/**
 * The manifest a site publishes next to its vector shards (ADR 0001).
 *
 * The manifest is the only file a client fetches first: it names the embedding space, the
 * vector encoding and the shards. Shards have content-hashed file names and can be cached
 * forever; the manifest should be served with a short cache lifetime.
 */

export const MANIFEST_FORMAT = 'inkling/manifest';
export const MANIFEST_FORMAT_VERSION = 1;

export type Quantization = 'int8' | 'float32';

/** The model that produced the catalog's vectors. */
export interface ModelInfo {
  /** Provider-specific model id, e.g. `onnx-community/embeddinggemma-300m-ONNX`. */
  id: string;
  /** Pinned revision (a commit hash for Hugging Face models). */
  revision: string;
  /** Weights variant the build ran with (e.g. `q8`); informational. */
  dtype?: string;
  /** The model's own output size before Matryoshka truncation. */
  nativeDims: number;
  /** Template used to turn an item into the model's input, `{title}` and `{text}` replaced. */
  documentPrompt: string;
}

export interface ShardRef {
  /** URL of the shard, relative to the manifest's URL. */
  url: string;
  /** The catalog section this shard holds, or `null` for items without a section. */
  section: string | null;
  /** Number of items in the shard. */
  count: number;
  /** Size of the shard file in bytes. */
  bytes: number;
  /** Hex SHA-256 of the shard file. */
  sha256: string;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  /** Content hash of the space and all shards; changes whenever any vector or item changes. */
  version: string;
  /** ISO 8601 build time. */
  generatedAt: string;
  /**
   * The embedding space: vectors with different `space` strings must never be compared.
   * Derived from the model id, revision, weights variant, native and published dimensions,
   * and document prompt.
   */
  space: string;
  model: ModelInfo;
  /** Dimensions of the published vectors (after truncation). */
  dims: number;
  quantization: Quantization;
  /** Total number of items across all shards. */
  count: number;
  /** All sections, in catalog order. */
  sections: string[];
  shards: ShardRef[];
}

/** An item's metadata as published in a shard. Text is not published. */
export interface ShardItem {
  id: string;
  url: string;
  title: string;
  section?: string;
  tags?: string[];
  /** ISO 8601 publication date. */
  date?: string;
  image?: string;
  /**
   * Site-provided cold-start prior in [0, 1] (popularity or editorial order); 1 is the item
   * the site would show first.
   */
  prior: number;
}

/** Builds the `space` string. Changing any part of it means vectors are incomparable. */
export function spaceKey(model: ModelInfo, dims: number): string {
  const dtype = model.dtype ? `|dtype=${model.dtype}` : '';
  return `${model.id}@${model.revision}${dtype}|native=${model.nativeDims}|dims=${dims}|prompt=${fnv1a(model.documentPrompt)}`;
}

/** Throws unless `value` looks like a manifest this version of Inkling can read. */
export function assertManifest(value: unknown): asserts value is Manifest {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Inkling manifest: not an object');
  }
  const m = value as Partial<Manifest>;
  if (m.format !== MANIFEST_FORMAT) {
    throw new TypeError(`Inkling manifest: format is ${JSON.stringify(m.format)}`);
  }
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new TypeError(
      `Inkling manifest: format version ${m.formatVersion} is not supported (expected ${MANIFEST_FORMAT_VERSION})`,
    );
  }
  if (typeof m.space !== 'string' || typeof m.dims !== 'number' || !Array.isArray(m.shards)) {
    throw new TypeError('Inkling manifest: missing space, dims or shards');
  }
  if (m.quantization !== 'int8' && m.quantization !== 'float32') {
    throw new TypeError(`Inkling manifest: unknown quantization ${JSON.stringify(m.quantization)}`);
  }
}

/** 32-bit FNV-1a as 8 hex digits: a short, stable fingerprint (not a security hash). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
