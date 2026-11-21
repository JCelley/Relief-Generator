/**
 * Lays out and draws a text item to a coverage mask with the browser's own font engine: straight
 * (with the font's kerning) or along an arc, letter by letter. The mask is centred on the item's
 * position; the worker turns it into the carving profile.
 */
import { rasterKey, type TextItem, type TextMask } from '../core/text';
import { fontDef, cssFont } from './fonts';

const ctx2d = () => document.createElement('canvas').getContext('2d')!;

/** cap height as a fraction of the font size, measured on "H" */
async function capRatio(font: string, weight: number, family: string): Promise<number> {
  await document.fonts.load(`${weight} 100px "${family}"`, 'H');
  const c = ctx2d();
  c.font = font.replace(/\d+px/, '100px');
  const m = c.measureText('H');
  return Math.max(0.3, Math.min(1, (m.actualBoundingBoxAscent || 70) / 100));
}

export interface TextLayoutInfo {
  /** size of the drawn area (mm) */
  wMm: number;
  hMm: number;
}

export async function rasterizeText(t: TextItem): Promise<TextMask & TextLayoutInfo> {
  const f = fontDef(t.font);
  const ratio = await capRatio(cssFont(f, 100), f.weight, f.family);
  await document.fonts.load(cssFont(f, 100), t.text || 'H');
  const chars = [...t.text];
  // first at 10 px/mm to lay out, then at a resolution that keeps the canvas a sensible size
  const layout = (ppm: number) => {
    const c = ctx2d();
    const px = (t.size * ppm) / ratio;
    c.font = cssFont(f, px);
    const capH = t.size * ppm;
    const sp = t.spacing * ppm;
    const straight = Math.abs(t.arc) < 0.5 && Math.abs(t.spacing) < 1e-6;
    const widths = chars.map((ch) => c.measureText(ch).width + sp);
    const total = straight ? c.measureText(t.text).width : widths.reduce((a, b) => a + b, 0) - (chars.length ? sp : 0);
    const asc = Math.max(capH, c.measureText(t.text).actualBoundingBoxAscent || capH);
    const desc = Math.max(0.25 * capH, c.measureText(t.text).actualBoundingBoxDescent || 0);
    // each glyph: centre (on the middle of the capitals) and turn, in y-up coordinates
    type G = { ch: string; x: number; y: number; rot: number; w: number };
    const glyphs: G[] = [];
    const A = (t.arc * Math.PI) / 180;
    if (straight) glyphs.push({ ch: t.text, x: 0, y: 0, rot: 0, w: total });
    else {
      let s = -total / 2;
      const R = Math.abs(A) > 1e-3 ? total / Math.abs(A) : Infinity;
      chars.forEach((ch, i) => {
        const w = widths[i] - (i === chars.length - 1 ? sp : 0);
        const mid = s + (widths[i] - sp) / 2;
        s += widths[i];
        if (!Number.isFinite(R)) glyphs.push({ ch, x: mid, y: 0, rot: 0, w });
        else {
          const phi = mid / R;
          if (A > 0) glyphs.push({ ch, x: R * Math.sin(phi), y: R * Math.cos(phi) - R, rot: -phi, w });
          else glyphs.push({ ch, x: R * Math.sin(phi), y: R - R * Math.cos(phi), rot: phi, w });
        }
      });
    }
    // bounds of every glyph box (from the descent below the baseline to the ascent above)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const g of glyphs) {
      const co = Math.cos(g.rot), si = Math.sin(g.rot);
      for (const [u, v] of [[-g.w / 2, -capH / 2 - desc], [g.w / 2, -capH / 2 - desc], [g.w / 2, -capH / 2 + asc], [-g.w / 2, -capH / 2 + asc]]) {
        const X = g.x + co * u - si * v, Y = g.y + si * u + co * v;
        x0 = Math.min(x0, X);
        x1 = Math.max(x1, X);
        y0 = Math.min(y0, Y);
        y1 = Math.max(y1, Y);
      }
    }
    return { px, capH, glyphs, x0, x1, y0, y1 };
  };
  const first = layout(10);
  const wMm0 = (first.x1 - first.x0) / 10 + 2, hMm0 = (first.y1 - first.y0) / 10 + 2;
  const ppm = Math.max(2, Math.min(12, 4000 / Math.max(wMm0, hMm0), Math.sqrt(12e6 / (wMm0 * hMm0))));
  const L = layout(ppm);
  const pad = Math.ceil(ppm) + 2;
  // centre the canvas on the middle of the bounds, so the item's position is the middle of its text
  const mx = (L.x0 + L.x1) / 2, my = (L.y0 + L.y1) / 2;
  const W = Math.ceil(L.x1 - L.x0) + 2 * pad, H = Math.ceil(L.y1 - L.y0) + 2 * pad;
  const cv = document.createElement('canvas');
  cv.width = Math.max(4, W);
  cv.height = Math.max(4, H);
  const c = cv.getContext('2d')!;
  c.font = cssFont(fontDef(t.font), L.px);
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  for (const g of L.glyphs) {
    c.save();
    // y-up to canvas (y-down): flip y and the sense of rotation
    c.translate(cv.width / 2 + (g.x - mx), cv.height / 2 - (g.y - my));
    c.rotate(-g.rot);
    c.fillText(g.ch, 0, L.capH / 2);
    c.restore();
  }
  const img = c.getImageData(0, 0, cv.width, cv.height).data;
  const mask = new Float32Array(cv.width * cv.height);
  for (let k = 0; k < mask.length; k++) mask[k] = img[k * 4 + 3] / 255;
  return { key: rasterKey(t), w: cv.width, h: cv.height, pxPerMm: ppm, mask, wMm: cv.width / ppm, hMm: cv.height / ppm };
}
