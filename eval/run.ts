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
 *
 * Ablation: `--dims 128,256 --quantization int8,float32` builds one catalog per combination
 * from a single embedding pass per model (the cache keeps full vectors; truncation and
 * quantization happen at build). `name@dims` or `name@dims/quantization` in `--models` pins
 * one model to a single catalog. Neighbouring catalogs of one model are compared on nDCG@10,
 * per impression, with a standard error and a bootstrap 95% interval.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Inkling, MemoryStore } from '../src/client/index.ts';
import type { Quantization } from '../src/format/manifest.ts';
import { build } from '../src/node/build.ts';
import { hashProvider } from '../src/node/providers/hash.ts';
import { transformersProvider } from '../src/node/providers/transformers.ts';
import type { EmbeddingProvider } from '../src/node/providers/types.ts';
import { loadMind } from './datasets/mind.ts';
import { synthetic } from './datasets/synthetic.ts';
import { mean, METRIC_NAMES, pairedDifference, score, type Metrics } from './metrics.ts';
import type { Dataset } from './types.ts';

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'synthetic' },
    'mind-dir': { type: 'string' },
    impressions: { type: 'string', default: '2000' },
    models: { type: 'string' },
    /** Comma-separated; default 256 for MIND, each synthetic model's own size. */
    dims: { type: 'string' },
    quantization: { type: 'string', default: 'int8' },
    /** Comma-separated: profile, default, diversity. */
    variants: { type: 'string', default: 'profile,default,diversity' },
    /** Results file name (without `.json`); derived from the models by default. */
    name: { type: 'string' },
    out: { type: 'string', default: 'eval/results' },
  },
});

interface Model {
  name: string;
  /** Builds the provider; called once per model, so one embedding pass serves all catalogs. */
  provider: () => EmbeddingProvider;
  /** Dimensions when `--dims` is not given. */
  defaultDims: number;
}

interface Catalog {
  label: string;
  model: string;
  dtype?: string;
  dims: number;
  quantization: Quantization;
  /** The model's default catalog: its default dimensions, int8. */
  default: boolean;
  dir: string;
  items: number;
  embedded: number;
  cached: number;
  shardBytes: number;
  manifestBytes: number;
  bytesPerItem: number;
  buildSeconds: number;
}

type RankOptions = Parameters<Inkling['rank']>[1];
const VARIANTS: Record<string, [string, RankOptions]> = {
  profile: ['profile only', { prior: 'catalog', diversity: 0, weights: { prior: 0, recency: 0 } }],
  default: ['profile + popularity (default weights)', { prior: 'catalog', diversity: 0 }],
  diversity: ['profile + popularity + diversity 0.2', { prior: 'catalog' }],
};

let dataset: Dataset;
let available: Record<string, Model>;
let defaultModels: string;
if (values.dataset === 'synthetic') {
  const data = synthetic();
  dataset = data;
  available = {
    a: { name: 'model A', provider: () => data.providers.a, defaultDims: 128 },
    b: { name: 'model B', provider: () => data.providers.b, defaultDims: 96 },
  };
  defaultModels = 'a,b';
} else if (values.dataset === 'mind') {
  if (!values['mind-dir']) throw new Error('--mind-dir is required for MIND (see eval/README.md)');
  dataset = await loadMind({ dir: values['mind-dir'], impressions: Number(values.impressions) });
  const gemma = (dtype: string): Model => ({
    name: `EmbeddingGemma ${dtype}`,
    provider: () => transformersProvider({ dtype, batchSize: 16 }),
    defaultDims: 256,
  });
  available = {
    hash: { name: 'hash (lexical)', provider: hashProvider, defaultDims: 256 },
    gemma: gemma('q8'),
    'gemma-q4': gemma('q4'),
    'gemma-fp32': gemma('fp32'),
  };
  defaultModels = 'hash,gemma';
} else {
  throw new Error(`Unknown dataset ${values.dataset}`);
}

const quantizations = list(values.quantization).map((q) => quantizationOf(q, '--quantization'));
const dimsList = values.dims ? list(values.dims).map((d) => positiveInt(d, '--dims')) : undefined;
const variantKeys = list(values.variants);
const variants = variantKeys.map((v) => {
  const variant = VARIANTS[v];
  if (!variant) throw new Error(`Unknown variant ${v} (${Object.keys(VARIANTS).join(', ')})`);
  return variant;
});
// Catalogs are compared on the default weights, or the first variant run.
const compared = Math.max(0, variantKeys.indexOf('default'));
const plan = list(values.models ?? defaultModels).map((spec) => {
  const [key, pin] = spec.split('@') as [string, string | undefined];
  const model = available[key];
  if (!model) throw new Error(`Unknown model ${key} (${Object.keys(available).join(', ')})`);
  if (!pin) {
    return {
      model,
      dims: dimsList ?? [model.defaultDims],
      quantizations,
    };
  }
  const [dims = '', quantization = 'int8'] = pin.split('/');
  return {
    model,
    dims: [positiveInt(dims, spec)],
    quantizations: [quantizationOf(quantization, spec)],
  };
});

