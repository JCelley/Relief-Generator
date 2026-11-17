/// <reference lib="webworker" />
import { prepare, computeRelief, Prepared, RawInputs } from '../core/relief';
import { toMachiningGrid, MachGrid } from '../core/resample';
import { fitSurface } from '../core/bspline';
import { writeStep } from '../core/step';
import { writeStl } from '../core/stl';
import type { ReliefParams } from '../core/params';
import type { ComputeRequest, ComputeResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let raw: RawInputs | null = null;
let prep: Prepared | null = null;
let last: { key: string; mach: MachGrid } | null = null;

const post = (m: ComputeResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function getPrepared(p: ReliefParams): Prepared {
  if (!raw) throw new Error('no photo loaded');
  if (!prep || prep.guideEps !== p.guideEps) {
    prep = prepare(raw, p.guideEps);
    post({ type: 'prepared', mask: { ...prep.mask, data: new Float32Array(prep.mask.data) }, depth: { ...prep.depth, data: new Float32Array(prep.depth.data) } });
  }
  return prep;
}

function machFor(p: ReliefParams): { mach: MachGrid; ms: number; iterations?: number } {
  const key = JSON.stringify(p);
  if (last && last.key === key) return { mach: last.mach, ms: 0 };
  const t0 = performance.now();
  const pr = getPrepared(p);
  const r = computeRelief(pr, p);
  const mach = toMachiningGrid(r.height, p);
  last = { key, mach };
  return { mach, ms: performance.now() - t0, iterations: r.iterations };
}

self.onmessage = (ev: MessageEvent<ComputeRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'inputs') {
      raw = req.raw;
      prep = null;
      last = null;
      return;
    }
    if (req.type === 'params') {
      const { mach, ms, iterations } = machFor(req.params);
      const z = new Float32Array(mach.z);
      post(
        {
          type: 'relief',
          id: req.id,
          z,
          nx: mach.nx,
          ny: mach.ny,
          stats: { widthMm: mach.widthMm, heightMm: mach.heightMm, zMin: mach.zMin, zMax: mach.zMax, nx: mach.nx, ny: mach.ny, dx: mach.dx, ms, iterations },
        },
        [z.buffer],
      );
      return;
    }
    if (req.type === 'export') {
      const { mach } = machFor(req.params);
      const t0 = performance.now();
      if (req.kind === 'stl') {
        const bytes = writeStl(mach);
        post({ type: 'exported', id: req.id, kind: 'stl', bytes, info: `${((bytes.length - 84) / 50).toLocaleString()} triangles` }, [bytes.buffer]);
        return;
      }
      if (req.kind === 'solid' && Math.min(mach.zMin, req.params.baseThickness) < 0.05) {
        throw new Error('Solid export needs a base thickness > 0.05 mm (the side walls would be zero height).');
      }
      const surf = fitSurface(mach, {
        tolerance: req.params.fitTolerance,
        onProgress: (message) => post({ type: 'progress', id: req.id, message }),
      });
      const text = writeStep(surf, req.kind, { name: req.name });
      const bytes = new TextEncoder().encode(text);
      const info =
        `${surf.nu}×${surf.nv} poles, max dev ${surf.maxError.toFixed(4)} mm (rms ${surf.rmsError.toFixed(4)})` +
        (surf.maxError > req.params.fitTolerance ? ' — tolerance not reached, finest net used' : '') +
        `, ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      post({ type: 'exported', id: req.id, kind: req.kind, bytes, info }, [bytes.buffer]);
    }
  } catch (e) {
    post({ type: 'error', id: 'id' in req ? req.id : -1, message: e instanceof Error ? e.message : String(e) });
  }
};
