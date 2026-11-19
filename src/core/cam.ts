import type { MachGrid } from './resample';
import { tipHeight, toolProfile, type Cutter, type ToolType } from './cutter';

/**
 * 3-axis toolpaths straight from the machining grid, and a plain G-code writer that runs on
 * GRBL, Mach3/4, LinuxCNC and most hobby router controllers (no tool changes, no dwell, comments in
 * parentheses). Coordinates: X0 Y0 = front-left corner of the part, X right, Y away from you;
 * Z0 = top of the part (or the bottom, see `zZero`).
 */

/** a continuous cutting move: x, y, z triplets in part coordinates (mm, z = height above the bottom) */
export type Path = Float32Array;

export interface Toolpath {
  name: string;
  tool: Cutter;
  paths: Path[];
  rpm: number;
  feed: number;
  plunge: number;
}

// ---- finishing ----------------------------------------------------------------------------------

export interface FinishOpts {
  tool: Cutter;
  stepover: number;
  /** raster direction: lines along X, along Y, or both one after the other */
  dir: 'x' | 'y' | 'xy';
}

/**
 * Parallel (raster) finishing: zig-zag lines at `stepover`, the tool riding on the surface without
 * gouging (tip height from the cutter shape). The tool stays down between lines.
 */
export function finishingPaths(g: MachGrid, o: FinishOpts): Path[] {
  const tip = tipHeight(g, o.tool);
  const out: Path[] = [];
  if (o.dir === 'x' || o.dir === 'xy') out.push(raster(g, tip, o.stepover, 'x'));
  if (o.dir === 'y' || o.dir === 'xy') out.push(raster(g, tip, o.stepover, 'y'));
  return out;
}

/** one zig-zag path covering the part; `along` = direction of the cutting lines */
function raster(g: MachGrid, tip: Float32Array, stepover: number, along: 'x' | 'y'): Path {
  const { nx, ny } = g;
  const X = (i: number) => (i === nx - 1 ? g.widthMm : i * g.dx);
  const Y = (j: number) => (j === ny - 1 ? g.heightMm : j * g.dy);
  const across = along === 'x' ? g.heightMm : g.widthMm;
  const n = along === 'x' ? nx : ny; // points along a line
  const m = along === 'x' ? ny : nx; // grid lines across
  const d = along === 'x' ? g.dy : g.dx;
  // tip height at grid index k along the line, at position s across: linear between the two
  // neighbouring grid lines (exact on grid lines; between them the error is second order)
  const at = (k: number, gi: number) => (along === 'x' ? tip[gi * nx + k] : tip[k * nx + gi]);
  const lineZ = (k: number, s: number) => {
    const f = Math.min(m - 1, Math.max(0, s / d));
    const a = Math.floor(f), b = Math.min(m - 1, a + 1), w = f - a;
    return at(k, a) * (1 - w) + at(k, b) * w;
  };
  const pos = (k: number) => (along === 'x' ? X(k) : Y(k));
  const pts: number[] = [];
  const push = (u: number, s: number, z: number) => {
    if (along === 'x') pts.push(u, s, z);
    else pts.push(s, u, z);
  };
  const lines: number[] = [];
  const count = Math.max(1, Math.ceil(across / stepover - 1e-6));
  for (let k = 0; k <= count; k++) lines.push(Math.min(across, k * (across / count)));
  let prevEnd: { k: number; s: number; z: number } | null = null;
  lines.forEach((s, li) => {
    const fwd = li % 2 === 0;
    const zs = new Float32Array(n);
    for (let k = 0; k < n; k++) zs[k] = lineZ(k, s);
    const order = Array.from({ length: n }, (_, k) => (fwd ? k : n - 1 - k));
    // link from the previous line: lift to the highest point on the way, step over, go down
    if (prevEnd) {
      const k = order[0];
      const a = Math.floor(Math.min(prevEnd.s, s) / d), b = Math.ceil(Math.max(prevEnd.s, s) / d);
      let zl = Math.max(prevEnd.z, zs[k]);
      for (let gi = Math.max(0, a); gi <= Math.min(m - 1, b); gi++) zl = Math.max(zl, at(k, gi));
      if (zl > prevEnd.z + 1e-4) push(pos(k), prevEnd.s, zl);
      if (zl > zs[k] + 1e-4) push(pos(k), s, zl);
    }
    const keep = simplify(order.map((k) => pos(k)), order.map((k) => zs[k]), 0.002);
    for (const q of keep) push(pos(order[q]), s, zs[order[q]]);
    const last = order[n - 1];
    prevEnd = { k: last, s, z: zs[last] };
  });
  return Float32Array.from(pts);
}

