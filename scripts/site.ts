/**
 * `npm run site`: the GitHub Pages site in site/dist: the front page (site/), the demo under
 * demo/, and room for the API reference under api/ (`npm run api`, after this).
 *
 *   node scripts/site.ts [--base /]
 *
 * `--base` is the site's path on its host (`/hunch/` on GitHub Pages); the front page links
 * relatively, and the demo is built for `<base>demo/`.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const OUT = 'site/dist';
const { values } = parseArgs({ options: { base: { type: 'string', default: '/' } } });
const base = values.base.endsWith('/') ? values.base : `${values.base}/`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const file of ['index.html', 'site.css', 'hunch.svg']) {
  await cp(join('site', file), join(OUT, file));
}
const demo = spawnSync(
  process.execPath,
  ['scripts/demo.ts', '--base', `${base}demo/`, '--out', join(OUT, 'demo')],
  { stdio: 'inherit' },
);
if (demo.status !== 0) process.exit(demo.status ?? 1);
console.error(`${OUT}: the front page, and the demo for ${base}demo/`);
