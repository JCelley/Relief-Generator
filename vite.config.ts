import { defineConfig, type Plugin } from 'vitest/config';

/**
 * onnxruntime-web's JS layer only forwards a fixed list of WebGPU provider options and drops
 * `enableInt64`, so int64 ops (BiRefNet's deformable-conv index maths) fall back to the CPU at full
 * resolution and exhaust the 4 GB WASM heap. This adds that one option next to `validationMode`.
 * The build fails if the pattern is not found (e.g. after an onnxruntime-web upgrade), so it can't
 * silently stop working.
 */
function ortEnableInt64(): Plugin {
  const re = /(\w+)\.validationMode&&(\w+)\((\w+),"validationMode",\1\.validationMode,(\w+)\)/;
  return {
    name: 'ort-webgpu-enable-int64',
    enforce: 'pre',
    transform(code, id) {
      if (!/onnxruntime-web[\\/]dist[\\/]ort\.webgpu(\.bundle)?\.min\.mjs/.test(id)) return null;
      if (!re.test(code)) this.error('ort-webgpu-enable-int64: pattern not found – check onnxruntime-web version');
      return { code: code.replace(re, (m, o, f, h, a) => `${o}.enableInt64&&${f}(${h},"enableInt64","1",${a}),${m}`), map: null };
    },
  };
}

export default defineConfig({
  // relative base so the build works on GitHub Pages under /<repo>/
  base: './',
  plugins: [ortEnableInt64()],
  worker: { format: 'es', plugins: () => [ortEnableInt64()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // keep onnxruntime-web out of the dev pre-bundler so the transform above also runs in `npm run dev`
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000 },
});
