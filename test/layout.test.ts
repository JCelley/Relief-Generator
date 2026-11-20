import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, type ReliefParams } from '../src/core/params';
import { toMachiningGrid } from '../src/core/resample';
import { resolveLayout, layoutActive, sdf, outlineLoop, borderProfile, makeAlong, BORDER_STYLES, type Shape } from '../src/core/layout';
import { cutoutPath } from '../src/core/cam';
import { makeGrid } from '../src/core/grid';

// a 100 × 50 mm picture: a flat plateau (height 1) everywhere
const pic = makeGrid(200, 100, 1);
const P = (o: Partial<ReliefParams>): ReliefParams => ({ ...DEFAULT_PARAMS, widthMm: 100, gridSpacing: 0.5, smoothing: 0, falloffWidth: 2, ...o });
const zAt = (m: ReturnType<typeof toMachiningGrid>, x: number, y: number) => m.z[Math.round(y / m.dy) * m.nx + Math.round(x / m.dx)];

describe('stock and layout', () => {
  it('leaves a plain picture exactly as before', () => {
    expect(layoutActive(DEFAULT_PARAMS)).toBe(false);
    const m = toMachiningGrid(pic, P({}));
    expect(m.widthMm).toBe(100);
    expect(m.heightMm).toBe(50);
    expect(zAt(m, 0, 0)).toBeCloseTo(9, 5); // no fading at the edges
  });

  it('places the part on bigger stock, off centre, and leaves the board round it uncut', () => {
    const m = toMachiningGrid(pic, P({ stockW: 200, stockH: 100, picX: 30, picY: -10 }));
    expect(m.widthMm).toBe(200);
    expect(m.heightMm).toBe(100);
    // part = picture: x 80..180, y 15..65
    expect(zAt(m, 130, 40)).toBeCloseTo(9, 3);
    expect(zAt(m, 60, 40)).toBeCloseTo(9, 5); // uncut board at the part's top
    expect(zAt(m, 130, 80)).toBeCloseTo(9, 5);
    // faded to the base at its own edges
    expect(zAt(m, 80.5, 40)).toBeLessThan(5);
    // thicker stock: the uncut board stands at its full thickness
    const t = toMachiningGrid(pic, P({ stockW: 200, stockH: 100, stockThick: 19 }));
    expect(zAt(t, 20, 50)).toBeCloseTo(19, 5);
    expect(t.zMax).toBeCloseTo(19, 5);
  });

  it('keeps the part its own size whatever the stock', () => {
    const p = P({ borderStyle: 'bead', borderWidth: 10, borderGap: 5 });
    const a = resolveLayout({ ...p, stockW: 300, stockH: 120 }, 100, 50);
    const b = resolveLayout({ ...p, stockW: 800, stockH: 400 }, 100, 50);
    expect(a.outline.a).toBeCloseTo(65, 6);
    expect(b.outline.a).toBeCloseTo(65, 6);
    expect(b.outline.b).toBeCloseTo(40, 6);
    const c = resolveLayout({ ...p, partW: 200, partH: 150, picX: 10 }, 100, 50);
    expect(c.W).toBeCloseTo(200, 6);
    expect(c.outline.cx).toBeCloseTo(110, 6);
    expect(c.pic.x0).toBeCloseTo(60, 6); // picture centred in the part
  });

  it('sizes the stock to fit the picture, border and gap', () => {
    const L = resolveLayout(P({ borderStyle: 'bead', borderWidth: 10, borderGap: 5, borderInset: 2 }), 100, 50);
    expect(L.W).toBeCloseTo(100 + 2 * 17, 6);
    expect(L.H).toBeCloseTo(50 + 2 * 17, 6);
    expect(L.window).toBeCloseTo(15, 6);
  });

  it('carves a bead border round the edge with a flat gap inside', () => {
    const p = P({ borderStyle: 'bead', borderWidth: 10, borderHeight: 4, borderGap: 5 });
    const m = toMachiningGrid(pic, p);
    expect(zAt(m, 65, 5)).toBeCloseTo(3 + 4, 2); // band centre
    expect(zAt(m, 65, 0.5)).toBeLessThan(3 + 2.5); // near the outer edge
    expect(zAt(m, 65, 12.5)).toBeCloseTo(3, 5); // the gap
    expect(zAt(m, 65, 40)).toBeCloseTo(9, 3); // the picture
    expect(m.zMax).toBeCloseTo(9, 3);
  });

  it('cuts an intaglio border in from the top', () => {
    const m = toMachiningGrid(pic, P({ borderStyle: 'flat', borderWidth: 10, borderHeight: 8, invert: true }));
    // top = base + max(relief 6, border 8) = 11; band cut 8 deep
    expect(zAt(m, 65, 5)).toBeCloseTo(3, 3);
    expect(zAt(m, 65, 12)).toBeCloseTo(11, 3);
  });

  it('clips the picture to an oval', () => {
    const m = toMachiningGrid(pic, P({ outlineShape: 'oval', stockW: 120, stockH: 80 }));
    // oval 100 × 50 in the middle of 120 × 80 stock
    expect(zAt(m, 60, 40)).toBeCloseTo(9, 3);
    expect(zAt(m, 14, 18)).toBeCloseTo(9, 5); // in the picture's box, outside the oval: uncut
    expect(zAt(m, 60, 16)).toBeLessThan(5); // just inside the oval: faded down
  });

  it('keeps every border profile between 0 and 1', () => {
    for (const [s] of BORDER_STYLES)
      for (let k = 0; k < 2000; k++) {
        const h = borderProfile(s, (k % 50) / 49, ((k * 7) % 97) / 97, 8, 12);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1 + 1e-9);
      }
  });

  it('fits a whole number of pattern repeats round an oval and along each side of a rectangle', () => {
    for (const outlineShape of ['oval', 'rounded', 'arch'] as const) {
      const L = resolveLayout(P({ outlineShape, borderStyle: 'rope', borderWidth: 10, stockW: 160, stockH: 110 }), 100, 50);
      const along = makeAlong(L);
      // walk round the centre line of the band
      const s = L.outline, loop = outlineLoop(s, -L.bw / 2);
      // the pattern phase never jumps, not even where the count wraps round
      let prev = along(loop[0][0], loop[0][1], -L.bw / 2), worst = 0, total = 0;
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k], b = loop[(k + 1) % loop.length];
        for (let t = 0.1; t < 1.05; t += 0.1) {
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          const u = along(x, y, sdf(s, x, y));
          const du = u - prev;
          worst = Math.max(worst, Math.abs(du - Math.round(du)));
          total += Math.abs(du) < 0.5 ? du : 0;
          prev = u;
        }
      }
      expect(worst).toBeLessThan(0.12); // steps are up to 0.4 mm; a seam would jump by up to half a repeat
      // a whole number of repeats in all
      expect(Math.abs(total - Math.round(total))).toBeLessThan(0.05);
      expect(total).toBeGreaterThan(10);
    }
  });

  it('starts each side of a rectangle at a corner, so the pattern mirrors at the mitres', () => {
    const R = resolveLayout(P({ borderStyle: 'pearls', borderWidth: 10, partW: 160, partH: 110 }), 100, 50);
    const al = makeAlong(R);
    // centre line of the band runs 5 mm in; its corners are (5, 5), (155, 5), (155, 105), (5, 105)
    const ph = (u: number) => Math.abs(u - Math.round(u));
    for (const [x, y, d] of [
      [5.001, 50, -5], // left side
      [155 - 0.001, 50, -5], // right side
      [80, 5.001, -5], // bottom
      [80, 105 - 0.001, -5], // top
    ]) {
      const vertical = x < 10 || x > 150;
      const ends = vertical ? [al(x, 5.2, d), al(x, 104.8, d)] : [al(5.2, y, d), al(154.8, y, d)];
      for (const u of ends) expect(ph(u)).toBeLessThan(0.05);
    }
  });
});

