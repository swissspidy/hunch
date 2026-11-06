import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeShard } from '../../src/format/shard.ts';
import { build, computePriors } from '../../src/node/build.ts';
import { spaceKey } from '../../src/format/manifest.ts';
import { EmbeddingCache } from '../../src/node/cache.ts';
import { transformersProvider } from '../../src/node/providers/transformers.ts';
import type { CatalogItem } from '../../src/node/types.ts';
import { countingProvider, tempDir } from '../helpers.ts';

const items: CatalogItem[] = [
  {
    id: 'a',
    url: '/a',
    title: 'Sourdough bread',
    text: 'Baking bread with a starter',
    section: 'Food',
  },
  {
    id: 'b',
    url: '/b',
    title: 'Rye bread',
    text: 'Baking rye with a starter',
    section: 'Food',
    date: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'c',
    url: '/c',
    title: 'Exoplanets',
    text: 'Telescopes read planet atmospheres',
    section: 'Science Fiction & Fact',
  },
  { id: 'd', url: '/d', title: 'Misc', text: 'No section at all' },
];

test('writes a manifest and one shard per section', async () => {
  const out = await tempDir();
  const provider = countingProvider();
  const result = await build({
    items,
    outDir: out,
    provider,
    dims: 64,
    cacheDir: false,
    now: new Date(0),
  });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, result.manifest);
  assert.equal(manifest.count, 4);
  assert.equal(manifest.dims, 64);
  assert.equal(manifest.quantization, 'int8');
  assert.deepEqual(manifest.sections, ['Food', 'Science Fiction & Fact']);
  assert.deepEqual(
    manifest.shards.map((s: { section: string | null; count: number }) => [s.section, s.count]),
    [
      ['Food', 2],
      ['Science Fiction & Fact', 1],
      [null, 1],
    ],
  );
  assert.match(manifest.shards[1]!.url, /^shards\/science-fiction-fact\.[0-9a-f]{12}\.ink$/);
  assert.equal(manifest.generatedAt, '1970-01-01T00:00:00.000Z');

  const shard = decodeShard(
    new Uint8Array(await readFile(join(out, manifest.shards[0]!.url))).buffer,
  );
  assert.equal(shard.space, manifest.space);
  assert.deepEqual(shard.items, [
    { id: 'a', url: '/a', title: 'Sourdough bread', section: 'Food', prior: 1 },
    {
      id: 'b',
      url: '/b',
      title: 'Rye bread',
      section: 'Food',
      date: '2026-01-01T00:00:00.000Z',
      prior: 0.75,
    },
  ]);
  // Text is embedded, never published.
  assert.doesNotMatch(await readFile(join(out, manifest.shards[0]!.url), 'latin1'), /starter/);
});

test('rebuilds embed only new or changed items, and are reproducible', async () => {
  const out = await tempDir();
  const cacheDir = join(out, 'cache');
  const first = countingProvider();
  const a = await build({
    items,
    outDir: out,
    provider: first,
    dims: 64,
    cacheDir,
    now: new Date(0),
  });
  assert.equal(first.calls.length, 4);
  const manifestBytes = await readFile(join(out, 'manifest.json'));

  const second = countingProvider();
  const b = await build({
    items,
    outDir: out,
    provider: second,
    dims: 64,
    cacheDir,
    now: new Date(1e12),
  });
  assert.equal(second.calls.length, 0);
  assert.equal(b.cached, 4);
  assert.equal(b.manifest.version, a.manifest.version);
  // Unchanged: byte-identical, build time included.
  assert.deepEqual(await readFile(join(out, 'manifest.json')), manifestBytes);

  const third = countingProvider();
  const changed = items.map((i) => (i.id === 'c' ? { ...i, text: 'Telescopes and spectra' } : i));
  const c = await build({ items: changed, outDir: out, provider: third, dims: 32, cacheDir });
  assert.equal(third.calls.length, 1, 'only the changed item, even with other dims');
  assert.notEqual(c.manifest.version, a.manifest.version);
});

