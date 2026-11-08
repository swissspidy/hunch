/**
 * `npm run site`: the GitHub Pages site in site/dist: the front page (site/), the demo under
 * demo/, the WordPress plugin and its Playground demo under wordpress/ (scripts/playground.ts),
 * and room for the API reference under api/ (`npm run api`, after this).
 *
 *   node scripts/site.ts [--url http://127.0.0.1:4173/]
 *
 * `--url` is where the site is published (`https://<owner>.github.io/<repository>/` on GitHub
 * Pages). The front page links relatively; the demo is built for its path plus `demo/`, and the
 * Playground blueprint needs absolute URLs.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const OUT = 'site/dist';
const { values } = parseArgs({
  options: { url: { type: 'string', default: 'http://127.0.0.1:4173/' } },
});
const url = new URL(values.url.endsWith('/') ? values.url : `${values.url}/`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const file of ['index.html', 'site.css', 'hunch.svg']) {
  await cp(join('site', file), join(OUT, file));
}
run('scripts/demo.ts', '--base', `${url.pathname}demo/`, '--out', join(OUT, 'demo'));
run('scripts/playground.ts', '--url', url.href, '--out', join(OUT, 'wordpress'));
console.error(`${OUT}: the front page, the demo and the WordPress plugin for ${url.href}`);

function run(script: string, ...args: string[]): void {
  const child = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (child.status !== 0) process.exit(child.status ?? 1);
}
