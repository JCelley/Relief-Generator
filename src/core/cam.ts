import type { MachGrid } from './resample';
import { tipHeight, toolProfile, simulateCut, type Cutter, type ToolType } from './cutter';

/**
 * 3-axis toolpaths straight from the machining grid, and a plain G-code writer that runs on
 * GRBL, Mach3/4, LinuxCNC and most hobby router controllers (comments in parentheses).
 * Coordinates: X0 Y0 = front-left corner of the stock, X right, Y away from you; Z0 = top of the
 * stock (or the part bottom, see `zZero`).
 */

/** a continuous cutting move: x, y, z triplets in part coordinates (mm, z = height above the bottom) */
export type Path = Float32Array;

export interface Toolpath {
  name: string;
  tool: Cutter;
  /** tool number (T#) for a file with several tools */
  number: number;
  paths: Path[];
  /** for each path: top of the material the tool meets over its start (mm above the part bottom);
   *  the rapid down stops 1 mm above it. Default: the stock top */
  entry?: number[];
  /** for each path: a height (mm above the part bottom) at which a rapid from the end of the path
   *  before is clear of the material everywhere in the box between the two points (so it is safe
   *  even when the controller's rapid is not a straight line); NaN = go up to the safe height */
  link?: number[];
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

/** square dilation of a 0/1 mask by ri columns and rj rows (separable) */
function dilate(mask: Uint8Array, nx: number, ny: number, ri: number, rj: number): Uint8Array {
  const tmp = new Uint8Array(nx * ny), out = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    let last = -1e9;
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i]) last = i;
      if (i - last <= ri) tmp[j * nx + i] = 1;
    }
    last = 1e9;
    for (let i = nx - 1; i >= 0; i--) {
      if (mask[j * nx + i]) last = i;
      if (last - i <= ri) tmp[j * nx + i] = 1;
    }
  }
  for (let i = 0; i < nx; i++) {
    let last = -1e9;
    for (let j = 0; j < ny; j++) {
      if (tmp[j * nx + i]) last = j;
      if (j - last <= rj) out[j * nx + i] = 1;
    }
    last = 1e9;
    for (let j = ny - 1; j >= 0; j--) {
      if (tmp[j * nx + i]) last = j;
      if (last - j <= rj) out[j * nx + i] = 1;
    }
  }
  return out;
}

/**
 * Grid points the finishing tool need not visit: flat floor that a flat roughing end mill has
 * already cut to depth (it met only the floor there, and so did its neighbours on the roughing lines
 * either side), where the finishing tool would only ride on that floor. Null if roughing can't do it.
 */
export function floorSkip(g: MachGrid, rough: Cutter, finish: Cutter, roughStepover: number): Uint8Array | null {
  if (rough.type !== 'flat') return null;
  const { nx, ny } = g, fl = g.zMin + 1e-4;
  const tr = tipHeight(g, rough), tf = tipHeight(g, finish);
  // not reached by the roughing tool at floor depth, grown by half a roughing stepover and a margin
  const notDone = new Uint8Array(nx * ny);
  for (let k = 0; k < notDone.length; k++) notDone[k] = tr[k] > fl ? 1 : 0;
  const m = roughStepover / 2 + 0.5;
  const grown = dilate(notDone, nx, ny, Math.ceil(m / g.dx), Math.ceil(m / g.dy));
  const skip = new Uint8Array(nx * ny);
  let n = 0;
  for (let k = 0; k < skip.length; k++) if (!grown[k] && tf[k] <= fl) (skip[k] = 1), n++;
  return n ? skip : null;
}

/** square running maximum of a grid over ±ri columns and ±rj rows (separable) */
function maxFilter(a: Float32Array, nx: number, ny: number, ri: number, rj: number): Float32Array {
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let m = -Infinity;
      for (let q = Math.max(0, i - ri); q <= Math.min(nx - 1, i + ri); q++) m = Math.max(m, a[j * nx + q]);
      tmp[j * nx + i] = m;
    }
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      let m = -Infinity;
      for (let q = Math.max(0, j - rj); q <= Math.min(ny - 1, j + rj); q++) m = Math.max(m, tmp[q * nx + i]);
      out[j * nx + i] = m;
    }
  return out;
}

/**
 * Highest the material can be after roughing, as met by a tool of radius `reach` coming down at
 * each point. Roughing takes every point on its lines down to the tool's final height there (the
 * design plus the allowance, or the floor), and every point lies within half a stepover of a line,
 * inside the tool's footprint: so the material is no higher than that final height within half a
 * stepover, and the tool meets the highest of that within its own radius.
 */
