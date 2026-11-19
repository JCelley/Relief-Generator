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
export type ExportKind = StepKind | 'stl' | '3mf' | 'png' | 'stand';

export type ComputeRequest =
  /** photo: the analysed photo (models: false = luminance only, enough for a lithophane); lamp: all lamp pictures side by side */
  | { type: 'inputs'; raw: RawInputs; slot: 'photo' | 'lamp'; models: boolean; panels?: number }
  | { type: 'params'; id: number; params: ReliefParams; view: 'design' | 'cut' | 'reach' }
  | { type: 'export'; id: number; params: ReliefParams; kind: ExportKind; name: string };

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
}

export type ComputeResponse =
  | { type: 'prepared'; mask: Grid; depth: Grid }
  | { type: 'relief'; id: number; z: Float32Array; nx: number; ny: number; stats: ReliefStats; left?: Float32Array; mesh?: PreviewMesh }
  | { type: 'exported'; id: number; kind: ExportKind; bytes: Uint8Array; info: string }
  | { type: 'progress'; id: number; message: string }
  | { type: 'error'; id: number; message: string };
