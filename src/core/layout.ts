/**
 * Stock and layout for a CNC relief: the board size, where the picture sits on it, the plaque
 * outline (rectangle, rounded, oval, arch) and a border from a library of moulding profiles and
 * carved patterns. All lengths in mm, CAD orientation (x right, y up, origin at the front-left
 * corner of the stock).
 */
import type { ReliefParams } from './params';

export type OutlineShape = 'rect' | 'rounded' | 'oval' | 'arch';
export type BorderStyle =
  | 'none'
  | 'flat'
  | 'bead'
  | 'cove'
  | 'bevel'
  | 'ogee'
  | 'beadCove'
  | 'stepped'
  | 'reeded'
  | 'vgroove'
  | 'rope'
  | 'pearls'
  | 'dentil'
  | 'scallop'
  | 'eggDart'
  | 'greekKey'
  | 'fluted';

/** [style, name, library group]; decorative patterns repeat along the border */
export const BORDER_STYLES: [BorderStyle, string, string][] = [
  ['none', 'None', ''],
  ['flat', 'Flat band', 'Basic'],
  ['bead', 'Bead (half-round)', 'Basic'],
  ['cove', 'Cove', 'Basic'],
  ['bevel', 'Bevel', 'Basic'],
  ['ogee', 'Ogee', 'Basic'],
  ['beadCove', 'Bead & cove (picture frame)', 'Basic'],
  ['stepped', 'Stepped', 'Basic'],
  ['reeded', 'Reeded (3 beads)', 'Basic'],
  ['vgroove', 'Flat with V-groove', 'Basic'],
  ['rope', 'Rope', 'Decorative'],
  ['pearls', 'Pearls (bead string)', 'Decorative'],
  ['dentil', 'Dentil blocks', 'Decorative'],
  ['scallop', 'Scalloped', 'Decorative'],
  ['eggDart', 'Egg & dart', 'Decorative'],
  ['greekKey', 'Greek key', 'Decorative'],
  ['fluted', 'Fluted', 'Decorative'],
];

/** pattern repeat as a multiple of the border width (when Pattern size is 0 = auto) */
const PITCH: Partial<Record<BorderStyle, number>> = { rope: 0.55, pearls: 1, dentil: 0.7, scallop: 1.2, eggDart: 1.1, greekKey: 0.8, fluted: 0.45 };
export const isPattern = (s: BorderStyle) => PITCH[s] !== undefined;

export interface Shape {
  kind: OutlineShape;
  cx: number;
  cy: number;
  /** half width / half height */
  a: number;
  b: number;
  /** corner radius (rounded) */
  c: number;
}

export interface Layout {
  /** false: plain picture, exactly the old behaviour (stock = picture, no border) */
  active: boolean;
  /** stock size */
  W: number;
  H: number;
  /** picture rectangle on the stock */
  pic: { x0: number; y0: number; w: number; h: number };
  /** plaque outline = outer edge of the border; the cutout follows it */
  outline: Shape;
  border: BorderStyle;
  /** border width and height */
  bw: number;
  bh: number;
  pitch: number;
  /** the picture fades out this far inside the outline (border width + gap) */
  window: number;
}

export function layoutActive(p: ReliefParams): boolean {
  return (
    p.mode === 'relief' &&
    (p.borderStyle !== 'none' || p.outlineShape !== 'rect' || p.stockW > 0 || p.stockH > 0 || p.picX !== 0 || p.picY !== 0 || p.borderInset > 0)
  );
}

