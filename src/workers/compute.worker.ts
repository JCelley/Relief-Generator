/// <reference lib="webworker" />
import { prepare, computeRelief, Prepared, RawInputs } from '../core/relief';
import { toMachiningGrid, MachGrid } from '../core/resample';
import { fitSurface } from '../core/bspline';
import { writeStep } from '../core/step';
import { heightfieldMesh, meshToStl, standMesh, decimateGrid, placeOnBed, upsideDown, Mesh } from '../core/mesh';
import { lithophaneGrid, lithoMesh, lithoRange } from '../core/litho';
import { simulateCut, CutResult } from '../core/cutter';
import { meshTo3mf, heightmapPng } from '../core/files';
import type { ReliefParams } from '../core/params';
import type { ComputeRequest, ComputeResponse, PreviewPaths } from './protocol';
import { finishingPaths, roughingPaths, writeGcode, previewSegments, Toolpath } from '../core/cam';

declare const self: DedicatedWorkerGlobalScope;

let photo: { raw: RawInputs; models: boolean; ver: number } | null = null;
let lamp: { raw: RawInputs; panels: number; ver: number } | null = null;
let ver = 0;
let prep: Prepared | null = null;
let last: { key: string; mach: MachGrid; cut?: CutResult; rough?: Toolpath | null; finish?: Toolpath } | null = null;

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
  const key = JSON.stringify(p) + '|' + src;
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
  const r = computeRelief(pr, p);
  const mach = toMachiningGrid(r.height, p);
  last = { key, mach };
  return { mach, ms: performance.now() - t0, iterations: r.iterations };
}

function cutFor(p: ReliefParams): CutResult {
  machFor(p);
  if (!last!.cut) last!.cut = simulateCut(last!.mach, { type: p.toolType, diameter: p.toolDiameter, angle: p.toolAngle });
  return last!.cut;
}

/** roughing (null when off) and finishing toolpaths for the current relief, cached with it */
function toolpaths(p: ReliefParams): { rough: Toolpath | null; finish: Toolpath; mach: MachGrid } {
  const { mach } = machFor(p);
  const c = last!;
  if (c.finish === undefined) {
    const tool = { type: p.toolType, diameter: p.toolDiameter, angle: p.toolAngle };
    c.finish = { name: 'finishing', tool, rpm: p.finRpm, feed: p.finFeed, plunge: p.finPlunge, paths: finishingPaths(mach, { tool, stepover: Math.max(0.01, p.finStepover), dir: p.finDir }) };
    if (p.roughOn) {
      const rt = { type: p.roughType, diameter: p.roughDiameter, angle: 0 };
      c.rough = { name: 'roughing', tool: rt, rpm: p.roughRpm, feed: p.roughFeed, plunge: p.roughPlunge, paths: roughingPaths(mach, { tool: rt, stepdown: p.roughStepdown, stepover: Math.max(0.05, p.roughStepover), allowance: p.roughAllowance, stockTop: mach.zMax }) };
    } else c.rough = null;
  }
  return { rough: c.rough ?? null, finish: c.finish, mach };
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
      }
      last = null;
      return;
    }
    if (req.type === 'params') {
      const p = req.params;
      const { mach, ms, iterations } = machFor(p);
      const z = new Float32Array(mach.z);
      const transfer: Transferable[] = [z.buffer];
      const stats = { widthMm: mach.widthMm, heightMm: mach.heightMm, zMin: mach.zMin, zMax: mach.zMax, nx: mach.nx, ny: mach.ny, dx: mach.dx, ms, iterations } as Extract<ComputeResponse, { type: 'relief' }>['stats'];
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
        const tp = toolpaths(p);
        const g = { units: 'mm' as const, safeZ: p.safeZ, zZero: p.zZero, partTop: mach.zMax };
        const safe = mach.zMax + p.safeZ;
        paths = {
          rough: tp.rough ? previewSegments(tp.rough.paths, safe) : null,
          finish: previewSegments(tp.finish.paths, safe),
          roughSec: tp.rough ? writeGcode(tp.rough, g).seconds : 0,
          finishSec: writeGcode(tp.finish, g).seconds,
        };
        transfer.push(paths.finish.buffer);
        if (paths.rough) transfer.push(paths.rough.buffer);
      }
      post({ type: 'relief', id: req.id, z, nx: mach.nx, ny: mach.ny, stats, left, mesh, paths }, transfer);
      return;
    }
    if (req.type === 'export') {
      const p = req.params;
      const t0 = performance.now();
      const done = (bytes: Uint8Array, info: string) => post({ type: 'exported', id: req.id, kind: req.kind, bytes, info }, [bytes.buffer]);
      if (req.kind === 'stand') {
        const { tMax } = lithoRange(p);
        const w = p.lithoShape === 'flat' || p.lithoShape === 'rounded' ? p.widthMm : p.widthMm * 0.6;
        const m = standMesh(Math.max(30, w + (p.lithoShape === 'flat' || p.lithoShape === 'rounded' ? 10 : 0)), tMax + 0.4);
        done(meshToStl(m), `stand for a ${tMax.toFixed(1)} mm plate (slot ${(tMax + 0.4).toFixed(1)} mm, tilted 10°)`);
        return;
      }
      const { mach } = machFor(p);
      if (req.kind === 'gcodeRough' || req.kind === 'gcodeFinish') {
        const tp = toolpaths(p);
        const op = req.kind === 'gcodeRough' ? tp.rough : tp.finish;
        if (!op) throw new Error('Roughing is switched off.');
        if (!op.paths.some((q) => q.length >= 3)) throw new Error('Nothing to cut: the roughing tool would only cut air at this size.');
        const r = writeGcode(op, {
          units: req.units ?? 'mm',
          safeZ: p.safeZ,
          zZero: p.zZero,
          partTop: mach.zMax,
          notes: [
            `Part ${mach.widthMm.toFixed(2)} x ${mach.heightMm.toFixed(2)} mm, ${mach.zMax.toFixed(2)} mm tall (base ${p.baseThickness.toFixed(2)} mm)`,
            'Check speeds, feeds and the toolpath before running. Air-cut first if unsure.',
          ],
        });
        const h = Math.floor(r.seconds / 3600), mi = Math.round((r.seconds % 3600) / 60);
        done(new TextEncoder().encode(r.text), `${r.lines.toLocaleString()} lines, about ${h ? `${h} h ` : ''}${mi} min`);
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
