import type { MachGrid } from './resample';

/** Maps a flat-part point (x, y in the picture plane, h = height above the back) to 3D. */
export type PointMap = (x: number, y: number, h: number) => [number, number, number];

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

/**
 * Closed, watertight, manifold binary STL straight from the machining grid:
 * top = 2 triangles per grid cell, 4 side walls between the top boundary and the back (h = 0),
 * back = one strip per grid column (only the edge columns carry every row, so the back stays a
 * valid closed surface when bent). An optional map bends the part (see cylinderMap).
 * Units are mm. Outward-facing (CCW) triangles.
 */
export function writeStl(g: MachGrid, map?: PointMap): Uint8Array {
  const { nx, ny, dx, dy, z } = g;
  const W = g.widthMm;
  const H = g.heightMm;
  const X = (i: number) => (i === nx - 1 ? W : i * dx);
  const Y = (j: number) => (j === ny - 1 ? H : j * dy);
  const Z = (i: number, j: number) => z[j * nx + i];
  const P: PointMap = map ?? ((x, y, h) => [x, y, h]);

  // back: rows used by each column (all rows on the two edge columns, else bottom and top only)
  const backRows = (i: number) => (i === 0 || i === nx - 1 ? ny : 2);
  const perim = 2 * (nx - 1) + 2 * (ny - 1);
  let backTris = 0;
  for (let i = 0; i < nx - 1; i++) backTris += backRows(i) + backRows(i + 1) - 2;
  const triCount = 2 * (nx - 1) * (ny - 1) + 2 * perim + backTris;

  const buf = new ArrayBuffer(84 + 50 * triCount);
  const dv = new DataView(buf);
  const headerText = 'Relief Generator binary STL (mm)';
  for (let i = 0; i < headerText.length; i++) dv.setUint8(i, headerText.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nxv = uy * vz - uz * vy;
    let nyv = uz * vx - ux * vz;
    let nzv = ux * vy - uy * vx;
    const l = Math.hypot(nxv, nyv, nzv) || 1;
    nxv /= l; nyv /= l; nzv /= l;
    dv.setFloat32(off, nxv, true); dv.setFloat32(off + 4, nyv, true); dv.setFloat32(off + 8, nzv, true);
    dv.setFloat32(off + 12, a[0], true); dv.setFloat32(off + 16, a[1], true); dv.setFloat32(off + 20, a[2], true);
    dv.setFloat32(off + 24, b[0], true); dv.setFloat32(off + 28, b[1], true); dv.setFloat32(off + 32, b[2], true);
    dv.setFloat32(off + 36, c[0], true); dv.setFloat32(off + 40, c[1], true); dv.setFloat32(off + 44, c[2], true);
    dv.setUint16(off + 48, 0, true);
    off += 50;
  };
  const top = (i: number, j: number) => P(X(i), Y(j), Z(i, j));
  const bot = (i: number, j: number) => P(X(i), Y(j), 0);

  // top (normal +h): (i,j) (i+1,j) (i+1,j+1) and (i,j) (i+1,j+1) (i,j+1)
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = top(i, j), b = top(i + 1, j), c = top(i + 1, j + 1), d = top(i, j + 1);
      tri(a, b, c);
      tri(a, c, d);
    }
  }

  // boundary loop, counter-clockwise seen from the top side: bottom edge → right → top → left
  const loop: [number, number][] = [];
  for (let i = 0; i < nx - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) loop.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) loop.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) loop.push([0, j]);

  // walls: for CCW loop a→b, outward wall quad = a_back, b_back, b_top, a_top
  for (let k = 0; k < loop.length; k++) {
    const [ai, aj] = loop[k];
    const [bi, bj] = loop[(k + 1) % loop.length];
    const a0 = bot(ai, aj), b0 = bot(bi, bj), b1 = top(bi, bj), a1 = top(ai, aj);
    tri(a0, b0, b1);
    tri(a0, b1, a1);
  }

  // back (normal −h): zip each column strip between its left and right row lists
  const rowsOf = (i: number) => (backRows(i) === ny ? Array.from({ length: ny }, (_, j) => j) : [0, ny - 1]);
  for (let i = 0; i < nx - 1; i++) {
    const A = rowsOf(i), B = rowsOf(i + 1);
    let pa = 0, pb = 0;
    while (pa < A.length - 1 || pb < B.length - 1) {
      const advA = pb >= B.length - 1 || (pa < A.length - 1 && A[pa + 1] <= B[pb + 1]);
      if (advA) {
        tri(bot(i, A[pa]), bot(i, A[pa + 1]), bot(i + 1, B[pb]));
        pa++;
      } else {
        tri(bot(i, A[pa]), bot(i + 1, B[pb + 1]), bot(i + 1, B[pb]));
        pb++;
      }
    }
  }
  if (off !== buf.byteLength) throw new Error('STL size mismatch');
  return new Uint8Array(buf);
}
