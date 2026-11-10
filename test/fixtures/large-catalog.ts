/**
 * Ranking calls on a large synthetic catalog, for the test that slicing (ADR 0008) leaves every
 * result as it was. `test/fixtures/large-catalog.json` holds what the client returned for them
 * before ranking was sliced, and `assertSameResults` compares with it: the same ids, and the
 * same scores to within 1e-8 (the similarity kernel's arithmetic differs from the old code's
 * float64 sums in the last bits, ADR 0010).
 */

import assert from 'node:assert/strict';

import { Hunch, type SignalStore } from '../../src/client/index.ts';
import { MANIFEST_FORMAT_VERSION, type Manifest } from '../../src/format/manifest.ts';
import { encodeShard } from '../../src/format/shard.ts';
import { normalize } from '../../src/rank/vector.ts';
import type { SyntheticCatalog } from '../../scripts/synthetic.ts';
import { random } from '../helpers.ts';

const ITEMS = 20_000;
const DIMS = 64;
const SECTIONS = 10;
export const NOW = Date.UTC(2026, 3, 1);

/**
 * The catalog the results were recorded with: 20,000 items in ten sections, a shard each,
 * random unit vectors as int8, and in every section priors that fall from 1. It is cut here
 * and not by the benchmarks' `syntheticCatalog`, whose shards and priors follow the build's
 * (ADR 0012): the recorded results are for this catalog, whatever a build writes today.
 */
export async function largeCatalog(): Promise<SyntheticCatalog> {
  const next = random(42);
  const files: SyntheticCatalog['files'] = new Map();
  const shards: Manifest['shards'] = [];
  const n = ITEMS / SECTIONS;
  for (let s = 0; s < SECTIONS; s++) {
    const items = Array.from({ length: n }, (_, i) => ({
      id: `s${s}-item-${i}`,
      url: `https://news.example/section-${s}/2026/11/a-typical-headline-slug-for-item-${i}/`,
      title: `A typical headline for item ${i} of section ${s}, about this long`,
      section: `section-${s}`,
      tags: ['politics', 'europe'],
      date: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      prior: (n - i) / n,
    }));
    const vectors = items.map(() => normalize(Array.from({ length: DIMS }, () => next() * 2 - 1)));
    const bytes = encodeShard({ space: 'bench', items }, vectors, DIMS, 'int8');
    const url = `shards/section-${s}.hunch`;
    files.set(url, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    shards.push({
      url,
      section: `section-${s}`,
      count: n,
      bytes: bytes.length,
      sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
  }
  return {
    manifest: {
      format: 'hunch/manifest',
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: 'bench',
      generatedAt: new Date(0).toISOString(),
      space: 'bench',
      model: { id: 'bench', revision: '0', nativeDims: DIMS, documentPrompt: '' },
      dims: DIMS,
      quantization: 'int8',
      count: ITEMS,
      sections: Array.from({ length: SECTIONS }, (_, s) => `section-${s}`),
      shards,
    },
    files,
  };
}

export interface Result {
  call: string;
  ids: string[];
  scores: number[];
}

/** Runs the calls and returns their results. */
export async function rankingCalls(
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
  const hunch = await Hunch.load({
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
  await add('related', hunch.related(id(5), { n: 10 }));
  await add('related same section', hunch.related(id(17), { n: 10, sections: 'same' }));
  await add('cold recommend', hunch.recommend({ n: 10 }));
  for (let i = 0; i < 40; i++) await hunch.record(i % 3 ? 'view' : 'click', id(i * 13));
  await hunch.record('hide', id(7));
  await hunch.record('follow', id(1234));
  await add('recommend', hunch.recommend({ n: 10 }));
  await add('recommend, no diversity', hunch.recommend({ n: 20, diversity: 0 }));
  await add(
    'recommend, two sections',
    hunch.recommend({ n: 10, sections: ['section-2', 'section-7'] }),
  );
  const next = random(7);
  const query = Array.from({ length: DIMS }, () => next() * 2 - 1);
  await add('search', hunch.search(query, { n: 10 }));
  await add('search, personalized', hunch.search(query, { n: 10, personalize: 0.5 }));
  const list = Array.from({ length: 30 }, (_, i) => id(i * 101));
  const ranked = await hunch.rank(list);
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
