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

export interface ScoreWeights {
  similarity: number;
  prior: number;
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

/** Ranks `candidates` and returns the best `options.n`, most relevant first. */
export function rank(
  candidates: readonly number[],
  input: RankInput,
  options: RankOptions,
): Ranked[] {
  const { n, confidence, weights, diversity } = options;
  if (n <= 0 || candidates.length === 0) return [];
  const sims = candidates.map((index) => input.similarity(index));
  let min = Infinity;
  let max = -Infinity;
  for (const sim of sims) {
    if (sim < min) min = sim;
    if (sim > max) max = sim;
  }
  const spread = max - min;
  // One candidate, or all equally similar: similarity says nothing.
  const rescale = (sim: number): number =>
    spread > 1e-9 ? Math.min(1, Math.max(0, (sim - min) / spread)) : 0;
  const scored = candidates.map((index, k) => {
    const similarity = sims[k]!;
    const relevance = rescale(similarity);
    const prior = input.prior(index);
    const recency = input.recency(index);
    const base =
      weights.similarity * confidence * relevance +
      weights.prior * (1 - confidence) * prior +
      weights.recency * recency;
    return { index, base, similarity, relevance, prior, recency, score: base, redundancy: 0 };
  });
  scored.sort(byBase);
  const pool = scored.slice(0, Math.max(n, options.poolSize));
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
      const sim = rescale(input.pairwise(pool[k]!.index, chosen.index));
      if (sim > redundancy[k]!) redundancy[k] = sim;
    }
  }
  return picked;
}

/** 0.5 ^ (age / halfLife) for an ISO date; 1 for future dates, 0 without a date. */
export function recency(date: string | undefined, now: number, halfLifeDays: number): number {
  if (!date) return 0;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, now - t) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function byBase(
  a: { base: number; prior: number; index: number },
  b: { base: number; prior: number; index: number },
): number {
  return b.base - a.base || b.prior - a.prior || a.index - b.index;
}
