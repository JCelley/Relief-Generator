import { describe, it, expect } from 'vitest';
import { findPlainBorder } from '../src/core/trim';

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 3);
  return d;
}
// busy "photo" content: orange with noise
const photo = (x: number, y: number): [number, number, number] => [200 + ((x * 7 + y * 13) % 50), 80 + ((x * 31) % 60), (y * 17) % 40];

describe('plain border trim', () => {
  it('finds a white matte with a soft grey shadow', () => {
    const w = 300, h = 400;
    const img = image(w, h, (x, y) => {
      const m = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (m < 12) return [255, 255, 255];
      if (m < 18) {
        const g = 255 - (m - 11) * 6; // shadow ramp
        return [g, g, g];
      }
      return photo(x, y);
    });
    const box = findPlainBorder(img, w, h, 3)!;
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(18);
    expect(box.x).toBeLessThan(24);
    expect(box.y).toBeGreaterThanOrEqual(18);
    expect(box.w).toBeLessThanOrEqual(w - 36);
  });

  it('finds black letterbox bars (top and bottom only)', () => {
    const w = 400, h = 300;
    const img = image(w, h, (x, y) => (y < 40 || y >= h - 40 ? [0, 0, 0] : photo(x, y)));
    const box = findPlainBorder(img, w, h, 3)!;
    expect(box.x).toBe(0);
    expect(box.w).toBe(w);
    expect(box.y).toBeGreaterThanOrEqual(40);
    expect(box.h).toBeLessThanOrEqual(h - 80);
  });

  it('leaves an ordinary photo with a plain sky alone', () => {
    const w = 300, h = 300;
    const img = image(w, h, (x, y) => (y < 80 ? [235, 238, 240] : photo(x, y)));
    expect(findPlainBorder(img, w, h, 3)).toBeNull();
  });
});
