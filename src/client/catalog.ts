/**
 * The catalog as the client sees it: the manifest, and the shards loaded so far, as columns
 * (ADR 0010).
 *
 * Every loaded item is a row. Its vector sits in one contiguous store (WebAssembly memory where
 * it runs), and the values the ranking reads per item (norm, prior, publication time, section)
 * in typed arrays indexed by row. The published metadata (title, URL, …) is only read for the
 * items a call returns. Shards load lazily, by section, and are checked against the manifest's
 * embedding space and hash before their vectors are used, so vectors from two models are never
 * compared.
 */

import {
  assertManifest,
  type Manifest,
  type ShardItem,
  type ShardRef,
} from '../format/manifest.ts';
import { sha256Hex } from '../format/sha256.ts';
import { decodeShard } from '../format/shard.ts';
import { createVectorStore, MAX_SPAN, type VectorStore } from '../rank/kernel.ts';
import { recencyAt } from '../rank/rank.ts';
import { yieldToPage, type Pause } from './slices.ts';

/** A `fetch`-compatible function, for the client's `fetch` option. */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Multiply-adds per `dots` call, between pause checks: about a millisecond in the JavaScript
 * kernel on a slow phone. The WebAssembly kernel takes up to MAX_SPAN rows a call.
 */
const JS_WORK = 1 << 18;
/** Half-lives whose recency factors are kept at once. */
const RECENCY_CACHES = 4;
/** Rows a run of candidates may skip and still be computed in one pass (cheaper than a call). */
const GAP = 16;

export class Catalog {
  readonly manifest: Manifest;
  readonly url: URL;
  private readonly fetch: Fetch;
  private readonly store: VectorStore;
  /** Published metadata, by row. */
  private readonly items: ShardItem[] = [];
  /** 1 / L2 norm of each stored row: `dot(q, row) · invNorm` is the cosine for a unit `q`. */
  invNorm = new Float32Array(0);
  prior = new Float64Array(0);
  /** Publication time in ms (NaN: no date). */
  time = new Float64Array(0);
  /** Index into `manifest.sections` (-1: no section, or one the manifest doesn't list). */
  section = new Int32Array(0);
  private readonly ids = new Map<string, number>();
  private readonly sectionIndex: Map<string, number>;
  private readonly loading = new Map<ShardRef, Promise<void>>();
  /** Each loaded shard's rows (an id in two shards counts in the first loaded). */
  private readonly byShard = new Map<ShardRef, Int32Array>();
  private all: Int32Array | undefined;
  private scratch: Float64Array | undefined;
  /** 2^((time - t0) / half-life) per row, by half-life: see `recencies`. */
  private readonly recency = new Map<
    number,
    { t0: number; count: number; factors: Float64Array }
  >();

  private constructor(manifest: Manifest, url: URL, fetchFn: Fetch, kernel: 'wasm' | 'js') {
    this.manifest = manifest;
    this.url = url;
    this.fetch = fetchFn;
    this.store = createVectorStore(manifest.dims, manifest.quantization, kernel);
    this.sectionIndex = new Map(
      (Array.isArray(manifest.sections) ? manifest.sections : []).map((s, i) => [s, i]),
    );
  }

  static async load(
    url: string | URL,
    fetchFn: Fetch,
    kernel: 'wasm' | 'js' = 'wasm',
  ): Promise<Catalog> {
    const resolved = new URL(url, globalThis.location?.href);
    const response = await fetchFn(resolved);
    if (!response.ok) throw new Error(`Inkling: manifest ${resolved} returned ${response.status}`);
    const manifest: unknown = await response.json();
    assertManifest(manifest);
    return new Catalog(manifest, resolved, fetchFn, kernel);
  }

  /** Which similarity kernel runs: `'wasm'` (SIMD) or `'js'`. */
  get kernel(): 'wasm' | 'js' {
    return this.store.kind;
  }

