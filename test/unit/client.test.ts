import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { Inkling } from '../../src/client/index.ts';
import { build } from '../../src/node/build.ts';
import { hashProvider } from '../../src/node/providers/hash.ts';
import { loadSource } from '../../src/node/sources/index.ts';
import { dirFetch, tempDir } from '../helpers.ts';

let dir = '';
const MANIFEST = 'http://site/inkling/manifest.json';
const now = () => Date.parse('2026-11-01T00:00:00Z');

before(async () => {
  dir = await tempDir();
  const items = await loadSource('demo/feed.xml');
  await build({ items, outDir: join(dir, 'inkling'), provider: hashProvider(), cacheDir: false });
});

test('related items share the query item’s topic', async () => {
  const ink = await Inkling.load({ manifest: MANIFEST, fetch: dirFetch(dir), now });
  // The hash provider is lexical, not semantic: "night", "train" and "rail" carry this.
  const related = await ink.related('night-train-alps', { n: 3, diversity: 0 });
  assert.equal(related.length, 3);
  const ids = related.map((r) => r.id);
  assert.ok(ids.slice(0, 2).includes('budget-rail-europe'), ids.join(', '));
  assert.ok(
    related.every((r) => r.section === 'Travel'),
    ids.join(', '),
  );
  assert.ok(!ids.includes('night-train-alps'));
  const first = related[0]!;
  assert.equal(first.why.relevance, 1);
  assert.ok(first.why.similarity > related[2]!.why.similarity);
  assert.equal(first.why.redundancy, 0);
  assert.match(first.url, /^https:\/\/example\.com\/travel\//);
});

test('only the shards needed are fetched', async () => {
  const log: string[] = [];
  const ink = await Inkling.load({ manifest: MANIFEST, fetch: dirFetch(dir, log), now });
  const related = await ink.related('coffee-chemistry', {
    sections: 'same',
    sectionHint: 'Science',
  });
  assert.equal(related.length, 5);
  assert.ok(related.every((r) => r.section === 'Science'));
  assert.equal(log.length, 2, log.join(', '));
  assert.match(log[1]!, /\/inkling\/shards\/science\./);
  // Asking across all sections loads the rest, once.
  await ink.related('coffee-chemistry');
  await ink.related('cold-brew');
  assert.equal(log.length, 5, log.join(', '));
});

test('exclusions, unknown items and n', async () => {
  const ink = await Inkling.load({ manifest: MANIFEST, fetch: dirFetch(dir), now });
  const all = await ink.related('cold-brew', { n: 100 });
  assert.equal(all.length, 31);
  assert.equal(new Set(all.map((r) => r.id)).size, 31);
  const without = await ink.related('cold-brew', { n: 3, exclude: [all[0]!.id] });
  assert.ok(!without.some((r) => r.id === all[0]!.id));
  assert.deepEqual(await ink.related('no-such-item'), []);
  assert.equal((await ink.item('cold-brew'))?.section, 'Food');
});

test('a shard from another embedding space is refused', async () => {
  const other = await tempDir();
  const items = await loadSource('demo/feed.xml');
  await build({
    items,
    outDir: join(other, 'inkling'),
    provider: hashProvider(256),
    dims: 256,
    cacheDir: false,
  });
  // The manifest of one build pointing at the shards of another, hashes fixed up.
  const manifest = JSON.parse(await readFile(join(dir, 'inkling/manifest.json'), 'utf8'));
  const otherManifest = JSON.parse(await readFile(join(other, 'inkling/manifest.json'), 'utf8'));
  manifest.shards = otherManifest.shards;
  await writeFile(join(other, 'inkling/manifest.json'), JSON.stringify(manifest));
  const ink = await Inkling.load({ manifest: MANIFEST, fetch: dirFetch(other), now });
  await assert.rejects(ink.related('cold-brew'), /is from space .*hash@1\|native=256\|dims=256/);
});

test('a shard that does not match its hash is refused', async () => {
  const copy = await tempDir();
  const manifest = JSON.parse(await readFile(join(dir, 'inkling/manifest.json'), 'utf8'));
  manifest.shards[0].sha256 = '0'.repeat(64);
  await writeFile(join(copy, 'manifest.json'), JSON.stringify(manifest));
  const fetchFn = dirFetch(dir);
  const ink = await Inkling.load({
    manifest: MANIFEST,
    fetch: (url, init) =>
      String(url).endsWith('manifest.json')
        ? readFile(join(copy, 'manifest.json')).then((b) => new Response(b))
        : fetchFn(url, init),
    now,
  });
  await assert.rejects(
    ink.related('cold-brew', { sectionHint: 'Food' }),
    /does not match the manifest's hash/,
  );
});

test('manifests of another format are refused', async () => {
  const bad = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)));
  await assert.rejects(
    Inkling.load({ manifest: MANIFEST, fetch: bad({ format: 'x' }) }),
    /format is "x"/,
  );
  await assert.rejects(
    Inkling.load({
      manifest: MANIFEST,
      fetch: bad({ format: 'inkling/manifest', formatVersion: 2 }),
    }),
    /format version 2/,
  );
  await assert.rejects(
    Inkling.load({
      manifest: MANIFEST,
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    }),
    /returned 404/,
  );
});
