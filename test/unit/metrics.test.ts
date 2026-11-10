import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mean, pairedDifference, score } from '../../eval/metrics.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('a perfect ranking scores 1 everywhere', () => {
  const m = score(['a', 'b', 'c', 'd'], new Set(['a', 'b']));
  assert.deepEqual(m, { auc: 1, mrr: 0.75, ndcg5: 1, ndcg10: 1, recall10: 1 });
});

test('the worst ranking has an AUC of 0', () => {
  const m = score(['c', 'd', 'a'], new Set(['a']));
  near(m.auc, 0);
  near(m.mrr, 1 / 3);
  near(m.ndcg5, 1 / Math.log2(4));
});

test('AUC counts ordered pairs, MRR follows MIND (mean reciprocal rank of the clicks)', () => {
  // Clicks at ranks 2 and 4 of 5: pairs (2>3,2>5,4>5) of 6 are right.
  const m = score(['n1', 'p1', 'n2', 'p2', 'n3'], new Set(['p1', 'p2']));
  near(m.auc, 3 / 6);
  near(m.mrr, (1 / 2 + 1 / 4) / 2);
  near(m.ndcg5, (1 / Math.log2(3) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3)));
  near(m.recall10, 1);
});

test('recall@10 only counts the top ten', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `i${i}`);
  near(score(ids, new Set(['i0', 'i11'])).recall10, 0.5);
});

test('mean averages each metric', () => {
  const a = score(['a', 'b'], new Set(['a']));
  const b = score(['b', 'a'], new Set(['a']));
  near(mean([a, b]).auc, 0.5);
});

test('pairedDifference: mean, standard error and a bootstrap interval of b − a', () => {
  const a = [0.1, 0.5, 0.3, 0.9, 0.2, 0.4];
  const same = pairedDifference(a, a);
  assert.deepEqual(same, { mean: 0, stderr: 0, ci95: [0, 0] });

  const shifted = pairedDifference(
    a.map((x) => x + 0.25),
    a,
  );
  assert.ok(Math.abs(shifted.mean - 0.25) < 1e-12);
  assert.ok(shifted.stderr < 1e-12);

  // Differences of +1 and −1 in equal numbers: mean 0, standard error 1 / sqrt(n − 1).
  const n = 400;
  const b = Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1));
  const zero = new Array<number>(n).fill(0);
  const noisy = pairedDifference(b, zero);
  assert.equal(noisy.mean, 0);
  assert.ok(Math.abs(noisy.stderr - 1 / Math.sqrt(n - 1)) < 1e-12);
  // The 95% interval is about ±1.96 standard errors around the mean, and deterministic.
  assert.ok(noisy.ci95[0] < -1.5 * noisy.stderr && noisy.ci95[0] > -2.5 * noisy.stderr);
  assert.ok(noisy.ci95[1] > 1.5 * noisy.stderr && noisy.ci95[1] < 2.5 * noisy.stderr);
  assert.deepEqual(pairedDifference(b, zero), noisy);

  assert.throws(() => pairedDifference([1, 2], [1]), RangeError);
  for (const resamples of [0, -1, 2.5, Number.NaN]) {
    assert.throws(() => pairedDifference(b, zero, resamples), RangeError, String(resamples));
  }
});
