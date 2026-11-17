import { Grid, makeGrid } from './grid';

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher 2012). */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact Euclidean distance (in pixels) from every pixel to the nearest pixel
 * where `isSeed` is true. Pixels with no seed anywhere get a large value.
 */
export function distanceTransform(w: number, h: number, isSeed: (i: number) => boolean): Grid {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = isSeed(i) ? 0 : INF;
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  // rows
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  const out = makeGrid(w, h);
  for (let i = 0; i < w * h; i++) out.data[i] = Math.sqrt(g[i]);
  return out;
}

/**
 * Distance (px) from each inside-mask pixel to the mask boundary
 * (0 outside the mask). The image border is NOT treated as boundary, so a
 * subject cropped by the frame keeps its full height at the frame edge.
 */
export function insideDistance(mask: Grid, threshold = 0.5): Grid {
  const { w, h, data } = mask;
  const dist = distanceTransform(w, h, (i) => data[i] < threshold);
  for (let i = 0; i < w * h; i++) if (data[i] < threshold) dist.data[i] = 0;
  return dist;
}

/**
 * Morphological opening of a binary mask with a disc of radius r (px):
 * removes parts thinner than ~2r (e.g. whiskers, stray hairs) that a cutter
 * of that radius could not reproduce anyway. Keeps everything else intact.
 */
export function openMask(mask: Grid, r: number, threshold = 0.5): Grid {
  if (r < 0.75) return { w: mask.w, h: mask.h, data: Float32Array.from(mask.data, (v) => (v >= threshold ? 1 : 0)) };
  const { w, h, data } = mask;
  // erode: inside pixels farther than r from the outside (frame is not outside)
  const dIn = distanceTransform(w, h, (i) => data[i] < threshold);
  // dilate the eroded set by r
  const dEr = distanceTransform(w, h, (i) => dIn.data[i] > r);
  const out = makeGrid(w, h);
  for (let i = 0; i < w * h; i++) out.data[i] = data[i] >= threshold && dEr.data[i] <= r + 0.5 ? 1 : 0;
  return out;
}

export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
