import { describe, it, expect } from 'vitest';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { lithophaneGrid, lithoMesh } from '../src/core/litho';
import { Mesh, meshVolume, standMesh, decimateGrid } from '../src/core/mesh';
import { meshTo3mf, heightmapPng } from '../src/core/files';
import { simulateCut, toolProfile } from '../src/core/cutter';
import { DEFAULT_PARAMS, ReliefParams } from '../src/core/params';
import type { Grid } from '../src/core/grid';
import type { MachGrid } from '../src/core/resample';

/** every edge used exactly once in each direction (closed, consistently oriented) */
function openEdges(m: Mesh): number {
  const e = new Map<string, number>();
  for (let t = 0; t < m.idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = m.idx[t + k], b = m.idx[t + ((k + 1) % 3)];
      const key = `${a},${b}`;
      e.set(key, (e.get(key) ?? 0) + 1);
    }
  let bad = 0;
  for (const [key, c] of e) {
    const [a, b] = key.split(',');
    if (c !== 1 || e.get(`${b},${a}`) !== 1) bad++;
  }
  return bad;
}

const lum: Grid = { w: 200, h: 150, data: Float32Array.from({ length: 200 * 150 }, (_, i) => (i % 200) / 200) };
const base: ReliefParams = { ...DEFAULT_PARAMS, mode: 'lithophane', widthMm: 80, lithoGrid: 0.5 };

describe('lithophane shapes', () => {
  for (const shape of ['flat', 'rounded', 'oval', 'heart', 'curved'] as const) {
    for (const hole of [0, 5]) {
      it(`${shape}${hole ? ' with hole' : ''}: closed and positive volume`, () => {
        const p = { ...base, lithoShape: shape, lithoHole: hole };
        const g = lithophaneGrid(lum, p);
        const { mesh } = lithoMesh(g, p);
        expect(openEdges(mesh)).toBe(0);
        const v = meshVolume(mesh);
        const box = g.widthMm * g.heightMm * g.zMax * (shape === 'curved' ? 1.2 : 1);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(box);
        if (shape === 'oval' && !hole) {
          // ellipse area π·a·b, mean thickness between min and max
          const area = Math.PI * (g.widthMm / 2) * (g.heightMm / 2);
          expect(v).toBeGreaterThan(area * 0.8);
          expect(v).toBeLessThan(area * 3.01);
        }
      });
    }
  }

  it('brightness changes thickness', () => {
    const a = lithophaneGrid(lum, { ...base, lithoBorder: 0 });
    const b = lithophaneGrid(lum, { ...base, lithoBorder: 0, lithoBrightness: 0.3 });
    const mean = (g: MachGrid) => g.z.reduce((s, v) => s + v, 0) / g.z.length;
    expect(mean(b)).toBeLessThan(mean(a) - 0.3);
  });
});

describe('lamp shade', () => {
  const strip: Grid = { w: 600, h: 200, data: Float32Array.from({ length: 600 * 200 }, (_, i) => ((i % 600) % 100) / 100) };
  for (const lip of [0, 8]) {
    it(`closed tube, picture outside${lip ? ', with lip' : ''}`, () => {
      const p: ReliefParams = { ...base, lithoShape: 'lamp', lampDiameter: 80, lampFitter: lip ? 'lip' : 'none', lampLip: lip };
      const g = lithophaneGrid(strip, p, 6);
      expect(g.widthMm).toBeCloseTo(Math.PI * 80, 3);
      const { mesh, upright } = lithoMesh(g, p);
      expect(upright).toBe(true);
      expect(openEdges(mesh)).toBe(0);
      const v = meshVolume(mesh);
      const shell = Math.PI * ((40 + g.zMax) ** 2 - 40 ** 2) * g.heightMm;
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(shell + (lip ? Math.PI * (40 ** 2 - 32 ** 2) * 2 : 0) + 1);
      // dividers are full thickness
      expect(g.z[Math.round(g.ny / 2) * g.nx]).toBeCloseTo(g.zMax, 3);
    });
  }
});

describe('lamp fitter', () => {
  const strip: Grid = { w: 600, h: 200, data: Float32Array.from({ length: 600 * 200 }, (_, i) => ((i % 600) % 100) / 100) };
  for (const end of ['top', 'bottom'] as const) {
    it(`ring fitter (${end}): every shell closed, hub on the bed`, () => {
      const p: ReliefParams = { ...base, lithoShape: 'lamp', lampDiameter: 80, lampFitter: 'ring', lampHole: 11.1, lampFitterEnd: end };
      const g = lithophaneGrid(strip, p, 6);
      const { mesh } = lithoMesh(g, p);
      expect(openEdges(mesh)).toBe(0);
      let zMin = Infinity, zMax = -Infinity, hubMin = Infinity;
      for (let k = 0; k < mesh.pos.length; k += 3) {
        zMin = Math.min(zMin, mesh.pos[k + 2]);
        zMax = Math.max(zMax, mesh.pos[k + 2]);
        if (Math.hypot(mesh.pos[k], mesh.pos[k + 1]) < 6) hubMin = Math.min(hubMin, mesh.pos[k + 2]);
      }
      expect(zMin).toBeCloseTo(0, 3);
      expect(zMax).toBeCloseTo(g.heightMm, 3);
      expect(hubMin).toBeCloseTo(0, 3); // washer hole rim on the bed
      expect(meshVolume(mesh)).toBeGreaterThan(0);
      // the band under the spokes is solid
      expect(g.z[2 * g.nx + 10]).toBeCloseTo(g.zMax, 3);
    });
  }
});

