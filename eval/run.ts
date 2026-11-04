/**
 * `npm run eval`: offline evaluation of Inkling's ranking (milestones 3 and 4).
 *
 *   node eval/run.ts --dataset synthetic
 *   node eval/run.ts --dataset mind --mind-dir <dir> [--impressions 2000] [--models hash,gemma]
 *
 * For each impression, the user's history becomes signals (one view per item read), and the
 * items shown are ranked by `Inkling.rank()` through the real client: shards, profile and
 * ranking function. Baselines: random order, and popularity (the catalog's prior). With two
 * models, the model-switch check records the signals through the client on the first model's
 * catalog and ranks with the second's, which must match a fresh profile on the second exactly.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Inkling, MemoryStore } from '../src/client/index.ts';
import { build } from '../src/node/build.ts';
import { hashProvider } from '../src/node/providers/hash.ts';
import { transformersProvider } from '../src/node/providers/transformers.ts';
import type { EmbeddingProvider } from '../src/node/providers/types.ts';
import { loadMind } from './datasets/mind.ts';
import { synthetic } from './datasets/synthetic.ts';
import { mean, METRIC_NAMES, score, type Metrics } from './metrics.ts';
import type { Dataset, Impression } from './types.ts';

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'synthetic' },
    'mind-dir': { type: 'string' },
    impressions: { type: 'string', default: '2000' },
    models: { type: 'string' },
    dims: { type: 'string', default: '256' },
    out: { type: 'string', default: 'eval/results' },
  },
});

interface Model {
  name: string;
  provider: EmbeddingProvider;
  dims: number;
}

let dataset: Dataset;
let models: Model[];
const dims = Number(values.dims);
if (values.dataset === 'synthetic') {
  const data = synthetic();
  dataset = data;
  models = [
    { name: 'model A (128 dims)', provider: data.providers.a, dims: 128 },
    { name: 'model B (96 dims)', provider: data.providers.b, dims: 96 },
  ];
} else if (values.dataset === 'mind') {
  if (!values['mind-dir']) throw new Error('--mind-dir is required for MIND (see eval/README.md)');
  dataset = await loadMind({ dir: values['mind-dir'], impressions: Number(values.impressions) });
  const available: Record<string, () => Model> = {
    hash: () => ({ name: 'hash (lexical, 512 → 256 dims)', provider: hashProvider(), dims }),
    gemma: () => ({
      name: `EmbeddingGemma q8 (${dims} dims)`,
      provider: transformersProvider({ dtype: 'q8', batchSize: 16 }),
      dims,
    }),
    'gemma-128': () => ({
      name: 'EmbeddingGemma q8 (128 dims)',
      provider: transformersProvider({ dtype: 'q8', batchSize: 16 }),
      dims: 128,
    }),
  };
  models = (values.models ?? 'hash,gemma').split(',').map((m) => {
    const make = available[m];
    if (!make) throw new Error(`Unknown model ${m} (${Object.keys(available).join(', ')})`);
    return make();
  });
} else {
  throw new Error(`Unknown dataset ${values.dataset}`);
}

console.error(`${dataset.name}: ${dataset.items.length} items`);
const slug = values.dataset;
const rows: { ranker: string; metrics: Metrics }[] = [];

rows.push({
  ranker: 'random',
  metrics: evaluate(dataset.impressions, (imp) => shuffle(imp.candidates, imp.id)),
});
const popularity = new Map(dataset.items.map((item) => [item.id, item.popularity ?? 0]));
rows.push({
  ranker: 'popularity',
  metrics: evaluate(dataset.impressions, (imp) =>
    [...imp.candidates].sort((a, b) => popularity.get(b)! - popularity.get(a)!),
  ),
});

const catalogs: { model: Model; dir: string }[] = [];
for (const model of models) {
  const dir = join(
    'eval/.work',
    slug,
    model.provider.model.id.replace(/[^\w.-]+/g, '_'),
    String(model.dims),
  );
  const started = performance.now();
  const result = await build({
    items: dataset.items,
    outDir: dir,
    provider: model.provider,
    dims: model.dims,
    cacheDir: join('eval/.cache', slug),
    log: (m) => console.error(`  ${m}`),
  });
  await model.provider.dispose?.();
  console.error(
    `${model.name}: ${result.embedded} embedded, ${result.cached} cached, ${(result.bytes / 1024).toFixed(0)} KB, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  catalogs.push({ model, dir });
  const variants: [string, Parameters<Inkling['rank']>[1]][] = [
    ['profile only', { prior: 'catalog', diversity: 0, weights: { prior: 0, recency: 0 } }],
    ['profile + popularity (default weights)', { prior: 'catalog', diversity: 0 }],
    ['profile + popularity + diversity 0.2', { prior: 'catalog' }],
  ];
  for (const [label, options] of variants) {
    rows.push({
      ranker: `Inkling, ${model.name}: ${label}`,
      metrics: await evaluateInkling(dir, (ink, imp) => ink.rank(imp.candidates, options)),
    });
  }
}

let modelSwitch: { identical: number; total: number } | undefined;
if (catalogs.length >= 2) {
  const [from, to] = catalogs as [{ model: Model; dir: string }, { model: Model; dir: string }];
  modelSwitch = await switchCheck(from.dir, to.dir);
  console.error(
    `model switch ${from.model.name} → ${to.model.name}: ${modelSwitch.identical} of ${modelSwitch.total} rankings identical to a fresh profile`,
  );
}

const table = [
  `| Ranker | ${METRIC_NAMES.map(label).join(' | ')} |`,
  `|---|${METRIC_NAMES.map(() => '---').join('|')}|`,
  ...rows.map(
    (r) => `| ${r.ranker} | ${METRIC_NAMES.map((k) => r.metrics[k].toFixed(4)).join(' | ')} |`,
  ),
].join('\n');
console.log(`\n${dataset.name}, ${dataset.impressions.length} impressions\n\n${table}\n`);
await mkdir(values.out, { recursive: true });
const name =
  values.dataset === 'mind'
    ? `mind-${models.map((m) => m.provider.model.id.split('/').pop()).join('-')}`
    : slug;
await writeFile(
  join(values.out, `${name}.json`),
  `${JSON.stringify({ dataset: dataset.name, impressions: dataset.impressions.length, items: dataset.items.length, rows, modelSwitch }, null, 2)}\n`,
);

// ---------------------------------------------------------------------------------------------

function evaluate(
  impressions: readonly Impression[],
  rankFn: (imp: Impression) => string[],
): Metrics {
  return mean(impressions.map((imp) => score(rankFn(imp), imp.clicked)));
}

async function load(dir: string, store: MemoryStore, now: () => number): Promise<Inkling> {
  return Inkling.load({
    manifest: 'http://eval/manifest.json',
    fetch: async (input) => new Response(await readFile(join(dir, new URL(input).pathname))),
    consent: true,
    store,
    now,
  });
}

async function evaluateInkling(
  dir: string,
  rankFn: (ink: Inkling, imp: Impression) => Promise<string[]>,
): Promise<Metrics> {
  const store = new MemoryStore();
  let now = 0;
  const ink = await load(dir, store, () => now);
  const all: Metrics[] = [];
  for (const imp of dataset.impressions) {
    now = imp.at;
    await store.destroy();
    for (const itemId of imp.history)
      await store.add({ itemId, kind: 'view', weight: 1, at: imp.at });
    all.push(score(await rankFn(ink, imp), imp.clicked));
  }
  return mean(all);
}

/** Signals recorded on one model's catalog, ranked on another's, against a fresh profile there. */
async function switchCheck(
  fromDir: string,
  toDir: string,
): Promise<{ identical: number; total: number }> {
  const switched = new MemoryStore();
  const fresh = new MemoryStore();
  let now = 0;
  const a = await load(fromDir, switched, () => now);
  const b = await load(toDir, switched, () => now);
  const bFresh = await load(toDir, fresh, () => now);
  let identical = 0;
  for (const imp of dataset.impressions) {
    now = imp.at;
    await switched.destroy();
    await fresh.destroy();
    for (const id of imp.history) {
      await a.record('view', id);
      await fresh.add({ itemId: id, kind: 'view', weight: 1, at: imp.at });
    }
    const options = { prior: 'catalog', diversity: 0 } as const;
    const [x, y] = await Promise.all([
      b.rank(imp.candidates, options),
      bFresh.rank(imp.candidates, options),
    ]);
    if (x.join() === y.join()) identical++;
  }
  return { identical, total: dataset.impressions.length };
}

function shuffle(ids: readonly string[], seed: string): string[] {
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619);
  s >>>= 0;
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function label(metric: keyof Metrics): string {
  return { auc: 'AUC', mrr: 'MRR', ndcg5: 'nDCG@5', ndcg10: 'nDCG@10', recall10: 'Recall@10' }[
    metric
  ];
}
