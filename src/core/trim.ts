/**
 * Detects a plain border around a picture (white poster matte, black letterbox, scanner margin,
 * including a soft drop shadow) so it can be cropped off before depth estimation. Left in, such a
 * border turns into a raised picture frame in the relief.
 */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TOL = 22; // per-channel distance from the line's mean colour that still counts as "plain"
const STEP = 32; // how much the border colour may drift from one line to the next (shadows)
const FLAT = 0.97; // fraction of a line that must be plain
const GREY = 40; // the outermost line must be near-neutral (white / grey / black)
const MAX_SIDE = 0.25; // never trim more than this fraction from one side

/** pixel accessor: returns [r,g,b] of pixel (x,y) */
type Px = (x: number, y: number) => [number, number, number];

function lineStats(px: Px, n: number, at: (k: number) => [number, number]) {
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < n; k++) {
    const [x, y] = at(k);
    const c = px(x, y);
    r += c[0]; g += c[1]; b += c[2];
  }
  const mean: [number, number, number] = [r / n, g / n, b / n];
  let plain = 0;
  for (let k = 0; k < n; k++) {
    const [x, y] = at(k);
    const c = px(x, y);
    if (Math.max(Math.abs(c[0] - mean[0]), Math.abs(c[1] - mean[1]), Math.abs(c[2] - mean[2])) <= TOL) plain++;
  }
  return { mean, flat: plain / n };
}

/** Depth of the plain border on one side, in pixels (0 = none). */
function sideDepth(px: Px, lines: number, len: number, at: (line: number, k: number) => [number, number]): number {
  let prev: [number, number, number] | null = null;
  const limit = Math.floor(lines * MAX_SIDE);
  let d = 0;
  for (; d < limit; d++) {
    const s = lineStats(px, len, (k) => at(d, k));
    if (s.flat < FLAT) break;
    if (!prev) {
      if (Math.max(...s.mean) - Math.min(...s.mean) > GREY) return 0;
    } else if (Math.max(Math.abs(s.mean[0] - prev[0]), Math.abs(s.mean[1] - prev[1]), Math.abs(s.mean[2] - prev[2])) > STEP) break;
    prev = s.mean;
  }
  return d;
}

/**
 * Returns the crop box of the picture inside a plain border, or null when there is none.
 * A border only counts when two opposite sides have one (frame or letterbox), so a clear sky
 * along the top edge of an ordinary photo is never cut off.
 */
export function findPlainBorder(data: ArrayLike<number>, w: number, h: number, channels: number): CropBox | null {
  if (w < 32 || h < 32) return null;
  const px: Px = (x, y) => {
    const i = (y * w + x) * channels;
    return channels >= 3 ? [data[i], data[i + 1], data[i + 2]] : [data[i], data[i], data[i]];
  };
  // sample the middle 90 % of each line so a shadow or rounded corner does not break it
  const mx = Math.floor(w * 0.05), my = Math.floor(h * 0.05);
  const top = sideDepth(px, h, w - 2 * mx, (d, k) => [mx + k, d]);
  const bottom = sideDepth(px, h, w - 2 * mx, (d, k) => [mx + k, h - 1 - d]);
  const left = sideDepth(px, w, h - 2 * my, (d, k) => [d, my + k]);
  const right = sideDepth(px, w, h - 2 * my, (d, k) => [w - 1 - d, my + k]);
  const minX = Math.max(2, w * 0.005), minY = Math.max(2, h * 0.005);
  const vert = top >= minY && bottom >= minY;
  const horz = left >= minX && right >= minX;
  if (!vert && !horz) return null;
  // step a little further in so the anti-aliased picture edge is not kept as a ridge
  const pad = Math.max(1, Math.round(Math.min(w, h) * 0.004));
  const t = top >= minY ? top + pad : 0;
  const b = bottom >= minY ? bottom + pad : 0;
  const l = left >= minX ? left + pad : 0;
  const r = right >= minX ? right + pad : 0;
  const box = { x: l, y: t, w: w - l - r, h: h - t - b };
  if (box.w < w * 0.4 || box.h < h * 0.4) return null;
  return box;
}
