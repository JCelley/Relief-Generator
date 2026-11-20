/// <reference lib="webworker" />
import { prepare, computeRelief, Prepared, RawInputs } from '../core/relief';
import { toMachiningGrid, MachGrid } from '../core/resample';
import { fitSurface } from '../core/bspline';
import { writeStep } from '../core/step';
import { heightfieldMesh, meshToStl, standMesh, decimateGrid, placeOnBed, upsideDown, Mesh } from '../core/mesh';
import { lithophaneGrid, lithoMesh, lithoRange } from '../core/litho';
import { simulateCut, CutResult } from '../core/cutter';
import { meshTo3mf, heightmapPng } from '../core/files';
import { geometryKey, CAM_KEYS, type ReliefParams } from '../core/params';
import type { ComputeRequest, ComputeResponse, PreviewPaths } from './protocol';
import { finishingPaths, finishingRuns, floorSkip, topSkip, roughRest, toolRadiusAt, roughingPaths, detailRegion, detailPaths, cutoutPath, writeGcode, previewSegments, chipRatio, type Toolpath, type GcodeOpts } from '../core/cam';
import type { Cutter } from '../core/cutter';
import { setupSheet } from '../core/setup';
import { outlineLoop, BORDER_STYLES } from '../core/layout';
import type { Grid } from '../core/grid';

declare const self: DedicatedWorkerGlobalScope;

let photo: { raw: RawInputs; models: boolean; ver: number } | null = null;
let lamp: { raw: RawInputs; panels: number; ver: number } | null = null;
let ver = 0;
let prep: Prepared | null = null;
/** the relief itself (slow); placing it on the stock and the border are worked out from it quickly */
let rel: { key: string; height: Grid; iterations?: number } | null = null;
const RELIEF_KEYS = [
  'method', 'compression', 'detailGain', 'baseScale', 'baseGamma', 'gradThreshold', 'textureGain', 'toneDepth', 'toneScale', 'toneDarkUp',
  'reliefHeight', 'falloffWidth', 'bgMode', 'bgLevel', 'maskThreshold', 'maskCleanup', 'widthMm', 'guideEps',
] as const satisfies readonly (keyof ReliefParams)[];
/** the current surface and what was worked out from it: cutter simulation, detail region, toolpaths */
let last: {
  key: string;
  mach: MachGrid;
  finishCut?: CutResult;
  detail?: { key: string; region: Uint8Array; cut: Float32Array; area: number };
  cut?: { key: string; res: CutResult };
  cam?: { key: string; ops: Toolpath[] };
} | null = null;

