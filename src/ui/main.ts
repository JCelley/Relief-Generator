import { DEFAULT_PARAMS, PRESETS, PresetName, ReliefParams, minLithoRadius, effectiveGridSpacing } from '../core/params';
import { shadeHeightfield } from '../core/shade';
import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import type { MaskModelKey, Device } from '../models/infer';
import type { ComputeRequest, ComputeResponse, ExportKind, ModelRequest, ModelResponse, ReliefStats } from '../workers/protocol';
import { FIELDS, Field } from './schema';
import { maskQuality } from '../core/maskQuality';
import { MASK_MODELS } from '../models/infer';
import { ReliefPreview, Finish } from './preview3d';
import { backlitBrightness } from '../core/litho';
import { photoLuminance, LampImages, cropDialog } from './images';
import { recommend, stepoverFor, scallopHeight } from '../core/cam';

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
/** a photo's luminance is in the compute worker (enough for a flat or curved lithophane) */
let havePhoto = false;
/** the depth / mask models have run on the current photo (needed for a CNC relief) */
let photoModels = false;
let modelsRunning = false;
const isLamp = () => params.mode === 'lithophane' && params.lithoShape === 'lamp';
/** inputs for the current mode are in the compute worker */
const haveInputsFor = () => (params.mode === 'relief' ? photoModels : isLamp() ? lampImgs.list.length > 0 : havePhoto);
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

const inputs = new Map<keyof ReliefParams, { f: Field; input: HTMLInputElement | HTMLSelectElement; num?: HTMLInputElement; unit?: HTMLElement }>();

/** a value in mm (or the raw value) as shown in a number box, in the current units */
function toDisplay(f: Field, v: number): string {
  if (f.kind === 'range' && f.length) {
    const x = units === 'in' ? v / MM_PER_IN : v;
    if (units === 'in') {
      // exact 1/64" fractions (tool sizes) in full, anything else to 4 places
      const f64 = x * 64;
      return String(Math.abs(f64 - Math.round(f64)) < 1e-4 ? Math.round(f64) / 64 : Number(x.toFixed(Math.abs(x) < 0.01 ? 5 : 4)));
    }
    return String(Number(x.toFixed(3)));
  }
  return String(Number(v.toFixed(4)));
}
const fromDisplay = (f: Field, x: number) => (f.kind === 'range' && f.length && units === 'in' ? x * MM_PER_IN : x);

/** drop-down suggestions for a number box (common tool sizes, fitter holes, angles) */
function fillPresets(f: Field) {
  if (f.kind !== 'range' || !f.presets) return;
  const dl = document.getElementById(`dl_${f.key}`) as HTMLDataListElement;
  dl.replaceChildren(
    ...f.presets.map(([v, label]) => {
      const o = document.createElement('option');
      o.value = toDisplay(f, v);
      if (label) o.label = label;
      return o;
    }),
  );
}

function buildFields() {
  for (const f of FIELDS) {
    const host = $(f.advanced ? 'advanced' : 'cam' in f && f.cam ? 'cam' : 'basic');
    const row = document.createElement('div');
    row.className = 'row' + (f.kind === 'range' ? ' range' : '');
    if (f.help) row.title = f.help;
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `p_${f.key}`;
    row.appendChild(label);
    let input: HTMLInputElement | HTMLSelectElement;
    let num: HTMLInputElement | undefined;
    let unit: HTMLElement | undefined;
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
        // exact value: type it in (lengths in the current units)
        num = document.createElement('input');
        num.type = 'number';
        num.step = 'any';
        num.className = 'num';
        num.id = `n_${f.key}`;
        num.setAttribute('aria-label', `${f.label} value`);
        if (f.presets) {
          const dl = document.createElement('datalist');
          dl.id = `dl_${f.key}`;
          row.appendChild(dl);
          num.setAttribute('list', dl.id);
        }
        unit = document.createElement('em');
      }
    }
    input.id = `p_${f.key}`;
    row.appendChild(input);
    if (num && unit) {
      const wrap = document.createElement('span');
      wrap.className = 'num-wrap';
      wrap.append(num, unit);
      row.appendChild(wrap);
      const n = num;
      n.addEventListener('change', () => {
        if (f.kind !== 'range') return;
        const x = Number(n.value);
        if (n.value.trim() === '' || !Number.isFinite(x)) {
          syncOutputs();
          return;
        }
        const v = Math.min(f.max, Math.max(f.min, fromDisplay(f, x)));
        (params as unknown as Record<string, number>)[f.key] = v;
        input.value = String(v);
        syncOutputs(true);
        onParamsChanged();
      });
      n.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') n.blur();
      });
    }
    host.appendChild(row);
    const handler = () => {
      const p = params as unknown as Record<string, unknown>;
      if (f.kind === 'check') p[f.key] = (input as HTMLInputElement).checked;
      else if (f.kind === 'select') {
        p[f.key] = input.value;
        if (f.key === 'lithoShape' && input.value === 'lamp' && !lampImgs.list.length && lastFile) lampImgs.add([lastFile]);
      }
      else p[f.key] = Number(input.value);
      syncOutputs();
      onParamsChanged();
    };
    input.addEventListener('input', handler);
    inputs.set(f.key, { f, input, num, unit });
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
  for (const { f } of inputs.values()) fillPresets(f);
  syncOutputs(true);
}

