/**
 * Milestones 3 and 4 on the synthetic dataset: Inkling beats the popularity baseline on
 * nDCG@10, and after a model switch every ranking equals a fresh profile's on the new model.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '../helpers.ts';

test('synthetic evaluation: beats popularity, and a model switch loses nothing', async () => {
  const out = await tempDir();
  await promisify(execFile)(process.execPath, [
    'eval/run.ts',
    '--dataset',
    'synthetic',
    '--out',
    out,
  ]);
  const result = JSON.parse(await readFile(join(out, 'synthetic.json'), 'utf8')) as {
    rows: { ranker: string; metrics: { ndcg10: number; auc: number } }[];
    modelSwitch: { identical: number; total: number };
    impressions: number;
  };
  const row = (prefix: string) => result.rows.find((r) => r.ranker.startsWith(prefix))!.metrics;
  const popularity = row('popularity');
  const inkling = row('Inkling, model A (128 dims): profile + popularity (default');
  const afterSwitch = row('Inkling, model B (96 dims): profile + popularity (default');
  assert.ok(inkling.ndcg10 > popularity.ndcg10 + 0.2, `${inkling.ndcg10} vs ${popularity.ndcg10}`);
  assert.ok(afterSwitch.ndcg10 > popularity.ndcg10 + 0.2);
  assert.ok(row('random').auc > 0.45 && row('random').auc < 0.55);
  assert.ok(result.impressions > 1000);
  assert.equal(result.modelSwitch.total, result.impressions);
  assert.equal(result.modelSwitch.identical, result.modelSwitch.total);
});