  /**
   * Every loaded row, in manifest order whatever order the shards arrived in, so ties rank the
   * same way every time.
   */
  loaded(): Int32Array {
    if (!this.all) {
      const parts = this.manifest.shards.flatMap((ref) => this.byShard.get(ref) ?? []);
      const all = new Int32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.length;
      }
      this.all = all;
    }
    return this.all;
  }

  /** The row of a loaded item. */
  get(id: string): number | undefined {
    return this.ids.get(id);
  }

  /** A row's published metadata. */
  item(row: number): ShardItem {
    return this.items[row]!;
  }

  /** The row index of a section name (-1 when the manifest doesn't list it). */
  sectionOf(name: string): number {
    return this.sectionIndex.get(name) ?? -1;
  }

  /** Sections known so far: the manifest's, and any its shards add. */
  get sectionCount(): number {
    return this.sectionIndex.size;
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
  async find(id: string, sectionHint?: string): Promise<number | undefined> {
    const known = this.ids.get(id);
    if (known !== undefined) return known;
    const refs = [...this.manifest.shards].sort(
      (a, b) => Number(b.section === sectionHint) - Number(a.section === sectionHint),
    );
    for (const ref of refs) {
      await this.loadShard(ref);
      const row = this.ids.get(id);
      if (row !== undefined) return row;
    }
    return undefined;
  }

  /** The row's vector, renormalized to unit length as float32. */
  vector(row: number): Float32Array {
    const stored = this.store.row(row);
    const inv = this.invNorm[row]!;
    const out = new Float32Array(stored.length);
    for (let d = 0; d < stored.length; d++) out[d] = stored[d]! * inv;
    return out;
  }

  /** Cosine similarity between a unit query vector and one row. */
  cosine(query: Float32Array, row: number): number {
    return this.store.dot(query, row) * this.invNorm[row]!;
  }

  /**
   * The cosine of a unit query with each of `rows`, into `out` (by position in `rows`). Runs of
   * nearby rows go to the kernel in one call, with `pause` between calls (ADR 0008).
   */
  async cosines(
    query: Float32Array,
    rows: Int32Array,
    out: Float64Array,
    pause: Pause,
  ): Promise<void> {
    // Shared by every call: filled and read with no await in between.
    const scratch = (this.scratch ??= new Float64Array(MAX_SPAN));
    // Rows per call: bounded by the work, so a JavaScript call stays short however many dims.
    const span =
      this.store.kind === 'wasm'
        ? MAX_SPAN
        : Math.min(MAX_SPAN, Math.max(1, Math.floor(JS_WORK / this.manifest.dims)));
    for (let i = 0; i < rows.length;) {
      // The run: rows ascending with small gaps, at most `span` rows from first to last.
      const first = rows[i]!;
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j]! > rows[j - 1]! &&
        rows[j]! - rows[j - 1]! <= GAP &&
        rows[j]! - first < span
      ) {
        j++;
      }
      const last = rows[j - 1]!;
      this.store.dots(query, first, last + 1, scratch);
      for (let k = i; k < j; k++) {
        const row = rows[k]!;
        out[k] = scratch[row - first]! * this.invNorm[row]!;
      }
      // The slicer yields only once its time is up: a check costs a clock read.
      await pause();
      i = j;
    }
  }

  /**
   * recency(row) = 0.5^(age / half-life) for each of `rows`, into `out`. The per-row part,
   * 2^((time - t0) / half-life), is kept for the half-life, so a call costs one multiplication
   * per row instead of a power: 2^((time - t0) / h) · 2^((t0 - now) / h) is the same value
   * up to float64 rounding. Future dates give 1, no date 0, as `recencyAt`.
   */
  recencies(rows: Int32Array, now: number, halfLifeDays: number, out: Float64Array): void {
    const ms = halfLifeDays * 86_400_000;
    if (!(ms > 0) || !Number.isFinite(ms)) {
      for (let k = 0; k < rows.length; k++)
        out[k] = recencyAt(this.time[rows[k]!]!, now, halfLifeDays);
      return;
    }
    let cache = this.recency.get(halfLifeDays);
    // A new reference time once `now` drifts far from it, so 2^x stays in range.
    if (!cache || Math.abs(now - cache.t0) > 256 * ms) {
      cache = { t0: now, count: 0, factors: new Float64Array(0) };
      // A few half-lives at once, so calls that alternate between them don't rebuild.
      if (this.recency.size >= RECENCY_CACHES) {
        this.recency.delete(this.recency.keys().next().value!);
      }
      this.recency.set(halfLifeDays, cache);
    }
    const count = this.store.count;
    if (cache.count < count) {
      if (cache.factors.length < count) {
        const grown = new Float64Array(this.prior.length);
        grown.set(cache.factors.subarray(0, cache.count));
        cache.factors = grown;
      }
      for (let row = cache.count; row < count; row++) {
        const t = this.time[row]!;
        // Far future: Infinity, so the product below is clamped to 1.
        cache.factors[row] = Number.isNaN(t) ? 0 : 2 ** ((t - cache.t0) / ms);
      }
      cache.count = count;
    }
    const scale = 2 ** ((cache.t0 - now) / ms);
    const { factors } = cache;
    for (let k = 0; k < rows.length; k++) out[k] = Math.min(1, factors[rows[k]!]! * scale);
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
    if (shard.quantization !== this.manifest.quantization) {
      throw new Error(
        `Inkling: shard ${url} is ${shard.quantization}, not ${this.manifest.quantization}`,
      );
    }
    await yieldToPage();
    const count = shard.items.length;
    const first = this.store.append(shard.vectors, count);
    this.grow(first + count);
    this.invNorm.set(shard.invNorms.subarray(0, count), first);
    const rows: number[] = [];
    shard.items.forEach((item, i) => {
      const row = first + i;
      this.items[row] = item;
      this.prior[row] = item.prior;
      this.time[row] = item.date ? Date.parse(item.date) : NaN;
      this.section[row] = item.section === undefined ? -1 : this.sectionId(item.section);
      // The row stays stored either way; a duplicate id is just never a candidate.
      if (this.ids.has(item.id)) return;
      this.ids.set(item.id, row);
      rows.push(row);
    });
    this.byShard.set(ref, Int32Array.from(rows));
    this.all = undefined;
  }

  /**
   * A section's index, added when the manifest doesn't list it, so filtering by section works
   * as it did by name whatever the manifest says.
   */
  private sectionId(name: string): number {
    let index = this.sectionIndex.get(name);
    if (index === undefined) this.sectionIndex.set(name, (index = this.sectionIndex.size));
    return index;
  }

  /** Makes room in the columns for `rows` rows. */
  private grow(rows: number): void {
    if (rows <= this.prior.length) return;
    const size = Math.max(rows, Math.ceil(this.prior.length * 1.5));
    const resize = <T extends Float32Array | Float64Array | Int32Array>(
      old: T,
      make: (n: number) => T,
    ): T => {
      const grown = make(size);
      grown.set(old);
      return grown;
    };
    this.invNorm = resize(this.invNorm, (n) => new Float32Array(n));
    this.prior = resize(this.prior, (n) => new Float64Array(n));
    this.time = resize(this.time, (n) => new Float64Array(n));
    this.section = resize(this.section, (n) => new Int32Array(n));
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
