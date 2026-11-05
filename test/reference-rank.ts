/**
 * The ranking function as it was before ADR 0008 (a full sort of every candidate), kept
 * verbatim as the reference that `rank()` and `ranking()` must match exactly.
 */

import type { RankInput, RankOptions, Ranked } from '../src/rank/rank.ts';

/** Ranks `candidates` and returns the best `options.n`, most relevant first. */
export function referenceRank(
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

function byBase(
  a: { base: number; prior: number; index: number },
  b: { base: number; prior: number; index: number },
): number {
  return b.base - a.base || b.prior - a.prior || a.index - b.index;
}
