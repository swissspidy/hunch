/**
 * Binary vector shards (ADR 0001; version 2: ADR 0011).
 *
 * Version 2, little-endian:
 *
 *   offset  size          field
 *   0       4             magic "INKV"
 *   4       1             format version (2)
 *   5       1             quantization: 1 = int8, 2 = float32
 *   6       2             reserved (0)
 *   8       4             dims
 *   12      4             count n
 *   16      4             header length H in bytes
 *   20      4             metadata length M in bytes
 *   24      H             UTF-8 JSON header: { "space": string, "sections": string[], "ids": string[] }
 *   ...     0-7           zero padding to a multiple of 8 bytes from the start of the file
 *   ...     8n            prior, float64
 *   ...     8n            publication time in ms since the epoch, float64 (NaN: no date)
 *   ...     4n            length of each item's metadata in bytes, uint32
 *   ...     2n            section: index into the header's `sections`, uint16 (0xffff: none)
 *   ...     0-3           zero padding to a multiple of 4
 *   ...                   n * dims vector components, row-major: int8, or float32
 *   ...     M             metadata: per item, UTF-8 JSON of its other published fields
 *                         ({ url, title, tags?, date?, image?, … })
 *
 * The columns are what a client reads for every item; the metadata only for items it returns,
 * so it is decoded one item at a time, on demand. Norms aren't stored: a reader computes them
 * from the rows as cheaply as it would download them. Version 1 (ADR 0001) put every item's
 * metadata in one JSON header; readers still read it (ADR 0009).
 *
 * Vectors are L2-normalized before quantization. int8 rows are `round(v / max|v| * 127)`; the
 * scale is not stored because every comparison renormalizes (cosine is scale-free).
 */

import type { Quantization, ShardItem } from './manifest.ts';

const MAGIC = 0x564b4e49; // "INKV" read as little-endian u32
/** The shard format version this release writes. */
export const SHARD_FORMAT_VERSION = 2;
const NO_SECTION = 0xffff;

const QUANT_CODES: Record<Quantization, number> = { int8: 1, float32: 2 };

/** What `encodeShard` writes: the embedding space and the items, in row order. */
export interface ShardHeader {
  /** The embedding space of the vectors (the manifest's `space`). */
  space: string;
  /** The items, in row order. */
  items: ShardItem[];
}

/** A decoded shard file. */
export interface DecodedShard {
  /** The shard format version (1 or 2). */
  version: number;
  /** The embedding space of the vectors (the manifest's `space`). */
  space: string;
  /** Components per vector. */
  dims: number;
  /** How the components are stored. */
  quantization: Quantization;
  /** Number of items. */
  count: number;
  /** The items' ids, in row order. */
  ids: string[];
  /** Each item's prior. */
  prior: Float64Array;
  /** Each item's publication time in ms since the epoch (NaN: no date). */
  time: Float64Array;
  /** The sections the items name, each once. */
  sections: string[];
  /** Each item's index in `sections` (-1: no section). */
  section: Int32Array;
  /** Row-major vector components (`count * dims`), a view on the buffer. */
  vectors: Int8Array | Float32Array;
  /** 1 / L2 norm of each stored row, so `dot(q, row) * invNorm[i]` is the cosine for a unit `q`. */
  invNorms: Float32Array;
  /** Item `i`'s published metadata, decoded on demand. */
  item(i: number): ShardItem;
  /** Every item's published metadata (decodes them all). */
  readonly items: ShardItem[];
}

