/**
 * Inkling's client: ranks a site's catalog in the visitor's browser, from vectors the site
 * precomputed. No model runs here, and nothing about the visitor leaves the device.
 *
 * Related items use no visitor data. Personalization ("for you") records signals in the site's
 * own IndexedDB, and only once the site's consent hook says yes (ADR 0001).
 *
 * @module @swissspidy/inkling
 */

import type { Manifest, ShardItem } from '../format/manifest.ts';
import { DEFAULT_WEIGHTS, ranking, recency, type ScoreWeights } from '../rank/rank.ts';
import { normalize } from '../rank/vector.ts';
import { Catalog, type Entry, type Fetch } from './catalog.ts';
import { buildProfile, profileSimilarity, type Profile } from './profile.ts';
import { SLICE_ITEMS, slicer, type Pause } from './slices.ts';
import {
  aggregate,
  dwellWeight,
  IndexedDbStore,
  MemoryStore,
  SIGNAL_WEIGHTS,
  nextVisit,
  toPrune,
  type Aggregate,
  type Signal,
  type SignalKind,
  type SignalStore,
} from './signals.ts';

/** `true`, or a function the client asks before every read or write of signals. */
export type Consent = boolean | (() => boolean | Promise<boolean>);

/** Options for {@link Inkling.load}; all but `manifest` also for {@link Inkling.configure}. */
export interface InklingOptions {
  /** URL of the site's `manifest.json` (relative URLs resolve against the page). */
  manifest: string | URL;
  /**
   * Personalization is off until this says yes: no signal is read or written before. Whether
   * storing signals needs the visitor's consent (ePrivacy Art. 5(3)) is the site's call.
   */
  consent?: Consent;
  /** Where signals live (default: IndexedDB, database `inkling` or `inkling-<namespace>`). */
  store?: SignalStore;
  /** Keeps several catalogs on one origin apart. */
  namespace?: string;
  /** Half-life of implicit signals, in days (default 21). */
  signalHalfLifeDays?: number;
  /** Signals kept at most (default 2000). */
  maxSignals?: number;
  /** Implicit signals kept at most this many days (default 180). */
  maxSignalAgeDays?: number;
  /** Minutes without activity that end a visit (default 30), for "since your last visit". */
  visitGapMinutes?: number;
  /** Replaces `fetch` (tests, service workers, custom caching). */
  fetch?: Fetch;
  /** Clock, in epoch milliseconds (tests). */
  now?: () => number;
}

/** Options every ranking method takes. */
export interface RankingOptions {
  /** How many items to return (default 5). */
  n?: number;
  /** Item ids to leave out. */
  exclude?: readonly string[];
  /** MMR trade-off in [0, 1]: 0 is pure relevance (default 0.2). */
  diversity?: number;
  /** Half-life of the recency boost, in days (default 30). */
  recencyHalfLifeDays?: number;
  /** Weights of the ranking function's terms (defaults: ADR 0001). */
  weights?: Partial<ScoreWeights>;
}

/** Options for {@link Inkling.related}. */
export interface RelatedOptions extends RankingOptions {
  /**
   * Restrict candidates to these sections; `'same'` means the item's own section. Only the
   * shards of these sections are fetched. Default: every section.
   */
  sections?: readonly string[] | 'same';
  /** Section of the item, if known: its shard is fetched first. */
  sectionHint?: string;
}

/** Options for {@link Inkling.search}. */
export interface SearchOptions extends RankingOptions {
  /** Restrict results to these sections (only their shards are fetched). */
  sections?: readonly string[];
  /**
   * How much the visitor's profile counts, in [0, 1] (default 0: the query alone). Needs
   * consent; without a profile the query decides.
   */
  personalize?: number;
  /** Leave out items the visitor has already seen (default false: search shows everything). */
  excludeSeen?: boolean;
}

/** Options for {@link Inkling.recommend} and {@link Inkling.sinceLastVisit}. */
export interface RecommendOptions extends RankingOptions {
  /** Restrict candidates to these sections (only their shards are fetched for candidates). */
  sections?: readonly string[];
  /** Include items the visitor has already viewed (default false). */
  includeSeen?: boolean;
  /** Only items dated after this time (epoch milliseconds); undated items are left out. */
  after?: number;
}

/** An item the profile leans on: "because you read …". */
export interface Because {
  /** The item's id. */
  id: string;
  /** The item's title. */
  title: string;
  /** The item's URL. */
  url: string;
  /** Share of the recommendation's profile similarity this item accounts for, in [0, 1]. */
  share: number;
}