/** force: also rewrite the number box that has focus (after a typed value was applied) */
function syncOutputs(force = false) {
  const p = params as unknown as Record<string, number>;
  for (const { f, num, unit } of inputs.values()) {
    if (!num || !unit || f.kind !== 'range') continue;
    const v = p[f.key];
    if (force || document.activeElement !== num) num.value = toDisplay(f, v);
    unit.textContent = f.length ? units + ('rate' in f && f.rate ? '/min' : '') : (f.unit ?? '');
    if (f.key === 'gridSpacing') num.title = v === 0 ? `auto: ${fmtLen(effectiveGridSpacing(params))}` : '';
  }
  // show only the controls that matter for the current mode / method / bg mode
  const litho = params.mode === 'lithophane';
  const vis = (k: keyof ReliefParams, on: boolean) => {
    const e = inputs.get(k);
    if (e) (e.input.parentElement as HTMLElement).style.display = on ? '' : 'none';
  };
  for (const { f } of inputs.values()) vis(f.key, Boolean(f.litho) === litho);
  for (const k of ['roughType', 'roughDiameter', 'roughFlutes', 'roughStepdown', 'roughStepover', 'roughAllowance', 'roughRpm', 'roughFeed', 'roughPlunge'] as const) vis(k, params.roughOn);
  $('camSection').hidden = litho;
  $('pathCtl').hidden = litho;
  updateCamInfo();
  if (!litho) {
    vis('bgLevel', params.bgMode === 'keep');
    vis('baseGamma', params.method === 'baseDetail');
    vis('gradThreshold', params.method === 'gradient');
    vis('toneDarkUp', params.toneDepth > 0);
    vis('toneScale', params.toneDepth > 0);
    vis('toolAngle', params.toolType !== 'ball');
  } else {
    const sh = params.lithoShape, lamp = sh === 'lamp';
    vis('lithoRadius', sh === 'curved');
    vis('lithoCorner', sh === 'rounded');
    for (const k of ['lampDiameter', 'lampHeight', 'lampDivider', 'lampFitter'] as const) vis(k, lamp);
    vis('lampLip', lamp && params.lampFitter === 'lip');
    vis('lampHole', lamp && params.lampFitter === 'ring');
    vis('lampFitterEnd', lamp && params.lampFitter === 'ring');
    vis('lithoHole', !lamp);
  }
  const lamp = isLamp();
  $('lampBox').hidden = !lamp;
  for (const id of ['width', 'heightOut']) ($(id).parentElement as HTMLElement).hidden = lamp;
  $('viewCtl').hidden = litho;
  $('strobeCtl').hidden = !lamp;
  $('presetRow').hidden = litho;
  $('lithoTips').hidden = !litho;
  updateLithoWarn();
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
    (s.ms ? `   (${Math.round(s.ms)} ms)` : '') +
    curvedInfo(s) +
    lampInfo(s) +
    toolInfo(s);
}