/** Encodes unit vectors (one per item, `dims` long) into a shard file (version 2). */
export function encodeShard(
  header: ShardHeader,
  vectors: readonly Float32Array[],
  dims: number,
  quantization: Quantization,
): Uint8Array<ArrayBuffer> {
  const { items } = header;
  const n = items.length;
  if (vectors.length !== n) {
    throw new RangeError(`encodeShard: ${n} items but ${vectors.length} vectors`);
  }
  const encoder = new TextEncoder();
  const sections: string[] = [];
  const sectionIndex = new Map<string, number>();
  const metadata: Uint8Array[] = [];
  for (const { id: _id, section, prior: _prior, ...rest } of items) {
    if (section !== undefined && !sectionIndex.has(section)) {
      sectionIndex.set(section, sections.length);
      sections.push(section);
    }
    metadata.push(encoder.encode(JSON.stringify(rest)));
  }
  // 0xffff means no section: at most 65,535 sections.
  if (sections.length > NO_SECTION) throw new RangeError('encodeShard: too many sections');
  const json = encoder.encode(
    JSON.stringify({ space: header.space, sections, ids: items.map((item) => item.id) }),
  );
  const metaLength = metadata.reduce((sum, m) => sum + m.length, 0);
  const layout = layoutOf(json.length, n, dims, quantization);
  const out = new Uint8Array(layout.metadata + metaLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, SHARD_FORMAT_VERSION);
  view.setUint8(5, QUANT_CODES[quantization]);
  view.setUint32(8, dims, true);
  view.setUint32(12, n, true);
  view.setUint32(16, json.length, true);
  view.setUint32(20, metaLength, true);
  out.set(json, 24);

  let offset = 0;
  items.forEach((item, i) => {
    view.setFloat64(layout.prior + 8 * i, item.prior, true);
    view.setFloat64(layout.time + 8 * i, item.date ? Date.parse(item.date) : NaN, true);
    view.setUint32(layout.lengths + 4 * i, metadata[i]!.length, true);
    view.setUint16(
      layout.section + 2 * i,
      item.section === undefined ? NO_SECTION : sectionIndex.get(item.section)!,
      true,
    );
    out.set(metadata[i]!, layout.metadata + offset);
    offset += metadata[i]!.length;
  });

  const rows =
    quantization === 'int8'
      ? new Int8Array(out.buffer, layout.vectors, n * dims)
      : new Float32Array(out.buffer, layout.vectors, n * dims);
  vectors.forEach((v, i) => {
    if (v.length !== dims) throw new RangeError(`encodeShard: vector ${i} has ${v.length} dims`);
    if (quantization === 'int8') quantizeInt8(v, dims, rows as Int8Array, i * dims);
    else rows.set(v, i * dims);
  });
  return out;
}

/**
 * Decodes a shard file, version 1 or 2. The vectors are views on `buffer` (no copy); the
 * columns and metadata are copied, so `buffer` needn't outlive the vectors' use.
 */
