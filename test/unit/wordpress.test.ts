// The WordPress plugin's PHP encoder against the Node build (ADR 0007): the same items and
// vectors must give byte-identical shards and manifests. Skipped when `php` is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertManifest, type Manifest, type Quantization } from '../../src/format/manifest.ts';
import { decodeShard } from '../../src/format/shard.ts';
import { build } from '../../src/node/build.ts';
import { EmbeddingCache } from '../../src/node/cache.ts';
import { transformersProvider } from '../../src/node/providers/transformers.ts';
import { documentInput, type EmbeddingProvider } from '../../src/node/providers/types.ts';
import { htmlToText } from '../../src/node/text.ts';
import type { CatalogItem } from '../../src/node/types.ts';
import { tempDir } from '../helpers.ts';

const DRIVER = new URL('../../wordpress/inkling/tests/write-catalog.php', import.meta.url);
const php = spawnSync('php', ['-r', 'echo class_exists("Normalizer") ? "intl" : "";'], {
  encoding: 'utf8',
});
const skip = php.status === 0 ? false : 'php is not installed';
// Without PHP's intl extension, accents in a section name are not transliterated in its shard's
// file name (the file is still valid, but named differently from the Node build's).
const accented = php.stdout === 'intl' ? 'Café Culture' : 'Cafe Culture';

// The pinned EmbeddingGemma model info, exactly as the CLI publishes it.
const model = transformersProvider().model;
const NOW = new Date('2026-11-05T10:00:00.000Z');

/** A deterministic pseudo-random float32 vector of the model's size. */
function vector(seed: number): Float32Array {
  const v = new Float32Array(model.nativeDims);
  let x = seed * 2654435761;
  for (let i = 0; i < v.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    v[i] = ((x >>> 8) / 0x1000000 - 0.5) * (i < 16 ? 4 : 1);
  }
  return v;
}

const items: CatalogItem[] = [
  {
    id: 'https://example.com/?p=12',
    url: 'https://example.com/2026/10/rye/',
    title: 'Dense, dark rye bread',
    text: 'Rye takes longer.',
    section: 'Food',
    tags: ['bread', 'baking'],
    date: '2026-10-09T08:00:00.000Z',
    image: 'https://example.com/wp-content/uploads/rye.jpg',
  },
  {
    id: 'https://example.com/?p=11',
    url: 'https://example.com/2026/10/cafe/',
    title: 'Café “culture” / a \\ slash   and \u0001 and 🥐',
    text: 'Croissants.',
    section: accented,
    date: '2026-10-08T08:00:00.000Z',
    popularity: 3,
  },
  {
    id: 'https://example.com/?p=10',
    url: 'https://example.com/2026/10/starter/',
    title: 'A sourdough starter',
    text: 'Flour and water.',
    section: 'Food',
    popularity: 7,
  },
  { id: 'https://example.com/?p=9', url: 'https://example.com/9/', title: '', text: 'No title.' },
  {
    id: 'https://example.com/?p=8',
    url: 'https://example.com/8/',
    title: 'Night trains',
    text: 'Sleep through Europe.',
    section: 'Travel',
    popularity: 3,
  },
  {
    id: 'https://example.com/?p=7',
    url: 'https://example.com/7/',
    title: 'Bread again',
    text: 'More bread.',
    section: 'Food',
  },
];
const vectors = new Map(
  items.map((item, i) => [
    documentInput(model.documentPrompt, item.title, item.text),
    vector(i + 1),
  ]),
);

/** EmbeddingGemma's model info, returning the fixed vectors instead of running the model. */
const provider: EmbeddingProvider = {
  model,
  embed: (inputs) => Promise.resolve(inputs.map((input) => vectors.get(input)!)),
};

interface Options {
  dims: number;
  quantization: Quantization;
  shardBy?: 'section' | 'none';
  maxShardItems?: number;
  /** The weights variant (default: the CLI's, q8). */
  dtype?: string;
}

/** The model info for the options' weights variant. */
function modelFor(options: Options): typeof model {
  return options.dtype ? transformersProvider({ dtype: options.dtype }).model : model;
}

interface PhpResult {
  removed: string[];
  html: string[];
  inputs: { input: string; hash: string }[];
  fnv1a: string;
  space: string;
  /** What Inkling_Catalog::model() picks for the job's `weights`. */
  model: unknown;
}