describe('cutout round the outline', () => {
  const tool = { type: 'flat' as const, diameter: 6.35, angle: 0 };
  const base = { tool, stockTop: 9, stepdown: 3, through: 0.3, tabs: 2, tabWidth: 6, tabHeight: 2, climb: true };

  for (const kind of ['oval', 'arch'] as const) {
    it(`keeps the tool its radius off a${kind === 'oval' ? 'n' : 'n'} ${kind} outline`, () => {
      const s: Shape = { kind, cx: 80, cy: 60, a: 70, b: 50, c: 0 };
      const loop = outlineLoop(s, 3.175);
      for (const [x, y] of loop) expect(sdf(s, x, y)).toBeCloseTo(3.175, 2);
      const p = cutoutPath({ ...base, widthMm: 140, heightMm: 100, loop });
      let tabbed = 0;
      for (let k = 0; k < p.length; k += 3) {
        expect(sdf(s, p[k], p[k + 1])).toBeGreaterThan(3.175 - 0.02);
        if (Math.abs(p[k + 2] - 2) < 1e-6) tabbed++;
      }
      expect(tabbed).toBeGreaterThan(8);
      // clockwise (climb): negative signed area
      let a = 0;
      for (let k = 0; k + 5 < p.length; k += 3) a += p[k] * p[k + 4] - p[k + 3] * p[k + 1];
      expect(a).toBeLessThan(0);
    });
  }

  it('follows a rounded, inset outline', () => {
    const s: Shape = { kind: 'rounded', cx: 80, cy: 60, a: 70, b: 50, c: 12 };
    const p = cutoutPath({ ...base, widthMm: 140, heightMm: 100, x0: 10, y0: 10, corner: 12 });
    for (let k = 0; k < p.length; k += 3) expect(sdf(s, p[k], p[k + 1])).toBeCloseTo(3.175, 2);
  });
});

