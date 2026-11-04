import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { buildProfile, profileSimilarity } from '../../src/client/profile.ts';
import {
  aggregate,
  dwellWeight,
  IndexedDbStore,
  toPrune,
  type Signal,
} from '../../src/client/signals.ts';

const DAY = 86_400_000;
const now = Date.parse('2026-11-01T00:00:00Z');

test('implicit signals halve every half-life; explicit ones do not decay', () => {
  const agg = aggregate(
    [
      { itemId: 'a', kind: 'view', weight: 1, at: now },
      { itemId: 'a', kind: 'click', weight: 2, at: now - 21 * DAY },
      { itemId: 'b', kind: 'follow', weight: 5, at: now - 365 * DAY },
    ],
    now,
    21,
  );
  assert.equal(agg.get('a')!.score, 2);
  assert.equal(agg.get('a')!.seen, true);
  assert.equal(agg.get('b')!.score, 5);
  assert.equal(agg.get('b')!.seen, true, 'a followed item is known');
});

test('the latest explicit signal decides whether an item is hidden', () => {
  const hiddenThenFollowed = aggregate(
    [
      { itemId: 'a', kind: 'hide', weight: -5, at: now - 2 },
      { itemId: 'a', kind: 'follow', weight: 5, at: now - 1 },
    ],
    now,
    21,
  );
  assert.equal(hiddenThenFollowed.get('a')!.hidden, false);
  const hidden = aggregate([{ itemId: 'a', kind: 'hide', weight: -5, at: now }], now, 21);
  assert.equal(hidden.get('a')!.hidden, true);
  assert.equal(hidden.get('a')!.score, -5);
});

test('dwell counts from 10 seconds and caps at a minute', () => {
  assert.equal(dwellWeight(9), 0);
  assert.equal(dwellWeight(30), 1);
  assert.equal(dwellWeight(600), 2);
});

test('pruning drops old implicit signals, then the oldest past the cap', () => {
  const s = (seq: number, kind: Signal['kind'], ageDays: number): Signal => ({
    seq,
    itemId: `i${seq}`,
    kind,
    weight: 1,
    at: now - ageDays * DAY,
  });
  const signals = [
    s(1, 'view', 200),
    s(2, 'follow', 400),
    s(3, 'view', 10),
    s(4, 'click', 5),
    s(5, 'view', 1),
  ];
  assert.deepEqual(
    toPrune(signals, now, 10, 180).sort((a, b) => a - b),
    [1],
  );
  assert.deepEqual(
    toPrune(signals, now, 2, 180).sort((a, b) => a - b),
    [1, 3, 4],
  );
  // Explicit signals go last.
  assert.deepEqual(
    toPrune(signals, now, 1, 180).sort((a, b) => a - b),
    [1, 3, 4, 5],
  );
});

test('the profile is the weighted mean of positive items, minus the negative ones', () => {
  const vectors: Record<string, Float32Array> = {
    a: Float32Array.of(1, 0, 0),
    b: Float32Array.of(0, 1, 0),
    c: Float32Array.of(0, 0, 1),
  };
  const agg = aggregate(
    [
      { itemId: 'a', kind: 'follow', weight: 5, at: now },
      { itemId: 'b', kind: 'view', weight: 1, at: now },
      { itemId: 'c', kind: 'hide', weight: -5, at: now },
      { itemId: 'gone', kind: 'view', weight: 1, at: now },
    ],
    now,
    21,
  );
  const profile = buildProfile(agg, (id) => vectors[id], 3);
  assert.equal(profile.mass, 6);
  assert.equal(profile.confidence, 6 / 9);
  assert.deepEqual(profile.missing, ['gone']);
  assert.deepEqual(
    profile.contributors.map((c) => c.itemId),
    ['a', 'b'],
  );
  const norm = Math.hypot(5, 1);
  assert.ok(Math.abs(profile.positive![0]! - 5 / norm) < 1e-6);
  assert.deepEqual([...profile.negative!], [0, 0, 1]);
  assert.equal(profileSimilarity(0.8, 0.6), 0.5);
  assert.equal(profileSimilarity(0.8, -0.6), 0.8);
  const empty = buildProfile(new Map(), () => undefined, 3);
  assert.equal(empty.positive, null);
  assert.equal(empty.confidence, 0);
});

test('IndexedDbStore stores, deletes, keeps state and destroys its database', async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const store = new IndexedDbStore('inkling-test');
    await store.add({ itemId: 'a', kind: 'view', weight: 1, at: 1 });
    await store.add({ itemId: 'b', kind: 'hide', weight: -5, at: 2 });
    const all = await store.all();
    assert.deepEqual(
      all.map((s) => [s.seq, s.itemId]),
      [
        [1, 'a'],
        [2, 'b'],
      ],
    );
    await store.delete([1]);
    assert.deepEqual(
      (await store.all()).map((s) => s.itemId),
      ['b'],
    );
    assert.deepEqual(await store.getState(), { paused: false });
    await store.setState({ paused: true });
    assert.deepEqual(await store.getState(), { paused: true });
    assert.deepEqual(
      (await indexedDB.databases()).map((d) => d.name),
      ['inkling-test'],
    );
    await store.destroy();
    assert.deepEqual(await indexedDB.databases(), []);
    // Usable again after destroy (a fresh database).
    assert.deepEqual(await store.all(), []);
  } finally {
    globalThis.indexedDB = original;
  }
});
