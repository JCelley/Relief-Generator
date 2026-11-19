import type { MachGrid } from './resample';

/** Maps a flat-part point (x, y in the picture plane, h = height above the back) to 3D. */
export type PointMap = (x: number, y: number, h: number) => [number, number, number];

/**
 * Indexed, closed triangle mesh (mm). The first `topTris` triangles are the picture / relief
 * surface, and `h` holds each vertex's height above the back (−1 for vertices not on that
 * surface), so the preview can shade the picture side separately from walls and back.
 */
export interface Mesh {
  pos: Float32Array;
  idx: Uint32Array;
  h: Float32Array;
  topTris: number;
}

/** Growable mesh builder */
class MB {
  pos: number[] = [];
  h: number[] = [];
  idx: number[] = [];
  vert(p: [number, number, number], h = -1): number {
    this.pos.push(p[0], p[1], p[2]);
    this.h.push(h);
    return this.h.length - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  done(topTris: number): Mesh {
    return { pos: Float32Array.from(this.pos), idx: Uint32Array.from(this.idx), h: Float32Array.from(this.h), topTris };
  }
}

/**
 * Bends the part around a vertical cylinder of radius R (mm) for a curved lithophane, oriented to
 * print standing up: the picture's up direction becomes +Z (bottom edge on the bed), the back sits
 * on the cylinder and the picture side faces outward (−Y at the centre), reading left to right.
 * Arc length along the back equals the flat width.
 */
export function cylinderMap(widthMm: number, radius: number): PointMap {
  return (x, y, h) => {
    const th = (x - widthMm / 2) / radius;
    const r = radius + h;
    return [r * Math.sin(th), radius - r * Math.cos(th), y];
  };
}

const gridX = (g: MachGrid) => (i: number) => (i === g.nx - 1 ? g.widthMm : i * g.dx);
const gridY = (g: MachGrid) => (j: number) => (j === g.ny - 1 ? g.heightMm : j * g.dy);

/**
 * Closed mesh of a full rectangular heightfield: top = 2 triangles per grid cell, 4 side walls
 * down to the back (h = 0), back = one strip per grid column (only the edge columns carry every
 * row, so the back stays a valid closed surface when bent by `map`). Outward-facing triangles.
 */
export function heightfieldMesh(g: MachGrid, map?: PointMap): Mesh {
  const { nx, ny, z } = g;
  const X = gridX(g), Y = gridY(g);
  const P: PointMap = map ?? ((x, y, h) => [x, y, h]);
  const m = new MB();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m.vert(P(X(i), Y(j), z[j * nx + i]), z[j * nx + i]);
  const T = (i: number, j: number) => j * nx + i;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) m.quad(T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j + 1));
  const topTris = m.idx.length / 3;

  // back vertices: only on the boundary
  const B = new Int32Array(nx * ny).fill(-1);
  const bot = (i: number, j: number) => {
    const k = j * nx + i;
    if (B[k] < 0) B[k] = m.vert(P(X(i), Y(j), 0));
    return B[k];
  };
  // boundary loop, counter-clockwise seen from the top side: bottom edge → right → top → left
  const loop: [number, number][] = [];
  for (let i = 0; i < nx - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) loop.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) loop.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) loop.push([0, j]);
  for (let k = 0; k < loop.length; k++) {
    const [ai, aj] = loop[k];
    const [bi, bj] = loop[(k + 1) % loop.length];
    m.quad(bot(ai, aj), bot(bi, bj), T(bi, bj), T(ai, aj));
  }
  // back (normal −h): zip each column strip between its left and right row lists
  const rowsOf = (i: number) => (i === 0 || i === nx - 1 ? Array.from({ length: ny }, (_, j) => j) : [0, ny - 1]);
  for (let i = 0; i < nx - 1; i++) {
    const A = rowsOf(i), Bc = rowsOf(i + 1);
    let pa = 0, pb = 0;
    while (pa < A.length - 1 || pb < Bc.length - 1) {
      const advA = pb >= Bc.length - 1 || (pa < A.length - 1 && A[pa + 1] <= Bc[pb + 1]);
      if (advA) {
        m.tri(bot(i, A[pa]), bot(i, A[pa + 1]), bot(i + 1, Bc[pb]));
        pa++;
      } else {
        m.tri(bot(i, A[pa]), bot(i + 1, Bc[pb + 1]), bot(i + 1, Bc[pb]));
        pb++;
      }
    }
  }
  return m.done(topTris);
}

