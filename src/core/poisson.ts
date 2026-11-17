import { Grid, makeGrid } from './grid';

export interface PoissonOptions {
  /** screening weight pulling u toward `target` (keeps the system well conditioned) */
  lambda?: number;
  /** optional target for the screening term (default 0) */
  target?: Grid;
  /** initial guess */
  init?: Grid;
  maxIter?: number;
  /** relative residual tolerance */
  tol?: number;
}

/**
 * Screened Poisson reconstruction on a masked domain:
 *
 *   minimise  Σ_edges (u_q − u_p − g_pq)²  +  λ Σ_p (u_p − t_p)²
 *
 * where horizontal edges carry gx(x,y) = desired u(x+1,y) − u(x,y) and
 * vertical edges gy(x,y) = desired u(x,y+1) − u(x,y).
 * Pixels with domain < 0.5 are fixed at 0 (Dirichlet); the image border is
 * free (Neumann). Solved with Jacobi-preconditioned conjugate gradients.
 */
export function solveScreenedPoisson(
  gx: Grid,
  gy: Grid,
  domain: Grid,
  opts: PoissonOptions = {},
): { u: Grid; iterations: number; residual: number } {
  const { w, h } = gx;
  const n = w * h;
  const lambda = opts.lambda ?? 1e-4;
  const maxIter = opts.maxIter ?? 3000;
  const tol = opts.tol ?? 1e-6;
  const inD = new Uint8Array(n);
  for (let i = 0; i < n; i++) inD[i] = domain.data[i] >= 0.5 ? 1 : 0;

  // degree (number of edges incl. edges to Dirichlet pixels; image border has none)
  const diag = new Float64Array(n);
  const b = new Float64Array(n);
  const t = opts.target?.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inD[i]) continue;
      let deg = 0;
      let rhs = 0;
      // edge to the right: (i -> i+1) residual u_{i+1} - u_i - gx_i ; contributes +gx_i... see derivation
      if (x + 1 < w) {
        deg++;
        rhs -= gx.data[i];
      }
      if (x > 0) {
        deg++;
        rhs += gx.data[i - 1];
      }
      if (y + 1 < h) {
        deg++;
        rhs -= gy.data[i];
      }
      if (y > 0) {
        deg++;
        rhs += gy.data[i - w];
      }
      diag[i] = deg + lambda;
      b[i] = rhs + (t ? lambda * t[i] : 0);
    }
  }

  // A u = (deg+λ) u_i − Σ_{free neighbours} u_j
  const applyA = (u: Float64Array, out: Float64Array) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!inD[i]) {
          out[i] = 0;
          continue;
        }
        let s = diag[i] * u[i];
        if (x + 1 < w && inD[i + 1]) s -= u[i + 1];
        if (x > 0 && inD[i - 1]) s -= u[i - 1];
        if (y + 1 < h && inD[i + w]) s -= u[i + w];
        if (y > 0 && inD[i - w]) s -= u[i - w];
        out[i] = s;
      }
    }
  };

  const u = new Float64Array(n);
  if (opts.init) for (let i = 0; i < n; i++) u[i] = inD[i] ? opts.init.data[i] : 0;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  applyA(u, Ap);
  let bnorm = 0;
  for (let i = 0; i < n; i++) {
    r[i] = inD[i] ? b[i] - Ap[i] : 0;
    bnorm += b[i] * b[i];
  }
  bnorm = Math.sqrt(bnorm) || 1;
  let rz = 0;
  for (let i = 0; i < n; i++) {
    z[i] = inD[i] ? r[i] / diag[i] : 0;
    p[i] = z[i];
    rz += r[i] * z[i];
  }
  let it = 0;
  let rnorm = 0;
  for (; it < maxIter; it++) {
    applyA(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (pAp <= 0) break;
    const alpha = rz / pAp;
    rnorm = 0;
    for (let i = 0; i < n; i++) {
      u[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      rnorm += r[i] * r[i];
    }
    rnorm = Math.sqrt(rnorm);
    if (rnorm / bnorm < tol) {
      it++;
      break;
    }
    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      z[i] = inD[i] ? r[i] / diag[i] : 0;
      rzNew += r[i] * z[i];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  const out = makeGrid(w, h);
  for (let i = 0; i < n; i++) out.data[i] = u[i];
  return { u: out, iterations: it, residual: rnorm / bnorm };
}

/** Forward differences: gx(x,y) = u(x+1,y) − u(x,y) (0 on last column), same for gy. */
export function forwardGradients(u: Grid): { gx: Grid; gy: Grid } {
  const { w, h, data } = u;
  const gx = makeGrid(w, h);
  const gy = makeGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) gx.data[i] = data[i + 1] - data[i];
      if (y + 1 < h) gy.data[i] = data[i + w] - data[i];
    }
  }
  return { gx, gy };
}
