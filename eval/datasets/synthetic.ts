/**
 * A synthetic news site with known ground truth. Items belong to latent topics; users like a
 * few topics; clicks depend on a user's affinity to an item and on the item's popularity.
 *
 * Two "embedding models" see the latent space through different random projections, with
 * noise and different sizes. Neither is the truth, and their vectors are incomparable, like
 * two real models. That makes them a controlled test of a model switch.
 */

import type { EmbeddingProvider } from '../../src/node/providers/types.ts';
import type { CatalogItem } from '../../src/node/types.ts';
import type { Dataset, Impression } from '../types.ts';

export interface SyntheticOptions {
  items?: number;
  users?: number;
  topics?: number;
  seed?: number;
}

export interface Synthetic extends Dataset {
  /** Embedding providers over the latent space: `a` (128 dims) and `b` (96 dims). */
  providers: { a: EmbeddingProvider; b: EmbeddingProvider };
}

const LATENT = 32;

export function synthetic(options: SyntheticOptions = {}): Synthetic {
  const itemCount = options.items ?? 3000;
  const userCount = options.users ?? 1500;
  const topicCount = options.topics ?? 16;
  const rand = rng(options.seed ?? 7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  const topics = Array.from({ length: topicCount }, () =>
    unit(Array.from({ length: LATENT }, gauss)),
  );
  const latent = new Map<string, number[]>();
  const items: CatalogItem[] = [];
  const day = 86_400_000;
  const start = Date.UTC(2026, 9, 1);
  for (let i = 0; i < itemCount; i++) {
    const topic = Math.floor(rand() * topicCount);
    const v = unit(topics[topic]!.map((x) => x + (0.6 * gauss()) / Math.sqrt(LATENT)));
    const id = `item-${i}`;
    latent.set(id, v);
    items.push({
      id,
      url: `/items/${i}`,
      title: id,
      text: '',
      section: `topic-${topic}`,
      date: new Date(start + rand() * 30 * day).toISOString(),
      // Zipf-like: a few items are very popular.
      popularity: Math.round(1000 / (1 + i * rand())),
    });
  }
  const popMax = Math.log1p(Math.max(...items.map((i) => i.popularity!)));
  const pop = new Map(items.map((i) => [i.id, Math.log1p(i.popularity!) / popMax]));

  const impressions: Impression[] = [];
  for (let u = 0; u < userCount; u++) {
    const likes = Array.from(
      { length: 1 + Math.floor(rand() * 3) },
      () => topics[Math.floor(rand() * topicCount)]!,
    );
    const affinity = (id: string) => Math.max(...likes.map((t) => dot(t, latent.get(id)!)));
    const pick = (weight: (id: string) => number, n: number, exclude: Set<string>) => {
      const out: string[] = [];
      while (out.length < n) {
        const item = items[Math.floor(rand() * itemCount)]!;
        if (!exclude.has(item.id) && rand() < weight(item.id)) {
          out.push(item.id);
          exclude.add(item.id);
        }
      }
      return out;
    };
    const seen = new Set<string>();
    // A history of 3 to 30 reads, mostly of liked topics.
    const history = pick(
      (id) => Math.max(0.02, affinity(id)) ** 2,
      3 + Math.floor(rand() * 28),
      seen,
    );
    const candidates = pick(() => 1, 20, seen);
    const clicked = new Set(
      candidates.filter((id) => rand() < sigmoid(6 * affinity(id) + 2 * pop.get(id)! - 5)),
    );
    if (clicked.size === 0 || clicked.size === candidates.length) continue;
    impressions.push({
      id: String(u),
      user: `u${u}`,
      at: start + 31 * day,
      history,
      candidates,
      clicked,
    });
  }

  const projection = (dims: number, noise: number, id: string): EmbeddingProvider => {
    const matrix = Array.from({ length: dims }, () => Array.from({ length: LATENT }, gauss));
    return {
      model: { id, revision: '1', nativeDims: dims, documentPrompt: '{title}' },
      embed: (inputs) =>
        Promise.resolve(
          inputs.map((itemId) => {
            const v = latent.get(itemId)!;
            return Float32Array.from(matrix, (row) => dot(row, v) + noise * gauss());
          }),
        ),
    };
  };
  return {
    name: `synthetic (${itemCount} items, ${topicCount} topics, ${impressions.length} impressions)`,
    items,
    impressions,
    providers: {
      a: projection(128, 0.8, 'synthetic/model-a'),
      b: projection(96, 1.2, 'synthetic/model-b'),
    },
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** A small seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