/**
 * Closed mesh of the part of a heightfield inside an outline. `f(x, y)` is an implicit outline
 * (negative inside, roughly mm). A grid cell is kept when its centre is inside; vertices on the
 * kept region's edge are then slid onto the outline so it comes out smooth instead of stepped.
 */
export function maskedMesh(g: MachGrid, f: (x: number, y: number) => number, map?: PointMap): Mesh {
  const { nx, ny, z, dx, dy } = g;
  const X = gridX(g), Y = gridY(g);
  const P: PointMap = map ?? ((x, y, h) => [x, y, h]);
  const cx = nx - 1, cy = ny - 1;
  const keep = new Uint8Array(cx * cy);
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) keep[j * cx + i] = f((X(i) + X(i + 1)) / 2, (Y(j) + Y(j + 1)) / 2) < 0 ? 1 : 0;
  // two cells touching only at a corner would make a pinched (non-manifold) vertex: join them
  for (let j = 0; j < cy - 1; j++)
    for (let i = 0; i < cx - 1; i++) {
      const a = keep[j * cx + i], b = keep[j * cx + i + 1], c = keep[(j + 1) * cx + i], d = keep[(j + 1) * cx + i + 1];
      if (a && d && !b && !c) keep[j * cx + i + 1] = 1;
      else if (b && c && !a && !d) keep[j * cx + i] = 1;
    }
  const K = (i: number, j: number) => i >= 0 && j >= 0 && i < cx && j < cy && keep[j * cx + i] === 1;

  // vertex positions in the picture plane, with edge vertices projected onto the outline
  const vx = new Float32Array(nx * ny), vy = new Float32Array(nx * ny);
  const maxMove = 0.7 * Math.min(dx, dy);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let x = X(i), y = Y(j);
      const cells = [K(i - 1, j - 1), K(i, j - 1), K(i - 1, j), K(i, j)];
      const nIn = cells.filter(Boolean).length;
      if (nIn > 0 && nIn < 4) {
        const e = 1e-3;
        const v = f(x, y);
        const gx = (f(x + e, y) - f(x - e, y)) / (2 * e), gy = (f(x, y + e) - f(x, y - e)) / (2 * e);
        const g2 = gx * gx + gy * gy;
        if (g2 > 1e-12) {
          let mx = (-v * gx) / g2, my = (-v * gy) / g2;
          const l = Math.hypot(mx, my);
          if (l > maxMove) { mx *= maxMove / l; my *= maxMove / l; }
          x = Math.min(g.widthMm, Math.max(0, x + mx));
          y = Math.min(g.heightMm, Math.max(0, y + my));
        }
      }
      vx[j * nx + i] = x;
      vy[j * nx + i] = y;
    }

  const m = new MB();
  const Tv = new Int32Array(nx * ny).fill(-1), Bv = new Int32Array(nx * ny).fill(-1);
  const top = (i: number, j: number) => {
    const k = j * nx + i;
    if (Tv[k] < 0) Tv[k] = m.vert(P(vx[k], vy[k], z[k]), z[k]);
    return Tv[k];
  };
  const bot = (i: number, j: number) => {
    const k = j * nx + i;
    if (Bv[k] < 0) Bv[k] = m.vert(P(vx[k], vy[k], 0));
    return Bv[k];
  };
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) if (K(i, j)) m.quad(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
  const topTris = m.idx.length / 3;
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) {
      if (!K(i, j)) continue;
      m.quad(bot(i, j), bot(i, j + 1), bot(i + 1, j + 1), bot(i + 1, j));
      // cell edges counter-clockwise; a wall wherever the neighbour across the edge is not kept
      const edges: [number, number, number, number, number, number][] = [
        [i, j, i + 1, j, i, j - 1],
        [i + 1, j, i + 1, j + 1, i + 1, j],
        [i + 1, j + 1, i, j + 1, i, j + 1],
        [i, j + 1, i, j, i - 1, j],
      ];
      for (const [ai, aj, bi, bj, ni, nj] of edges)
        if (!K(ni, nj)) m.quad(bot(ai, aj), bot(bi, bj), top(bi, bj), top(ai, aj));
    }
  return m.done(topTris);
}