export function roughRest(g: MachGrid, rough: Cutter, allowance: number, stepover: number, reach: number): Float32Array {
  const tip = tipHeight(g, rough);
  const floor = rough.type === 'flat' ? g.zMin + 1e-4 : -Infinity;
  for (let k = 0; k < tip.length; k++) if (tip[k] > floor) tip[k] += allowance;
  const m = stepover / 2 + reach + 0.05;
  return maxFilter(tip, g.nx, g.ny, Math.ceil(m / g.dx), Math.ceil(m / g.dy));
}

/**
 * Grid points where the finishing tool would only touch the top of the stock (uncut board round a
 * part, or a flat top at the stock height): there is nothing to cut there. Null if there are none.
 */
export function topSkip(g: MachGrid, finish: Cutter, stockTop: number): Uint8Array | null {
  const tf = tipHeight(g, finish);
  const skip = new Uint8Array(tf.length);
  let n = 0;
  for (let k = 0; k < tf.length; k++) if (tf[k] >= stockTop - 1e-4) (skip[k] = 1), n++;
  return n ? skip : null;
}

export interface FinishRunOpts extends FinishOpts {
  /** grid points to leave out (see floorSkip) */
  skip: Uint8Array;
  /** highest the material can be before this pass, as met by this tool (see roughRest) */
  rest: Float32Array;
  stockTop: number;
}

/**
 * Raster finishing that leaves out floor already cut to depth: each line is split into runs
 * (joined over gaps up to 2 mm), and between runs the tool rapids across over the material instead
 * of feeding over the floor.
 */
export function finishingRuns(g: MachGrid, o: FinishRunOpts): PathSet {
  const { nx, ny } = g;
  const tip = tipHeight(g, o.tool);
  const out: PathSet = { paths: [], entry: [], link: [] };
  let last: Path | null = null;
  const dirs: ('x' | 'y')[] = o.dir === 'xy' ? ['x', 'y'] : [o.dir];
  dirs.forEach((along, di) => {
    // the second direction of a cross-hatch goes over a surface the first one finished
    const top = di === 0 ? o.rest : tip;
    const n = along === 'x' ? nx : ny, m = along === 'x' ? ny : nx;
    const d = along === 'x' ? g.dy : g.dx, du = along === 'x' ? g.dx : g.dy;
    const across = along === 'x' ? g.heightMm : g.widthMm;
    const idx = (k: number, gi: number) => (along === 'x' ? gi * nx + k : k * nx + gi);
    const pos = (k: number) => (k === n - 1 ? (along === 'x' ? g.widthMm : g.heightMm) : k * du);
    /** highest the material can be in the box between two points, plus a margin */
    const hop = (x0: number, y0: number, x1: number, y1: number) => {
      const i0 = Math.max(0, Math.floor(Math.min(x0, x1) / g.dx)), i1 = Math.min(nx - 1, Math.ceil(Math.max(x0, x1) / g.dx));
      const j0 = Math.max(0, Math.floor(Math.min(y0, y1) / g.dy)), j1 = Math.min(ny - 1, Math.ceil(Math.max(y0, y1) / g.dy));
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 200_000) return NaN;
      let h = -Infinity;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) h = Math.max(h, top[j * nx + i]);
      return Math.min(o.stockTop, h) + 0.2;
    };
    const gap = Math.ceil(2 / du);
    const count = Math.max(1, Math.ceil(across / o.stepover - 1e-6));
    for (let li = 0; li <= count; li++) {
      const s = Math.min(across, li * (across / count));
      const f = Math.min(m - 1, Math.max(0, s / d));
      const a = Math.floor(f), b = Math.min(m - 1, a + 1), w = f - a;
      const zAt = (k: number) => tip[idx(k, a)] * (1 - w) + tip[idx(k, b)] * w;
      const work = (k: number) => !(o.skip[idx(k, a)] && o.skip[idx(k, b)]);
      const fwd = li % 2 === 0;
      const runs: number[][] = [];
      let cur: number[] = [], miss = 0;
      for (let q = 0; q < n; q++) {
        const k = fwd ? q : n - 1 - q;
        if (work(k)) {
          if (cur.length && miss) for (let r = miss; r > 0; r--) cur.push(fwd ? k - r : k + r);
          cur.push(k);
          miss = 0;
        } else if (cur.length && ++miss > gap) {
          runs.push(cur);
          cur = [];
          miss = 0;
        }
      }
      if (cur.length) runs.push(cur);
      for (const r of runs) {
        const keep = simplify(r.map(pos), r.map(zAt), 0.002);
        const pts: number[] = [];
        for (const q of keep) {
          const k = r[q];
          if (along === 'x') pts.push(pos(k), s, zAt(k));
          else pts.push(s, pos(k), zAt(k));
        }
        const p = Float32Array.from(pts);
        const k0 = r[0];
        out.entry.push(Math.max(p[2], Math.min(o.stockTop, Math.max(top[idx(k0, a)], top[idx(k0, b)]))));
        const q = last ? last.length - 3 : 0;
        out.link!.push(last ? hop(last[q], last[q + 1], p[0], p[1]) : NaN);
        out.paths.push(p);
        last = p;
      }
    }
  });
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

