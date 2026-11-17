import type { MachGrid } from './resample';

/**
 * Tensor-product B-spline surface approximating a regular heightfield grid.
 *
 * Because the samples sit on a regular grid, the least-squares problem
 *   min ‖Bu · P · Bvᵀ − Z‖²
 * separates into two banded 1-D solves (rows, then columns), which is exact
 * and far faster than a general scattered-point fit. x and y of the control
 * points are placed at the Greville abscissae, so x(u) and y(v) are exactly
 * linear: the surface is a true height field and each boundary curve lies in
 * the corresponding side plane (x = 0, x = W, y = 0, y = H).
 */
export interface BSplineSurface {
  degree: number;
  /** control point counts in u (x) and v (y) */
  nu: number;
  nv: number;
  /** full clamped knot vectors */
  knotsU: Float64Array;
  knotsV: Float64Array;
  /** control points, index (k*nv + m)*3 for u-index k, v-index m */
  ctrl: Float64Array;
  widthMm: number;
  heightMm: number;
  maxError: number;
  rmsError: number;
}

export const DEGREE = 3;

/** Clamped uniform knot vector for n control points of degree p (length n+p+1). */
export function clampedKnots(n: number, p = DEGREE): Float64Array {
  const m = n + p + 1;
  const k = new Float64Array(m);
  const inner = n - p; // number of spans
  for (let i = 0; i < m; i++) {
    if (i <= p) k[i] = 0;
    else if (i >= n) k[i] = 1;
    else k[i] = (i - p) / inner;
  }
  return k;
}

/** NURBS Book A2.1 */
export function findSpan(n: number, p: number, u: number, U: Float64Array): number {
  if (u >= U[n]) return n - 1;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** NURBS Book A2.2: the p+1 non-zero basis functions at u. */
export function basisFuns(span: number, u: number, p: number, U: Float64Array, N: Float64Array): void {
  const left = new Float64Array(p + 1);
  const right = new Float64Array(p + 1);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
}

export function greville(U: Float64Array, n: number, p = DEGREE): Float64Array {
  const g = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 1; i <= p; i++) s += U[k + i];
    g[k] = s / p;
  }
  return g;
}

/** Sparse collocation matrix: for each sample, first column index + p+1 values. */
interface Collocation {
  first: Int32Array;
  vals: Float64Array; // nSamples * (p+1)
}

function collocation(nSamples: number, n: number, U: Float64Array, p = DEGREE): Collocation {
  const first = new Int32Array(nSamples);
  const vals = new Float64Array(nSamples * (p + 1));
  const N = new Float64Array(p + 1);
  for (let i = 0; i < nSamples; i++) {
    const u = nSamples === 1 ? 0 : i / (nSamples - 1);
    const span = findSpan(n, p, u, U);
    basisFuns(span, u, p, U, N);
    first[i] = span - p;
    for (let r = 0; r <= p; r++) vals[i * (p + 1) + r] = N[r];
  }
  return { first, vals };
}

/**
 * Banded SPD normal matrix BᵀB (bandwidth p), stored as lower band
 * L[i*(p+1) + d] = A[i][i-d]. Then factored in place (banded Cholesky).
 */
function factorNormal(C: Collocation, nSamples: number, n: number, p = DEGREE, ridge = 1e-10): Float64Array {
  const bw = p + 1;
  const A = new Float64Array(n * bw);
  for (let s = 0; s < nSamples; s++) {
    const f = C.first[s];
    for (let a = 0; a <= p; a++) {
      const va = C.vals[s * bw + a];
      for (let b = 0; b <= a; b++) {
        A[(f + a) * bw + (a - b)] += va * C.vals[s * bw + b];
      }
    }
  }
  for (let i = 0; i < n; i++) A[i * bw] += ridge;
  // banded Cholesky: A = L Lᵀ
  for (let i = 0; i < n; i++) {
    for (let d = Math.min(p, i); d >= 0; d--) {
      const j = i - d; // column
      let s = A[i * bw + d];
      for (let k = Math.max(0, i - p); k < j; k++) {
        // L[i][k] * L[j][k]
        if (j - k > p) continue;
        s -= A[i * bw + (i - k)] * A[j * bw + (j - k)];
      }
      if (d === 0) {
        A[i * bw] = Math.sqrt(Math.max(s, 1e-300));
      } else {
        A[i * bw + d] = s / A[j * bw];
      }
    }
  }
  return A;
}

/** Solve L Lᵀ x = b in place. */
function cholSolve(L: Float64Array, n: number, b: Float64Array, p = DEGREE): void {
  const bw = p + 1;
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = Math.max(0, i - p); k < i; k++) s -= L[i * bw + (i - k)] * b[k];
    b[i] = s / L[i * bw];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k <= Math.min(n - 1, i + p); k++) s -= L[k * bw + (k - i)] * b[k];
    b[i] = s / L[i * bw];
  }
}

/** Bᵀ y for one sample vector. */
function projectRhs(C: Collocation, y: ArrayLike<number>, nSamples: number, n: number, out: Float64Array, p = DEGREE): void {
  out.fill(0, 0, n);
  const bw = p + 1;
  for (let s = 0; s < nSamples; s++) {
    const f = C.first[s];
    const v = y[s];
    for (let a = 0; a <= p; a++) out[f + a] += C.vals[s * bw + a] * v;
  }
}

