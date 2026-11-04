import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { Inkling, MemoryStore, type InklingOptions } from '../../src/client/index.ts';
import { build } from '../../src/node/build.ts';
import { documentInput, type EmbeddingProvider } from '../../src/node/providers/types.ts';
import type { CatalogItem } from '../../src/node/types.ts';
import { dirFetch, tempDir } from '../helpers.ts';

const TOPICS = ['bread', 'space', 'rail'] as const;
const now = () => Date.parse('2026-11-01T00:00:00Z');

/** A provider whose vectors are a topic axis plus a little of an item axis: crisp neighbours. */
function topicProvider(id: string, dims: number): EmbeddingProvider {
  return {
    model: { id, revision: '1', nativeDims: dims, documentPrompt: '{title}' },
    embed: (inputs) =>
      Promise.resolve(
        inputs.map((input) => {
          const v = new Float32Array(dims);
          TOPICS.forEach((t, i) => {
            if (input.includes(t)) v[i] = 1;
          });
          v[3 + (Number(/\d+/.exec(input)![0]) % (dims - 3))] = 0.3;
          return v;
        }),
      ),
  };
}

// Editorial order interleaves the topics: bread 0, space 0, rail 0, bread 1, …
const items: CatalogItem[] = [0, 1, 2, 3].flatMap((k) =>
  TOPICS.map((t, i) => ({
    id: `${t}-${k}`,
    url: `/${t}/${k}`,
    title: `${t} ${k * 3 + i}`,
    text: '',
    section: t,
  })),
);

let dir = '';
before(async () => {
  dir = await tempDir();
  await build({
    items,
    outDir: join(dir, 'v1'),
    provider: topicProvider('topics', 16),
    dims: 16,
    cacheDir: false,
  });
  // The same catalog with another model (another space), minus one item.
  await build({
    items: items.filter((i) => i.id !== 'bread-0'),
    outDir: join(dir, 'v2'),
    provider: topicProvider('topics-2', 12),
    dims: 12,
    cacheDir: false,
  });
});

function load(options: Partial<InklingOptions> = {}, version = 'v1') {
  return Inkling.load({
    manifest: `http://site/${version}/manifest.json`,
    fetch: dirFetch(dir),
    now,
    consent: true,
    store: new MemoryStore(),
    ...options,
  });
}

test('without consent nothing is recorded and the site’s order stands', async () => {
  const store = new MemoryStore();
  const ink = await load({ consent: undefined, store });
  assert.equal(await ink.record('view', 'bread-0'), false);
  assert.deepEqual(await store.all(), []);
  const recs = await ink.recommend({ n: 4 });
  assert.deepEqual(
    recs.map((r) => r.id),
    ['bread-0', 'space-0', 'rail-0', 'bread-1'],
  );
  assert.ok(recs.every((r) => r.why.confidence === 0 && r.why.because.length === 0));
  assert.ok(recs.every((r) => r.why.similarityShare === 0));
  assert.deepEqual((await ink.export()).signals, []);
});

test('views shape "for you": same topic first, seen items left out, with reasons', async () => {
  const ink = await load();
  assert.equal(await ink.record('view', 'rail-0'), true);
  await ink.record('view', 'rail-1');
  await ink.record('click', 'rail-1');
  const recs = await ink.recommend({ n: 3 });
  assert.deepEqual(
    recs
      .map((r) => r.id)
      .slice(0, 2)
      .sort(),
    ['rail-2', 'rail-3'],
  );
  assert.ok(!recs.some((r) => r.id === 'rail-0' || r.id === 'rail-1'));
  assert.equal(recs[0]!.why.confidence, 4 / 7);
  assert.ok(recs[0]!.why.similarityShare > 0.5, String(recs[0]!.why.similarityShare));
  assert.deepEqual(
    recs[0]!.why.because.map((b) => b.id),
    ['rail-1', 'rail-0'],
  );
  assert.ok(Math.abs(recs[0]!.why.because.reduce((sum, b) => sum + b.share, 0) - 1) < 1e-9);
  const withSeen = await ink.recommend({ n: 2, includeSeen: true, diversity: 0 });
  assert.ok(withSeen.some((r) => r.id === 'rail-1'));
});

test('hidden items never appear, and push their topic down', async () => {
  const ink = await load();
  await ink.record('follow', 'space-0');
  await ink.record('hide', 'bread-1');
  const recs = await ink.recommend({ n: 12, diversity: 0 });
  const ids = recs.map((r) => r.id);
  assert.ok(!ids.includes('bread-1'));
  assert.equal(ids.length, 10, 'all but the hidden item and the followed (known) one');
  assert.ok(ids.indexOf('space-1') < ids.indexOf('rail-0'));
  assert.ok(ids.indexOf('rail-0') < ids.indexOf('bread-0'), ids.join());
  // Forgetting an item undoes its hide.
  await ink.forget('bread-1');
  assert.ok((await ink.recommend({ n: 12 })).some((r) => r.id === 'bread-1'));
});

