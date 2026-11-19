import type { Mesh } from './mesh';
import type { MachGrid } from './resample';

/** zlib ('deflate') or raw deflate via the platform CompressionStream (browsers, Node ≥ 18) */
async function compress(data: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Minimal ZIP writer (deflate), enough for 3MF packages. */
export async function zip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const comp = await compress(f.data, 'deflate-raw');
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true); // deflate
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, comp);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 3MF package (one object, mm). Smaller than STL and opens directly in current slicers. */
export async function meshTo3mf(m: Mesh, name = 'Relief'): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
      `<metadata name="Title">${name.replace(/[<>&"]/g, '_')}</metadata>\n<metadata name="Application">Relief Generator</metadata>\n` +
      '<resources><object id="1" type="model"><mesh><vertices>\n',
  );
  const f = (v: number) => (Math.round(v * 1e4) / 1e4).toString();
  const { pos, idx } = m;
  let buf = '';
  for (let k = 0; k < pos.length; k += 3) {
    buf += `<vertex x="${f(pos[k])}" y="${f(pos[k + 1])}" z="${f(pos[k + 2])}"/>\n`;
    if (buf.length > 1 << 20) { chunks.push(buf); buf = ''; }
  }
  buf += '</vertices><triangles>\n';
  for (let t = 0; t < idx.length; t += 3) {
    buf += `<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>\n`;
    if (buf.length > 1 << 20) { chunks.push(buf); buf = ''; }
  }
  buf += '</triangles></mesh></object></resources>\n<build><item objectid="1"/></build>\n</model>\n';
  chunks.push(buf);
  const parts = chunks.map((c) => enc.encode(c));
  const model = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) { model.set(p, o); o += p.length; }
  const types =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zip([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

/**
 * 16-bit greyscale PNG height map of the grid: black = lowest point, white = highest, one pixel
 * per grid point, picture-up. For Vectric Aspire / Carveco / laser software; set the Z range
 * there to (zMax − zMin).
 */
export async function heightmapPng(g: MachGrid): Promise<Uint8Array> {
  const { nx, ny, z } = g;
  const span = g.zMax - g.zMin || 1;
  const raw = new Uint8Array(ny * (1 + 2 * nx));
  let o = 0;
  for (let row = 0; row < ny; row++) {
    const j = ny - 1 - row;
    raw[o++] = 0; // filter: none
    for (let i = 0; i < nx; i++) {
      const v = Math.round((65535 * (z[j * nx + i] - g.zMin)) / span);
      raw[o++] = v >> 8;
      raw[o++] = v & 0xff;
    }
  }
  const idat = await compress(raw, 'deflate');
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, nx);
  dv.setUint32(4, ny);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // greyscale
  // physical size: pixels per metre, so image editors know the scale
  const ppm = Math.round(1000 / g.dx);
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm);
  pv.setUint32(4, ppm);
  phys[8] = 1;
  const chunks = [chunk('IHDR', ihdr), chunk('pHYs', phys), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = new Uint8Array(sig.length + chunks.reduce((a, b) => a + b.length, 0));
  out.set(sig, 0);
  let p = sig.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
