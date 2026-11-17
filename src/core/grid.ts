/**
 * Minimal 2D float grid used throughout the pipeline.
 * Row-major, row 0 = top of the image (image convention) unless noted.
 */
export interface Grid {
  w: number;
  h: number;
  data: Float32Array;
}

export function makeGrid(w: number, h: number, fill = 0): Grid {
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { w, h, data };
}

export function cloneGrid(g: Grid): Grid {
  return { w: g.w, h: g.h, data: new Float32Array(g.data) };
}

export function mapGrid(g: Grid, f: (v: number, i: number) => number): Grid {
  const out = makeGrid(g.w, g.h);
  for (let i = 0; i < g.data.length; i++) out.data[i] = f(g.data[i], i);
  return out;
}

/** Bilinear sample at continuous pixel coords where (0,0) is the centre of the top-left pixel. */
export function sampleBilinear(g: Grid, x: number, y: number): number {
  const { w, h, data } = g;
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Bilinear resize (pixel-centre aligned). When shrinking, call a blur first
 * (see resizeArea) to avoid aliasing.
 */
export function resizeBilinear(g: Grid, w2: number, h2: number): Grid {
  const out = makeGrid(w2, h2);
  const sx = g.w / w2;
  const sy = g.h / h2;
  for (let y = 0; y < h2; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < w2; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      out.data[y * w2 + x] = sampleBilinear(g, fx, fy);
    }
  }
  return out;
}

/** Percentile of values (optionally only where weight > 0.5). p in [0,1]. */
export function percentile(values: Float32Array, p: number, weight?: Float32Array): number {
  let arr: Float32Array;
  if (weight) {
    let n = 0;
    for (let i = 0; i < values.length; i++) if (weight[i] > 0.5) n++;
    if (n === 0) return 0;
    arr = new Float32Array(n);
    n = 0;
    for (let i = 0; i < values.length; i++) if (weight[i] > 0.5) arr[n++] = values[i];
  } else {
    arr = new Float32Array(values);
  }
  arr.sort();
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
  return arr[idx];
}

/** Robustly normalise to [0,1] using the given percentiles (computed inside `weight` if given). */
export function normalizeRobust(g: Grid, lo = 0.01, hi = 0.99, weight?: Float32Array): Grid {
  const a = percentile(g.data, lo, weight);
  const b = percentile(g.data, hi, weight);
  const span = b - a || 1;
  return mapGrid(g, (v) => Math.min(1, Math.max(0, (v - a) / span)));
}

export function minMax(data: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}
