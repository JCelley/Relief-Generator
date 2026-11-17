/**
 * Tiny ONNX (protobuf) rewriter: splits every wide Concat (many inputs) and
 * wide Split (many outputs) into a tree of smaller ops along the same axis.
 * The result is mathematically identical.
 *
 * Why: onnxruntime-web's WebGPU Concat/Split kernels bind one storage buffer
 * per input/output; BiRefNet's decoder has 16-way Concats and Splits, which
 * then need 17 buffers and fail on GPUs whose limit is 16 (most consumer GPUs,
 * e.g. NVIDIA under Chrome/D3D12). Fan <= 8 keeps every shader small.
 *
 * Only the ModelProto → GraphProto → NodeProto path is decoded; every other
 * byte (initialisers, metadata …) is copied through untouched.
 */

interface Field {
  no: number;
  wire: number;
  /** start of the tag */
  start: number;
  /** start of the payload (after length prefix for LEN fields) */
  dataStart: number;
  end: number;
}

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (;;) {
    if (pos >= b.length) throw new Error('truncated protobuf varint');
    const byte = b[pos++];
    result += (byte & 0x7f) * mul;
    if (byte < 0x80) return [result, pos];
    mul *= 128;
  }
}

function varintBytes(v: number): number[] {
  const out: number[] = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function parseFields(b: Uint8Array, start: number, end: number): Field[] {
  const fields: Field[] = [];
  let pos = start;
  while (pos < end) {
    const fStart = pos;
    let key: number;
    [key, pos] = readVarint(b, pos);
    const no = Math.floor(key / 8);
    const wire = key & 7;
    let dataStart = pos;
    switch (wire) {
      case 0:
        [, pos] = readVarint(b, pos);
        break;
      case 1:
        pos += 8;
        break;
      case 2: {
        let len: number;
        [len, dataStart] = readVarint(b, pos);
        pos = dataStart + len;
        if (pos > end) throw new Error('truncated protobuf field');
        break;
      }
      case 5:
        pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wire} at ${fStart}`);
    }
    fields.push({ no, wire, start: fStart, dataStart, end: pos });
  }
  if (pos !== end) throw new Error('protobuf parse overrun');
  return fields;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

function lenField(no: number, payload: Uint8Array | number[]): number[] {
  const p = payload instanceof Uint8Array ? Array.from(payload) : payload;
  return [...varintBytes(no * 8 + 2), ...varintBytes(p.length), ...p];
}
function strField(no: number, s: string): number[] {
  return lenField(no, Array.from(enc.encode(s)));
}

/** Concatenate chunks into one Uint8Array. */
function concatBytes(parts: (Uint8Array | number[])[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface NodeInfo {
  inputs: string[];
  outputs: string[];
  name: string;
  opType: string;
  domain?: string;
  /** raw bytes of each attribute field (tag included) */
  attrs: Uint8Array[];
  other: Uint8Array[];
}

function parseNode(b: Uint8Array, start: number, end: number): NodeInfo {
  const n: NodeInfo = { inputs: [], outputs: [], name: '', opType: '', attrs: [], other: [] };
  for (const f of parseFields(b, start, end)) {
    const s = () => dec.decode(b.subarray(f.dataStart, f.end));
    if (f.no === 1 && f.wire === 2) n.inputs.push(s());
    else if (f.no === 2 && f.wire === 2) n.outputs.push(s());
    else if (f.no === 3 && f.wire === 2) n.name = s();
    else if (f.no === 4 && f.wire === 2) n.opType = s();
    else if (f.no === 7 && f.wire === 2) n.domain = s();
    else if (f.no === 5) n.attrs.push(b.subarray(f.start, f.end));
    else n.other.push(b.subarray(f.start, f.end));
  }
  return n;
}

function encodeNode(n: NodeInfo): number[] {
  const out: number[] = [];
  for (const i of n.inputs) out.push(...strField(1, i));
  for (const o of n.outputs) out.push(...strField(2, o));
  if (n.name) out.push(...strField(3, n.name));
  out.push(...strField(4, n.opType));
  for (const a of n.attrs) out.push(...a);
  if (n.domain !== undefined) out.push(...strField(7, n.domain));
  for (const x of n.other) out.push(...x);
  return out;
}

/** Split one Concat node into a tree; returns NodeProto payloads (topologically ordered). */
function splitConcat(n: NodeInfo, maxInputs: number): number[][] {
  const nodes: number[][] = [];
  let level = n.inputs;
  let depth = 0;
  while (level.length > maxInputs) {
    const next: string[] = [];
    for (let k = 0; k < level.length; k += maxInputs) {
      const chunk = level.slice(k, k + maxInputs);
      if (chunk.length === 1) {
        next.push(chunk[0]);
        continue;
      }
      const out = `${n.outputs[0]}__split_${depth}_${k / maxInputs}`;
      nodes.push(encodeNode({ ...n, inputs: chunk, outputs: [out], name: `${n.name}__split_${depth}_${k / maxInputs}` }));
      next.push(out);
    }
    level = next;
    depth++;
  }
  nodes.push(encodeNode({ ...n, inputs: level }));
  return nodes;
}

// ---- Split ------------------------------------------------------------------------------------------

/** Read an int64 list from a TensorProto payload (raw_data or int64_data). */
function readInt64Tensor(b: Uint8Array, start: number, end: number): number[] | null {
  let dataType = 0;
  let out: number[] | null = null;
  for (const f of parseFields(b, start, end)) {
    if (f.no === 2 && f.wire === 0) dataType = readVarint(b, f.dataStart)[0];
    else if (f.no === 9 && f.wire === 2) {
      const dv = new DataView(b.buffer, b.byteOffset + f.dataStart, f.end - f.dataStart);
      out = [];
      for (let o = 0; o + 8 <= dv.byteLength; o += 8) out.push(Number(dv.getBigInt64(o, true)));
    } else if (f.no === 7 && f.wire === 2) {
      out = [];
      let pos = f.dataStart;
      while (pos < f.end) {
        let v: number;
        [v, pos] = readVarint(b, pos);
        out.push(v);
      }
    } else if (f.no === 7 && f.wire === 0) {
      (out ??= []).push(readVarint(b, f.dataStart)[0]);
    }
  }
  return dataType === 7 ? out : null;
}

/** Value of a Constant node holding an int64 tensor (attribute "value"), else null. */
function constantInt64(n: NodeInfo): number[] | null {
  for (const a of n.attrs) {
    const af = parseFields(a, 0, a.length);
    if (af.length !== 1) continue;
    const inner = parseFields(a, af[0].dataStart, af[0].end);
    const nameF = inner.find((f) => f.no === 1 && f.wire === 2);
    const tF = inner.find((f) => f.no === 5 && f.wire === 2);
    if (!nameF || !tF || dec.decode(a.subarray(nameF.dataStart, nameF.end)) !== 'value') continue;
    return readInt64Tensor(a, tF.dataStart, tF.end);
  }
  return null;
}

/** NodeProto payload for a Constant node holding a 1-D int64 tensor. */
function int64Constant(name: string, values: number[]): number[] {
  const raw = new Uint8Array(values.length * 8);
  const dv = new DataView(raw.buffer);
  values.forEach((v, i) => dv.setBigInt64(i * 8, BigInt(v), true));
  // TensorProto: dims=1, data_type=2 (INT64 = 7), raw_data=9
  const tensor = [...varintBytes(1 * 8 + 0), ...varintBytes(values.length), ...varintBytes(2 * 8 + 0), 7, ...lenField(9, raw)];
  // AttributeProto: name=1, t=5, type=20 (TENSOR = 4)
  const attr = [...strField(1, 'value'), ...lenField(5, tensor), ...varintBytes(20 * 8 + 0), 4];
  return encodeNode({ inputs: [], outputs: [name], name, opType: 'Constant', attrs: [new Uint8Array(lenField(5, attr))], other: [] });
}

/** Split with many outputs -> a tree of Splits with fan-out <= maxOut. */
function splitSplit(n: NodeInfo, sizes: number[], maxOut: number): number[][] {
  const nodes: number[][] = [];
  let uid = 0;
  const build = (input: string, outs: string[], sz: number[]) => {
    if (outs.length <= maxOut) {
      const c = `${n.name}__sizes_${uid++}`;
      nodes.push(int64Constant(c, sz));
      nodes.push(encodeNode({ ...n, inputs: [input, c], outputs: outs, name: `${n.name}__part_${uid++}` }));
      return;
    }
    // group the outputs into <= maxOut contiguous groups
    const per = Math.ceil(outs.length / maxOut);
    const groups: { outs: string[]; sz: number[] }[] = [];
    for (let k = 0; k < outs.length; k += per) groups.push({ outs: outs.slice(k, k + per), sz: sz.slice(k, k + per) });
    const gNames = groups.map((g, i) => (g.outs.length === 1 ? g.outs[0] : `${n.name}__group_${uid}_${i}`));
    const c = `${n.name}__sizes_${uid++}`;
    nodes.push(int64Constant(c, groups.map((g) => g.sz.reduce((a, b) => a + b, 0))));
    nodes.push(encodeNode({ ...n, inputs: [input, c], outputs: gNames, name: `${n.name}__part_${uid++}` }));
    groups.forEach((g, i) => {
      if (g.outs.length > 1) build(gNames[i], g.outs, g.sz);
    });
  };
  build(n.inputs[0], n.outputs, sizes);
  return nodes;
}

// ---- Sum, Cast/Slice ----------------------------------------------------------------------------------

/** Integer attribute value (AttributeProto.i) by name, or undefined. */
function intAttr(n: NodeInfo, name: string): number | undefined {
  for (const a of n.attrs) {
    const af = parseFields(a, 0, a.length);
    if (af.length !== 1) continue;
    const inner = parseFields(a, af[0].dataStart, af[0].end);
    const nameF = inner.find((f) => f.no === 1 && f.wire === 2);
    const iF = inner.find((f) => f.no === 3 && f.wire === 0);
    if (nameF && iF && dec.decode(a.subarray(nameF.dataStart, nameF.end)) === name) return readVarint(a, iF.dataStart)[0];
  }
  return undefined;
}

/** Sum(x1..xn) -> balanced tree of binary Adds (same broadcasting semantics). */
function sumToAdds(n: NodeInfo): number[][] {
  const nodes: number[][] = [];
  let level = n.inputs;
  let k = 0;
  while (level.length > 2) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const out = `${n.outputs[0]}__add_${k}`;
      nodes.push(encodeNode({ inputs: [level[i], level[i + 1]], outputs: [out], name: `${n.name}__add_${k++}`, opType: 'Add', attrs: [], other: [] }));
      next.push(out);
    }
    level = next;
  }
  nodes.push(encodeNode({ inputs: level, outputs: n.outputs, name: n.name, opType: 'Add', attrs: [], other: [] }));
  return nodes;
}

export interface PatchResult {
  bytes: Uint8Array;
  patched: number;
}

/**
 * Rewrites, all mathematically identical:
 *  - Concat with more than `maxFan` inputs / Split with more than `maxFan` outputs -> trees of smaller ops
 *    (WebGPU binds one storage buffer per tensor; 16-way ops exceed the usual limit of 16)
 *  - Sum -> tree of Adds (no WebGPU Sum kernel)
 *  - Slice(Cast(x, to=int64)) -> Cast(Slice(x)) (no WebGPU int64 Slice kernel)
 * Without the last two, BiRefNet's deformable convolutions fall back to the CPU at full resolution
 * and exhaust the 4 GB WASM heap.
 */
export function patchForWebGPU(model: Uint8Array, maxFan = 8): PatchResult {
  const top = parseFields(model, 0, model.length);
  const graphField = top.find((f) => f.no === 7 && f.wire === 2);
  if (!graphField) throw new Error('ONNX model has no graph');
  const gFields = parseFields(model, graphField.dataStart, graphField.end);
  // pass 1: decode nodes, remember int64 constants
  const nodes = new Map<Field, NodeInfo>();
  const consts = new Map<string, number[]>();
  for (const f of gFields) {
    if (f.no !== 1 || f.wire !== 2) continue;
    const node = parseNode(model, f.dataStart, f.end);
    nodes.set(f, node);
    if (node.opType === 'Constant' && node.outputs.length === 1) {
      const v = constantInt64(node);
      if (v) consts.set(node.outputs[0], v);
    }
  }
  const producer = new Map<string, NodeInfo>();
  for (const n of nodes.values()) for (const o of n.outputs) producer.set(o, n);
  let patched = 0;
  const graphParts: (Uint8Array | number[])[] = [];
  for (const f of gFields) {
    const node = nodes.get(f);
    if (node && (node.domain ?? '') === '') {
      // Sum (no WebGPU kernel) -> balanced tree of Adds
      if (node.opType === 'Sum' && node.inputs.length >= 2) {
        for (const payload of sumToAdds(node)) graphParts.push(lenField(1, payload));
        patched++;
        continue;
      }
      // Slice(Cast(x, to=int64)) -> Cast(Slice(x)): int64 Slice has no WebGPU kernel; identical values
      if (node.opType === 'Slice' && node.inputs.length >= 3) {
        const cast = producer.get(node.inputs[0]);
        if (cast && cast.opType === 'Cast' && (cast.domain ?? '') === '' && intAttr(cast, 'to') === 7) {
          const mid = `${node.outputs[0]}__presliced`;
          graphParts.push(lenField(1, encodeNode({ ...node, inputs: [cast.inputs[0], ...node.inputs.slice(1)], outputs: [mid] })));
          graphParts.push(lenField(1, encodeNode({ ...cast, inputs: [mid], outputs: node.outputs, name: `${node.name}__cast` })));
          patched++;
          continue;
        }
      }
      if (node.opType === 'Concat' && node.inputs.length > maxFan) {
        for (const payload of splitConcat(node, maxFan)) graphParts.push(lenField(1, payload));
        patched++;
        continue;
      }
      if (node.opType === 'Split' && node.outputs.length > maxFan && node.inputs.length === 2) {
        const sizes = consts.get(node.inputs[1]);
        if (sizes && sizes.length === node.outputs.length) {
          for (const payload of splitSplit(node, sizes, maxFan)) graphParts.push(lenField(1, payload));
          patched++;
          continue;
        }
      }
    }
    graphParts.push(model.subarray(f.start, f.end));
  }
  if (!patched) return { bytes: model, patched: 0 };
  const graphPayload = concatBytes(graphParts);
  const parts: (Uint8Array | number[])[] = [];
  for (const f of top) {
    if (f === graphField) {
      parts.push(varintBytes(7 * 8 + 2), varintBytes(graphPayload.length), graphPayload);
    } else parts.push(model.subarray(f.start, f.end));
  }
  return { bytes: concatBytes(parts), patched };
}
