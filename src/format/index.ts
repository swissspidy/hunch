/**
 * The manifest and shard format (ADR 0001), for tools that read or write it.
 *
 * @module @swissspidy/hunch/format
 */

export {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSIONS,
  assertManifest,
  fnv1a,
  spaceKey,
  type Manifest,
  type ModelInfo,
  type Quantization,
  type ShardItem,
  type ShardRef,
} from './manifest.ts';
export {
  decodeShard,
  encodeShard,
  SHARD_FORMAT_VERSION,
  type DecodedShard,
  type ShardHeader,
} from './shard.ts';
