import { Grid, makeGrid, sampleBilinear, minMax } from './grid';
import { gaussianBlur } from './filters';
import { ReliefParams, effectiveGridSpacing } from './params';
import { Layout, resolveLayout, sdf, borderProfile, makeAlong, isPattern } from './layout';
import { smoothstep } from './distance';
import { applyTexts, type TextField } from './text';

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
  /** relief: stock, picture placement, outline and border (the grid covers the stock) */
  layout?: Layout;
}

export function reliefSizeMm(imgW: number, imgH: number, widthMm: number): { widthMm: number; heightMm: number } {
  return { widthMm, heightMm: (widthMm * imgH) / imgW };
}

/**
 * Convert normalised relief height (0..1, working res) to millimetres on the machining grid, with
 * the stock layout, border and (given their drawn letters) the text items.
 */
export function toMachiningGrid(height01: Grid, p: ReliefParams, texts?: Map<string, TextField>): MachGrid {
  const m = surfaceGrid(height01, p);
  if (p.mode === 'relief' && p.texts?.length && texts) applyTexts(m, p.texts, texts, p.baseThickness);
  return m;
}

function surfaceGrid(height01: Grid, p: ReliefParams): MachGrid {
  const { widthMm, heightMm } = reliefSizeMm(height01.w, height01.h, p.widthMm);
  const L = resolveLayout(p, widthMm, heightMm);
  if (L.active) return composeGrid(height01, p, L);
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
  return { nx, ny, dx, dy, widthMm, heightMm, z, zMin, zMax, layout: p.mode === 'relief' ? L : undefined };
}

/**
 * The stock with the part on it: the picture fades to the base over the edge falloff at its own
 * edges and inside the border (plus the gap); the border profile is measured in from the outline;
 * outside the outline the stock is left uncut (at its thickness, at least the part's top). Intaglio
 * cuts both in from the top.
 */
function composeGrid(height01: Grid, p: ReliefParams, L: Layout): MachGrid {
  const spacing = effectiveGridSpacing(p);
  const nx = Math.max(2, Math.round(L.W / spacing) + 1);
  const ny = Math.max(2, Math.round(L.H / spacing) + 1);
  const dx = L.W / (nx - 1), dy = L.H / (ny - 1);
  const { x0, y0, w: pw, h: ph } = L.pic;
  const pxPerMm = height01.w / pw;
  const sSmooth = p.smoothing * pxPerMm;
  const sAA = Math.max(0, 0.5 * spacing * pxPerMm - 0.5);
  const src = gaussianBlur(height01, Math.sqrt(sSmooth * sSmooth + sAA * sAA));
  const fade = Math.max(1, p.falloffWidth);
  const along = L.border !== 'none' && isPattern(L.border) ? makeAlong(L) : null;
  const tall = Math.max(p.reliefHeight, L.bh);
  const top = p.baseThickness + tall;
  const uncut = Math.max(top, p.stockThick);
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = j * dy;
    for (let i = 0; i < nx; i++) {
      const x = i * dx;
      const d = sdf(L.outline, x, y);
      if (d > 0) {
        z[j * nx + i] = uncut;
        continue;
      }
      let v = 0;
      // the picture
      const edge = Math.min(x - x0, x0 + pw - x, y - y0, y0 + ph - y);
      if (edge > 0 && -d > L.window) {
        const px = ((x - x0) / pw) * height01.w - 0.5, py = ((y0 + ph - y) / ph) * height01.h - 0.5;
        const hgt = Math.min(1, Math.max(0, sampleBilinear(src, px, py)));
        v = p.reliefHeight * hgt * smoothstep(edge / fade) * smoothstep((-d - L.window) / fade);
      }
      // the border
      if (L.bw > 0 && d <= 0 && d >= -L.bw) {
        const u = along ? along(x, y, d) : 0;
        v = Math.max(v, L.bh * borderProfile(L.border, -d / L.bw, u - Math.floor(u), L.pitch, L.bw));
      }
      z[j * nx + i] = p.invert ? top - v : p.baseThickness + v;
    }
  }
  const [zMin, zMax] = minMax(z);
  return { nx, ny, dx, dy, widthMm: L.W, heightMm: L.H, z, zMin, zMax, layout: L };
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
