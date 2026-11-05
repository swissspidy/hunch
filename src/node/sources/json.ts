/** A JSON catalog: an array of items, or `{ "items": [...] }`. */

import type { CatalogItem } from '../types.ts';
import { compact, isoDate } from './feed.ts';

/** Parses a JSON catalog: an array of items, or `{ "items": [...] }`. */
export function parseJsonCatalog(json: string): CatalogItem[] {
  const data: unknown = JSON.parse(json);
  const list = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) throw new Error('A JSON catalog is an array or { "items": [...] }');
  return list.map((raw, index) => normalizeItem(raw, index));
}

/** Checks an item from JSON or a custom loader, and fills in what can be derived. */
export function normalizeItem(raw: unknown, index: number): CatalogItem {
  const where = `Catalog item ${index + 1}`;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where} is not an object`);
  const item = raw as Record<string, unknown>;
  const id = item.id ?? item.url;
  if (typeof id !== 'string' || !id) throw new Error(`${where} has no id or url`);
  if (typeof item.title !== 'string') throw new Error(`${where} (${id}) has no title`);
  const tags = item.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
    throw new Error(`${where} (${id}): tags must be an array of strings`);
  }
  const popularity = item.popularity;
  if (popularity !== undefined && typeof popularity !== 'number') {
    throw new Error(`${where} (${id}): popularity must be a number`);
  }
  return compact({
    id,
    url: typeof item.url === 'string' ? item.url : id,
    title: item.title,
    text: typeof item.text === 'string' ? item.text : '',
    section: typeof item.section === 'string' ? item.section : undefined,
    tags,
    date: typeof item.date === 'string' ? isoDate(item.date) : undefined,
    image: typeof item.image === 'string' ? item.image : undefined,
    popularity,
  });
}
