import { describe, it, expect } from 'vitest';
import { lithophaneGrid, backlitBrightness } from '../src/core/litho';
import { writeStl } from '../src/core/stl';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { Grid } from '../src/core/grid';

// left half black, right half white, 200 x 100 px
const lum: Grid = { w: 200, h: 100, data: Float32Array.from({ length: 200 * 100 }, (_, i) => ((i % 200) < 100 ? 0 : 1)) };
const p = { ...DEFAULT_PARAMS, mode: 'lithophane' as const, widthMm: 100, lithoMin: 0.8, lithoMax: 3, lithoBorder: 3, lithoGrid: 0.5 };

describe('lithophane', () => {
  const m = lithophaneGrid(lum, p);
  const at = (xMm: number, yMm: number) => m.z[Math.round(yMm / m.dy) * m.nx + Math.round(xMm / m.dx)];

  it('maps dark to thick and light to thin, within the set range', () => {
    expect(m.zMin).toBeCloseTo(0.8, 2);
    expect(m.zMax).toBeCloseTo(3, 2);
    expect(at(25, 25)).toBeCloseTo(3, 2); // black side
    expect(at(75, 25)).toBeCloseTo(0.8, 2); // white side
    expect(m.dx).toBeCloseTo(0.5, 2);
  });

  it('adds a full-thickness frame', () => {
    expect(at(1, 25)).toBeCloseTo(3, 2);
    expect(at(99, 25)).toBeCloseTo(3, 2);
    expect(at(75, 1)).toBeCloseTo(3, 2);
    expect(at(75, 5)).toBeCloseTo(0.8, 2);
  });

  it('exports a closed STL', () => {
    const bytes = writeStl(m);
    const n = new DataView(bytes.buffer).getUint32(80, true);
    expect(bytes.length).toBe(84 + 50 * n);
    expect(n).toBeGreaterThan(2 * (m.nx - 1) * (m.ny - 1));
  });

  it('backlit view: thin is bright, thick is dark', () => {
    expect(backlitBrightness(0.8, 0.8, 3)).toBeCloseTo(1);
    expect(backlitBrightness(3, 0.8, 3)).toBeLessThan(0.1);
  });
});

import { cylinderMap } from '../src/core/stl';

/** every directed edge matched by its reverse, plus the enclosed volume (divergence theorem) */
function checkClosed(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer);
  const n = dv.getUint32(80, true);
  const edges = new Map<string, number>();
  const key = (o: number) => `${dv.getFloat32(o, true).toFixed(4)},${dv.getFloat32(o + 4, true).toFixed(4)},${dv.getFloat32(o + 8, true).toFixed(4)}`;
  let vol = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t + 12;
    const v = [key(o), key(o + 12), key(o + 24)];
    for (let k = 0; k < 3; k++) {
      const e = `${v[k]}|${v[(k + 1) % 3]}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((c) => dv.getFloat32(o + 12 * k + 4 * c, true)));
    for (const q of p) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], q[c]); hi[c] = Math.max(hi[c], q[c]); }
    const [a, b, c] = p;
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  let bad = 0;
  for (const [e, c] of edges) {
    const [a, b] = e.split('|');
    if (c !== 1 || edges.get(`${b}|${a}`) !== 1) bad++;
  }
  return { bad, vol, lo, hi };
}

describe('lithophane STL', () => {
  const m = lithophaneGrid(lum, p);
  // reference volume of the flat plate: mean thickness × area
  const mean = m.z.reduce((a, v) => a + v, 0) / m.z.length;
  const area = m.widthMm * m.heightMm;

  it('flat: closed, outward-facing, right volume', () => {
    const r = checkClosed(writeStl(m));
    expect(r.bad).toBe(0);
    expect(r.vol / (mean * area)).toBeCloseTo(1, 1);
  });

  it('curved: closed, outward-facing, standing up, wraps the radius', () => {
    const R = 40;
    const r = checkClosed(writeStl(m, cylinderMap(m.widthMm, R)));
    expect(r.bad).toBe(0);
    expect(r.vol).toBeGreaterThan(0);
    // volume of a bent plate ≈ thickness × area × (1 + t/2R)
    expect(r.vol / (mean * area * (1 + mean / (2 * R)))).toBeCloseTo(1, 1);
    expect(r.lo[2]).toBeCloseTo(0, 3); // bottom edge on the bed
    expect(r.hi[2]).toBeCloseTo(m.heightMm, 3);
    // 100 mm of arc on R = 40 is ~143°: chord = 2·R·sin(θ/2) at the back, a little more outside
    const chord = r.hi[0] - r.lo[0];
    expect(chord).toBeGreaterThan(2 * R * Math.sin(100 / R / 2));
    expect(chord).toBeLessThan(2 * (R + 3.01) * Math.sin(100 / R / 2) + 0.01);
  });
});
