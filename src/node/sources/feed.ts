/** RSS 2.0, RSS 1.0 (RDF) and Atom 1.0 feeds. */

import { XMLParser } from 'fast-xml-parser';
import { htmlToText, decodeEntities } from '../text.ts';
import type { CatalogItem } from '../types.ts';

const ARRAYS = new Set(['item', 'entry', 'category', 'link']);

type Node = Record<string, unknown>;

/** Parses an RSS 2.0, RSS 1.0 (RDF) or Atom 1.0 feed. An item's id is its `guid`, or its link. */
export function parseFeed(xml: string): CatalogItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    // Entities are decoded by htmlToText/decodeEntities, once: feeds often double-encode HTML.
    processEntities: false,
    isArray: (name) => ARRAYS.has(name),
  });
  const doc = parser.parse(xml) as Node;
  const rss = doc.rss as Node | undefined;
  if (rss) {
    const channel = rss.channel as Node | undefined;
    return ((channel?.item as Node[] | undefined) ?? []).map(rssItem);
  }
  // RSS 1.0: the items are siblings of the channel, under rdf:RDF.
  const rdf = doc['rdf:RDF'] as Node | undefined;
  if (rdf) return ((rdf.item as Node[] | undefined) ?? []).map(rssItem);
  const feed = doc.feed as Node | undefined;
  if (feed) return ((feed.entry as Node[] | undefined) ?? []).map(atomEntry);
  throw new Error('Not an RSS or Atom feed');
}

function rssItem(item: Node, index: number): CatalogItem {
  const link = text(first(item.link));
  const guid = text(item.guid);
  const id = guid || link || attr(item, 'rdf:about');
  if (!id) throw new Error(`Feed item ${index + 1} has neither guid nor link`);
  // A guid is a link only when it says so (isPermaLink defaults to true) and looks like one.
  const permalink =
    attr(item.guid, 'isPermaLink') !== 'false' && /^https?:\/\//i.test(guid) ? guid : '';
  const url = link || permalink || attr(item, 'rdf:about');
  if (!url) throw new Error(`Feed item ${index + 1} (${id}) has no link`);
  const categories = ((item.category as unknown[] | undefined) ?? []).map(text).filter(Boolean);
  const body = text(item['content:encoded']) || text(item.description);
  return compact({
    id,
    url,
    title: decodeEntities(htmlToText(text(item.title))),
    text: htmlToText(decodeEntities(body)),
    section: categories[0],
    tags: categories.length ? categories : undefined,
    date: isoDate(text(item.pubDate) || text(item['dc:date'])),
    image: attr(item.enclosure, 'url') || attr(item['media:content'], 'url') || undefined,
  });
}

function atomEntry(entry: Node, index: number): CatalogItem {
  const links = (entry.link as Node[] | undefined) ?? [];
  const alternate = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  const url = alternate ? String(alternate['@_href'] ?? '') : '';
  const id = text(entry.id) || url;
  if (!id) throw new Error(`Feed entry ${index + 1} has neither id nor link`);
  const categories = ((entry.category as Node[] | undefined) ?? [])
    .map((c) => String(c['@_label'] ?? c['@_term'] ?? ''))
    .filter(Boolean);
  const body = text(entry.content) || text(entry.summary);
  return compact({
    id,
    url: url || id,
    title: decodeEntities(htmlToText(text(entry.title))),
    text: htmlToText(decodeEntities(body)),
    section: categories[0],
    tags: categories.length ? categories : undefined,
    date: isoDate(text(entry.published) || text(entry.updated)),
  });
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return text((value as Node)['#text']);
  return String(value).trim();
}

function attr(value: unknown, name: string): string {
  const node = first(value);
  return node && typeof node === 'object' ? String((node as Node)[`@_${name}`] ?? '') : '';
}

export function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Drops the keys whose value is `undefined` (so JSON output and deep equality stay tidy). */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