/** paths plus, for each, the top of the material the tool meets over its start (see Toolpath.entry) */
export interface PathSet {
  paths: Path[];
  entry: number[];
  /** see Toolpath.link */
  link?: number[];
}

/**
 * Z-level raster roughing: level by level from the top of the stock down, lines along X at
 * `stepover`; the tool cuts only where there is material left from the level above, never deeper
 * than `stepdown` per level and never closer than `allowance` to the design. Every point of a run
 * was visited at the level above (same lines every level), so the material over a run's start is at
 * most that level: the tool can come down fast to just above it and ramp in from there.
 * With a flat end mill, the flat floor of the part is cut to its final depth (no allowance).
 */
export function roughingPaths(g: MachGrid, o: RoughOpts): PathSet {
  const { nx, ny } = g;
  const tip = tipHeight(g, o.tool);
  // a flat end mill cuts the flat floor (the lowest level) to its final depth: there it meets only
  // the floor, and its bottom leaves it as flat as a finishing pass would
  const floor = o.tool.type === 'flat' ? g.zMin + 1e-4 : -Infinity;
  for (let k = 0; k < tip.length; k++) if (tip[k] > floor) tip[k] += o.allowance;
  let lo = Infinity;
  for (const v of tip) lo = Math.min(lo, v);
  const X = (i: number) => (i === nx - 1 ? g.widthMm : i * g.dx);
  const count = Math.max(1, Math.ceil(g.heightMm / o.stepover - 1e-6));
  const rows: number[] = [];
  for (let k = 0; k <= count; k++) rows.push(Math.min(g.heightMm, k * (g.heightMm / count)));
  const out: PathSet = { paths: [], entry: [] };
  const sd = Math.max(0.05, o.stepdown);
  let prev = o.stockTop;
  for (let level = o.stockTop - sd; prev > lo + 1e-4; level -= sd) {
    const L = Math.max(level, lo);
    rows.forEach((y, ri) => {
      const f = Math.min(ny - 1, Math.max(0, y / g.dy));
      const a = Math.floor(f), b = Math.min(ny - 1, Math.ceil(f));
      const zt = (i: number) => Math.max(tip[a * nx + i], tip[b * nx + i]);
      const order = Array.from({ length: nx }, (_, i) => (ri % 2 === 0 ? i : nx - 1 - i));
      let xs: number[] = [], zs: number[] = [];
      const flush = () => {
        if (xs.length) {
          // flat stretches at the level need only their ends
          const pts: number[] = [];
          for (const q of simplify(xs, zs, 0.002)) pts.push(xs[q], y, zs[q]);
          out.paths.push(Float32Array.from(pts));
          out.entry.push(prev);
        }
        xs = [];
        zs = [];
      };
      for (const i of order) {
        const t = zt(i);
        if (t < prev - 1e-3) {
          xs.push(X(i));
          zs.push(Math.max(L, t));
        } else flush();
      }
      flush();
    });
    prev = L;
  }
  return out;
}

// ---- detail (rest machining) --------------------------------------------------------------------

/** half-width of a cutter at height h above its tip */
export function toolRadiusAt(tool: Cutter, h: number): number {
  const r = tool.diameter / 2;
  if (tool.type === 'flat') return r;
  if (tool.type === 'ball') return h >= r ? r : Math.sqrt(Math.max(0, r * r - (r - h) * (r - h)));
  let a = 0, b = r + h * Math.tan(((Math.min(179, tool.angle) / 2) * Math.PI) / 180) + 1;
  for (let k = 0; k < 40; k++) {
    const m = (a + b) / 2;
    if (toolProfile(tool, m) <= h) a = m;
    else b = m;
  }
  return a;
}

/**
 * Where a smaller detail tool still has work after the finishing pass: grid points where the
 * finishing tool leaves more than `min` mm that the detail tool can take off, grown by the detail
 * tool's width there so it gets into the corner from all sides. `cut` = what the detail tool leaves.
 */