test('pause, resume, forget and export', async () => {
  const store = new MemoryStore();
  const ink = await load({ store });
  await ink.record('view', 'bread-0');
  await ink.pause();
  assert.equal(await ink.paused(), true);
  assert.equal(await ink.record('view', 'bread-1'), false);
  await ink.resume();
  assert.equal(await ink.record('dwell', 'bread-1', { seconds: 30 }), true);
  assert.equal(await ink.record('dwell', 'bread-2', { seconds: 5 }), false);
  assert.equal(await ink.record('dwell', 'bread-2', { seconds: Number.NaN }), false);
  assert.equal(await ink.record('nope' as 'view', 'bread-2'), false);
  const exported = await ink.export();
  assert.equal(exported.format, 'inkling/signals');
  assert.deepEqual(
    exported.signals.map((s) => [s.itemId, s.kind, s.weight]),
    [
      ['bread-0', 'view', 1],
      ['bread-1', 'dwell', 1],
    ],
  );
  await ink.forget();
  assert.deepEqual(await store.all(), []);
  assert.equal((await ink.recommend({ n: 1 }))[0]!.why.confidence, 0);
});

test('consent is asked every time, so withdrawing it stops personalization', async () => {
  let consent = true;
  const ink = await load({ consent: () => consent });
  await ink.record('view', 'space-0');
  assert.ok((await ink.recommend())[0]!.why.confidence > 0);
  consent = false;
  assert.equal((await ink.recommend())[0]!.why.confidence, 0);
  assert.equal(await ink.record('view', 'space-1'), false);
  // A throwing hook means no.
  const broken = await load({
    consent: () => {
      throw new Error('CMP not ready');
    },
  });
  assert.equal(await broken.record('view', 'space-1'), false);
});

test('rank() reorders a server list, keeping unknown ids and moving hidden ones last', async () => {
  const ink = await load();
  const list = ['bread-0', 'space-0', 'nope', 'rail-0', 'space-1'];
  assert.deepEqual(await ink.rank(list), ['bread-0', 'space-0', 'rail-0', 'space-1', 'nope']);
  // With the catalog's prior, the editorial order (bread-0, space-0, rail-0, …, space-1) decides.
  assert.deepEqual(await ink.rank([...list].reverse(), { prior: 'catalog' }), [
    'bread-0',
    'space-0',
    'rail-0',
    'space-1',
    'nope',
  ]);
  await ink.record('follow', 'space-2');
  await ink.record('follow', 'space-3');
  await ink.record('hide', 'bread-0');
  const ranked = await ink.rank(list, { diversity: 0 });
  assert.deepEqual(ranked.slice(0, 2).sort(), ['space-0', 'space-1']);
  assert.deepEqual(ranked.slice(-2), ['nope', 'bread-0']);
});

test('explain() shows how the profile sees an item', async () => {
  const ink = await load();
  await ink.record('view', 'bread-0');
  await ink.record('view', 'space-0');
  const bread = (await ink.explain('bread-2'))!;
  assert.equal(bread.signals, 2);
  assert.equal(bread.seen, false);
  assert.equal(bread.because[0]!.id, 'bread-0');
  assert.equal(bread.because[0]!.title, 'bread 0');
  assert.ok(bread.similarity > (await ink.explain('rail-2'))!.similarity);
  assert.equal((await ink.explain('bread-0'))!.seen, true);
  assert.equal(await ink.explain('nope'), undefined);
});

test('a new model needs no migration: the same signals meet the new vectors', async () => {
  const store = new MemoryStore();
  const v1 = await load({ store });
  for (const id of ['bread-0', 'bread-1']) {
    await v1.record('view', id);
    await v1.record('click', id);
  }
  const before = (await v1.recommend({ n: 2, diversity: 0 })).map((r) => r.id).sort();
  assert.deepEqual(before, ['bread-2', 'bread-3']);

  const v2 = await load({ store }, 'v2');
  assert.notEqual(v2.manifest.space, v1.manifest.space);
  const after = await v2.recommend({ n: 2, diversity: 0 });
  assert.deepEqual(after.map((r) => r.id).sort(), before);
  const explained = (await v2.explain('bread-2'))!;
  assert.equal(explained.missing, 1, 'bread-0 is not in the new catalog');
  assert.deepEqual(
    explained.because.map((b) => b.id),
    ['bread-1'],
  );
});

test('the signal store is pruned to its cap', async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 5; i++)
    await store.add({ itemId: `rail-${i % 4}`, kind: 'view', weight: 1, at: now() - i });
  const ink = await load({ store, maxSignals: 3 });
  await ink.record('view', 'space-0');
  const kept = await store.all();
  assert.equal(kept.length, 3);
  assert.ok(kept.some((s) => s.itemId === 'space-0'));
});

test('documentInput fills the prompt (topic provider sanity)', () => {
  assert.equal(documentInput('{title}', 'bread 3', ''), 'bread 3');
});
