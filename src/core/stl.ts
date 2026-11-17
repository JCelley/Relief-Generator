import type { MachGrid } from './resample';

/**
 * Closed, watertight, manifold binary STL straight from the machining grid:
 * top = 2 triangles per grid cell, 4 side walls as strips between the top
 * boundary and the z=0 boundary, bottom = fan around a centre vertex.
 * Units are mm. Outward-facing (CCW) triangles.
 */
export function writeStl(g: MachGrid): Uint8Array {
  const { nx, ny, dx, dy, z } = g;
  const W = g.widthMm;
  const H = g.heightMm;
  const perim = 2 * (nx - 1) + 2 * (ny - 1);
  const triCount = 2 * (nx - 1) * (ny - 1) + 2 * perim + perim;
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const dv = new DataView(buf);
  const headerText = 'Relief Generator binary STL (mm)';
  for (let i = 0; i < headerText.length; i++) dv.setUint8(i, headerText.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nxv = uy * vz - uz * vy;
    let nyv = uz * vx - ux * vz;
    let nzv = ux * vy - uy * vx;
    const l = Math.hypot(nxv, nyv, nzv) || 1;
    nxv /= l; nyv /= l; nzv /= l;
    dv.setFloat32(off, nxv, true); dv.setFloat32(off + 4, nyv, true); dv.setFloat32(off + 8, nzv, true);
    dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true);
    dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true);
    dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true);
    dv.setUint16(off + 48, 0, true);
    off += 50;
  };
  const X = (i: number) => (i === nx - 1 ? W : i * dx);
  const Y = (j: number) => (j === ny - 1 ? H : j * dy);
  const Z = (i: number, j: number) => z[j * nx + i];

  // top (normal +z): (i,j) (i+1,j) (i+1,j+1) and (i,j) (i+1,j+1) (i,j+1)
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      tri(X(i), Y(j), Z(i, j), X(i + 1), Y(j), Z(i + 1, j), X(i + 1), Y(j + 1), Z(i + 1, j + 1));
      tri(X(i), Y(j), Z(i, j), X(i + 1), Y(j + 1), Z(i + 1, j + 1), X(i), Y(j + 1), Z(i, j + 1));
    }
  }

  // boundary loop, counter-clockwise seen from above: bottom edge → right → top → left
  const loop: [number, number][] = [];
  for (let i = 0; i < nx - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) loop.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) loop.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) loop.push([0, j]);

  // walls: for CCW loop a→b, outward wall quad = a_bot, b_bot, b_top, a_top
  for (let k = 0; k < loop.length; k++) {
    const [ai, aj] = loop[k];
    const [bi, bj] = loop[(k + 1) % loop.length];
    const ax = X(ai), ay = Y(aj), bx = X(bi), by = Y(bj);
    tri(ax, ay, 0, bx, by, 0, bx, by, Z(bi, bj));
    tri(ax, ay, 0, bx, by, Z(bi, bj), ax, ay, Z(ai, aj));
  }

  // bottom (normal −z): fan around the centre, reversed winding
  const cx = W / 2, cy = H / 2;
  for (let k = 0; k < loop.length; k++) {
    const [ai, aj] = loop[k];
    const [bi, bj] = loop[(k + 1) % loop.length];
    tri(cx, cy, 0, X(bi), Y(bj), 0, X(ai), Y(aj), 0);
  }
  if (off !== buf.byteLength) throw new Error('STL size mismatch');
  return new Uint8Array(buf);
}
