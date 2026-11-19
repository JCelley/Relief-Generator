import portrait from '../../presets/portrait.json';
import pet from '../../presets/pet.json';
import object from '../../presets/object.json';
import landscape from '../../presets/landscape.json';
import illustration from '../../presets/illustration.json';

export type CompressionMethod = 'baseDetail' | 'gradient';
export type BgMode = 'flat' | 'keep';
export type OutputMode = 'relief' | 'lithophane';

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
  /** Z0 at the top of the part or at its bottom (spoilboard) */
  zZero: 'top' | 'bottom';

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
  roughRpm: 18000,
  roughFeed: 5000,
  roughPlunge: 1670,
  roughFlutes: 2,
  safeZ: 5,
  zZero: 'top',
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
  return d / 4;
}