/** Why an item was ranked where it was: the ranking function's terms. */
export interface Explanation {
  /** Cosine similarity to the query item, or the profile similarity sim(c) for "for you". */
  similarity: number;
  /** Similarity rescaled over the candidates, in [0, 1]: the term the ranking uses. */
  relevance: number;
  /** Recency term in [0, 1]. */
  recency: number;
  /** The site's cold-start prior in [0, 1]. */
  prior: number;
  /** Highest similarity to an item ranked above it (the diversity penalty's input). */
  redundancy: number;
  /** Trust in the profile, in [0, 1): 1 for related items, 0 without signals. */
  confidence: number;
  /**
   * Share of the score that similarity contributes, in [0, 1]; the rest is the site's order
   * and recency. Low for "for you" items that are there as editors' picks.
   */
  similarityShare: number;
  /** For "for you": the visitor's items that contributed most, largest share first. */
  because: Because[];
}

/** A ranked item: its published metadata, its score, and the terms of that score. */
export interface Recommendation extends ShardItem {
  /** The ranking function's score (ADR 0001). Comparable within one result list only. */
  score: number;
  /** Why the item is ranked where it is. */
  why: Explanation;
}

/** `explain(itemId)`: how the visitor's profile sees one item. */
export interface ItemExplanation {
  /** The item's id. */
  id: string;
  /** The profile similarity sim(c), or 0 without a profile. */
  similarity: number;
  /** Trust in the profile, in [0, 1): 0 without signals. */
  confidence: number;
  /** The site's cold-start prior in [0, 1]. */
  prior: number;
  /** Recency term in [0, 1]. */
  recency: number;
  /** The visitor hid the item: it is never recommended. */
  hidden: boolean;
  /** The visitor has viewed, clicked, dwelt on or followed the item. */
  seen: boolean;
  /** The visitor's items that contribute most to the similarity, largest share first. */
  because: Because[];
  /** Signals stored. */
  signals: number;
  /** Items with signals that the current catalog no longer has. */
  missing: number;
}

/** What {@link Inkling.export} returns: everything stored about the visitor, as JSON. */
export interface SignalExport {
  /** Identifies the document. */
  format: 'inkling/signals';
  /** The export format's version. */
  formatVersion: 1;
  /** When it was exported (ISO 8601). */
  exportedAt: string;
  /** The catalog version the signals were exported next to (for the visitor's reference). */
  manifestVersion: string;
  /** Every stored signal, oldest first. */
  signals: Signal[];
}

interface Personal {
  aggregates: Map<string, Aggregate>;
  profile: Profile;
  signals: number;
}

const NO_PROFILE: Profile = {
  positive: null,
  negative: null,
  mass: 0,
  confidence: 0,
  contributors: [],
  missing: [],
};

/**
 * The client for one catalog: related items, and with consent "for you", "since your last
 * visit", search and the visitor's controls. Create it with {@link Inkling.load}, or share one
 * per manifest with {@link Inkling.shared}.
 */
export class Inkling {
  private static defaults: Omit<InklingOptions, 'manifest'> = {};
  private static instances = new Map<string, Promise<Inkling>>();

  private readonly catalog: Catalog;
  private readonly options: InklingOptions;
  private readonly store: SignalStore;
  private readonly now: () => number;
  /** Counts forget() calls, so a visit that started before one does not write after it. */
  private forgotten = 0;
  private constructor(catalog: Catalog, options: InklingOptions) {
    this.catalog = catalog;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.store =
      options.store ??
      (typeof indexedDB === 'undefined'
        ? new MemoryStore()
        : new IndexedDbStore(options.namespace ? `inkling-${options.namespace}` : 'inkling'));
  }

