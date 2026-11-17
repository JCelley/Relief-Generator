/**
 * Headless tuning harness.
 *
 *   npm run tune -- --images samples/ --grid params/grid.json [--out out/tune] [--mask birefnet] [--size 1024]
 *
 * For every photo: runs the models once (cached in .cache/), then renders a
 * raking-light preview of the machining heightfield for every combination in
 * the parameter grid and assembles one labelled contact sheet per photo.
 *
 * grid.json:
 *   {
 *     "preset": "portrait",                      // optional starting preset
 *     "base":   { "widthMm": 152.4 },            // optional fixed overrides
 *     "vary":   { "compression": [0.6, 0.8], "detailGain": [1, 2] }
 *   }
 */
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import sharp from 'sharp';
import type { MaskModelKey } from '../src/models/infer';
import { prepare, computeRelief, Prepared } from '../src/core/relief';
import { arg, analyzeCached } from './common';
import { toMachiningGrid, machToImageGrid } from '../src/core/resample';
import { shadeHeightfield } from '../src/core/shade';
import { DEFAULT_PARAMS, PRESETS, PresetName, ReliefParams } from '../src/core/params';
import type { Grid } from '../src/core/grid';

const imagesDir = resolve(arg('images', 'samples')!);
const gridPath = arg('grid', 'params/grid.json')!;
const outDir = resolve(arg('out', 'out/tune')!);
const maskKey = (arg('mask', 'birefnet') as MaskModelKey) ?? 'birefnet';
const workSize = Number(arg('size', '1024'));
const tileW = Number(arg('tile', '360'));

interface GridSpec {
  preset?: PresetName;
  base?: Partial<ReliefParams>;
  vary: Record<string, (number | string | boolean)[]>;
}

function combos(vary: GridSpec['vary']): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vals] of Object.entries(vary)) {
    const next: Record<string, unknown>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next;
  }
  return out;
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

async function tile(gray: Uint8ClampedArray | Uint8Array, w: number, h: number, label: string): Promise<Buffer> {
  const th = Math.round((tileW * h) / w);
  const img = await sharp(Buffer.from(gray), { raw: { width: w, height: h, channels: 1 } })
    .resize(tileW, th)
    .toColourspace('srgb')
    .png()
    .toBuffer();
  const lines = label.split('\n');
  const lh = 15;
  const labelH = lines.length * lh + 8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#1d1d1d"/>${lines
    .map((l, i) => `<text x="6" y="${(i + 1) * lh}" font-family="monospace" font-size="12" fill="#e8e8e8">${esc(l)}</text>`)
    .join('')}</svg>`;
  return sharp({ create: { width: tileW, height: th + labelH, channels: 3, background: '#1d1d1d' } })
    .composite([
      { input: img, top: 0, left: 0 },
      { input: Buffer.from(svg), top: th, left: 0 },
    ])
    .png()
    .toBuffer();
}

function toGray(g: Grid, lo = 0, hi = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h);
  for (let i = 0; i < out.length; i++) out[i] = (255 * (g.data[i] - lo)) / (hi - lo || 1);
  return out;
}

async function sheet(tiles: Buffer[], cols: number, file: string, title: string) {
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const cellH = Math.max(...metas.map((m) => m.height ?? 0));
  const rows = Math.ceil(tiles.length / cols);
  const pad = 6;
  const titleH = 28;
  const W = cols * (tileW + pad) + pad;
  const H = titleH + rows * (cellH + pad) + pad;
  const titleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${titleH}"><text x="8" y="20" font-family="sans-serif" font-size="16" fill="#fff">${esc(title)}</text></svg>`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } })
    .composite([
      { input: Buffer.from(titleSvg), top: 0, left: 0 },
      ...tiles.map((t, i) => ({ input: t, left: pad + (i % cols) * (tileW + pad), top: titleH + pad + Math.floor(i / cols) * (cellH + pad) })),
    ])
    .jpeg({ quality: 88 })
    .toFile(file);
}

async function main() {
  const spec: GridSpec = JSON.parse(readFileSync(gridPath, 'utf8'));
  const base: ReliefParams = { ...DEFAULT_PARAMS, ...(spec.preset ? PRESETS[spec.preset] : {}), ...(spec.base ?? {}) };
  const list = combos(spec.vary);
  const files = readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (!files.length) throw new Error(`no images in ${imagesDir}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`${files.length} photos × ${list.length} combos`);

  for (const f of files) {
    console.log(`• ${f}`);
    const raw = await analyzeCached(join(imagesDir, f), maskKey, workSize);
    const prepCache = new Map<number, Prepared>();
    const tiles: Buffer[] = [];
    // reference tiles
    const p0 = prepare(raw, base.guideEps);
    prepCache.set(base.guideEps, p0);
    tiles.push(await tile(toGray(raw.luminance), raw.luminance.w, raw.luminance.h, 'photo'));
    tiles.push(await tile(toGray(p0.mask), p0.w, p0.h, `mask (${maskKey})`));
    tiles.push(await tile(toGray(p0.depth), p0.w, p0.h, 'depth (guided upsample)'));
    for (const c of list) {
      const p = { ...base, ...c } as ReliefParams;
      let prep = prepCache.get(p.guideEps);
      if (!prep) {
        prep = prepare(raw, p.guideEps);
        prepCache.set(p.guideEps, prep);
      }
      const t0 = Date.now();
      const r = computeRelief(prep, p);
      const m = toMachiningGrid(r.height, p);
      const img = machToImageGrid(m);
      const gray = shadeHeightfield(img, { pixelMm: m.dx, azimuth: 135, elevation: 22 });
      const label = Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const ms = Date.now() - t0;
      tiles.push(await tile(gray, img.w, img.h, `${label}\n${m.nx}×${m.ny} grid, ${ms} ms`));
    }
    const cols = Math.min(4, Math.ceil(Math.sqrt(tiles.length)));
    const out = join(outDir, `${basename(f, extname(f))}.jpg`);
    await sheet(tiles, cols, out, `${f} — preset ${spec.preset ?? 'default'} — ${JSON.stringify(spec.base ?? {})}`);
    console.log(`  → ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
