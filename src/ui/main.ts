import { DEFAULT_PARAMS, PRESETS, PresetName, ReliefParams } from '../core/params';
import { shadeHeightfield } from '../core/shade';
import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import type { MaskModelKey, Device } from '../models/infer';
import type { ComputeRequest, ComputeResponse, ModelRequest, ModelResponse, ReliefStats } from '../workers/protocol';
import { FIELDS, Field } from './schema';
import { maskQuality } from '../core/maskQuality';
import { MASK_MODELS } from '../models/infer';
import { ReliefPreview, Finish } from './preview3d';
import { backlitBrightness } from '../core/litho';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MM_PER_IN = 25.4;
const STORE_KEY = 'relief-generator:v2'; // v2: BiRefNet became the default mask model

// ---- state ---------------------------------------------------------------------------------------
type Units = 'mm' | 'in';
interface Saved {
  params: ReliefParams;
  units: Units;
  preset: PresetName;
  maskModel: MaskModelKey;
  device: Device | 'auto';
}
function loadSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
const saved = loadSaved();
let params: ReliefParams = { ...DEFAULT_PARAMS, ...PRESETS.portrait, ...(saved.params ?? {}) };
let units: Units = saved.units ?? 'in';
let photoName = 'relief';
let haveInputs = false;
function persist() {
  try {
    const s: Saved = {
      params,
      units,
      preset: ($('preset') as HTMLSelectElement).value as PresetName,
      maskModel: ($('maskModel') as HTMLSelectElement).value as MaskModelKey,
      device: ($('deviceSel') as HTMLSelectElement).value as Device | 'auto',
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

// ---- workers -------------------------------------------------------------------------------------
const newModelWorker = () => new Worker(new URL('../workers/models.worker.ts', import.meta.url), { type: 'module' });
let modelWorker = newModelWorker();
let lastRequest: ModelRequest | null = null;
const computeWorker = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
const sendCompute = (m: ComputeRequest, t: Transferable[] = []) => computeWorker.postMessage(m, t);

let analyzeId = 0;
let reliefId = 0;
let busy = false;
let dirty = false;
let lastStats: ReliefStats | null = null;

const preview = new ReliefPreview($('three'));

// ---- status --------------------------------------------------------------------------------------
function status(msg: string, err = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', err);
}
function exportInfo(msg: string, err = false) {
  const el = $('exportInfo');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

// ---- parameter UI --------------------------------------------------------------------------------
const fmtLen = (mm: number) => (units === 'in' ? `${(mm / MM_PER_IN).toFixed(mm < 2.54 ? 4 : 3)} in` : `${mm.toFixed(mm < 1 ? 3 : 2)} mm`);

const inputs = new Map<keyof ReliefParams, { f: Field; input: HTMLInputElement | HTMLSelectElement; out?: HTMLOutputElement }>();

function buildFields() {
  for (const f of FIELDS) {
    const host = $(f.advanced ? 'advanced' : 'basic');
    const row = document.createElement('div');
    row.className = 'row' + (f.kind === 'range' ? ' range' : '');
    if (f.help) row.title = f.help;
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `p_${f.key}`;
    row.appendChild(label);
    let input: HTMLInputElement | HTMLSelectElement;
    let out: HTMLOutputElement | undefined;
    if (f.kind === 'select') {
      input = document.createElement('select');
      for (const [v, t] of f.options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = t;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      if (f.kind === 'check') input.type = 'checkbox';
      else {
        input.type = 'range';
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = String(f.step);
        out = document.createElement('output');
      }
    }
    input.id = `p_${f.key}`;
    row.appendChild(input);
    if (out) row.appendChild(out);
    host.appendChild(row);
    const handler = () => {
      const p = params as unknown as Record<string, unknown>;
      if (f.kind === 'check') p[f.key] = (input as HTMLInputElement).checked;
      else if (f.kind === 'select') p[f.key] = input.value;
      else p[f.key] = Number(input.value);
      syncOutputs();
      onParamsChanged();
    };
    input.addEventListener('input', handler);
    inputs.set(f.key, { f, input, out });
  }
}

function syncInputs() {
  const p = params as unknown as Record<string, unknown>;
  for (const { f, input } of inputs.values()) {
    if (f.kind === 'check') (input as HTMLInputElement).checked = Boolean(p[f.key]);
    else input.value = String(p[f.key]);
  }
  ($('width') as HTMLInputElement).value = units === 'in' ? (params.widthMm / MM_PER_IN).toFixed(3) : params.widthMm.toFixed(1);
  ($('units') as HTMLSelectElement).value = units;
  syncOutputs();
}

function syncOutputs() {
  const p = params as unknown as Record<string, number>;
  for (const { f, out } of inputs.values()) {
    if (!out || f.kind !== 'range') continue;
    const v = p[f.key];
    if (f.key === 'gridSpacing' && v === 0) out.textContent = `auto ${fmtLen(params.toolDiameter / 4)}`;
    else out.textContent = f.length ? fmtLen(v) : String(Number(v.toFixed(4)));
  }
  // show only the controls that matter for the current mode / method / bg mode
  const litho = params.mode === 'lithophane';
  const vis = (k: keyof ReliefParams, on: boolean) => {
    const e = inputs.get(k);
    if (e) (e.input.parentElement as HTMLElement).style.display = on ? '' : 'none';
  };
  for (const { f } of inputs.values()) vis(f.key, Boolean(f.litho) === litho);
  if (!litho) {
    vis('bgLevel', params.bgMode === 'keep');
    vis('baseGamma', params.method === 'baseDetail');
    vis('gradThreshold', params.method === 'gradient');
    vis('toneDarkUp', params.toneDepth > 0);
    vis('toneScale', params.toneDepth > 0);
  }
  $('presetRow').hidden = litho;
  ($('mode') as HTMLSelectElement).value = params.mode;
  $('reliefCap').textContent = litho ? 'backlit' : 'relief';
  updateDims();
}

function updateDims() {
  const s = lastStats;
  const hOut = $('heightOut');
  if (!s) {
    hOut.textContent = '–';
    $('dims').textContent = 'No relief yet';
    return;
  }
  hOut.textContent = fmtLen(s.heightMm);
  const both = (mm: number) => `${mm.toFixed(2)} mm / ${(mm / MM_PER_IN).toFixed(3)} in`;
  $('dims').textContent =
    `W × H  ${s.widthMm.toFixed(1)} × ${s.heightMm.toFixed(1)} mm  (${(s.widthMm / MM_PER_IN).toFixed(2)} × ${(s.heightMm / MM_PER_IN).toFixed(2)} in)\n` +
    `Z min  ${both(s.zMin)}\nZ max  ${both(s.zMax)}\n` +
    `grid   ${s.nx} × ${s.ny} @ ${s.dx.toFixed(3)} mm` +
    (s.ms ? `   (${Math.round(s.ms)} ms)` : '');
}

let debounce = 0;
/** shows the Reset button when a slider no longer matches the selected preset */
function updatePresetModified() {
  const name = ($('preset') as HTMLSelectElement).value as PresetName;
  const preset = PRESETS[name] as Record<string, unknown>;
  const cur = params as unknown as Record<string, unknown>;
  const modified = Object.keys(preset).some((k) => {
    const a = cur[k], b = preset[k];
    return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-6 : a !== b;
  });
  $('presetModRow').hidden = !modified || params.mode === 'lithophane';
}

function applyPreset() {
  const name = ($('preset') as HTMLSelectElement).value as PresetName;
  // presets change the "look" only; size, machining and tool settings are kept
  params = { ...params, ...PRESETS[name] };
  syncInputs();
  onParamsChanged();
}

function onParamsChanged() {
  updatePresetModified();
  persist();
  if (!haveInputs) return;
  clearTimeout(debounce);
  debounce = window.setTimeout(requestRelief, 120);
}

function requestRelief() {
  if (busy) {
    dirty = true;
    return;
  }
  busy = true;
  dirty = false;
  showMaskWarning();
  sendCompute({ type: 'params', id: ++reliefId, params: { ...params } });
}

// ---- views ---------------------------------------------------------------------------------------
function drawGray(canvas: HTMLCanvasElement, w: number, h: number, gray: (i: number) => number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = gray(i);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function drawGrid(canvas: HTMLCanvasElement, g: Grid) {
  drawGray(canvas, g.w, g.h, (i) => 255 * g.data[i]);
}

/** crop: the part of the photo that was analysed (a plain border may have been trimmed off) */
async function drawPhoto(file: Blob, crop?: RawInputs['crop']) {
  const bmp = await createImageBitmap(file);
  const c = $<HTMLCanvasElement>('cvPhoto');
  // the worker decodes the same file, so scale its crop box in case the sizes differ
  const k = crop ? bmp.width / crop.srcW : 1;
  const sx = crop ? crop.x * k : 0, sy = crop ? crop.y * k : 0;
  const sw = crop ? crop.w * k : bmp.width, sh = crop ? crop.h * k : bmp.height;
  const s = Math.min(1, 600 / Math.max(sw, sh));
  c.width = Math.round(sw * s);
  c.height = Math.round(sh * s);
  c.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close();
}

function drawRelief(z: Float32Array, nx: number, ny: number, stats: ReliefStats) {
  // image orientation (row 0 = top) for the 2D thumbnail
  const img: Grid = { w: nx, h: ny, data: new Float32Array(nx * ny) };
  for (let j = 0; j < ny; j++) img.data.set(z.subarray(j * nx, (j + 1) * nx), (ny - 1 - j) * nx);
  const az = Number(($('lightAz') as HTMLInputElement).value);
  const el = Number(($('lightEl') as HTMLInputElement).value);
  const gray =
    params.mode === 'lithophane'
      ? Uint8ClampedArray.from(img.data, (t) => 255 * backlitBrightness(t, stats.zMin, stats.zMax))
      : shadeHeightfield(img, { pixelMm: stats.dx, azimuth: az, elevation: el });
  drawGray($<HTMLCanvasElement>('cvRelief'), nx, ny, (i) => gray[i]);
}

// ---- photo loading -------------------------------------------------------------------------------
function setExportsEnabled(on: boolean) {
  // STEP is for CAM; a lithophane goes to the slicer as STL
  const litho = params.mode === 'lithophane';
  for (const id of ['expSurface', 'expSolid', 'expStl']) ($(id) as HTMLButtonElement).disabled = !on || (litho && id !== 'expStl');
}

// ---- mask sanity check --------------------------------------------------------------------------
let lastFile: File | null = null;
let usedMaskModel: MaskModelKey = 'none';
let lastMask: Grid | null = null;
let lastQuality: { thr: number; q: ReturnType<typeof maskQuality> } | null = null;

function showMaskWarning(mask: Grid | null = lastMask) {
  const box = $('maskWarn');
  box.hidden = true;
  lastMask = mask;
  if (!mask || usedMaskModel === 'none' || params.mode === 'lithophane') return;
  // keeping the whole background at full height (Landscape) does not depend on the mask
  if (params.bgMode === 'keep' && params.bgLevel >= 0.9) return;
  if (!lastQuality || lastQuality.thr !== params.maskThreshold) lastQuality = { thr: params.maskThreshold, q: maskQuality(mask, params.maskThreshold) };
  const q = lastQuality.q;
  if (!q.suspect) return;
  const alt: MaskModelKey = usedMaskModel === 'birefnet' ? 'ormbg' : 'birefnet';
  $('maskWarnText').textContent = `The subject mask looks wrong: ${q.reason}. The relief will probably come out in fragments. For a scene with no single subject, use the Landscape preset.`;
  const btn = $<HTMLButtonElement>('maskWarnRetry');
  btn.textContent = `Retry with ${MASK_MODELS[alt as Exclude<MaskModelKey, 'none'>].label.split(' (')[0]}`;
  btn.onclick = () => {
    ($('maskModel') as HTMLSelectElement).value = alt;
    persist();
    if (lastFile) loadPhoto(lastFile);
  };
  box.hidden = false;
}

async function loadPhoto(file: File) {
  lastFile = file;
  lastMask = null;
  $('maskWarn').hidden = true;
  photoName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'relief';
  haveInputs = false;
  lastStats = null;
  setExportsEnabled(false);
  exportInfo('');
  await drawPhoto(file);
  for (const id of ['cvMask', 'cvDepth', 'cvRelief']) {
    const c = $<HTMLCanvasElement>(id);
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }
  status('Starting models…');
  const req: ModelRequest = {
    type: 'analyze',
    id: ++analyzeId,
    image: file,
    device: ($('deviceSel') as HTMLSelectElement).value as Device | 'auto',
    maskModel: ($('maskModel') as HTMLSelectElement).value as MaskModelKey,
    workingMaxSide: 1024,
    ortBase: new URL('ort/', document.baseURI).href,
  };
  lastRequest = req;
  modelWorker.postMessage(req);
}

const downloads = new Map<string, { loaded: number; total: number }>();
function onModelMessage(ev: MessageEvent<ModelResponse>) {
  const m = ev.data;
  if (m.id !== analyzeId) return;
  if (m.type === 'progress') {
    if (m.stage === 'download' && m.file) {
      downloads.set(m.file, { loaded: m.loaded ?? 0, total: m.total ?? 0 });
      let l = 0;
      let t = 0;
      for (const d of downloads.values()) {
        l += d.loaded;
        t += d.total;
      }
      status(`Downloading models (first run only, cached afterwards)…\n${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`);
    } else if (m.stage === 'depth') status('Estimating depth…');
    else if (m.stage === 'mask') status('Finding the subject…');
    else status(m.stage);
    return;
  }
  if (m.type === 'error') {
    const retry = (patch: Partial<ModelRequest>, msg: string) => {
      // a failed WebGPU session can leave the runtime unusable, so retry in a fresh worker
      console.warn(msg, m.message);
      status(msg);
      modelWorker.terminate();
      modelWorker = newModelWorker();
      modelWorker.onmessage = onModelMessage;
      lastRequest = { ...lastRequest!, ...patch, id: ++analyzeId };
      modelWorker.postMessage(lastRequest);
    };
    if (lastRequest && lastRequest.maskModel === 'birefnet') {
      retry({ maskModel: 'ormbg' }, 'BiRefNet could not run on this device – retrying with ormbg…');
      return;
    }
    if (m.device === 'webgpu' && lastRequest) {
      retry({ device: 'wasm' }, 'WebGPU failed on this GPU – retrying on CPU (slower)…');
      return;
    }
    status(`Model error: ${m.message}`, true);
    return;
  }
  usedMaskModel = m.maskModel;
  $('device').textContent = m.device === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
  status(
    `Analysed in ${(m.ms / 1000).toFixed(1)} s on ${m.device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}.` +
      (m.raw.crop ? ' Plain border around the picture trimmed off.' : ''),
  );
  if (m.raw.crop && lastFile) drawPhoto(lastFile, m.raw.crop);
  const t: Transferable[] = [m.raw.luminance.data.buffer, m.raw.depth.data.buffer];
  if (m.raw.mask) t.push(m.raw.mask.data.buffer);
  sendCompute({ type: 'inputs', raw: m.raw }, t);
  haveInputs = true;
  busy = false;
  requestRelief();
}
modelWorker.onmessage = onModelMessage;

// ---- compute results -----------------------------------------------------------------------------
let exportId = 0;
let exportKind = '';
computeWorker.onmessage = (ev: MessageEvent<ComputeResponse>) => {
  const m = ev.data;
  if (m.type === 'prepared') {
    drawGrid($<HTMLCanvasElement>('cvMask'), m.mask);
    drawGrid($<HTMLCanvasElement>('cvDepth'), m.depth);
    lastQuality = null;
    showMaskWarning(m.mask);
    return;
  }
  if (m.type === 'relief') {
    busy = false;
    lastStats = m.stats;
    preview.setHeightfield(m.z, m.nx, m.ny, m.stats.widthMm, m.stats.heightMm);
    drawRelief(m.z, m.nx, m.ny, m.stats);
    updateDims();
    setExportsEnabled(true);
    if (dirty) requestRelief();
    return;
  }
  if (m.type === 'progress') {
    exportInfo(`Fitting B-spline… ${m.message}`);
    return;
  }
  if (m.type === 'error') {
    if (m.id === exportId) {
      exportInfo(`Export failed: ${m.message}`, true);
      setExportsEnabled(true);
    } else {
      busy = false;
      status(`Error: ${m.message}`, true);
    }
    return;
  }
  if (m.type === 'exported' && m.id === exportId) {
    const ext = m.kind === 'stl' ? 'stl' : 'step';
    const suffix = m.kind === 'stl' ? '' : `_${m.kind}`;
    const blob = new Blob([m.bytes as BlobPart], { type: m.kind === 'stl' ? 'model/stl' : 'application/step' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${photoName}${suffix}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    exportInfo(`${exportKind}: ${(m.bytes.length / 1e6).toFixed(1)} MB — ${m.info}`);
    setExportsEnabled(true);
  }
};

function doExport(kind: 'surface' | 'solid' | 'stl', label: string) {
  if (!haveInputs) return;
  exportKind = label;
  setExportsEnabled(false);
  exportInfo(kind === 'stl' ? 'Building STL…' : 'Fitting B-spline surface…');
  sendCompute({ type: 'export', id: ++exportId, params: { ...params }, kind, name: photoName });
}

// ---- wiring --------------------------------------------------------------------------------------
buildFields();
if (saved.preset) ($('preset') as HTMLSelectElement).value = saved.preset;
if (saved.maskModel) ($('maskModel') as HTMLSelectElement).value = saved.maskModel;
if (saved.device) ($('deviceSel') as HTMLSelectElement).value = saved.device;
syncInputs();
if (params.mode === 'lithophane') {
  ($('finish') as HTMLSelectElement).value = 'backlit';
  preview.setFinish('backlit');
}

$('preset').addEventListener('change', applyPreset);
$('presetReset').addEventListener('click', applyPreset);
$('mode').addEventListener('change', () => {
  params.mode = ($('mode') as HTMLSelectElement).value as ReliefParams['mode'];
  const fin = $('finish') as HTMLSelectElement;
  // show a lithophane with light behind it; a relief with raking light
  if (params.mode === 'lithophane') fin.value = 'backlit';
  else if (fin.value === 'backlit') fin.value = 'clay';
  preview.setFinish(fin.value as Finish);
  syncOutputs();
  setExportsEnabled(Boolean(lastStats));
  onParamsChanged();
});
$('resetAll').addEventListener('click', () => {
  // back to factory settings + the selected preset; keep the part size and stock the user chose
  const { mode, widthMm, reliefHeight, baseThickness } = params;
  params = { ...DEFAULT_PARAMS, mode, widthMm, reliefHeight, baseThickness };
  applyPreset();
});
updatePresetModified();
$('units').addEventListener('change', () => {
  units = ($('units') as HTMLSelectElement).value as Units;
  syncInputs();
  persist();
});
$('width').addEventListener('change', () => {
  const v = Number(($('width') as HTMLInputElement).value);
  if (!(v > 0)) return;
  params.widthMm = units === 'in' ? v * MM_PER_IN : v;
  syncOutputs();
  onParamsChanged();
});
for (const id of ['maskModel', 'deviceSel']) $(id).addEventListener('change', persist);

const fileInput = $<HTMLInputElement>('file');
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadPhoto(f);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) loadPhoto(f);
});

const light = () => {
  const az = Number(($('lightAz') as HTMLInputElement).value);
  const el = Number(($('lightEl') as HTMLInputElement).value);
  // UI azimuth: 0 = light from the right, 90 = from the top
  preview.setLight(az, el);
};
$('lightAz').addEventListener('input', light);
$('lightEl').addEventListener('input', light);
light();
$('finish').addEventListener('change', () => preview.setFinish(($('finish') as HTMLSelectElement).value as Finish));
$('resetView').addEventListener('click', () => preview.resetView());

$('expSurface').addEventListener('click', () => doExport('surface', 'STEP surface'));
$('expSolid').addEventListener('click', () => doExport('solid', 'STEP solid'));
$('expStl').addEventListener('click', () => doExport('stl', 'STL'));

// offline support (production builds only)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker registration failed', e));
}