export function decodeShard(buffer: ArrayBuffer): DecodedShard {
  const fail = (why: string): never => {
    throw new TypeError(`Inkling shard: ${why}`);
  };
  const truncated = (end: number) => {
    if (buffer.byteLength < end) fail('truncated');
  };
  truncated(24);
  const view = new DataView(buffer);
  const u32 = (at: number) => view.getUint32(at, true);
  if (u32(0) !== MAGIC) fail('bad magic');
  const version = view.getUint8(4);
  if (version !== 1 && version !== SHARD_FORMAT_VERSION) {
    fail(`format version ${version} is not supported`);
  }
  const code = view.getUint8(5);
  const quantization =
    (['int8', 'float32'] as const)[code - 1] ?? fail(`unknown quantization ${code}`);
  const dims = u32(8);
  const count = u32(12);
  const headerLength = u32(16);
  const v1 = version === 1;
  const start = v1 ? 20 : 24;
  truncated(start + headerLength);
  const decoder = new TextDecoder();
  // A header that isn't an object reads as an empty one, and fails the checks below.
  const header = (JSON.parse(decoder.decode(new Uint8Array(buffer, start, headerLength))) ??
    {}) as { space?: unknown; items?: ShardItem[]; sections?: string[]; ids?: string[] };
  const list = v1 ? header.items : header.ids;
  if (
    typeof header.space !== 'string' ||
    !Array.isArray(list) ||
    !(v1 || Array.isArray(header.sections))
  ) {
    fail(
      `the header needs ${v1 ? 'a string space and an items array' : 'a space, sections and ids'}`,
    );
  }
  if (list!.length !== count) fail(`header lists ${list!.length} items, not ${count}`);
  const layout = layoutOf(headerLength, count, dims, quantization);
  const vectorsAt = v1 ? align(20 + headerLength, 4) : layout.vectors;
  truncated(vectorsAt + count * dims * (code === 1 ? 1 : 4));
  const vectors =
    code === 1
      ? new Int8Array(buffer, vectorsAt, count * dims)
      : new Float32Array(buffer, vectorsAt, count * dims);
  const base = {
    version,
    space: header.space as string,
    dims,
    quantization,
    count,
    vectors,
    invNorms: norms(vectors, count, dims),
  };

  if (v1) {
    const items = header.items!;
    const sections: string[] = [];
    return {
      ...base,
      ids: items.map((item) => item.id),
      prior: Float64Array.from(items, (item) => item.prior),
      time: Float64Array.from(items, (item) => (item.date ? Date.parse(item.date) : NaN)),
      sections,
      section: Int32Array.from(items, ({ section }) =>
        section === undefined ? -1 : (sections.indexOf(section) + 1 || sections.push(section)) - 1,
      ),
      item: itemsReader(items),
      items,
    };
  }

  const metaLength = u32(20);
  truncated(layout.metadata + metaLength);
  const ids = header.ids!;
  const sections = header.sections!;
  // Copies, so the closures below don't keep the buffer (and its vectors) alive.
  const column = <T>(make: new (b: ArrayBuffer) => T, at: number, bytes: number) =>
    new make(buffer.slice(at, at + bytes));
  const prior = column(Float64Array, layout.prior, 8 * count);
  const lengths = column(Uint32Array, layout.lengths, 4 * count);
  const offsets = new Uint32Array(count + 1);
  let end = 0;
  lengths.forEach((length, i) => (offsets[i + 1] = end += length));
  const metadata = column(Uint8Array, layout.metadata, metaLength);
  const section = Int32Array.from(column(Uint16Array, layout.section, 2 * count), (s) =>
    s === NO_SECTION ? -1 : s < sections.length ? s : fail('a section index is out of range'),
  );
  if (end !== metaLength) fail('bad metadata lengths');
  const item = metadataReader(ids, sections, section, prior, offsets, metadata);
  return {
    ...base,
    ids,
    prior,
    time: column(Float64Array, layout.time, 8 * count),
    sections,
    section,
    item,
    get items() {
      return ids.map((_, i) => item(i));
    },
  };
}

/** Item `i` of a version 1 header (outside `decodeShard`, as `metadataReader`). */
function itemsReader(items: ShardItem[]): (i: number) => ShardItem {
  return (i) => items[i]!;
}

/**
 * Item `i`'s published metadata, decoded from the metadata bytes. A function of its own, so the
 * closure holds what it reads, not `decodeShard`'s scope (and with it the shard's buffer).
 */
function metadataReader(
  ids: string[],
  sections: string[],
  section: Int32Array,
  prior: Float64Array,
  offsets: Uint32Array,
  metadata: Uint8Array,
): (i: number) => ShardItem {
  const decoder = new TextDecoder();
  return (i) => {
    const s = section[i]!;
    return {
      id: ids[i]!,
      ...(JSON.parse(decoder.decode(metadata.subarray(offsets[i], offsets[i + 1]))) as object),
      ...(s < 0 ? {} : { section: sections[s] }),
      prior: prior[i]!,
    } as ShardItem;
  };
}

/** Byte offsets of a version 2 shard's parts. */
function layoutOf(headerLength: number, n: number, dims: number, quantization: Quantization) {
  const prior = align(24 + headerLength, 8);
  const time = prior + 8 * n;
  const lengths = time + 8 * n;
  const section = lengths + 4 * n;
  const vectors = align(section + 2 * n, 4);
  const metadata = vectors + n * dims * (quantization === 'int8' ? 1 : 4);
  return { prior, time, lengths, section, vectors, metadata };
}

/** 1 / L2 norm of each row, summed in float64 (0 for a zero row). */
function norms(vectors: Int8Array | Float32Array, count: number, dims: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      const x = vectors[base + d]!;
      sum += x * x;
    }
    out[i] = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  }
  return out;
}

function quantizeInt8(v: Float32Array, dims: number, out: Int8Array, offset: number): void {
  let max = 0;
  for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(v[d]!));
  const scale = max > 0 ? 127 / max : 0;
  for (let d = 0; d < dims; d++) out[offset + d] = Math.round(v[d]! * scale);
}

function align(n: number, to: number): number {
  return Math.ceil(n / to) * to;
}
