import { describe, it, expect } from 'vitest';
import {
  finishingPaths,
  roughingPaths,
  writeGcode,
  recommend,
  stepoverFor,
  scallopHeight,
  chipLoad,
  previewSegments,
  cutoutPath,
  detailRegion,
  detailPaths,
  chipRatio,
  toolRadiusAt,
  floorSkip,
  finishingRuns,
  roughRest,
} from '../src/core/cam';
import { tipHeight, simulateCut } from '../src/core/cutter';
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

/** replays G-code: [x, y, z (part coordinates), rapid?] for every move */
function replay(text: string, zOff: number) {
  let x = 0, y = 0, zz = 0, mode = '';
  const out: [number, number, number, boolean][] = [];
  for (const l of text.split('\n')) {
    if (l.startsWith('(') || l.startsWith('G90') || !/[XYZ]/.test(l)) continue;
    if (/\bG0\b/.test(l)) mode = 'G0';
    if (/\bG1\b/.test(l)) mode = 'G1';
    const v = (c: string, d: number) => {
      const m = new RegExp(c + '(-?[\\d.]+)').exec(l);
      return m ? Number(m[1]) : d;
    };
    x = v('X', x);
    y = v('Y', y);
    zz = v('Z', zz - zOff) + zOff;
    out.push([x, y, zz, mode === 'G0']);
  }
  return out;
}

