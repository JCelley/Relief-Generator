/**
 * Headless photo → relief export (same pipeline as the web app).
 *
 *   npm run export -- --image photo.jpg [--preset portrait] [--width-in 6 | --width-mm 152.4]
 *                     [--params my.json] [--mask birefnet] [--out out/] [--kinds surface,solid,stl]
 *
 * --params: JSON file with any ReliefParams overrides (applied after the preset).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { arg, analyzeCached } from './common';
import { prepare, computeRelief } from '../src/core/relief';
import { toMachiningGrid } from '../src/core/resample';
import { fitSurface } from '../src/core/bspline';
import { writeStep } from '../src/core/step';
import { writeStl } from '../src/core/stl';
import { DEFAULT_PARAMS, PRESETS, PresetName, ReliefParams } from '../src/core/params';
import type { MaskModelKey } from '../src/models/infer';

async function main() {
  const image = arg('image');
  if (!image) throw new Error('--image is required');
  const preset = (arg('preset', 'portrait') as PresetName) ?? 'portrait';
  const p: ReliefParams = { ...DEFAULT_PARAMS, ...PRESETS[preset] };
  const paramsFile = arg('params');
  if (paramsFile) Object.assign(p, JSON.parse(readFileSync(paramsFile, 'utf8')));
  if (arg('width-in')) p.widthMm = Number(arg('width-in')) * 25.4;
  if (arg('width-mm')) p.widthMm = Number(arg('width-mm'));
  const mask = (arg('mask', 'birefnet') as MaskModelKey) ?? 'birefnet';
  const out = resolve(arg('out', 'out')!);
  const kinds = (arg('kinds', 'surface,solid,stl') ?? '').split(',');
  mkdirSync(out, { recursive: true });
  const name = basename(image, extname(image)).replace(/[^\w.-]+/g, '_');

  const raw = await analyzeCached(resolve(image), mask, 1024);
  let t = Date.now();
  const r = computeRelief(prepare(raw, p.guideEps), p);
  const m = toMachiningGrid(r.height, p);
  console.log(
    `relief ${m.widthMm.toFixed(1)} × ${m.heightMm.toFixed(1)} mm, Z ${m.zMin.toFixed(2)}–${m.zMax.toFixed(2)} mm, grid ${m.nx}×${m.ny} @ ${m.dx.toFixed(3)} mm (${Date.now() - t} ms)`,
  );
  if (kinds.includes('stl')) {
    const f = join(out, `${name}.stl`);
    writeFileSync(f, writeStl(m));
    console.log(`→ ${f}`);
  }
  if (kinds.includes('surface') || kinds.includes('solid')) {
    t = Date.now();
    const s = fitSurface(m, { tolerance: p.fitTolerance });
    console.log(`B-spline ${s.nu}×${s.nv} poles, max dev ${s.maxError.toFixed(4)} mm, rms ${s.rmsError.toFixed(4)} mm (${Date.now() - t} ms)`);
    for (const k of ['surface', 'solid'] as const) {
      if (!kinds.includes(k)) continue;
      const f = join(out, `${name}_${k}.step`);
      writeFileSync(f, writeStep(s, k, { name }));
      console.log(`→ ${f}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