  /** Fetches the manifest. Shards are fetched on first use. */
  static async load(options: InklingOptions): Promise<Inkling> {
    for (const name of [
      'signalHalfLifeDays',
      'maxSignals',
      'maxSignalAgeDays',
      'visitGapMinutes',
    ] as const) {
      const value = options[name];
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
        throw new RangeError(`Inkling: ${name} must be a positive number, not ${value}`);
      }
    }
    const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const catalog = await Catalog.load(options.manifest, fetchFn);
    return new Inkling(catalog, options);
  }

  /**
   * Options for the clients that `Inkling.shared()` creates, such as the web components'. The
   * consent hook is looked up whenever it is needed, so it can be set at any time.
   */
  static configure(defaults: Omit<InklingOptions, 'manifest'>): void {
    Inkling.defaults = { ...Inkling.defaults, ...defaults };
  }

  /** One client per manifest URL, shared by everything on the page. */
  static shared(manifest: string | URL): Promise<Inkling> {
    const key = new URL(manifest, globalThis.location?.href).href;
    let instance = Inkling.instances.get(key);
    if (!instance) {
      instance = Inkling.load({
        ...Inkling.defaults,
        manifest: key,
        consent: () => evaluate(Inkling.defaults.consent),
      });
      Inkling.instances.set(key, instance);
      instance.catch(() => Inkling.instances.delete(key));
    }
    return instance;
  }

  /** The catalog's manifest. */
  get manifest(): Manifest {
    return this.catalog.manifest;
  }

  /** Looks up an item's published metadata. */
  async item(id: string, sectionHint?: string): Promise<ShardItem | undefined> {
    return (await this.catalog.find(id, sectionHint))?.item;
  }

  // Related items ----------------------------------------------------------------------------

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
    const pause = slicer();
    const pool = await this.candidates(sections, (e) => !exclude.has(e.item.id), pause);
    const query = this.catalog.vector(target);
    return this.rankEntries(pool, (e) => this.catalog.cosine(query, e), 1, options, pause);
  }

  // Personalization --------------------------------------------------------------------------

  /** Whether the site's consent hook currently allows personalization. */
  async consented(): Promise<boolean> {
    try {
      return await evaluate(this.options.consent);
    } catch {
      return false;
    }
  }

  /**
   * Records a signal. Does nothing (and returns false) without consent, while paused, or when
   * storage fails. `dwell` takes the visible time in `seconds` and counts from 10 seconds on.
   */
  async record(
    kind: SignalKind,
    itemId: string,
    options: { seconds?: number } = {},
  ): Promise<boolean> {
    const weight = kind === 'dwell' ? dwellWeight(options.seconds ?? 0) : SIGNAL_WEIGHTS[kind];
    // An unknown kind or a NaN duration would poison the profile's sums.
    if (!Number.isFinite(weight) || weight === 0) return false;
    return this.write({ itemId, kind, weight, at: this.now() });
  }

  /**
   * Records a view of `itemId` now, and dwell time as the page is hidden or left (capped at one
   * minute's worth). Returns a function that stops observing. A no-op outside a browser.
   */
  observe(itemId: string): () => void {
    if (typeof document === 'undefined') return () => {};
    void this.visit();
    void this.record('view', itemId);
    let visibleSince: number | null = document.visibilityState === 'visible' ? this.now() : null;
    let seconds = 0;
    let recorded = 0;
    const flush = (): void => {
      if (visibleSince !== null) {
        seconds += (this.now() - visibleSince) / 1000;
        visibleSince = null;
      }
      const weight = dwellWeight(seconds) - recorded;
      if (weight > 0.01) {
        recorded += weight;
        void this.write({ itemId, kind: 'dwell', weight, at: this.now() });
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
      else visibleSince = this.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', flush);
    return () => {
      flush();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('pagehide', flush);
    };
  }

  /**
   * "For you": the catalog ranked by the visitor's profile. Without consent or signals, this is
   * the site's own order (the cold start); the profile takes over as signals accumulate.
   * Hidden items never appear, and items already seen only with `includeSeen`.
   */
  async recommend(options: RecommendOptions = {}): Promise<Recommendation[]> {
    const personal = await this.personal();
    await this.catalog.loadSections(options.sections);
    const exclude = new Set(options.exclude);
    const after = options.after;
    const pause = slicer();
    const pool = await this.candidates(
      options.sections,
      (e) => {
        const agg = personal.aggregates.get(e.item.id);
        if (after !== undefined && !(Date.parse(e.item.date ?? '') > after)) return false;
        return !exclude.has(e.item.id) && !agg?.hidden && (options.includeSeen || !agg?.seen);
      },
      pause,
    );
    return this.rankPersonal(pool, personal, options, pause);
  }

  /**
   * Ranks the catalog by similarity to a query vector, such as one from
   * `@swissspidy/inkling/query`, which embeds text with the catalog's own model on the device.
   * The vector is truncated to the catalog's dimensions and normalized. Hidden items never
   * appear. With `personalize`, the visitor's profile is blended in.
   */
  async search(query: ArrayLike<number>, options: SearchOptions = {}): Promise<Recommendation[]> {
    const { dims, model } = this.catalog.manifest;
    if (query.length !== dims && query.length !== model.nativeDims) {
      throw new RangeError(
        `Inkling: a query vector has ${dims} or ${model.nativeDims} dims (${model.id}), not ${query.length}`,
      );
    }
    const components = Array.prototype.slice.call(query, 0, dims) as number[];
    if (!components.every(Number.isFinite)) {
      throw new RangeError('Inkling: a query vector has a non-finite component');
    }
    const vector = normalize(components);
    const requested = options.personalize ?? 0;
    const personalize = Number.isNaN(requested) ? 0 : Math.min(1, Math.max(0, requested));
    // Signals (with consent) for hidden and seen items, and the profile when personalizing.
    const personal = await this.personal(personalize > 0);
    await this.catalog.loadSections(options.sections);
    const exclude = new Set(options.exclude);
    const pause = slicer();
    const pool = await this.candidates(
      options.sections,
      (e) => {
        const agg = personal.aggregates.get(e.item.id);
        return !exclude.has(e.item.id) && !agg?.hidden && !(options.excludeSeen && agg?.seen);
      },
      pause,
    );
    const weight = personal.profile.positive ? personalize : 0;
    return this.rankEntries(
      pool,
      (e) =>
        (1 - weight) * this.catalog.cosine(vector, e) +
        weight * this.profileSimilarity(personal.profile, e),
      1,
      { diversity: 0, ...options, weights: { recency: 0, ...options.weights } },
      pause,
    );
  }

  /**
   * Records activity now (with consent, unless paused) and returns when the visitor's previous
   * visit ended, or `undefined` on a first visit. A visit ends after `visitGapMinutes` without
   * activity; calling this again in the same visit changes nothing.
   */
  async visit(): Promise<number | undefined> {
    if (!(await this.consented())) return undefined;
    const generation = this.forgotten;
    try {
      const gap = (this.options.visitGapMinutes ?? 30) * 60_000;
      const now = this.now();
      // One read-modify-write: a concurrent pause() is never overwritten, and the state read
      // is the current one, so a forget() before it cannot be undone. A forget() that started
      // after this call began leaves the state as it finds it.
      const next = await this.store.updateState((state) =>
        state.paused || generation !== this.forgotten ? state : nextVisit(state, now, gap),
      );
      return generation === this.forgotten ? next.previousVisit : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * "Since your last visit": items published after the visitor's previous visit, ranked like
   * `recommend()`. Records this visit first. Empty on a first visit or without consent.
   */
  async sinceLastVisit(options: Omit<RecommendOptions, 'after'> = {}): Promise<Recommendation[]> {
    const previous = await this.visit();
    if (previous === undefined) return [];
    const recommendations = await this.recommend({ ...options, after: previous });
    // Consent may have been withdrawn meanwhile: then there is no "last visit" to speak of.
    return (await this.consented()) ? recommendations : [];
  }

  /**
   * Orders a list the server rendered (item ids) by the visitor's profile. Unknown ids keep
   * their order after the known ones, hidden items go last, and nothing is dropped.
   */
  async rank(
    ids: readonly string[],
    options: RankingOptions & {
      /**
       * The cold-start order: the list's own (default), or the catalog's published prior
       * (popularity or editorial order), for lists in no particular order.
       */
      prior?: 'list' | 'catalog';
    } = {},
  ): Promise<string[]> {
    const personal = await this.personal();
    const entries = await Promise.all(ids.map((id) => this.catalog.find(id)));
    const known: Entry[] = [];
    const unknown: string[] = [];
    const hidden: string[] = [];
    ids.forEach((id, i) => {
      if (personal.aggregates.get(id)?.hidden) hidden.push(id);
      else if (entries[i]) known.push(entries[i]);
      else unknown.push(id);
    });
    // By default the site's list is the cold-start order: its positions are the prior.
    const position = new Map(known.map((e, i) => [e.item.id, 1 - i / known.length]));
    const ranked = await this.rankPersonal(
      known,
      personal,
      { ...options, n: known.length },
      slicer(),
      options.prior === 'catalog' ? undefined : (e) => position.get(e.item.id)!,
    );
    return [...ranked.map((r) => r.id), ...unknown, ...hidden];
  }

  /** How the visitor's profile sees one item, and which of their items it leans on. */
  async explain(
    itemId: string,
    options: { recencyHalfLifeDays?: number } = {},
  ): Promise<ItemExplanation | undefined> {
    const entry = await this.catalog.find(itemId);
    if (!entry) return undefined;
    const personal = await this.personal();
    const agg = personal.aggregates.get(itemId);
    return {
      id: itemId,
      similarity: this.profileSimilarity(personal.profile, entry),
      confidence: personal.profile.confidence,
      prior: entry.item.prior,
      recency: recency(entry.item.date, this.now(), options.recencyHalfLifeDays ?? 30),
      hidden: agg?.hidden ?? false,
      seen: agg?.seen ?? false,
      because: this.because(personal.profile, entry),
      signals: personal.signals,
      missing: personal.profile.missing.length,
    };
  }

  // User controls ----------------------------------------------------------------------------

  /** Stops recording signals (stored signals still rank). */
  pause(): Promise<void> {
    return this.setPaused(true);
  }

  /** Records signals again after {@link Inkling.pause}. */
  resume(): Promise<void> {
    return this.setPaused(false);
  }

  /** Whether recording is paused (false without consent). */
  async paused(): Promise<boolean> {
    if (!(await this.consented())) return false;
    try {
      return (await this.store.getState()).paused;
    } catch {
      return false;
    }
  }

  /**
   * Deletes the signals of one item, or, without `itemId`, everything Inkling stored on this
   * device (its whole database). Works without consent: deleting is always allowed.
   */
  async forget(itemId?: string): Promise<void> {
    if (itemId === undefined) {
      this.forgotten++;
      await this.store.destroy();
      return;
    }
    // Deleting needs no consent, but must not create a database that does not exist yet.
    if (!(await this.consented()) && !(await this.store.exists())) return;
    const signals = await this.store.all();
    await this.store.delete(signals.filter((s) => s.itemId === itemId).map((s) => s.seq!));
  }

  /** Everything stored about the visitor, as JSON-ready data. */
  async export(): Promise<SignalExport> {
    const signals = (await this.consented()) ? await this.store.all().catch(() => []) : [];
    return {
      format: 'inkling/signals',
      formatVersion: 1,
      exportedAt: new Date(this.now()).toISOString(),
      manifestVersion: this.catalog.manifest.version,
      signals: signals.map(({ itemId, kind, weight, at }) => ({ itemId, kind, weight, at })),
    };
  }

  // Internals --------------------------------------------------------------------------------

  private async write(signal: Signal): Promise<boolean> {
    if (!(await this.consented())) return false;
    try {
      if ((await this.store.getState()).paused) return false;
      // Again: consent may have been withdrawn while the state was read.
      if (!(await this.consented())) return false;
      await this.store.add(signal);
      // On every write, so a long-lived page stays within the limits too (at most 2,000 reads).
      const drop = toPrune(
        await this.store.all(),
        this.now(),
        this.options.maxSignals ?? 2000,
        this.options.maxSignalAgeDays ?? 180,
      );
      await this.store.delete(drop);
      return true;
    } catch {
      return false;
    }
  }

  private async setPaused(paused: boolean): Promise<void> {
    if (!(await this.consented())) return;
    await this.store.updateState((state) => ({ ...state, paused }));
  }

  /**
   * Signals, aggregated, and the profile they make with the current catalog's vectors. Without
   * `withProfile`, only the aggregates: no shard is loaded for the profile.
   */
  private async personal(withProfile = true): Promise<Personal> {
    const none: Personal = { aggregates: new Map(), profile: NO_PROFILE, signals: 0 };
    if (!(await this.consented())) return none;
    let signals: Signal[];
    try {
      signals = await this.store.all();
    } catch {
      return none;
    }
    if (signals.length === 0) return none;
    const aggregates = aggregate(signals, this.now(), this.options.signalHalfLifeDays ?? 21);
    if (!withProfile) return { aggregates, profile: NO_PROFILE, signals: signals.length };
    // The shards of every item with signals, so the profile sees all of them.
    const entries = new Map<string, Entry | undefined>();
    await Promise.all(
      [...aggregates.keys()].map(async (id) => entries.set(id, await this.catalog.find(id))),
    );
    const profile = buildProfile(
      aggregates,
      (id) => {
        const entry = entries.get(id);
        return entry && this.catalog.vector(entry);
      },
      this.catalog.manifest.dims,
    );
    return { aggregates, profile, signals: signals.length };
  }

  /** The loaded entries in `sections` that `keep` keeps, in slices (ADR 0008). */
  private async candidates(
    sections: readonly string[] | undefined,
    keep: (e: Entry) => boolean,
    pause: Pause,
  ): Promise<Entry[]> {
    const all = this.catalog.loaded();
    const pool: Entry[] = [];
    for (let from = 0; from < all.length; from += SLICE_ITEMS) {
      await pause();
      for (const e of all.slice(from, from + SLICE_ITEMS)) {
        if (
          keep(e) &&
          (!sections || (e.item.section !== undefined && sections.includes(e.item.section)))
        ) {
          pool.push(e);
        }
      }
    }
    return pool;
  }

  private profileSimilarity(profile: Profile, entry: Entry): number {
    if (!profile.positive) return 0;
    const neg = profile.negative ? this.catalog.cosine(profile.negative, entry) : 0;
    return profileSimilarity(this.catalog.cosine(profile.positive, entry), neg);
  }

  /** The profile items with the largest score × similarity to `entry`, top three. */
  private because(profile: Profile, entry: Entry): Because[] {
    const parts = profile.contributors.map((c) => ({
      c,
      part: c.score * Math.max(0, this.catalog.cosine(c.vector, entry)),
    }));
    const total = parts.reduce((sum, p) => sum + p.part, 0);
    if (total <= 0) return [];
    return parts
      .filter((p) => p.part > 0)
      .sort((a, b) => b.part - a.part)
      .slice(0, 3)
      .map(({ c, part }) => {
        const item = this.catalog.get(c.itemId)!.item;
        return { id: item.id, title: item.title, url: item.url, share: part / total };
      });
  }

  private async rankPersonal(
    pool: Entry[],
    personal: Personal,
    options: RankingOptions,
    pause: Pause,
    prior?: (e: Entry) => number,
  ): Promise<Recommendation[]> {
    const { profile } = personal;
    // Without a profile the site's order stands as it is: no recency, no reshuffling.
    const cold = profile.confidence === 0;
    const recs = await this.rankEntries(
      pool,
      (e) => this.profileSimilarity(profile, e),
      profile.confidence,
      cold ? { ...options, diversity: 0, weights: { ...options.weights, recency: 0 } } : options,
      pause,
      prior,
    );
    if (profile.positive) {
      for (const rec of recs) rec.why.because = this.because(profile, this.catalog.get(rec.id)!);
    }
    return recs;
  }

  /**
   * Ranks `pool`. Scoring runs in slices, and `pause` yields to the page between them, so a
   * large catalog does not block input (ADR 0008). Where the slices fall does not change the
   * result.
   */
  private async rankEntries(
    pool: Entry[],
    similarity: (e: Entry) => number,
    confidence: number,
    options: RankingOptions,
    pause: Pause,
    prior: (e: Entry) => number = (e) => e.item.prior,
  ): Promise<Recommendation[]> {
    const n = options.n ?? 5;
    const now = this.now();
    const halfLife = options.recencyHalfLifeDays ?? 30;
    const vectors = new Map<number, Float32Array>();
    const vectorOf = (i: number): Float32Array => {
      let v = vectors.get(i);
      if (!v) vectors.set(i, (v = this.catalog.vector(pool[i]!)));
      return v;
    };
    const steps = ranking(
      pool.map((_, i) => i),
      {
        similarity: (i) => similarity(pool[i]!),
        prior: (i) => prior(pool[i]!),
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
    let step = steps.next();
    while (!step.done) {
      await pause();
      step = steps.next();
    }
    const ranked = step.value;
    const w = { ...DEFAULT_WEIGHTS, ...options.weights };
    return ranked.map((r) => ({
      ...pool[r.index]!.item,
      score: r.score,
      why: {
        similarityShare: share(
          w.similarity * confidence * r.relevance,
          w.prior * (1 - confidence) * r.prior + w.recency * r.recency,
        ),
        similarity: r.similarity,
        relevance: r.relevance,
        recency: r.recency,
        prior: r.prior,
        redundancy: r.redundancy,
        confidence,
        because: [],
      },
    }));
  }
}

function share(part: number, rest: number): number {
  return part + rest > 0 ? part / (part + rest) : 0;
}

async function evaluate(consent: Consent | undefined): Promise<boolean> {
  if (typeof consent === 'function') return (await consent()) === true;
  return consent === true;
}

export type { Manifest, ShardItem } from '../format/manifest.ts';
export type { ScoreWeights } from '../rank/rank.ts';
export type { Fetch } from './catalog.ts';
export { IndexedDbStore, MemoryStore } from './signals.ts';
export type { Signal, SignalKind, SignalState, SignalStore } from './signals.ts';
