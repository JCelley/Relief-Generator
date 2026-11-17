import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { patchForWebGPU } from '../src/models/onnxPatch';

const require = createRequire(import.meta.url);
const MODEL = 'node_modules/@huggingface/transformers/.cache/onnx-community/BiRefNet_lite-ONNX/onnx/model.onnx';

// Runs only once the harness (npm run tune) has downloaded BiRefNet into the transformers cache.
describe.skipIf(!existsSync(MODEL))('ONNX Concat splitting (BiRefNet)', () => {
  it('produces identical outputs after the WebGPU rewrites', async () => {
    const ort = require('onnxruntime-node');
    const orig = new Uint8Array(readFileSync(MODEL));
    const { bytes, patched } = patchForWebGPU(orig, 8);
    expect(patched).toBeGreaterThan(4 + 33 + 17); // 4 wide Concats, 50 wide Splits, plus Sums and int64 Slices
    // smooth, image-like input (a bright blob on a darker background, ImageNet-normalised range)
    const S = 1024;
    const x = new Float32Array(3 * S * S);
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < S; y++)
        for (let xx = 0; xx < S; xx++) {
          const r = Math.hypot(xx - 520, y - 480) / 300;
          x[c * S * S + y * S + xx] = (r < 1 ? 1.5 - r : -1.2) + 0.2 * Math.sin(xx / 37 + c) * Math.cos(y / 23);
        }
    const run = async (model: Uint8Array) => {
      const sess = await ort.InferenceSession.create(model);
      const r = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
      const out = new Float32Array(r[sess.outputNames[0]].data as Float32Array);
      await sess.release();
      return out;
    };
    const oa = await run(orig);
    const ob = await run(bytes);
    expect(ob.length).toBe(oa.length);
    let maxDiff = 0;
    for (let i = 0; i < oa.length; i++) maxDiff = Math.max(maxDiff, Math.abs(oa[i] - ob[i]));
    expect(maxDiff).toBeLessThan(1e-4);
  }, 120000);
});
