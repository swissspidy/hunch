/**
 * `npm run bench`: shard sizes and `related()` time for a synthetic catalog (ADR 0001's size
 * budget). Vectors are random unit vectors (they compress like real ones: barely), metadata
 * looks like a news site's.
 *
 *   node scripts/bench.ts [--items 10000] [--dims 256] [--sections 10]
 */

import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { Inkling } from '../src/client/index.ts';
import type { Manifest, Quantization } from '../src/format/manifest.ts';
import { encodeShard } from '../src/format/shard.ts';
import { normalize } from '../src/rank/vector.ts';

const { values } = parseArgs({
  options: {
    items: { type: 'string', default: '10000' },
    dims: { type: 'string', default: '256' },
    sections: { type: 'string', default: '10' },
  },
});
const count = Number(values.items);
const dims = Number(values.dims);
const sectionCount = Number(values.sections);

let seed = 42;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

for (const quantization of ['int8', 'float32'] as Quantization[]) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const shards: Manifest['shards'] = [];
  let raw = 0;
  let gz = 0;
  for (let s = 0; s < sectionCount; s++) {
    const n = Math.floor(count / sectionCount) + (s < count % sectionCount ? 1 : 0);
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
    const bytes = encodeShard({ space: 'bench', items }, vectors, dims, quantization);
    const url = `shards/section-${s}.ink`;
    files.set(`/${url}`, bytes);
    raw += bytes.length;
    gz += gzipSync(bytes).length;
    shards.push({
      url,
      section: `section-${s}`,
      count: n,
      bytes: bytes.length,
      sha256: await sha256(bytes),
    });
  }
  const manifest: Manifest = {
    format: 'inkling/manifest',
    formatVersion: 1,
    version: 'bench',
    generatedAt: new Date(0).toISOString(),
    space: 'bench',
    model: { id: 'bench', revision: '0', nativeDims: dims, documentPrompt: '' },
    dims,
    quantization,
    count,
    sections: shards.map((s) => s.section!),
    shards,
  };
  const vectorBytes = count * dims * (quantization === 'int8' ? 1 : 4);
  const fetchFn = async (input: string | URL) => {
    const path = new URL(input).pathname;
    if (path === '/manifest.json') return new Response(JSON.stringify(manifest));
    return new Response(files.get(path)!.slice());
  };

  const loadStart = performance.now();
  const ink = await Inkling.load({ manifest: 'http://bench/manifest.json', fetch: fetchFn });
  await ink.related('s0-item-0', { sections: 'same' });
  const firstSection = performance.now() - loadStart;
  await ink.related('s0-item-0');
  const allLoaded = performance.now() - loadStart;
  const runs = 20;
  const start = performance.now();
  for (let i = 0; i < runs; i++) await ink.related(`s${i % sectionCount}-item-${i}`, { n: 10 });
  const perQuery = (performance.now() - start) / runs;
  const heap = process.memoryUsage();

  console.log(`${count} items, ${dims} dims, ${quantization}, ${sectionCount} shards`);
  console.log(
    `  shards     ${mb(raw)} (${mb(vectorBytes)} vectors, ${mb(raw - vectorBytes)} metadata), ${mb(gz)} gzipped`,
  );
  console.log(
    `  load       ${firstSection.toFixed(0)} ms first section, ${allLoaded.toFixed(0)} ms all (decode + norms)`,
  );
  console.log(`  related()  ${perQuery.toFixed(1)} ms over all ${count} items (n = 10, MMR)`);
  console.log(
    `  memory     ${mb(heap.heapUsed + heap.arrayBuffers)} heap + array buffers (whole process)`,
  );
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
