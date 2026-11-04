/**
 * Inkling's client: ranks a site's catalog in the visitor's browser, from vectors the site
 * precomputed. No model runs here, and nothing about the visitor leaves the device.
 */

import type { Manifest, ShardItem } from '../format/manifest.ts';
import { DEFAULT_WEIGHTS, rank, recency, type ScoreWeights } from '../rank/rank.ts';
import { Catalog, type Entry, type Fetch } from './catalog.ts';

export interface InklingOptions {
  /** URL of the site's `manifest.json` (relative URLs resolve against the page). */
  manifest: string | URL;
  /** Replaces `fetch` (tests, service workers, custom caching). */
  fetch?: Fetch;
  /** Clock, in epoch milliseconds (tests). */
  now?: () => number;
}

export interface RelatedOptions {
  /** How many items to return (default 5). */
  n?: number;
  /**
   * Restrict candidates to these sections; `'same'` means the item's own section. Only the
   * shards of these sections are fetched. Default: every section.
   */
  sections?: readonly string[] | 'same';
  /** Item ids to leave out (the item itself is always left out). */
  exclude?: readonly string[];
  /** MMR trade-off in [0, 1]: 0 is pure similarity (default 0.2). */
  diversity?: number;
  /** Half-life of the recency boost, in days (default 30). */
  recencyHalfLifeDays?: number;
  /** Weights of the ranking function's terms (defaults: ADR 0001). */
  weights?: Partial<ScoreWeights>;
  /** Section of the item, if known: its shard is fetched first. */
  sectionHint?: string;
}

/** Why an item was ranked where it was: the ranking function's terms. */
export interface Explanation {
  /** Cosine similarity to the query item (or, later, the visitor's profile). */
  similarity: number;
  /** Similarity rescaled over the candidates, in [0, 1]: the term the ranking uses. */
  relevance: number;
  /** Recency term in [0, 1]. */
  recency: number;
  /** The site's cold-start prior in [0, 1]. */
  prior: number;
  /** Highest similarity to an item ranked above it (the diversity penalty's input). */
  redundancy: number;
}

export interface Recommendation extends ShardItem {
  score: number;
  why: Explanation;
}

export class Inkling {
  private readonly catalog: Catalog;
  private readonly now: () => number;

  private constructor(catalog: Catalog, now: () => number) {
    this.catalog = catalog;
    this.now = now;
  }

  /** Fetches the manifest. Shards are fetched on first use. */
  static async load(options: InklingOptions): Promise<Inkling> {
    const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const catalog = await Catalog.load(options.manifest, fetchFn);
    return new Inkling(catalog, options.now ?? Date.now);
  }

  get manifest(): Manifest {
    return this.catalog.manifest;
  }

  /** Looks up an item's published metadata. */
  async item(id: string, sectionHint?: string): Promise<ShardItem | undefined> {
    return (await this.catalog.find(id, sectionHint))?.item;
  }

  /**
   * Items similar to `itemId`, by cosine similarity of their vectors, with a small recency
   * boost and MMR diversity. Uses no visitor data. Returns `[]` for an unknown item.
   */
  async related(itemId: string, options: RelatedOptions = {}): Promise<Recommendation[]> {
    const target = await this.catalog.find(itemId, options.sectionHint);
    if (!target) return [];
    const sections =
      options.sections === 'same'
        ? target.item.section === undefined
          ? []
          : [target.item.section]
        : options.sections;
    await this.catalog.loadSections(sections);

    const exclude = new Set(options.exclude);
    exclude.add(itemId);
    const pool = this.catalog
      .loaded()
      .filter(
        (e) =>
          !exclude.has(e.item.id) &&
          (!sections || (e.item.section !== undefined && sections.includes(e.item.section))),
      );
    return this.rankEntries(pool, this.catalog.vector(target), 1, options);
  }

  private rankEntries(
    pool: Entry[],
    query: Float32Array,
    confidence: number,
    options: RelatedOptions,
  ): Recommendation[] {
    const n = options.n ?? 5;
    const now = this.now();
    const halfLife = options.recencyHalfLifeDays ?? 30;
    const vectors = new Map<number, Float32Array>();
    const vectorOf = (i: number): Float32Array => {
      let v = vectors.get(i);
      if (!v) vectors.set(i, (v = this.catalog.vector(pool[i]!)));
      return v;
    };
    const ranked = rank(
      pool.map((_, i) => i),
      {
        similarity: (i) => this.catalog.cosine(query, pool[i]!),
        prior: (i) => pool[i]!.item.prior,
        recency: (i) => recency(pool[i]!.item.date, now, halfLife),
        pairwise: (i, j) => this.catalog.cosine(vectorOf(j), pool[i]!),
      },
      {
        n,
        confidence,
        weights: { ...DEFAULT_WEIGHTS, ...options.weights },
        diversity: options.diversity ?? 0.2,
        poolSize: Math.max(4 * n, 50),
      },
    );
    return ranked.map((r) => ({
      ...pool[r.index]!.item,
      score: r.score,
      why: {
        similarity: r.similarity,
        relevance: r.relevance,
        recency: r.recency,
        prior: r.prior,
        redundancy: r.redundancy,
      },
    }));
  }
}

export type { Manifest, ShardItem } from '../format/manifest.ts';
export type { ScoreWeights } from '../rank/rank.ts';
export type { Fetch } from './catalog.ts';