/**
 * Closed lamp shade: the heightfield wrapped all the way around a vertical cylinder whose inside
 * radius is widthMm / 2π (x wraps around, the last grid column coincides with the first). The
 * picture is on the outside, upright (y → Z), base on the bed at Z = 0. Optional inward lip at
 * the bottom (width `lip`, thickness `lipT`) to sit on a puck light.
 */
export function lampMesh(g: MachGrid, lip = 0, lipT = 2): Mesh {
  const { nx, ny, z } = g;
  const R = g.widthMm / (2 * Math.PI);
  const Y = gridY(g);
  const cols = nx - 1; // column nx−1 is the seam (same place as column 0)
  const at = (i: number, r: number, y: number): [number, number, number] => {
    const th = ((i % cols) * g.dx) / R;
    return [r * Math.sin(th), -r * Math.cos(th), y];
  };
  const m = new MB();
  // outer (picture) surface
  const O = (i: number, j: number) => (i % cols) * ny + j;
  for (let i = 0; i < cols; i++) for (let j = 0; j < ny; j++) m.vert(at(i, R + z[j * nx + i], Y(j)), z[j * nx + i]);
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < ny - 1; j++) m.quad(O(i, j), O(i + 1, j), O(i + 1, j + 1), O(i, j + 1));
  const topTris = m.idx.length / 3;
  // rest of the cross-section, from the top of the inside wall down and out to the bottom edge
  const H = g.heightMm;
  const lipOn = lip > 0 && lipT < H;
  const prof: [number, number][] = lipOn
    ? [[R, H], [R, lipT], [R - lip, lipT], [R - lip, 0]]
    : [[R, H], [R, 0]];
  const np = prof.length;
  const base = m.h.length;
  for (let i = 0; i < cols; i++) for (const [r, y] of prof) m.vert(at(i, r, y));
  const Q = (i: number, k: number) => base + (i % cols) * np + k;
  for (let i = 0; i < cols; i++) {
    // top rim: outer top → inner top
    m.quad(O(i, ny - 1), O(i + 1, ny - 1), Q(i + 1, 0), Q(i, 0));
    // inside wall (and lip) going down
    for (let k = 0; k < np - 1; k++) m.quad(Q(i, k), Q(i + 1, k), Q(i + 1, k + 1), Q(i, k + 1));
    // bottom: innermost point → outer bottom
    m.quad(Q(i, np - 1), Q(i + 1, np - 1), O(i + 1, 0), O(i, 0));
  }
  const mesh = m.done(topTris);
  if (meshVolume(mesh) < 0) flip(mesh);
  return mesh;
}

/**
 * Stand for a flat lithophane: a block with a slot tilted 10° back, extruded along X.
 * `slotW` = plate thickness + clearance. Printed lying on its bottom.
 */