/** Douglas–Peucker on a (u, z) polyline: indexes of the points to keep (within tol, mm) */
function simplify(u: number[], z: number[], tol: number): number[] {
  const n = u.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const t = (u[i] - u[a]) / (u[b] - u[a] || 1);
      const dz = Math.abs(z[i] - (z[a] + t * (z[b] - z[a])));
      if (dz > wd) { wd = dz; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ---- roughing -----------------------------------------------------------------------------------

export interface RoughOpts {
  tool: Cutter;
  stepdown: number;
  stepover: number;
  /** material left on the surface for the finishing pass (mm) */
  allowance: number;
  /** top of the stock (mm above the part bottom) */
  stockTop: number;
}

/**
 * Z-level raster roughing: level by level from the top of the stock down, lines along X at
 * `stepover`; the tool cuts only where there is material left from the level above, never deeper
 * than `stepdown` per level and never closer than `allowance` to the design. Each run starts with a
 * plunge from the safe height and ends with a retract.
 */
export function roughingPaths(g: MachGrid, o: RoughOpts): Path[] {
  const { nx, ny } = g;
  const tip = tipHeight(g, o.tool);
  for (let k = 0; k < tip.length; k++) tip[k] += o.allowance;
  let lo = Infinity;
  for (const v of tip) lo = Math.min(lo, v);
  const X = (i: number) => (i === nx - 1 ? g.widthMm : i * g.dx);
  const count = Math.max(1, Math.ceil(g.heightMm / o.stepover - 1e-6));
  const rows: number[] = [];
  for (let k = 0; k <= count; k++) rows.push(Math.min(g.heightMm, k * (g.heightMm / count)));
  const out: Path[] = [];
  const sd = Math.max(0.05, o.stepdown);
  let prev = o.stockTop;
  for (let level = o.stockTop - sd; prev > lo + 1e-4; level -= sd) {
    const L = Math.max(level, lo);
    rows.forEach((y, ri) => {
      const f = Math.min(ny - 1, Math.max(0, y / g.dy));
      const a = Math.floor(f), b = Math.min(ny - 1, Math.ceil(f));
      const zt = (i: number) => Math.max(tip[a * nx + i], tip[b * nx + i]);
      const order = Array.from({ length: nx }, (_, i) => (ri % 2 === 0 ? i : nx - 1 - i));
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 6) out.push(Float32Array.from(run));
        run = [];
      };
      for (const i of order) {
        const t = zt(i);
        if (t < prev - 1e-3) run.push(X(i), y, Math.max(L, t));
        else flush();
      }
      flush();
    });
    prev = L;
  }
  return out;
}

// ---- speeds and feeds ---------------------------------------------------------------------------

export type Material = 'softwood' | 'hardwood' | 'mdf' | 'plastic' | 'aluminum';

/** chip load per tooth (inch) for 1/16", 1/8", 1/4", 1/2" cutters: common router starting values */
const CHIP: Record<Material, number[]> = {
  softwood: [0.002, 0.004, 0.011, 0.021],
  hardwood: [0.0015, 0.003, 0.009, 0.019],
  mdf: [0.002, 0.004, 0.013, 0.023],
  plastic: [0.002, 0.004, 0.007, 0.012],
  aluminum: [0.0005, 0.001, 0.002, 0.004],
};
const CHIP_D = [1.5875, 3.175, 6.35, 12.7];

/** chip load (mm per tooth), log-log interpolated over the tool diameter */
export function chipLoad(material: Material, diameter: number): number {
  const t = CHIP[material];
  const d = Math.min(CHIP_D[3], Math.max(0.2, diameter));
  let k = 0;
  while (k < 2 && d > CHIP_D[k + 1]) k++;
  const f = Math.log(d / CHIP_D[k]) / Math.log(CHIP_D[k + 1] / CHIP_D[k]);
  return Math.exp(Math.log(t[k]) + f * (Math.log(t[k + 1]) - Math.log(t[k]))) * 25.4;
}

export interface Recommendation {
  rpm: number;
  feed: number;
  plunge: number;
  stepdown: number;
  stepover: number;
}

