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

/**
 * Gives the service worker's cache a new name on every build, so each deploy starts a fresh
 * offline cache and the old one (with all the previous build's hashed files) is deleted.
 */
function swCacheVersion(): Plugin {
  return {
    name: 'sw-cache-version',
    apply: 'build',
    async writeBundle(opts) {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const file = join(opts.dir ?? 'dist', 'sw.js');
      const src = await readFile(file, 'utf8');
      if (!src.includes("'relief-app-v1'")) this.error('sw-cache-version: cache name not found in sw.js');
      await writeFile(file, src.replace("'relief-app-v1'", `'relief-app-${Date.now().toString(36)}'`));
    },
  };
}

export default defineConfig({
  // relative base so the build works on GitHub Pages under /<repo>/
  base: './',
  plugins: [ortEnableInt64(), swCacheVersion()],
  worker: { format: 'es', plugins: () => [ortEnableInt64()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // keep onnxruntime-web out of the dev pre-bundler so the transform above also runs in `npm run dev`
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000 },
});