export function standMesh(length: number, slotW: number, opts: { depth?: number; height?: number; slotDepth?: number; tilt?: number } = {}): Mesh {
  const D = opts.depth ?? Math.max(30, slotW * 8);
  const Hb = opts.height ?? 12;
  const sd = opts.slotDepth ?? Math.min(8, Hb - 3);
  const tilt = ((opts.tilt ?? 10) * Math.PI) / 180;
  const c = D * 0.45;
  const off = sd * Math.tan(tilt);
  // cross-section in (y, z), counter-clockwise
  const poly: [number, number][] = [
    [0, 0], [D, 0], [D, Hb],
    [c + slotW / 2, Hb], [c + slotW / 2 + off, Hb - sd], [c - slotW / 2 + off, Hb - sd], [c - slotW / 2, Hb],
    [0, Hb],
  ];
  const m = new MB();
  const n = poly.length;
  for (const [y, zz] of poly) m.vert([0, y, zz]);
  for (const [y, zz] of poly) m.vert([length, y, zz]);
  const caps = earClip(poly);
  // x = 0 cap faces −X, x = L cap faces +X
  for (const [a, b, cc] of caps) {
    m.tri(a, cc, b);
    m.tri(n + a, n + b, n + cc);
  }
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    m.quad(k, k2, n + k2, n + k);
  }
  const mesh = m.done(0);
  if (meshVolume(mesh) < 0) flip(mesh);
  return mesh;
}

/** ear-clipping triangulation of a simple counter-clockwise polygon */
function earClip(poly: [number, number][]): [number, number, number][] {
  const idx = poly.map((_, i) => i);
  const out: [number, number, number][] = [];
  const cross = (a: number, b: number, c: number) =>
    (poly[b][0] - poly[a][0]) * (poly[c][1] - poly[a][1]) - (poly[b][1] - poly[a][1]) * (poly[c][0] - poly[a][0]);
  const inside = (p: number, a: number, b: number, c: number) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      break;
    }
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

export function meshVolume(m: Mesh): number {
  const { pos, idx } = m;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v +=
      (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) /
      6;
  }
  return v;
}

function flip(m: Mesh) {
  for (let t = 0; t < m.idx.length; t += 3) {
    const b = m.idx[t + 1];
    m.idx[t + 1] = m.idx[t + 2];
    m.idx[t + 2] = b;
  }
}

/** Shifts the mesh so its lowest point is at Z = 0 and its footprint starts at X = Y = 0. */
export function placeOnBed(m: Mesh): Mesh {
  const lo = [Infinity, Infinity, Infinity];
  for (let k = 0; k < m.pos.length; k++) lo[k % 3] = Math.min(lo[k % 3], m.pos[k]);
  const pos = new Float32Array(m.pos.length);
  for (let k = 0; k < pos.length; k++) pos[k] = m.pos[k] - lo[k % 3];
  return { ...m, pos };
}

/** Binary STL (mm, outward-facing CCW triangles). */
export function meshToStl(m: Mesh): Uint8Array {
  const { pos, idx } = m;
  const triCount = idx.length / 3;
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const dv = new DataView(buf);
  const headerText = 'Relief Generator binary STL (mm)';
  for (let i = 0; i < headerText.length; i++) dv.setUint8(i, headerText.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    for (let k = 0; k < 3; k++) {
      const p = idx[t + k] * 3;
      dv.setFloat32(off + 12 + 12 * k, pos[p], true);
      dv.setFloat32(off + 16 + 12 * k, pos[p + 1], true);
      dv.setFloat32(off + 20 + 12 * k, pos[p + 2], true);
    }
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }
  return new Uint8Array(buf);
}

/** Every-other-row/column subsample of a grid (keeps the last row/column) for a lighter preview. */
export function decimateGrid(g: MachGrid, maxPoints: number): MachGrid {
  const s = Math.ceil(Math.sqrt((g.nx * g.ny) / maxPoints));
  if (s <= 1) return g;
  const pick = (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n - 1; i += s) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    // the last gap may be short; drop the one before it if it is tiny so spacing stays even
    return out;
  };
  const cols = pick(g.nx), rows = pick(g.ny);
  const nx = cols.length, ny = rows.length;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = g.z[rows[j] * g.nx + cols[i]];
  return { ...g, nx, ny, dx: g.dx * s, dy: g.dy * s, z };
}
