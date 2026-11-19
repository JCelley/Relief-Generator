import type { MachGrid } from './resample';

export type ToolType = 'ball' | 'taperedBall' | 'vbit';

export interface Cutter {
  type: ToolType;
  /** ball: ball Ø; tapered ball: tip ball Ø; V-bit / engraver: flat tip Ø (0 = sharp) — mm */
  diameter: number;
  /** included angle in degrees (tapered ball, V-bit); ignored for a ball end mill */
  angle: number;
}

export interface CutResult {
  /** surface the tool leaves behind (≥ the design surface everywhere) */
  cut: Float32Array;
  /** material left where the tool cannot reach (cut − design), mm */
  left: Float32Array;
  /** fraction of grid points with more than 0.05 mm left */
  missedFrac: number;
  maxLeft: number;
}

/**
 * Simulates a 3-axis finishing pass with the given cutter over the whole surface (no stepover
 * scallops): the result is the morphological closing of the design surface by the tool shape.
 * Tip height at q:  t(q) = max_p ( z(p) − prof(|p−q|) )   (the tool rests on the surface)
 * Cut surface:      c(p) = min_q ( t(q) + prof(|p−q|) )
 * The tool shape is split into a small part (sphere / flat disk, done exactly on a small kernel)
 * and a cone (done with a two-pass chamfer propagation, ~2 % distance error), which is valid
 * because a tapered ball = sphere ⊕ cone and a flat-tipped engraver = disk ⊕ cone.
 */
export function simulateCut(g: MachGrid, tool: Cutter): CutResult {
  const { nx, ny, dx, dy, z } = g;
  const r = Math.max(0, tool.diameter / 2);
  const half = (Math.min(179, Math.max(1, tool.angle)) / 2) * (Math.PI / 180);
  // cone slope (height per mm of radius); the ball end mill has a straight shank (no cone)
  const slope = tool.type === 'ball' ? 0 : 1 / Math.tan(half);

  // small part of the tool: height above the tip at offset (di, dj); Infinity = not part of it
  const offs: { di: number; dj: number; h: number }[] = [];
  if (r > 0) {
    const ri = Math.ceil(r / dx), rj = Math.ceil(r / dy);
    for (let dj = -rj; dj <= rj; dj++)
      for (let di = -ri; di <= ri; di++) {
        const d = Math.hypot(di * dx, dj * dy);
        if (d > r + 1e-9) continue;
        // sphere for ball / tapered ball, flat disk for an engraver
        offs.push({ di, dj, h: tool.type === 'vbit' ? 0 : r - Math.sqrt(Math.max(0, r * r - d * d)) });
      }
  }

  const n = nx * ny;
  let t: Float32Array = new Float32Array(z);
  // dilation (tip height): small part, then cone
  if (offs.length > 1) t = applyKernel(t, nx, ny, offs, +1);
  if (slope > 0) propagate(t, nx, ny, dx, dy, slope, +1);
  // erosion back down with the same tool (cone, then small part)
  let c: Float32Array = t;
  if (slope > 0) propagate(c, nx, ny, dx, dy, slope, -1);
  if (offs.length > 1) c = applyKernel(c, nx, ny, offs, -1);

  const left = new Float32Array(n);
  let missed = 0, maxLeft = 0;
  for (let k = 0; k < n; k++) {
    const v = Math.max(0, c[k] - z[k]);
    c[k] = z[k] + v;
    left[k] = v;
    if (v > 0.05) missed++;
    if (v > maxLeft) maxLeft = v;
  }
  return { cut: c, left, missedFrac: missed / n, maxLeft };
}

/** sign +1: out(p) = max_o (in(p+o) − h_o)  (dilation); −1: out(p) = min_o (in(p+o) + h_o) */
function applyKernel(src: Float32Array, nx: number, ny: number, offs: { di: number; dj: number; h: number }[], sign: 1 | -1): Float32Array {
  const out = new Float32Array(src.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let best = sign > 0 ? -Infinity : Infinity;
      for (const o of offs) {
        const ii = i + o.di, jj = j + o.dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const v = src[jj * nx + ii];
        if (sign > 0) {
          const w = v - o.h;
          if (w > best) best = w;
        } else {
          const w = v + o.h;
          if (w < best) best = w;
        }
      }
      out[j * nx + i] = best;
    }
  return out;
}

/**
 * In-place cone dilation (sign +1: a(p) = max_q a(q) − s·|p−q|) or erosion (sign −1:
 * a(p) = min_q a(q) + s·|p−q|) with a 5×5 chamfer mask, forward then backward pass.
 */
function propagate(a: Float32Array, nx: number, ny: number, dx: number, dy: number, s: number, sign: 1 | -1) {
  // half of the 16-neighbourhood visited by a raster-order forward pass
  const fwd: [number, number][] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [-2, -1], [-1, -2], [1, -2], [2, -1]];
  const steps = fwd.map(([di, dj]) => ({ di, dj, w: s * Math.hypot(di * dx, dj * dy) }));
  const relax = (i: number, j: number, flip: number) => {
    const k = j * nx + i;
    let v = a[k];
    for (const st of steps) {
      const ii = i + flip * st.di, jj = j + flip * st.dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const u = a[jj * nx + ii];
      if (sign > 0) {
        if (u - st.w > v) v = u - st.w;
      } else if (u + st.w < v) v = u + st.w;
    }
    a[k] = v;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) relax(i, j, 1);
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) relax(i, j, -1);
}

/** a cutter's profile height above its tip at radius d (mm), for tests and readouts */
export function toolProfile(tool: Cutter, d: number): number {
  const r = tool.diameter / 2;
  const half = ((tool.angle / 2) * Math.PI) / 180;
  if (tool.type === 'ball') return d <= r ? r - Math.sqrt(r * r - d * d) : Infinity;
  if (tool.type === 'vbit') return d <= r ? 0 : (d - r) / Math.tan(half);
  // tapered ball: sphere up to the tangent point, then the cone
  const rt = r * Math.cos(half);
  if (d <= rt) return r - Math.sqrt(r * r - d * d);
  const ht = r - r * Math.sin(half);
  return ht + (d - rt) / Math.tan(half);
}
