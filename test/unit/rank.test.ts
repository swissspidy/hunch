import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WEIGHTS, rank, recency, type RankInput } from '../../src/rank/rank.ts';

function input(
  sims: number[],
  pair: (i: number, j: number) => number,
  priors?: number[],
): RankInput {
  return {
    similarity: (i) => sims[i]!,
    prior: (i) => priors?.[i] ?? 0,
    recency: () => 0,
    pairwise: pair,
  };
}
const options = { n: 3, confidence: 1, weights: DEFAULT_WEIGHTS, diversity: 0, poolSize: 10 };

test('without diversity, candidates come by similarity', () => {
  const ranked = rank(
    [0, 1, 2, 3],
    input([0.1, 0.9, 0.5, 0.7], () => 0),
    options,
  );
  assert.deepEqual(
    ranked.map((r) => r.index),
    [1, 3, 2],
  );
});

test('MMR skips near-duplicates of what it already picked', () => {
  // 0 and 1 are near-identical and both very similar to the query; 2 is a bit less similar.
  const pair = (i: number, j: number) =>
    (i === 0 && j === 1) || (i === 1 && j === 0) ? 0.99 : 0.5;
  const sims = [0.9, 0.89, 0.85, 0.5];
  const plain = rank([0, 1, 2, 3], input(sims, pair), { ...options, n: 2 });
  assert.deepEqual(
    plain.map((r) => r.index),
    [0, 1],
  );
  const diverse = rank([0, 1, 2, 3], input(sims, pair), { ...options, n: 2, diversity: 0.3 });
  assert.deepEqual(
    diverse.map((r) => r.index),
    [0, 2],
  );
  // Redundancy is rescaled like relevance: a cosine of 0.5 is the candidates' minimum.
  assert.equal(diverse[1]!.redundancy, 0);
});

test('similarity is rescaled over the candidates, so the cosine band does not matter', () => {
  const narrow = rank(
    [0, 1, 2],
    input([0.3, 0.35, 0.4], () => 0),
    options,
  );
  const wide = rank(
    [0, 1, 2],
    input([-0.8, 0.1, 1], () => 0),
    options,
  );
  assert.ok(Math.abs(narrow[1]!.relevance - 0.5) < 1e-9);
  assert.deepEqual(
    narrow.map((r) => r.index),
    wide.map((r) => r.index),
  );
  assert.equal(narrow[0]!.relevance, 1);
  assert.equal(narrow[2]!.relevance, 0);
  assert.equal(narrow[0]!.similarity, 0.4);
});

test('with no confidence the prior decides (cold start)', () => {
  const ranked = rank(
    [0, 1, 2],
    input([0.9, 0.1, 0.5], () => 0, [0.2, 1, 0.6]),
    { ...options, confidence: 0 },
  );
  assert.deepEqual(
    ranked.map((r) => r.index),
    [1, 2, 0],
  );
});

test('ties are broken by prior, then by index', () => {
  const ranked = rank(
    [2, 1, 0],
    input([0.5, 0.5, 0.5], () => 0, [0, 0.5, 0]),
    options,
  );
  assert.deepEqual(
    ranked.map((r) => r.index),
    [1, 0, 2],
  );
});

test('recency halves every half-life', () => {
  const now = Date.parse('2026-01-31T00:00:00Z');
  assert.equal(recency('2026-01-31T00:00:00Z', now, 30), 1);
  assert.ok(Math.abs(recency('2026-01-01T00:00:00Z', now, 30) - 0.5) < 1e-9);
  assert.equal(recency(undefined, now, 30), 0);
  assert.equal(recency('not a date', now, 30), 0);
  assert.equal(recency('2027-01-01T00:00:00Z', now, 30), 1);
});

test('n of 0 or no candidates give nothing', () => {
  assert.deepEqual(
    rank(
      [],
      input([], () => 0),
      options,
    ),
    [],
  );
  assert.deepEqual(
    rank(
      [0],
      input([1], () => 0),
      { ...options, n: 0 },
    ),
    [],
  );
});
