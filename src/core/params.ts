import portrait from '../../presets/portrait.json';
import pet from '../../presets/pet.json';
import object from '../../presets/object.json';
import landscape from '../../presets/landscape.json';
import illustration from '../../presets/illustration.json';

export type CompressionMethod = 'baseDetail' | 'gradient';
export type BgMode = 'flat' | 'keep';
export type OutputMode = 'relief' | 'lithophane';
import type { BorderStyle, OutlineShape } from './layout';

/** Every tunable knob. Lengths are millimetres unless noted. */
export interface ReliefParams {
  /** what to make: a CNC relief from depth, or a backlit 3D-print lithophane from brightness */
  mode: OutputMode;
  /** overall width of the relief (mm); height follows the image aspect */
  widthMm: number;
  /** total Z range of the relief above the base (mm) */
  reliefHeight: number;
  /** flat base under the relief (mm) */
  baseThickness: number;

  method: CompressionMethod;
  /** 0..1: how hard the low-frequency depth is squashed (1 = flattened) */
  compression: number;
  /** multiplier on the high-frequency detail layer */
  detailGain: number;
  /** size of the base/detail split, as a fraction of the image diagonal */
  baseScale: number;
  /** gamma applied to the normalised base layer (<1 lifts the background, >1 pushes it down) */
  baseGamma: number;
  /** v2: depth jumps larger than this (in % of depth range per pixel·1000) are treated as discontinuities */
  gradThreshold: number;
  /** small luminance high-pass texture added on top (0 = off). Use sparingly, e.g. fur. */
  textureGain: number;
  /** tone carving depth (mm): areas clearly darker than their surroundings are cut in, lighter ones raised. 0 = off */
  toneDepth: number;
  /** tone carving: size of the "surroundings" as a fraction of the image diagonal */
  toneScale: number;
  /** tone carving: raise dark areas instead of cutting them in */
  toneDarkUp: boolean;

  /** pre-fit smoothing (mm, Gaussian sigma) – relates to tool size */
  smoothing: number;
  /** edge blend distance from the mask edge down to the base (mm) */
  falloffWidth: number;
  bgMode: BgMode;
  /** keep mode: background height relative to the subject (0..1) */
  bgLevel: number;
  /** intaglio (cut-in) relief */
  invert: boolean;

  /** guided-upsampling regularisation (higher = less photo texture leaks into depth) */
  guideEps: number;
  /** mask threshold 0..1 */
  maskThreshold: number;
  /** remove mask features thinner than ~2× this radius (mm), e.g. whiskers. 0 = off */
  maskCleanup: number;

  /** finishing tool: ball end mill, tapered ball nose, or V-bit / engraver */
  toolType: 'ball' | 'taperedBall' | 'vbit' | 'flat';
  /** finishing tool diameter (mm): ball Ø, tapered-ball tip Ø, or V-bit flat tip Ø (0 = sharp) */
  toolDiameter: number;
  /** tapered ball / V-bit included angle (degrees) */
  toolAngle: number;
  /** machining grid spacing (mm); 0 = auto (tool radius / 2) */
  gridSpacing: number;
  /** B-spline approximation tolerance (mm) */
  fitTolerance: number;

  /** G-code: material (sets the recommended speeds and feeds) */
  camMaterial: 'softwood' | 'hardwood' | 'mdf' | 'plastic' | 'aluminum';
  /** finishing pass (uses the finishing tool above): stepover (mm), raster direction, speeds */
  finStepover: number;
  finDir: 'x' | 'y' | 'xy';
  finRpm: number;
  /** feed / plunge rate, mm/min */
  finFeed: number;
  finPlunge: number;
  finFlutes: number;
  /** roughing pass with its own tool */
  roughOn: boolean;
  roughType: 'flat' | 'ball';
  roughDiameter: number;
  roughStepdown: number;
  roughStepover: number;
  /** material left for the finishing pass (mm) */
  roughAllowance: number;
  roughRpm: number;
  roughFeed: number;
  roughPlunge: number;
  roughFlutes: number;
  /** safe height above the top of the part for rapid moves (mm) */
  safeZ: number;
  /** Z0 at the top of the stock or at the part bottom (spoilboard) */
  zZero: 'top' | 'bottom';
  /** stock thickness (mm); 0 = exactly the part height (base + relief) */
  stockThick: number;
  /** ramp-in angle (degrees) at the start of each cut, 0 = straight plunge */
  rampAngle: number;
  /** wait after starting the spindle (s) */
  spindleDelay: number;
  /** tool change in the all-in-one file: T# M6, or an M0 pause (plain GRBL) */
  toolChange: 'm6' | 'm0';
  /** machine: spindle top speed (rpm) and fastest feed (mm/min), caps for the recommendations */
  minRpm: number;
  maxRpm: number;
  maxFeed: number;
  /** detail (rest machining) pass with a smaller tool where the finishing tool cannot reach */
  detailOn: boolean;
  detailType: 'ball' | 'taperedBall' | 'vbit';
  detailDiameter: number;
  detailAngle: number;
  detailStepover: number;
  detailFlutes: number;
  detailRpm: number;
  detailFeed: number;
  detailPlunge: number;
  /** cutout: profile around the part with the roughing tool, through the stock, with tabs */
  cutoutOn: boolean;
  /** tabs per side (0 = none), their length and height (mm) */
  cutoutTabs: number;
  cutoutTabW: number;
  cutoutTabH: number;
  /** depth below the part bottom (mm) */
  cutoutThrough: number;
  cutoutDir: 'climb' | 'conventional';