describe('finishing', () => {
  const tool = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const [p] = finishingPaths(g, { tool, stepover: 0.5, dir: 'x' });
  const tip = tipHeight(g, tool);

  it('rides on the surface without gouging and covers the part', () => {
    let below = 0;
    const ys = new Set<number>();
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
  const { paths, entry } = roughingPaths(g, { tool, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
  const tip = tipHeight(g, tool);

  it('stays clear of the design by the allowance (except on the flat floor), never deeper than one stepdown per level', () => {
    expect(paths.length).toBeGreaterThan(0);
    const levels = new Set<number>();
    let onFloor = 0;
    for (const p of paths)
      for (let k = 0; k < p.length; k += 3) {
        const t = at(tip, p[k], p[k + 1]);
        // the flat end mill takes the flat floor (3 mm) to its final depth
        expect(p[k + 2]).toBeGreaterThanOrEqual(t + (t > 3 + 1e-4 ? 0.5 : 0) - 1e-3);
        if (Math.abs(p[k + 2] - 3) < 1e-4) onFloor++;
        levels.add(Math.round(Math.min(...Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 2])) * 1000));
      }
    expect(onFloor).toBeGreaterThan(10);
    // 8 → 6 → 4 → 3 (the floor; base + allowance next to the dome)
    expect([...levels].sort((a, b) => b - a)[0]).toBe(6000);
    expect(Math.min(...levels)).toBe(3000);
    expect([...levels].every((v) => [6000, 4000, 3500, 3000].includes(v))).toBe(true);
  });

  it('a ball end mill leaves the allowance on the floor too', () => {
    const ball = { type: 'ball' as const, diameter: 6.35, angle: 0 };
    const r = roughingPaths(g, { tool: ball, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
    for (const p of r.paths) for (let k = 2; k < p.length; k += 3) expect(p[k]).toBeGreaterThanOrEqual(3.5 - 1e-3);
  });

  it('enters each run from the level above', () => {
    expect(entry.length).toBe(paths.length);
    paths.forEach((p, i) => {
      expect(entry[i]).toBeGreaterThanOrEqual(p[2] - 1e-6);
      expect(entry[i] - p[2]).toBeLessThanOrEqual(2 + 1e-6);
    });
  });

  it('thicker stock: starts at the stock top', () => {
    const t = roughingPaths(g, { tool, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 12 });
    let top = -Infinity;
    for (const p of t.paths) for (let k = 2; k < p.length; k += 3) top = Math.max(top, p[k]);
    expect(top).toBeCloseTo(10, 3);
  });
});

describe('G-code', () => {
  const tool = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const paths = finishingPaths(g, { tool, stepover: 1, dir: 'xy' });
  const tp = { name: 'finishing', number: 2, tool, paths, rpm: 18000, feed: 1500, plunge: 500 };

  it('mm, Z0 at the top: nothing below the part bottom, rapids across only at the safe height', () => {
    const r = writeGcode(tp, { units: 'mm', safeZ: 5, zZero: 'top', stockTop: 8 });
    const lines = r.text.trim().split('\n');
    expect(lines).toContain('G21');
    expect(lines).toContain('M3 S18000');
    expect(lines[lines.length - 1]).toBe('M30');
    expect(r.text).not.toContain('M6');
    let prev: [number, number, number, boolean] = [0, 0, 13, true];
    let minZ = Infinity, maxZ = -Infinity;
    for (const m of replay(r.text, 8)) {
      if (m[3] && (Math.abs(m[0] - prev[0]) > 1e-6 || Math.abs(m[1] - prev[1]) > 1e-6)) expect(m[2]).toBeCloseTo(13, 3);
      if (!m[3]) {
        minZ = Math.min(minZ, m[2]);
        maxZ = Math.max(maxZ, m[2]);
      }
      prev = m;
    }
    expect(minZ).toBeGreaterThanOrEqual(3 - 1e-3); // never below the 3 mm base
    expect(maxZ).toBeLessThanOrEqual(9 + 1e-3);
    expect(r.seconds).toBeGreaterThan(60);
  });

  it('inches: G20 and scaled values', () => {
    const r = writeGcode(tp, { units: 'in', safeZ: 5, zZero: 'bottom', stockTop: 8 });
    expect(r.text).toContain('G20');
    expect(r.text).toContain('Z0.5118'); // safe height 13 mm above the bottom
    expect(r.text).toContain('F59.1'); // 1500 mm/min
  });

  it('preview segments come in pairs', () => {
    expect(previewSegments(paths, 13).length % 6).toBe(0);
  });
});

describe('ramps and tool changes', () => {
  const rt = { type: 'flat' as const, diameter: 6.35, angle: 0 };
  const r = roughingPaths(g, { tool: rt, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
  const rough = { name: 'roughing', number: 1, tool: rt, rpm: 18000, feed: 3000, plunge: 1000, ...r };
  const ft = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const fin = { name: 'finishing', number: 2, tool: ft, rpm: 18000, feed: 1500, plunge: 500, paths: finishingPaths(g, { tool: ft, stepover: 1, dir: 'x' }) };

  it('rapids stop 1 mm above the material, then the tool ramps in', () => {
    const res = writeGcode(rough, { units: 'mm', safeZ: 5, zZero: 'bottom', stockTop: 8, rampAngle: 5 });
    const mv = replay(res.text, 0);
    let prev = mv[0], steep = 0, lowRapid = Infinity;
    for (const m of mv) {
      const dz = prev[2] - m[2], dxy = Math.hypot(m[0] - prev[0], m[1] - prev[1]);
      if (m[3]) lowRapid = Math.min(lowRapid, m[2]);
      else if (dz > 1.05 && dz > dxy * Math.tan((6 * Math.PI) / 180)) steep++;
      prev = m;
    }
    // the lowest level is 3.5 mm, entered from 4 mm: rapids never below 5 mm
    expect(lowRapid).toBeGreaterThanOrEqual(5 - 1e-3);
    // straight plunges only where a run is too short to ramp along
    expect(steep).toBeLessThan(r.paths.length * 0.3);
    // faster than ramping down from the stock top every time
    const fromTop = writeGcode({ ...rough, entry: undefined }, { units: 'mm', safeZ: 5, zZero: 'bottom', stockTop: 8, rampAngle: 5 });
    expect(res.seconds).toBeLessThan(fromTop.seconds);
  });

  it('one file with both tools: tool change, spindle restarts, re-zero note', () => {
    const res = writeGcode([rough, fin], { units: 'mm', safeZ: 5, zZero: 'top', stockTop: 8, spindleDelay: 3, toolChange: 'm6' });
    expect(res.text).toContain('T1 M6');
    expect(res.text).toContain('T2 M6');
    expect(res.text).toContain('TOOL CHANGE');
    expect(res.text.match(/M3 S18000/g)?.length).toBe(2);
    expect(res.text).toContain('G4 P3');
    expect(res.ops.map((o) => o.name)).toEqual(['roughing', 'finishing']);
    expect(Math.abs(res.ops[0].seconds + res.ops[1].seconds - res.seconds)).toBeLessThan(10);
    const m0 = writeGcode([rough, fin], { units: 'mm', safeZ: 5, zZero: 'top', stockTop: 8, toolChange: 'm0' });
    expect(m0.text).not.toContain('M6');
    expect(m0.text.split('\n')).toContain('M0');
  });
});

describe('cutout', () => {
  const tool = { type: 'flat' as const, diameter: 6, angle: 0 };
  const o = { tool, widthMm: 40, heightMm: 30, stockTop: 8, stepdown: 3, through: 0.3, tabs: 2, tabWidth: 5, tabHeight: 2, climb: true };
  const p = cutoutPath(o);

  it('goes round the part at the tool radius, down to just below it, over the tabs', () => {
    let minZ = Infinity, maxZ = -Infinity, onTab = 0;
    for (let k = 0; k < p.length; k += 3) {
      const x = p[k], y = p[k + 1], zz = p[k + 2];
      const ex = Math.max(-x, 0, x - 40), ey = Math.max(-y, 0, y - 30);
      expect(Math.hypot(ex, ey)).toBeCloseTo(3, 1);
      minZ = Math.min(minZ, zz);
      maxZ = Math.max(maxZ, zz);
      if (Math.abs(zz - 2) < 1e-6) onTab++;
    }
    expect(minZ).toBeCloseTo(-0.3, 5);
    expect(maxZ).toBeCloseTo(8, 5);
    expect(onTab).toBeGreaterThan(8);
    // going down only gently, except straight down at the end of a tab
    let slope = 0;
    for (let k = 3; k < p.length; k += 3) {
      const d = Math.hypot(p[k] - p[k - 3], p[k + 1] - p[k - 2]);
      if (d > 1e-6 && p[k + 2] < p[k - 1]) slope = Math.max(slope, (p[k - 1] - p[k + 2]) / d);
    }
    expect(slope).toBeLessThan(0.05);
  });

  it('clockwise for climb, counter-clockwise for conventional', () => {
    const area = (q: Float32Array) => {
      let a = 0;
      const n = q.length / 3;
      for (let i = 0; i < n - 1; i++) a += q[i * 3] * q[i * 3 + 4] - q[i * 3 + 3] * q[i * 3 + 1];
      return a;
    };
    expect(area(p)).toBeLessThan(0);
    expect(area(cutoutPath({ ...o, climb: false }))).toBeGreaterThan(0);
  });
});

describe('detail pass', () => {
  // a 1 mm wide groove down to 1 mm: a 3.175 mm ball cannot get in, a 0.5 mm ball can
  const z2 = new Float32Array(g.z);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (Math.abs(i * dx - 10) <= 0.5) z2[j * nx + i] = 1;
  const g2 = { ...g, z: z2, zMin: 1 };
  const big = { type: 'ball' as const, diameter: 3.175, angle: 0 };
  const small = { type: 'ball' as const, diameter: 0.5, angle: 0 };
  const fc = simulateCut(g2, big).cut;
  const d = detailRegion(g2, small, fc);

  it('works only around what the finishing tool missed, and goes deeper', () => {
    // the groove, and the soft crease where the dome meets the base; not the dome itself
    const R = (x: number, y: number) => d.region[Math.round(y / dx) * nx + Math.round(x / dx)];
    expect(R(10, 15)).toBe(1);
    expect(R(20, 15)).toBe(0);
    expect(R(26, 15)).toBe(0);
    expect(d.area).toBeLessThan(30 * 8 + 2 * Math.PI * 12 * 3);
    const r = detailPaths(g2, { tool: small, stepover: 0.5, dir: 'x', finishCut: fc, region: d.region });
    // runs are linked with short hops over the finished surface
    expect(r.link!.filter((h) => !Number.isNaN(h)).length).toBeGreaterThan(r.paths.length / 2);
    const hops = writeGcode({ name: 'detail', number: 3, tool: small, rpm: 18000, feed: 900, plunge: 300, ...r }, { units: 'mm', safeZ: 5, zZero: 'bottom', stockTop: 8 });
    for (const m of replay(hops.text, 0)) expect(m[2]).toBeGreaterThanOrEqual(0.99); // never below the groove floor
    let low = Infinity;
    for (const p of r.paths)
      for (let k = 0; k < p.length; k += 3) {
        expect(Math.hypot(p[k] - 20, p[k + 1] - 15)).toBeGreaterThan(8); // runs are joined over gaps up to 3 mm
        low = Math.min(low, p[k + 2]);
      }
    expect(low).toBeLessThan(1.5);
    r.paths.forEach((p, i) => expect(r.entry[i]).toBeGreaterThanOrEqual(p[2] - 1e-6));
  });

  it('tool width at a height', () => {
    expect(toolRadiusAt(small, 1)).toBeCloseTo(0.25, 6);
    expect(toolRadiusAt({ type: 'vbit', diameter: 0, angle: 90 }, 1)).toBeCloseTo(1, 3);
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
    // 8230 mm/min at 18k is too fast for a hobby router: 5000 mm/min, spindle slowed to keep the chip
    expect(r.rpm).toBe(10900);
    expect(Math.abs(r.feed - 5000)).toBeLessThanOrEqual(30);
    expect(r.stepdown).toBeCloseTo(3.18, 2);
    expect(r.stepover).toBeCloseTo(2.54, 2);
  });
  it('machine limits cap the recommendation', () => {
    const r = recommend('hardwood', { type: 'flat', diameter: 6.35, angle: 0 }, 2, 'rough', { minRpm: 12000, maxRpm: 24000, maxFeed: 2500 });
    expect(r.rpm).toBe(12000);
    expect(r.feed).toBe(2500);
  });
  it('chip load check flags rubbing', () => {
    const t = { type: 'flat' as const, diameter: 6.35, angle: 0 };
    expect(chipRatio('hardwood', t, 2, 18000, 500, 'rough').ratio).toBeLessThan(0.5);
    const rec = recommend('hardwood', t, 2, 'rough', { minRpm: 8000, maxRpm: 30000, maxFeed: 20000 });
    expect(chipRatio('hardwood', t, 2, rec.rpm, rec.feed, 'rough').ratio).toBeCloseTo(1, 1);
  });
  it('finishing stepover and scallop', () => {
    const ball = { type: 'ball' as const, diameter: 3.175, angle: 0 };
    expect(stepoverFor(ball)).toBeCloseTo(0.318, 3);
    expect(scallopHeight(ball, 0.3175)).toBeCloseTo(1.5875 - Math.sqrt(1.5875 ** 2 - 0.15875 ** 2), 5);
    const v = { type: 'vbit' as const, diameter: 0, angle: 60 };
    expect(scallopHeight(v, stepoverFor(v))).toBeCloseTo(0.02, 3);
  });
});

describe('flat floor', () => {
  const rough = { type: 'flat' as const, diameter: 6.35, angle: 0 };
  const ball = { type: 'ball' as const, diameter: 1.5875, angle: 0 };
  const skip = floorSkip(g, rough, ball, 2.5)!;
  const tipB = tipHeight(g, ball);

  it('leaves out only floor well away from the dome', () => {
    expect(skip).not.toBeNull();
    let n = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (skip[j * nx + i]) {
          n++;
          // dome radius 12 + roughing tool radius + half a roughing stepover + margin
          expect(Math.hypot(i * dx - 20, j * dx - 15)).toBeGreaterThan(12 + 3.175 + 1.25 + 0.5 - 0.3);
        }
    expect(n).toBeGreaterThan(100);
    expect(floorSkip(g, { ...rough, type: 'ball' }, ball, 2.5)).toBeNull();
  });

  it('finishes everything else without gouging, rapids across over the material, and saves time', () => {
    // the material the roughing paths really leave: the flat end mill swept along them
    const rp = roughingPaths(g, { tool: rough, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
    const mat = new Float32Array(nx * ny).fill(8);
    const R = 3.175, ri = Math.ceil(R / dx);
    const sweep = (x: number, y: number, zc: number) => {
      const ci = Math.round(x / dx), cj = Math.round(y / dx);
      for (let j = Math.max(0, cj - ri); j <= Math.min(ny - 1, cj + ri); j++)
        for (let i = Math.max(0, ci - ri); i <= Math.min(nx - 1, ci + ri); i++)
          if (Math.hypot(i * dx - x, j * dx - y) <= R) mat[j * nx + i] = Math.min(mat[j * nx + i], zc);
    };
    for (const p of rp.paths)
      for (let k = 0; k + 3 < p.length; k += 3) {
        const n = Math.max(1, Math.ceil(Math.hypot(p[k + 3] - p[k], p[k + 4] - p[k + 1]) / 0.1));
        for (let q = 0; q <= n; q++) sweep(p[k] + ((p[k + 3] - p[k]) * q) / n, p[k + 1] + ((p[k + 4] - p[k + 1]) * q) / n, Math.max(p[k + 2], p[k + 5]));
      }
    // what the ball meets: the highest material within its radius
    const rb = Math.ceil(0.8 / dx), meets = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let m = -Infinity;
        for (let jj = Math.max(0, j - rb); jj <= Math.min(ny - 1, j + rb); jj++)
          for (let ii = Math.max(0, i - rb); ii <= Math.min(nx - 1, i + rb); ii++) m = Math.max(m, mat[jj * nx + ii]);
        meets[j * nx + i] = m;
      }
    const rest = roughRest(g, rough, 0.5, 2.5, toolRadiusAt(ball, 2));
    let worst = -Infinity;
    for (let k = 0; k < rest.length; k++) worst = Math.max(worst, meets[k] - rest[k]);
    expect(worst).toBeLessThanOrEqual(1e-3); // the estimate is never below the real material

    const r = finishingRuns(g, { tool: ball, stepover: 0.5, dir: 'x', skip, rest, stockTop: 8 });
    expect(r.paths.length).toBeGreaterThan(30);
    // riding on the tool height interpolated between the grid lines either side
    const lo = (x: number, y: number) => Math.min(tipB[Math.floor(y / dx) * nx + Math.round(x / dx)], tipB[Math.min(ny - 1, Math.ceil(y / dx)) * nx + Math.round(x / dx)], tipB[Math.round(y / dx) * nx + Math.floor(x / dx)], tipB[Math.round(y / dx) * nx + Math.min(nx - 1, Math.ceil(x / dx))]);
    for (const p of r.paths) for (let k = 0; k < p.length; k += 3) expect(p[k + 2]).toBeGreaterThanOrEqual(lo(p[k], p[k + 1]) - 1e-3);
    // the line through the middle of the dome is covered across the whole dome
    const mid = r.paths.filter((p) => Math.abs(p[1] - 15) < 0.26 && Math.abs(p[4] - 15) < 0.26);
    expect(mid.some((p) => Math.min(p[0], p[p.length - 3]) <= 8 && Math.max(p[0], p[p.length - 3]) >= 32)).toBe(true);
    const tp = { name: 'finishing', number: 2, tool: ball, rpm: 18000, feed: 1000, plunge: 300 };
    const res = writeGcode({ ...tp, ...r }, { units: 'mm', safeZ: 5, zZero: 'bottom', stockTop: 8 });
    // rapids never meet the material roughing left (the finishing pass only lowers it further)
    const mv = replay(res.text, 0);
    for (let k = 1; k < mv.length; k++) {
      if (!mv[k][3]) continue;
      const [x0, y0, z0] = mv[k - 1], [x1, y1, z1] = mv[k];
      if (x0 === x1 && y0 === y1 && z1 >= z0) continue; // straight up from where it just cut
      for (let t = 0; t <= 1; t += 0.05) {
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        if (x < 0 || y < 0 || x > 40 || y > 30) continue;
        expect(z0 + (z1 - z0) * t).toBeGreaterThanOrEqual(at(meets, x, y) - 1e-3);
      }
    }
    const full = writeGcode({ ...tp, paths: finishingPaths(g, { tool: ball, stepover: 0.5, dir: 'x' }) }, { units: 'mm', safeZ: 5, zZero: 'bottom', stockTop: 8 });
    expect(res.seconds).toBeLessThan(0.85 * full.seconds);
  });
});

describe('run time estimates', () => {
  it('times without writing the file, exactly as the written file', () => {
    const ball = { type: 'ball' as const, diameter: 1.5875, angle: 0 }, flat = { type: 'flat' as const, diameter: 6.35, angle: 0 };
    const r = roughingPaths(g, { tool: flat, stepdown: 2, stepover: 2.5, allowance: 0.5, stockTop: 8 });
    const ops = [
      { name: 'roughing', number: 1, tool: flat, rpm: 12000, feed: 2500, plunge: 800, ...r },
      { name: 'finishing', number: 2, tool: ball, rpm: 18000, feed: 1000, plunge: 300, paths: finishingPaths(g, { tool: ball, stepover: 0.5, dir: 'xy' }) },
    ];
    const o = { units: 'mm' as const, safeZ: 5, zZero: 'top' as const, stockTop: 8, rampAngle: 5, spindleDelay: 3 };
    for (const sel of [ops[0], ops[1], ops]) {
      const full = writeGcode(sel, o), fast = writeGcode(sel, { ...o, timeOnly: true });
      expect(fast.seconds).toBeCloseTo(full.seconds, 6);
      expect(fast.seconds).toBeGreaterThan(0);
    }
  });
});
