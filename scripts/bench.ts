/**
 * `npm run bench`: shard sizes and ranking time for a synthetic catalog (ADR 0001's size
 * budget), in Node; with `--browser`, in Chromium with the CPU slowed 4× (DevTools' mid-range
 * mobile preset), IndexedDB signals included (ADR 0003).
 *
 * The browser run also counts long tasks (over 50 ms on the main thread) while a returning
 * visitor's page loads the catalog and ranks "for you" for the first time (ADR 0008).
 *
 *   node scripts/bench.ts [--items 10000[,50000,…]] [--dims 256] [--sections 10] [--browser]
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { Hunch, MemoryStore } from '../src/client/index.ts';
import type { Quantization } from '../src/format/manifest.ts';
import { bundleGlobal } from './bundle.ts';
import { syntheticCatalog, type SyntheticCatalog } from './synthetic.ts';

const { values } = parseArgs({
  options: {
    items: { type: 'string', default: '10000' },
    dims: { type: 'string', default: '256' },
    sections: { type: 'string', default: '10' },
    browser: { type: 'boolean', default: false },
  },
});
const counts = values.items.split(',').map(Number);
const dims = Number(values.dims);
const sections = Number(values.sections);
let count = 0;
// Every section has at least this many items; benchmark ids stay within them.
let perSection = 0;
/** The i-th benchmark item: sections in turn, so every id exists. */
const itemId = (i: number) => `s${i % sections}-item-${Math.floor(i / sections) % perSection}`;

for (count of counts) {
  if (!(Number.isInteger(count) && sections >= 1 && count >= sections)) {
    throw new RangeError(`--sections must be from 1 to --items (${count}), not ${values.sections}`);
  }
  perSection = Math.floor(count / sections);
  if (values.browser) await browser();
  else for (const q of ['int8', 'float32'] as Quantization[]) await node(q);
}

async function node(quantization: Quantization): Promise<void> {
  const catalog = await syntheticCatalog(count, dims, sections, quantization);
  const raw = [...catalog.files.values()].reduce((sum, b) => sum + b.length, 0);
  const gz = [...catalog.files.values()].reduce((sum, b) => sum + gzipSync(b).length, 0);
  const vectorBytes = count * dims * (quantization === 'int8' ? 1 : 4);
  const fetchFn = (input: string | URL) => {
    const path = new URL(input).pathname.slice(1);
    return Promise.resolve(
      path === 'manifest.json'
        ? new Response(JSON.stringify(catalog.manifest))
        : new Response(catalog.files.get(path)!.slice()),
    );
  };
  const store = new MemoryStore();
  const start = performance.now();
  const hunch = await Hunch.load({
    manifest: 'http://bench/manifest.json',
    fetch: fetchFn,
    consent: true,
    store,
  });
  await hunch.related('s0-item-0', { sections: 'same' });
  const firstSection = performance.now() - start;
  await hunch.related('s0-item-0');
  const allLoaded = performance.now() - start;
  const related = await time(20, (i) => hunch.related(itemId(i), { n: 10 }));
  for (let i = 0; i < 50; i++) await hunch.record('view', itemId(i * 7));
  const recommend = await time(20, () => hunch.recommend({ n: 10 }));
  const heap = process.memoryUsage();
  console.log(`${count} items, ${dims} dims, ${quantization}, ${shape(catalog)} (Node)`);
  console.log(
    `  shards       ${mb(raw)} (${mb(vectorBytes)} vectors, ${mb(raw - vectorBytes)} metadata), ${mb(gz)} gzipped`,
  );
  console.log(
    `  load         ${firstSection.toFixed(0)} ms first section, ${allLoaded.toFixed(0)} ms all`,
  );
  console.log(`  related()    ${related.toFixed(1)} ms over all items (n = 10)`);
  console.log(`  recommend()  ${recommend.toFixed(1)} ms with 50 signals (n = 10)`);
  console.log(
    `  memory       ${mb(heap.heapUsed + heap.arrayBuffers)} heap + array buffers (whole process)`,
  );
}

