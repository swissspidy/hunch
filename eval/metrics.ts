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
