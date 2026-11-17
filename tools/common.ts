import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RawImage } from '@huggingface/transformers';
import { analyzePhoto, MaskModelKey } from '../src/models/infer';
import type { RawInputs } from '../src/core/relief';
import type { Grid } from '../src/core/grid';

export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const cacheDir = resolve('.cache');

function saveGrid(path: string, g: Grid | null) {
  if (!g) return;
  const head = Buffer.alloc(8);
  head.writeUInt32LE(g.w, 0);
  head.writeUInt32LE(g.h, 4);
  writeFileSync(path, Buffer.concat([head, Buffer.from(g.data.buffer, g.data.byteOffset, g.data.byteLength)]));
}

function loadGrid(path: string): Grid | null {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  const w = b.readUInt32LE(0);
  const h = b.readUInt32LE(4);
  const data = new Float32Array(b.buffer.slice(b.byteOffset + 8, b.byteOffset + 8 + w * h * 4));
  return { w, h, data };
}

/** Run the models on a photo (CPU, onnxruntime-node), cached in .cache/ by content hash. */
export async function analyzeCached(file: string, maskKey: MaskModelKey, workSize: number): Promise<RawInputs> {
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash('sha1').update(readFileSync(file)).update(`${maskKey}|${workSize}`).digest('hex').slice(0, 12);
  const base = join(cacheDir, `${basename(file, extname(file))}-${hash}`);
  const lum = loadGrid(`${base}.lum`);
  const depth = loadGrid(`${base}.depth`);
  if (lum && depth) return { luminance: lum, depth, mask: maskKey === 'none' ? null : loadGrid(`${base}.mask`) };
  const t0 = Date.now();
  const img = await RawImage.read(file);
  const raw = await analyzePhoto(img, { device: 'cpu', maskModel: maskKey, workingMaxSide: workSize });
  console.log(`  models: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  saveGrid(`${base}.lum`, raw.luminance);
  saveGrid(`${base}.depth`, raw.depth);
  saveGrid(`${base}.mask`, raw.mask);
  return raw;
}
