/**
 * A synthetic catalog for benchmarks: news-like metadata and random unit vectors (which
 * compress like real ones: barely), as the files a build would publish: a section's items in
 * hash buckets of at most `maxItems` (2,000, the build's default) and priors over a power of
 * two (ADR 0012), cut by the build's own functions.
 */

import {
  MANIFEST_FORMAT_VERSION,
  type Manifest,
  type Quantization,
} from '../src/format/manifest.ts';
import { encodeShard } from '../src/format/shard.ts';
import { bucketsOf, computePriors } from '../src/node/build.ts';
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
  // The whole catalog in its order, section after section: the priors count across all of it.
  const all = Array.from({ length: sections }, (_, s) => {
    const n = Math.floor(count / sections) + (s < count % sections ? 1 : 0);
    return Array.from({ length: n }, (_, i) => ({
      id: `s${s}-item-${i}`,
      url: `https://news.example/section-${s}/2026/11/a-typical-headline-slug-for-item-${i}/`,
      title: `A typical headline for item ${i} of section ${s}, about this long`,
      text: '',
      section: `section-${s}`,
      tags: ['politics', 'europe'],
      date: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
    }));
  });
  const priors = computePriors(all.flat());
  let first = 0;
  for (const [s, members] of all.entries()) {
    const items = members.map(({ text: _text, ...item }, i) => ({
      ...item,
      prior: priors[first + i]!,
    }));
    first += members.length;
    const vectors = new Map(
      items.map((item) => [item.id, normalize(Array.from({ length: dims }, random))]),
    );
    for (const [bucket, chunk] of bucketsOf(items, (item) => item.id, maxItems)) {
      const bytes = encodeShard(
        { space: 'bench', items: chunk },
        chunk.map((item) => vectors.get(item.id)!),
        dims,
        quantization,
      );
      const url = `shards/section-${s}${bucket === null ? '' : `-${bucket + 1}`}.hunch`;
      files.set(url, bytes);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      shards.push({
        url,
        section: `section-${s}`,
        count: chunk.length,
        bytes: bytes.length,
        sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    }
  }
  return {
    manifest: {
      format: 'hunch/manifest',
      formatVersion: MANIFEST_FORMAT_VERSION,
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
