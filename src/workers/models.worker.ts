/// <reference lib="webworker" />
import { env, RawImage } from '@huggingface/transformers';
import { analyzePhoto, Device, MASK_MODELS, MaskModelKey } from '../models/infer';
import { patchForWebGPU } from '../models/onnxPatch';
import type { ModelRequest, ModelResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (m: ModelResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);

// ---- BiRefNet WebGPU fix ---------------------------------------------------------------------------
// BiRefNet's decoder has a 16-input Concat, which needs 17 storage buffers in onnxruntime-web's WebGPU
// kernel (most GPUs allow 16); same for its 16-way Splits. We rewrite the graph on download (Concats split into a tree, identical
// maths, verified in test/onnxPatch.test.ts); transformers.js then caches the patched file.
const PATCH_RE = /BiRefNet[^/]*\/resolve\/[^/]+\/onnx\/[^/?]+\.onnx(\?|$)/;
const PATCH_HEADER = 'x-relief-patched';
const PATCH_VERSION = 'v3'; // bump when patchForWebGPU changes so stale cached copies are re-downloaded
let currentId = 0;
const origFetch: typeof fetch = (env as any).fetch ?? self.fetch.bind(self);
(env as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const res = await origFetch(input, init);
  if (method !== 'GET' || res.status !== 200 || !PATCH_RE.test(url) || !res.body) return res;
  // read with progress (transformers.js cannot see this download)
  const total = Number(res.headers.get('content-length') ?? 0);
  const file = url.split('/').slice(-2).join('/');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (performance.now() - lastPost > 200) {
      lastPost = performance.now();
      post({ type: 'progress', id: currentId, stage: 'download', file, loaded, total });
    }
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  post({ type: 'progress', id: currentId, stage: 'download', file, loaded, total: loaded });
  const { bytes, patched } = patchForWebGPU(buf);
  const headers = new Headers(res.headers);
  headers.set('content-length', String(bytes.length));
  headers.set(PATCH_HEADER, `${PATCH_VERSION}:${patched}`);
  return new Response(bytes as BlobPart, { status: 200, statusText: 'OK', headers });
};

/** Drop any BiRefNet weights cached before the patch existed. */
async function purgeUnpatched() {
  try {
    const cache = await caches.open(env.cacheKey ?? 'transformers-cache');
    for (const req of await cache.keys()) {
      if (!PATCH_RE.test(req.url)) continue;
      const r = await cache.match(req);
      if (r && !(r.headers.get(PATCH_HEADER) ?? '').startsWith(`${PATCH_VERSION}:`)) await cache.delete(req);
    }
  } catch {
    /* no cache available */
  }
}

async function pickDevice(requested: Device | 'auto'): Promise<Device> {
  if (requested !== 'auto') return requested;
  try {
    const gpu = (navigator as any).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* fall through */
  }
  return 'wasm';
}

self.onmessage = async (ev: MessageEvent<ModelRequest>) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  const { id } = req;
  currentId = id;
  await purgeUnpatched();
  // serve onnxruntime's wasm from our own origin (works offline, no CDN)
  const onnx = (env.backends as any).onnx;
  if (onnx?.wasm) onnx.wasm.wasmPaths = req.ortBase;
  const t0 = performance.now();
  let maskModel: MaskModelKey = req.maskModel;
  const run = async (device: Device) => {
    const image = await RawImage.fromBlob(req.image);
    if (maskModel !== 'none' && device === 'wasm' && !MASK_MODELS[maskModel].wasmOk) {
      post({ type: 'progress', id, stage: `${MASK_MODELS[maskModel].label} needs WebGPU – using ormbg on CPU` });
      maskModel = 'ormbg';
    }
    return analyzePhoto(image, {
      device,
      maskModel,
      workingMaxSide: req.workingMaxSide,
      onStage: (stage) => post({ type: 'progress', id, stage }),
      progress: (p) => {
        if (p.status === 'progress' && p.file) post({ type: 'progress', id, stage: 'download', file: p.file, loaded: p.loaded, total: p.total });
      },
    });
  };
  const device = await pickDevice(req.device);
  try {
    const raw = await run(device);
    const transfer: Transferable[] = [raw.luminance.data.buffer, raw.depth.data.buffer];
    if (raw.mask) transfer.push(raw.mask.data.buffer);
    post({ type: 'done', id, raw, device, maskModel, ms: performance.now() - t0 }, transfer);
  } catch (e) {
    console.error(e);
    post({ type: 'error', id, device, message: e instanceof Error ? e.message : String(e) });
  }
};
