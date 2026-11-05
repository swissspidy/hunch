/**
 * A synthetic catalog for benchmarks: news-like metadata and random unit vectors (which
 * compress like real ones: barely), as the files a build would publish: one shard per section,
 * split at `maxItems` (2,000, the build's default).
 */

import type { Manifest, Quantization } from '../src/format/manifest.ts';
import { encodeShard } from '../src/format/shard.ts';
import { normalize } from '../src/rank/vector.ts';

export interface SyntheticCatalog {
  manifest: Manifest;
  /** Published path (`shards/…`) to bytes. */
  files: Map<string, Uint8Array<ArrayBuffer>>;
}

export async function syntheticCatalog(
  count: number,
  dims: number,
  sections: number,
  quantization: Quantization,
  maxItems = 2000,
): Promise<SyntheticCatalog> {
  for (const [name, value] of Object.entries({ count, dims, sections })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer, not ${value}`);
    }
  }
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const shards: Manifest['shards'] = [];
  for (let s = 0; s < sections; s++) {
    const n = Math.floor(count / sections) + (s < count % sections ? 1 : 0);
    const items = Array.from({ length: n }, (_, i) => ({
      id: `s${s}-item-${i}`,
      url: `https://news.example/section-${s}/2026/11/a-typical-headline-slug-for-item-${i}/`,
      title: `A typical headline for item ${i} of section ${s}, about this long`,
      section: `section-${s}`,
      tags: ['politics', 'europe'],
      date: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      prior: (n - i) / n,
    }));
    const vectors = items.map(() => normalize(Array.from({ length: dims }, random)));
    for (let start = 0, part = 1; start < n; start += maxItems, part++) {
      const bytes = encodeShard(
        { space: 'bench', items: items.slice(start, start + maxItems) },
        vectors.slice(start, start + maxItems),
        dims,
        quantization,
      );
      const url = `shards/section-${s}${n > maxItems ? `-${part}` : ''}.ink`;
      files.set(url, bytes);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      shards.push({
        url,
        section: `section-${s}`,
        count: Math.min(maxItems, n - start),
        bytes: bytes.length,
        sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    }
  }
  return {
    manifest: {
      format: 'inkling/manifest',
      formatVersion: 1,
      version: 'bench',
      generatedAt: new Date(0).toISOString(),
      space: 'bench',
      model: { id: 'bench', revision: '0', nativeDims: dims, documentPrompt: '' },
      dims,
      quantization,
      count,
      sections: Array.from({ length: sections }, (_, s) => `section-${s}`),
      shards,
    },
    files,
  };
}
