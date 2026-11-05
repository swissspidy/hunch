/**
 * The catalog as the client sees it: the manifest, and the shards loaded so far.
 *
 * Shards load lazily, by section. Every shard is checked against the manifest's embedding
 * space and hash before its vectors are used, so vectors from two models are never compared.
 */

import {
  assertManifest,
  type Manifest,
  type ShardItem,
  type ShardRef,
} from '../format/manifest.ts';
import { sha256Hex } from '../format/sha256.ts';
import { decodeShard, type DecodedShard } from '../format/shard.ts';
import { dotRow } from '../rank/vector.ts';
import { yieldToPage } from './slices.ts';

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Entry {
  item: ShardItem;
  shard: DecodedShard;
  row: number;
}

export class Catalog {
  readonly manifest: Manifest;
  readonly url: URL;
  private readonly fetch: Fetch;
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<ShardRef, Promise<void>>();
  /** Each loaded shard's entries (an id in two shards counts in the first loaded). */
  private readonly byShard = new Map<ShardRef, Entry[]>();
  private all: Entry[] | undefined;

  private constructor(manifest: Manifest, url: URL, fetchFn: Fetch) {
    this.manifest = manifest;
    this.url = url;
    this.fetch = fetchFn;
  }

  static async load(url: string | URL, fetchFn: Fetch): Promise<Catalog> {
    const resolved = new URL(url, globalThis.location?.href);
    const response = await fetchFn(resolved);
    if (!response.ok) throw new Error(`Inkling: manifest ${resolved} returned ${response.status}`);
    const manifest: unknown = await response.json();
    assertManifest(manifest);
    return new Catalog(manifest, resolved, fetchFn);
  }

  /**
   * Every loaded entry, in manifest order whatever order the shards arrived in, so ties rank
   * the same way every time.
   */
  loaded(): Entry[] {
    return (this.all ??= this.manifest.shards.flatMap((ref) => this.byShard.get(ref) ?? []));
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  /** Loads the shards of the given sections (all shards when `sections` is omitted). */
  async loadSections(sections?: readonly string[]): Promise<void> {
    const refs = this.manifest.shards.filter(
      (ref) => !sections || (ref.section !== null && sections.includes(ref.section)),
    );
    await Promise.all(refs.map((ref) => this.loadShard(ref)));
  }

  /**
   * Finds an item, loading shards until it turns up: the hinted section's first, then the rest
   * in manifest order.
   */
  async find(id: string, sectionHint?: string): Promise<Entry | undefined> {
    const known = this.entries.get(id);
    if (known) return known;
    const refs = [...this.manifest.shards].sort(
      (a, b) => Number(b.section === sectionHint) - Number(a.section === sectionHint),
    );
    for (const ref of refs) {
      await this.loadShard(ref);
      const entry = this.entries.get(id);
      if (entry) return entry;
    }
    return undefined;
  }

  /** The entry's vector, renormalized to unit length as float32. */
  vector(entry: Entry): Float32Array {
    const { shard, row } = entry;
    const out = new Float32Array(shard.dims);
    const inv = shard.invNorms[row]!;
    const base = row * shard.dims;
    for (let d = 0; d < shard.dims; d++) out[d] = shard.vectors[base + d]! * inv;
    return out;
  }

  /** Cosine similarity between a unit query vector and an entry. */
  cosine(query: Float32Array, entry: Entry): number {
    const { shard, row } = entry;
    return dotRow(query, shard.vectors, row * shard.dims, shard.dims) * shard.invNorms[row]!;
  }

  private loadShard(ref: ShardRef): Promise<void> {
    let pending = this.loading.get(ref);
    if (!pending) {
      pending = this.fetchShard(ref);
      this.loading.set(ref, pending);
      // A failed load can be retried by a later call.
      pending.catch(() => this.loading.delete(ref));
    }
    return pending;
  }

  private async fetchShard(ref: ShardRef): Promise<void> {
    const url = new URL(ref.url, this.url);
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Inkling: shard ${url} returned ${response.status}`);
    const buffer = await response.arrayBuffer();
    // Shards that arrive together are hashed, decoded and indexed in tasks of their own, so
    // none of them blocks input for long (ADR 0008).
    await yieldToPage();
    await verify(buffer, ref, url);
    await yieldToPage();
    const shard = decodeShard(buffer);
    if (shard.space !== this.manifest.space) {
      throw new Error(
        `Inkling: shard ${url} is from space ${shard.space}, not ${this.manifest.space}`,
      );
    }
    if (shard.dims !== this.manifest.dims) {
      throw new Error(`Inkling: shard ${url} has ${shard.dims} dims, not ${this.manifest.dims}`);
    }
    await yieldToPage();
    const entries: Entry[] = [];
    shard.items.forEach((item, row) => {
      if (this.entries.has(item.id)) return;
      const entry = { item, shard, row };
      this.entries.set(item.id, entry);
      entries.push(entry);
    });
    this.byShard.set(ref, entries);
    this.all = undefined;
  }
}

async function verify(buffer: ArrayBuffer, ref: ShardRef, url: URL): Promise<void> {
  const subtle = globalThis.crypto?.subtle;
  let hex: string;
  if (subtle) {
    hex = '';
    for (const byte of new Uint8Array(await subtle.digest('SHA-256', buffer))) {
      hex += byte.toString(16).padStart(2, '0');
    }
  } else {
    // SubtleCrypto is only exposed in secure contexts: plain-HTTP sites get the JS fallback.
    hex = sha256Hex(new Uint8Array(buffer));
  }
  if (hex !== ref.sha256)
    throw new Error(`Inkling: shard ${url} does not match the manifest's hash`);
}
