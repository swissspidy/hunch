/**
 * Ranking in slices (ADR 0008): the steps, the pauses between them, and that the results are
 * exactly what the client returned before.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { syntheticCatalog, type SyntheticCatalog } from '../../scripts/synthetic.ts';
import { Inkling, MemoryStore } from '../../src/client/index.ts';
import { slicer } from '../../src/client/slices.ts';
import { DEFAULT_WEIGHTS, rank, ranking, type RankInput } from '../../src/rank/rank.ts';
import { DIMS, ITEMS, SECTIONS, rankingCalls, type Result } from '../fixtures/large-catalog.ts';
import { referenceRank } from '../reference-rank.ts';

/** A seeded generator in [0, 1). */
function random(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Inputs with many ties: values on a coarse grid. */
function input(count: number, seed: number, grid: number): RankInput {
  const r = random(seed);
  const value = () => Math.round(r() * grid) / grid;
  const sims = Array.from({ length: count }, () => value() * 2 - 1);
  const priors = Array.from({ length: count }, value);
  const recencies = Array.from({ length: count }, value);
  const pair = (i: number, j: number) => Math.cos(i * 7 + j * 13);
  return {
    similarity: (i) => sims[i]!,
    prior: (i) => priors[i]!,
    recency: (i) => recencies[i]!,
    pairwise: (i, j) => pair(Math.min(i, j), Math.max(i, j)),
  };
}

test('rank() picks exactly what a full sort of every candidate picked', () => {
  let cases = 0;
  for (const count of [1, 3, 60, 1000, 5000]) {
    for (const grid of [4, 1000, 2 ** 30]) {
      for (const [n, diversity, confidence] of [
        [5, 0.2, 1],
        [10, 0, 0.6],
        [50, 0.3, 0],
        [200, 0.2, 0.9],
      ] as const) {
        const seed = count * 31 + grid + n;
        // Candidates in no particular order, so ties fall to the index rule.
        const candidates = Array.from({ length: count }, (_, i) => (i * 7919) % count);
        const options = {
          n,
          confidence,
          weights: DEFAULT_WEIGHTS,
          diversity,
          poolSize: Math.max(4 * n, 50),
        };
        const expected = referenceRank(candidates, input(count, seed, grid), options);
        assert.deepEqual(rank(candidates, input(count, seed, grid), options), expected);
        cases++;
      }
    }
  }
  assert.equal(cases, 60);
});

test('ranking() pauses every 512 candidates, and its result does not depend on the pauses', () => {
  const candidates = Array.from({ length: 2000 }, (_, i) => i);
  const options = {
    n: 10,
    confidence: 0.8,
    weights: DEFAULT_WEIGHTS,
    diversity: 0.2,
    poolSize: 50,
  };
  const steps = ranking(candidates, input(2000, 3, 1000), options);
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses++;
    step = steps.next();
  }
  // Four slices to score, four to pick the pool.
  assert.equal(pauses, 8);
  assert.deepEqual(step.value, rank(candidates, input(2000, 3, 1000), options));
  // Nothing to rank: no pause at all.
  assert.equal(ranking([], input(0, 1, 10), options).next().done, true);
});

test('a slicer yields only once a slice has run its time', async () => {
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => clock;
  try {
    const pause = slicer();
    clock = 9;
    assert.equal(pause(), undefined);
    clock = 11;
    const pending = pause();
    assert.ok(pending instanceof Promise);
    await pending;
    // A new slice starts after the yield.
    clock = 20;
    assert.equal(pause(), undefined);
  } finally {
    performance.now = realNow;
  }
});

let catalog: SyntheticCatalog;
let expected: Result[];
before(async () => {
  catalog = await syntheticCatalog(ITEMS, DIMS, SECTIONS, 'int8');
  expected = JSON.parse(
    await readFile(new URL('../fixtures/large-catalog.json', import.meta.url), 'utf8'),
  ) as Result[];
});

const g = globalThis as { scheduler?: { yield(): Promise<void> } };
after(() => delete g.scheduler);

test('20,000 items: same ids and scores as before slicing, with scheduler.yield()', async () => {
  let yields = 0;
  g.scheduler = {
    yield: () => {
      yields++;
      return Promise.resolve();
    },
  };
  // A clock that runs fast: every check finds the slice over, so every pause yields.
  let clock = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => (clock += 20);
  try {
    assert.deepEqual(await rankingCalls(Inkling, new MemoryStore(), catalog), expected);
  } finally {
    performance.now = realNow;
    delete g.scheduler;
  }
  // Candidates (40 slices) and ranking (80 slices) for each of the full-catalog calls, and
  // one yield before and after verifying each of the 10 shards.
  assert.ok(yields > 500, `${yields} yields`);
});

test('20,000 items: same ids and scores without scheduler.yield() (new tasks instead)', async () => {
  assert.equal(g.scheduler, undefined);
  assert.deepEqual(await rankingCalls(Inkling, new MemoryStore(), catalog), expected);
});
