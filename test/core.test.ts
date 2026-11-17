import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeGrid } from '../src/core/grid';
import { distanceTransform, insideDistance } from '../src/core/distance';
import { forwardGradients, solveScreenedPoisson } from '../src/core/poisson';
import { fitSurface, fitSurfaceFixed, evalSurfaceZ, clampedKnots, greville } from '../src/core/bspline';
import { writeStep, fmt } from '../src/core/step';
import { writeStl } from '../src/core/stl';
import { computeRelief, prepare } from '../src/core/relief';
import { toMachiningGrid, MachGrid } from '../src/core/resample';
import { DEFAULT_PARAMS } from '../src/core/params';

const require = createRequire(import.meta.url);

function gridFrom(nx: number, ny: number, W: number, H: number, f: (x: number, y: number) => number): MachGrid {
  const z = new Float32Array(nx * ny);
  const dx = W / (nx - 1);
  const dy = H / (ny - 1);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v = f(i * dx, j * dy);
      z[j * nx + i] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  return { nx, ny, dx, dy, widthMm: W, heightMm: H, z, zMin: lo, zMax: hi };
}

describe('distance transform', () => {
  it('matches brute force', () => {
    const w = 23, h = 17;
    const seeds = [5, 100, 300];
    const d = distanceTransform(w, h, (i) => seeds.includes(i));
    for (let i = 0; i < w * h; i++) {
      const x = i % w, y = Math.floor(i / w);
      const bf = Math.min(...seeds.map((s) => Math.hypot((s % w) - x, Math.floor(s / w) - y)));
      expect(d.data[i]).toBeCloseTo(bf, 4);
    }
  });
  it('inside distance ignores the frame', () => {
    const m = makeGrid(10, 10, 1);
    const d = insideDistance(m);
    expect(d.data[0]).toBeGreaterThan(1e6);
  });
});

describe('screened Poisson', () => {
  it('reconstructs a function from its gradients (Neumann)', () => {
    const w = 40, h = 30;
    const u0 = makeGrid(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) u0.data[y * w + x] = Math.sin(x / 7) * Math.cos(y / 5) + 0.01 * x;
    const { gx, gy } = forwardGradients(u0);
    const { u } = solveScreenedPoisson(gx, gy, makeGrid(w, h, 1), { lambda: 1e-6, target: u0, tol: 1e-10, maxIter: 5000 });
    for (let i = 0; i < w * h; i++) expect(u.data[i]).toBeCloseTo(u0.data[i], 3);
  });
  it('honours the Dirichlet domain', () => {
    const w = 30, h = 30;
    const dom = makeGrid(w, h);
    const u0 = makeGrid(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 15, y - 15);
        if (r < 10) {
          dom.data[y * w + x] = 1;
          u0.data[y * w + x] = 10 - r;
        }
      }
    const { gx, gy } = forwardGradients(u0);
    // zero gradients that leave the domain (as the pipeline does)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!(dom.data[i] && x + 1 < w && dom.data[i + 1])) gx.data[i] = 0;
        if (!(dom.data[i] && y + 1 < h && dom.data[i + w])) gy.data[i] = 0;
      }
    const { u } = solveScreenedPoisson(gx, gy, dom, { lambda: 1e-6, tol: 1e-10 });
    for (let i = 0; i < w * h; i++) if (!dom.data[i]) expect(u.data[i]).toBe(0);
    expect(u.data[15 * w + 15]).toBeGreaterThan(5);
  });
});

describe('B-spline fit', () => {
  it('reproduces a bicubic polynomial exactly', () => {
    const g = gridFrom(41, 31, 100, 75, (x, y) => 1 + 0.001 * x * x - 0.00002 * x * x * x + 0.0005 * y * y + 0.00001 * x * y * y);
    const s = fitSurfaceFixed(g, 8, 7);
    expect(s.maxError).toBeLessThan(1e-6);
  });
  it('has linear x/y (Greville) and hits tolerance', () => {
    const g = gridFrom(120, 90, 60, 45, (x, y) => 3 + 2 * Math.sin(x / 6) * Math.cos(y / 5));
    const s = fitSurface(g, { tolerance: 0.01 });
    expect(s.maxError).toBeLessThanOrEqual(0.01);
    expect(s.nu).toBeLessThan(g.nx);
    // x of control points evenly reproduce x(u) = u W
    const U = clampedKnots(s.nu);
    const gu = greville(U, s.nu);
    expect(gu[0]).toBe(0);
    expect(gu[s.nu - 1]).toBe(1);
    // evaluation at an off-grid point is close to the function
    const z = evalSurfaceZ(s, 0.37, 0.61);
    expect(z).toBeCloseTo(3 + 2 * Math.sin((0.37 * 60) / 6) * Math.cos((0.61 * 45) / 5), 1);
  });
});

