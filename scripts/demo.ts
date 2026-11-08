/**
 * `npm run demo`: builds the demo site in demo/dist from demo/feed.xml.
 *
 *   node scripts/demo.ts [--base /] [--out demo/dist] [--provider transformers|hash] [--serve [port]]
 *
 * The site is static HTML. Each article page server-renders a "Related" list of the latest
 * articles in its section; `<hunch-related>` rewrites those slots in place with the items
 * whose vectors are closest. The browser loads `manifest.json` and one shard per section, and
 * no model. The vectors come from EmbeddingGemma via the committed embedding cache
 * (demo/hunch-cache), so the demo builds without downloading the model unless the feed changes.
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
import { bundleEsm, bundleGlobal } from './bundle.ts';

const SLOTS = 4;

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: '/' },
    out: { type: 'string', default: 'demo/dist' },
    provider: { type: 'string', default: 'transformers' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string', default: '4173' },
  },
});
const base = values.base.endsWith('/') ? values.base : `${values.base}/`;
const OUT = values.out;

const feed = await loadSource('demo/feed.xml');
const items: CatalogItem[] = feed.map((item) => ({ ...item, url: `${base}items/${item.id}.html` }));

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'items'), { recursive: true });
const provider =
  values.provider === 'hash' ? hashProvider() : transformersProvider({ dtype: 'q8' });
const result = await build({
  items,
  outDir: join(OUT, 'hunch'),
  provider,
  dims: 256,
  quantization: 'int8',
  cacheDir: values.provider === 'hash' ? false : 'demo/hunch-cache',
  // The cache keeps the output reproducible; so does a fixed time.
  now: new Date('2026-11-01T00:00:00Z'),
  log: (m) => console.error(m),
});
await provider.dispose?.();
await bundleGlobal(join(OUT, 'hunch.js'));
// The query embedder, loaded only when a visitor searches.
await writeFile(join(OUT, 'hunch-query.js'), await bundleEsm('src/query/index.ts'));
await cp('demo/style.css', join(OUT, 'style.css'));
await cp('demo/demo.js', join(OUT, 'demo.js'));

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
  `${OUT}: ${items.length} articles, ${result.manifest.shards.length} shards, ` +
    `${(result.bytes / 1024).toFixed(1)} KB of vectors (${result.manifest.model.id})`,
);

if (values.serve) await serve(Number(values.port));

function slot(item: CatalogItem, indent: string): string {
  return `${indent}<li data-hunch-slot data-hunch-id="${esc(item.id)}">
${indent}  <a href="${esc(item.url)}"><span class="title" data-hunch-title>${esc(item.title)}</span></a>
${indent}  <span class="meta"><span data-hunch-section>${esc(item.section ?? '')}</span> · <time data-hunch-date datetime="${esc(item.date ?? '')}">${fmt(item.date)}</time></span>
${indent}</li>`;
}

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
  // The cold start is the site's own order: the feed's first items.
  // The digest's fallback: the newest articles.
  const latest = [...items]
    .sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))
    .slice(0, 3)
    .map((item) => slot(item, '      '))
    .join('\n');
  const editorial = items
    .slice(0, SLOTS)
    .map((item) => slot(item, '      '))
    .join('\n');
  return `<header><h1>Field Notes</h1><p class="lede">A demo publication for <a href="https://github.com/swissspidy/hunch">Hunch</a>. Recommendations are ranked in your browser from precomputed vectors, with no model. Search embeds your query with a model in your browser. There is no server-side profile and no tracking.</p></header>
<main>
  <section aria-labelledby="search-heading">
    <h2 id="search-heading">Search</h2>
    <form id="search" class="search" role="search">
      <input type="search" name="q" aria-label="Search the articles" placeholder="e.g. trains through the mountains" required disabled>
      <button type="submit" disabled>Search on this device</button>
    </form>
    <p class="status"><output id="search-status">Your query never leaves this browser. The first search downloads EmbeddingGemma (about 200 MB, once) from Hugging Face.</output></p>
    <ol id="results" class="cards"></ol>
  </section>
  <section aria-labelledby="digest-heading">
    <h2 id="digest-heading">Since your last visit</h2>
    <hunch-digest manifest="${base}hunch/manifest.json" context="Headlines of a publication about food, science, technology and travel, published since the reader's last visit.">
      <p class="summary" data-hunch-summary>The latest articles. Come back later, with personalization on, for what is new since this visit.</p>
      <ol class="related" role="list">
${latest}
      </ol>
    </hunch-digest>
  </section>
  <section aria-labelledby="for-you-heading">
    <h2 id="for-you-heading">For you</h2>
    <hunch-for-you manifest="${base}hunch/manifest.json">
      <ol class="related" role="list">
${editorial}
      </ol>
    </hunch-for-you>
    <details class="why">
      <summary>Why these?</summary>
      <ol id="why-list"><li>The editors' picks: turn on personalization below and read a few articles.</li></ol>
    </details>
  </section>
  <section class="privacy" aria-labelledby="privacy-heading">
    <h2 id="privacy-heading">Your data</h2>
    <p>Personalization keeps a list of the articles you read in this browser's storage. It never leaves your device.</p>
    <p><label><input type="checkbox" id="consent"> Personalize this site on my device</label></p>
    <p class="controls">
      <button type="button" id="pause">Pause</button>
      <button type="button" id="export">Export my data</button>
      <button type="button" id="forget">Forget everything</button>
    </p>
    <p class="status"><output id="status" aria-live="off">Personalization is off. Nothing is stored.</output></p>
    <p class="time-travel">Try "since your last visit" (with personalization on): <a id="travel" href="?as-of=2026-09-15">visit as if it were 15 September 2026</a>, then <a href="./">come back today</a>. The first link forgets this browser's visits, so September is the last visit.</p>
  </section>
${sections}
</main>`;
}

function articleBody(item: CatalogItem): string {
  // The server's non-personalized fallback: the latest other articles of the same section.
  const fallback = (bySection.get(item.section ?? 'Other') ?? [])
    .filter((other) => other.id !== item.id)
    .slice(0, SLOTS);
  return `<header><p><a href="${base}">← Field Notes</a></p></header>
<main>
  <hunch-page manifest="${base}hunch/manifest.json" item="${esc(item.id)}"></hunch-page>
  <article>
    <p class="kicker">${esc(item.section ?? '')} · <time datetime="${esc(item.date ?? '')}">${fmt(item.date)}</time></p>
    <h1>${esc(item.title)}</h1>
    <p>${esc(item.text)}</p>
    <p class="controls" data-item="${esc(item.id)}">
      <button type="button" data-signal="follow">More like this</button>
      <button type="button" data-signal="hide">Not interested</button>
      <output id="feedback"></output>
    </p>
  </article>
  <aside aria-labelledby="related-heading">
    <h2 id="related-heading">Related</h2>
    <hunch-related manifest="${base}hunch/manifest.json" item="${esc(item.id)}" section="${esc(item.section ?? '')}">
      <ol class="related" role="list">
${fallback.map((other) => slot(other, '        ')).join('\n')}
      </ol>
    </hunch-related>
    <details class="why">
      <summary>Why these?</summary>
      <p>Ranked on this device by cosine similarity of precomputed EmbeddingGemma vectors, a small recency boost and diversity. Nothing about you was used or sent.</p>
      <ol id="why-list"><li>Waiting for the ranking…</li></ol>
    </details>
  </aside>
</main>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${base}style.css">
<link rel="preload" href="${base}hunch/manifest.json" as="fetch" crossorigin="anonymous">
<script>
  // Hunch's consent hook, set before the components start. The demo asks with a checkbox;
  // a real site asks its consent manager.
  // ?as-of=2026-09-15 visits the demo as if it were that day, to try "since your last visit".
  const asOf = Date.parse(new URLSearchParams(location.search).get('as-of') ?? '');
  window.HunchConfig = {
    consent: () => { try { return localStorage.getItem('hunch-demo-consent') === 'yes'; } catch { return false; } },
    now: Number.isNaN(asOf) ? undefined : () => asOf,
  };
</script>
<script src="${base}hunch.js" defer></script>
<script src="${base}demo.js" defer></script>
</head>
<body data-manifest="${base}hunch/manifest.json">
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
    '.hunch': 'application/octet-stream',
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
