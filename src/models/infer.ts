/**
 * Model stage: depth (Depth Anything V2 Small) + subject mask, via transformers.js.
 * Runs unchanged in a browser worker (WebGPU / WASM) and in Node (onnxruntime-node).
 */
import { AutoModel, AutoProcessor, RawImage, Tensor } from '@huggingface/transformers';
import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import { findPlainBorder } from '../core/trim';

export type Device = 'webgpu' | 'wasm' | 'cpu';

export interface ModelSpec {
  id: string;
  label: string;
  license: string;
  /** dtype per device */
  dtype: Record<Device, string>;
  /** runs within browser WASM memory limits */
  wasmOk: boolean;
  /**
   * needs int64 ops on the GPU (otherwise they fall back to the CPU and run out of WASM memory).
   * The `enableInt64` WebGPU option is forwarded by the Vite plugin in vite.config.ts.
   */
  webgpuInt64?: boolean;
}

export const DEPTH_MODEL: ModelSpec = {
  id: 'onnx-community/depth-anything-v2-small',
  label: 'Depth Anything V2 Small',
  license: 'Apache-2.0',
  dtype: { webgpu: 'fp16', wasm: 'q8', cpu: 'fp32' },
  wasmOk: true,
};

export type MaskModelKey = 'birefnet' | 'ormbg' | 'modnet' | 'none';

export const MASK_MODELS: Record<Exclude<MaskModelKey, 'none'>, ModelSpec> = {
  birefnet: {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    label: 'BiRefNet lite (general, best edges)',
    license: 'MIT',
    dtype: { webgpu: 'fp16', wasm: 'fp16', cpu: 'fp32' },
    wasmOk: false, // 1024² activations exceed the 4 GB WASM heap
    webgpuInt64: true,
  },
  ormbg: {
    id: 'onnx-community/ormbg-ONNX',
    label: 'ormbg (general, lighter)',
    license: 'Apache-2.0',
    dtype: { webgpu: 'fp16', wasm: 'q8', cpu: 'fp32' },
    wasmOk: true,
  },
  modnet: {
    id: 'Xenova/modnet',
    label: 'MODNet (portraits, fastest)',
    license: 'Apache-2.0',
    dtype: { webgpu: 'fp32', wasm: 'q8', cpu: 'fp32' },
    wasmOk: true,
  },
};

export type Progress = (info: { status: string; file?: string; progress?: number; loaded?: number; total?: number; name?: string }) => void;

interface Loaded {
  model: any;
  processor: any;
}

const cache = new Map<string, Promise<Loaded>>();

function load(spec: ModelSpec, device: Device, progress?: Progress): Promise<Loaded> {
  const key = `${spec.id}|${device}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(spec.id, {
          device: device as any,
          ...(device === 'webgpu' && spec.webgpuInt64 ? { session_options: { executionProviders: [{ name: 'webgpu', enableInt64: true }] } as any } : {}),
          dtype: spec.dtype[device] as any,
          progress_callback: progress as any,
        }),
        AutoProcessor.from_pretrained(spec.id, { progress_callback: progress as any }),
      ]);
      return { model, processor };
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

function tensorToGrid(t: Tensor): Grid {
  const f = t.type === 'float32' ? t : t.to('float32');
  const dims = f.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const src = f.data as Float32Array;
  return { w, h, data: new Float32Array(src.subarray(0, w * h)) };
}

async function runModel(l: Loaded, image: RawImage): Promise<Record<string, Tensor>> {
  const inputs = await l.processor(image);
  const session = l.model.sessions?.['model'];
  if (session && !session.inputNames.includes('pixel_values') && session.inputNames.length === 1) {
    inputs[session.inputNames[0]] = inputs.pixel_values;
    delete inputs.pixel_values;
  }
  return l.model(inputs);
}

export async function estimateDepth(image: RawImage, device: Device, progress?: Progress): Promise<Grid> {
  const l = await load(DEPTH_MODEL, device, progress);
  const out = await runModel(l, image);
  return tensorToGrid(out.predicted_depth);
}

export async function estimateMask(image: RawImage, key: MaskModelKey, device: Device, progress?: Progress): Promise<Grid | null> {
  if (key === 'none') return null;
  const spec = MASK_MODELS[key];
  const l = await load(spec, device, progress);
  const out = await runModel(l, image);
  const name = l.model.sessions?.['model']?.outputNames?.[0] ?? Object.keys(out)[0];
  const g = tensorToGrid(out[name]);
  let outside = false;
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i];
    if (v < -1e-5 || v > 1 + 1e-5) {
      outside = true;
      break;
    }
  }
  if (outside) for (let i = 0; i < g.data.length; i++) g.data[i] = 1 / (1 + Math.exp(-g.data[i]));
  return g;
}

/** Photo → luminance Grid (0..1) at working resolution (longest side ≤ maxSide). */
export async function luminanceOf(image: RawImage, maxSide: number): Promise<Grid> {
  const s = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.max(2, Math.round(image.width * s));
  const h = Math.max(2, Math.round(image.height * s));
  const img = (s < 1 ? await image.resize(w, h) : image).rgb();
  const data = new Float32Array(w * h);
  const px = img.data as Uint8ClampedArray;
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 3] / 255;
    const g = px[i * 3 + 1] / 255;
    const b = px[i * 3 + 2] / 255;
    data[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { w, h, data };
}

export interface AnalyzeOptions {
  device: Device;
  maskModel: MaskModelKey;
  workingMaxSide: number;
  progress?: Progress;
  onStage?: (stage: string) => void;
  /** crop off a plain border (poster matte, letterbox) first; default true */
  trimBorder?: boolean;
}

/** Crops a plain border off the photo; returns the photo unchanged when there is none. */
export function trimPlainBorder(rgb: RawImage): { image: RawImage; crop?: RawInputs['crop'] } {
  const box = findPlainBorder(rgb.data as Uint8ClampedArray, rgb.width, rgb.height, rgb.channels);
  if (!box) return { image: rgb };
  const out = new Uint8ClampedArray(box.w * box.h * 3);
  const src = rgb.data as Uint8ClampedArray;
  for (let y = 0; y < box.h; y++) {
    const s0 = ((box.y + y) * rgb.width + box.x) * 3;
    out.set(src.subarray(s0, s0 + box.w * 3), y * box.w * 3);
  }
  return { image: new RawImage(out, box.w, box.h, 3), crop: { ...box, srcW: rgb.width, srcH: rgb.height } };
}

export async function analyzePhoto(image: RawImage, opts: AnalyzeOptions): Promise<RawInputs> {
  let rgb = image.rgb();
  let crop: RawInputs['crop'];
  if (opts.trimBorder !== false) ({ image: rgb, crop } = trimPlainBorder(rgb));
  opts.onStage?.('depth');
  const depth = await estimateDepth(rgb, opts.device, opts.progress);
  opts.onStage?.('mask');
  const mask = await estimateMask(rgb, opts.maskModel, opts.device, opts.progress);
  const luminance = await luminanceOf(rgb, opts.workingMaxSide);
  return { luminance, depth, mask, crop };
}
