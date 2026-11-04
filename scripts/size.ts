/**
 * `npm run size`: the client's minified, gzipped size against its budget (ADR 0001). Writes a
 * table to the GitHub job summary when there is one.
 */

import { appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { bundleEsm } from './bundle.ts';

const BUDGETS: [label: string, entry: string, gzipBudget: number][] = [
  ['core (Inkling client)', 'src/client/index.ts', 10 * 1024],
  ['core + <inkling-related>', 'src/elements/global.ts', 12 * 1024],
];

let failed = false;
const rows: string[] = [];
for (const [label, entry, budget] of BUDGETS) {
  const min = await bundleEsm(entry);
  const gz = gzipSync(min, { level: 9 }).length;
  const ok = gz <= budget;
  failed ||= !ok;
  const line = `${label}: ${kb(min.length)} min, ${kb(gz)} gzip (budget ${kb(budget)})`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
  rows.push(`| ${label} | ${kb(min.length)} | ${kb(gz)} | ${kb(budget)} | ${ok ? '✅' : '❌'} |`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Bundle size',
      '',
      '| Bundle | Minified | Gzip | Budget | |',
      '|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  );
}
if (failed) process.exitCode = 1;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}
