/**
 * The ranking function (ADR 0001, "Ranking").
 *
 *   rel(c)   = (sim(c) - min sim) / (max sim - min sim)      over the candidates, in [0, 1]
 *   rec(c)   = 0.5 ^ (age(c) / recencyHalfLife)              (0 without a date)
 *   base(c)  = wSim * conf * rel(c) + wPrior * (1 - conf) * prior(c) + wRec * rec(c)
 *   red(c)   = max_{s in picked} rescaled cos(c, s)            (same rescaling as rel)
 *   pick     = argmax_c  (1 - diversity) * base(c) - diversity * red(c)
 *
 * `sim` is the cosine to the query (an item for `related`, the visitor's profile for
 * "for you"); `conf` is how much the query is trusted (1 for `related`, grows with the
 * profile's signal mass). Rescaling puts similarity on the same [0, 1] scale as the prior and
 * recency whatever band of cosines a model uses, so the weights carry over when the model
 * changes. The last line is maximal marginal relevance (MMR), applied greedily over the
 * best-scoring pool. Ties go to the higher prior, then the lower candidate index, so the result
 * is deterministic.
 */

/** The weights of the ranking function's terms (ADR 0001). Not stable: they may change in any release. */
export interface ScoreWeights {
  /** Weight of the (rescaled) similarity, scaled by the confidence in the query. */
  similarity: number;
  /** Weight of the site's cold-start prior, scaled by the lack of confidence. */
  prior: number;
  /** Weight of the recency boost. */
  recency: number;
}

export interface RankInput {
  /** Cosine similarity of candidate `i` to the query, in [-1, 1]. */
  similarity(i: number): number;
  /** Site-provided cold-start prior of candidate `i`, in [0, 1]. */
  prior(i: number): number;
  /** Recency of candidate `i`, in [0, 1]. */
  recency(i: number): number;
  /** Cosine similarity between two candidates, for diversity. */
  pairwise(i: number, j: number): number;
}

export interface RankOptions {
  /** How many results to return. */
  n: number;
  /** Trust in the query, in [0, 1]. */
  confidence: number;
  weights: ScoreWeights;
  /** MMR trade-off in [0, 1]: 0 is pure relevance, 1 is pure novelty. */
  diversity: number;
  /** Candidates considered by MMR, best `base` first (at least `n`). */
  poolSize: number;
}

export interface Ranked {
  /** The candidate (whatever the caller's indexes mean). */
  index: number;
  /** The MMR objective when the candidate was picked. */
  score: number;
  /** base(c), before the diversity penalty. */
  base: number;
  /** Raw cosine similarity to the query. */
  similarity: number;
  /** Similarity rescaled over the candidates, in [0, 1]. */
  relevance: number;
  prior: number;
  recency: number;
  /** Highest rescaled similarity to an already picked result (0 for the first). */
  redundancy: number;
}

export const DEFAULT_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  similarity: 1,
  prior: 0.5,
  recency: 0.1,
});

/** The ranking's inputs, one entry per candidate (ADR 0010). */
export interface RankColumns {
  /** Cosine similarity of each candidate to the query, in [-1, 1]. */
  similarity: ArrayLike<number>;
  /** Site-provided cold-start prior of each candidate, in [0, 1]. */
  prior: ArrayLike<number>;
  /** Recency of each candidate, in [0, 1]. */
  recency: ArrayLike<number>;
  /** Cosine similarity between candidates `i` and `j` (`j` already picked), for diversity. */
  pairwise(i: number, j: number): number;
}