let lastPathTimes: { rough: number; finish: number } | null = null;
const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
/** ridge height the finishing stepover leaves, and run times when the toolpaths are shown */
function updateCamInfo() {
  const tool = { type: params.toolType, diameter: params.toolDiameter, angle: params.toolAngle };
  const rec = stepoverFor(tool);
  let t = `Finish ridges ≈ ${fmtLen(scallopHeight(tool, params.finStepover))} on flat areas (recommended stepover ${fmtLen(rec)}).`;
  if (params.roughOn && params.roughDiameter <= params.toolDiameter) t += `\nThe roughing tool is not bigger than the finishing tool.`;
  if (!params.roughOn && params.reliefHeight > 2 * params.toolDiameter)
    t += `\nNo roughing: the finishing tool cuts the full ${fmtLen(params.reliefHeight)} depth in one pass. Fine for soft material and shallow reliefs only.`;
  if (lastPathTimes && showPaths())
    t += `\nEstimated time: ${params.roughOn ? `roughing ${fmtTime(lastPathTimes.rough)}, ` : ''}finishing ${fmtTime(lastPathTimes.finish)}.`;
  t += `\nX0 Y0 = front-left corner of the part; Z0 = ${params.zZero === 'top' ? 'top of the part' : 'spoilboard'}. One file per tool: re-zero Z after the tool change.`;
  $('camInfo').textContent = t;
}

function lampInfo(s: ReliefStats): string {
  if (!isLamp()) return '';
  const n = lampImgs.list.length;
  const D = params.lampDiameter;
  return `
lamp inside Ø ${fmtLen(D)}, outside Ø ${fmtLen(D + 2 * s.zMax)}, ${fmtLen(s.heightMm)} tall
${n} picture${n === 1 ? '' : 's'}, each ${fmtLen((Math.PI * D) / Math.max(1, n))} wide` +
    (params.lampFitter === 'lip' ? `\nbottom opening Ø ${fmtLen(Math.max(0, D - 2 * params.lampLip))}` : '') +
    (params.lampFitter === 'ring'
      ? `\nfitter hole Ø ${fmtLen(params.lampHole)} at the ${params.lampFitterEnd}` + (params.lampFitterEnd === 'top' ? ' (prints upside down)' : '')
      : '');
}

function toolInfo(s: ReliefStats): string {
  if (params.mode !== 'relief' || s.missedFrac === undefined) return '';
  const name =
    params.toolType === 'ball'
      ? `${fmtLen(params.toolDiameter)} ball`
      : params.toolType === 'taperedBall'
        ? `${fmtLen(params.toolDiameter)} tip ${params.toolAngle}° tapered ball`
        : `${params.toolDiameter > 0 ? fmtLen(params.toolDiameter) + ' tip ' : ''}${params.toolAngle}° V-bit`;
  return `
tool   ${name}: can't reach ${(100 * s.missedFrac).toFixed(1)} % (up to ${fmtLen(s.maxLeft ?? 0)} left)`;
}

/** warns about thicknesses outside what prints and lights well (white PLA, 0.4 mm nozzle) */
function updateLithoWarn() {
  const box = $('lithoWarn');
  const msgs: string[] = [];
  if (params.mode === 'lithophane') {
    if (params.lithoMin < 0.6) msgs.push(`Min thickness ${fmtLen(params.lithoMin)} is below ${fmtLen(0.6)}: the brightest areas may break or print with pinholes.`);
    if (params.lithoMax > 4) msgs.push(`Max thickness ${fmtLen(params.lithoMax)} is above ${fmtLen(4)}: the darkest areas will look solid black and lose detail.`);
    if (params.lithoMax - params.lithoMin < 1.5)
      msgs.push(`Only ${fmtLen(Math.max(0, params.lithoMax - params.lithoMin))} between min and max thickness: the picture will look flat. About ${fmtLen(2)} or more works best.`);
  }
  box.textContent = msgs.join('\n');
  box.style.whiteSpace = 'pre-line';
  box.hidden = msgs.length === 0;
}

function curveRadius(widthMm: number): number {
  if (params.mode !== 'lithophane' || params.lithoShape !== 'curved') return 0;
  return Math.max(params.lithoRadius, minLithoRadius(widthMm));
}

/** footprint of a curved lithophane standing up: chord across the ends and depth of the arc */
function curvedInfo(s: ReliefStats): string {
  const R = curveRadius(s.widthMm);
  if (!R) return '';
  const th = s.widthMm / R;
  const ro = R + s.zMax;
  const half = Math.min(th / 2, Math.PI / 2);
  const chord = 2 * ro * Math.sin(half);
  const depth = ro - R * Math.cos(th / 2);
  const deg = (th * 180) / Math.PI;
  const clamped = R > params.lithoRadius ? ' (radius raised: the ends would touch)' : '';
  return `
curved R ${fmtLen(R)}, ${deg.toFixed(0)}° arc${clamped}
footprint ${fmtLen(chord)} × ${fmtLen(depth)}, ${fmtLen(s.heightMm)} tall`;
}

