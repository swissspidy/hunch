/**
 * Ranking calls on a large synthetic catalog, for the test that slicing (ADR 0008) leaves every
 * result as it was. `test/fixtures/large-catalog.json` holds what the client returned for them
 * before ranking was sliced, and `assertSameResults` compares with it: the same ids, and the
 * same scores to within 1e-8 (the similarity kernel's arithmetic differs from the old code's
 * float64 sums in the last bits, ADR 0010).
 */

import assert from 'node:assert/strict';

import type { Inkling, SignalStore } from '../../src/client/index.ts';
import type { SyntheticCatalog } from '../../scripts/synthetic.ts';

export const ITEMS = 20_000;
export const DIMS = 64;
export const SECTIONS = 10;
export const NOW = Date.UTC(2026, 3, 1);

interface Client {
  load: typeof Inkling.load;
}

export interface Result {
  call: string;
  ids: string[];
  scores: number[];
}

/** Runs the calls with `Client` (the current one, or an older one) and returns their results. */
export async function rankingCalls(
  Client: Client,
  store: SignalStore,
  catalog: SyntheticCatalog,
  kernel?: 'wasm' | 'js',
): Promise<Result[]> {
  const fetchFn = (input: string | URL) => {
    const path = new URL(input).pathname.slice(1);
    return Promise.resolve(
      path === 'manifest.json'
        ? new Response(JSON.stringify(catalog.manifest))
        : new Response(catalog.files.get(path)!.slice()),
    );
  };
  const ink = await Client.load({
    manifest: 'http://large/manifest.json',
    fetch: fetchFn,
    consent: true,
    store,
    now: () => NOW,
    ...(kernel && { kernel }),
  });
  const id = (i: number) => `s${i % SECTIONS}-item-${Math.floor(i / SECTIONS)}`;
  const results: Result[] = [];
  const add = async (call: string, recs: Promise<{ id: string; score: number }[]>) => {
    const list = await recs;
    results.push({ call, ids: list.map((r) => r.id), scores: list.map((r) => r.score) });
  };
  await add('related', ink.related(id(5), { n: 10 }));
  await add('related same section', ink.related(id(17), { n: 10, sections: 'same' }));
  await add('cold recommend', ink.recommend({ n: 10 }));
  for (let i = 0; i < 40; i++) await ink.record(i % 3 ? 'view' : 'click', id(i * 13));
  await ink.record('hide', id(7));
  await ink.record('follow', id(1234));
  await add('recommend', ink.recommend({ n: 10 }));
  await add('recommend, no diversity', ink.recommend({ n: 20, diversity: 0 }));
  await add(
    'recommend, two sections',
    ink.recommend({ n: 10, sections: ['section-2', 'section-7'] }),
  );
  let seed = 7;
  const query = Array.from(
    { length: DIMS },
    () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1,
  );
  await add('search', ink.search(query, { n: 10 }));
  await add('search, personalized', ink.search(query, { n: 10, personalize: 0.5 }));
  const list = Array.from({ length: 30 }, (_, i) => id(i * 101));
  const ranked = await ink.rank(list);
  results.push({ call: 'rank', ids: ranked, scores: [] });
  return results;
}

/** The same ids in the same order, and scores within 1e-8 of the expected ones. */
export function assertSameResults(actual: Result[], expected: Result[]): void {
  assert.deepEqual(
    actual.map((r) => [r.call, r.ids]),
    expected.map((r) => [r.call, r.ids]),
  );
  actual.forEach((r, i) => {
    r.scores.forEach((score, k) => {
      const want = expected[i]!.scores[k]!;
      assert.ok(Math.abs(score - want) < 1e-8, `${r.call} #${k}: ${score} vs ${want}`);
    });
  });
}
