import { DEFAULT_PARAMS, PRESETS, PresetName, ReliefParams, minLithoRadius, effectiveGridSpacing, CAM_KEYS, LAYOUT_KEYS } from '../core/params';
import { resolveLayout, outlineLoop, isPattern, type Layout } from '../core/layout';
import { shadeHeightfield } from '../core/shade';
import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import type { MaskModelKey, Device } from '../models/infer';
import type { MachGrid } from '../core/resample';
import type { ComputeRequest, ComputeResponse, ExportKind, GcodeOp, ModelRequest, ModelResponse, ReliefStats } from '../workers/protocol';
import { FIELDS, Field, CAM_GROUPS, CamGroup } from './schema';
import { maskQuality } from '../core/maskQuality';
import { MASK_MODELS } from '../models/infer';
import { ReliefPreview, Finish } from './preview3d';
import { backlitBrightness } from '../core/litho';
import { photoLuminance, LampImages, cropDialog } from './images';
import { recommend, stepoverFor, scallopHeight, chipRatio, toolLabel, type Material } from '../core/cam';
import type { Cutter, ToolType } from '../core/cutter';
import { loadTools, saveTools, defaultName, sameTool, type LibTool } from './tools';
import { initTooltips } from './tooltip';

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

// ---- run times: a second worker times the G-code passes, so the preview never waits for it ---------
let timesWorker: Worker | null = null;
let timesBusy = false;
let timesId = 0;
let timesState: 'none' | 'working' | 'done' = 'none';
const OP_GROUP: Record<string, CamGroup> = { roughing: 'rough', finishing: 'finish', detail: 'detail', cutout: 'cutout' };

function showTimes() {
  for (const g of ['job', 'rough', 'finish', 'detail', 'cutout'] as CamGroup[]) {
    const el = document.getElementById(`time_${g}`);
    if (!el) continue;
    let text = '';
    if (timesState === 'working') text = '· estimating…';
    else if (timesState === 'done' && lastPaths) {
      if (g === 'job') text = lastPaths.ops.length ? `· about ${fmtTime(lastPaths.total)} in all` : '';
      else {
        const o = lastPaths.ops.find((q) => OP_GROUP[q.name] === g);
        text = o ? `· about ${fmtTime(o.sec)}` : '';
      }
    }
    el.textContent = text;
  }
}

/** times the passes for the surface just computed; a newer request cancels one still running */
function requestTimes(mach: MachGrid, p: ReliefParams) {
  if (timesBusy && timesWorker) {
    timesWorker.terminate();
    timesWorker = null;
  }
  if (!timesWorker) {
    timesWorker = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
    timesWorker.onmessage = (ev: MessageEvent<ComputeResponse>) => {
      const m = ev.data;
      if (m.type === 'error') {
        timesBusy = false;
        timesState = 'none';
        showTimes();
        return;
      }
      if (m.type !== 'times' || m.id !== timesId) return;
      timesBusy = false;
      lastPaths = { ops: m.ops, total: m.total };
      timesState = 'done';
      showTimes();
      updateCamInfo();
    };
  }
  timesBusy = true;
  timesState = 'working';
  showTimes();
  timesWorker.postMessage({ type: 'times', id: ++timesId, params: p, mach } satisfies ComputeRequest, [mach.z.buffer]);
}

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

// ---- G-code section: groups and the tool library ------------------------------------------------
const camGroups = new Map<CamGroup, HTMLElement>();
/** the container for a group of G-code fields (created in the order they first appear) */
function camHost(g: CamGroup): HTMLElement {
  let el = camGroups.get(g);
  if (!el) {
    if (g === 'machine') {
      const d = document.createElement('details');
      d.innerHTML = `<summary>${CAM_GROUPS[g]} and G-code options</summary>`;
      el = d;
    } else {
      el = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = CAM_GROUPS[g];
      // estimated run time of this pass (the whole job on the Job heading)
      const t = document.createElement('span');
      t.className = 'op-time';
      t.id = `time_${g}`;
      t.title = 'Estimated run time from the feeds, rapids, ramps and spindle spin-up. Real runs take longer on lots of short moves (acceleration): often 10–30 % more.';
      h.appendChild(t);
      el.appendChild(h);
    }
    el.className = 'cam-group';
    el.id = `camg_${g}`;
    $('cam').appendChild(el);
    camGroups.set(g, el);
  }
  return el;
}

