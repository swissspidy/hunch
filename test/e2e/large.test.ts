/**
 * A large catalog in Chromium (ADR 0008): 50,000 items, the CPU slowed 4× like the browser
 * benchmark, and no task of 100 ms or more while the shards load or while recommend() ranks
 * them, with `scheduler.yield()` and without it, with the WebAssembly kernel and the JavaScript
 * one.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Hunch } from '../../src/client/index.ts';
import { bundleGlobal } from '../../scripts/bundle.ts';
import { syntheticCatalog } from '../../scripts/synthetic.ts';
import { tempDir } from '../helpers.ts';
import { BROWSER } from './site.ts';

// CPU throttling goes through the Chrome DevTools Protocol, and long tasks are Chromium's only.
const SKIP =
  BROWSER === 'chromium' ? false : `CPU throttling and long tasks need Chromium, not ${BROWSER}`;

const ITEMS = 50_000;
const SECTIONS = 10;
/** What makes a task "long": the Long Tasks API reports nothing shorter. */
const LONG_TASK_MS = 50;
/**
 * The longest task allowed while loading or ranking: twice a long task, which leaves room for a
 * busy CI machine. One recommend() over the 50,000 items takes 45 to 60 ms here with the
 * WebAssembly kernel, too close to a long task for the observer to tell one task from slices,
 * and 100 to 200 ms with the JavaScript kernel, sliced or in one task: that run is the one
 * that shows the slicing.
 */
const LONGEST_MS = 100;

let origin = '';
let server: Server;
let browser: Browser;

before(async () => {
  if (SKIP) return;
  const catalog = await syntheticCatalog(ITEMS, 256, SECTIONS, 'int8');
  const dir = await tempDir();
  await bundleGlobal(join(dir, 'hunch.js'));
  const bundle = await readFile(join(dir, 'hunch.js'));
  server = createServer((req, res) => {
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
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  // A first page, so the browser's own start-up work is not timed with the first test.
  const warmUp = await browser.newPage();
  await warmUp.goto(origin);
  await warmUp.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

type Kernel = 'wasm' | 'js';

interface Run {
  /** The kernel that ran, which is the one asked for. */
  kernel: Kernel;
  ids: string[];
  duration: number;
  longTasks: number[];
  /** Load, 50 signals and a first recommend(): every shard verified, decoded and indexed. */
  loadDuration: number;
  loadLongTasks: number[];
  yields: boolean;
}

/**
 * With the CPU slowed 4× throughout: loads the catalog, records 50 signals and ranks once
 * (timed as the load), then times one more recommend() on its own.
 */
async function recommendOnce(page: Page, kernel: Kernel): Promise<Run> {
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    const load = await page.evaluate(
      async ({ sections, kernel }) => {
        const w = window as unknown as {
          Hunch: typeof Hunch;
          hunch: Hunch;
          __longTasks: { start: number; duration: number }[];
        };
        const t0 = performance.now();
        w.hunch = await w.Hunch.load({ manifest: '/manifest.json', consent: true, kernel });
        for (let i = 0; i < 50; i++) await w.hunch.record('view', `s${i % sections}-item-${i * 7}`);
        // Every shard and the profile, so what follows is ranking alone.
        await w.hunch.recommend({ n: 10 });
        const t1 = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          loadDuration: t1 - t0,
          loadLongTasks: w.__longTasks
            .filter((t) => t.start + t.duration > t0 && t.start < t1)
            .map((t) => t.duration),
        };
      },
      { sections: SECTIONS, kernel },
    );
    return await page
      .evaluate(async () => {
        const w = window as unknown as {
          hunch: Hunch;
          __longTasks: { start: number; duration: number }[];
        };
        const t0 = performance.now();
        const recs = await w.hunch.recommend({ n: 10 });
        const t1 = performance.now();
        // Let the observer deliver the last entries.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await w.hunch.forget();
        return {
          kernel: w.hunch.kernel,
          ids: recs.map((r) => r.id),
          duration: t1 - t0,
          longTasks: w.__longTasks
            .filter((t) => t.start + t.duration > t0 && t.start < t1)
            .map((t) => t.duration),
          yields: typeof (window as { scheduler?: { yield?: unknown } }).scheduler?.yield,
        };
      })
      .then((r) => ({ ...r, ...load, yields: r.yields === 'function' }));
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

/** Asserts that neither the load nor recommend() had a task of `LONGEST_MS` or more. */
function check(t: TestContext, run: Run): void {
  const list = (tasks: number[]) => tasks.map((d) => d.toFixed(0)).join(', ') || 'none';
  const loadDetail = `load took ${run.loadDuration.toFixed(0)} ms, long tasks: ${list(run.loadLongTasks)}`;
  const detail = `recommend() took ${run.duration.toFixed(0)} ms, long tasks: ${list(run.longTasks)}`;
  t.diagnostic(loadDetail);
  t.diagnostic(detail);
  assert.ok(Math.max(0, ...run.loadLongTasks) < LONGEST_MS, loadDetail);
  const longest = Math.max(0, ...run.longTasks);
  assert.equal(run.ids.length, 10);
  assert.ok(longest < LONGEST_MS, detail);
  // Relative to the work: a ranking that ran as one task would be one task as long as itself.
  assert.ok(longest < run.duration / 2, detail);
  if (run.kernel === 'js') {
    // And the work is a long task's worth: in one task the observer would have reported it, so
    // the two checks above pass only because the ranking was sliced.
    assert.ok(
      run.duration >= LONG_TASK_MS,
      `${detail}: too short to show slicing, rank more items or slow the CPU further`,
    );
  }
}

for (const kernel of ['wasm', 'js'] as const) {
  test(
    `50,000 items: recommend() leaves no long task, with scheduler.yield() (${kernel} kernel)`,
    { skip: SKIP },
    async (t) => {
      const page = await browser.newPage();
      try {
        const run = await recommendOnce(page, kernel);
        assert.equal(run.kernel, kernel);
        assert.equal(run.yields, true);
        check(t, run);
      } finally {
        await page.close();
      }
    },
  );

  test(
    `50,000 items: recommend() leaves no long task without scheduler.yield() (${kernel} kernel)`,
    { skip: SKIP },
    async (t) => {
      const page = await browser.newPage();
      try {
        await page.addInitScript(() => {
          Object.defineProperty(window, 'scheduler', { value: undefined, configurable: true });
        });
        const run = await recommendOnce(page, kernel);
        assert.equal(run.kernel, kernel);
        assert.equal(run.yields, false);
        check(t, run);
      } finally {
        await page.close();
      }
    },
  );
}
