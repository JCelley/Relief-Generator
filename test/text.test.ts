import { describe, it, expect } from 'vitest';
import { applyTexts, textField, textProfile, rasterKey, TEXT_STYLES, type TextItem, type TextField } from '../src/core/text';
import type { MachGrid } from '../src/core/resample';

// a "letter": a 20 × 6 mm bar drawn at 10 px/mm, with a 1 mm margin
const ppm = 10, w = 220, h = 80;
const mask = new Float32Array(w * h);
for (let j = 10; j < 70; j++) for (let i = 10; i < 210; i++) mask[j * w + i] = 1;

const item = (o: Partial<TextItem>): TextItem => ({ id: 1, text: 'I', font: 'Cinzel', size: 6, spacing: 0, arc: 0, rotation: 0, x: 0, y: 0, style: 'dome', height: 2, ...o });
const flat = (): MachGrid => {
  const nx = 401, ny = 201, dx = 0.25;
  return { nx, ny, dx, dy: dx, widthMm: 100, heightMm: 50, z: new Float32Array(nx * ny).fill(3), zMin: 3, zMax: 3 };
};
const zAt = (m: MachGrid, x: number, y: number) => m.z[Math.round(y / m.dy) * m.nx + Math.round(x / m.dx)];

describe('text', () => {
  const t0 = item({});
  const fields = new Map<string, TextField>([[rasterKey(t0), textField({ key: rasterKey(t0), w, h, pxPerMm: ppm, mask })]]);

  it('measures the distance in from the edge of the letters', () => {
    const f = fields.get(rasterKey(t0))!;
    // the middle of the bar is 3 mm from its long edges
    expect(f.dist[40 * w + 110]).toBeCloseTo(3, 1);
    expect(f.dist[5 * w + 110]).toBe(0);
  });

  it('raises the letters on the base, centred where they are placed', () => {
    const m = flat();
    applyTexts(m, [item({ x: 10, y: -5 })], fields, 3);
    // centre of the stock 50, 25 → bar centred at 60, 20, 20 × 6 mm
    expect(zAt(m, 60, 20)).toBeCloseTo(5, 2);
    expect(zAt(m, 49, 20)).toBeCloseTo(3, 5);
    expect(zAt(m, 60, 24)).toBeCloseTo(3, 5);
    expect(m.zMax).toBeCloseTo(5, 2);
  });

  it('turns the letters with the rotation', () => {
    const m = flat();
    applyTexts(m, [item({ rotation: 90 })], fields, 3);
    // the bar now runs along Y: 6 wide in X, 20 long in Y
    expect(zAt(m, 50, 33)).toBeGreaterThan(4);
    expect(zAt(m, 58, 25)).toBeCloseTo(3, 5);
  });

  it('carves into whatever surface is there', () => {
    const m = flat();
    m.z.fill(10);
    applyTexts(m, [item({ style: 'engrave', height: 1.5 })], fields, 3);
    expect(zAt(m, 50, 25)).toBeCloseTo(8.5, 3);
    expect(zAt(m, 20, 10)).toBeCloseTo(10, 5);
    expect(m.zMin).toBeCloseTo(8.5, 3);
  });

  it('V-carves as a 60° V-bit would: depth = 1.73 × distance in, up to the depth', () => {
    expect(textProfile('vcarve', 0.5, 5)).toBeCloseTo(0.866, 3);
    expect(textProfile('vcarve', 10, 5)).toBe(5);
    expect(textProfile('bevel', 1, 5)).toBe(1);
    for (const [s] of TEXT_STYLES) {
      expect(textProfile(s, 0, 2)).toBe(0);
      expect(textProfile(s, 100, 2)).toBeCloseTo(2, 6);
    }
  });

  it('skips empty text and text whose letters are not drawn yet', () => {
    const m = flat();
    applyTexts(m, [item({ text: '  ' }), item({ text: 'other' })], fields, 3);
    expect(m.zMax).toBe(3);
  });
});