let debounce = 0;
/** shows the Reset button when a slider no longer matches the selected preset */
/** lithophane sliders the Reset button restores (the Shape choice is kept) */
const LITHO_SLIDERS = ['lithoMax', 'lithoMin', 'lithoGamma', 'lithoBrightness', 'lithoContrast', 'lithoRadius', 'lithoCorner', 'lithoBorder', 'lampDivider', 'lithoGrid'] as const;

/** values Reset goes back to: the selected preset (relief) or the lithophane defaults */
function resetTarget(): Partial<ReliefParams> {
  if (params.mode === 'lithophane') return Object.fromEntries(LITHO_SLIDERS.map((k) => [k, DEFAULT_PARAMS[k]]));
  return PRESETS[($('preset') as HTMLSelectElement).value as PresetName];
}

/** shows the Reset button when a slider no longer matches the preset (or the lithophane defaults) */
function updatePresetModified() {
  const target = resetTarget() as Record<string, unknown>;
  const cur = params as unknown as Record<string, unknown>;
  const modified = Object.keys(target).some((k) => {
    const a = cur[k], b = target[k];
    return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-6 : a !== b;
  });
  $('presetModText').textContent = params.mode === 'lithophane' ? 'Sliders changed from the defaults' : 'Sliders changed from the preset';
  $('presetModRow').hidden = !modified;
}

function applyPreset() {
  // presets change the "look" only; size, machining and tool settings are kept
  params = { ...params, ...resetTarget() };
  syncInputs();
  onParamsChanged();
}

function onParamsChanged() {
  updatePresetModified();
  persist();
  if (params.mode === 'relief' && havePhoto && !photoModels && !modelsRunning && lastFile) analyze(lastFile);
  setExportsEnabled(Boolean(lastStats) && haveInputsFor());
  if (!haveInputsFor()) return;
  clearTimeout(debounce);
  debounce = window.setTimeout(requestRelief, 120);
}

function requestRelief() {
  if (busy) {
    dirty = true;
    return;
  }
  if (!haveInputsFor()) return;
  busy = true;
  dirty = false;
  showMaskWarning();
  if (isLamp()) sendLampInputs();
  sendCompute({ type: 'params', id: ++reliefId, params: { ...params }, view: viewMode(), toolpaths: showPaths() });
}

const showPaths = () => params.mode === 'relief' && ($('showPaths') as HTMLInputElement).checked;
const viewMode = () => ($('view') as HTMLSelectElement).value as 'design' | 'cut' | 'reach';

// ---- lamp shade pictures ------------------------------------------------------------------------
let lampSent = '';
const lampImgs = new LampImages($('lampList'), () => {
  $('lampCount').textContent = lampImgs.list.length ? `(${lampImgs.list.length})` : '';
  updateDims();
  onParamsChanged();
});
/** composes the strip of lamp pictures and sends it, when the pictures or the lamp size changed */
function sendLampInputs() {
  const key = `${lampImgs.version}|${params.lampDiameter}|${params.lampHeight}`;
  if (key === lampSent || !lampImgs.list.length) return;
  lampSent = key;
  const lum = lampImgs.compose(params.lampDiameter, params.lampHeight, 5);
  sendCompute(
    { type: 'inputs', slot: 'lamp', models: false, panels: lampImgs.list.length, raw: { luminance: lum, depth: { w: 0, h: 0, data: new Float32Array(0) }, mask: null } },
    [lum.data.buffer],
  );
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
  // STEP and height maps are for CAM; a lithophane goes to the slicer as STL / 3MF
  const litho = params.mode === 'lithophane';
  const flat = litho && params.lithoShape !== 'curved' && params.lithoShape !== 'lamp';
  const show: Record<string, boolean> = { expSurface: !litho, expSolid: !litho, expStl: true, exp3mf: litho, expPng: !litho, expStand: flat, expRough: !litho && params.roughOn, expFinish: !litho };
  for (const [id, vis] of Object.entries(show)) {
    const b = $(id) as HTMLButtonElement;
    b.hidden = !vis;
    b.disabled = !on;
  }
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
  $('cropRow').hidden = false;
  photoName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'relief';
  havePhoto = false;
  photoModels = false;
  lastStats = null;
  setExportsEnabled(false);
  exportInfo('');
  await drawPhoto(file);
  for (const id of ['cvMask', 'cvDepth', 'cvRelief']) {
    const c = $<HTMLCanvasElement>(id);
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }
  if (params.mode === 'lithophane') {
    // a lithophane only needs the photo's brightness: no models to download or run
    const raw = await photoLuminance(file);
    if (file !== lastFile) return;
    if (raw.crop) drawPhoto(file, raw.crop);
    sendCompute({ type: 'inputs', slot: 'photo', models: false, raw }, [raw.luminance.data.buffer]);
    havePhoto = true;
    status('Photo loaded.' + (raw.crop ? ' Plain border around the picture trimmed off.' : ''));
    if (isLamp() && !lampImgs.list.length) await lampImgs.add([file]);
    busy = false;
    requestRelief();
    return;
  }
  analyze(file);
}