/**
 * Conservative starting speeds and feeds for a hobby router spindle (max 24 000 rpm). The
 * finishing pass of a ball / tapered tool cuts with less than its full diameter, so it uses 75 %
 * of the chip load. Stepover: roughing 40 % of Ø (30 % in aluminium); finishing see stepoverFor.
 */
export function recommend(material: Material, tool: Cutter, flutes: number, op: 'rough' | 'finish'): Recommendation {
  const rpm = material === 'plastic' ? 16000 : 18000;
  // effective cutting diameter: a sharp V-bit still cuts with its flanks
  const d = Math.max(tool.diameter, tool.type === 'vbit' || tool.type === 'taperedBall' ? 1.5 : 0.3);
  const chip = chipLoad(material, d) * (op === 'finish' && tool.type !== 'flat' ? 0.75 : 1);
  const feed = Math.round(Math.min(op === 'finish' ? 4000 : 5000, Math.max(100, rpm * Math.max(1, flutes) * chip)) / 10) * 10;
  const plunge = Math.round(feed / 3 / 10) * 10;
  const sdK = material === 'aluminum' ? 0.2 : material === 'plastic' ? 0.4 : 0.5;
  return {
    rpm,
    feed,
    plunge,
    stepdown: Math.round(Math.max(0.2, d * sdK) * 100) / 100,
    stepover: op === 'rough' ? Math.round(d * (material === 'aluminum' ? 0.3 : 0.4) * 100) / 100 : stepoverFor(tool),
  };
}

/**
 * Recommended finishing stepover: 10 % of the ball / tip Ø (fine finish in wood, ~0.006 mm
 * scallop) for ball and tapered tools; for a V-bit or engraver the stepover that leaves a 0.02 mm
 * ridge; 25 % of Ø for a flat end mill.
 */
export function stepoverFor(tool: Cutter): number {
  const r = tool.diameter / 2;
  let s: number;
  if (tool.type === 'ball' || tool.type === 'taperedBall') s = 0.1 * tool.diameter;
  else if (tool.type === 'flat') s = 0.25 * tool.diameter;
  else s = 2 * (r + 0.02 * Math.tan(((tool.angle / 2) * Math.PI) / 180));
  return Math.round(Math.max(0.02, s) * 1000) / 1000;
}

/** height of the ridges a stepover leaves on a flat area */
export function scallopHeight(tool: Cutter, stepover: number): number {
  const p = toolProfile(tool, stepover / 2);
  return Number.isFinite(p) ? p : 0;
}

// ---- G-code -------------------------------------------------------------------------------------

export interface GcodeOpts {
  units: 'mm' | 'in';
  /** safe height above the top of the part (mm) */
  safeZ: number;
  /** Z0 at the top of the part (the highest point) or at its bottom (the bed / spoilboard) */
  zZero: 'top' | 'bottom';
  /** height of the part's top above its bottom (mm) */
  partTop: number;
  /** description lines for the header */
  notes?: string[];
}

export const toolLabel = (t: Cutter, fmt: (mm: number) => string): string =>
  ({
    ball: `${fmt(t.diameter)} ball end mill`,
    taperedBall: `${fmt(t.diameter)} tip, ${t.angle}° tapered ball nose`,
    vbit: `${t.angle}° V-bit${t.diameter > 0 ? `, ${fmt(t.diameter)} flat tip` : ''}`,
    flat: `${fmt(t.diameter)} flat end mill`,
  })[t.type as ToolType];

export interface GcodeResult {
  text: string;
  /** estimated run time (s): cutting at feed, plunges at plunge rate, rapids at 5 m/min */
  seconds: number;
  cutLength: number;
  lines: number;
}

/**
 * G-code for one toolpath (one tool). Absolute coordinates, units per mm/inch choice, feed per
 * minute. Rapids only at the safe height; every path starts with a plunge at the plunge rate.
 */
