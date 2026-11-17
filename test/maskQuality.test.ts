import { describe, it, expect } from 'vitest';
import { makeGrid } from '../src/core/grid';
import { maskQuality } from '../src/core/maskQuality';

const W = 120;
const H = 90;
function mask(f: (x: number, y: number) => number) {
  const g = makeGrid(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.data[y * W + x] = f(x, y);
  return g;
}
const disc = (x: number, y: number, cx: number, cy: number, r: number) => (Math.hypot(x - cx, y - cy) < r ? 1 : 0);

describe('mask quality', () => {
  it('accepts a clean single subject', () => {
    const q = maskQuality(mask((x, y) => disc(x, y, 60, 45, 30)));
    expect(q.suspect).toBe(false);
    expect(q.regions).toBe(1);
  });
  it('flags a mostly grey (unsure) mask', () => {
    const q = maskQuality(mask((x, y) => (disc(x, y, 60, 45, 35) ? 0.4 + 0.2 * Math.sin(x / 3) : 0)));
    expect(q.suspect).toBe(true);
    expect(q.reason).toMatch(/unsure/);
  });
  it('flags a subject that falls apart into pieces', () => {
    const q = maskQuality(mask((x, y) => disc(x, y, 20, 20, 12) || disc(x, y, 60, 60, 11) || disc(x, y, 100, 30, 12)));
    expect(q.suspect).toBe(true);
    expect(q.reason).toMatch(/pieces/);
  });
  it('flags an almost empty mask', () => {
    expect(maskQuality(mask(() => 0)).suspect).toBe(true);
  });
});