/** runs the depth and mask models on the photo (CNC relief) */
function analyze(file: File) {
  modelsRunning = true;
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
    modelsRunning = false;
    status(`Model error: ${m.message}`, true);
    return;
  }
  modelsRunning = false;
  usedMaskModel = m.maskModel;
  $('device').textContent = m.device === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
  status(
    `Analysed in ${(m.ms / 1000).toFixed(1)} s on ${m.device === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'}.` +
      (m.raw.crop ? ' Plain border around the picture trimmed off.' : ''),
  );
  if (m.raw.crop && lastFile) drawPhoto(lastFile, m.raw.crop);
  const t: Transferable[] = [m.raw.luminance.data.buffer, m.raw.depth.data.buffer];
  if (m.raw.mask) t.push(m.raw.mask.data.buffer);
  sendCompute({ type: 'inputs', slot: 'photo', models: true, raw: m.raw }, t);
  havePhoto = true;
  photoModels = true;
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
    let shown = m.z;
    if (m.mesh) {
      preview.setLithoMesh(m.mesh.pos, m.mesh.idx, m.mesh.h, m.mesh.topTris, m.mesh.upright, m.mesh.axis);
      applySpin();
    }
    else {
      const view = viewMode();
      if (m.left && view === 'cut') {
        shown = new Float32Array(m.z.length);
        for (let k = 0; k < shown.length; k++) shown[k] = m.z[k] + m.left[k];
      }
      preview.setHeightfield(shown, m.nx, m.ny, m.stats.widthMm, m.stats.heightMm);
      preview.setReach(m.left && view === 'reach' ? m.left : null);
      lastPathTimes = m.paths ? { rough: m.paths.roughSec, finish: m.paths.finishSec } : null;
    }
    preview.setToolpaths(m.paths?.rough ?? null, m.paths?.finish ?? null);
    updateCamInfo();
    drawRelief(shown, m.nx, m.ny, m.stats);
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
    const FILES: Record<ExportKind, [string, string, string]> = {
      surface: ['_surface', 'step', 'application/step'],
      solid: ['_solid', 'step', 'application/step'],
      stl: ['', 'stl', 'model/stl'],
      '3mf': ['', '3mf', 'model/3mf'],
      png: ['_heightmap', 'png', 'image/png'],
      gcodeRough: ['_roughing', 'nc', 'text/plain'],
      gcodeFinish: ['_finishing', 'nc', 'text/plain'],
      stand: ['_stand', 'stl', 'model/stl'],
    };
    const [suffix, ext, mime] = FILES[m.kind];
    const blob = new Blob([m.bytes as BlobPart], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${isLamp() && m.kind !== 'stand' ? 'lamp_shade' : photoName}${suffix}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    exportInfo(`${exportKind}: ${(m.bytes.length / 1e6).toFixed(1)} MB — ${m.info}`);
    setExportsEnabled(true);
  }
};