export function writeGcode(tp: Toolpath, o: GcodeOpts): GcodeResult {
  const k = o.units === 'in' ? 1 / 25.4 : 1;
  const dec = o.units === 'in' ? 4 : 3;
  const zOff = o.zZero === 'top' ? o.partTop : 0;
  const n = (v: number) => {
    const s = (v * k).toFixed(dec).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const nf = (v: number) => (v * k).toFixed(1).replace(/\.0$/, '');
  const fmtLen = (mm: number) => (o.units === 'in' ? `${n(mm)} in` : `${n(mm)} mm`);
  const L: string[] = [];
  const safe = o.partTop + o.safeZ;
  L.push(`(Relief Generator - ${tp.name})`);
  L.push(`(Tool: ${toolLabel(tp.tool, fmtLen)})`);
  L.push(`(Zero: X0 Y0 = front-left corner of the part, Z0 = ${o.zZero === 'top' ? 'top of the part' : 'bottom of the part (spoilboard)'})`);
  L.push(`(Part: ${fmtLen(o.partTop)} tall; spindle ${tp.rpm} rpm, feed ${nf(tp.feed)}, plunge ${nf(tp.plunge)} ${o.units}/min)`);
  for (const s of o.notes ?? []) L.push(`(${s.replace(/[()]/g, '')})`);
  L.push('G90 G94 G17');
  L.push(o.units === 'in' ? 'G20' : 'G21');
  L.push(`G0 Z${n(safe - zOff)}`);
  L.push(`M3 S${Math.round(tp.rpm)}`);
  let cur = { x: 0, y: 0, z: safe };
  let mode = '';
  let feed = -1;
  let cutLen = 0, plungeLen = 0, rapidLen = 0;
  const move = (g: 'G0' | 'G1', x: number, y: number, z: number, f?: number) => {
    const parts: string[] = [];
    if (g !== mode) parts.push(g);
    if (Math.abs(x - cur.x) > 1e-6) parts.push(`X${n(x)}`);
    if (Math.abs(y - cur.y) > 1e-6) parts.push(`Y${n(y)}`);
    if (Math.abs(z - cur.z) > 1e-6) parts.push(`Z${n(z - zOff)}`);
    if (parts.length === (g !== mode ? 1 : 0)) return;
    if (g === 'G1' && f !== undefined && f !== feed) {
      parts.push(`F${nf(f)}`);
      feed = f;
    }
    const d = Math.hypot(x - cur.x, y - cur.y, z - cur.z);
    if (g === 'G0') rapidLen += d;
    else if (f === tp.plunge) plungeLen += d;
    else cutLen += d;
    mode = g;
    L.push(parts.join(' '));
    cur = { x, y, z };
  };
  // the first move of the file goes up before going across
  L.push('G0 X0 Y0');
  mode = 'G0';
  for (const p of tp.paths) {
    if (p.length < 3) continue;
    move('G0', cur.x, cur.y, safe);
    move('G0', p[0], p[1], safe);
    move('G1', p[0], p[1], p[2], tp.plunge);
    for (let i = 3; i < p.length; i += 3) {
      // a move that goes down steeply is a plunge
      const dz = cur.z - p[i + 2], dxy = Math.hypot(p[i] - cur.x, p[i + 1] - cur.y);
      move('G1', p[i], p[i + 1], p[i + 2], dz > 0.5 && dz > 2 * dxy ? tp.plunge : tp.feed);
    }
  }
  move('G0', cur.x, cur.y, safe);
  L.push('M5');
  mode = '';
  move('G0', 0, 0, safe);
  L.push('M30');
  const seconds = (cutLen / tp.feed + plungeLen / tp.plunge + rapidLen / 5000) * 60;
  return { text: L.join('\n') + '\n', seconds, cutLength: cutLen, lines: L.length };
}

/** line-segment vertex list (x, y, z pairs) of the toolpaths for the 3D preview, links included */
export function previewSegments(paths: Path[], safe: number, maxSegs = 400_000): Float32Array {
  let total = 0;
  for (const p of paths) total += p.length / 3 + 2;
  const step = Math.max(1, Math.ceil(total / maxSegs));
  const out: number[] = [];
  let last: [number, number, number] | null = null;
  const seg = (a: [number, number, number], b: [number, number, number]) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  for (const p of paths) {
    const first: [number, number, number] = [p[0], p[1], p[2]];
    if (last) {
      seg(last, [last[0], last[1], safe]);
      seg([last[0], last[1], safe], [first[0], first[1], safe]);
      seg([first[0], first[1], safe], first);
    }
    let prev = first;
    const np = p.length / 3;
    for (let i = step; i < np + step - 1; i += step) {
      const q = Math.min(i, np - 1) * 3;
      const cur: [number, number, number] = [p[q], p[q + 1], p[q + 2]];
      seg(prev, cur);
      prev = cur;
    }
    last = prev;
  }
  return Float32Array.from(out);
}