test('keeps the previous build’s shards and removes older ones', async () => {
  const out = await tempDir();
  const provider = countingProvider();
  const v1 = await build({ items, outDir: out, provider, dims: 16, cacheDir: false });
  const v2 = await build({
    items: items.slice(0, 3),
    outDir: out,
    provider,
    dims: 16,
    cacheDir: false,
  });
  const v3 = await build({
    items: items.slice(0, 2),
    outDir: out,
    provider,
    dims: 16,
    cacheDir: false,
  });
  const files = (await readdir(join(out, 'shards'))).sort();
  const names = (m: typeof v1.manifest) => m.shards.map((s) => s.url.slice('shards/'.length));
  assert.deepEqual(files, [...new Set([...names(v2.manifest), ...names(v3.manifest)])].sort());
  assert.ok(v3.removed.includes(names(v1.manifest).find((n) => n.startsWith('all.'))!));
});

test('splits large sections and checks its input', async () => {
  const out = await tempDir();
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `i${i}`,
    url: `/${i}`,
    title: `T${i}`,
    text: 'x',
    section: 'S',
  }));
  const result = await build({
    items: many,
    outDir: out,
    provider: countingProvider(),
    cacheDir: false,
    maxShardItems: 2,
    quantization: 'float32',
  });
  assert.deepEqual(
    result.manifest.shards.map((s) => s.count),
    [2, 2, 1],
  );
  assert.match(result.manifest.shards[2]!.url, /^shards\/s-3\./);
  await assert.rejects(
    build({ items, outDir: out, provider: countingProvider(), cacheDir: false, maxShardItems: 0 }),
    /maxShardItems must be a positive integer/,
  );
  await assert.rejects(
    build({ items: [], outDir: out, provider: countingProvider(), cacheDir: false }),
    /empty/,
  );
  const broken = countingProvider(8);
  broken.embed = (inputs) =>
    Promise.resolve(inputs.map(() => Float32Array.of(1, Number.NaN, 0, 0, 0, 0, 0, 0)));
  await assert.rejects(
    build({ items, outDir: out, provider: broken, cacheDir: false, dims: 4 }),
    /non-finite component/,
  );
  await assert.rejects(
    build({
      items: [items[0]!, items[0]!],
      outDir: out,
      provider: countingProvider(),
      cacheDir: false,
    }),
    /Duplicate/,
  );
  await assert.rejects(
    build({ items, outDir: out, provider: countingProvider(64), dims: 65, cacheDir: false }),
    /dims/,
  );
});

test('priors follow popularity, then catalog order', () => {
  const base = { url: '/', title: '', text: '' };
  assert.deepEqual(
    computePriors([
      { ...base, id: 'a' },
      { ...base, id: 'b', popularity: 1 },
      { ...base, id: 'c', popularity: 9 },
      { ...base, id: 'd' },
    ]),
    [0.5, 0.75, 1, 0.25],
  );
});

test('a corrupt cache is reported, not silently used', async () => {
  const out = await tempDir();
  const provider = countingProvider();
  await writeFile(join(out, `${provider.model.id.replace('/', '_')}@1.vec`), 'garbage');
  await assert.rejects(
    build({ items, outDir: out, provider, cacheDir: out }),
    /not an Inkling embedding cache/,
  );
});

test('EmbeddingGemma q4 uses the file browsers can run, and that file is part of the space', async () => {
  const q8 = transformersProvider().model;
  const q4 = transformersProvider({ dtype: 'q4' }).model;
  assert.equal(q8.file, undefined);
  assert.equal(q4.file, 'model_no_gather');
  assert.equal(transformersProvider({ dtype: 'q4', file: 'model' }).model.file, 'model');
  // q8 spaces and cache keys are unchanged by the new field.
  assert.equal(
    spaceKey(q8, 256),
    `onnx-community/embeddinggemma-300m-ONNX@${q8.revision}|dtype=q8|native=768|dims=256|prompt=03e0cd9b`,
  );
  assert.match(spaceKey(q4, 256), /\|dtype=q4\|file=model_no_gather\|native=768\|/);
  const key = (model: typeof q8) => EmbeddingCache.open(model).then((c) => c.key('input'));
  assert.notEqual(await key(q4), await key({ ...q4, file: undefined }));
});
