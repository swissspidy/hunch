/**
 * A sitemap (or sitemap index) and the text of its pages. Each page's title, section, tags and
 * date come from its Open Graph / article meta tags; its text from `<article>`, `<main>` or
 * `<body>`, in that order.
 */

import { XMLParser } from 'fast-xml-parser';
import { decodeEntities, htmlToText } from '../text.ts';
import type { CatalogItem } from '../types.ts';
import { compact, isoDate } from './feed.ts';

type Node = Record<string, unknown>;

export interface SitemapOptions {
  fetchText: (url: string) => Promise<string>;
  /** Pages fetched at once (default 4). */
  concurrency?: number;
  /** Stop after this many pages. */
  limit?: number;
}

export async function loadSitemap(url: string, options: SitemapOptions): Promise<CatalogItem[]> {
  const pages = await sitemapUrls(url, options.fetchText, new Set());
  const selected = options.limit ? pages.slice(0, options.limit) : pages;
  const items: CatalogItem[] = new Array(selected.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < selected.length) {
      const i = next++;
      const page = selected[i]!;
      items[i] = parsePage(page.loc, await options.fetchText(page.loc), page.lastmod);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  return items;
}

async function sitemapUrls(
  url: string,
  fetchText: (url: string) => Promise<string>,
  seen: Set<string>,
): Promise<{ loc: string; lastmod?: string }[]> {
  if (seen.has(url)) return [];
  seen.add(url);
  const doc = new XMLParser({ isArray: (name) => name === 'url' || name === 'sitemap' }).parse(
    await fetchText(url),
  ) as Node;
  const index = doc.sitemapindex as Node | undefined;
  if (index) {
    const nested = ((index.sitemap as Node[] | undefined) ?? []).map((s) => String(s.loc));
    const lists = [];
    for (const loc of nested) lists.push(await sitemapUrls(loc, fetchText, seen));
    return lists.flat();
  }
  const set = doc.urlset as Node | undefined;
  if (!set) throw new Error(`${url} is not a sitemap`);
  return ((set.url as Node[] | undefined) ?? []).map((u) =>
    compact({ loc: String(u.loc), lastmod: u.lastmod ? String(u.lastmod) : undefined }),
  );
}

export function parsePage(url: string, html: string, lastmod?: string): CatalogItem {
  const meta = (name: string): string | undefined => {
    const re = new RegExp(
      `<meta\\s[^>]*(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta\\s[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      'i',
    );
    const m = re.exec(html);
    const value = m?.[1] ?? m?.[2];
    return value === undefined ? undefined : decodeEntities(value);
  };
  const tags = [
    ...html.matchAll(/<meta\s[^>]*property=["']article:tag["'][^>]*content=["']([^"']*)["']/gi),
  ].map((m) => decodeEntities(m[1]!));
  const title =
    meta('og:title') ?? htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const body =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;
  const date = meta('article:published_time') ?? lastmod;
  return compact({
    id: new URL(url).pathname,
    url,
    title: title || url,
    text: htmlToText(body),
    section: meta('article:section'),
    tags: tags.length ? tags : undefined,
    date: date ? isoDate(date) : undefined,
    image: meta('og:image'),
  });
}
