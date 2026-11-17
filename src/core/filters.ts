import { Grid, makeGrid } from './grid';

/** Mean over a (2r+1)^2 window, clamped at borders (divides by the true pixel count). O(N). */
export function boxMean(g: Grid, r: number): Grid {
  const { w, h, data } = g;
  r = Math.max(0, Math.round(r));
  if (r === 0) return { w, h, data: new Float32Array(data) };
  // integral image in float64 for accuracy
  const W = w + 1;
  const S = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row;
    }
  }
  const out = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
      out.data[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/**
 * Gaussian approximated by three successive box filters (Wells 1986); O(N)
 * regardless of sigma. Used for large sigma.
 */
function gaussianByBoxes(g: Grid, sigma: number): Grid {
  // box radii for 3 passes (Kovesi 2010)
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  let out = g;
  for (let i = 0; i < n; i++) out = boxMean(out, ((i < m ? wl : wu) - 1) / 2);
  return out;
}

/** Separable Gaussian blur with clamp-to-edge borders. sigma in pixels. */
export function gaussianBlur(g: Grid, sigma: number): Grid {
  const { w, h, data } = g;
  if (!(sigma > 0.05)) return { w, h, data: new Float32Array(data) };
  if (sigma > 6) return gaussianByBoxes(g, sigma);
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        s += k[i + r] * data[row + xx];
      }
      tmp[row + x] = s;
    }
  }
  const out = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        s += k[i + r] * tmp[yy * w + x];
      }
      out.data[y * w + x] = s;
    }
  }
  return out;
}

/**
 * Normalised (masked) Gaussian: blur(g*m)/blur(m). Values outside the mask
 * do not bleed in. Where the blurred mask is ~0 the original value is kept.
 */
export function maskedGaussian(g: Grid, mask: Grid, sigma: number): Grid {
  const gm = makeGrid(g.w, g.h);
  for (let i = 0; i < gm.data.length; i++) gm.data[i] = g.data[i] * mask.data[i];
  const a = gaussianBlur(gm, sigma);
  const b = gaussianBlur(mask, sigma);
  const out = makeGrid(g.w, g.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = b.data[i] > 1e-4 ? a.data[i] / b.data[i] : g.data[i];
  return out;
}

/**
 * Push–pull fill: values where weight ≥ 0.5 are kept, everything else is a
 * smooth extrapolation built from a weighted image pyramid. There is no step at
 * the boundary, so later smoothing creates no halo or rim there.
 */
export function pushPullFill(g: Grid, weight: Grid): Grid {
  const levels: { v: Float32Array; m: Float32Array; w: number; h: number }[] = [];
  let v = new Float32Array(g.w * g.h);
  let m = new Float32Array(g.w * g.h);
  for (let i = 0; i < v.length; i++) {
    m[i] = weight.data[i] >= 0.5 ? 1 : 0;
    v[i] = g.data[i] * m[i];
  }
  let w = g.w;
  let h = g.h;
  levels.push({ v, m, w, h });
  // pull (downsample premultiplied values and weights)
  while (w > 1 || h > 1) {
    const w2 = Math.max(1, Math.ceil(w / 2));
    const h2 = Math.max(1, Math.ceil(h / 2));
    const v2 = new Float32Array(w2 * h2);
    const m2 = new Float32Array(w2 * h2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y >> 1) * w2 + (x >> 1);
        v2[j] += v[y * w + x];
        m2[j] += m[y * w + x];
      }
    }
    // normalise weights to [0,1] (saturate) but keep premultiplied value consistent
    for (let j = 0; j < v2.length; j++) {
      if (m2[j] > 0) {
        const s = Math.min(1, m2[j]) / m2[j];
        v2[j] *= s;
        m2[j] = Math.min(1, m2[j]);
      }
    }
    v = v2;
    m = m2;
    w = w2;
    h = h2;
    levels.push({ v, m, w, h });
  }
  // push (fill each level from the coarser one)
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l];
    const C = levels[l + 1];
    const coarse = { w: C.w, h: C.h, data: new Float32Array(C.v.length) };
    for (let j = 0; j < C.v.length; j++) coarse.data[j] = C.m[j] > 0 ? C.v[j] / C.m[j] : 0;
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x;
        const a = L.m[i];
        if (a >= 1) continue;
        // bilinear sample of the coarser level
        const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), y0 = Math.floor(cy);
        const x1 = Math.min(C.w - 1, x0 + 1), y1 = Math.min(C.h - 1, y0 + 1);
        const fx = cx - x0, fy = cy - y0;
        const d = coarse.data;
        const cv =
          (d[y0 * C.w + x0] * (1 - fx) + d[y0 * C.w + x1] * fx) * (1 - fy) + (d[y1 * C.w + x0] * (1 - fx) + d[y1 * C.w + x1] * fx) * fy;
        L.v[i] = L.v[i] + (1 - a) * cv;
        L.m[i] = 1;
      }
    }
  }
  const out = makeGrid(g.w, g.h);
  const L0 = levels[0];
  for (let i = 0; i < out.data.length; i++) out.data[i] = weight.data[i] >= 0.5 ? g.data[i] : L0.v[i];
  return out;
}

/**
 * Guided filter (He, Sun, Tang 2010). Edge-preserving smoothing of `p`
 * steered by guide `I`. With I === p it is an edge-preserving self-smoother.
 */
export function guidedFilter(I: Grid, p: Grid, r: number, eps: number): Grid {
  const n = I.data.length;
  const Ip = makeGrid(I.w, I.h);
  const II = makeGrid(I.w, I.h);
  for (let i = 0; i < n; i++) {
    Ip.data[i] = I.data[i] * p.data[i];
    II.data[i] = I.data[i] * I.data[i];
  }
  const mI = boxMean(I, r);
  const mp = boxMean(p, r);
  const mIp = boxMean(Ip, r);
  const mII = boxMean(II, r);
  const a = makeGrid(I.w, I.h);
  const b = makeGrid(I.w, I.h);
  for (let i = 0; i < n; i++) {
    const cov = mIp.data[i] - mI.data[i] * mp.data[i];
    const v = mII.data[i] - mI.data[i] * mI.data[i];
    const ai = cov / (v + eps);
    a.data[i] = ai;
    b.data[i] = mp.data[i] - ai * mI.data[i];
  }
  const ma = boxMean(a, r);
  const mb = boxMean(b, r);
  const out = makeGrid(I.w, I.h);
  for (let i = 0; i < n; i++) out.data[i] = ma.data[i] * I.data[i] + mb.data[i];
  return out;
}