describe('stand', () => {
  it('closed, right volume', () => {
    const m = standMesh(100, 3.4, { depth: 30, height: 12, slotDepth: 8, tilt: 0 });
    expect(openEdges(m)).toBe(0);
    expect(meshVolume(m)).toBeCloseTo(100 * (30 * 12 - 3.4 * 8), 1);
  });
});

describe('files', () => {
  it('3MF zip holds the model', async () => {
    const p = { ...base, lithoShape: 'oval' as const };
    const { mesh } = lithoMesh(lithophaneGrid(lum, p), p);
    const z = await meshTo3mf(mesh, 'test');
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    let o = 0;
    const names: string[] = [];
    let model = '';
    while (dv.getUint32(o, true) === 0x04034b50) {
      const cs = dv.getUint32(o + 18, true), nl = dv.getUint16(o + 26, true);
      const name = new TextDecoder().decode(z.subarray(o + 30, o + 30 + nl));
      names.push(name);
      const data = inflateRawSync(z.subarray(o + 30 + nl, o + 30 + nl + cs));
      if (name === '3D/3dmodel.model') model = data.toString();
      o += 30 + nl + cs;
    }
    expect(names).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect((model.match(/<triangle /g) ?? []).length).toBe(mesh.idx.length / 3);
  });

  it('16-bit PNG height map', async () => {
    const g: MachGrid = { nx: 3, ny: 2, dx: 1, dy: 1, widthMm: 2, heightMm: 1, z: Float32Array.from([0, 1, 2, 2, 2, 2]), zMin: 0, zMax: 2 };
    const png = await heightmapPng(g);
    expect(String.fromCharCode(...png.subarray(1, 4))).toBe('PNG');
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(3);
    expect(dv.getUint32(20)).toBe(2);
    expect(png[24]).toBe(16);
    let o = 8;
    let raw: Buffer | null = null;
    while (o < png.length) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
      if (type === 'IDAT') raw = inflateSync(png.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    // top row is j = 1 (all 2 → white), bottom row 0, 1, 2
    expect([...raw!]).toEqual([0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 128, 0, 255, 255]);
  });

  it('preview decimation keeps the extent', () => {
    const g = lithophaneGrid(lum, base);
    const d = decimateGrid(g, 2000);
    expect(d.nx * d.ny).toBeLessThan(3000);
    expect(d.z[d.nx * d.ny - 1]).toBe(g.z[g.nx * g.ny - 1]);
  });
});

describe('cutter simulation', () => {
  // a 1 mm wide, 3 mm deep slot in a flat 5 mm plate, 0.1 mm grid
  const nx = 101, ny = 21, dx = 0.1;
  const z = new Float32Array(nx * ny).fill(5);
  for (let j = 0; j < ny; j++) for (let i = 45; i <= 55; i++) z[j * nx + i] = 2;
  const g: MachGrid = { nx, ny, dx, dy: dx, widthMm: 10, heightMm: 2, z, zMin: 2, zMax: 5 };
  const mid = (a: Float32Array) => a[10 * nx + 50];

  it('a ball smaller than the slot reaches the bottom', () => {
    expect(mid(simulateCut(g, { type: 'ball', diameter: 0.6, angle: 0 }).cut)).toBeCloseTo(2, 2);
  });
  it('a 3 mm ball only dips in by its sagitta', () => {
    const r = simulateCut(g, { type: 'ball', diameter: 3, angle: 0 });
    const R = 1.5;
    // the slot spans x = 4.5..5.5 (edges at ±0.55 from the centre, between grid points)
    expect(mid(r.cut)).toBeGreaterThan(5 - (R - Math.sqrt(R * R - 0.6 * 0.6)) - 0.02);
    expect(mid(r.cut)).toBeLessThan(5 - (R - Math.sqrt(R * R - 0.5 * 0.5)) + 0.02);
    expect(r.missedFrac).toBeGreaterThan(0);
  });
  it('a sharp 90° V-bit cuts a V about half the slot width deep', () => {
    const r = simulateCut(g, { type: 'vbit', diameter: 0, angle: 90 });
    expect(mid(r.cut)).toBeGreaterThan(4.35);
    expect(mid(r.cut)).toBeLessThan(4.55);
    expect(r.cut[10 * nx + 20]).toBeCloseTo(5, 3);
  });
  it('never removes design material', () => {
    const r = simulateCut(g, { type: 'taperedBall', diameter: 0.5, angle: 20 });
    for (let k = 0; k < z.length; k++) expect(r.cut[k]).toBeGreaterThanOrEqual(z[k] - 1e-5);
  });
  it('tapered ball profile is continuous', () => {
    const t = { type: 'taperedBall' as const, diameter: 1, angle: 20 };
    const rt = 0.5 * Math.cos((10 * Math.PI) / 180);
    expect(toolProfile(t, rt - 1e-6)).toBeCloseTo(toolProfile(t, rt + 1e-6), 4);
  });
});