/** stock, picture placement, outline and border for a picture of picW × picH mm */
export function resolveLayout(p: ReliefParams, picW: number, picH: number): Layout {
  const active = layoutActive(p);
  const border = active && p.borderStyle !== 'none';
  const inset = active ? Math.max(0, p.borderInset) : 0;
  const margin = border ? p.borderWidth + p.borderGap : 0;
  const W = active && p.stockW > 0 ? p.stockW : picW + 2 * (margin + inset);
  const H = active && p.stockH > 0 ? p.stockH : picH + 2 * (margin + inset);
  const ox = active ? p.picX : 0, oy = active ? p.picY : 0;
  const a = Math.max(0.5, W / 2 - inset), b = Math.max(0.5, H / 2 - inset);
  const kind = active ? p.outlineShape : 'rect';
  const outline: Shape = { kind, cx: W / 2, cy: H / 2, a, b, c: kind === 'rounded' ? Math.max(0, Math.min(p.outlineCorner, a, b)) : 0 };
  const inr = Math.min(a, b, kind === 'arch' ? archRise(a, b) : Infinity);
  const bw = border ? Math.max(0.5, Math.min(p.borderWidth, 0.45 * inr)) : 0;
  const pitch = p.borderPitch > 0 ? p.borderPitch : (PITCH[p.borderStyle] ?? 1) * bw;
  return {
    active,
    W,
    H,
    pic: { x0: W / 2 + ox - picW / 2, y0: H / 2 + oy - picH / 2, w: picW, h: picH },
    outline,
    border: border ? p.borderStyle : 'none',
    bw,
    bh: border ? Math.max(0, p.borderHeight) : 0,
    pitch: Math.max(0.5, pitch),
    window: border ? bw + Math.max(0, p.borderGap) : 0,
  };
}

// ---- signed distance to the outline (negative inside) -------------------------------------------

const archRise = (a: number, b: number) => Math.min(a, b);

function sdBox(px: number, py: number, a: number, b: number, c: number): number {
  const qx = Math.abs(px) - (a - c), qy = Math.abs(py) - (b - c);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - c;
}

/** distance to an ellipse (iterative closest point, exact to well under a micron) */
function sdEllipse(px: number, py: number, a: number, b: number): number {
  const x = Math.abs(px), y = Math.abs(py);
  let tx = Math.SQRT1_2, ty = Math.SQRT1_2;
  for (let k = 0; k < 4; k++) {
    const ex = ((a * a - b * b) * tx ** 3) / a, ey = ((b * b - a * a) * ty ** 3) / b;
    const r = Math.hypot(a * tx - ex, b * ty - ey);
    const qx = x - ex, qy = y - ey, q = Math.hypot(qx, qy) || 1e-12;
    tx = Math.min(1, Math.max(0, ((qx * r) / q + ex) / a));
    ty = Math.min(1, Math.max(0, ((qy * r) / q + ey) / b));
    const t = Math.hypot(tx, ty) || 1;
    tx /= t;
    ty /= t;
  }
  const d = Math.hypot(x - a * tx, y - b * ty);
  return (x * x) / (a * a) + (y * y) / (b * b) < 1 ? -d : d;
}

export function sdf(s: Shape, x: number, y: number): number {
  const px = x - s.cx, py = y - s.cy;
  if (s.kind === 'oval') return sdEllipse(px, py, s.a, s.b);
  if (s.kind === 'arch') {
    // straight sides up to the shoulder, then a circular arc through the top centre
    const rise = archRise(s.a, s.b), R = (s.a * s.a + rise * rise) / (2 * rise);
    const yS = s.b - rise, cyc = s.b - R;
    const dC = Math.hypot(px, py - cyc) - R;
    return Math.max(sdBox(px, py, s.a, s.b, 0), Math.min(py - yS, dC));
  }
  return sdBox(px, py, s.a, s.b, s.kind === 'rounded' ? s.c : 0);
}

/** point on the level set sdf = level along the ray from the centre at angle t */
function rayPoint(s: Shape, t: number, level: number): [number, number] {
  const dx = Math.cos(t), dy = Math.sin(t);
  let lo = 0, hi = Math.hypot(s.a, s.b) + Math.abs(level) + 1;
  for (let k = 0; k < 48; k++) {
    const m = (lo + hi) / 2;
    if (sdf(s, s.cx + m * dx, s.cy + m * dy) < level) lo = m;
    else hi = m;
  }
  const m = (lo + hi) / 2;
  return [s.cx + m * dx, s.cy + m * dy];
}

/**
 * The closed curve at distance `level` from the outline (positive = outside), counter-clockwise
 * from the bottom centre, refined until no chord is more than `tol` off the curve. Outside an
 * exact distance field the offset has round corners, as a tool of that radius goes round.
 */
