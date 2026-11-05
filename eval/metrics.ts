/**
 * Ranking metrics as MIND reports them (per impression, then averaged): AUC, MRR, nDCG@k,
 * and recall@k (clicked items in the top k over all clicked).
 */

export interface Metrics {
  auc: number;
  mrr: number;
  ndcg5: number;
  ndcg10: number;
  recall10: number;
}

export const METRIC_NAMES: (keyof Metrics)[] = ['auc', 'mrr', 'ndcg5', 'ndcg10', 'recall10'];

/** Metrics for one ranked list (best first) against the clicked set. */
export function score(ranked: readonly string[], clicked: ReadonlySet<string>): Metrics {
  const labels = ranked.map((id) => (clicked.has(id) ? 1 : 0));
  const positives = labels.reduce<number>((a, b) => a + b, 0);
  return {
    auc: auc(labels),
    mrr: labels.reduce<number>((sum, l, i) => sum + l / (i + 1), 0) / positives,
    ndcg5: ndcg(labels, 5),
    ndcg10: ndcg(labels, 10),
    recall10: labels.slice(0, 10).reduce<number>((a, b) => a + b, 0) / positives,
  };
}

export function mean(all: readonly Metrics[]): Metrics {
  const out = { auc: 0, mrr: 0, ndcg5: 0, ndcg10: 0, recall10: 0 };
  for (const m of all) for (const k of METRIC_NAMES) out[k] += m[k] / all.length;
  return out;
}

/** The share of (positive, negative) pairs ranked in the right order. */
function auc(labels: readonly number[]): number {
  let negativesBelow = 0;
  let correct = 0;
  let pos = 0;
  // Walk from the bottom: each positive beats the negatives seen so far.
  for (let i = labels.length - 1; i >= 0; i--) {
    if (labels[i]) {
      correct += negativesBelow;
      pos++;
    } else {
      negativesBelow++;
    }
  }
  return pos === 0 || negativesBelow === 0 ? 0.5 : correct / (pos * negativesBelow);
}

function ndcg(labels: readonly number[], k: number): number {
  const dcg = (ls: readonly number[]) =>
    ls.slice(0, k).reduce((sum, l, i) => sum + (2 ** l - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...labels].sort((a, b) => b - a));
  return ideal === 0 ? 0 : dcg(labels) / ideal;
}

export interface PairedDifference {
  /** Mean of `b[i] − a[i]`. */
  mean: number;
  /** Standard error of that mean. */
  stderr: number;
  /** 95% percentile bootstrap interval of the mean, resampling impressions. */
  ci95: [number, number];
}

/**
 * How much `b` beats `a` when both scored the same impressions: the mean per-impression
 * difference, its standard error, and a seeded (so reproducible) bootstrap interval.
 */
export function pairedDifference(
  b: readonly number[],
  a: readonly number[],
  resamples = 2000,
): PairedDifference {
  if (a.length !== b.length || a.length < 2) {
    throw new RangeError('pairedDifference needs two equally long lists of at least 2 scores');
  }
  const n = a.length;
  const d = Float64Array.from(b, (x, i) => x - a[i]!);
  const avg = d.reduce((s, x) => s + x, 0) / n;
  const variance = d.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1);
  let seed = 0x9e3779b9;
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sum += d[Math.floor((seed / 4294967296) * n)]!;
    }
    means[r] = sum / n;
  }
  means.sort();
  const at = (q: number) => means[Math.min(resamples - 1, Math.floor(q * resamples))]!;
  return { mean: avg, stderr: Math.sqrt(variance / n), ci95: [at(0.025), at(0.975)] };
}
