import type { Grid } from './grid';

export interface ShadeOptions {
  /** light azimuth in degrees (0 = from the right, 90 = from the top of the image) */
  azimuth?: number;
  /** light elevation above the surface in degrees (low = raking) */
  elevation?: number;
  /** pixel size in mm (heights are in mm) */
  pixelMm: number;
  ambient?: number;
}

/**
 * Software "raking light" render of a heightfield (row 0 = top of image).
 * Returns 8-bit grey values. Used by the headless tuning harness and 2D views.
 */
export function shadeHeightfield(g: Grid, opts: ShadeOptions): Uint8ClampedArray {
  const az = ((opts.azimuth ?? 135) * Math.PI) / 180;
  const el = ((opts.elevation ?? 25) * Math.PI) / 180;
  const amb = opts.ambient ?? 0.12;
  // light vector in image space: x right, y up (screen), z out of the surface
  const lx = Math.cos(el) * Math.cos(az);
  const ly = Math.cos(el) * Math.sin(az);
  const lz = Math.sin(el);
  const { w, h, data } = g;
  const out = new Uint8ClampedArray(w * h);
  const inv2 = 1 / (2 * opts.pixelMm);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const dzdx = (data[y * w + xp] - data[y * w + xm]) * inv2 * (2 / Math.max(1, xp - xm));
      // image y grows downward; screen-up derivative is the negative
      const dzdy = -(data[yp * w + x] - data[ym * w + x]) * inv2 * (2 / Math.max(1, yp - ym));
      let nx = -dzdx;
      let ny = -dzdy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const d = Math.max(0, nx * lx + ny * ly + nz * lz);
      const v = amb + (1 - amb) * d;
      out[y * w + x] = Math.round(255 * Math.min(1, v * 1.05));
    }
  }
  return out;
}
