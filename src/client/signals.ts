/**
 * Signals: the only thing Inkling stores about a visitor (ADR 0001, "The signal schema"). A list
 * of { itemId, kind, weight, at } in the site's own IndexedDB. The profile is never stored; it
 * is derived from these on every page.
 */

export type SignalKind = 'view' | 'click' | 'dwell' | 'follow' | 'hide';

export interface Signal {
  /** Assigned by the store. */
  seq?: number;
  itemId: string;
  kind: SignalKind;
  /** Signed weight before decay. */
  weight: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface SignalState {
  paused: boolean;
  /** The visitor's last activity on the site, epoch milliseconds. */
  lastSeen?: number;
  /** The last activity of the visit before the current one: "since your last visit". */
  previousVisit?: number;
}

/**
 * The state after activity at `now`: a gap of more than `gapMs` since the last activity starts
 * a new visit, and the old visit's last activity becomes the previous visit.
 */
export function nextVisit(state: SignalState, now: number, gapMs: number): SignalState {
  if (state.lastSeen !== undefined && now - state.lastSeen > gapMs) {
    return { ...state, previousVisit: state.lastSeen, lastSeen: now };
  }
  return { ...state, lastSeen: Math.max(now, state.lastSeen ?? now) };
}

/** Where signals live. `IndexedDbStore` in browsers, `MemoryStore` elsewhere and in tests. */
export interface SignalStore {
  add(signal: Signal): Promise<void>;
  all(): Promise<Signal[]>;
  delete(seqs: readonly number[]): Promise<void>;
  /** Removes everything this store holds, including its database. */
  destroy(): Promise<void>;
  /** Whether the store holds anything (without creating it if not). */
  exists(): Promise<boolean>;
  /** Returns what `setState()` stored: `paused`, and the visit fields `lastSeen` and `previousVisit`. */
  getState(): Promise<SignalState>;
  /** Stores all of `state`, the visit fields included. */
  setState(state: SignalState): Promise<void>;
  /**
   * Reads the state, applies `update` and stores the result in one step, so concurrent
   * updates (a pause and a visit) cannot overwrite each other. Returns the stored state.
   */
  updateState(update: (state: SignalState) => SignalState): Promise<SignalState>;
}

export const SIGNAL_WEIGHTS: Readonly<Record<Exclude<SignalKind, 'dwell'>, number>> = {
  view: 1,
  click: 2,
  follow: 5,
  hide: -5,
};

/** Explicit signals do not decay and are not pruned by age. */
const EXPLICIT: ReadonlySet<SignalKind> = new Set<SignalKind>(['follow', 'hide']);

/** Dwell weight for a total visible time: 2 × min(seconds / 60, 1), from 10 seconds on. */
export function dwellWeight(seconds: number): number {
  return seconds < 10 ? 0 : 2 * Math.min(seconds / 60, 1);
}

export interface Aggregate {
  /** Sum of decayed weights. */
  score: number;
  /** The latest explicit signal decides: `hide` means never shown again. */
  hidden: boolean;
  /** Has a view, click, dwell or follow: the visitor knows the item. */
  seen: boolean;
}

/** Sums each item's decayed signals: w × 0.5^(age / halfLife) for implicit kinds. */
export function aggregate(
  signals: readonly Signal[],
  now: number,
  halfLifeDays: number,
): Map<string, Aggregate> {
  const out = new Map<string, Aggregate>();
  const latestExplicit = new Map<string, Signal>();
  for (const s of signals) {
    let agg = out.get(s.itemId);
    if (!agg) out.set(s.itemId, (agg = { score: 0, hidden: false, seen: false }));
    if (EXPLICIT.has(s.kind)) {
      agg.score += s.weight;
      if (s.kind === 'follow') agg.seen = true;
      const prev = latestExplicit.get(s.itemId);
      if (!prev || s.at >= prev.at) latestExplicit.set(s.itemId, s);
    } else {
      const ageDays = Math.max(0, now - s.at) / 86_400_000;
      agg.score += s.weight * Math.pow(0.5, ageDays / halfLifeDays);
      agg.seen = true;
    }
  }
  for (const [id, s] of latestExplicit) out.get(id)!.hidden = s.kind === 'hide';
  return out;
}

/** The sequence numbers to delete: implicit signals past `maxAgeDays`, then the oldest past `max`. */
export function toPrune(
  signals: readonly Signal[],
  now: number,
  max: number,
  maxAgeDays: number,
): number[] {
  const cutoff = now - maxAgeDays * 86_400_000;
  const drop = new Set<number>();
  for (const s of signals) {
    if (s.seq !== undefined && !EXPLICIT.has(s.kind) && s.at < cutoff) drop.add(s.seq);
  }
  const kept = signals.filter((s) => s.seq !== undefined && !drop.has(s.seq));
  if (kept.length > max) {
    // Oldest implicit first, then oldest explicit.
    kept.sort((a, b) => Number(EXPLICIT.has(a.kind)) - Number(EXPLICIT.has(b.kind)) || a.at - b.at);
    for (const s of kept.slice(0, kept.length - max)) drop.add(s.seq!);
  }
  return [...drop];
}

export class MemoryStore implements SignalStore {
  private signals: Signal[] = [];
  private seq = 0;
  private state: SignalState = { paused: false };

