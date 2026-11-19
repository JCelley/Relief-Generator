import { describe, it, expect } from 'vitest';
import { finishingPaths, roughingPaths, writeGcode, recommend, stepoverFor, scallopHeight, chipLoad, previewSegments } from '../src/core/cam';
import { tipHeight } from '../src/core/cutter';
import type { MachGrid } from '../src/core/resample';

// 40 × 30 mm part, 0.2 mm grid: 3 mm base with a 5 mm tall dome, top at 8 mm
const nx = 201, ny = 151, dx = 0.2;
const z = new Float32Array(nx * ny);
for (let j = 0; j < ny; j++)
  for (let i = 0; i < nx; i++) {
    const r = Math.hypot(i * dx - 20, j * dx - 15);
    z[j * nx + i] = 3 + Math.max(0, 5 * (1 - (r / 12) ** 2));
  }
const g: MachGrid = { nx, ny, dx, dy: dx, widthMm: 40, heightMm: 30, z, zMin: 3, zMax: 8 };
const at = (a: Float32Array, x: number, y: number) => a[Math.round(y / dx) * nx + Math.round(x / dx)];

describe('finishing', () => {
  const tool = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const [p] = finishingPaths(g, { tool, stepover: 0.5, dir: 'x' });
  const tip = tipHeight(g, tool);

  it('rides on the surface without gouging and covers the part', () => {
    let below = 0, ys = new Set<number>();
    for (let k = 0; k < p.length; k += 3) {
      const x = p[k], y = p[k + 1], zz = p[k + 2];
      ys.add(Math.round(y * 100));
      // the tool tip is never below the non-gouging height at that point
      const f = y / dx, j0 = Math.floor(f), j1 = Math.min(ny - 1, j0 + 1), i = Math.round(x / dx);
      const t = tip[j0 * nx + i] * (1 - (f - j0)) + tip[j1 * nx + i] * (f - j0);
      if (zz < t - 1e-3) below++;
    }
    expect(below).toBe(0);
    expect(ys.size).toBe(61); // 30 mm / 0.5 mm stepover + 1
    // on the dome top the ball touches the surface
    let top = -Infinity;
    for (let k = 2; k < p.length; k += 3) top = Math.max(top, p[k]);
    expect(top).toBeCloseTo(8, 1);
  });

  it('simplifies flat stretches', () => {
    expect(p.length / 3).toBeLessThan(nx * 61 * 0.7);
  });
});

describe('roughing', () => {
  const tool = { type: 'flat' as const, diameter: 6.35, angle: 0 };
  const paths = roughingPaths(g, { tool, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
  const tip = tipHeight(g, tool);

  it('stays clear of the design by the allowance, never deeper than one stepdown per level', () => {
    expect(paths.length).toBeGreaterThan(0);
    const levels = new Set<number>();
    for (const p of paths)
      for (let k = 0; k < p.length; k += 3) {
        expect(p[k + 2]).toBeGreaterThanOrEqual(at(tip, p[k], p[k + 1]) + 0.5 - 1e-3);
        levels.add(Math.round(Math.min(...Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 2])) * 1000));
      }
    // 8 → 6 → 4 → 3.5 (base + allowance)
    expect([...levels].sort((a, b) => b - a)).toEqual([6000, 4000, 3500]);
  });
});

describe('G-code', () => {
  const tool = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const paths = finishingPaths(g, { tool, stepover: 1, dir: 'xy' });
  const tp = { name: 'finishing', tool, paths, rpm: 18000, feed: 1500, plunge: 500 };

  it('mm, Z0 at the top: nothing below the part bottom, rapids only at the safe height', () => {
    const r = writeGcode(tp, { units: 'mm', safeZ: 5, zZero: 'top', partTop: 8 });
    const lines = r.text.trim().split('\n');
    expect(lines).toContain('G21');
    expect(lines).toContain('M3 S18000');
    expect(lines[lines.length - 1]).toBe('M30');
    let mode = '', zz = 0, minZ = Infinity, maxZ = -Infinity;
    for (const l of lines) {
      if (l.startsWith('(')) continue;
      const g0 = /\bG0\b/.test(l), g1 = /\bG1\b/.test(l);
      if (g0) mode = 'G0';
      if (g1) mode = 'G1';
      const m = /Z(-?[\d.]+)/.exec(l);
      if (m) zz = Number(m[1]);
      if (/[XY]/.test(l) && mode === 'G0' && !l.startsWith('G90')) expect(zz).toBeCloseTo(5, 3);
      if (mode === 'G1') {
        minZ = Math.min(minZ, zz);
        maxZ = Math.max(maxZ, zz);
      }
    }
    expect(minZ).toBeGreaterThanOrEqual(-5 - 1e-3); // never below the 3 mm base (8 − 3)
    expect(maxZ).toBeLessThanOrEqual(1e-3);
    expect(r.seconds).toBeGreaterThan(60);
  });

  it('inches: G20 and scaled values', () => {
    const r = writeGcode(tp, { units: 'in', safeZ: 5, zZero: 'bottom', partTop: 8 });
    expect(r.text).toContain('G20');
    expect(r.text).toContain('Z0.5118'); // safe height 13 mm above the bottom
    expect(r.text).toContain('F59.1'); // 1500 mm/min
  });

  it('preview segments come in pairs', () => {
    expect(previewSegments(paths, 13).length % 6).toBe(0);
  });
});

describe('feeds and stepover', () => {
  it('chip load follows the chart', () => {
    expect(chipLoad('hardwood', 6.35)).toBeCloseTo(0.009 * 25.4, 4);
    expect(chipLoad('hardwood', 4.7625)).toBeGreaterThan(0.003 * 25.4);
    expect(chipLoad('hardwood', 4.7625)).toBeLessThan(0.009 * 25.4);
  });
  it('1/4" 2-flute in hardwood at 18k rpm', () => {
    const r = recommend('hardwood', { type: 'flat', diameter: 6.35, angle: 0 }, 2, 'rough');
    expect(r.feed).toBe(5000); // 8230 mm/min capped for a hobby router
    expect(r.stepdown).toBeCloseTo(3.18, 2);
    expect(r.stepover).toBeCloseTo(2.54, 2);
  });
  it('finishing stepover and scallop', () => {
    const ball = { type: 'ball' as const, diameter: 3.175, angle: 0 };
    expect(stepoverFor(ball)).toBeCloseTo(0.318, 3);
    expect(scallopHeight(ball, 0.3175)).toBeCloseTo(1.5875 - Math.sqrt(1.5875 ** 2 - 0.15875 ** 2), 5);
    const v = { type: 'vbit' as const, diameter: 0, angle: 60 };
    expect(scallopHeight(v, stepoverFor(v))).toBeCloseTo(0.02, 3);
  });
});
