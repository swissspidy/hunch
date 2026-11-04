/**
 * The build step: catalog items in, `manifest.json` and vector shards out (ADR 0001).
 *
 * Builds are incremental (only inputs missing from the embedding cache are embedded) and
 * reproducible (the same items, model and options give byte-identical output).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  spaceKey,
  type Manifest,
  type Quantization,
  type ShardItem,
  type ShardRef,
} from '../format/manifest.ts';
import { encodeShard } from '../format/shard.ts';
import { truncate } from '../rank/vector.ts';
import { EmbeddingCache } from './cache.ts';
import { documentInput, type EmbeddingProvider } from './providers/types.ts';
import { compact } from './sources/feed.ts';
import type { CatalogItem } from './types.ts';

export interface BuildOptions {
  items: readonly CatalogItem[];
  /** Directory for `manifest.json` and `shards/`. */
  outDir: string;
  provider: EmbeddingProvider;
  /** Published dimensions, at most the model's (default 256, or the model's if smaller). */
  dims?: number;
  quantization?: Quantization;
  /** Embedding cache directory; `false` for none (default `.inkling-cache`). */
  cacheDir?: string | false;
  /** One shard per section (default), or a single shard. */
  shardBy?: 'section' | 'none';
  /** Split shards larger than this (default 2000 items). */
  maxShardItems?: number;
  /** Characters of item text embedded (default 4000). */
  maxTextChars?: number;
  /** Build time; kept from the previous manifest when nothing changed. */
  now?: Date;
  log?: (message: string) => void;
}