const finishTool = (): Cutter => ({ type: params.toolType, diameter: params.toolDiameter, angle: params.toolAngle });
const roughToolNow = (): Cutter => ({ type: params.roughType, diameter: params.roughDiameter, angle: 0 });
const detailToolNow = (): Cutter => ({ type: params.detailType, diameter: params.detailDiameter, angle: params.detailAngle });

type Slot = 'rough' | 'finish' | 'detail';
/** which tools each slot takes, and how it reads / sets them in the settings */
const SLOTS: Record<Slot, { types: ToolType[]; get: () => Omit<LibTool, 'name'>; set: (t: LibTool) => void }> = {
  rough: {
    types: ['flat', 'ball'],
    get: () => ({ ...roughToolNow(), flutes: params.roughFlutes }),
    set: (t) => Object.assign(params, { roughType: t.type, roughDiameter: t.diameter, roughFlutes: t.flutes }),
  },
  finish: {
    types: ['ball', 'taperedBall', 'vbit', 'flat'],
    get: () => ({ ...finishTool(), flutes: params.finFlutes }),
    set: (t) => Object.assign(params, { toolType: t.type, toolDiameter: t.diameter, toolAngle: t.type === 'ball' || t.type === 'flat' ? params.toolAngle : t.angle, finFlutes: t.flutes }),
  },
  detail: {
    types: ['ball', 'taperedBall', 'vbit'],
    get: () => ({ ...detailToolNow(), flutes: params.detailFlutes }),
    set: (t) => Object.assign(params, { detailType: t.type, detailDiameter: t.diameter, detailAngle: t.type === 'ball' ? params.detailAngle : t.angle, detailFlutes: t.flutes }),
  },
};
let library = loadTools();

/** "My tools" row: pick a saved tool, save the current one, or remove one */
function libRow(slot: Slot): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row lib';
  row.id = `lib_${slot}`;
  row.title = 'Your tool library (kept in this browser). Pick a tool to fill in its type, size and flutes. Save adds the tool currently set below.';
  const label = document.createElement('label');
  label.textContent = 'My tools';
  label.htmlFor = `libSel_${slot}`;
  const sel = document.createElement('select');
  sel.id = `libSel_${slot}`;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'small';
  save.textContent = 'Save';
  save.title = 'Add the current tool to your library';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'small';
  del.textContent = '×';
  del.title = 'Remove the selected tool from your library';
  del.id = `libDel_${slot}`;
  const wrap = document.createElement('span');
  wrap.className = 'lib-btns';
  wrap.append(save, del);
  row.append(label, sel, wrap);
  sel.addEventListener('change', () => {
    const t = library[Number(sel.value)];
    if (!t || sel.value === '') return;
    SLOTS[slot].set(t);
    syncInputs();
    onParamsChanged();
  });
  save.addEventListener('click', () => {
    const cur = SLOTS[slot].get();
    const name = prompt('Name for this tool in your library:', defaultName(cur));
    if (!name) return;
    library = library.filter((t) => !sameTool(t, cur));
    library.push({ ...cur, name });
    library.sort((a, b) => a.type.localeCompare(b.type) || b.diameter - a.diameter);
    saveTools(library);
    syncLibs();
  });
  del.addEventListener('click', () => {
    const t = library[Number(sel.value)];
    if (!t || sel.value === '') return;
    if (!confirm(`Remove "${t.name}" from your tool library?`)) return;
    library.splice(Number(sel.value), 1);
    saveTools(library);
    syncLibs();
  });
  return row;
}

/** fills the library drop-downs and selects the entry matching each slot's current tool */
function syncLibs() {
  for (const slot of Object.keys(SLOTS) as Slot[]) {
    const sel = document.getElementById(`libSel_${slot}`) as HTMLSelectElement | null;
    if (!sel) continue;
    const cur = SLOTS[slot].get();
    const opts = [new Option('— pick a saved tool —', '')];
    let match = '';
    library.forEach((t, i) => {
      if (!SLOTS[slot].types.includes(t.type)) return;
      opts.push(new Option(t.name, String(i)));
      if (!match && sameTool(t, cur)) match = String(i);
    });
    sel.replaceChildren(...opts);
    sel.value = match;
    ($(`libDel_${slot}`) as HTMLButtonElement).disabled = !match;
  }
}

