import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { Hunch, MemoryStore } from '../../src/client/index.ts';
import { createQueryEmbedder, type TransformersModule } from '../../src/query/index.ts';
import { build } from '../../src/node/build.ts';
import { hashProvider } from '../../src/node/providers/hash.ts';
import { loadSource } from '../../src/node/sources/index.ts';
import { dirFetch, tempDir } from '../helpers.ts';

let dir = '';
const MANIFEST = 'http://site/hunch/manifest.json';
before(async () => {
  dir = await tempDir();
  await build({
    items: await loadSource('demo/feed.xml'),
    outDir: join(dir, 'hunch'),
    provider: hashProvider(),
    cacheDir: false,
  });
});

const load = (options: { consent?: boolean; store?: MemoryStore } = {}) =>
  Hunch.load({ manifest: MANIFEST, fetch: dirFetch(dir), ...options });

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
  await assert.rejects(ink.search(query.map((x, i) => (i ? x : NaN))), /non-finite/);
  // A native-size vector is truncated to the catalog's dims: extra components don't count.
  const native = new Float32Array(ink.manifest.model.nativeDims);
  native.set(query);
  native.fill(0.05, query.length);
  const ids = (list: { id: string }[]) => list.map((r) => r.id);
  assert.deepEqual(ids(await ink.search(native, { n: 5 })), ids(await ink.search(query, { n: 5 })));
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
          data[600] = 12; // beyond the 512 kept dims
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
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
  // Dollar patterns in the query are inserted literally.
  await embedder.embed('price $& $$');
  assert.equal(calls.at(-1), 'embed ["query: price $& $$"]');
});

test('EmbeddingGemma q4 loads the file browsers can run, for a q8 or a q4 catalog', async () => {
  const ink = await load();
  const options: string[] = [];
  const fake: TransformersModule = {
    AutoTokenizer: { from_pretrained: () => Promise.resolve(() => ({})) },
    AutoModel: {
      from_pretrained: (_id, o) => {
        options.push(JSON.stringify(o));
        return Promise.resolve(() =>
          Promise.resolve({
            sentence_embedding: { dims: [1, 768], data: new Float32Array(768).fill(1) },
          }),
        );
      },
    },
  };
  const gemma = {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    revision: 'r',
    dtype: 'q8',
    nativeDims: 768,
    documentPrompt: '{text}',
  };
  const transformers = () => Promise.resolve(fake);
  // A q8 catalog, queried with smaller weights.
  await createQueryEmbedder({ ...ink.manifest, model: gemma }, { transformers, dtype: 'q4' });
  // A q4 catalog: its own file.
  const q4 = { ...gemma, dtype: 'q4', file: 'model_no_gather' };
  await createQueryEmbedder({ ...ink.manifest, model: q4 }, { transformers });
  // A q8 catalog with its own weights: the default file.
  await createQueryEmbedder({ ...ink.manifest, model: gemma }, { transformers });
  assert.deepEqual(options, [
    '{"revision":"r","dtype":"q4","model_file_name":"model_no_gather"}',
    '{"revision":"r","dtype":"q4","model_file_name":"model_no_gather"}',
    '{"revision":"r","dtype":"q8"}',
  ]);
});

test('a model that loads when the tokenizer fails is released', async () => {
  const ink = await load();
  let disposed = false;
  const fake: TransformersModule = {
    AutoTokenizer: { from_pretrained: () => Promise.reject(new Error('no tokenizer')) },
    AutoModel: {
      from_pretrained: () =>
        Promise.resolve(
          Object.assign(() => Promise.resolve({}), {
            dispose: () => {
              disposed = true;
              return Promise.resolve();
            },
          }),
        ),
    },
  };
  const manifest = { ...ink.manifest, model: { ...ink.manifest.model, id: 'acme/embed' } };
  await assert.rejects(createQueryEmbedder(manifest, { transformers: fake }), /no tokenizer/);
  assert.ok(disposed);
});

test('search() treats a NaN personalize as 0 and loads no profile without it', async () => {
  const ink = await load({ consent: true, store: new MemoryStore() });
  const query = await (await createQueryEmbedder(ink.manifest)).embed('night trains');
  for (const id of ['sourdough-starter', 'rye-bread']) await ink.record('follow', id);
  const scores = (list: { id: string; score: number }[]) =>
    list.map((r) => `${r.id} ${r.score.toFixed(6)}`);
  assert.deepEqual(
    scores(await ink.search(query, { n: 5, personalize: NaN })),
    scores(await ink.search(query, { n: 5 })),
  );
});