export function detailRegion(g: MachGrid, tool: Cutter, finishCut: Float32Array, min = 0.05): { region: Uint8Array; cut: Float32Array; area: number } {
  const { nx, ny } = g;
  const cut = simulateCut(g, tool).cut;
  const seed = new Uint8Array(nx * ny);
  let depth = 0;
  for (let k = 0; k < seed.length; k++) {
    const d = finishCut[k] - cut[k];
    if (d > min) {
      seed[k] = 1;
      depth = Math.max(depth, d);
    }
  }
  const rad = toolRadiusAt(tool, depth) + 0.5;
  const region = dilate(seed, nx, ny, Math.ceil(rad / g.dx), Math.ceil(rad / g.dy));
  let n = 0;
  for (const v of region) n += v;
  return { region, cut, area: (n / region.length) * g.widthMm * g.heightMm };
}

export interface DetailOpts {
  tool: Cutter;
  stepover: number;
  dir: 'x' | 'y' | 'xy';
  /** surface left by the finishing pass */
  finishCut: Float32Array;
  region: Uint8Array;
}

/**
 * Raster lines with the detail tool, only where `region` is set: runs along each line, joined over
 * gaps up to 1 mm (riding on the surface). Between runs less than 10 mm apart the tool hops across
 * just over the finished surface (the tool's resting height over it is known everywhere) instead of
 * going up to the safe height; each run is entered from just above that surface.
 */
export function detailPaths(g: MachGrid, o: DetailOpts): PathSet {
  const { nx, ny } = g;
  const tip = tipHeight(g, o.tool);
  const above = tipHeight({ ...g, z: o.finishCut }, o.tool);
  const out: PathSet = { paths: [], entry: [], link: [] };
  /** highest resting height of the tool over the finished surface in the box between two points */
  const hop = (x0: number, y0: number, x1: number, y1: number) => {
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1) / g.dx)), i1 = Math.min(nx - 1, Math.ceil(Math.max(x0, x1) / g.dx));
    const j0 = Math.max(0, Math.floor(Math.min(y0, y1) / g.dy)), j1 = Math.min(ny - 1, Math.ceil(Math.max(y0, y1) / g.dy));
    let h = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) h = Math.max(h, above[j * nx + i]);
    return h + 0.2;
  };
  let last: Path | null = null;
  const dirs: ('x' | 'y')[] = o.dir === 'xy' ? ['x', 'y'] : [o.dir];
  for (const along of dirs) {
    const n = along === 'x' ? nx : ny, m = along === 'x' ? ny : nx;
    const d = along === 'x' ? g.dy : g.dx, du = along === 'x' ? g.dx : g.dy;
    const across = along === 'x' ? g.heightMm : g.widthMm;
    const idx = (k: number, gi: number) => (along === 'x' ? gi * nx + k : k * nx + gi);
    const pos = (k: number) => (k === n - 1 ? (along === 'x' ? g.widthMm : g.heightMm) : k * du);
    const gap = Math.ceil(1 / du);
    const count = Math.max(1, Math.ceil(across / o.stepover - 1e-6));
    for (let li = 0; li <= count; li++) {
      const s = Math.min(across, li * (across / count));
      const f = Math.min(m - 1, Math.max(0, s / d));
      const a = Math.floor(f), b = Math.min(m - 1, a + 1), w = f - a;
      const zAt = (k: number) => tip[idx(k, a)] * (1 - w) + tip[idx(k, b)] * w;
      const inR = (k: number) => o.region[idx(k, Math.round(f))] === 1;
      const fwd = li % 2 === 0;
      const ks: number[] = [];
      for (let q = 0; q < n; q++) ks.push(fwd ? q : n - 1 - q);
      // runs of in-region points, joined over short gaps
      const runs: number[][] = [];
      let cur: number[] = [], miss = 0;
      for (const k of ks) {
        if (inR(k)) {
          if (cur.length && miss) for (let q = miss; q > 0; q--) cur.push(fwd ? k - q : k + q);
          cur.push(k);
          miss = 0;
        } else if (cur.length) {
          miss++;
          if (miss > gap) {
            runs.push(cur);
            cur = [];
            miss = 0;
          }
        }
      }
      if (cur.length) runs.push(cur);
      for (const r of runs) {
        const keep = simplify(r.map(pos), r.map(zAt), 0.002);
        const pts: number[] = [];
        for (const q of keep) {
          const k = r[q];
          if (along === 'x') pts.push(pos(k), s, zAt(k));
          else pts.push(s, pos(k), zAt(k));
        }
        const k0 = r[0], q = last ? last.length - 3 : 0;
        const near = last !== null && Math.hypot(pts[0] - last[q], pts[1] - last[q + 1]) <= 10;
        const p = Float32Array.from(pts);
        out.entry.push(Math.max(above[idx(k0, a)], above[idx(k0, b)]));
        out.link!.push(near ? hop(last![q], last![q + 1], pts[0], pts[1]) : NaN);
        out.paths.push(p);
        last = p;
      }
    }
  }
  return out;
}