function buildFields() {
  for (const f of FIELDS) {
    const host = f.advanced ? $('advanced') : f.stock ? $('stock') : f.cam ? camHost(f.group ?? 'job') : $('basic');
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
      let og: HTMLOptGroupElement | null = null;
      for (const [v, t, g] of f.options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = t;
        if (g) {
          if (og?.label !== g) {
            og = document.createElement('optgroup');
            og.label = g;
            input.appendChild(og);
          }
          og.appendChild(o);
        } else input.appendChild(o);
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
    if (f.key === 'finStepover') {
      // the finishing tool is chosen in the Relief section (it also drives the cut simulation)
      const t = document.createElement('div');
      t.className = 'row';
      t.innerHTML = '<label>Tool</label><span id="camFinTool" class="cam-note"></span>';
      host.appendChild(t);
      host.appendChild(libRow('finish'));
    }
    host.appendChild(row);
    if (f.key === 'roughOn') host.appendChild(libRow('rough'));
    if (f.key === 'detailOn') host.appendChild(libRow('detail'));
    if (f.key === 'cutoutOn') {
      const t = document.createElement('div');
      t.className = 'cam-note';
      t.id = 'cutoutNote';
      host.appendChild(t);
    }
    if (f.key === 'camMaterial') host.appendChild($('camRecRow'));
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
  // the roughing tool also does the cutout
  const roughTool = params.roughOn || params.cutoutOn;
  for (const k of ['roughType', 'roughDiameter', 'roughFlutes', 'roughStepdown', 'roughRpm', 'roughFeed', 'roughPlunge'] as const) vis(k, roughTool);
  for (const k of ['roughStepover', 'roughAllowance'] as const) vis(k, params.roughOn);
  $('lib_rough').hidden = !roughTool;
  for (const k of ['detailType', 'detailDiameter', 'detailFlutes', 'detailStepover', 'detailRpm', 'detailFeed', 'detailPlunge'] as const) vis(k, params.detailOn);
  vis('detailAngle', params.detailOn && params.detailType !== 'ball');
  $('lib_detail').hidden = !params.detailOn;
  for (const k of ['cutoutTabs', 'cutoutTabW', 'cutoutTabH', 'cutoutThrough', 'cutoutDir'] as const) vis(k, params.cutoutOn);
  vis('cutoutTabW', params.cutoutOn && params.cutoutTabs > 0);
  vis('cutoutTabH', params.cutoutOn && params.cutoutTabs > 0);
  const shapeName = { rect: 'the stock edge', rounded: 'the rounded outline', oval: 'the oval', arch: 'the arched outline' }[params.outlineShape];
  const along = params.outlineShape === 'rect' && params.borderInset > 0 ? 'the outline (inset from the stock edge)' : shapeName;
  $('cutoutNote').textContent = params.cutoutOn ? `Goes round ${along} (Stock & border). Uses the roughing tool (${params.roughOn ? 'set above' : 'shown above'}) and its stepdown and feeds.` : '';
  syncLibs();
  $('camSection').hidden = litho;
  $('stockSection').hidden = litho;
  $('widthLabel').textContent = litho ? 'Width' : 'Picture width';
  $('heightLabel').textContent = litho ? 'Height' : 'Picture height';
  vis('outlineCorner', params.outlineShape === 'rounded');
  vis('borderInset', !(params.stockW > 0 && params.stockH > 0));
  for (const k of ['borderWidth', 'borderHeight', 'borderGap'] as const) vis(k, params.borderStyle !== 'none');
  vis('borderPitch', isPattern(params.borderStyle));
  drawLayout();
  $('pathCtl').hidden = litho;
  updateCamInfo();
  if (!litho) {
    vis('bgLevel', params.bgMode === 'keep');
    vis('baseGamma', params.method === 'baseDetail');
    vis('gradThreshold', params.method === 'gradient');
    vis('toneDarkUp', params.toneDepth > 0);
    vis('toneScale', params.toneDepth > 0);
    vis('toolAngle', params.toolType !== 'ball' && params.toolType !== 'flat');
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
  hOut.textContent = fmtLen(s.picH ?? s.heightMm);
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

let lastPaths: { ops: { name: string; sec: number }[]; total: number } | null = null;
let lastDetailArea: number | undefined;
let recNote = '';
const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};
const fmtRate = (mm: number) => (units === 'in' ? `${(mm / MM_PER_IN).toFixed(1)} in/min` : `${Math.round(mm)} mm/min`);
const fmtChip = (mm: number) => (units === 'in' ? `${(mm / MM_PER_IN).toFixed(4)}"` : `${mm.toFixed(3)} mm`);

/**
 * Checks the G-code settings and says what they will give: ridge height, chip loads against the
 * chart, settings the machine cannot do, run times. Problems go in the warning box.
 */
function updateCamInfo() {
  const ft = finishTool();
  const note = document.getElementById('camFinTool');
  if (note) note.textContent = `${toolLabel(ft, fmtLen)}, set under Relief`;
  const info: string[] = [], warn: string[] = [];
  if (recNote) info.push(recNote);
  const mat = params.camMaterial as Material;
  const ridge = scallopHeight(ft, params.finStepover);
  const rec = stepoverFor(ft);
  info.push(`Finish ridges ≈ ${fmtLen(ridge)} on flat areas (recommended stepover ${fmtLen(rec)}).`);
  if (ridge > 0.05) warn.push(`Finishing ridges of ${fmtLen(ridge)} will show and need sanding: bring the finishing stepover down toward ${fmtLen(rec)}.`);
  type Op = { label: string; tool: Cutter; flutes: number; rpm: number; feed: number; plunge: number; kind: 'rough' | 'finish' };
  const ops: Op[] = [];
  if (params.roughOn || params.cutoutOn)
    ops.push({ label: params.roughOn ? 'Roughing' : 'Cutout', tool: roughToolNow(), flutes: params.roughFlutes, rpm: params.roughRpm, feed: params.roughFeed, plunge: params.roughPlunge, kind: 'rough' });
  ops.push({ label: 'Finishing', tool: ft, flutes: params.finFlutes, rpm: params.finRpm, feed: params.finFeed, plunge: params.finPlunge, kind: 'finish' });
  if (params.detailOn) ops.push({ label: 'Detail', tool: detailToolNow(), flutes: params.detailFlutes, rpm: params.detailRpm, feed: params.detailFeed, plunge: params.detailPlunge, kind: 'finish' });
  const loads: string[] = [];
  for (const o of ops) {
    const c = chipRatio(mat, o.tool, o.flutes, o.rpm, o.feed, o.kind);
    loads.push(`${o.label.toLowerCase()} ${fmtChip(c.actual)} (chart ${fmtChip(c.chart)})`);
    if (c.ratio < 0.5) warn.push(`${o.label}: the chip load is under half the chart, so the tool will rub, burn the wood and dull. Raise the feed or slow the spindle (Use recommended).`);
    else if (c.ratio > 1.6) warn.push(`${o.label}: the chip load is well over the chart: risk of breaking the tool. Lower the feed or speed up the spindle.`);
    if (o.rpm > params.maxRpm + 1 || o.rpm < params.minRpm - 1) warn.push(`${o.label}: ${o.rpm} rpm is outside your spindle's range (${params.minRpm}–${params.maxRpm} rpm, under Machine).`);
    if (o.feed > params.maxFeed + 1) warn.push(`${o.label}: feed ${fmtRate(o.feed)} is above your machine's max feed (${fmtRate(params.maxFeed)}).`);
    if (o.plunge > o.feed + 1) warn.push(`${o.label}: the plunge rate is faster than the feed.`);
  }
  info.push(`Chip load per tooth: ${loads.join(', ')}.`);
  if (params.roughOn) {
    if (params.roughDiameter <= params.toolDiameter) warn.push('The roughing tool is not bigger than the finishing tool, so roughing gains nothing.');
    if (params.roughStepover > 0.9 * params.roughDiameter) warn.push(`The roughing stepover is ${Math.round((100 * params.roughStepover) / params.roughDiameter)} % of the tool Ø: it leaves ridges of material between the lines. Keep it under about 50 %.`);
    if (params.roughStepdown > params.roughDiameter) warn.push('The roughing stepdown is deeper than the tool is wide: hard on the tool and the machine.');
  } else if (params.reliefHeight > 2 * params.toolDiameter) warn.push(`No roughing: the finishing tool cuts the full ${fmtLen(params.reliefHeight)} depth in one pass. Only for soft material and shallow reliefs.`);
  const missed = lastStats?.missedFrac ?? 0;
  if (params.detailOn) {
    if (params.detailDiameter >= params.toolDiameter && params.detailType === params.toolType) warn.push('The detail tool is not smaller than the finishing tool, so it has nothing to do.');
    info.push(`Detail ridges ≈ ${fmtLen(scallopHeight(detailToolNow(), params.detailStepover))} (recommended stepover ${fmtLen(stepoverFor(detailToolNow()))}).`);
    if (lastDetailArea !== undefined && lastStats) {
      const pct = (100 * lastDetailArea) / (lastStats.widthMm * lastStats.heightMm);
      info.push(pct < 0.05 ? 'The detail tool has next to nothing to do on this relief: the finishing tool reaches nearly everything.' : `The detail pass works on ${pct.toFixed(1)} % of the part.`);
    }
  } else if (missed > 0.01)
    info.push(`Tip: the finishing tool can't reach ${(100 * missed).toFixed(1)} % of the surface (Show: Missed areas). A detail pass with a smaller tapered ball or V-bit gets into those spots.`);
  if (params.cutoutOn && params.roughType !== 'flat') warn.push('Cutting out with a ball end mill leaves a rounded edge at the bottom; a flat end mill is better.');
  if (params.stockThick > 0 && lastStats && params.stockThick < lastStats.zMax - 1e-3)
    warn.push(`The stock (${fmtLen(params.stockThick)}) is thinner than the part (${fmtLen(lastStats.zMax)}): it is taken as exactly the part height.`);
  if (params.zZero === 'top' && params.stockThick === 0) info.push('Z0 on top of the stock assumes the stock is exactly the part height. Set Stock thickness if your board is thicker.');
  if (lastPaths && timesState === 'done')
    info.push(`Estimated time: ${lastPaths.ops.map((o) => `${o.name} ${fmtTime(o.sec)}`).join(', ')}${lastPaths.ops.length > 1 ? `; ${fmtTime(lastPaths.total)} in all, plus tool changes` : ''}. Real runs take longer on lots of short moves (acceleration), often 10–30 %.`);
  else if (timesState === 'working') info.push('Working out run times…');
  info.push(`X0 Y0 = front-left corner of the stock; Z0 = ${params.zZero === 'top' ? 'top of the stock' : 'spoilboard'}. Set Z0 again after each tool change.`);
  $('camInfo').textContent = info.join('\n');
  const w = $('camWarn');
  w.textContent = warn.join('\n');
  w.hidden = warn.length === 0;
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
  const name = toolLabel(finishTool(), fmtLen);
  const after = params.detailOn ? ` (after the detail pass, ${fmtLen(params.detailDiameter)} ${params.detailType === 'vbit' ? 'V-bit' : params.detailType === 'ball' ? 'ball' : 'tapered'})` : '';
  return `
tool   ${name}: can't reach ${(100 * s.missedFrac).toFixed(1)} % (up to ${fmtLen(s.maxLeft ?? 0)} left)${after}`;
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

/** the settings of the relief being computed (the run times go with them) */
let sentParams: ReliefParams = { ...params };

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
  sentParams = { ...params };
  sendCompute({ type: 'params', id: ++reliefId, params: sentParams, view: viewMode(), toolpaths: showPaths() });
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
  const show: Record<string, boolean> = {
    expSurface: !litho,
    expSolid: !litho,
    expStl: true,
    exp3mf: litho,
    expPng: !litho,
    expStand: flat,
    expWedge: litho,
    expRough: !litho && params.roughOn,
    expFinish: !litho,
    expDetail: !litho && params.detailOn,
    expCutout: !litho && params.cutoutOn,
    expAll: !litho && (params.roughOn || params.detailOn || params.cutoutOn),
    expSetup: !litho,
  };
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
      lastDetailArea = m.stats.detailArea;
      if (m.paths) {
        // the toolpaths came with their times
        if (timesBusy && timesWorker) {
          timesWorker.terminate();
          timesWorker = null;
          timesBusy = false;
        }
        lastPaths = { ops: m.paths.ops.map((o) => ({ name: o.name, sec: o.sec })), total: m.paths.total };
        timesState = 'done';
        showTimes();
      } else if (!dirty) {
        // time the passes for this surface in the background
        const p = sentParams, s = m.stats;
        const layout = s.picW && s.picH ? resolveLayout(p, s.picW, s.picH) : undefined;
        requestTimes({ nx: m.nx, ny: m.ny, dx: s.dx, dy: s.heightMm / (m.ny - 1), widthMm: s.widthMm, heightMm: s.heightMm, z: new Float32Array(m.z), zMin: s.zMin, zMax: s.zMax, layout }, p);
      }
    }
    // the stock box and origin always show for a relief; the paths when ticked
    const stockTop = Math.max(m.stats.zMax, params.stockThick);
    preview.setToolpaths(m.paths?.ops ?? null, params.mode === 'relief' ? { stockTop, zeroZ: params.zZero === 'top' ? stockTop : 0 } : undefined);
    updateCamInfo();
    drawRelief(shown, m.nx, m.ny, m.stats);
    drawLayout();
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
    if (m.kind === 'setup') {
      const html = new TextDecoder().decode(m.bytes);
      if (setupWin && !setupWin.closed) {
        setupWin.document.open();
        setupWin.document.write(html);
        setupWin.document.close();
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = `${photoName}_setup.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      setupWin = null;
      exportInfo('Setup sheet opened in a new tab (print it from there).');
      setExportsEnabled(true);
      return;
    }
    const FILES: Record<Exclude<ExportKind, 'setup'>, [string, string, string]> = {
      surface: ['_surface', 'step', 'application/step'],
      solid: ['_solid', 'step', 'application/step'],
      stl: ['', 'stl', 'model/stl'],
      '3mf': ['', '3mf', 'model/3mf'],
      png: ['_heightmap', 'png', 'image/png'],
      gcode: [`_${exportOp}`, 'nc', 'text/plain'],
      stand: ['_stand', 'stl', 'model/stl'],
      wedge: ['litho_test_strip', 'stl', 'model/stl'],
    };
    const [suffix, ext, mime] = FILES[m.kind];
    const blob = new Blob([m.bytes as BlobPart], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m.kind === 'wedge' ? `${suffix}.${ext}` : `${isLamp() && m.kind !== 'stand' ? 'lamp_shade' : photoName}${suffix}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    exportInfo(`${exportKind}: ${(m.bytes.length / 1e6).toFixed(1)} MB — ${m.info}`);
    setExportsEnabled(true);
  }
};

// ---- stock & border layout ---------------------------------------------------------------------
/** the layout as the panel shows it now (null before the first relief: the picture's shape is unknown) */
function currentLayout(): Layout | null {
  const s = lastStats;
  if (params.mode !== 'relief' || !s?.picW || !s.picH) return null;
  return resolveLayout(params, params.widthMm, (params.widthMm * s.picH) / s.picW);
}
let layoutK = 1;
let snapped = { x: false, y: false };

/** top view of the stock: the last shaded relief, the outline, the border and the picture frame */
function drawLayout() {
  const cv = $<HTMLCanvasElement>('layoutCv');
  const L = currentLayout();
  const info = $('stockInfo');
  if (!L) {
    cv.hidden = true;
    info.textContent = params.mode === 'relief' ? 'Load a photo to lay it out on the stock.' : '';
    return;
  }
  cv.hidden = false;
  const avail = Math.max(160, (cv.parentElement as HTMLElement).clientWidth || 300);
  const k = Math.min(avail / L.W, 240 / L.H);
  layoutK = k;
  const w = Math.max(1, Math.round(L.W * k)), h = Math.max(1, Math.round(L.H * k));
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#3a342c';
  ctx.fillRect(0, 0, w, h);
  // the shaded relief covers the stock as last computed
  const s = lastStats!;
  const rc = $<HTMLCanvasElement>('cvRelief');
  if (rc.width > 1 && Math.abs(s.widthMm - L.W) < 0.05 && Math.abs(s.heightMm - L.H) < 0.05) ctx.drawImage(rc, 0, 0, w, h);
  const X = (x: number) => x * k, Y = (y: number) => h - y * k;
  const path = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
  };
  const tol = 0.5 / k;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e0b070';
  path(outlineLoop(L.outline, 0, tol));
  ctx.stroke();
  if (L.bw > 0) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(224,176,112,0.6)';
    path(outlineLoop(L.outline, -L.bw, tol));
    ctx.stroke();
  }
  // centre lines the picture snaps to
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  if (snapped.x) ctx.moveTo(w / 2 + 0.5, 0), ctx.lineTo(w / 2 + 0.5, h);
  if (snapped.y) ctx.moveTo(0, h / 2 + 0.5), ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();
  // the picture
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#7fc8ff';
  ctx.lineWidth = 1.5;
  const p = L.pic;
  ctx.strokeRect(X(p.x0) + 0.5, Y(p.y0 + p.h) + 0.5, p.w * k - 1, p.h * k - 1);
  ctx.setLineDash([]);

  const fmtOff = (v: number) => (Math.abs(v) < 1e-6 ? '0' : (v > 0 ? '+' : '−') + fmtLen(Math.abs(v)));
  const o = L.outline;
  const lines = [
    `Stock ${fmtLen(L.W)} × ${fmtLen(L.H)}` + (params.stockThick > 0 ? ` × ${fmtLen(params.stockThick)}` : '') + (params.stockW || params.stockH ? '' : ' (fits the part)'),
    `Part ${fmtLen(2 * o.a)} × ${fmtLen(2 * o.b)}` + (params.partW || params.partH ? '' : ' (fits the picture)') + `, ${params.picX || params.picY ? `moved ${fmtOff(params.picX)} X, ${fmtOff(params.picY)} Y` : 'in the middle'}; picture ${fmtLen(p.w)} × ${fmtLen(p.h)}.`,
  ];
  if (o.cx - o.a < -0.01 || o.cy - o.b < -0.01 || o.cx + o.a > L.W + 0.01 || o.cy + o.b > L.H + 0.01)
    lines.push('The part runs off the stock: make the stock bigger, the part smaller, or move it.');
  // a board thicker than the part: the part sits that much lower, as a pocket in the board
  const partTop = params.baseThickness + Math.max(params.reliefHeight, L.bh);
  const extra = params.stockThick - partTop;
  if (extra > 0.1)
    lines.push(
      `The board is ${fmtLen(extra)} thicker than the part, so the part is ${params.cutoutOn ? 'faced down that much and cut out' : 'sunk that deep into the board'}. ` +
        `To carve only the relief from the top of the board, set Base thickness to ${fmtLen(params.baseThickness + extra)}.`,
    );
  if (L.border !== 'none' && isPattern(L.border)) lines.push(`Pattern repeat about ${fmtLen(L.pitch)} (fitted so the ends meet).`);
  // what falls outside the space inside the border
  const a = L.outline.a - L.window, b = L.outline.b - L.window, cx = L.outline.cx, cy = L.outline.cy;
  const over = p.x0 < cx - a - 0.01 || p.x0 + p.w > cx + a + 0.01 || p.y0 < cy - b - 0.01 || p.y0 + p.h > cy + b + 0.01;
  if (over || L.outline.kind === 'oval' || L.outline.kind === 'arch')
    lines.push(L.border !== 'none' || L.window > 0 ? 'What reaches past the border fades out before it.' : 'What reaches past the outline fades out at it.');
  if (L.border !== 'none' && params.outlineShape === 'rounded' && isPattern(L.border) && L.outline.c < L.bw / 2)
    lines.push('Tip: a corner radius of at least half the border width lets the pattern flow round the corners.');
  info.textContent = lines.join('\n');
  const auto = !(params.stockW > 0 || params.stockH > 0 || params.partW > 0 || params.partH > 0);
  ($('picFit') as HTMLButtonElement).disabled = auto;
  ($('picFill') as HTMLButtonElement).disabled = auto;
}

function setParam<K extends keyof ReliefParams>(key: K, v: ReliefParams[K]) {
  params[key] = v;
  const e = inputs.get(key);
  if (e) e.input.value = String(v);
}

/**
 * Picture size that fits inside (or fills) the space inside the border: of the part size that was
 * set, or else of the biggest part the stock that was set takes (less the edge margin).
 */
function fitPicture(fill: boolean) {
  const L = currentLayout();
  if (!L) return;
  const aspect = L.pic.w / L.pic.h;
  const box = (part: number, stock: number) => (part > 0 ? part : stock > 0 ? stock - 2 * params.borderInset : Infinity);
  const wMax = box(params.partW, params.stockW) - 2 * L.window;
  const hMax = box(params.partH, params.stockH) - 2 * L.window;
  const byH = hMax * aspect;
  const w = Number.isFinite(wMax) && Number.isFinite(byH) ? (fill ? Math.max(wMax, byH) : Math.min(wMax, byH)) : Math.min(wMax, byH);
  if (!(w > 1) || !Number.isFinite(w)) return;
  params.widthMm = Math.round(w * 10) / 10;
  setParam('picX', 0);
  setParam('picY', 0);
  syncInputs();
  onParamsChanged();
}

{
  const cv = $<HTMLCanvasElement>('layoutCv');
  let drag: { x: number; y: number; px: number; py: number } | null = null;
  const move = (nx: number, ny: number) => {
    // snap to the centre lines within a few pixels
    const snap = 6 / layoutK;
    snapped = { x: Math.abs(nx) < snap, y: Math.abs(ny) < snap };
    setParam('picX', snapped.x ? 0 : Math.round(nx * 10) / 10);
    setParam('picY', snapped.y ? 0 : Math.round(ny * 10) / 10);
    syncOutputs(true);
    onParamsChanged();
  };
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, px: params.picX, py: params.picY };
    cv.setPointerCapture(e.pointerId);
    cv.classList.add('dragging');
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    move(drag.px + (e.clientX - drag.x) / layoutK, drag.py - (e.clientY - drag.y) / layoutK);
  });
  const end = () => {
    drag = null;
    snapped = { x: false, y: false };
    cv.classList.remove('dragging');
    drawLayout();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('keydown', (e) => {
    const step = (units === 'in' ? MM_PER_IN / 16 : 1) * (e.shiftKey ? 10 : 1);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setParam('picX', Math.round((params.picX + d[0]) * 100) / 100);
    setParam('picY', Math.round((params.picY + d[1]) * 100) / 100);
    syncOutputs(true);
    onParamsChanged();
  });
  $('picCentre').addEventListener('click', () => {
    setParam('picX', 0);
    setParam('picY', 0);
    syncOutputs(true);
    onParamsChanged();
  });
  $('picFit').addEventListener('click', () => fitPicture(false));
  $('picFill').addEventListener('click', () => fitPicture(true));
  window.addEventListener('resize', () => drawLayout());
}

