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
export type ComputeRequest =
  | { type: 'inputs'; raw: RawInputs }
  | { type: 'params'; id: number; params: ReliefParams }
  | { type: 'export'; id: number; params: ReliefParams; kind: StepKind | 'stl'; name: string };

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
}

export type ComputeResponse =
  | { type: 'prepared'; mask: Grid; depth: Grid }
  | { type: 'relief'; id: number; z: Float32Array; nx: number; ny: number; stats: ReliefStats }
  | { type: 'exported'; id: number; kind: StepKind | 'stl'; bytes: Uint8Array; info: string }
  | { type: 'progress'; id: number; message: string }
  | { type: 'error'; id: number; message: string };