function doExport(kind: ExportKind, label: string) {
  if (!haveInputsFor()) return;
  exportKind = label;
  setExportsEnabled(false);
  exportInfo(kind === 'surface' || kind === 'solid' ? 'Fitting B-spline surface…' : `Building ${label}…`);
  sendCompute({ type: 'export', id: ++exportId, params: { ...params }, kind, name: photoName, units });
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
  // a photo loaded for a relief still needs its brightness sent for a lithophane, and vice versa
  if (params.mode === 'lithophane' && lastFile && !havePhoto && !modelsRunning) loadPhoto(lastFile);
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
const backdropSel = $('backdrop') as HTMLSelectElement;
try {
  backdropSel.value = localStorage.getItem('relief-generator:backdrop') === 'dark' ? 'dark' : 'light';
} catch {
  /* storage unavailable */
}
preview.setBackdrop(backdropSel.value as 'light' | 'dark');
backdropSel.addEventListener('change', () => {
  preview.setBackdrop(backdropSel.value as 'light' | 'dark');
  try {
    localStorage.setItem('relief-generator:backdrop', backdropSel.value);
  } catch {
    /* storage unavailable */
  }
});

$('expSurface').addEventListener('click', () => doExport('surface', 'STEP surface'));
$('expSolid').addEventListener('click', () => doExport('solid', 'STEP solid'));
$('expStl').addEventListener('click', () => doExport('stl', 'STL'));
$('exp3mf').addEventListener('click', () => doExport('3mf', '3MF'));
$('expPng').addEventListener('click', () => doExport('png', 'Height map'));
$('expStand').addEventListener('click', () => doExport('stand', 'Stand STL'));
$('expRough').addEventListener('click', () => doExport('gcodeRough', 'Roughing G-code'));
$('expFinish').addEventListener('click', () => doExport('gcodeFinish', 'Finishing G-code'));
$('showPaths').addEventListener('change', () => {
  if (!showPaths()) preview.setToolpaths(null, null);
  updateCamInfo();
  requestRelief();
});
$('camRecommend').addEventListener('click', () => {
  const mat = params.camMaterial;
  const fin = recommend(mat, { type: params.toolType, diameter: params.toolDiameter, angle: params.toolAngle }, params.finFlutes, 'finish');
  const rough = recommend(mat, { type: params.roughType, diameter: params.roughDiameter, angle: 0 }, params.roughFlutes, 'rough');
  Object.assign(params, {
    finRpm: fin.rpm,
    finFeed: fin.feed,
    finPlunge: fin.plunge,
    finStepover: fin.stepover,
    roughRpm: rough.rpm,
    roughFeed: rough.feed,
    roughPlunge: rough.plunge,
    roughStepdown: rough.stepdown,
    roughStepover: rough.stepover,
  });
  syncInputs();
  onParamsChanged();
});
$('view').addEventListener('change', () => {
  updateDims();
  requestRelief();
});
let spinning = false;
/** spin settings → preview; the strobe needs one flash per lamp picture */
function applySpin() {
  const rpm = Math.min(300, Math.max(1, Number(($('rpm') as HTMLInputElement).value) || 10));
  const strobe = ($('strobe') as HTMLInputElement).checked && isLamp() && lampImgs.list.length > 1;
  const n = lampImgs.list.length;
  $('fps').textContent = strobe ? `${((rpm * n) / 60).toFixed(1)} pictures/s` : '';
  preview.setSpin(spinning, rpm, strobe ? n : 0);
}
$('spin').addEventListener('click', () => {
  spinning = !spinning;
  $('spin').classList.toggle('on', spinning);
  applySpin();
});
for (const id of ['rpm', 'strobe']) $(id).addEventListener('change', applySpin);
$('rpm').addEventListener('input', applySpin);
$('cropBtn').addEventListener('click', async () => {
  if (!lastFile) return;
  const f = await cropDialog(lastFile);
  if (f) loadPhoto(f);
});
const lampFiles = $<HTMLInputElement>('lampFiles');
lampFiles.addEventListener('change', () => {
  if (lampFiles.files) lampImgs.add([...lampFiles.files]);
  lampFiles.value = '';
});
$('lampClear').addEventListener('click', () => lampImgs.clear());
const lampBox = $('lampBox');
lampBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  lampBox.classList.add('over');
});
lampBox.addEventListener('dragleave', () => lampBox.classList.remove('over'));
lampBox.addEventListener('drop', (e) => {
  e.preventDefault();
  lampBox.classList.remove('over');
  if (e.dataTransfer?.files) lampImgs.add([...e.dataTransfer.files]);
});

// offline support (production builds only)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker registration failed', e));
}
