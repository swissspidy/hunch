import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { Inkling, MemoryStore } from '../../src/client/index.ts';
import { createQueryEmbedder, type TransformersModule } from '../../src/query/index.ts';
import { build } from '../../src/node/build.ts';
import { hashProvider } from '../../src/node/providers/hash.ts';
import { loadSource } from '../../src/node/sources/index.ts';
import { dirFetch, tempDir } from '../helpers.ts';

let dir = '';
const MANIFEST = 'http://site/inkling/manifest.json';
before(async () => {
  dir = await tempDir();
  await build({
    items: await loadSource('demo/feed.xml'),
    outDir: join(dir, 'inkling'),
    provider: hashProvider(),
    cacheDir: false,
  });
});

const load = (options: { consent?: boolean; store?: MemoryStore } = {}) =>
  Inkling.load({ manifest: MANIFEST, fetch: dirFetch(dir), ...options });

test('a text query, embedded in the browser with the catalog’s model, finds matching items', async () => {
  const ink = await load();
  assert.equal(ink.manifest.model.queryPrompt, '{query}');
  const embedder = await createQueryEmbedder(ink.manifest);
  const query = await embedder.embed('sourdough starter bread baking');
  assert.equal(query.length, ink.manifest.dims);
  assert.ok(Math.abs(Math.hypot(...query) - 1) < 1e-5);
  const results = await ink.search(query, { n: 3 });
  assert.equal(results[0]!.id, 'sourdough-starter');
  assert.ok(results.every((r) => r.why.confidence === 1));
  // Cached: the same vector object.
  assert.equal(await embedder.embed('sourdough starter bread baking'), query);
});

test('search() takes full or truncated vectors, filters and personalizes', async () => {
  const store = new MemoryStore();
  const ink = await load({ consent: true, store });
  const embedder = await createQueryEmbedder(ink.manifest);
  const query = await embedder.embed('night trains rail travel');
  await assert.rejects(ink.search(new Float32Array(7)), /query vector has 256 or 512 dims/);
  const travel = await ink.search(query, { n: 3, sections: ['Travel'] });
  assert.ok(travel.every((r) => r.section === 'Travel'));
  await ink.record('hide', travel[0]!.id);
  assert.ok(!(await ink.search(query, { n: 10 })).some((r) => r.id === travel[0]!.id), 'hidden');
  await ink.record('view', travel[1]!.id);
  assert.ok(
    (await ink.search(query, { n: 10 })).some((r) => r.id === travel[1]!.id),
    'seen stays',
  );
  assert.ok(
    !(await ink.search(query, { n: 10, excludeSeen: true })).some((r) => r.id === travel[1]!.id),
  );
  // A strong profile for Food pulls food items up when personalizing.
  for (const id of ['sourdough-starter', 'rye-bread', 'baguette-shaping'])
    await ink.record('follow', id);
  const plain = await ink.search(query, { n: 32 });
  const mixed = await ink.search(query, { n: 32, personalize: 0.8 });
  const rankOf = (list: { id: string }[], id: string) => list.findIndex((r) => r.id === id);
  assert.ok(rankOf(mixed, 'fresh-pasta') < rankOf(plain, 'fresh-pasta'));
});

test('Transformers.js gets the pinned model, revision and weights; the query prompt is applied', async () => {
  const ink = await load();
  const calls: string[] = [];
  const fake: TransformersModule = {
    env: {},
    AutoTokenizer: {
      from_pretrained: (id, options) => {
        calls.push(`tokenizer ${id} ${JSON.stringify(options)}`);
        return Promise.resolve((texts: string[]) => ({ texts }));
      },
    },
    AutoModel: {
      from_pretrained: (id, options) => {
        calls.push(`model ${id} ${JSON.stringify(options)}`);
        const model = (inputs: Record<string, unknown>) => {
          calls.push(`embed ${JSON.stringify(inputs.texts)}`);
          const data = new Float32Array(1024);
          data[0] = 3;
          data[300] = 4;
          return Promise.resolve({ sentence_embedding: { dims: [1, 1024], data } });
        };
        return Promise.resolve(model);
      },
    },
  };
  const manifest = {
    ...ink.manifest,
    dims: 512,
    model: {
      id: 'acme/embed',
      revision: 'abc123',
      dtype: 'q8',
      nativeDims: 1024,
      documentPrompt: '{text}',
      queryPrompt: 'query: {query}',
    },
  };
  let configured = false;
  const embedder = await createQueryEmbedder(manifest, {
    transformers: () => Promise.resolve(fake),
    dtype: 'q4',
    configure: () => (configured = true),
  });
  const v = await embedder.embed('  hello  ');
  assert.ok(configured);
  assert.deepEqual(calls, [
    'tokenizer acme/embed {"revision":"abc123"}',
    'model acme/embed {"revision":"abc123","dtype":"q4"}',
    'embed ["query: hello"]',
  ]);
  // Truncated to 512 dims (the component at 300 kept), renormalized.
  assert.equal(v.length, 512);
  assert.ok(Math.abs(v[0]! - 0.6) < 1e-6 && Math.abs(v[300]! - 0.8) < 1e-6);
});