  /** stock (the board) width / height (mm); 0 = fit the part plus the edge margin */
  stockW: number;
  stockH: number;
  /** part (plaque) width / height (mm); 0 = fit the picture plus the border and gap */
  partW: number;
  partH: number;
  /** part centre relative to the stock centre (mm, + = right / up); the picture is centred in the part */
  picX: number;
  picY: number;
  /** part outline (the outer edge of the border; the cutout follows it; outside it the stock is left uncut) */
  outlineShape: OutlineShape;
  /** rounded outline: corner radius (mm) */
  outlineCorner: number;
  /** stock fitted to the part: space round the part (mm) */
  borderInset: number;
  /** border from the library, its width, height above the base, the gap to the picture, and pattern repeat (0 = auto) */
  borderStyle: BorderStyle;
  borderWidth: number;
  borderHeight: number;
  borderGap: number;
  borderPitch: number;

  /** lithophane: thickness of the lightest areas (mm) */
  lithoMin: number;
  /** lithophane: thickness of the darkest areas (mm) */
  lithoMax: number;
  /** lithophane: solid frame around the picture at full thickness (mm), 0 = none */
  lithoBorder: number;
  /** lithophane: mesh spacing (mm); about half the nozzle diameter */
  lithoGrid: number;
  /** lithophane: >1 darkens the midtones (thicker), <1 lightens them */
  lithoGamma: number;
  /** lithophane: flat plate or bent into an arc (picture outside, light inside) */
  lithoShape: LithoShape;
  /** curved lithophane: radius of the inside (back) face, mm */
  lithoRadius: number;
  /** lithophane: brightness offset applied to the photo before thickness mapping (-0.5..0.5) */
  lithoBrightness: number;
  /** lithophane: contrast multiplier around mid-grey */
  lithoContrast: number;
  /** rounded-rectangle shape: corner radius (mm) */
  lithoCorner: number;
  /** hanging hole diameter at the top (mm), 0 = none (flat shapes) */
  lithoHole: number;
  /** lamp shade: inside diameter (mm) */
  lampDiameter: number;
  /** lamp shade: height (mm) */
  lampHeight: number;
  /** lamp shade: solid divider between pictures (mm), 0 = none */
  lampDivider: number;
  /** lamp shade: inward lip at the bottom to rest on a puck light (mm) */
  lampLip: number;
  /** lamp shade hardware: open, lip for a puck light, or a ring fitter (spider washer / socket ring) */
  lampFitter: 'none' | 'lip' | 'ring';
  /** ring fitter: centre hole (mm), e.g. 7/16" harp washer, 29 mm E14, 40 mm E27 */
  lampHole: number;
  /** ring fitter at the top (harp / pendant) or the bottom (sits on a table-lamp socket) */
  lampFitterEnd: 'top' | 'bottom';
}

export type LithoShape = 'flat' | 'rounded' | 'oval' | 'heart' | 'curved' | 'lamp';

/** Smallest radius that still leaves a gap between the two ends of a curved lithophane (~340° arc). */
export function minLithoRadius(widthMm: number): number {
  return widthMm / (1.9 * Math.PI);
}

