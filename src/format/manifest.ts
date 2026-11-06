/**
 * The manifest a site publishes next to its vector shards (ADR 0001).
 *
 * The manifest is the only file a client fetches first: it names the embedding space, the
 * vector encoding and the shards. Shards have content-hashed file names and can be cached
 * forever; the manifest should be served with a short cache lifetime.
 */

/** The manifest's `format`: identifies the document. */
export const MANIFEST_FORMAT = 'inkling/manifest';
/** The manifest format version this release writes (ADR 0009, ADR 0011). */
export const MANIFEST_FORMAT_VERSION = 2;
/** The manifest format versions this release reads: its own and the previous one (ADR 0009). */
export const MANIFEST_FORMAT_VERSIONS: readonly number[] = [1, 2];

/** How the shards store vector components: int8 (the default) or float32. */
export type Quantization = 'int8' | 'float32';

/** The model that produced the catalog's vectors. */
export interface ModelInfo {
  /** Provider-specific model id, e.g. `onnx-community/embeddinggemma-300m-ONNX`. */
  id: string;
  /** Pinned revision (a commit hash for Hugging Face models). */
  revision: string;
  /** Weights variant the build ran with (e.g. `q8`); part of the space. */
  dtype?: string;
  /**
   * The ONNX file, when not the model's default one (Transformers.js's `model_file_name`, e.g.
   * `model_no_gather` for EmbeddingGemma's q4 weights, which browsers can run). Part of the space.
   */
  file?: string;
  /** The model's own output size before Matryoshka truncation. */
  nativeDims: number;
  /** Template used to turn an item into the model's input, `{title}` and `{text}` replaced. */
  documentPrompt: string;
  /**
   * Template for a search query, `{query}` replaced (EmbeddingGemma's is
   * `task: search result | query: {query}`). Optional: older manifests have none.
   */
  queryPrompt?: string;
}

/** One shard file, as the manifest lists it. */
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

/** `manifest.json`: the catalog's embedding space, encoding and shards. */
export interface Manifest {
  /** Always `inkling/manifest`. */
  format: typeof MANIFEST_FORMAT;
  /**
   * The format version; a reader refuses versions it doesn't know (ADR 0009). Version 2's
   * shards keep the per-item values in binary columns (ADR 0011); version 1's in JSON.
   */
  formatVersion: 1 | 2;
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
  /** The model the vectors come from. */
  model: ModelInfo;
  /** Dimensions of the published vectors (after truncation). */
  dims: number;
  /** How the shards store vector components. */
  quantization: Quantization;
  /** Total number of items across all shards. */
  count: number;
  /** All sections, in catalog order. */
  sections: string[];
  /** The shard files, in catalog order. */
  shards: ShardRef[];
}

/** An item's metadata as published in a shard. Text is not published. */
export interface ShardItem {
  /** The item's stable id in the catalog. */
  id: string;
  /** The item's URL. */
  url: string;
  /** The item's title. */
  title: string;
  /** The item's section, if it has one. */
  section?: string;
  /** The item's tags. */
  tags?: string[];
  /** ISO 8601 publication date. */
  date?: string;
  /** URL of the item's image. */
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
  const file = model.file ? `|file=${model.file}` : '';
  return `${model.id}@${model.revision}${dtype}${file}|native=${model.nativeDims}|dims=${dims}|prompt=${fnv1a(model.documentPrompt)}`;
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
  if (!MANIFEST_FORMAT_VERSIONS.includes(m.formatVersion as number)) {
    throw new TypeError(
      `Inkling manifest: format version ${m.formatVersion} is not supported (expected ${MANIFEST_FORMAT_VERSIONS.join(' or ')})`,
    );
  }
  if (
    typeof m.space !== 'string' ||
    typeof m.dims !== 'number' ||
    typeof m.model !== 'object' ||
    m.model === null ||
    !Array.isArray(m.shards) ||
    !m.shards.every((shard: Partial<ShardRef> | null) => typeof shard?.url === 'string')
  ) {
    throw new TypeError('Inkling manifest: missing space, dims, model or shard URLs');
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
