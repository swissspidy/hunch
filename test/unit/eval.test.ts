/**
 * Milestones 3 and 4 on the synthetic dataset: Hunch beats the popularity baseline on
 * nDCG@10, and after a model switch every ranking equals a fresh profile's on the new model.
 * The same run is a small ablation (two sizes, int8 and float32) from one embedding pass.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pairedDifference } from '../../eval/metrics.ts';
import { tempDir } from '../helpers.ts';

interface Result {
  rows: { ranker: string; metrics: { ndcg10: number; auc: number } }[];
  modelSwitch: { identical: number; total: number };
  impressions: number;
  items: number;
  catalogs: {
    label: string;
    dims: number;
    quantization: string;
    embedded: number;
    cached: number;
    bytesPerItem: number;
  }[];
  comparisons: { a: string; b: string; mean: number; stderr: number; ci95: [number, number] }[];
}

test('synthetic evaluation: beats popularity, a model switch loses nothing, one embedding pass', async () => {
  const out = await tempDir();
  // One process for both checks keeps CI time flat: model A at 64 and 128 dims, int8 and
  // float32 (four catalogs), model B at its own 96 dims, and only the default weights.
  await promisify(execFile)(process.execPath, [
    'eval/run.ts',
    '--dataset',
    'synthetic',
    '--models',
    'a,b@96',
    '--dims',
    '64,128',
    '--quantization',
    'int8,float32',
    '--variants',
    'default',
    '--name',
    'ablation',
    '--out',
    out,
    '--cache',
    join(out, 'cache'),
  ]);
  const result = JSON.parse(await readFile(join(out, 'ablation.json'), 'utf8')) as Result;
  const row = (prefix: string) => result.rows.find((r) => r.ranker.startsWith(prefix))!.metrics;
  const popularity = row('popularity');
  const hunch = row('Hunch, model A (128 dims): profile + popularity (default');
  const afterSwitch = row('Hunch, model B (96 dims): profile + popularity (default');
  assert.ok(hunch.ndcg10 > popularity.ndcg10 + 0.2, `${hunch.ndcg10} vs ${popularity.ndcg10}`);
  assert.ok(afterSwitch.ndcg10 > popularity.ndcg10 + 0.2);
  assert.ok(row('random').auc > 0.45 && row('random').auc < 0.55);
  assert.ok(result.impressions > 1000);
  // The switch goes from the first catalog (model A) to model B, not to another size of A.
  assert.equal(result.modelSwitch.total, result.impressions);
  assert.equal(result.modelSwitch.identical, result.modelSwitch.total);

  // Ablation: the four catalogs of model A share one embedding pass (the first build embeds,
  // the others only truncate and quantize).
  assert.deepEqual(
    result.catalogs.map((c) => c.label),
    [
      'model A (64 dims)',
      'model A (64 dims, float32)',
      'model A (128 dims)',
      'model A (128 dims, float32)',
      'model B (96 dims)',
    ],
  );
  for (const c of result.catalogs) assert.equal(c.embedded + c.cached, result.items);
  // From an empty cache: the first catalog of model A embeds everything, the other three nothing.
  assert.equal(result.catalogs[0]!.embedded, result.items);
  for (const c of result.catalogs.slice(1, 4)) assert.equal(c.embedded, 0, c.label);
  const perItem = (label: string) => result.catalogs.find((c) => c.label === label)!.bytesPerItem;
  assert.ok(perItem('model A (64 dims, float32)') > perItem('model A (64 dims)'));
  assert.ok(perItem('model A (128 dims)') > perItem('model A (64 dims)'));
  // Neighbours of one model (64 → 128 at each quantization, int8 → float32 at each size), then
  // the rest against the model's default catalog (128 dims, int8).
  assert.deepEqual(result.comparisons.map((c) => `${c.a} → ${c.b}`).sort(), [
    'model A (128 dims) → model A (128 dims, float32)',
    'model A (128 dims) → model A (64 dims, float32)',
    'model A (64 dims) → model A (128 dims)',
    'model A (64 dims) → model A (64 dims, float32)',
    'model A (64 dims, float32) → model A (128 dims, float32)',
  ]);
  const more = result.comparisons.find((c) => c.b === 'model A (128 dims)')!;
  assert.ok(more.mean > 0 && more.ci95[0] > 0, 'twice the dimensions ranks better here');
});

test('pairedDifference: mean, standard error and a bootstrap interval of b − a', () => {
  const a = [0.1, 0.5, 0.3, 0.9, 0.2, 0.4];
  const same = pairedDifference(a, a);
  assert.deepEqual(same, { mean: 0, stderr: 0, ci95: [0, 0] });

  const shifted = pairedDifference(
    a.map((x) => x + 0.25),
    a,
  );
  assert.ok(Math.abs(shifted.mean - 0.25) < 1e-12);
  assert.ok(shifted.stderr < 1e-12);

  // Differences of +1 and −1 in equal numbers: mean 0, standard error 1 / sqrt(n − 1).
  const n = 400;
  const b = Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1));
  const zero = new Array<number>(n).fill(0);
  const noisy = pairedDifference(b, zero);
  assert.equal(noisy.mean, 0);
  assert.ok(Math.abs(noisy.stderr - 1 / Math.sqrt(n - 1)) < 1e-12);
  // The 95% interval is about ±1.96 standard errors around the mean, and deterministic.
  assert.ok(noisy.ci95[0] < -1.5 * noisy.stderr && noisy.ci95[0] > -2.5 * noisy.stderr);
  assert.ok(noisy.ci95[1] > 1.5 * noisy.stderr && noisy.ci95[1] < 2.5 * noisy.stderr);
  assert.deepEqual(pairedDifference(b, zero), noisy);

  assert.throws(() => pairedDifference([1, 2], [1]), RangeError);
  for (const resamples of [0, -1, 2.5, Number.NaN]) {
    assert.throws(() => pairedDifference(b, zero, resamples), RangeError, String(resamples));
  }
});

test('eval run: rejects an empty --variants list and writes results for a single impression', async () => {
  const out = await tempDir();
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [
      'eval/run.ts',
      '--dataset',
      'synthetic',
      '--models',
      'a',
      '--dims',
      '64,128',
      '--out',
      out,
      '--cache',
      join(out, 'cache'),
      ...args,
    ]);
  await assert.rejects(run('--variants', ','), /--variants/);
  await run('--variants', 'default', '--impressions', '1', '--name', 'one');
  const result = JSON.parse(await readFile(join(out, 'one.json'), 'utf8')) as Result;
  assert.equal(result.impressions, 1);
  assert.deepEqual(result.comparisons, []);
});
