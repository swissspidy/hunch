/**
 * Binary vector shards (ADR 0001).
 *
 * Layout, little-endian:
 *
 *   offset  size  field
 *   0       4     magic "INKV"
 *   4       1     format version (1)
 *   5       1     quantization: 1 = int8, 2 = float32
 *   6       2     reserved (0)
 *   8       4     dims
 *   12      4     count
 *   16      4     header length H in bytes
 *   20      H     UTF-8 JSON header: { "space": string, "items": ShardItem[] }
 *   ...     0-3   zero padding to a multiple of 4 bytes from the start of the file
 *   ...           count * dims vector components, row-major: int8, or float32
 *
 * Vectors are L2-normalized before quantization. int8 rows are `round(v / max|v| * 127)`; the
 * scale is not stored because every comparison renormalizes (cosine is scale-free).
 */

import type { Quantization, ShardItem } from './manifest.ts';

const MAGIC = 0x564b4e49; // "INKV" read as little-endian u32
const FORMAT_VERSION = 1;
const FIXED_HEADER = 20;

const QUANT_CODES: Record<Quantization, number> = { int8: 1, float32: 2 };

export interface ShardHeader {
  space: string;
  items: ShardItem[];
}

export interface DecodedShard {
  space: string;
  dims: number;
  quantization: Quantization;
  items: ShardItem[];
  /** Row-major vector components (`items.length * dims`). */
  vectors: Int8Array | Float32Array;
  /** 1 / L2 norm of each stored row, so `dot(q, row) * invNorm[i]` is the cosine for a unit `q`. */
  invNorms: Float32Array;
}

/** Encodes unit vectors (one per item, `dims` long) into a shard file. */
export function encodeShard(
  header: ShardHeader,
  vectors: readonly Float32Array[],
  dims: number,
  quantization: Quantization,
): Uint8Array<ArrayBuffer> {
  if (vectors.length !== header.items.length) {
    throw new RangeError(`encodeShard: ${header.items.length} items but ${vectors.length} vectors`);
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align4(FIXED_HEADER + json.length);
  const width = quantization === 'int8' ? 1 : 4;
  const out = new Uint8Array(dataStart + vectors.length * dims * width);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, FORMAT_VERSION);
  view.setUint8(5, QUANT_CODES[quantization]);
  view.setUint32(8, dims, true);
  view.setUint32(12, vectors.length, true);
  view.setUint32(16, json.length, true);
  out.set(json, FIXED_HEADER);

  if (quantization === 'int8') {
    const rows = new Int8Array(out.buffer, dataStart, vectors.length * dims);
    vectors.forEach((v, i) => quantizeInt8(v, dims, rows, i * dims));
  } else {
    const rows = new Float32Array(out.buffer, dataStart, vectors.length * dims);
    vectors.forEach((v, i) => {
      if (v.length !== dims) throw new RangeError(`encodeShard: vector ${i} has ${v.length} dims`);
      rows.set(v, i * dims);
    });
  }
  return out;
}

/** Decodes a shard file. The returned vectors are views on `buffer` (no copy). */
export function decodeShard(buffer: ArrayBuffer): DecodedShard {
  if (buffer.byteLength < FIXED_HEADER) throw new RangeError('Inkling shard: truncated');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new TypeError('Inkling shard: bad magic');
  const version = view.getUint8(4);
  if (version !== FORMAT_VERSION) {
    throw new TypeError(`Inkling shard: format version ${version} is not supported`);
  }
  const code = view.getUint8(5);
  const quantization: Quantization | undefined =
    code === 1 ? 'int8' : code === 2 ? 'float32' : undefined;
  if (!quantization) throw new TypeError(`Inkling shard: unknown quantization ${code}`);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const headerLength = view.getUint32(16, true);
  const dataStart = align4(FIXED_HEADER + headerLength);
  const width = quantization === 'int8' ? 1 : 4;
  if (buffer.byteLength < dataStart + count * dims * width) {
    throw new RangeError('Inkling shard: truncated');
  }
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, FIXED_HEADER, headerLength)),
  ) as ShardHeader;
  if (header.items.length !== count) {
    throw new TypeError(`Inkling shard: header lists ${header.items.length} items, not ${count}`);
  }
  const vectors =
    quantization === 'int8'
      ? new Int8Array(buffer, dataStart, count * dims)
      : new Float32Array(buffer, dataStart, count * dims);
  const invNorms = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      const x = vectors[base + d]!;
      sum += x * x;
    }
    invNorms[i] = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  }
  return { space: header.space, dims, quantization, items: header.items, vectors, invNorms };
}

function quantizeInt8(v: Float32Array, dims: number, out: Int8Array, offset: number): void {
  if (v.length !== dims) throw new RangeError(`quantizeInt8: vector has ${v.length} dims`);
  let max = 0;
  for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(v[d]!));
  const scale = max > 0 ? 127 / max : 0;
  for (let d = 0; d < dims; d++) out[offset + d] = Math.round(v[d]! * scale);
}

function align4(n: number): number {
  return (n + 3) & ~3;
}
