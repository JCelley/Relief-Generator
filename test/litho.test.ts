import { describe, it, expect } from 'vitest';
import { lithophaneGrid, backlitBrightness } from '../src/core/litho';
import { writeStl } from '../src/core/stl';
import { DEFAULT_PARAMS } from '../src/core/params';
import type { Grid } from '../src/core/grid';

// left half black, right half white, 200 x 100 px
const lum: Grid = { w: 200, h: 100, data: Float32Array.from({ length: 200 * 100 }, (_, i) => ((i % 200) < 100 ? 0 : 1)) };
const p = { ...DEFAULT_PARAMS, mode: 'lithophane' as const, widthMm: 100, lithoMin: 0.8, lithoMax: 3, lithoBorder: 3, lithoGrid: 0.5 };

describe('lithophane', () => {
  const m = lithophaneGrid(lum, p);
  const at = (xMm: number, yMm: number) => m.z[Math.round(yMm / m.dy) * m.nx + Math.round(xMm / m.dx)];

  it('maps dark to thick and light to thin, within the set range', () => {
    expect(m.zMin).toBeCloseTo(0.8, 2);
    expect(m.zMax).toBeCloseTo(3, 2);
    expect(at(25, 25)).toBeCloseTo(3, 2); // black side
    expect(at(75, 25)).toBeCloseTo(0.8, 2); // white side
    expect(m.dx).toBeCloseTo(0.5, 2);
  });

  it('adds a full-thickness frame', () => {
    expect(at(1, 25)).toBeCloseTo(3, 2);
    expect(at(99, 25)).toBeCloseTo(3, 2);
    expect(at(75, 1)).toBeCloseTo(3, 2);
    expect(at(75, 5)).toBeCloseTo(0.8, 2);
  });

  it('exports a closed STL', () => {
    const bytes = writeStl(m);
    const n = new DataView(bytes.buffer).getUint32(80, true);
    expect(bytes.length).toBe(84 + 50 * n);
    expect(n).toBeGreaterThan(2 * (m.nx - 1) * (m.ny - 1));
  });

  it('backlit view: thin is bright, thick is dark', () => {
    expect(backlitBrightness(0.8, 0.8, 3)).toBeCloseTo(1);
    expect(backlitBrightness(3, 0.8, 3)).toBeLessThan(0.1);
  });
});
