import { Grid, makeGrid, mapGrid, normalizeRobust, resizeBilinear } from './grid';
import { gaussianBlur, guidedFilter, maskedGaussian, pushPullFill } from './filters';
import { insideDistance, openMask, smoothstep } from './distance';
import { forwardGradients, solveScreenedPoisson } from './poisson';
import type { ReliefParams } from './params';

/** Raw model outputs plus the photo, as produced by the model stage. */
export interface RawInputs {
  /** photo luminance 0..1 at working resolution (this sets the working size) */
  luminance: Grid;
  /** relative inverse depth (disparity, larger = closer) at model resolution */
  depth: Grid;
  /** subject alpha 0..1 at model resolution; null = whole image is subject */
  mask: Grid | null;
}

/** Inputs upsampled to working resolution. Depends only on guideEps. */
export interface Prepared {
  w: number;
  h: number;
  luminance: Grid;
  /** disparity normalised to 0..1 (1 = closest) */
  depth: Grid;
  /** soft mask 0..1 */
  mask: Grid;
  guideEps: number;
}

/**
 * Edge-aware upsampling: bilinear to working res, then a guided filter using
 * the full-res photo luminance as guide so depth edges snap to image edges.
 */
export function guidedUpsample(low: Grid, guide: Grid, eps: number): Grid {
  const up = resizeBilinear(low, guide.w, guide.h);
  const scale = guide.w / low.w;
  const r = Math.max(2, Math.round(scale * 1.5));
  return guidedFilter(guide, up, r, eps);
}

export function prepare(raw: RawInputs, guideEps: number): Prepared {
  const { luminance } = raw;
  const w = luminance.w;
  const h = luminance.h;
  // normalise raw depth first so eps is scale-independent
  const d01 = normalizeRobust(raw.depth, 0.001, 0.999);
  const depth = guidedUpsample(d01, luminance, guideEps);
  let mask: Grid;
  if (raw.mask) {
    const m = guidedUpsample(raw.mask, luminance, 1e-4);
    mask = mapGrid(m, (v) => Math.min(1, Math.max(0, v)));
  } else {
    mask = makeGrid(w, h, 1);
  }
  return { w, h, luminance, depth, mask, guideEps };
}

export interface ReliefResult {
  /** normalised relief height 0..1 at working resolution (before invert/base/mm scaling) */
  height: Grid;
  /** binary subject domain used */
  domain: Grid;
  /** diagnostic: solver iterations for the gradient method */
  iterations?: number;
}

/** Fill pixels outside the domain with a smooth extrapolation of the inside values (no step at the edge). */
function fillOutside(g: Grid, domain: Grid): Grid {
  return pushPullFill(g, domain);
}

function highPass(g: Grid, sigma: number): Grid {
  const lp = gaussianBlur(g, sigma);
  return mapGrid(g, (v, i) => v - lp.data[i]);
}

/** v1: split into an edge-preserving base and a detail layer, squash the base, boost the detail. */
export function compressBaseDetail(D: Grid, domain: Grid, p: ReliefParams): Grid {
  const diag = Math.hypot(D.w, D.h);
  const r = Math.max(2, Math.round(p.baseScale * diag));
  const filled = fillOutside(D, domain);
  const base = guidedFilter(filled, filled, r, 0.002);
  const bNorm = normalizeRobust(base, 0.005, 0.995, domain.data);
  const keep = 1 - Math.min(1, Math.max(0, p.compression));
  const out = makeGrid(D.w, D.h);
  for (let i = 0; i < out.data.length; i++) {
    const b = Math.pow(bNorm.data[i], p.baseGamma);
    const detail = filled.data[i] - base.data[i];
    out.data[i] = keep * b + p.detailGain * detail;
  }
  return out;
}

/** Attenuated gradient field for one pyramid level (output in D units per pixel). */
function attenuatedGradients(D: Grid, dom: Grid, p: ReliefParams): { gx: Grid; gy: Grid } {
  const { w, h } = D;
  const diag = Math.hypot(w, h);
  const { gx, gy } = forwardGradients(D);
  const alpha = Math.pow(10, 1 - 2 * Math.min(1, Math.max(0, p.compression)));
  const thr = p.gradThreshold;
  const atten = (g: number) => {
    const a = Math.abs(g) * diag;
    if (a > thr) return 0; // depth discontinuity
    return (Math.sign(g) * alpha * Math.log(1 + a / alpha)) / diag;
  };
  const d = dom.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // zero gradients that cross the mask boundary
      const gxOk = x + 1 < w && d[i] >= 0.5 && d[i + 1] >= 0.5;
      const gyOk = y + 1 < h && d[i] >= 0.5 && d[i + w] >= 0.5;
      gx.data[i] = gxOk ? atten(gx.data[i]) : 0;
      gy.data[i] = gyOk ? atten(gy.data[i]) : 0;
    }
  }
  return { gx, gy };
}

function downsample2(g: Grid, binary: boolean): Grid {
  const w2 = Math.max(2, Math.round(g.w / 2));
  const h2 = Math.max(2, Math.round(g.h / 2));
  const r = resizeBilinear(binary ? g : gaussianBlur(g, 0.8), w2, h2);
  return binary ? mapGrid(r, (v) => (v >= 0.5 ? 1 : 0)) : r;
}

/**
 * v2: gradient-domain compression (Weyrich et al. 2007 style): zero gradients
 * at depth discontinuities and the mask boundary, attenuate the rest with
 * g' = sign(g)·α·log(1+|g|/α), then reconstruct with a screened Poisson solve.
 * Solved coarse-to-fine (each level warm-starts the next) for speed.
 */