export function outlineLoop(s: Shape, level: number, tol = 0.01): [number, number][] {
  const out: [number, number][] = [];
  const seg = (t0: number, p0: [number, number], t1: number, p1: [number, number], depth: number) => {
    const tm = (t0 + t1) / 2, pm = rayPoint(s, tm, level);
    const lx = p1[0] - p0[0], ly = p1[1] - p0[1], L = Math.hypot(lx, ly) || 1e-12;
    const dev = Math.abs((pm[0] - p0[0]) * ly - (pm[1] - p0[1]) * lx) / L;
    if ((dev > tol || L > 4) && depth < 14) {
      seg(t0, p0, tm, pm, depth + 1);
      seg(tm, pm, t1, p1, depth + 1);
    } else out.push(p0);
  };
  const n = 256, t0 = -Math.PI / 2;
  let prev = rayPoint(s, t0, level);
  for (let k = 0; k < n; k++) {
    const ta = t0 + (2 * Math.PI * k) / n, tb = t0 + (2 * Math.PI * (k + 1)) / n;
    const next = rayPoint(s, tb, level);
    seg(ta, prev, tb, next, 0);
    prev = next;
  }
  return out;
}

// ---- border profiles ------------------------------------------------------------------------------

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const round = (t: number) => Math.sqrt(Math.max(0, 1 - t * t)); // half-round, t in -1..1
const frac = (x: number) => x - Math.floor(x);

/** distance from (x, y) to the segment a–b */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x - ax - t * vx, y - ay - t * vy);
}

/** Greek key (running meander) centre line in cells: 4 cells along × 5 across per repeat */
const KEY: [number, number][] = [
  [-2, 4],
  [0, 4],
  [0, 0],
  [2, 0],
  [2, 4],
  [4, 4],
  [4, 0],
];

/**
 * Border height 0..1 at v across the band (0 = outer edge, 1 = inner edge) and f along one
 * pattern repeat (0..1); P = repeat length and W = band width in mm (for round shapes).
 */
export function borderProfile(style: BorderStyle, v: number, f: number, P: number, W: number): number {
  switch (style) {
    case 'flat':
      return 1 - ss(0.9, 1, v);
    case 'bead':
      return round(2 * v - 1);
    case 'cove':
      return v < 0.12 ? 1 : 1 - round(1 - (v - 0.12) / 0.88);
    case 'bevel':
      return v < 0.35 ? 1 : 1 - (v - 0.35) / 0.65;
    case 'ogee':
      return v < 0.15 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (v - 0.15)) / 0.85);
    case 'beadCove':
      return v < 0.3 ? 0.55 + 0.45 * round((v - 0.15) / 0.15) : 0.55 * (1 - round(1 - (v - 0.3) / 0.7));
    case 'stepped':
      return 1 - (ss(0.31, 0.35, v) + ss(0.64, 0.68, v)) / 3;
    case 'reeded':
      return 0.35 + 0.65 * round(2 * frac(v * 3) - 1);
    case 'vgroove':
      return (1 - ss(0.92, 1, v)) * (1 - 0.5 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.12));
    case 'rope': {
      // strands slanting at about 45° across a half-round
      const g = frac(f + (v - 0.5) * (W / P) * 0.9);
      return round(2 * v - 1) * (0.55 + 0.45 * round(2 * g - 1));
    }
    case 'pearls': {
      const R = 0.46 * Math.min(P, W);
      const r2 = (((f - 0.5) * P) ** 2 + ((v - 0.5) * W) ** 2) / (R * R);
      const line = v < 0.06 || v > 0.94 ? 0.3 : 0;
      return Math.max(line, r2 < 1 ? Math.sqrt(1 - r2) : 0);
    }
    case 'dentil': {
      const fillet = 1 - ss(0.22, 0.26, v);
      const block = ss(0.3, 0.34, v) * ss(0.18, 0.22, f) * (1 - ss(0.78, 0.82, f));
      return Math.max(fillet, 0.25 + 0.5 * block);
    }
    case 'scallop': {
      const lim = 0.45 + 0.5 * round(2 * f - 1);
      const e = lim - v;
      return e <= 0 ? 0 : e >= 0.12 ? 1 : round(1 - e / 0.12);
    }
    case 'eggDart': {
      const fillet = 1 - ss(0.1, 0.14, v);
      // egg in its cup
      // taller than wide, fuller toward the outside; the cup is open at the top into the fillet
      const ex = (f - 0.42) / 0.18, ey = (v - 0.55) / (v < 0.55 ? 0.36 : 0.3);
      const r = Math.hypot(ex, ey);
      const egg = r < 1 ? 0.9 * Math.sqrt(1 - r * r) : 0;
      const cup = 0.55 * Math.max(0, 1 - Math.abs(r - 1.28) / 0.13) * ss(0.2, 0.35, v);
      // dart: a ridge between the eggs tapering to a point toward the inside
      const df = Math.abs(f - 0.92) * P, hw = 0.07 * P * (1 - (v - 0.18) / 0.72);
      const dart = v > 0.18 && v < 0.9 && df < hw ? 0.75 * (1 - df / hw) : 0;
      return Math.max(fillet, egg, cup, dart);
    }
    case 'greekKey': {
      const cx = P / 4, cy = W / 5, x = f * P, y = v * W;
      let d = Infinity;
      for (let k = 0; k + 1 < KEY.length; k++)
        d = Math.min(d, segDist(x, y, (KEY[k][0] + 0.5) * cx, (KEY[k][1] + 0.5) * cy, (KEY[k + 1][0] + 0.5) * cx, (KEY[k + 1][1] + 0.5) * cy));
      const hw = 0.5 * Math.min(cx, cy);
      return d >= hw ? 0 : d < 0.6 * hw ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - 0.6 * hw)) / (0.4 * hw));
    }
    case 'fluted': {
      const t = (f - 0.15) / 0.7;
      const ch = t > 0 && t < 1 ? round(2 * t - 1) * round((v - 0.5) / 0.38) : 0;
      return (1 - ss(0.92, 1, v)) * (1 - 0.5 * ch);
    }
    default:
      return 0;
  }
}