export const DEFAULT_PARAMS: ReliefParams = {
  mode: 'relief',
  widthMm: 152.4,
  reliefHeight: 6,
  baseThickness: 3,
  method: 'gradient',
  compression: 0.7,
  detailGain: 1.6,
  baseScale: 0.04,
  baseGamma: 1,
  gradThreshold: 40,
  textureGain: 0,
  toneDepth: 0,
  toneScale: 0.15,
  toneDarkUp: false,
  smoothing: 0.4,
  falloffWidth: 3,
  bgMode: 'flat',
  bgLevel: 0.25,
  invert: false,
  guideEps: 0.003,
  maskThreshold: 0.5,
  maskCleanup: 0.8,
  toolType: 'ball',
  toolDiameter: 1.5875,
  toolAngle: 60,
  gridSpacing: 0,
  fitTolerance: 0.01,
  camMaterial: 'hardwood',
  finStepover: 0.159,
  finDir: 'x',
  finRpm: 18000,
  finFeed: 1030,
  finPlunge: 340,
  finFlutes: 2,
  roughOn: true,
  roughType: 'flat',
  roughDiameter: 6.35,
  roughStepdown: 3.18,
  roughStepover: 2.54,
  roughAllowance: 0.5,
  roughRpm: 10900,
  roughFeed: 4980,
  roughPlunge: 1660,
  roughFlutes: 2,
  safeZ: 5,
  zZero: 'top',
  stockThick: 0,
  rampAngle: 5,
  spindleDelay: 3,
  toolChange: 'm6',
  minRpm: 10000,
  maxRpm: 24000,
  maxFeed: 5000,
  detailOn: false,
  detailType: 'taperedBall',
  detailDiameter: 0.5,
  detailAngle: 10,
  detailStepover: 0.089,
  detailFlutes: 2,
  detailRpm: 18000,
  detailFeed: 970,
  detailPlunge: 320,
  cutoutOn: false,
  cutoutTabs: 2,
  cutoutTabW: 6,
  cutoutTabH: 2,
  cutoutThrough: 0.3,
  cutoutDir: 'climb',
  stockW: 0,
  stockH: 0,
  partW: 0,
  partH: 0,
  picX: 0,
  picY: 0,
  outlineShape: 'rect',
  outlineCorner: 12,
  borderInset: 0,
  borderStyle: 'none',
  borderWidth: 12,
  borderHeight: 4,
  borderGap: 4,
  borderPitch: 0,
  lithoMin: 0.8,
  lithoMax: 3.0,
  lithoBorder: 3,
  lithoGrid: 0.2,
  lithoGamma: 1,
  lithoShape: 'flat',
  lithoRadius: 80,
  lithoBrightness: 0,
  lithoContrast: 1,
  lithoCorner: 10,
  lithoHole: 0,
  lampDiameter: 100,
  lampHeight: 120,
  lampDivider: 1.5,
  lampLip: 8,
  lampFitter: 'none',
  lampHole: 40,
  lampFitterEnd: 'top',
};

export type PresetName = 'portrait' | 'pet' | 'object' | 'landscape' | 'illustration';

/** Presets live in /presets/*.json so the tuning harness output can be pasted straight in. */
export const PRESETS: Record<PresetName, Partial<ReliefParams>> = {
  portrait: portrait as Partial<ReliefParams>,
  pet: pet as Partial<ReliefParams>,
  object: object as Partial<ReliefParams>,
  landscape: landscape as Partial<ReliefParams>,
  illustration: illustration as Partial<ReliefParams>,
};

export function withPreset(name: PresetName, base: ReliefParams = DEFAULT_PARAMS): ReliefParams {
  return { ...base, ...PRESETS[name] };
}

export function effectiveGridSpacing(p: ReliefParams): number {
  if (p.gridSpacing > 0) return p.gridSpacing;
  // a sharp or tiny-tipped V-bit would give a needlessly fine grid
  const d = Math.max(p.toolDiameter, p.toolType === 'ball' ? 0.2 : 0.8);
  // a detail pass needs a grid fine enough to show what its smaller tool gets into, but the photo's
  // depth holds nothing much finer than 0.2 mm on a typical part
  const dd = p.mode === 'relief' && p.detailOn ? Math.max(0.2, Math.max(p.detailDiameter, p.detailType === 'ball' ? 0.2 : 0.4) / 4) : Infinity;
  return Math.min(d / 4, dd);
}

/** settings that only change the G-code, not the relief (changing them needs no recompute) */
export const CAM_KEYS = [
  'camMaterial', 'finStepover', 'finDir', 'finRpm', 'finFeed', 'finPlunge', 'finFlutes',
  'roughOn', 'roughType', 'roughDiameter', 'roughStepdown', 'roughStepover', 'roughAllowance', 'roughRpm', 'roughFeed', 'roughPlunge', 'roughFlutes',
  'safeZ', 'zZero', 'rampAngle', 'spindleDelay', 'toolChange', 'minRpm', 'maxRpm', 'maxFeed',
  'detailOn', 'detailType', 'detailDiameter', 'detailAngle', 'detailStepover', 'detailFlutes', 'detailRpm', 'detailFeed', 'detailPlunge',
  'cutoutOn', 'cutoutTabs', 'cutoutTabW', 'cutoutTabH', 'cutoutThrough', 'cutoutDir',
] as const satisfies readonly (keyof ReliefParams)[];

/** stock, placement and border: a job setting, kept by Reset all */
export const LAYOUT_KEYS = [
  'stockW', 'stockH', 'stockThick', 'partW', 'partH', 'picX', 'picY', 'outlineShape', 'outlineCorner', 'borderInset', 'borderStyle', 'borderWidth', 'borderHeight', 'borderGap', 'borderPitch',
] as const satisfies readonly (keyof ReliefParams)[];

/** the settings the relief / lithophane surface depends on, as a cache key */
export function geometryKey(p: ReliefParams): string {
  const g: Record<string, unknown> = { ...p };
  for (const k of CAM_KEYS) delete g[k];
  // the detail tool sets the grid spacing when it is on
  g.grid = effectiveGridSpacing(p);
  return JSON.stringify(g);
}
