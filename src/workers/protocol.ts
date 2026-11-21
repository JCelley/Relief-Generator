import type { TextMask } from '../core/text';
import type { MachGrid } from '../core/resample';
import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import type { ReliefParams } from '../core/params';
import type { Device, MaskModelKey } from '../models/infer';
import type { StepKind } from '../core/step';

// ---- model worker ------------------------------------------------------------------------------
export type ModelRequest = {
  type: 'analyze';
  id: number;
  image: Blob;
  device: Device | 'auto';
  maskModel: MaskModelKey;
  workingMaxSide: number;
  ortBase: string;
};

export type ModelResponse =
  | { type: 'progress'; id: number; stage: string; file?: string; loaded?: number; total?: number }
  | { type: 'done'; id: number; raw: RawInputs; device: Device; maskModel: MaskModelKey; ms: number }
  | { type: 'error'; id: number; device: Device; message: string };

// ---- compute worker ----------------------------------------------------------------------------
/** what the Export buttons produce */
export type ExportKind = StepKind | 'stl' | '3mf' | 'png' | 'stand' | 'wedge' | 'gcode' | 'setup';
/** which G-code: one operation, or all of them in one file with tool changes */
export type GcodeOp = 'roughing' | 'finishing' | 'detail' | 'cutout' | 'all';

export type ComputeRequest =
  /** photo: the analysed photo (models: false = luminance only, enough for a lithophane); lamp: all lamp pictures side by side */
  | { type: 'inputs'; raw: RawInputs; slot: 'photo' | 'lamp'; models: boolean; panels?: number }
  | { type: 'params'; id: number; params: ReliefParams; view: 'design' | 'cut' | 'reach'; toolpaths?: boolean }
  | { type: 'export'; id: number; params: ReliefParams; kind: ExportKind; name: string; units?: 'mm' | 'in'; op?: GcodeOp }
  /** drawn text items: keep these, add those (the letters only change when the wording, font, size, spacing or arc do) */
  | { type: 'texts'; keep: string[]; add: TextMask[] }
  /** run times of each G-code pass for this surface (sent to a second worker so it never holds up the preview) */
  | { type: 'times'; id: number; params: ReliefParams; mach: MachGrid };

/** toolpaths for the 3D view: line segments in part coordinates, and estimated run times (s) */
export interface PreviewPaths {
  /** each operation in machining order with its estimated run time (s) */
  ops: { name: string; segs: Float32Array; sec: number }[];
  /** all of them in one file */
  total: number;
  /** stock top and the height of Z0 above the part bottom (mm) */
  stockTop: number;
  zeroZ: number;
}

/** lithophane mesh for the preview (decimated) */
export interface PreviewMesh {
  pos: Float32Array;
  idx: Uint32Array;
  h: Float32Array;
  topTris: number;
  upright: boolean;
  /** lamp shade: centred on its axis, so it can be spun about it */
  axis: boolean;
}

export interface ReliefStats {
  /** relief: the picture's own size on the stock (widthMm × heightMm is the stock) */
  picW?: number;
  picH?: number;
  widthMm: number;
  heightMm: number;
  zMin: number;
  zMax: number;
  nx: number;
  ny: number;
  dx: number;
  ms: number;
  iterations?: number;
  /** cutter simulation: fraction of the surface the tool cannot reach, and the most left there */
  missedFrac?: number;
  maxLeft?: number;
  /** area the detail pass works on (mm²) */
  detailArea?: number;
}

export type ComputeResponse =
  | { type: 'prepared'; mask: Grid; depth: Grid }
  | { type: 'relief'; id: number; z: Float32Array; nx: number; ny: number; stats: ReliefStats; left?: Float32Array; mesh?: PreviewMesh; paths?: PreviewPaths }
  | { type: 'exported'; id: number; kind: ExportKind; bytes: Uint8Array; info: string }
  | { type: 'progress'; id: number; message: string }
  | { type: 'times'; id: number; ops: { name: string; sec: number }[]; total: number }
  | { type: 'error'; id: number; message: string };