  add(signal: Signal): Promise<void> {
    this.signals.push({ ...signal, seq: ++this.seq });
    return Promise.resolve();
  }
  all(): Promise<Signal[]> {
    return Promise.resolve(this.signals.map((s) => ({ ...s })));
  }
  delete(seqs: readonly number[]): Promise<void> {
    const set = new Set(seqs);
    this.signals = this.signals.filter((s) => !set.has(s.seq!));
    return Promise.resolve();
  }
  exists(): Promise<boolean> {
    return Promise.resolve(this.signals.length > 0);
  }
  destroy(): Promise<void> {
    this.signals = [];
    this.state = { paused: false };
    return Promise.resolve();
  }
  getState(): Promise<SignalState> {
    return Promise.resolve({ ...this.state });
  }
  setState(state: SignalState): Promise<void> {
    this.state = { ...state };
    return Promise.resolve();
  }
  updateState(update: (state: SignalState) => SignalState): Promise<SignalState> {
    this.state = { ...update({ ...this.state }) };
    return Promise.resolve({ ...this.state });
  }
}

/** Signals in IndexedDB: database `name` (default `inkling`), version 1. Opened on first use. */
export class IndexedDbStore implements SignalStore {
  private readonly name: string;
  private opening: Promise<IDBDatabase> | undefined;

  constructor(name = 'inkling') {
    this.name = name;
  }

  async add(signal: Signal): Promise<void> {
    const { seq: _, ...record } = signal;
    await this.tx('signals', 'readwrite', (store) => store.add(record));
  }

  all(): Promise<Signal[]> {
    return this.tx('signals', 'readonly', (store) => store.getAll() as IDBRequest<Signal[]>);
  }

  async delete(seqs: readonly number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.tx('signals', 'readwrite', (store) => {
      let last: IDBRequest | undefined;
      for (const seq of seqs) last = store.delete(seq);
      return last!;
    });
  }

  async destroy(): Promise<void> {
    const db = await this.opening?.catch(() => undefined);
    db?.close();
    this.opening = undefined;
    await request(indexedDB.deleteDatabase(this.name));
  }

  async exists(): Promise<boolean> {
    if (this.opening) return true;
    // Without indexedDB.databases() (older browsers), assume it does.
    if (typeof indexedDB.databases !== 'function') return true;
    return (await indexedDB.databases()).some((db) => db.name === this.name);
  }

  async getState(): Promise<SignalState> {
    const row = await this.tx(
      'meta',
      'readonly',
      (store) => store.get('state') as IDBRequest<(SignalState & { key: string }) | undefined>,
    );
    return compactState({
      paused: row?.paused ?? false,
      lastSeen: row?.lastSeen,
      previousVisit: row?.previousVisit,
    });
  }

  async setState(state: SignalState): Promise<void> {
    await this.tx('meta', 'readwrite', (store) => store.put({ key: 'state', ...state }));
  }

  async updateState(update: (state: SignalState) => SignalState): Promise<SignalState> {
    const db = await this.db();
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    let next: SignalState | undefined;
    // The read and the write share one readwrite transaction: IndexedDB runs it alone.
    const read = store.get('state') as IDBRequest<(SignalState & { key: string }) | undefined>;
    read.onsuccess = () => {
      const row = read.result;
      next = update(
        compactState({
          paused: row?.paused ?? false,
          lastSeen: row?.lastSeen,
          previousVisit: row?.previousVisit,
        }),
      );
      store.put({ key: 'state', ...next });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    return next!;
  }

  private db(): Promise<IDBDatabase> {
    this.opening ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(this.name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        const signals = db.createObjectStore('signals', { keyPath: 'seq', autoIncrement: true });
        signals.createIndex('itemId', 'itemId');
        signals.createIndex('at', 'at');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      open.onsuccess = () => {
        // Another tab's forget() deletes the database: let it.
        open.result.onversionchange = () => {
          open.result.close();
          this.opening = undefined;
        };
        resolve(open.result);
      };
      open.onerror = () => {
        // A later call may try again (a blocked upgrade, a transient quota error).
        this.opening = undefined;
        reject(open.error ?? new Error('IndexedDB open failed'));
      };
    });
    return this.opening;
  }

  private async tx<T>(
    storeName: 'signals' | 'meta',
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    const tx = db.transaction(storeName, mode);
    const result = request(run(tx.objectStore(storeName)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    return result;
  }
}

function compactState(state: SignalState): SignalState {
  if (state.lastSeen === undefined) delete state.lastSeen;
  if (state.previousVisit === undefined) delete state.previousVisit;
  return state;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}