function runPhp(
  dir: string,
  catalog: readonly CatalogItem[],
  options: Options,
  extra: { html?: string[]; inputs?: { title: string; text: string }[]; weights?: string } = {},
): PhpResult {
  const { dtype: _, ...rest } = options;
  const job = {
    dir,
    model: modelFor(options),
    ...rest,
    now: NOW.toISOString(),
    items: catalog.map(({ text, ...item }) => ({
      ...item,
      vector: Array.from(vectors.get(documentInput(model.documentPrompt, item.title, text))!),
    })),
    html: extra.html ?? [],
    inputs: extra.inputs ?? [],
    ...(extra.weights && { weights: extra.weights }),
  };
  const out = spawnSync('php', [fileURLToPath(DRIVER)], {
    input: JSON.stringify(job),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  return JSON.parse(out.stdout) as PhpResult;
}

function runNode(dir: string, catalog: readonly CatalogItem[], options: Options) {
  const { dtype: _, ...rest } = options;
  return build({
    items: catalog,
    outDir: dir,
    provider: { ...provider, model: modelFor(options) },
    cacheDir: false,
    now: NOW,
    ...rest,
  });
}

/** Both directories hold the same files with the same bytes; returns the manifest. */
async function assertSameOutput(nodeDir: string, phpDir: string): Promise<Manifest> {
  const nodeManifest = await readFile(join(nodeDir, 'manifest.json'));
  const phpManifest = await readFile(join(phpDir, 'manifest.json'));
  assert.equal(phpManifest.toString(), nodeManifest.toString());
  assert.deepEqual(
    (await readdir(join(phpDir, 'shards'))).sort(),
    (await readdir(join(nodeDir, 'shards'))).sort(),
  );
  const manifest: unknown = JSON.parse(phpManifest.toString());
  assertManifest(manifest);
  for (const ref of manifest.shards) {
    const phpBytes = await readFile(join(phpDir, ref.url));
    const nodeBytes = await readFile(join(nodeDir, ref.url));
    assert.ok(phpBytes.equals(nodeBytes), `${ref.url} differs`);
    assert.equal(createHash('sha256').update(phpBytes).digest('hex'), ref.sha256);
    assert.equal(phpBytes.length, ref.bytes);
    // Copies: a file's Buffer may sit at any offset of a shared pool.
    const shard = decodeShard(new Uint8Array(phpBytes).buffer);
    const expected = decodeShard(new Uint8Array(nodeBytes).buffer);
    assert.equal(shard.space, manifest.space);
    assert.equal(shard.vectors.byteOffset % 4, 0);
    assert.equal(shard.items.length, ref.count);
    assert.deepEqual(shard.items, expected.items);
    assert.deepEqual([...shard.vectors], [...expected.vectors]);
    assert.deepEqual([...shard.invNorms], [...expected.invNorms]);
  }
  return manifest;
}

for (const options of [
  { dims: 256, quantization: 'int8' },
  { dims: 128, quantization: 'float32' },
  { dims: 768, quantization: 'int8', shardBy: 'none' },
  { dims: 256, quantization: 'int8', maxShardItems: 2 },
  // The plugin's experimental "Model weights: q4" setting.
  { dims: 256, quantization: 'int8', dtype: 'q4' },
] satisfies Options[]) {
  test(`PHP writes the Node build's bytes: ${JSON.stringify(options)}`, { skip }, async () => {
    const nodeDir = await tempDir();
    const phpDir = await tempDir();
    await runNode(nodeDir, items, options);
    runPhp(phpDir, items, options);
    const manifest = await assertSameOutput(nodeDir, phpDir);
    assert.equal(manifest.count, items.length);
    assert.equal(manifest.model.id, 'onnx-community/embeddinggemma-300m-ONNX');
    assert.equal(manifest.model.dtype, options.dtype ?? 'q8');
  });
}

test('PHP keeps generatedAt and prunes shards as the Node build does', { skip }, async () => {
  const options: Options = { dims: 256, quantization: 'int8' };
  const nodeDir = await tempDir();
  const phpDir = await tempDir();
  // Three builds: the same catalog twice, then one item changed, then another change.
  const changed = items.map((item, i) => (i === 0 ? { ...item, title: 'Rye, revised' } : item));
  vectors.set(documentInput(model.documentPrompt, changed[0]!.title, changed[0]!.text), vector(99));
  const again = changed.map((item, i) => (i === 4 ? { ...item, section: 'Food' } : item));
  for (const catalog of [items, items, changed, again]) {
    const node = await runNode(nodeDir, catalog, options);
    const result = runPhp(phpDir, catalog, options);
    assert.deepEqual(result.removed.sort(), node.removed.sort());
    await assertSameOutput(nodeDir, phpDir);
  }
});

test(
  'PHP extracts text, fills the prompt and hashes the input as the Node build does',
  {
    skip,
  },
  async () => {
    const html = [
      '<!-- wp:paragraph --><p>Rye &amp; spelt&nbsp;bread&hellip;</p><!-- /wp:paragraph -->',
      '<h2>Title</h2>\n\n<ul><li>one</li><li>two&#x1F950;</li></ul><script>alert(1)</script>',
      '<p>  a   </p>\t<div>b &#65; &#0; &#xD800; &bogus; &QUOT;</div>　',
      'plain\r\n\r\ntext\v\fwith  spaces <br/>end',
      '<style>p{}</style><svg><path/></svg>x<SCRIPT >y</script >z',
    ];
    const long = `${'a'.repeat(3999)}🥐 and more`;
    const inputs = [
      { title: 'Dense rye', text: 'Rye takes longer.' },
      { title: '', text: 'No title, {title} and {text} in the text.' },
      { title: 'Long', text: long },
      { title: 'Long 2', text: `${'é'.repeat(4100)}` },
    ];
    const result = runPhp(
      await tempDir(),
      items,
      { dims: 256, quantization: 'int8' },
      { html, inputs },
    );
    // A lone surrogate (&#xD800;) is U+FFFD in UTF-8 on both sides once it is written out.
    assert.deepEqual(
      result.html,
      html.map((h) => htmlToText(h).toWellFormed()),
    );
    const cache = await EmbeddingCache.open(model);
    assert.deepEqual(
      result.inputs,
      inputs.map(({ title, text }) => {
        const input = documentInput(model.documentPrompt, title, text.slice(0, 4000));
        return { input: input.toWellFormed(), hash: cache.key(input) };
      }),
    );
    assert.equal(
      result.space,
      (await runNode(await tempDir(), items, { dims: 256, quantization: 'int8' })).manifest.space,
    );
    // q4 weights: another embedding space, so other hashes (a q8 vector is never reused).
    const q4: Options = { dims: 256, quantization: 'int8', dtype: 'q4' };
    const q4Result = runPhp(await tempDir(), items, q4, { inputs: inputs.slice(0, 1) });
    const q4Cache = await EmbeddingCache.open(modelFor(q4));
    const first = documentInput(model.documentPrompt, inputs[0]!.title, inputs[0]!.text);
    assert.equal(q4Result.inputs[0]!.hash, q4Cache.key(first));
    assert.notEqual(q4Result.inputs[0]!.hash, result.inputs[0]!.hash);
    assert.equal(q4Result.space, (await runNode(await tempDir(), items, q4)).manifest.space);
    assert.notEqual(q4Result.space, result.space);
    // The plugin's own model for each Model weights setting: the CLI's, key order included (the
    // manifests are compared byte for byte).
    for (const weights of ['q8', 'q4']) {
      const picked = runPhp(await tempDir(), items, q4, { weights }).model;
      assert.equal(JSON.stringify(picked), JSON.stringify(modelFor({ ...q4, dtype: weights })));
    }
  },
);

test('PHP reads dates as Date.parse reads them', { skip }, () => {
  const dates = [
    '2026-01-01T00:00:00.000Z',
    '2026-01-01',
    '2026-01',
    '2026',
    '+002026-01-01T00:00:00Z',
    '-000001-06-01T00:00:00Z',
    '-000000-01-01T00:00:00Z',
    '0050-03-01T00:00:00Z',
    '0000-01-01',
    '1969-12-31T23:59:59.999Z',
    '2024-02-29T12:00Z',
    '2026-02-30',
    '2026-02-31T00:00:00Z',
    '2026-04-31',
    '2026-02-32',
    '2026-13-01',
    '2026-00-10',
    '2026-01-01T24:00:00Z',
    '2026-01-01T24:00Z',
    '2026-01-01T24:00:01Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T10:00:00.5Z',
    '2026-01-01T10:00:00.123456Z',
    '2026-01-01T10:00:00+23:59',
    '2026-01-01T10:00:00-05:30',
    '2026-01-01T10:00:00+24:00',
    '2026-01-01T10:00:00+05:60',
    '9999-12-31T23:59:59.999Z',
    'yesterday',
    '',
  ];
  const script = `define('INKLING_STANDALONE', true); require 'wordpress/inkling/includes/class-inkling-shard.php';
foreach (json_decode(stream_get_contents(STDIN)) as $d) echo bin2hex(Inkling_Shard::time($d)), "\\n";`;
  const run = spawnSync('php', ['-r', script], { input: JSON.stringify(dates), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const got = run.stdout.trim().split('\n');
  dates.forEach((date, i) => {
    const want = Buffer.alloc(8);
    want.writeDoubleLE(date ? Date.parse(date) : NaN);
    assert.equal(got[i], want.toString('hex'), date);
  });
});
