/**
 * `npm run demo`: builds the demo site in demo/dist from demo/feed.xml.
 *
 *   node scripts/demo.ts [--base /] [--provider transformers|hash] [--serve [port]]
 *
 * The site is static HTML. Each article page server-renders a "Related" list of the latest
 * articles in its section; `<inkling-related>` rewrites those slots in place with the items
 * whose vectors are closest. The browser loads `manifest.json` and one shard per section, and
 * no model. The vectors come from EmbeddingGemma via the committed embedding cache
 * (demo/inkling-cache), so the demo builds without downloading the model unless the feed changes.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from '../src/node/build.ts';
import { hashProvider } from '../src/node/providers/hash.ts';
import { transformersProvider } from '../src/node/providers/transformers.ts';
import { loadSource } from '../src/node/sources/index.ts';
import type { CatalogItem } from '../src/node/types.ts';
import { bundleGlobal } from './bundle.ts';

const OUT = 'demo/dist';
const SLOTS = 4;

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: '/' },
    provider: { type: 'string', default: 'transformers' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string', default: '4173' },
  },
});
const base = values.base.endsWith('/') ? values.base : `${values.base}/`;

const feed = await loadSource('demo/feed.xml');
const items: CatalogItem[] = feed.map((item) => ({ ...item, url: `${base}items/${item.id}.html` }));

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'items'), { recursive: true });
const provider =
  values.provider === 'hash' ? hashProvider() : transformersProvider({ dtype: 'q8' });
const result = await build({
  items,
  outDir: join(OUT, 'inkling'),
  provider,
  dims: 256,
  quantization: 'int8',
  cacheDir: values.provider === 'hash' ? false : 'demo/inkling-cache',
  // The cache keeps the output reproducible; so does a fixed time.
  now: new Date('2026-11-01T00:00:00Z'),
  log: (m) => console.error(m),
});
await provider.dispose?.();
await bundleGlobal(join(OUT, 'inkling.js'));
await cp('demo/style.css', join(OUT, 'style.css'));

const bySection = new Map<string, CatalogItem[]>();
for (const item of items) {
  const list = bySection.get(item.section ?? 'Other') ?? [];
  list.push(item);
  bySection.set(item.section ?? 'Other', list);
}

await writeFile(join(OUT, 'index.html'), page('Field Notes', indexBody()));
for (const item of items) {
  await writeFile(join(OUT, 'items', `${item.id}.html`), page(item.title, articleBody(item)));
}
console.error(
  `demo/dist: ${items.length} articles, ${result.manifest.shards.length} shards, ` +
    `${(result.bytes / 1024).toFixed(1)} KB of vectors (${result.manifest.model.id})`,
);

if (values.serve) await serve(Number(values.port));

function indexBody(): string {
  const sections = [...bySection]
    .map(
      ([section, list]) => `<section>
  <h2>${esc(section)}</h2>
  <ul class="cards">
${list.map((item) => `    <li><a href="${esc(item.url)}">${esc(item.title)}</a> <time datetime="${esc(item.date ?? '')}">${fmt(item.date)}</time></li>`).join('\n')}
  </ul>
</section>`,
    )
    .join('\n');
  return `<header><h1>Field Notes</h1><p class="lede">A demo publication for <a href="https://github.com/swissspidy/inkling">Inkling</a>. Open any article: its "Related" list is ranked in your browser from precomputed vectors, with no model and no tracking.</p></header>
<main>${sections}</main>`;
}

function articleBody(item: CatalogItem): string {
  // The server's non-personalized fallback: the latest other articles of the same section.
  const fallback = (bySection.get(item.section ?? 'Other') ?? [])
    .filter((other) => other.id !== item.id)
    .slice(0, SLOTS);
  const slots = fallback
    .map(
      (other) => `      <li data-inkling-slot data-inkling-id="${esc(other.id)}">
        <a href="${esc(other.url)}"><span class="title" data-inkling-title>${esc(other.title)}</span></a>
        <span class="meta"><span data-inkling-section>${esc(other.section ?? '')}</span> · <time data-inkling-date datetime="${esc(other.date ?? '')}">${fmt(other.date)}</time></span>
      </li>`,
    )
    .join('\n');
  return `<header><p><a href="${base}">← Field Notes</a></p></header>
<main>
  <article>
    <p class="kicker">${esc(item.section ?? '')} · <time datetime="${esc(item.date ?? '')}">${fmt(item.date)}</time></p>
    <h1>${esc(item.title)}</h1>
    <p>${esc(item.text)}</p>
  </article>
  <aside aria-labelledby="related-heading">
    <h2 id="related-heading">Related</h2>
    <inkling-related manifest="${base}inkling/manifest.json" item="${esc(item.id)}" section="${esc(item.section ?? '')}">
      <ol class="related">
${slots}
      </ol>
    </inkling-related>
    <details class="why">
      <summary>Why these?</summary>
      <p>Ranked on this device by cosine similarity of precomputed EmbeddingGemma vectors, a small recency boost and diversity. Nothing about you was used or sent.</p>
      <ol id="why-list"><li>Waiting for the ranking…</li></ol>
    </details>
  </aside>
</main>
<script>
  document.querySelector('inkling-related').addEventListener('inkling:ready', (event) => {
    const list = document.getElementById('why-list');
    list.replaceChildren(...event.detail.recommendations.map((r) => {
      const li = document.createElement('li');
      li.textContent = r.title + ': similarity ' + r.why.similarity.toFixed(2) + ', recency ' + r.why.recency.toFixed(2);
      return li;
    }));
  });
</script>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${base}style.css">
<link rel="preload" href="${base}inkling/manifest.json" as="fetch" crossorigin="anonymous">
<script src="${base}inkling.js" defer></script>
</head>
<body>
${body}
</body>
</html>
`;
}

function fmt(date: string | undefined): string {
  return date
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
        Date.parse(date),
      )
    : '';
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function serve(port: number): Promise<void> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.ink': 'application/octet-stream',
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).slice(
      base.length - 1,
    );
    const root = resolve(OUT);
    const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    if (!file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    readFile(file).then(
      (body) => {
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end('Not found');
      },
    );
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    console.error(`serving http://127.0.0.1:${actual}${base}`);
  });
  await new Promise(() => {});
}