export interface BuildResult {
  manifest: Manifest;
  /** Inputs embedded by the model in this build. */
  embedded: number;
  /** Inputs served from the embedding cache. */
  cached: number;
  /** Shard files removed (neither in this manifest nor the previous one). */
  removed: string[];
  /** Total bytes of all shards. */
  bytes: number;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const { provider, outDir } = options;
  const log = options.log ?? (() => {});
  const model = provider.model;
  const dims = options.dims ?? Math.min(256, model.nativeDims);
  const quantization = options.quantization ?? 'int8';
  if (!Number.isInteger(dims) || dims < 1 || dims > model.nativeDims) {
    throw new RangeError(`dims must be an integer from 1 to ${model.nativeDims}, not ${dims}`);
  }
  if (provider.matryoshkaDims && !provider.matryoshkaDims.includes(dims)) {
    log(
      `warning: ${model.id} was trained for ${provider.matryoshkaDims.join('/')} dims, not ${dims}`,
    );
  }
  const maxItems = options.maxShardItems ?? 2000;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new RangeError(`maxShardItems must be a positive integer, not ${maxItems}`);
  }
  const items = checkItems(options.items);
  const space = spaceKey(model, dims);

  // Embed what the cache does not have.
  const cache = await EmbeddingCache.open(
    model,
    options.cacheDir === false ? undefined : (options.cacheDir ?? '.inkling-cache'),
  );
  const maxChars = options.maxTextChars ?? 4000;
  const inputs = items.map((item) =>
    documentInput(model.documentPrompt, item.title, item.text.slice(0, maxChars)),
  );
  const keys = inputs.map((input) => cache.key(input));
  const missing = [...new Set(keys.filter((key) => !cache.get(key)))];
  if (missing.length) {
    log(`embedding ${missing.length} of ${items.length} items with ${model.id}`);
    const byKey = new Map(keys.map((key, i) => [key, inputs[i]!]));
    const vectors = await provider.embed(missing.map((key) => byKey.get(key)!));
    missing.forEach((key, i) => {
      const v = vectors[i];
      if (!v || v.length !== model.nativeDims) {
        throw new Error(
          `${model.id} returned a vector of ${v?.length} dims, not ${model.nativeDims}`,
        );
      }
      // A NaN or Infinity would normalize into a row that never ranks.
      if (!v.every((x) => Number.isFinite(x))) {
        throw new Error(`${model.id} returned a vector with a non-finite component`);
      }
      cache.set(key, v);
    });
  }
  await cache.save();
  const vectors = keys.map((key) => truncate(cache.get(key)!, dims));

  // Shards, by section, in catalog order.
  const priors = computePriors(items);
  const groups = new Map<string | null, number[]>();
  items.forEach((item, i) => {
    const section = options.shardBy === 'none' ? null : (item.section ?? null);
    let group = groups.get(section);
    if (!group) groups.set(section, (group = []));
    group.push(i);
  });
  const shardDir = join(outDir, 'shards');
  await mkdir(shardDir, { recursive: true });
  const shards: ShardRef[] = [];
  const names = new Set<string>();
  for (const [section, members] of groups) {
    for (let start = 0, part = 1; start < members.length; start += maxItems, part++) {
      const chunk = members.slice(start, start + maxItems);
      const shardItems = chunk.map((i) => publishedItem(items[i]!, priors[i]!));
      const bytes = encodeShard(
        { space, items: shardItems },
        chunk.map((i) => vectors[i]!),
        dims,
        quantization,
      );
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let base = section === null ? 'all' : slug(section);
      if (members.length > maxItems) base += `-${part}`;
      while (names.has(base)) base += '_';
      names.add(base);
      const file = `${base}.${sha256.slice(0, 12)}.ink`;
      await writeFile(join(shardDir, file), bytes);
      shards.push({
        url: `shards/${file}`,
        section,
        count: chunk.length,
        bytes: bytes.length,
        sha256,
      });
    }
  }

  // The manifest. Its time stays the previous one's when nothing changed.
  const manifestPath = join(outDir, 'manifest.json');
  const previous = await readManifest(manifestPath);
  const version = createHash('sha256')
    .update(JSON.stringify({ space, quantization, shards: shards.map((s) => s.sha256) }))
    .digest('hex')
    .slice(0, 16);
  const sections = [...groups.keys()].filter((s): s is string => s !== null);
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    generatedAt:
      previous?.version === version
        ? previous.generatedAt
        : (options.now ?? new Date()).toISOString(),
    space,
    model,
    dims,
    quantization,
    count: items.length,
    sections:
      options.shardBy === 'none'
        ? [...new Set(items.flatMap((item) => (item.section ? [item.section] : [])))]
        : sections,
    shards,
  };
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(`${manifestPath}.tmp`, manifestPath);

  // Remove shards neither manifest names: clients holding the previous one can still load it.
  const keep = new Set(
    [...shards, ...(previous?.shards ?? [])].map((s) => s.url.replace(/^shards\//, '')),
  );
  const removed: string[] = [];
  for (const file of await readdir(shardDir)) {
    if (file.endsWith('.ink') && !keep.has(file)) {
      await rm(join(shardDir, file));
      removed.push(file);
    }
  }
  return {
    manifest,
    embedded: missing.length,
    cached: items.length - missing.length,
    removed,
    bytes: shards.reduce((sum, s) => sum + s.bytes, 0),
  };
}

function checkItems(items: readonly CatalogItem[]): readonly CatalogItem[] {
  if (items.length === 0) throw new Error('The catalog is empty');
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate item id ${JSON.stringify(item.id)}`);
    seen.add(item.id);
  }
  return items;
}

/**
 * Cold-start priors in (0, 1]: by `popularity` (highest first) where items have one, then in
 * catalog order (the site's editorial order). The first item gets 1, the last 1/n.
 */
export function computePriors(items: readonly CatalogItem[]): number[] {
  const order = items.map((_, i) => i);
  order.sort((a, b) => {
    const pa = items[a]!.popularity;
    const pb = items[b]!.popularity;
    if (pa !== undefined && pb !== undefined && pa !== pb) return pb - pa;
    if (pa !== undefined && pb === undefined) return -1;
    if (pa === undefined && pb !== undefined) return 1;
    return a - b;
  });
  const priors = new Array<number>(items.length);
  order.forEach((index, rank) => (priors[index] = (items.length - rank) / items.length));
  return priors;
}

function publishedItem(item: CatalogItem, prior: number): ShardItem {
  return compact({
    id: item.id,
    url: item.url,
    title: item.title,
    section: item.section,
    tags: item.tags?.length ? item.tags : undefined,
    date: item.date,
    image: item.image,
    prior,
  });
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}
