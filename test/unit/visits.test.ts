import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Hunch, MemoryStore } from '../../src/client/index.ts';
import { nextVisit } from '../../src/client/signals.ts';
import { canSummarize, summarize } from '../../src/digest/summarize.ts';
import { build } from '../../src/node/build.ts';
import { hashProvider } from '../../src/node/providers/hash.ts';
import type { CatalogItem } from '../../src/node/types.ts';
import { dirFetch, tempDir } from '../helpers.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const t0 = Date.parse('2026-10-01T12:00:00Z');

test('a gap longer than the visit gap starts a new visit', () => {
  const first = nextVisit({ paused: false }, t0, 30 * MIN);
  assert.deepEqual(first, { paused: false, lastSeen: t0 });
  const same = nextVisit(first, t0 + 20 * MIN, 30 * MIN);
  assert.deepEqual(same, { paused: false, lastSeen: t0 + 20 * MIN });
  const next = nextVisit(same, t0 + 2 * DAY, 30 * MIN);
  assert.deepEqual(next, { paused: false, lastSeen: t0 + 2 * DAY, previousVisit: t0 + 20 * MIN });
  // A clock that goes backwards does not move lastSeen back.
  assert.equal(nextVisit(next, t0, 30 * MIN).lastSeen, t0 + 2 * DAY);
});

let dir = '';
const items: CatalogItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `item-${i}`,
  url: `/${i}`,
  title: `${i % 2 ? 'Bread' : 'Rail'} story ${i}`,
  text: i % 2 ? 'baking bread sourdough' : 'night trains rail travel',
  section: i % 2 ? 'Food' : 'Travel',
  // item-0 is the newest: one a day, going back.
  date: new Date(t0 + 5 * DAY - i * DAY).toISOString(),
}));
before(async () => {
  dir = await tempDir();
  await build({ items, outDir: dir, provider: hashProvider(), cacheDir: false });
});

async function load(now: () => number, store = new MemoryStore(), consent = true) {
  return Hunch.load({
    manifest: 'http://site/manifest.json',
    fetch: dirFetch(dir),
    consent,
    store,
    now,
  });
}

test('since your last visit: items published after the previous visit, ranked', async () => {
  let now = t0;
  const store = new MemoryStore();
  const hunch = await load(() => now, store);
  assert.deepEqual(await hunch.sinceLastVisit(), [], 'first visit');
  assert.equal((await store.getState()).lastSeen, t0);
  await hunch.record('view', 'item-9');

  // Three days later: items 0 to 4 are dated after the first visit (t0); item-5 is dated t0.
  now = t0 + 3 * DAY + 10 * MIN;
  const recs = await hunch.sinceLastVisit({ n: 10 });
  assert.deepEqual(recs.map((r) => r.id).sort(), [
    'item-0',
    'item-1',
    'item-2',
    'item-3',
    'item-4',
  ]);
  assert.ok(recs.every((r) => Date.parse(r.date!) > t0));
  // Food first: the visitor read a Food item.
  assert.equal(recs[0]!.section, 'Food');
  // Later in the same visit, the same previous visit.
  now += 5 * MIN;
  assert.equal(await hunch.visit(), t0);
  assert.equal((await hunch.sinceLastVisit({ n: 10 })).length, recs.length);
});

test('without consent, or while paused, visits are not recorded', async () => {
  const store = new MemoryStore();
  const hunch = await load(() => t0, store, false);
  assert.equal(await hunch.visit(), undefined);
  assert.deepEqual(await store.getState(), { paused: false });
  const paused = await load(() => t0, store);
  await paused.pause();
  assert.equal(await paused.visit(), undefined);
  assert.deepEqual(await store.getState(), { paused: true });
});

test('the Summarizer is used only where an on-device model is available', async () => {
  const g = globalThis as { Summarizer?: unknown };
  assert.equal(await summarize([{ title: 'A' }]), null, 'no Summarizer API');
  const calls: string[] = [];
  let availability = 'downloadable';
  g.Summarizer = {
    availability: () => Promise.resolve(availability),
    create: (options: { sharedContext: string }) =>
      Promise.resolve({
        summarize: (text: string) => {
          calls.push(`${options.sharedContext}|${text}`);
          return Promise.resolve(' Two new stories. ');
        },
        destroy: () => calls.push('destroyed'),
      }),
  };
  try {
    assert.equal(await canSummarize(), false);
    assert.equal(await canSummarize({ allowDownload: true }), true);
    assert.equal(await summarize([{ title: 'A' }]), null);
    availability = 'available';
    assert.equal(await summarize([]), null);
    assert.equal(
      await summarize([{ title: 'A', section: 'Food' }, { title: 'B' }], {
        sharedContext: 'A food blog.',
      }),
      'Two new stories.',
    );
    assert.deepEqual(calls, ['A food blog.|A (Food)\nB', 'destroyed']);
  } finally {
    delete g.Summarizer;
  }
});

test('since your last visit leaves out seen and hidden items, like recommend()', async () => {
  let now = t0;
  const store = new MemoryStore();
  const hunch = await load(() => now, store);
  await hunch.visit();
  now = t0 + 3 * DAY;
  // Both dated after the first visit.
  await hunch.record('view', 'item-2');
  await hunch.record('hide', 'item-3');
  const ids = (await hunch.sinceLastVisit({ n: 10 })).map((r) => r.id);
  assert.ok(ids.length > 0);
  assert.ok(!ids.includes('item-2') && !ids.includes('item-3'), ids.join());
  const withSeen = (await hunch.sinceLastVisit({ n: 10, includeSeen: true })).map((r) => r.id);
  assert.ok(withSeen.includes('item-2'));
  assert.ok(!withSeen.includes('item-3'));
});

test('a visit never overwrites a pause, and does not undo a forget', async () => {
  const store = new MemoryStore();
  const hunch = await load(() => t0, store);
  await hunch.visit();
  await Promise.all([hunch.pause(), hunch.visit()]);
  assert.equal((await store.getState()).paused, true);
  await hunch.resume();
  await hunch.forget();
  assert.deepEqual(await store.getState(), { paused: false });
  assert.equal(await hunch.visit(), undefined, 'a first visit again');
});