export function compressGradient(D: Grid, domain: Grid, p: ReliefParams, keepBg: boolean): { u: Grid; iterations: number } {
  const maxSide = 1024;
  let D0 = D;
  let M0 = keepBg ? makeGrid(D.w, D.h, 1) : domain;
  while (Math.max(D0.w, D0.h) > maxSide) {
    D0 = downsample2(D0, false);
    M0 = downsample2(M0, true);
  }
  const pyr: { D: Grid; M: Grid }[] = [{ D: D0, M: M0 }];
  while (Math.max(pyr[pyr.length - 1].D.w, pyr[pyr.length - 1].D.h) > 96) {
    const t = pyr[pyr.length - 1];
    pyr.push({ D: downsample2(t.D, false), M: downsample2(t.M, true) });
  }
  let u: Grid | null = null;
  let iterations = 0;
  for (let l = pyr.length - 1; l >= 0; l--) {
    const { D: Dl, M: Ml } = pyr[l];
    const { gx, gy } = attenuatedGradients(Dl, Ml, p);
    const init: Grid | undefined = u ? resizeBilinear(u, Dl.w, Dl.h) : undefined;
    const coarsest = l === pyr.length - 1;
    const r = solveScreenedPoisson(gx, gy, Ml, { lambda: 1e-4, init, maxIter: coarsest ? 4000 : 250, tol: coarsest ? 1e-7 : 1e-5 });
    u = r.u;
    iterations += r.iterations;
  }
  let U = u!.w !== D.w ? resizeBilinear(u!, D.w, D.h) : u!;
  if (p.detailGain !== 1) {
    const r = Math.max(2, Math.round(p.baseScale * Math.hypot(D.w, D.h)));
    const sm = guidedFilter(U, U, r, 1e-4);
    U = mapGrid(U, (v, i) => v + (p.detailGain - 1) * (v - sm.data[i]));
  }
  return { u: U, iterations };
}

/**
 * Tone carving: signed map (-1..1) of how much darker (-) or lighter (+) each pixel is than its
 * surroundings inside the subject. Depth estimation cannot see painted features (a black pupil on a
 * white eye is the same distance away), so this lets strong tonal shapes be cut in or raised the way
 * a carver would. Uniform regions give flat-bottomed pockets with crisp rims; small tonal wobble
 * below the dead zone is ignored so gradients and noise do not become dents.
 */
export function toneMap(lum: Grid, domain: Grid, scale: number): Grid {
  const diag = Math.hypot(lum.w, lum.h);
  const local = maskedGaussian(lum, domain, Math.max(2, scale * diag));
  const d = mapGrid(lum, (v, i) => v - local.data[i]);
  // edge-preserving clean-up steered by the photo: keeps rims sharp, removes speckle
  const clean = guidedFilter(lum, d, 2, 1e-3);
  const dead = 0.06;
  const full = 0.35;
  return mapGrid(clean, (v, i) => {
    if (domain.data[i] < 0.5) return 0;
    const a = Math.abs(v);
    if (a <= dead) return 0;
    return Math.sign(v) * Math.min(1, (a - dead) / (full - dead));
  });
}

/** Full relief compression + edge falloff. Output 0..1 relief height at working resolution. */
export function computeRelief(prep: Prepared, p: ReliefParams): ReliefResult {
  const { w, h } = prep;
  const keepBg = p.bgMode === 'keep';
  const pxPerMm = w / p.widthMm;
  // soften ragged (fur) outlines a little before thresholding, then drop features thinner than the cutter
  const soft = p.maskCleanup > 0 ? gaussianBlur(prep.mask, Math.min(4, 0.5 * p.maskCleanup * pxPerMm)) : prep.mask;
  let domain = openMask(soft, p.maskCleanup * pxPerMm, p.maskThreshold);
  const count = (g: Grid) => g.data.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  if (count(domain) === 0) domain = openMask(prep.mask, 0, p.maskThreshold);
  if (count(domain) === 0) domain.data.fill(1);
  const workDomain = keepBg ? makeGrid(w, h, 1) : domain;

  const D = normalizeRobust(prep.depth, 0.005, 0.995, workDomain.data);
  let raw: Grid;
  let iterations: number | undefined;
  if (p.method === 'gradient') {
    const r = compressGradient(D, domain, p, keepBg);
    raw = r.u;
    iterations = r.iterations;
  } else {
    raw = compressBaseDetail(D, workDomain, p);
  }

  if (p.textureGain > 0) {
    const hp = highPass(prep.luminance, 1.5);
    raw = mapGrid(raw, (v, i) => v + p.textureGain * 0.1 * hp.data[i]);
  }

  const H = normalizeRobust(raw, 0.002, 0.998, workDomain.data);

  // tone carving (in mm, so it does not depend on the relief normalisation)
  if (p.toneDepth > 0 && p.reliefHeight > 0) {
    const t = toneMap(prep.luminance, domain, p.toneScale);
    const k = (p.toneDepth / p.reliefHeight) * (p.toneDarkUp ? -1 : 1);
    let max = 0;
    for (let i = 0; i < H.data.length; i++) {
      const v = Math.max(0, H.data[i] + k * t.data[i]);
      H.data[i] = v;
      if (v > max) max = v;
    }
    // keep the overall Z range exactly as requested
    if (max > 1) for (let i = 0; i < H.data.length; i++) H.data[i] /= max;
  }

  // edge falloff
  const fall = p.falloffWidth * pxPerMm;
  const dist = insideDistance(domain);
  for (let i = 0; i < H.data.length; i++) {
    const wgt = fall > 0.5 ? smoothstep(dist.data[i] / fall) : domain.data[i];
    H.data[i] *= keepBg ? p.bgLevel + (1 - p.bgLevel) * wgt : wgt;
  }
  return { height: H, domain, iterations };
}
