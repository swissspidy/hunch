/**
 * Loads a catalog from a file or URL: JSON, RSS/Atom, a sitemap, or a JavaScript module whose
 * default export is a loader (`() => CatalogItem[] | Promise<CatalogItem[]>`).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CatalogItem } from '../types.ts';
import { parseFeed } from './feed.ts';
import { normalizeItem, parseJsonCatalog } from './json.ts';
import { loadSitemap } from './sitemap.ts';

export type SourceKind = 'json' | 'feed' | 'sitemap' | 'module';

export interface LoadOptions {
  kind?: SourceKind;
  /** For sitemaps: stop after this many pages. */
  limit?: number;
}

export async function loadSource(
  source: string,
  options: LoadOptions = {},
): Promise<CatalogItem[]> {
  const remote = /^https?:\/\//i.test(source);
  if (options.kind === 'module' || (!remote && /\.(m?js|ts)$/i.test(source))) {
    const mod = (await import(pathToFileURL(resolve(source)).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      throw new Error(`${source}: a loader module's default export is a function`);
    }
    const items: unknown = await (mod.default as () => unknown)();
    if (!Array.isArray(items)) throw new Error(`${source}: the loader did not return an array`);
    return items.map((raw, i) => normalizeItem(raw, i));
  }
  const body = remote ? await fetchText(source) : await readFile(source, 'utf8');
  const kind = options.kind ?? sniff(source, body);
  switch (kind) {
    case 'json':
      return parseJsonCatalog(body);
    case 'feed':
      return parseFeed(body);
    case 'sitemap': {
      const base = remote ? source : pathToFileURL(resolve(source)).href;
      return loadSitemap(base, {
        limit: options.limit,
        fetchText: (url) =>
          url === base
            ? Promise.resolve(body)
            : // A local sitemap may name local files; fetch() cannot read file: URLs.
              url.startsWith('file:')
              ? readFile(fileURLToPath(url), 'utf8')
              : fetchText(url),
      });
    }
    case 'module':
      throw new Error(`${source}: a loader module must be a local file`);
  }
}

function sniff(source: string, body: string): SourceKind {
  const head = body.slice(0, 2048).trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  if (/<(urlset|sitemapindex)\b/.test(head)) return 'sitemap';
  if (/<(rss|feed|rdf:RDF)\b/.test(head)) return 'feed';
  throw new Error(`${source}: cannot tell the format (JSON, RSS/Atom or sitemap)`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'inkling-build' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}