async function browser(): Promise<void> {
  const { chromium } = await import('playwright-core');
  const catalog: SyntheticCatalog = await syntheticCatalog(count, dims, sections, 'int8');
  const dir = await mkdtemp(join(tmpdir(), 'hunch-bench-'));
  const script = join(dir, 'hunch.js');
  await bundleGlobal(script);
  const bundle = await readFile(script);
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').slice(1);
    if (path === '') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><script src="/hunch.js"></script>');
    } else if (path === 'hunch.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
    } else if (path === 'manifest.json') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(catalog.manifest));
    } else {
      const file = catalog.files.get(path);
      res.writeHead(file ? 200 : 404).end(file);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const b = await chromium.launch();
  try {
    const page = await b.newPage();
    // Long tasks (> 50 ms on the main thread), from the first script on.
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: { start: number; duration: number }[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          w.__longTasks.push({ start: e.startTime, duration: e.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    });
    await page.goto(origin);
    // A returning visitor: 50 signals in IndexedDB from an earlier page.
    await page.evaluate(
      async ({ sections, perSection }) => {
        const id = (i: number) => `s${i % sections}-item-${Math.floor(i / sections) % perSection}`;
        const I = (window as unknown as { Hunch: typeof Hunch }).Hunch;
        const hunch = await I.load({ manifest: '/manifest.json', consent: true });
        for (let i = 0; i < 50; i++) await hunch.record('view', id(i * 7));
      },
      { sections, perSection },
    );
    await page.goto(origin);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    const result = await page.evaluate(
      async ({ sections, perSection }) => {
        // As itemId() below: an id that exists whatever the catalog's size.
        const id = (i: number) => `s${i % sections}-item-${Math.floor(i / sections) % perSection}`;
        const w = window as unknown as {
          Hunch: typeof Hunch;
          __longTasks: { start: number; duration: number }[];
        };
        const I = w.Hunch;
        // Load + first recommend(), as a returning visitor's "for you" would.
        const t0 = performance.now();
        const hunch = await I.load({ manifest: '/manifest.json', consent: true });
        await hunch.recommend({ n: 10 });
        const t1 = performance.now();
        const firstRecommend = t1 - t0;
        // Let the observer deliver the last entries.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const longTasks = w.__longTasks
          .filter((t) => t.start >= t0 && t.start < t1)
          .map((t) => t.duration);
        // The rest on a fresh client, so the first section's load is measured on its own.
        const t2 = performance.now();
        const fresh = await I.load({ manifest: '/manifest.json', consent: true });
        await fresh.related('s0-item-0', { sections: 'same' });
        const first = performance.now() - t2;
        await fresh.related('s0-item-0');
        const all = performance.now() - t2;
        const t3 = performance.now();
        for (let i = 0; i < 10; i++) await fresh.related(id(i), { n: 10 });
        const related = (performance.now() - t3) / 10;
        const t4 = performance.now();
        for (let i = 0; i < 10; i++) await fresh.recommend({ n: 10 });
        const recommend = (performance.now() - t4) / 10;
        await fresh.forget();
        return { firstRecommend, longTasks, first, all, related, recommend };
      },
      { sections, perSection },
    );
    const metrics = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
    console.log(`${count} items, ${dims} dims, int8, ${shape(catalog)} (Chromium, CPU 4× slower)`);
    console.log(
      `  load         ${result.first.toFixed(0)} ms first section, ${result.all.toFixed(0)} ms all (local server)`,
    );
    console.log(`  related()    ${result.related.toFixed(1)} ms over all items (n = 10)`);
    console.log(
      `  recommend()  ${result.recommend.toFixed(1)} ms with 50 IndexedDB signals (n = 10)`,
    );
    console.log(`  long tasks   ${longTaskSummary(result.firstRecommend, result.longTasks)}`);
    const heap = metrics.metrics.find((m: { name: string }) => m.name === 'JSHeapUsedSize');
    if (heap) console.log(`  JS heap      ${mb(heap.value)} used`);
  } finally {
    await b.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Long tasks during load + first recommend(): count, longest, and blocking time over 50 ms. */
function longTaskSummary(total: number, durations: number[]): string {
  const longest = durations.length ? Math.max(...durations) : 0;
  const blocking = durations.reduce((sum, d) => sum + d - 50, 0);
  return (
    `${durations.length} over 50 ms in load + first recommend() (${total.toFixed(0)} ms), ` +
    `longest ${longest.toFixed(0)} ms, ${blocking.toFixed(0)} ms blocking`
  );
}

/** "10 sections in 50 shards": how the synthetic catalog is cut. */
function shape(catalog: SyntheticCatalog): string {
  return `${sections} sections in ${catalog.manifest.shards.length} shards`;
}

async function time(runs: number, fn: (i: number) => Promise<unknown>): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < runs; i++) await fn(i);
  return (performance.now() - start) / runs;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
