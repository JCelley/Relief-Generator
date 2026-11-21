/**
 * Text on a CNC relief. The browser lays out and draws each text item (fonts, letter spacing,
 * arc) to a coverage mask; here the mask becomes a distance-inside-the-letters map, and the map is
 * placed on the stock (position, rotation) and carved with a profile. Lengths in mm.
 */
import type { MachGrid } from './resample';
import { insideDistance } from './distance';
import type { Grid } from './grid';

export type TextStyle = 'dome' | 'flat' | 'bevel' | 'vcarve' | 'engrave';

export const TEXT_STYLES: [TextStyle, string][] = [
  ['dome', 'Raised, rounded (carved look)'],
  ['flat', 'Raised, flat top'],
  ['bevel', 'Raised, bevelled 45°'],
  ['vcarve', 'Carved in, V (60° V-bit)'],
  ['engrave', 'Carved in, flat bottom'],
];

export interface TextItem {
  id: number;
  text: string;
  /** font family (see ui/fonts) */
  font: string;
  /** height of the capital letters (mm) */
  size: number;
  /** extra space between letters (mm) */
  spacing: number;
  /** how far the text bends (degrees along its length): 0 = straight, + arches up, − curves down */
  arc: number;
  /** degrees, counter-clockwise */
  rotation: number;
  /** centre of the text relative to the middle of the stock (mm, + = right / up) */
  x: number;
  y: number;
  style: TextStyle;
  /** raised height above the base, or depth carved into the surface (mm) */
  height: number;
}

export const isCarved = (s: TextStyle) => s === 'vcarve' || s === 'engrave';

/** the settings the drawn letters depend on (position, rotation, style and height do not) */
export const rasterKey = (t: TextItem) => JSON.stringify([t.text, t.font, t.size, t.spacing, t.arc]);

/** a drawn text item: coverage 0..1, row 0 at the top, centred on the item's position */
export interface TextMask {
  key: string;
  w: number;
  h: number;
  pxPerMm: number;
  mask: Float32Array;
}

/** a text item ready to carve: distance inside the letters (mm, 0 outside) */
export interface TextField {
  w: number;
  h: number;
  pxPerMm: number;
  dist: Float32Array;
}

export function textField(m: TextMask): TextField {
  const g: Grid = { w: m.w, h: m.h, data: m.mask };
  const d = insideDistance(g);
  const dist = new Float32Array(m.w * m.h);
  // half a pixel in: the edge of the letter is between the last pixel in and the first one out
  for (let k = 0; k < dist.length; k++) dist[k] = m.mask[k] >= 0.5 ? (d.data[k] - 0.5) / m.pxPerMm : 0;
  return { w: m.w, h: m.h, pxPerMm: m.pxPerMm, dist };
}

const COT30 = Math.sqrt(3);

/** height (raised) or depth (carved) at distance d inside the letter, for height / depth H */
export function textProfile(style: TextStyle, d: number, H: number): number {
  if (d <= 0) return 0;
  switch (style) {
    case 'dome': {
      // a quarter-round shoulder as tall as the letters, so thin strokes come up as rounded ridges
      const t = Math.min(d, H) / H;
      return H * Math.sqrt(1 - (1 - t) * (1 - t));
    }
    case 'flat':
    case 'engrave': {
      const r = Math.min(0.3, H);
      const t = Math.min(d, r) / r;
      return H * Math.sqrt(1 - (1 - t) * (1 - t));
    }
    case 'bevel':
      return Math.min(H, d);
    case 'vcarve':
      return Math.min(H, d * COT30);
  }
}

function sample(f: TextField, u: number, v: number): number {
  if (u < 0 || v < 0 || u > f.w - 1 || v > f.h - 1) return 0;
  const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j;
  const i1 = Math.min(f.w - 1, i + 1), j1 = Math.min(f.h - 1, j + 1);
  const D = f.dist;
  return (D[j * f.w + i] * (1 - a) + D[j * f.w + i1] * a) * (1 - b) + (D[j1 * f.w + i] * (1 - a) + D[j1 * f.w + i1] * a) * b;
}

/**
 * Carves the text items into the surface: raised styles stand on the base (merged with the relief
 * and border round them), carved styles go into whatever surface they are on. Updates zMin / zMax.
 */
export function applyTexts(m: MachGrid, items: TextItem[], fields: Map<string, TextField>, base: number): void {
  for (const t of items) {
    const f = fields.get(rasterKey(t));
    if (!f || !t.text.trim() || t.height <= 0) continue;
    const cx = m.widthMm / 2 + t.x, cy = m.heightMm / 2 + t.y;
    const th = (t.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const hw = f.w / 2 / f.pxPerMm, hh = f.h / 2 / f.pxPerMm, R = Math.hypot(hw, hh);
    const i0 = Math.max(0, Math.floor((cx - R) / m.dx)), i1 = Math.min(m.nx - 1, Math.ceil((cx + R) / m.dx));
    const j0 = Math.max(0, Math.floor((cy - R) / m.dy)), j1 = Math.min(m.ny - 1, Math.ceil((cy + R) / m.dy));
    const carved = isCarved(t.style);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = i * m.dx - cx, py = j * m.dy - cy;
        // into the text's own frame (x right, y up), then its pixels (row 0 at the top)
        const lx = c * px + s * py, ly = -s * px + c * py;
        const d = sample(f, lx * f.pxPerMm + f.w / 2 - 0.5, f.h / 2 - ly * f.pxPerMm - 0.5);
        if (d <= 0) continue;
        const k = j * m.nx + i, h = textProfile(t.style, d, t.height);
        m.z[k] = carved ? m.z[k] - h : Math.max(m.z[k], base + h);
      }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of m.z) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  m.zMin = lo;
  m.zMax = hi;
}