const post = (m: ComputeResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function getPrepared(p: ReliefParams): Prepared {
  if (!photo) throw new Error('no photo loaded');
  if (!photo.models) throw new Error('the photo has not been analysed yet');
  if (!prep || prep.guideEps !== p.guideEps) {
    prep = prepare(photo.raw, p.guideEps);
    post({ type: 'prepared', mask: { ...prep.mask, data: new Float32Array(prep.mask.data) }, depth: { ...prep.depth, data: new Float32Array(prep.depth.data) } });
  }
  return prep;
}

const isLamp = (p: ReliefParams) => p.mode === 'lithophane' && p.lithoShape === 'lamp';

function machFor(p: ReliefParams): { mach: MachGrid; ms: number; iterations?: number } {
  const src = isLamp(p) ? lamp?.ver : photo?.ver;
  // G-code settings do not change the surface: keep it (and its cutter simulation) when only they change
  const key = geometryKey(p) + '|' + src;
  if (last && last.key === key) return { mach: last.mach, ms: 0 };
  const t0 = performance.now();
  if (p.mode === 'lithophane') {
    const mach = isLamp(p)
      ? (() => {
          if (!lamp) throw new Error('add pictures for the lamp shade');
          return lithophaneGrid(lamp.raw.luminance, p, lamp.panels);
        })()
      : (() => {
          if (!photo) throw new Error('no photo loaded');
          return lithophaneGrid(photo.raw.luminance, p);
        })();
    last = { key, mach };
    return { mach, ms: performance.now() - t0 };
  }
  const pr = getPrepared(p);
  const rk = JSON.stringify(RELIEF_KEYS.map((k) => p[k])) + '|' + photo!.ver;
  let iterations: number | undefined;
  if (!rel || rel.key !== rk) {
    const r = computeRelief(pr, p);
    rel = { key: rk, height: r.height };
    iterations = r.iterations;
  }
  const mach = toMachiningGrid(rel.height, p);
  last = { key, mach };
  return { mach, ms: performance.now() - t0, iterations };
}

const finishTool = (p: ReliefParams): Cutter => ({ type: p.toolType, diameter: p.toolDiameter, angle: p.toolAngle });
const roughTool = (p: ReliefParams): Cutter => ({ type: p.roughType, diameter: p.roughDiameter, angle: 0 });
const detailTool = (p: ReliefParams): Cutter => ({ type: p.detailType, diameter: p.detailDiameter, angle: p.detailAngle });
const stockTopOf = (p: ReliefParams, mach: MachGrid) => Math.max(mach.zMax, p.stockThick);
const opFlutes = (p: ReliefParams, name: string) => (name === 'finishing' ? p.finFlutes : name === 'detail' ? p.detailFlutes : p.roughFlutes);

/** what the finishing tool leaves (no stepover ridges) */
function finishCutFor(p: ReliefParams): CutResult {
  machFor(p);
  if (!last!.finishCut) last!.finishCut = simulateCut(last!.mach, finishTool(p));
  return last!.finishCut;
}

/** where the detail tool works, and what it leaves there */
function detailFor(p: ReliefParams) {
  const fc = finishCutFor(p);
  const key = JSON.stringify(detailTool(p));
  if (!last!.detail || last!.detail.key !== key) last!.detail = { key, ...detailRegion(last!.mach, detailTool(p), fc.cut) };
  return last!.detail;
}

/** what the tools will leave: the finishing tool, then the detail tool in its region */
function cutFor(p: ReliefParams): CutResult {
  const fc = finishCutFor(p);
  if (!p.detailOn) return fc;
  const d = detailFor(p);
  if (last!.cut?.key === d.key) return last!.cut.res;
  const { z } = last!.mach;
  const cut = new Float32Array(fc.cut), left = new Float32Array(z.length);
  let missed = 0, maxLeft = 0;
  for (let k = 0; k < z.length; k++) {
    if (d.region[k]) cut[k] = Math.min(cut[k], d.cut[k]);
    const v = Math.max(0, cut[k] - z[k]);
    left[k] = v;
    if (v > 0.05) missed++;
    if (v > maxLeft) maxLeft = v;
  }
  const res = { cut, left, missedFrac: missed / z.length, maxLeft };
  last!.cut = { key: d.key, res };
  return res;
}

/** the operations in machining order: roughing (T1), finishing (T2), detail (T3), cutout (T1) */
function camOps(p: ReliefParams): { ops: Toolpath[]; mach: MachGrid } {
  const { mach } = machFor(p);
  const key = JSON.stringify(CAM_KEYS.map((k) => p[k]));
  const c = last!;
  if (c.cam?.key === key) return { ops: c.cam.ops, mach };
  const st = stockTopOf(p, mach);
  const ops: Toolpath[] = [];
  if (p.roughOn) {
    const r = roughingPaths(mach, { tool: roughTool(p), stepdown: p.roughStepdown, stepover: Math.max(0.05, p.roughStepover), allowance: p.roughAllowance, stockTop: st });
    ops.push({ name: 'roughing', number: 1, tool: roughTool(p), rpm: p.roughRpm, feed: p.roughFeed, plunge: p.roughPlunge, ...r });
  }
  const fin = { tool: finishTool(p), stepover: Math.max(0.01, p.finStepover), dir: p.finDir };
  // flat floor the roughing end mill already cut to depth is left out of the finishing pass
  // and so is uncut stock round the part (nothing to cut there)
  const floor = p.roughOn ? floorSkip(mach, roughTool(p), finishTool(p), Math.max(0.05, p.roughStepover)) : null;
  const top = topSkip(mach, finishTool(p), st);
  const skip = floor && top ? floor.map((v, k) => v | top[k]) : (floor ?? top);
  const finOp = { name: 'finishing', number: 2, tool: finishTool(p), rpm: p.finRpm, feed: p.finFeed, plunge: p.finPlunge };
  if (skip) {
    // without roughing the material may be anywhere up to the stock top
    const rest = p.roughOn ? roughRest(mach, roughTool(p), p.roughAllowance, Math.max(0.05, p.roughStepover), toolRadiusAt(finishTool(p), 2)) : new Float32Array(mach.z.length).fill(st);
    ops.push({ ...finOp, ...finishingRuns(mach, { ...fin, skip, rest, stockTop: st }) });
  }
  else {
    const fp = finishingPaths(mach, fin);
    ops.push({
      ...finOp,
      paths: fp,
      // after roughing the material is at most the allowance plus one roughing step above the surface;
      // a second (cross-hatch) pass goes over a surface that is already finished
      entry: fp.map((q, i) => (i > 0 ? q[2] + 0.2 : p.roughOn ? Math.min(st, q[2] + p.roughAllowance + p.roughStepdown) : st)),
    });
  }
  if (p.detailOn) {
    const d = detailFor(p);
    const r = detailPaths(mach, { tool: detailTool(p), stepover: Math.max(0.01, p.detailStepover), dir: p.finDir, finishCut: finishCutFor(p).cut, region: d.region });
    ops.push({ name: 'detail', number: 3, tool: detailTool(p), rpm: p.detailRpm, feed: p.detailFeed, plunge: p.detailPlunge, ...r });
  }
  if (p.cutoutOn) {
    // round the plaque outline (the stock edge unless a shape or inset is set)
    const o = mach.layout?.outline;
    const curved = o && (o.kind === 'oval' || o.kind === 'arch');
    const path = cutoutPath({
      tool: roughTool(p),
      widthMm: o ? 2 * o.a : mach.widthMm,
      heightMm: o ? 2 * o.b : mach.heightMm,
      x0: o ? o.cx - o.a : 0,
      y0: o ? o.cy - o.b : 0,
      corner: o?.c ?? 0,
      loop: curved ? outlineLoop(o, roughTool(p).diameter / 2) : undefined,
      stockTop: st,
      stepdown: p.roughStepdown,
      through: p.cutoutThrough,
      tabs: p.cutoutTabs,
      tabWidth: p.cutoutTabW,
      tabHeight: p.cutoutTabH,
      climb: p.cutoutDir === 'climb',
    });
    ops.push({ name: 'cutout', number: 1, tool: roughTool(p), rpm: p.roughRpm, feed: p.roughFeed, plunge: p.roughPlunge, paths: [path], entry: [st] });
  }
  c.cam = { key, ops };
  return { ops, mach };
}

function gcodeOpts(p: ReliefParams, mach: MachGrid, units: 'mm' | 'in'): GcodeOpts {
  const st = stockTopOf(p, mach);
  return {
    units,
    safeZ: p.safeZ,
    zZero: p.zZero,
    stockTop: st,
    rampAngle: p.rampAngle,
    spindleDelay: p.spindleDelay,
    toolChange: p.toolChange,
    notes: [
      `Stock ${mach.widthMm.toFixed(2)} x ${mach.heightMm.toFixed(2)} x ${st.toFixed(2)} mm; part ${mach.zMax.toFixed(2)} mm tall (base ${p.baseThickness.toFixed(2)} mm)`,
      'Check speeds, feeds and the toolpath before running. Air-cut first if unsure.',
    ],
  };
}

function partMesh(p: ReliefParams, mach: MachGrid): Mesh {
  if (p.mode === 'lithophane') return lithoMesh(mach, p).mesh;
  return heightfieldMesh(mach);
}

self.onmessage = async (ev: MessageEvent<ComputeRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'inputs') {
      if (req.slot === 'lamp') lamp = { raw: req.raw, panels: req.panels ?? 1, ver: ++ver };
      else {
        photo = { raw: req.raw, models: req.models, ver: ++ver };
        prep = null;
        rel = null;
      }
      last = null;
      return;
    }
    if (req.type === 'params') {
      const p = req.params;
      const { mach, ms, iterations } = machFor(p);
      const z = new Float32Array(mach.z);
      const transfer: Transferable[] = [z.buffer];
      const stats = { picW: mach.layout?.pic.w, picH: mach.layout?.pic.h, widthMm: mach.widthMm, heightMm: mach.heightMm, zMin: mach.zMin, zMax: mach.zMax, nx: mach.nx, ny: mach.ny, dx: mach.dx, ms, iterations } as Extract<ComputeResponse, { type: 'relief' }>['stats'];
      let left: Float32Array | undefined;
      let mesh: Extract<ComputeResponse, { type: 'relief' }>['mesh'];
      if (p.mode === 'relief' && req.view !== 'design') {
        const t0 = performance.now();
        const c = cutFor(p);
        left = new Float32Array(c.left);
        transfer.push(left.buffer);
        stats.missedFrac = c.missedFrac;
        stats.maxLeft = c.maxLeft;
        stats.ms += performance.now() - t0;
      }
      if (p.mode === 'lithophane') {
        const small = decimateGrid(mach, 350_000);
        const r = lithoMesh(small, p);
        // show a lamp the way up it is used (a top fitter is printed upside down)
        const flipped = isLamp(p) && p.lampFitter === 'ring' && p.lampFitterEnd === 'top';
        const shown = flipped ? upsideDown(r.mesh, small.heightMm) : r.mesh;
        mesh = { ...shown, upright: r.upright, axis: isLamp(p) };
        transfer.push(mesh.pos.buffer, mesh.idx.buffer, mesh.h.buffer);
      }
      let paths: PreviewPaths | undefined;
      if (p.mode === 'relief' && req.toolpaths) {
        const { ops } = camOps(p);
        const g = gcodeOpts(p, mach, 'mm');
        const safe = g.stockTop + p.safeZ;
        paths = {
          stockTop: g.stockTop,
          zeroZ: p.zZero === 'top' ? g.stockTop : 0,
          ops: ops.map((t) => ({ name: t.name, segs: previewSegments(t.paths, safe, undefined, t.link), sec: writeGcode(t, g).seconds })),
          total: writeGcode(ops, g).seconds,
        };
        for (const o of paths.ops) transfer.push(o.segs.buffer);
      }
      if (p.mode === 'relief' && p.detailOn && req.view !== 'design') stats.detailArea = detailFor(p).area;
      post({ type: 'relief', id: req.id, z, nx: mach.nx, ny: mach.ny, stats, left, mesh, paths }, transfer);
      return;
    }
    if (req.type === 'export') {
      const p = req.params;
      const t0 = performance.now();
      const done = (bytes: Uint8Array, info: string) => post({ type: 'exported', id: req.id, kind: req.kind, bytes, info }, [bytes.buffer]);
      if (req.kind === 'wedge') {
        // 10 grey steps from white to black through the current thickness settings, to test a filament
        const w = 1000, h = 200, data = new Float32Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = 1 - Math.min(9, Math.floor(i / 100)) / 9;
        const q = { ...p, lithoShape: 'flat' as const, widthMm: 100, lithoHole: 0, lithoBorder: Math.max(2, Math.min(4, p.lithoBorder)) };
        const m = lithophaneGrid({ w, h, data }, q);
        done(meshToStl(placeOnBed(lithoMesh(m, q).mesh)), `test strip 100 × 20 mm, 10 steps ${lithoRange(q).tMin.toFixed(2)}–${lithoRange(q).tMax.toFixed(2)} mm thick`);
        return;
      }
      if (req.kind === 'stand') {
        const { tMax } = lithoRange(p);
        const w = p.lithoShape === 'flat' || p.lithoShape === 'rounded' ? p.widthMm : p.widthMm * 0.6;
        const m = standMesh(Math.max(30, w + (p.lithoShape === 'flat' || p.lithoShape === 'rounded' ? 10 : 0)), tMax + 0.4);
        done(meshToStl(m), `stand for a ${tMax.toFixed(1)} mm plate (slot ${(tMax + 0.4).toFixed(1)} mm, tilted 10°)`);
        return;
      }
      const { mach } = machFor(p);
      if (req.kind === 'gcode' || req.kind === 'setup') {
        const { ops } = camOps(p);
        const g = gcodeOpts(p, mach, req.units ?? 'mm');
        if (req.kind === 'setup') {
          const html = setupSheet({
            name: req.name,
            units: g.units,
            material: p.camMaterial,
            widthMm: mach.widthMm,
            heightMm: mach.heightMm,
            partTop: mach.zMax,
            base: p.baseThickness,
            stockTop: g.stockTop,
            zZero: p.zZero,
            safeZ: p.safeZ,
            toolChange: p.toolChange,
            cutout: p.cutoutOn ? { tabs: p.cutoutTabs, tabW: p.cutoutTabW, tabH: p.cutoutTabH, through: p.cutoutThrough } : null,
            layout: mach.layout?.active
              ? {
                  room: Math.min(
                    mach.layout.outline.cx - mach.layout.outline.a,
                    mach.layout.outline.cy - mach.layout.outline.b,
                    mach.layout.W - mach.layout.outline.cx - mach.layout.outline.a,
                    mach.layout.H - mach.layout.outline.cy - mach.layout.outline.b,
                  ),
                  tool: p.roughDiameter,
                  shape: { rect: 'rectangle', rounded: 'rounded rectangle', oval: 'oval', arch: 'arched top' }[mach.layout.outline.kind],
                  border: BORDER_STYLES.find(([v]) => v === mach.layout!.border)?.[1] ?? 'None',
                }
              : undefined,
            ops: ops.map((t) => {
              const r = writeGcode(t, g);
              const rough = t.name === 'roughing' || t.name === 'cutout';
              return {
                name: t.name,
                number: t.number,
                tool: t.tool,
                flutes: opFlutes(p, t.name),
                rpm: t.rpm,
                feed: t.feed,
                plunge: t.plunge,
                seconds: r.seconds,
                lines: r.lines,
                chip: chipRatio(p.camMaterial, t.tool, opFlutes(p, t.name), t.rpm, t.feed, rough ? 'rough' : 'finish'),
                stepdown: rough ? p.roughStepdown : undefined,
                stepover: t.name === 'roughing' ? p.roughStepover : t.name === 'finishing' ? p.finStepover : t.name === 'detail' ? p.detailStepover : undefined,
              };
            }),
            total: writeGcode(ops, g).seconds,
          });
          done(new TextEncoder().encode(html), 'setup sheet');
          return;
        }
        const sel = req.op === 'all' ? ops : ops.filter((t) => t.name === req.op);
        if (!sel.length) throw new Error(`The ${req.op} pass is switched off.`);
        if (!sel.some((t) => t.paths.some((q) => q.length >= 3))) throw new Error('Nothing to cut: the tool would only cut air here.');
        const r = writeGcode(sel, g);
        const h = Math.floor(r.seconds / 3600), mi = Math.round((r.seconds % 3600) / 60);
        done(
          new TextEncoder().encode(r.text),
          `${r.lines.toLocaleString()} lines, about ${h ? `${h} h ` : ''}${mi} min` + (sel.length > 1 ? ` (${sel.map((t) => `T${t.number} ${t.name}`).join(', ')})` : ''),
        );
        return;
      }
      if (req.kind === 'png') {
        const bytes = await heightmapPng(mach);
        done(bytes, `${mach.nx} × ${mach.ny} px, 16-bit; black = ${mach.zMin.toFixed(2)} mm, white = ${mach.zMax.toFixed(2)} mm (Z range ${(mach.zMax - mach.zMin).toFixed(2)} mm), ${(1 / mach.dx).toFixed(2)} px/mm`);
        return;
      }
      if (req.kind === 'stl' || req.kind === '3mf') {
        const mesh = placeOnBed(partMesh(p, mach));
        const tris = (mesh.idx.length / 3).toLocaleString();
        if (req.kind === 'stl') done(meshToStl(mesh), `${tris} triangles`);
        else done(await meshTo3mf(mesh, req.name), `${tris} triangles`);
        return;
      }
      if (req.kind === 'solid' && Math.min(mach.zMin, p.baseThickness) < 0.05) {
        throw new Error('Solid export needs a base thickness > 0.05 mm (the side walls would be zero height).');
      }
      const surf = fitSurface(mach, {
        tolerance: p.fitTolerance,
        onProgress: (message) => post({ type: 'progress', id: req.id, message }),
      });
      const text = writeStep(surf, req.kind, { name: req.name });
      const bytes = new TextEncoder().encode(text);
      const info =
        `${surf.nu}×${surf.nv} poles, max dev ${surf.maxError.toFixed(4)} mm (rms ${surf.rmsError.toFixed(4)})` +
        (surf.maxError > p.fitTolerance ? ' — tolerance not reached, finest net used' : '') +
        `, ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      done(bytes, info);
    }
  } catch (e) {
    post({ type: 'error', id: 'id' in req ? req.id : -1, message: e instanceof Error ? e.message : String(e) });
  }
};