// ---- cutout -------------------------------------------------------------------------------------

export interface CutoutOpts {
  tool: Cutter;
  widthMm: number;
  heightMm: number;
  stockTop: number;
  stepdown: number;
  /** how far below the part bottom to cut (mm), to cut cleanly through */
  through: number;
  /** holding tabs per side (0 = none), their length and height above the part bottom (mm) */
  tabs: number;
  tabWidth: number;
  tabHeight: number;
  /** climb: clockwise around the part (seen from above, spindle turning clockwise) */
  climb: boolean;
  /** front-left corner of the outline's box (default 0, 0) and its corner radius (default 0) */
  x0?: number;
  y0?: number;
  corner?: number;
  /**
   * any other convex outline: the tool-centre loop, counter-clockwise (the outline offset by the
   * tool radius); tabs are then spread evenly, `tabs` per quarter of the way round
   */
  loop?: [number, number][];
}

/**
 * Profile around the outside of the part, tool centre offset by its radius (round corners): one
 * continuous spiral going down at most `stepdown` per lap, so the tool never plunges, then a last
 * lap at the bottom. Over the tabs the tool stays at the tab height.
 */
export function cutoutPath(o: CutoutOpts): Path {
  const r = Math.max(0, o.tool.diameter / 2), W = o.widthMm, H = o.heightMm;
  const c = Math.max(0, Math.min(o.corner ?? 0, W / 2, H / 2)), R = c + r;
  // the outline as a polyline, clockwise from the bottom of the left side
  let loop: [number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
    for (let k = 0; k < n; k++) loop.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  };
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    if (R < 1e-6) return;
    const n = Math.max(12, Math.ceil((R * Math.PI) / 2 / 0.5));
    for (let k = 0; k < n; k++) {
      const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
      loop.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
  };
  // straight sides as [start index, end index] for the tabs
  const sides: [number, number][] = [];
  const side = (x0: number, y0: number, x1: number, y1: number) => {
    const s = loop.length;
    line(x0, y0, x1, y1);
    sides.push([s, loop.length]);
  };
  if (o.loop) {
    // clockwise, starting and ending at the first point
    loop = [...o.loop].reverse();
    loop.push(loop[0]);
  } else {
    side(-r, c, -r, H - c);
    arc(c, H - c, 180, 90);
    side(c, H + r, W - c, H + r);
    arc(W - c, H - c, 90, 0);
    side(W + r, H - c, W + r, c);
    arc(W - c, c, 0, -90);
    side(W - c, -r, c, -r);
    arc(c, c, -90, -180);
    loop.push([-r, c]);
    for (const q of loop) {
      q[0] += o.x0 ?? 0;
      q[1] += o.y0 ?? 0;
    }
  }
  // arc length along the loop
  const arcLen = () => {
    const a = [0];
    for (let k = 1; k < loop.length; k++) a.push(a[k - 1] + Math.hypot(loop[k][0] - loop[k - 1][0], loop[k][1] - loop[k - 1][1]));
    return a;
  };
  let u = arcLen();
  const P = u[u.length - 1];
  // tab intervals along the loop (centred on each side, long enough to clear the tool)
  const tabs: [number, number][] = [];
  const ranges: [number, number][] = o.loop ? [0, 1, 2, 3].map((k) => [(P * k) / 4, (P * (k + 1)) / 4]) : sides.map(([s, e]) => [u[s], u[Math.min(e, loop.length - 1)]]);
  if (o.tabs > 0)
    for (const [ra, rb] of ranges) {
      let ua = ra, ub = rb;
      // conventional: the same loop run backwards
      if (!o.climb) [ua, ub] = [P - ub, P - ua];
      for (let k = 0; k < o.tabs; k++) {
        const c = ua + ((ub - ua) * (k + 0.5)) / o.tabs, h = (o.tabWidth + 2 * r) / 2;
        tabs.push([c - h, c + h]);
      }
    }
  if (!o.climb) {
    loop.reverse();
    u = arcLen();
  }
  const bottom = -Math.max(0, o.through);
  const tabTop = Math.min(o.stockTop, Math.max(bottom, o.tabHeight));
  const laps = Math.max(1, Math.ceil((o.stockTop - bottom) / Math.max(0.05, o.stepdown) - 1e-6));
  const pts: number[] = [];
  const at = (s: number): [number, number] => {
    let k = 1;
    while (k < u.length - 1 && u[k] < s) k++;
    const w = (s - u[k - 1]) / (u[k] - u[k - 1] || 1);
    return [loop[k - 1][0] + (loop[k][0] - loop[k - 1][0]) * w, loop[k - 1][1] + (loop[k][1] - loop[k - 1][1]) * w];
  };
  for (let lap = 0; lap <= laps; lap++) {
    const zAt = (s: number) => (lap === laps ? bottom : o.stockTop - ((o.stockTop - bottom) * (lap + s / P)) / laps);
    const inTab = (s: number) => tabs.some(([a, b]) => s > a + 1e-6 && s < b - 1e-6);
    const marks = new Set<number>(u.slice(lap === 0 ? 0 : 1));
    for (const [a, b] of tabs) marks.add(a).add(b);
    for (const s of [...marks].sort((x, y) => x - y)) {
      const [x, y] = at(s);
      const zl = zAt(s), zt = Math.max(zl, tabTop);
      const enter = tabs.some(([a]) => Math.abs(s - a) < 1e-6), leave = tabs.some(([, b]) => Math.abs(s - b) < 1e-6);
      if (enter) pts.push(x, y, zl, x, y, zt);
      else if (leave) pts.push(x, y, zt, x, y, zl);
      else pts.push(x, y, inTab(s) ? zt : zl);
    }
  }
  return Float32Array.from(pts);
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

/** what the machine can do: spindle speed range (rpm) and the fastest feed it cuts well at (mm/min) */
export interface Machine {
  minRpm: number;
  maxRpm: number;
  maxFeed: number;
}

/** effective cutting diameter for chip-load purposes (a sharp V-bit still cuts with its flanks) */
const cutDiameter = (tool: Cutter) => Math.max(tool.diameter, tool.type === 'vbit' || tool.type === 'taperedBall' ? 1.5 : 0.3);

/**
 * Conservative starting speeds and feeds for a router spindle (18 000 rpm, plastic 16 000, within
 * the machine's speed range). The finishing pass of a ball / tapered tool cuts with less than its
 * full diameter, so it uses 75 % of the chip load. When the feed for that chip load is more than
 * the machine does (or 4 000 mm/min for finishing, for accuracy), the spindle is slowed instead
 * (down to its lowest speed) so the tool still takes a proper chip instead of rubbing and burning.
 * Stepover: roughing 40 % of Ø (30 % in aluminium); finishing see stepoverFor.
 */
export function recommend(material: Material, tool: Cutter, flutes: number, op: 'rough' | 'finish', mach: Machine = { minRpm: 10000, maxRpm: 24000, maxFeed: 5000 }): Recommendation {
  const d = cutDiameter(tool);
  const chip = chipLoad(material, d) * (op === 'finish' && tool.type !== 'flat' ? 0.75 : 1);
  const z = Math.max(1, flutes);
  const cap = op === 'finish' ? Math.min(mach.maxFeed, 4000) : mach.maxFeed;
  const base = Math.min(mach.maxRpm, Math.max(mach.minRpm, material === 'plastic' ? 16000 : 18000));
  const rpm = Math.round(Math.min(base, Math.max(mach.minRpm, cap / (z * chip))) / 100) * 100;
  const feed = Math.round(Math.min(cap, Math.max(100, rpm * z * chip)) / 10) * 10;
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
 * Chip load the settings give compared with the chart (1 = on the chart): below ~0.5 the tool rubs
 * and burns the wood and dulls, above ~1.5 it risks breaking a small cutter.
 */
export function chipRatio(material: Material, tool: Cutter, flutes: number, rpm: number, feed: number, op: 'rough' | 'finish'): { actual: number; chart: number; ratio: number } {
  const chart = chipLoad(material, cutDiameter(tool)) * (op === 'finish' && tool.type !== 'flat' ? 0.75 : 1);
  const actual = feed / Math.max(1, rpm) / Math.max(1, flutes);
  return { actual, chart, ratio: actual / chart };
}

/**
 * Recommended finishing stepover: 10 % of the ball / tip Ø (fine finish in wood, ~0.006 mm
 * scallop) for ball and tapered tools, but never finer than what leaves a 0.004 mm ridge (tiny
 * tips would otherwise take forever for nothing you can see); for a V-bit or engraver the stepover
 * that leaves a 0.02 mm ridge; 25 % of Ø for a flat end mill.
 */
export function stepoverFor(tool: Cutter): number {
  const r = tool.diameter / 2;
  let s: number;
  if (tool.type === 'ball' || tool.type === 'taperedBall') s = Math.max(0.1 * tool.diameter, 2 * Math.sqrt(Math.max(0, 2 * r * 0.004 - 0.004 ** 2)));
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
  /** safe height above the top of the stock (mm) */
  safeZ: number;
  /** Z0 at the top of the stock or at the part bottom (the bed / spoilboard) */
  zZero: 'top' | 'bottom';
  /** height of the stock top above the part bottom (mm) */
  stockTop: number;
  /** description lines for the header */
  notes?: string[];
  /** ramp-in angle (degrees) at the start of each cut; 0 = straight plunge */
  rampAngle?: number;
  /** seconds to wait after starting the spindle (G4), 0 = none */
  spindleDelay?: number;
  /** between tools in one file: T# M6 (Mach3/4, LinuxCNC, UCCNC, gSender, UGS) or an M0 pause */
  toolChange?: 'm6' | 'm0';
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
  /** run time of each operation (s) */
  ops: { name: string; seconds: number }[];
}

/** clearance above the material where rapids down stop (mm) */
const CLEAR = 1;

/**
 * G-code for one or more operations. Absolute coordinates, units per mm/inch choice, feed per
 * minute. Rapids across only at the safe height; each cut starts with a rapid down to 1 mm above
 * the material, then a ramp (back and forth along the start of the cut) or a plunge. Several
 * operations in one file get a tool change between different tools.
 */
export function writeGcode(input: Toolpath | Toolpath[], o: GcodeOpts): GcodeResult {
  const ops = Array.isArray(input) ? input : [input];
  const k = o.units === 'in' ? 1 / 25.4 : 1;
  const dec = o.units === 'in' ? 4 : 3;
  const zOff = o.zZero === 'top' ? o.stockTop : 0;
  const n = (v: number) => {
    const s = (v * k).toFixed(dec).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const nf = (v: number) => (v * k).toFixed(1).replace(/\.0$/, '');
  const fmtLen = (mm: number) => (o.units === 'in' ? `${n(mm)} in` : `${n(mm)} mm`);
  const multi = ops.length > 1;
  const L: string[] = [];
  const safe = o.stockTop + o.safeZ;
  L.push(`(Relief Generator - ${ops.map((t) => t.name).join(', ')})`);
  for (const t of ops) L.push(`(${multi ? `T${t.number} ` : ''}${t.name}: ${toolLabel(t.tool, fmtLen)}, ${t.rpm} rpm, feed ${nf(t.feed)}, plunge ${nf(t.plunge)} ${o.units}/min)`);
  L.push(`(Zero: X0 Y0 = front-left corner of the stock, Z0 = ${o.zZero === 'top' ? 'top of the stock' : 'bottom of the part (spoilboard)'})`);
  L.push(`(Stock top ${fmtLen(o.stockTop)} above the part bottom)`);
  for (const s of o.notes ?? []) L.push(`(${s.replace(/[()]/g, '')})`);
  L.push('G90 G94 G17');
  L.push(o.units === 'in' ? 'G20' : 'G21');
  L.push(`G0 Z${n(safe - zOff)}`);
  let cur = { x: 0, y: 0, z: safe };
  let mode = '';
  let feed = -1;
  let cutLen = 0, plungeLen = 0, rapidLen = 0, time = 0;
  let tp = ops[0];
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
    if (g === 'G0') {
      rapidLen += d;
      time += d / 5000;
    } else {
      if (f === tp.plunge) plungeLen += d;
      else cutLen += d;
      time += d / (f ?? tp.feed);
    }
    mode = g;
    L.push(parts.join(' '));
    cur = { x, y, z };
  };
  const tanA = Math.tan((Math.min(45, Math.max(0, o.rampAngle ?? 0)) * Math.PI) / 180);

  /** goes down from the current height to the start of path p, ramping along it when it can */
  const enter = (p: Path, zr: number) => {
    const z0 = p[2], drop = zr - z0;
    if (drop <= 1e-6) return;
    const maxLen = Math.min(20, Math.max(3, 3 * tp.tool.diameter));
    // the start of the path, up to maxLen along it: [x, y, z, s]
    const pts: number[][] = [[p[0], p[1], p[2], 0]];
    for (let i = 3; i < p.length && pts[pts.length - 1][3] < maxLen; i += 3) {
      const q = pts[pts.length - 1];
      const d = Math.hypot(p[i] - q[0], p[i + 1] - q[1]);
      if (d < 1e-9) continue;
      if (q[3] + d <= maxLen) pts.push([p[i], p[i + 1], p[i + 2], q[3] + d]);
      else {
        const w = (maxLen - q[3]) / d;
        pts.push([q[0] + (p[i] - q[0]) * w, q[1] + (p[i + 1] - q[1]) * w, q[2] + (p[i + 2] - q[2]) * w, maxLen]);
      }
    }
    const R = pts[pts.length - 1][3];
    const pairs = tanA > 0 && R >= 1 ? Math.ceil(drop / (2 * R * tanA) - 1e-9) : Infinity;
    if (drop <= CLEAR + 1e-6 || pairs > 40) {
      move('G1', p[0], p[1], z0, tp.plunge);
      return;
    }
    // back and forth along the start of the path, going down evenly, never below the path itself
    const slope = drop / (2 * pairs * R);
    let travelled = 0, sPrev = 0;
    for (let q = 0; q < pairs; q++)
      for (const leg of [pts.slice(1), pts.slice(0, -1).reverse()])
        for (const pt of leg) {
          travelled += Math.abs(pt[3] - sPrev);
          sPrev = pt[3];
          move('G1', pt[0], pt[1], Math.max(pt[2], zr - slope * travelled), tp.feed);
        }
    move('G1', p[0], p[1], z0, tp.feed);
  };

  const opTimes: { name: string; seconds: number }[] = [];
  ops.forEach((t, oi) => {
    const t0 = time;
    const prevTool = oi > 0 ? ops[oi - 1] : null;
    tp = t;
    if (!prevTool || prevTool.number !== t.number) {
      if (prevTool) {
        move('G0', cur.x, cur.y, safe);
        L.push('M5');
        mode = '';
      }
      if (multi) {
        L.push(`(${prevTool ? 'TOOL CHANGE: ' : ''}T${t.number} = ${toolLabel(t.tool, fmtLen)}${prevTool ? ' - change the tool, set Z0 again, then continue' : ''})`);
        if (o.toolChange === 'm0' && prevTool) L.push('M0');
        else if (o.toolChange !== 'm0') L.push(`T${t.number} M6`);
      }
      L.push(`M3 S${Math.round(t.rpm)}`);
      if ((o.spindleDelay ?? 0) > 0) {
        L.push(`G4 P${o.spindleDelay}`);
        time += o.spindleDelay! / 60;
      }
    } else if (prevTool.rpm !== t.rpm) L.push(`S${Math.round(t.rpm)}`);
    if (multi) L.push(`(${t.name})`);
    if (oi === 0) {
      // the first move of the file goes up before going across
      L.push('G0 X0 Y0');
      mode = 'G0';
      cur = { ...cur, x: 0, y: 0 };
    }
    t.paths.forEach((p, pi) => {
      if (p.length < 3) return;
      const entry = t.entry?.[pi] ?? o.stockTop;
      const link = pi > 0 ? (t.link?.[pi] ?? NaN) : NaN;
      if (link < safe) {
        // a short hop just over the material instead of going up to the safe height
        const h = Math.max(cur.z, link);
        move('G0', cur.x, cur.y, h);
        move('G0', p[0], p[1], h);
        // rapid down to just over the material, then feed in
        move('G0', p[0], p[1], Math.min(h, Math.max(p[2], entry + 0.05)));
        move('G1', p[0], p[1], p[2], t.plunge);
      } else {
        move('G0', cur.x, cur.y, safe);
        move('G0', p[0], p[1], safe);
        // rapid down to just above the material, then ramp or plunge in
        const zr = Math.min(safe, Math.max(p[2], entry + CLEAR));
        move('G0', p[0], p[1], zr);
        enter(p, zr);
      }
      for (let i = 3; i < p.length; i += 3) {
        // a move that goes down steeply is a plunge
        const dz = cur.z - p[i + 2], dxy = Math.hypot(p[i] - cur.x, p[i + 1] - cur.y);
        move('G1', p[i], p[i + 1], p[i + 2], dz > 0.5 && dz > 2 * dxy ? t.plunge : t.feed);
      }
    });
    opTimes.push({ name: t.name, seconds: (time - t0) * 60 });
  });
  move('G0', cur.x, cur.y, safe);
  L.push('M5');
  mode = '';
  move('G0', 0, 0, safe);
  L.push('M30');
  return { text: L.join('\n') + '\n', seconds: time * 60, cutLength: cutLen, lines: L.length, ops: opTimes };
}

/** line-segment vertex list (x, y, z pairs) of the toolpaths for the 3D preview, links included */
export function previewSegments(paths: Path[], safe: number, maxSegs = 400_000, link?: number[]): Float32Array {
  let total = 0;
  for (const p of paths) total += p.length / 3 + 2;
  const step = Math.max(1, Math.ceil(total / maxSegs));
  const out: number[] = [];
  let last: [number, number, number] | null = null;
  const seg = (a: [number, number, number], b: [number, number, number]) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  paths.forEach((p, pi) => {
    if (p.length < 3) return;
    const first: [number, number, number] = [p[0], p[1], p[2]];
    if (last) {
      const h = link && link[pi] < safe ? Math.max(link[pi], last[2]) : safe;
      seg(last, [last[0], last[1], h]);
      seg([last[0], last[1], h], [first[0], first[1], h]);
      seg([first[0], first[1], h], first);
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
  });
  return Float32Array.from(out);
}