/**
 * Position along the border in pattern repeats, for points in the band. Each repeat fits a whole
 * number of times: round the whole outline, or (rectangle) along each side with the pattern
 * mirrored at the mitred corners, like a carved frame.
 */
export function makeAlong(L: Layout): (x: number, y: number, d: number) => number {
  const s = L.outline, half = L.bw / 2, h = 0.02;
  const grad = (x: number, y: number) => {
    const gx = sdf(s, x + h, y) - sdf(s, x - h, y), gy = sdf(s, x, y + h) - sdf(s, x, y - h);
    const g = Math.hypot(gx, gy) || 1;
    return [gx / g, gy / g];
  };
  const fit = (len: number) => len / Math.max(1, Math.round(len / L.pitch));
  if (s.kind === 'rect') {
    const am = s.a - half, bm = s.b - half, px = fit(2 * am), py = fit(2 * bm);
    return (x, y) => {
      const [gx, gy] = grad(x, y);
      if (Math.abs(gx) > Math.abs(gy)) return gx > 0 ? (y - (s.cy - bm)) / py : (s.cy + bm - y) / py;
      return gy > 0 ? (s.cx + am - x) / px : (x - (s.cx - am)) / px;
    };
  }
  // the centre line of the band, sampled by angle, with its arc length
  const N = 2048, th = new Float64Array(N + 1), sl = new Float64Array(N + 1);
  let prev: [number, number] | null = null;
  for (let k = 0; k <= N; k++) {
    th[k] = -Math.PI + (2 * Math.PI * k) / N;
    const q = rayPoint(s, th[k], -half);
    sl[k] = prev ? sl[k - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]) : 0;
    prev = q;
  }
  const p = fit(sl[N]);
  return (x, y, d) => {
    // nearest point on the centre line, then its angle from the centre
    const [gx, gy] = grad(x, y);
    const qx = x - gx * (d + half), qy = y - gy * (d + half);
    const t = ((Math.atan2(qy - s.cy, qx - s.cx) + Math.PI) / (2 * Math.PI)) * N;
    const k = Math.min(N - 1, Math.max(0, Math.floor(t)));
    return (sl[k] + (sl[k + 1] - sl[k]) * (t - k)) / p;
  };
}
