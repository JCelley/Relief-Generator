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

  /** finishing tool diameter (mm) */
  toolDiameter: number;
  /** machining grid spacing (mm); 0 = auto (tool radius / 2) */
  gridSpacing: number;
  /** B-spline approximation tolerance (mm) */
  fitTolerance: number;

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
  toolDiameter: 1.5875,
  gridSpacing: 0,
  fitTolerance: 0.01,
  lithoMin: 0.8,
  lithoMax: 3.0,
  lithoBorder: 3,
  lithoGrid: 0.2,
  lithoGamma: 1,
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
  return p.gridSpacing > 0 ? p.gridSpacing : p.toolDiameter / 4;
}
