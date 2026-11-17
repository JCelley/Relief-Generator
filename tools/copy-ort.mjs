// Copies onnxruntime-web's WASM runtime into public/ort so the app never needs a CDN (offline use).
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const src = 'node_modules/onnxruntime-web/dist';
const dst = 'public/ort';
mkdirSync(dst, { recursive: true });
for (const f of [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]) {
  const p = join(src, f);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  copyFileSync(p, join(dst, f));
}
console.log('copied onnxruntime-web wasm → public/ort');
