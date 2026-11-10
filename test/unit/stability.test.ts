/**
 * The stability promises of ADR 0009, pinned.
 *
 * test/fixtures/format-v1 is a catalog built with format version 1 (manifest and shards) and
 * frozen: never rebuild it. Every release must keep decoding it, byte for byte, for as long as
 * ADR 0009 says readers keep reading version 1. A change to the format shows up here, and then
 * needs a new format version, a new frozen fixture next to this one, and the ADR's rules.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { Hunch } from '../../src/client/index.ts';
import { aggregate, IndexedDbStore, toPrune, type Signal } from '../../src/client/signals.ts';
import {
  assertManifest,
  MANIFEST_FORMAT_VERSION,
  type Manifest,
} from '../../src/format/manifest.ts';
import { decodeShard, encodeShard, SHARD_FORMAT_VERSION } from '../../src/format/shard.ts';
import { build } from '../../src/node/build.ts';
import { hashProvider } from '../../src/node/providers/hash.ts';
import { arrayBuffer, dirFetch, tempDir } from '../helpers.ts';

const V1 = 'test/fixtures/format-v1';
const FOOD_SHARD = 'shards/food.a9821627ccc1.hunch';

async function fixture(): Promise<{ manifest: Manifest; shards: Map<string, Buffer> }> {
  const manifest: unknown = JSON.parse(await readFile(join(V1, 'manifest.json'), 'utf8'));
  assertManifest(manifest);
  const shards = new Map<string, Buffer>();
  for (const ref of manifest.shards) shards.set(ref.url, await readFile(join(V1, ref.url)));
  return { manifest, shards };
}

test('format v1: the frozen manifest is read as it was written', async () => {
  const { manifest } = await fixture();
  assert.equal(manifest.format, 'hunch/manifest');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.space, 'hunch/hash@1|native=16|dims=8|prompt=1e7c1420');
  assert.equal(manifest.dims, 8);
  assert.equal(manifest.quantization, 'int8');
  assert.equal(manifest.count, 4);
  assert.deepEqual(manifest.sections, ['Food', 'Travel']);
  assert.deepEqual(
    manifest.shards.map((s) => [s.url, s.section, s.count]),
    [
      [FOOD_SHARD, 'Food', 2],
      ['shards/travel.49f872c005d0.hunch', 'Travel', 1],
      ['shards/all.127cc2a88bc1.hunch', null, 1],
    ],
  );
});

test('format v1: the frozen shards decode to the same items, columns and vectors', async () => {
  const { manifest, shards } = await fixture();
  for (const ref of manifest.shards) {
    const bytes = shards.get(ref.url)!;
    assert.equal(bytes.length, ref.bytes, ref.url);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256, ref.url);
    // The fixed header: magic "HNCH", version 1, int8, reserved 0, dims 8.
    assert.deepEqual([...bytes.subarray(0, 12)], [72, 78, 67, 72, 1, 1, 0, 0, 8, 0, 0, 0]);
    const shard = decodeShard(arrayBuffer(bytes));
    assert.equal(shard.version, 1);
    assert.equal(shard.space, manifest.space);
    assert.equal(shard.dims, 8);
    assert.equal(shard.quantization, 'int8');
    assert.equal(shard.count, ref.count);
  }
  const food = decodeShard(arrayBuffer(shards.get(FOOD_SHARD)!));
  assert.deepEqual(food.items, FOOD);
  assert.deepEqual(food.item(1), FOOD[1]);
  assert.deepEqual(food.ids, ['sourdough', 'rye']);
  assert.deepEqual([...food.prior], [0.75, 0.5]);
  assert.deepEqual(
    [...food.time],
    [Date.parse('2026-10-01T08:00:00.000Z'), Date.parse('2026-09-15T08:00:00.000Z')],
  );
  assert.deepEqual(food.sections, ['Food']);
  assert.deepEqual([...food.section], [0, 0]);
  assert.deepEqual(
    [...food.vectors],
    [0, 0, 107, 30, 67, 0, 0, 127, -77, 14, -14, 14, 14, -14, -50, 127],
  );
  const travel = decodeShard(arrayBuffer(shards.get('shards/travel.49f872c005d0.hunch')!));
  assert.deepEqual([...travel.vectors], [0, -108, 19, -127, -63, 64, 0, 64]);
  const about = decodeShard(arrayBuffer(shards.get('shards/all.127cc2a88bc1.hunch')!));
  assert.deepEqual([...about.section], [-1]);
  assert.deepEqual([...about.time], [NaN]);
});

const FOOD = [
  {
    id: 'sourdough',
    url: '/food/sourdough/',
    title: 'Keeping a sourdough starter',
    section: 'Food',
    tags: ['bread'],
    date: '2026-10-01T08:00:00.000Z',
    image: '/img/sourdough.jpg',
    prior: 0.75,
  },
  {
    id: 'rye',
    url: '/food/rye/',
    title: 'Dense, dark rye bread',
    section: 'Food',
    date: '2026-09-15T08:00:00.000Z',
    prior: 0.5,
  },
];

test('format v1: the client ranks the frozen catalog', async () => {
  const hunch = await Hunch.load({
    manifest: 'http://site/manifest.json',
    fetch: dirFetch(V1),
    consent: false,
  });
  assert.equal(hunch.manifest.formatVersion, 1);
  const related = await hunch.related('sourdough', { n: 3 });
  assert.deepEqual(related.map((r) => r.id).sort(), ['about', 'night-train', 'rye']);
  assert.equal((await hunch.item('night-train'))?.title, 'A night train through the Alps');
  assert.deepEqual(await hunch.item('rye'), FOOD[1]);
});

test('format v1: the writer still writes it', async () => {
  // Re-encoding the decoded shards gives the same bytes...
  const { manifest, shards } = await fixture();
  for (const [url, bytes] of shards) {
    const shard = decodeShard(arrayBuffer(bytes));
    const rows = shard.items.map((_, i) => {
      const row = Float32Array.from(shard.vectors.subarray(i * shard.dims, (i + 1) * shard.dims));
      return row.map((x) => x * shard.invNorms[i]!);
    });
    const again = encodeShard({ space: shard.space, items: shard.items }, rows, shard.dims, 'int8');
    assert.deepEqual(Buffer.from(again), bytes, url);
  }
  // ...and a build of the same catalog today writes the same format: the same version, the
  // same manifest fields, the same shard header.
  const out = await tempDir();
  const result = await build({
    items: JSON.parse(await readFile(join(V1, 'catalog.json'), 'utf8')),
    outDir: out,
    provider: hashProvider(16),
    dims: 8,
    quantization: 'int8',
    cacheDir: false,
    now: new Date(manifest.generatedAt),
  });
  assert.equal(MANIFEST_FORMAT_VERSION, 1);
  assert.equal(SHARD_FORMAT_VERSION, 1);
  assert.deepEqual(shape(result.manifest), shape(manifest));
  for (const file of await readdir(join(out, 'shards'))) {
    const bytes = await readFile(join(out, 'shards', file));
    assert.deepEqual([...bytes.subarray(0, 12)], [72, 78, 67, 72, 1, 1, 0, 0, 8, 0, 0, 0], file);
    assert.equal(decodeShard(arrayBuffer(bytes)).dims, result.manifest.dims, file);
  }
});

/** The keys of a value, recursively, with arrays reduced to their first element's shape. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return typeof value;
}

test('a newer format version is refused, not misread', async () => {
  const { manifest, shards } = await fixture();
  assert.throws(
    () => assertManifest({ ...manifest, formatVersion: 2 }),
    /format version 2 is not supported/,
  );
  const bytes = new Uint8Array(shards.get(FOOD_SHARD)!);
  bytes[4] = 2;
  assert.throws(() => decodeShard(bytes.buffer), /format version 2 is not supported/);
  await assert.rejects(
    Hunch.load({
      manifest: 'http://site/manifest.json',
      fetch: async () => Response.json({ ...manifest, formatVersion: 2 }),
    }),
    /format version 2/,
  );
});

test('signals of a kind from a newer release are kept, and not read as anything', () => {
  const now = Date.parse('2027-01-01');
  const old = now - 400 * 86_400_000;
  const signals = [
    { seq: 1, itemId: 'a', kind: 'view', weight: 1, at: now },
    { seq: 2, itemId: 'b', kind: 'share', weight: 3, at: old },
  ] as unknown as Signal[];
  // Not a view: item b is neither seen nor scored.
  assert.deepEqual([...aggregate(signals, now, 21).keys()], ['a']);
  // Not pruned by age as if it were implicit; only the cap can drop it, after implicit ones.
  assert.deepEqual(toPrune(signals, now, 10, 180), []);
  assert.deepEqual(toPrune(signals, now, 1, 180), [1]);
});

test('a database from a newer release is left alone, not opened or deleted', async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    // A newer release's database: schema version 2, with a signal in it.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hunch', 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('signals', { keyPath: 'seq', autoIncrement: true }).add({
          itemId: 'rye',
          kind: 'view',
          weight: 1,
          at: 1,
        });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const store = new IndexedDbStore('hunch');
    await assert.rejects(store.all(), { name: 'VersionError' });
    const hunch = await Hunch.load({
      manifest: 'http://site/manifest.json',
      fetch: dirFetch(V1),
      consent: true,
      store,
    });
    // Personalization is unavailable: the cold start, and nothing is written.
    const recs = await hunch.recommend({ n: 4 });
    assert.ok(recs.every((r) => r.why.confidence === 0));
    assert.equal(await hunch.record('view', 'sourdough'), false);
    const databases = await indexedDB.databases();
    assert.deepEqual(databases, [{ name: 'hunch', version: 2 }]);
    // Its signal is still there (opened without a version: no upgrade runs).
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const open = indexedDB.open('hunch');
      open.onsuccess = () => {
        const get = open.result.transaction('signals').objectStore('signals').getAll();
        get.onsuccess = () => {
          open.result.close();
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
      open.onerror = () => reject(open.error);
    });
    assert.deepEqual(
      rows.map((r) => (r as { itemId: string }).itemId),
      ['rye'],
    );
  } finally {
    globalThis.indexedDB = original;
  }
});
