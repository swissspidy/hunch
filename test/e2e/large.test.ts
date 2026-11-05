/**
 * A large catalog in Chromium (ADR 0008): 50,000 items, the CPU slowed 4× like the browser
 * benchmark, and no task of 100 ms or more while the shards load or while recommend() ranks
 * them, with `scheduler.yield()` and without it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Inkling } from '../../src/client/index.ts';
import { bundleGlobal } from '../../scripts/bundle.ts';
import { syntheticCatalog } from '../../scripts/synthetic.ts';
import { BROWSER } from './site.ts';

// CPU throttling goes through the Chrome DevTools Protocol, and long tasks are Chromium's only.
const SKIP =
  BROWSER === 'chromium' ? false : `CPU throttling and long tasks need Chromium, not ${BROWSER}`;

const ITEMS = 50_000;
const SECTIONS = 10;
/**
 * The longest task allowed while ranking: twice the 50 ms that makes a task "long", which
 * leaves room for a busy CI machine. Ranking 50,000 items in one task takes about 400 ms here.
 */
const LONGEST_MS = 100;

let origin = '';
let server: Server;
let browser: Browser;
let dir = '';

before(async () => {
  if (SKIP) return;
  const catalog = await syntheticCatalog(ITEMS, 256, SECTIONS, 'int8');
  dir = await mkdtemp(join(tmpdir(), 'inkling-large-'));
  await bundleGlobal(join(dir, 'inkling.js'));
  const bundle = await readFile(join(dir, 'inkling.js'));
  server = createServer((req, res) => {
    const path = (req.url ?? '/').slice(1);
    if (path === '') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><script src="/inkling.js"></script>');
    } else if (path === 'inkling.js') {
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
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface Run {
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
async function recommendOnce(page: Page): Promise<Run> {
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
    const load = await page.evaluate(async (sections) => {
      const w = window as unknown as {
        Inkling: typeof Inkling;
        ink: Inkling;
        __longTasks: { start: number; duration: number }[];
      };
      const t0 = performance.now();
      w.ink = await w.Inkling.load({ manifest: '/manifest.json', consent: true });
      for (let i = 0; i < 50; i++) await w.ink.record('view', `s${i % sections}-item-${i * 7}`);
      // Every shard and the profile, so what follows is ranking alone.
      await w.ink.recommend({ n: 10 });
      const t1 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        loadDuration: t1 - t0,
        loadLongTasks: w.__longTasks
          .filter((t) => t.start + t.duration > t0 && t.start < t1)
          .map((t) => t.duration),
      };
    }, SECTIONS);
    return await page
      .evaluate(async () => {
        const w = window as unknown as {
          ink: Inkling;
          __longTasks: { start: number; duration: number }[];
        };
        const t0 = performance.now();
        const recs = await w.ink.recommend({ n: 10 });
        const t1 = performance.now();
        // Let the observer deliver the last entries.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await w.ink.forget();
        return {
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
}

test(
  '50,000 items: recommend() leaves no long task, with scheduler.yield()',
  { skip: SKIP },
  async (t) => {
    const page = await browser.newPage();
    try {
      const run = await recommendOnce(page);
      assert.equal(run.yields, true);
      check(t, run);
    } finally {
      await page.close();
    }
  },
);

test(
  '50,000 items: recommend() leaves no long task without scheduler.yield()',
  { skip: SKIP },
  async (t) => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'scheduler', { value: undefined, configurable: true });
      });
      const run = await recommendOnce(page);
      assert.equal(run.yields, false);
      check(t, run);
    } finally {
      await page.close();
    }
  },
);
