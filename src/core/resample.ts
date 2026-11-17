import { Grid, makeGrid, sampleBilinear, minMax } from './grid';
import { gaussianBlur } from './filters';
import { ReliefParams, effectiveGridSpacing } from './params';

/**
 * Heightfield on the machining grid, in CAD orientation:
 * z[j*nx + i] is the height (mm) at x = i*dx, y = j*dy with y pointing UP
 * (row 0 is the bottom edge of the picture).
 */
export interface MachGrid {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  widthMm: number;
  heightMm: number;
  z: Float32Array;
  zMin: number;
  zMax: number;
}

export function reliefSizeMm(imgW: number, imgH: number, widthMm: number): { widthMm: number; heightMm: number } {
  return { widthMm, heightMm: (widthMm * imgH) / imgW };
}

/** Convert normalised relief height (0..1, working res) to millimetres on the machining grid. */
export function toMachiningGrid(height01: Grid, p: ReliefParams): MachGrid {
  const { widthMm, heightMm } = reliefSizeMm(height01.w, height01.h, p.widthMm);
  const spacing = effectiveGridSpacing(p);
  const nx = Math.max(2, Math.round(widthMm / spacing) + 1);
  const ny = Math.max(2, Math.round(heightMm / spacing) + 1);
  const dx = widthMm / (nx - 1);
  const dy = heightMm / (ny - 1);
  const pxPerMm = height01.w / widthMm;

  // pre-fit smoothing + anti-alias for the downsample
  const sSmooth = p.smoothing * pxPerMm;
  const sAA = Math.max(0, 0.5 * spacing * pxPerMm - 0.5);
  const sigma = Math.sqrt(sSmooth * sSmooth + sAA * sAA);
  const src = gaussianBlur(height01, sigma);

  const z = new Float32Array(nx * ny);
  const top = p.baseThickness + p.reliefHeight;
  for (let j = 0; j < ny; j++) {
    const yMm = j * dy;
    // image pixel row: pixel centres span [0, h-1] across the image
    const py = ((heightMm - yMm) / heightMm) * height01.h - 0.5;
    for (let i = 0; i < nx; i++) {
      const px = ((i * dx) / widthMm) * height01.w - 0.5;
      const hgt = Math.min(1, Math.max(0, sampleBilinear(src, px, py)));
      z[j * nx + i] = p.invert ? top - p.reliefHeight * hgt : p.baseThickness + p.reliefHeight * hgt;
    }
  }
  const [zMin, zMax] = minMax(z);
  return { nx, ny, dx, dy, widthMm, heightMm, z, zMin, zMax };
}

/** Convert a MachGrid back to an image-oriented Grid (row 0 = top) for display. */
export function machToImageGrid(m: MachGrid): Grid {
  const g = makeGrid(m.nx, m.ny);
  for (let j = 0; j < m.ny; j++) {
    const row = m.ny - 1 - j;
    for (let i = 0; i < m.nx; i++) g.data[row * m.nx + i] = m.z[j * m.nx + i];
  }
  return g;
}