console.error(`${dataset.name}: ${dataset.items.length} items`);
const slug = values.dataset;
const rows: { ranker: string; catalog?: string; metrics: Metrics; rankMs?: number }[] = [];
/** Per-impression nDCG@10 of each catalog's compared variant, for paired comparisons. */
const perImpression = new Map<string, number[]>();

rows.push({
  ranker: 'random',
  metrics: mean(
    dataset.impressions.map((imp) => score(shuffle(imp.candidates, imp.id), imp.clicked)),
  ),
});
const popularity = new Map(dataset.items.map((item) => [item.id, item.popularity ?? 0]));
rows.push({
  ranker: 'popularity',
  metrics: mean(
    dataset.impressions.map((imp) =>
      score(
        [...imp.candidates].sort((a, b) => (popularity.get(b) ?? 0) - (popularity.get(a) ?? 0)),
        imp.clicked,
      ),
    ),
  ),
});

const catalogs: Catalog[] = [];
for (const { model, dims: dimsForModel, quantizations: quantsForModel } of plan) {
  const provider = model.provider();
  const dtype = provider.model.dtype;
  const id = provider.model.id.replace(/[^\w.-]+/g, '_');
  // One cache file holds one model id and keeps only the entries a build used, so weights
  // variants (q8, q4) of one model need their own directories or they evict each other.
  const cacheDir = join('eval/.cache', slug, ...(dtype ? [dtype] : []));
  for (const dims of dimsForModel) {
    for (const quantization of quantsForModel) {
      const dir = join(
        'eval/.work',
        slug,
        id,
        ...(dtype ? [dtype] : []),
        `${dims}-${quantization}`,
      );
      const label = `${model.name} (${dims} dims${quantization === 'int8' ? '' : `, ${quantization}`})`;
      // Two selections of one catalog would make the model-switch check compare it with itself.
      if (catalogs.some((c) => c.dir === dir)) throw new Error(`${label} is in --models twice`);
      const started = performance.now();
      const result = await build({
        items: dataset.items,
        outDir: dir,
        provider,
        dims,
        quantization,
        cacheDir,
        log: (m) => console.error(`  ${m}`),
      });
      const manifestBytes = (await stat(join(dir, 'manifest.json'))).size;
      const catalog: Catalog = {
        label,
        model: provider.model.id,
        dtype,
        dims,
        quantization,
        default: dims === model.defaultDims && quantization === 'int8',
        dir,
        items: dataset.items.length,
        embedded: result.embedded,
        cached: result.cached,
        shardBytes: result.bytes,
        manifestBytes,
        bytesPerItem: result.bytes / dataset.items.length,
        buildSeconds: (performance.now() - started) / 1000,
      };
      catalogs.push(catalog);
      console.error(
        `${label}: ${result.embedded} embedded, ${result.cached} cached, ${(result.bytes / 1024).toFixed(0)} KB, ${catalog.buildSeconds.toFixed(1)} s`,
      );
      for (const [i, [variant, options]] of variants.entries()) {
        const { metrics, ndcg10, rankMs } = await evaluateInkling(dir, options);
        rows.push({ ranker: `Inkling, ${label}: ${variant}`, catalog: label, metrics, rankMs });
        if (i === compared) perImpression.set(label, ndcg10);
        console.error(
          `  ${variant}: nDCG@10 ${metrics.ndcg10.toFixed(4)}, ${rankMs.toFixed(2)} ms`,
        );
      }
    }
  }
  await provider.dispose?.();
}

let modelSwitch: { identical: number; total: number } | undefined;
// From the first catalog to the first of another model (or weights variant).
const from = catalogs[0];
const to = catalogs.find((c) => c.model !== from?.model || c.dtype !== from.dtype);
if (from && to) {
  modelSwitch = await switchCheck(from.dir, to.dir);
  console.error(
    `model switch ${from.label} → ${to.label}: ${modelSwitch.identical} of ${modelSwitch.total} rankings identical to a fresh profile`,
  );
}

