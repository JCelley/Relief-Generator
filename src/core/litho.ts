import { Grid, mapGrid, normalizeRobust } from './grid';
import { toMachiningGrid, MachGrid } from './resample';
import { minLithoRadius, type ReliefParams } from './params';
import { Mesh, cylinderMap, heightfieldMesh, maskedMesh, lampMesh, fitterMesh, mergeMeshes, upsideDown } from './mesh';

/**
 * Lithophane: a thin plate whose thickness follows the photo's darkness, so it shows the picture
 * when lit from behind. Lightest areas get `lithoMin`, darkest `lithoMax`; flat back at Z = 0, the
 * picture side on top. The photo is auto-levelled so the full thickness range is used, then the
 * brightness / contrast adjustments are applied.
 *
 * Lamp shade: `luminance` is the strip of all pictures side by side (`panels` of them), the width
 * is the inside circumference, and solid dividers separate the pictures.
 */
export function lithophaneGrid(luminance: Grid, p: ReliefParams, panels = 0): MachGrid {
  const lamp = p.lithoShape === 'lamp';
  const L = normalizeRobust(luminance, 0.005, 0.995);
  const g = Math.max(0.05, p.lithoGamma);
  const c = Math.max(0.05, p.lithoContrast ?? 1), b = p.lithoBrightness ?? 0;
  const dark = mapGrid(L, (v) => {
    const a = Math.min(1, Math.max(0, (v - 0.5) * c + 0.5 + b));
    return 1 - Math.pow(a, g);
  });
  const { tMin, tMax } = lithoRange(p);
  const m = toMachiningGrid(dark, {
    ...p,
    widthMm: lamp ? Math.PI * p.lampDiameter : p.widthMm,
    baseThickness: tMin,
    reliefHeight: tMax - tMin,
    invert: false,
    smoothing: 0,
    gridSpacing: Math.max(0.05, p.lithoGrid),
  });
  const X = (i: number) => (i === m.nx - 1 ? m.widthMm : i * m.dx);
  const Y = (j: number) => (j === m.ny - 1 ? m.heightMm : j * m.dy);
  if (lamp) {
    // solid bands top and bottom, dividers between the pictures (the seam is one of them)
    // the band must hold the lip or the fitter's spokes
    const band = Math.max(p.lithoBorder, p.lampFitter === 'lip' ? 2.5 : p.lampFitter === 'ring' ? 4 : 0);
    const n = Math.max(1, panels);
    const pw = m.widthMm / n;
    for (let j = 0; j < m.ny; j++)
      for (let i = 0; i < m.nx; i++) {
        const x = X(i), y = Y(j);
        const dPanel = Math.abs(x - Math.round(x / pw) * pw);
        if (y < band || y > m.heightMm - band || (p.lampDivider > 0 && dPanel < p.lampDivider / 2)) m.z[j * m.nx + i] = tMax;
      }
  } else {
    // solid frame following the outline (stiffens the plate, clean edge) and a ring round the hole
    const f = lithoOutline(p, m.widthMm, m.heightMm);
    const hole = holeOf(p, m.widthMm, m.heightMm, f.shape);
    for (let j = 0; j < m.ny; j++)
      for (let i = 0; i < m.nx; i++) {
        const x = X(i), y = Y(j);
        const d = distance(f.shape, x, y);
        const inFrame = p.lithoBorder > 0 && d > -p.lithoBorder;
        const inRing = hole && Math.hypot(x - hole.x, y - hole.y) < hole.r + hole.ring;
        if (inFrame || inRing) m.z[j * m.nx + i] = tMax;
      }
  }
  let zMin = Infinity, zMax = -Infinity;
  for (const v of m.z) {
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  return { ...m, zMin, zMax };
}

export function lithoRange(p: ReliefParams): { tMin: number; tMax: number } {
  const tMin = Math.max(0.1, Math.min(p.lithoMin, p.lithoMax - 0.1));
  return { tMin, tMax: Math.max(p.lithoMax, tMin + 0.1) };
}

/** Simulated backlit view: light transmitted through `t` mm (Beer–Lambert), 0..1. */
export function backlitBrightness(t: number, tMin: number, tMax: number): number {
  const alpha = Math.log(12) / Math.max(0.1, tMax - tMin);
  return Math.exp(-alpha * (t - tMin));
}

type Implicit = (x: number, y: number) => number;

/** approximate signed distance (mm) from an implicit outline: f / |∇f| */
function distance(f: Implicit, x: number, y: number): number {
  const e = 1e-3;
  const v = f(x, y);
  const gx = (f(x + e, y) - f(x - e, y)) / (2 * e), gy = (f(x, y + e) - f(x, y - e)) / (2 * e);
  return v / Math.max(1e-6, Math.hypot(gx, gy));
}

/**
 * Outline of a flat lithophane in the W × H picture box (negative inside):
 * `shape` without the hanging hole, `full` with it.
 */
export function lithoOutline(p: ReliefParams, W: number, H: number): { shape: Implicit; full: Implicit } {
  let shape: Implicit;
  const s = p.lithoShape;
  if (s === 'oval') {
    const a = W / 2, b = H / 2;
    shape = (x, y) => (Math.hypot((x - a) / a, (y - b) / b) - 1) * Math.min(a, b);
  } else if (s === 'heart') {
    // Inigo Quilez's heart (tip at 0, lobes up to ~1.104, half-width ~0.604), stretched to the box
    const hw = 0.25 + Math.SQRT2 / 4, ht = 0.75 + Math.SQRT2 / 4;
    const k = Math.min(W / (2 * hw), H / ht);
    shape = (x, y) => sdHeart(((x - W / 2) / (W / 2)) * hw, (y / H) * ht) * k;
  } else {
    const rc = s === 'rounded' ? Math.min(Math.max(0, p.lithoCorner), W / 2, H / 2) : 0;
    shape = (x, y) => sdRoundBox(x - W / 2, y - H / 2, W / 2, H / 2, rc);
  }
  const hole = holeOf(p, W, H, shape);
  const full: Implicit = hole ? (x, y) => Math.max(shape(x, y), hole.r - Math.hypot(x - hole.x, y - hole.y)) : shape;
  return { shape, full };
}

/** hanging hole near the top centre, below the outline, with a solid ring around it */
function holeOf(p: ReliefParams, W: number, H: number, shape: Implicit) {
  if (!(p.lithoHole > 0) || p.lithoShape === 'lamp') return null;
  const r = p.lithoHole / 2;
  const ring = Math.max(2, p.lithoBorder);
  // top of the outline above the centre (the dip of a heart, the top edge otherwise)
  let yTop = H;
  for (let y = H; y > 0; y -= H / 400) if (shape(W / 2, y) < 0) { yTop = y; break; }
  const y = yTop - ring - r;
  if (y - r < H * 0.3) return null;
  return { x: W / 2, y, r, ring };
}

function sdRoundBox(px: number, py: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdHeart(x: number, y: number): number {
  x = Math.abs(x);
  if (y + x > 1) return Math.hypot(x - 0.25, y - 0.75) - Math.SQRT2 / 4;
  const t = 0.5 * Math.max(x + y, 0);
  return Math.sqrt(Math.min(x * x + (y - 1) * (y - 1), (x - t) * (x - t) + (y - t) * (y - t))) * Math.sign(x - y);
}

/** true when the flat lithophane is not a plain rectangle (needs the outline-following mesh) */
export function hasOutline(p: ReliefParams): boolean {
  return p.lithoShape === 'rounded' || p.lithoShape === 'oval' || p.lithoShape === 'heart' || p.lithoHole > 0;
}

/**
 * Printable mesh of a lithophane grid. Flat shapes lie on their back (Z = 0, picture up); curved
 * ones and lamp shades stand upright (bottom edge at Z = 0) with the picture facing outward.
 */
export function lithoMesh(m: MachGrid, p: ReliefParams): { mesh: Mesh; upright: boolean } {
  if (p.lithoShape === 'lamp') {
    let mesh = lampMesh(m, p.lampFitter === 'lip' ? p.lampLip : 0);
    if (p.lampFitter === 'ring') {
      // the fitter is printed on the bed; a top fitter means printing the shade upside down
      if (p.lampFitterEnd === 'top') mesh = upsideDown(mesh, m.heightMm);
      mesh = mergeMeshes(mesh, fitterMesh(m.widthMm / (2 * Math.PI), p.lampHole));
    }
    return { mesh, upright: true };
  }
  if (p.lithoShape === 'curved') {
    const map = cylinderMap(m.widthMm, Math.max(p.lithoRadius, minLithoRadius(m.widthMm)));
    return { mesh: p.lithoHole > 0 ? maskedMesh(m, lithoOutline(p, m.widthMm, m.heightMm).full, map) : heightfieldMesh(m, map), upright: true };
  }
  if (hasOutline(p)) return { mesh: maskedMesh(m, lithoOutline(p, m.widthMm, m.heightMm).full), upright: false };
  return { mesh: heightfieldMesh(m), upright: false };
}
