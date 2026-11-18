import { Grid, mapGrid, normalizeRobust } from './grid';
import { toMachiningGrid, MachGrid } from './resample';
import type { ReliefParams } from './params';

/**
 * Lithophane: a thin plate whose thickness follows the photo's darkness, so it shows the picture
 * when lit from behind. Lightest areas get `lithoMin`, darkest `lithoMax`; flat back at Z = 0, the
 * picture side on top. The photo is auto-levelled so the full thickness range is used.
 */
export function lithophaneGrid(luminance: Grid, p: ReliefParams): MachGrid {
  const L = normalizeRobust(luminance, 0.005, 0.995);
  const g = Math.max(0.05, p.lithoGamma);
  const dark = mapGrid(L, (v) => 1 - Math.pow(Math.min(1, Math.max(0, v)), g));
  const tMin = Math.max(0.1, Math.min(p.lithoMin, p.lithoMax - 0.1));
  const tMax = Math.max(p.lithoMax, tMin + 0.1);
  const m = toMachiningGrid(dark, {
    ...p,
    baseThickness: tMin,
    reliefHeight: tMax - tMin,
    invert: false,
    smoothing: 0,
    gridSpacing: Math.max(0.05, p.lithoGrid),
  });
  // solid frame (stiffens the plate and gives a clean edge)
  if (p.lithoBorder > 0) {
    const bi = Math.round(p.lithoBorder / m.dx);
    const bj = Math.round(p.lithoBorder / m.dy);
    for (let j = 0; j < m.ny; j++)
      for (let i = 0; i < m.nx; i++)
        if (i < bi || j < bj || i >= m.nx - bi || j >= m.ny - bj) m.z[j * m.nx + i] = tMax;
  }
  let zMin = Infinity, zMax = -Infinity;
  for (const v of m.z) {
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  return { ...m, zMin, zMax };
}

/** Simulated backlit view: light transmitted through `t` mm (Beer–Lambert), 0..1. */
export function backlitBrightness(t: number, tMin: number, tMax: number): number {
  const alpha = Math.log(12) / Math.max(0.1, tMax - tMin);
  return Math.exp(-alpha * (t - tMin));
}