const comparisons = pairs(catalogs).map(([a, b]) => ({
  a: a.label,
  b: b.label,
  metric: 'ndcg10',
  variant: variants[compared]![0],
  ...pairedDifference(perImpression.get(b.label)!, perImpression.get(a.label)!),
}));

const table = [
  `| Ranker | ${METRIC_NAMES.map(label).join(' | ')} |`,
  `|---|${METRIC_NAMES.map(() => '---').join('|')}|`,
  ...rows.map(
    (r) => `| ${r.ranker} | ${METRIC_NAMES.map((k) => r.metrics[k].toFixed(4)).join(' | ')} |`,
  ),
].join('\n');
console.log(`\n${dataset.name}, ${dataset.impressions.length} impressions\n\n${table}\n`);
for (const c of comparisons) {
  console.log(
    `${c.b} − ${c.a}: nDCG@10 ${signed(c.mean)} ± ${c.stderr.toFixed(4)} (95% CI ${signed(c.ci95[0])} to ${signed(c.ci95[1])})`,
  );
}
await mkdir(values.out, { recursive: true });
const name =
  values.name ??
  (values.dataset === 'mind'
    ? `mind-${catalogs.map((c) => `${c.model.split('/').pop()}-${c.dims}`).join('-')}`
    : slug);
await writeFile(
  join(values.out, `${name}.json`),
  `${JSON.stringify(
    {
      dataset: dataset.name,
      impressions: dataset.impressions.length,
      items: dataset.items.length,
      rows,
      modelSwitch,
      // Only ablation runs add these, so the committed results of plain runs stay as they were.
      ...(dimsList || quantizations.length > 1 || values.models?.includes('@')
        ? {
            catalogs: catalogs.map((c) => ({ ...c, dir: undefined })),
            comparisons,
          }
        : {}),
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------------------------------------

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
  options: RankOptions,
): Promise<{ metrics: Metrics; ndcg10: number[]; rankMs: number }> {
  const store = new MemoryStore();
  let now = 0;
  const ink = await load(dir, store, () => now);
  const all: Metrics[] = [];
  let ms = 0;
  for (const imp of dataset.impressions) {
    now = imp.at;
    await store.destroy();
    for (const itemId of imp.history)
      await store.add({ itemId, kind: 'view', weight: 1, at: imp.at });
    const started = performance.now();
    const ranked = await ink.rank(imp.candidates, options);
    ms += performance.now() - started;
    all.push(score(ranked, imp.clicked));
  }
  return {
    metrics: mean(all),
    ndcg10: all.map((m) => m.ndcg10),
    rankMs: ms / dataset.impressions.length,
  };
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

/**
 * Pairs of catalogs of one model that differ in one setting: adjacent dimensions (same
 * quantization and weights), int8 and float32 (same dimensions), or weights variants. Then
 * every other catalog of a model against its default catalog, as `[default, other]`.
 */
function pairs(all: readonly Catalog[]): [Catalog, Catalog][] {
  const out = neighbours(all);
  for (const d of all.filter((c) => c.default)) {
    for (const c of all) {
      if (c === d || c.model !== d.model || c.dtype !== d.dtype) continue;
      if (!out.some(([a, b]) => (a === c && b === d) || (a === d && b === c))) out.push([d, c]);
    }
  }
  return out;
}

function neighbours(all: readonly Catalog[]): [Catalog, Catalog][] {
  const found: [Catalog, Catalog][] = [];
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (a.model !== b.model) continue;
      const sameDtype = a.dtype === b.dtype;
      const sameQuant = a.quantization === b.quantization;
      if (sameDtype && sameQuant) {
        const between = all.some(
          (c) =>
            c.model === a.model &&
            c.dtype === a.dtype &&
            c.quantization === a.quantization &&
            c.dims > Math.min(a.dims, b.dims) &&
            c.dims < Math.max(a.dims, b.dims),
        );
        if (!between) found.push(a.dims < b.dims ? [a, b] : [b, a]);
      } else if (a.dims === b.dims && (sameDtype || sameQuant)) {
        found.push([a, b]);
      }
    }
  }
  return found;
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

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function quantizationOf(value: string, what: string): Quantization {
  if (value !== 'int8' && value !== 'float32') {
    throw new Error(`${what}: quantization is int8 or float32, not ${value}`);
  }
  return value;
}

function positiveInt(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what}: not a positive integer: ${value}`);
  return n;
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
}

function label(metric: keyof Metrics): string {
  return { auc: 'AUC', mrr: 'MRR', ndcg5: 'nDCG@5', ndcg10: 'nDCG@10', recall10: 'Recall@10' }[
    metric
  ];
}
