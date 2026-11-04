/**
 * MIND (Microsoft News Dataset), small version: https://msnews.github.io/. Licensed under the
 * Microsoft Research License Terms (non-commercial research); not redistributed here.
 *
 * The evaluation uses the dev set's impressions (Nov 15, 2019), with each user's click history.
 * Popularity comes from clicks in the training impressions (the days before), so it uses no
 * information from the impressions being ranked.
 */

import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CatalogItem } from '../../src/node/types.ts';
import type { Dataset, Impression } from '../types.ts';

export interface MindOptions {
  /** Directory with dev/news.tsv, dev/behaviors.tsv and train/behaviors.tsv. */
  dir: string;
  /** Impressions to evaluate, sampled evenly from those with a history and a click (default 2000). */
  impressions?: number;
}

export async function loadMind(options: MindOptions): Promise<Dataset> {
  const limit = options.impressions ?? 2000;
  const eligible: Impression[] = [];
  for await (const line of lines(join(options.dir, 'dev/behaviors.tsv'))) {
    const [id, user, time, history, shown] = line.split('\t');
    if (!history || !shown) continue;
    const candidates: string[] = [];
    const clicked = new Set<string>();
    for (const entry of shown.split(' ')) {
      const [newsId, label] = entry.split('-');
      candidates.push(newsId!);
      if (label === '1') clicked.add(newsId!);
    }
    if (clicked.size === 0 || clicked.size === candidates.length) continue;
    eligible.push({
      id: id!,
      user: user!,
      at: Date.parse(`${time} UTC`),
      history: history.split(' '),
      candidates,
      clicked,
    });
  }
  // An even sample: deterministic, and spread over the day.
  const step = Math.max(1, eligible.length / limit);
  const impressions = Array.from(
    { length: Math.min(limit, eligible.length) },
    (_, i) => eligible[Math.floor(i * step)]!,
  );

  const needed = new Set(impressions.flatMap((imp) => [...imp.history, ...imp.candidates]));
  const popularity = new Map<string, number>();
  for await (const line of lines(join(options.dir, 'train/behaviors.tsv'))) {
    const shown = line.split('\t')[4];
    for (const entry of shown?.split(' ') ?? []) {
      if (entry.endsWith('-1')) {
        const newsId = entry.slice(0, -2);
        popularity.set(newsId, (popularity.get(newsId) ?? 0) + 1);
      }
    }
  }
  const items: CatalogItem[] = [];
  for await (const line of lines(join(options.dir, 'dev/news.tsv'))) {
    const [id, category, subcategory, title, abstract] = line.split('\t');
    if (!needed.has(id!)) continue;
    items.push({
      id: id!,
      url: `https://assets.msn.com/labs/mind/${id}.html`,
      title: title ?? '',
      text: abstract ?? '',
      section: category,
      tags: subcategory ? [subcategory] : undefined,
      popularity: popularity.get(id!) ?? 0,
    });
  }
  return { name: `MIND small (dev, ${impressions.length} impressions)`, items, impressions };
}

function lines(path: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
}
