/**
 * The manifest and shard format (ADR 0001), for tools that read or write it.
 *
 * @module @swissspidy/inkling/format
 */

export {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  assertManifest,
  fnv1a,
  spaceKey,
  type Manifest,
  type ModelInfo,
  type Quantization,
  type ShardItem,
  type ShardRef,
} from './manifest.ts';
export { decodeShard, encodeShard, type DecodedShard, type ShardHeader } from './shard.ts';
