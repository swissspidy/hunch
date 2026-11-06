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
import {
  DIMS,
  ITEMS,
  assertSameResults,
  NOW,
  SECTIONS,
  rankingCalls,
  type Result,
} from '../fixtures/large-catalog.ts';
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

test('ranking() pauses after every MMR pick, whatever the result', () => {
  const candidates = Array.from({ length: 2000 }, (_, i) => i);
  const options = {
    n: 10,
    confidence: 0.8,
    weights: DEFAULT_WEIGHTS,
    diversity: 0.2,
    poolSize: 50,
  };
  const ranked = input(2000, 3, 1000);
  const columns = {
    similarity: candidates.map((c) => ranked.similarity(c)),
    prior: candidates.map((c) => ranked.prior(c)),
    recency: candidates.map((c) => ranked.recency(c)),
    pairwise: (i: number, j: number) => ranked.pairwise(i, j),
  };
  const steps = ranking(columns, options);
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses++;
    step = steps.next();
  }
  // Scoring and choosing the pool run over typed arrays in one go; one pause per MMR pick.
  assert.equal(pauses, 10);
  assert.deepEqual(step.value, rank(candidates, ranked, options));
  // Nothing to rank: no pause at all.
  const none = { similarity: [], prior: [], recency: [], pairwise: () => 0 };
  assert.equal(ranking(none, options).next().done, true);
});

test('a whole list (n = every candidate, as rank(ids) asks) ranks as a full sort did', () => {
  const count = 3000;
  // Ascending priors: with no confidence, every candidate is better than the ones before.
  const candidates = Array.from({ length: count }, (_, i) => i);
  for (const [confidence, diversity] of [
    [0, 0],
    [0.7, 0],
    [0.7, 0.2],
  ] as const) {
    const options = {
      n: count,
      confidence,
      weights: DEFAULT_WEIGHTS,
      diversity,
      poolSize: 4 * count,
    };
    const ascending: RankInput = { ...input(count, 11, 50), prior: (i) => i / count };
    assert.deepEqual(
      rank(candidates, ascending, options),
      referenceRank(candidates, ascending, options),
    );
  }
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
    assertSameResults(await rankingCalls(Inkling, new MemoryStore(), catalog), expected);
  } finally {
    performance.now = realNow;
    delete g.scheduler;
  }
  // Three yields for each of the 10 shards, one per 8,192 rows of similarities, and one per
  // diversity pick.
  assert.ok(yields > 100, `${yields} yields`);
});

test('20,000 items: same ids and scores without scheduler.yield() (new tasks instead)', async () => {
  assert.equal(g.scheduler, undefined);
  assertSameResults(await rankingCalls(Inkling, new MemoryStore(), catalog), expected);
});

test('20,000 items: the JavaScript kernel gives the same results as the WebAssembly one', async () => {
  assertSameResults(await rankingCalls(Inkling, new MemoryStore(), catalog, 'js'), expected);
});

test('ties come in manifest order, whatever order the shards arrive in', async () => {
  const cold = expected.find((r) => r.call === 'cold recommend')!;
  // Holds every shard until all of them are requested, then answers in reverse manifest order.
  const held: { path: string; resolve: (r: Response) => void }[] = [];
  const shards = catalog.manifest.shards.length;
  const fetchFn = (input: string | URL): Promise<Response> => {
    const path = new URL(input).pathname.slice(1);
    if (path === 'manifest.json') {
      return Promise.resolve(new Response(JSON.stringify(catalog.manifest)));
    }
    return new Promise((resolve) => {
      held.push({ path, resolve });
      if (held.length < shards) return;
      void (async () => {
        const order = catalog.manifest.shards.map((ref) => ref.url).reverse();
        for (const url of order) {
          held.find((h) => h.path === url)!.resolve(new Response(catalog.files.get(url)!.slice()));
          // Long enough for that shard to be verified, decoded and indexed first.
          await new Promise((wait) => setTimeout(wait, 20));
        }
      })();
    });
  };
  const ink = await Inkling.load({
    manifest: 'http://large/manifest.json',
    fetch: fetchFn,
    consent: true,
    store: new MemoryStore(),
    now: () => NOW,
  });
  const recs = await ink.recommend({ n: 10 });
  assert.equal(held.length, shards);
  // The cold start ranks the first item of every section equally (prior 1): manifest order.
  assert.deepEqual(
    recs.map((r) => r.id),
    cold.ids,
  );
});