/** Ranks `candidates` and returns the best `options.n`, most relevant first. */
export function rank(
  candidates: readonly number[],
  input: RankInput,
  options: RankOptions,
): Ranked[] {
  // Ties go to the lower candidate: in ascending order, that is the earlier column entry.
  const sorted = [...candidates].sort((a, b) => a - b);
  const columns: RankColumns = {
    similarity: sorted.map((c) => input.similarity(c)),
    prior: sorted.map((c) => input.prior(c)),
    recency: sorted.map((c) => input.recency(c)),
    pairwise: (i, j) => input.pairwise(sorted[i]!, sorted[j]!),
  };
  const steps = ranking(columns, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value.map((r) => ({ ...r, index: sorted[r.index]! }));
}

/**
 * Ranks candidates from their columns: `index` in the result is the candidate's position in
 * them. It pauses after scoring, after choosing the pool and between the diversity picks, so a
 * caller can yield to the page in between
 * (ADR 0008); where it pauses does not change the result. Scoring and choosing the pool run
 * over typed arrays, with objects only for the pool.
 */
export function* ranking(
  columns: RankColumns,
  options: RankOptions,
): Generator<void, Ranked[], void> {
  const { n, confidence, weights, diversity } = options;
  const { similarity: sims, prior: priors, recency: recencies } = columns;
  const count = sims.length;
  if (n <= 0 || count === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < count; k++) {
    const sim = sims[k]!;
    if (sim < min) min = sim;
    if (sim > max) max = sim;
  }
  const spread = max - min;
  // One candidate, or all equally similar: similarity says nothing.
  const rescale = (sim: number): number =>
    spread > 1e-9 ? Math.min(1, Math.max(0, (sim - min) / spread)) : 0;
  const wSim = weights.similarity * confidence;
  const wPrior = weights.prior * (1 - confidence);
  const wRec = weights.recency;
  const base = new Float64Array(count);
  // rescale(), inlined: this loop and the next run once per candidate.
  const flat = !(spread > 1e-9);
  for (let k = 0; k < count; k++) {
    const rel = flat ? 0 : Math.min(1, Math.max(0, (sims[k]! - min) / spread));
    base[k] = wSim * rel + wPrior * priors[k]! + wRec * recencies[k]!;
  }
  // Scoring and choosing the pool are a pass each over the candidates: pause in between.
  yield;
  // Higher base first, then higher prior, then the earlier candidate: a strict order, so the
  // result is deterministic.
  const order = (a: number, b: number): number =>
    base[b]! - base[a]! || priors[b]! - priors[a]! || a - b;
  // The best `size` by that order without sorting every candidate: candidates that can still
  // make it are collected, and the collection is sorted and cut back to `size` whenever it
  // reaches twice that. O(count log size), and a single sort when every candidate is kept.
  const size = Math.min(count, Math.max(n, options.poolSize));
  const kept = new Int32Array(Math.min(count, 2 * size));
  let m = 0;
  let worst = -1;
  for (let k = 0; k < count; k++) {
    if (worst >= 0) {
      // order(k, worst) >= 0, inlined: k can't make it.
      const bk = base[k]!;
      const bw = base[worst]!;
      if (
        bk < bw ||
        (bk === bw && (priors[k]! < priors[worst]! || (priors[k] === priors[worst] && k > worst)))
      )
        continue;
    }
    kept[m++] = k;
    if (m === kept.length && m < count) {
      kept.sort(order);
      m = size;
      worst = kept[size - 1]!;
    }
  }
  const top = kept.subarray(0, m).sort(order).subarray(0, size);
  yield;
  const pool: Ranked[] = Array.from(top, (k) => {
    const similarity = sims[k]!;
    return {
      index: k,
      base: base[k]!,
      similarity,
      relevance: rescale(similarity),
      prior: priors[k]!,
      recency: recencies[k]!,
      score: base[k]!,
      redundancy: 0,
    };
  });
  if (diversity <= 0) return pool.slice(0, n);

  const picked: Ranked[] = [];
  // Highest similarity of each pool entry to anything picked so far.
  const redundancy = new Float64Array(pool.length);
  const taken = new Uint8Array(pool.length);
  while (picked.length < n && picked.length < pool.length) {
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < pool.length; k++) {
      if (taken[k]) continue;
      const score = (1 - diversity) * pool[k]!.base - diversity * redundancy[k]!;
      // Strictly greater: the pool is sorted, so ties keep the better `base`.
      if (score > bestScore) {
        best = k;
        bestScore = score;
      }
    }
    const chosen = pool[best]!;
    taken[best] = 1;
    picked.push({ ...chosen, score: bestScore, redundancy: redundancy[best]! });
    for (let k = 0; k < pool.length; k++) {
      if (taken[k]) continue;
      const sim = rescale(columns.pairwise(pool[k]!.index, chosen.index));
      if (sim > redundancy[k]!) redundancy[k] = sim;
    }
    // Each pick compares the rest of the pool: a long list (`rank(ids)`) pauses between picks.
    yield;
  }
  return picked;
}

/** 0.5 ^ (age / halfLife) for an ISO date; 1 for future dates, 0 without a date. */
export function recency(date: string | undefined, now: number, halfLifeDays: number): number {
  return recencyAt(date ? Date.parse(date) : NaN, now, halfLifeDays);
}

/** {@link recency} for a time in milliseconds (NaN: no date), as the catalog stores dates. */
export function recencyAt(time: number, now: number, halfLifeDays: number): number {
  if (Number.isNaN(time)) return 0;
  const ageDays = Math.max(0, now - time) / 86_400_000;
  // Before dividing: a half-life of 0 would make 0 / 0.
  if (ageDays === 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}