describe('STEP / STL export', () => {
  const g = gridFrom(60, 45, 120, 90, (x, y) => 3 + 4 * Math.exp(-((x - 60) ** 2 + (y - 45) ** 2) / 500));
  const s = fitSurface(g, { tolerance: 0.01 });

  it('formats reals with a decimal point', () => {
    expect(fmt(3)).toBe('3.');
    expect(fmt(-0.25)).toBe('-0.25');
    expect(fmt(0)).toBe('0.');
  });

  async function occt() {
    const factory = require('occt-import-js');
    return factory();
  }

  function bbox(meshes: { attributes: { position: { array: number[] } } }[]) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
      const a = m.attributes.position.array;
      for (let i = 0; i < a.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], a[i + k]);
          hi[k] = Math.max(hi[k], a[i + k]);
        }
    }
    return { lo, hi };
  }

  it('surface STEP imports in OpenCascade as one face with the right extents', async () => {
    const txt = writeStep(s, 'surface', { timestamp: '2026-01-01T00:00:00Z' });
    const o = await occt();
    const res = o.ReadStepFile(new TextEncoder().encode(txt), null);
    expect(res.success).toBe(true);
    expect(res.meshes.length).toBe(1);
    expect(res.meshes[0].brep_faces.length).toBe(1);
    const { lo, hi } = bbox(res.meshes);
    expect(lo[0]).toBeCloseTo(0, 2);
    expect(hi[0]).toBeCloseTo(120, 2);
    expect(hi[1]).toBeCloseTo(90, 2);
    expect(hi[2]).toBeGreaterThan(6.5);
    expect(lo[2]).toBeGreaterThan(2.9);
  });

  it('solid STEP imports as a closed 6-face body', async () => {
    const txt = writeStep(s, 'solid', { timestamp: '2026-01-01T00:00:00Z' });
    const o = await occt();
    const res = o.ReadStepFile(new TextEncoder().encode(txt), null);
    expect(res.success).toBe(true);
    expect(res.meshes.length).toBe(1);
    expect(res.meshes[0].brep_faces.length).toBe(6);
    const { lo, hi } = bbox(res.meshes);
    expect(lo[2]).toBeCloseTo(0, 3);
    expect(hi[2]).toBeGreaterThan(6.5);
  });

  it('STL is watertight (every edge shared by exactly two triangles)', () => {
    const bytes = writeStl(g);
    const dv = new DataView(bytes.buffer);
    const n = dv.getUint32(80, true);
    const edges = new Map<string, number>();
    const key = (o: number) => `${dv.getFloat32(o, true).toFixed(4)},${dv.getFloat32(o + 4, true).toFixed(4)},${dv.getFloat32(o + 8, true).toFixed(4)}`;
    for (let t = 0; t < n; t++) {
      const o = 84 + 50 * t + 12;
      const v = [key(o), key(o + 12), key(o + 24)];
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        // directed edge a->b must be matched by b->a
        const e = `${a}|${b}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    for (const [e, c] of edges) {
      expect(c).toBe(1);
      const [a, b] = e.split('|');
      expect(edges.get(`${b}|${a}`)).toBe(1);
    }
  });
});

describe('relief pipeline (synthetic)', () => {
  it('produces a relief that falls to the base at the mask edge', () => {
    const w = 160, h = 120;
    const lum = makeGrid(w, h, 0.5);
    const depthLow = makeGrid(80, 60);
    const maskLow = makeGrid(80, 60);
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 80; x++) {
        const r = Math.hypot(x - 40, y - 30);
        maskLow.data[y * 80 + x] = r < 22 ? 1 : 0;
        depthLow.data[y * 80 + x] = r < 22 ? 5 + Math.sqrt(22 * 22 - r * r) / 5 : 0.5; // sphere vs far background
      }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum.data[y * w + x] = Math.hypot(x - 80, y - 60) < 44 ? 0.8 : 0.2;
    const prep = prepare({ luminance: lum, depth: depthLow, mask: maskLow }, 0.003);
    for (const method of ['baseDetail', 'gradient'] as const) {
      const p = { ...DEFAULT_PARAMS, method, widthMm: 100 };
      const r = computeRelief(prep, p);
      expect(r.height.data[0]).toBe(0);
      expect(r.height.data[60 * w + 80]).toBeGreaterThan(0.5);
      const m = toMachiningGrid(r.height, p);
      expect(m.zMin).toBeCloseTo(p.baseThickness, 3);
      expect(m.zMax).toBeLessThanOrEqual(p.baseThickness + p.reliefHeight + 1e-4);
      expect(m.widthMm).toBe(100);
      expect(m.heightMm).toBeCloseTo(75, 6);
    }
  });
});

describe('tone carving', () => {
  it('cuts a dark disc into a flat-lit dome and raises a light dot', () => {
    const w = 200, h = 200;
    const lum = makeGrid(w, h, 0.7);
    const depth = makeGrid(100, 100);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 100, y - 100);
        if (r < 25) lum.data[y * w + x] = 0.08; // "pupil"
        if (Math.hypot(x - 95, y - 95) < 5) lum.data[y * w + x] = 1; // "highlight"
      }
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) depth.data[y * 100 + x] = Math.max(0, 50 - Math.hypot(x - 50, y - 50));
    const prep = prepare({ luminance: lum, depth, mask: null }, 0.003);
    const base = { ...DEFAULT_PARAMS, widthMm: 100, smoothing: 0 };
    const off = computeRelief(prep, base).height;
    const on = computeRelief(prep, { ...base, toneDepth: 1 }).height;
    const at = (g: typeof on, x: number, y: number) => g.data[y * w + x] * base.reliefHeight;
    // pupil (away from the highlight) is recessed by most of the requested millimetre relative to off
    const pupilDrop = at(off, 110, 110) - at(on, 110, 110);
    expect(pupilDrop).toBeGreaterThan(0.5);
    // flat bottom: two pupil points differ much less than the drop itself... relative to the untouched dome shape
    expect(Math.abs(at(on, 110, 110) - at(off, 110, 110) - (at(on, 112, 106) - at(off, 112, 106)))).toBeLessThan(0.15);
    // the highlight stands above the pupil around it
    expect(at(on, 95, 95)).toBeGreaterThan(at(on, 95, 104) + 0.3);
    // overall Z range still respected
    expect(Math.max(...on.data)).toBeLessThanOrEqual(1 + 1e-6);
  });
});
