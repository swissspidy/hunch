/**
 * The WordPress plugin on the Pages site: the zip, and a WordPress Playground demo of it.
 *
 *   node scripts/playground.ts --url https://example.github.io/hunch/ [--out site/dist/wordpress]
 *
 * Writes into `--out`:
 *
 * - `hunch.zip`: the plugin, as `npm run wordpress:build` makes it;
 * - `demo.json`: the demo's 32 articles as posts, each with its EmbeddingGemma vector from the
 *   committed embedding cache (demo/hunch-cache), so the Playground site ranks without
 *   downloading the model;
 * - `import.php`: creates those posts and a "For you" front page, stores the vectors and writes
 *   the plugin's files (wordpress/playground/import.php);
 * - `blueprint.json`: the Playground blueprint, with absolute URLs under `--url`;
 * - `playground.html`: a page that opens Playground with that blueprint.
 */

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EmbeddingCache } from '../src/node/cache.ts';
import { transformersProvider } from '../src/node/providers/transformers.ts';
import { documentInput } from '../src/node/providers/types.ts';
import { loadSource } from '../src/node/sources/index.ts';
import { htmlToText } from '../src/node/text.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4173/' },
    out: { type: 'string', default: 'site/dist/wordpress' },
  },
});
const site = new URL(values.url.endsWith('/') ? values.url : `${values.url}/`);
const base = new URL('wordpress/', site);
const out = values.out;
await mkdir(out, { recursive: true });

// The plugin's zip.
const zip = spawnSync(process.execPath, ['scripts/wordpress.ts'], { stdio: 'inherit' });
if (zip.status !== 0) process.exit(zip.status ?? 1);
await copyFile('wordpress/hunch.zip', join(out, 'hunch.zip'));

// The demo's articles, with the vectors the plugin would store for them. A post's content is its
// text in one paragraph, so the plugin's input for it (title and plain text in the document
// prompt) is the CLI's for the feed item, and the cached vector is that input's.
const model = transformersProvider({ dtype: 'q8' }).model;
const cache = await EmbeddingCache.open(model, 'demo/hunch-cache');
const items = await loadSource('demo/feed.xml');
const posts = items.map((item) => {
  const content = `<!-- wp:paragraph -->\n<p>${escape(item.text)}</p>\n<!-- /wp:paragraph -->`;
  const input = documentInput(model.documentPrompt, htmlToText(item.title), htmlToText(content));
  const vector = cache.get(cache.key(input));
  if (!vector) {
    throw new Error(`No cached vector for "${item.title}": run npm run demo with the model first`);
  }
  return {
    title: item.title,
    content,
    section: item.section,
    tags: item.tags ?? [],
    date: item.date,
    vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64'),
  };
});
await writeFile(join(out, 'demo.json'), `${JSON.stringify({ posts })}\n`);
await copyFile('wordpress/playground/import.php', join(out, 'import.php'));

const blueprint = {
  $schema: 'https://playground.wordpress.net/blueprint-schema.json',
  meta: {
    title: 'Hunch',
    description: 'Related posts and "for you", ranked in the browser, on a demo site.',
    author: 'swissspidy',
  },
  landingPage: '/',
  preferredVersions: { php: 'latest', wp: 'latest' },
  steps: [
    {
      step: 'installPlugin',
      pluginData: { resource: 'url', url: new URL('hunch.zip', base).href },
    },
    {
      step: 'writeFile',
      path: '/tmp/hunch-demo.json',
      data: { resource: 'url', url: new URL('demo.json', base).href },
    },
    {
      step: 'writeFile',
      path: '/tmp/hunch-import.php',
      data: { resource: 'url', url: new URL('import.php', base).href },
    },
    {
      step: 'runPHP',
      code: "<?php require '/wordpress/wp-load.php'; require '/tmp/hunch-import.php';",
    },
    { step: 'login', username: 'admin', password: 'password' },
  ],
};
await writeFile(join(out, 'blueprint.json'), `${JSON.stringify(blueprint, null, 2)}\n`);

const playground = `https://playground.wordpress.net/?blueprint-url=${encodeURIComponent(new URL('blueprint.json', base).href)}`;
await writeFile(
  join(out, 'playground.html'),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hunch in WordPress Playground</title>
<meta http-equiv="refresh" content="0; url=${playground}">
<p>Opening <a href="${playground}">Hunch in WordPress Playground</a>…</p>
`,
);
console.error(`${out}: the plugin, a demo of ${posts.length} posts and its Playground blueprint`);

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