describe('setup sheet with a stock layout', () => {
  it('names the stock and warns when the cutout runs past its edge', async () => {
    const { setupSheet } = await import('../src/core/setup');
    const base = { name: 'cat', units: 'mm' as const, material: 'hardwood', widthMm: 254, heightMm: 203.2, partTop: 9, base: 3, stockTop: 19, zZero: 'top' as const, safeZ: 5, toolChange: 'm6' as const, ops: [], total: 0 };
    const cut = { tabs: 2, tabW: 6, tabH: 2, through: 0.3 };
    const tight = setupSheet({ ...base, cutout: cut, layout: { room: 0, tool: 6.35, shape: 'oval', border: 'Rope' } });
    expect(tight).toContain('Stock 254.00 mm × 203.20 mm, 19.00 mm thick');
    expect(tight).toContain('runs past its edge');
    expect(tight).toContain('front-left corner of the stock');
    const roomy = setupSheet({ ...base, cutout: cut, layout: { room: 10, tool: 6.35, shape: 'oval', border: 'Rope' } });
    expect(roomy).not.toContain('runs past its edge');
    expect(roomy).toContain('Rope border');
  });
});

describe('finishing round a part on bigger stock', () => {
  it('leaves out the uncut board but not the part', async () => {
    const { topSkip } = await import('../src/core/cam');
    // a picture at half height: 3 mm under the top of the stock
    const m = toMachiningGrid(makeGrid(200, 100, 0.5), P({ stockW: 200, stockH: 100 }));
    const ball = { type: 'ball' as const, diameter: 1.5875, angle: 0 };
    const skip = topSkip(m, ball, Math.max(m.zMax, 0))!;
    const s = (x: number, y: number) => skip[Math.round(y / m.dy) * m.nx + Math.round(x / m.dx)];
    expect(s(20, 50)).toBe(1); // board left of the part (part spans x 50..150)
    expect(s(100, 50)).toBe(0); // the part's surface, below the top: finished
  });
});