let exportOp: GcodeOp = 'finishing';
let setupWin: Window | null = null;
function doExport(kind: ExportKind, label: string, op?: GcodeOp) {
  if (!haveInputsFor()) return;
  exportKind = label;
  if (op) exportOp = op;
  setExportsEnabled(false);
  exportInfo(kind === 'surface' || kind === 'solid' ? 'Fitting B-spline surface…' : `Building ${label}…`);
  sendCompute({ type: 'export', id: ++exportId, params: { ...params }, kind, name: photoName, units, op });
}

// ---- wiring --------------------------------------------------------------------------------------
buildFields();
initTooltips();
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
  // (and the G-code / machine settings: they belong to the shop, not the picture)
  const { mode, widthMm, reliefHeight, baseThickness } = params;
  const cam = Object.fromEntries([...CAM_KEYS, ...LAYOUT_KEYS].map((k) => [k, params[k]]));
  params = { ...DEFAULT_PARAMS, ...cam, mode, widthMm, reliefHeight, baseThickness };
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
$('expWedge').addEventListener('click', () => doExport('wedge', 'Test strip STL'));
$('expRough').addEventListener('click', () => doExport('gcode', 'Roughing G-code', 'roughing'));
$('expFinish').addEventListener('click', () => doExport('gcode', 'Finishing G-code', 'finishing'));
$('expDetail').addEventListener('click', () => doExport('gcode', 'Detail G-code', 'detail'));
$('expCutout').addEventListener('click', () => doExport('gcode', 'Cutout G-code', 'cutout'));
$('expAll').addEventListener('click', () => doExport('gcode', 'G-code (all tools)', 'all'));
$('expSetup').addEventListener('click', () => {
  // open the tab now, while the click still counts (pop-up blockers), and fill it in when ready
  setupWin = window.open('', '_blank');
  setupWin?.document.write('<p style="font:14px system-ui">Building the setup sheet…</p>');
  doExport('setup', 'Setup sheet');
});
$('showPaths').addEventListener('change', () => {
  if (!showPaths()) preview.setToolpaths(null);
  updateCamInfo();
  requestRelief();
});
$('camRecommend').addEventListener('click', () => {
  const mat = params.camMaterial as Material;
  const m = { minRpm: params.minRpm, maxRpm: params.maxRpm, maxFeed: params.maxFeed };
  const fin = recommend(mat, finishTool(), params.finFlutes, 'finish', m);
  const rough = recommend(mat, roughToolNow(), params.roughFlutes, 'rough', m);
  const det = recommend(mat, detailToolNow(), params.detailFlutes, 'finish', m);
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
    detailRpm: det.rpm,
    detailFeed: det.feed,
    detailPlunge: det.plunge,
    detailStepover: det.stepover,
  });
  const name = (($('p_camMaterial') as HTMLSelectElement).selectedOptions[0]?.textContent ?? mat).split(' (')[0];
  recNote = `Recommended speeds, feeds and stepovers filled in for ${name.toLowerCase()}.`;
  syncInputs();
  onParamsChanged();
  setTimeout(() => {
    recNote = '';
    updateCamInfo();
  }, 6000);
});

// ---- settings file: keep a job's settings with the photo, or move them to another computer -----
$('saveSettings').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'relief-generator', version: 1, units, params }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${photoName}_settings.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
const settingsFile = $<HTMLInputElement>('settingsFile');
settingsFile.addEventListener('change', async () => {
  const f = settingsFile.files?.[0];
  settingsFile.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j || typeof j.params !== 'object') throw new Error('not a Relief Generator settings file');
    params = { ...DEFAULT_PARAMS, ...j.params };
    if (j.units === 'mm' || j.units === 'in') units = j.units;
    syncInputs();
    onParamsChanged();
    status(`Settings loaded from ${f.name}.`);
  } catch (e) {
    status(`Could not load ${f.name}: ${e instanceof Error ? e.message : e}`, true);
  }
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