/** Least-squares fit with given control counts. */
export function fitSurfaceFixed(g: MachGrid, nu: number, nv: number): BSplineSurface {
  const { nx, ny } = g;
  nu = Math.max(DEGREE + 1, Math.min(nu, nx));
  nv = Math.max(DEGREE + 1, Math.min(nv, ny));
  const U = clampedKnots(nu);
  const V = clampedKnots(nv);
  const Cu = collocation(nx, nu, U);
  const Cv = collocation(ny, nv, V);
  const Lu = factorNormal(Cu, nx, nu);
  const Lv = factorNormal(Cv, ny, nv);

  // step 1: fit each grid row (along x) -> R[j][k]
  const R = new Float64Array(ny * nu);
  const tmp = new Float64Array(Math.max(nu, nv));
  for (let j = 0; j < ny; j++) {
    projectRhs(Cu, g.z.subarray(j * nx, (j + 1) * nx), nx, nu, tmp);
    cholSolve(Lu, nu, tmp);
    R.set(tmp.subarray(0, nu), j * nu);
  }
  // step 2: fit each column of R (along y) -> P[k][m]
  const Pz = new Float64Array(nu * nv);
  const col = new Float64Array(ny);
  for (let k = 0; k < nu; k++) {
    for (let j = 0; j < ny; j++) col[j] = R[j * nu + k];
    projectRhs(Cv, col, ny, nv, tmp);
    cholSolve(Lv, nv, tmp);
    for (let m = 0; m < nv; m++) Pz[k * nv + m] = tmp[m];
  }

  // error at the samples
  const E = new Float64Array(ny * nu); // E[j][k] = Σ_m By[j][m] P[k][m]
  for (let j = 0; j < ny; j++) {
    const f = Cv.first[j];
    for (let k = 0; k < nu; k++) {
      let s = 0;
      for (let a = 0; a <= DEGREE; a++) s += Cv.vals[j * (DEGREE + 1) + a] * Pz[k * nv + f + a];
      E[j * nu + k] = s;
    }
  }
  let maxErr = 0;
  let sq = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const f = Cu.first[i];
      let s = 0;
      for (let a = 0; a <= DEGREE; a++) s += Cu.vals[i * (DEGREE + 1) + a] * E[j * nu + f + a];
      const e = Math.abs(s - g.z[j * nx + i]);
      if (e > maxErr) maxErr = e;
      sq += e * e;
    }
  }

  const gu = greville(U, nu);
  const gv = greville(V, nv);
  const ctrl = new Float64Array(nu * nv * 3);
  for (let k = 0; k < nu; k++) {
    for (let m = 0; m < nv; m++) {
      const o = (k * nv + m) * 3;
      ctrl[o] = gu[k] * g.widthMm;
      ctrl[o + 1] = gv[m] * g.heightMm;
      ctrl[o + 2] = Pz[k * nv + m];
    }
  }
  return {
    degree: DEGREE,
    nu,
    nv,
    knotsU: U,
    knotsV: V,
    ctrl,
    widthMm: g.widthMm,
    heightMm: g.heightMm,
    maxError: maxErr,
    rmsError: Math.sqrt(sq / (nx * ny)),
  };
}

export interface FitOptions {
  tolerance: number;
  /** optional cap on total control points (keeps STEP size in check) */
  maxControlPoints?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Pick the coarsest control net (samples-per-control-span ratio) whose max
 * deviation is within tolerance. Falls back to the finest net tried.
 */
export function fitSurface(g: MachGrid, opts: FitOptions): BSplineSurface {
  const ratios = [8, 6, 5, 4, 3, 2.5, 2, 1.5, 1.25, 1];
  let best: BSplineSurface | null = null;
  for (const r of ratios) {
    const nu = Math.min(g.nx, Math.ceil((g.nx - 1) / r) + DEGREE);
    const nv = Math.min(g.ny, Math.ceil((g.ny - 1) / r) + DEGREE);
    if (opts.maxControlPoints && nu * nv > opts.maxControlPoints && best) break;
    const s = fitSurfaceFixed(g, nu, nv);
    opts.onProgress?.(`ratio ${r}: ${nu}×${nv} poles, max err ${s.maxError.toFixed(4)} mm`);
    best = s;
    if (s.maxError <= opts.tolerance) break;
  }
  return best!;
}

/** Evaluate z of the surface at parameter (u,v) in [0,1]². */
export function evalSurfaceZ(s: BSplineSurface, u: number, v: number): number {
  const p = s.degree;
  const Nu = new Float64Array(p + 1);
  const Nv = new Float64Array(p + 1);
  const su = findSpan(s.nu, p, u, s.knotsU);
  const sv = findSpan(s.nv, p, v, s.knotsV);
  basisFuns(su, u, p, s.knotsU, Nu);
  basisFuns(sv, v, p, s.knotsV, Nv);
  let z = 0;
  for (let a = 0; a <= p; a++) {
    for (let b = 0; b <= p; b++) {
      z += Nu[a] * Nv[b] * s.ctrl[((su - p + a) * s.nv + (sv - p + b)) * 3 + 2];
    }
  }
  return z;
}

/** Collapse a full clamped knot vector into distinct knots + multiplicities (STEP form). */
export function knotMultiplicities(U: Float64Array): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (let i = 0; i < U.length; i++) {
    if (knots.length && Math.abs(U[i] - knots[knots.length - 1]) < 1e-12) mults[mults.length - 1]++;
    else {
      knots.push(U[i]);
      mults.push(1);
    }
  }
  return { knots, mults };
}
