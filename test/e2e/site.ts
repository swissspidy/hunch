/** The demo site, served for a browser test file, and helpers to look at its pages. */

import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { after, before, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright-core';
import type { Hunch, Signal } from '../../src/client/index.ts';
import { readShard, tempDir } from '../helpers.ts';

const ENGINES = { chromium, firefox, webkit };
type Engine = keyof typeof ENGINES;

/** The browser the tests run in: `HUNCH_BROWSER=chromium` (the default), `firefox` or `webkit`. */
export const BROWSER: Engine = (() => {
  const name = process.env.HUNCH_BROWSER || 'chromium';
  if (!(name in ENGINES)) {
    throw new Error(`HUNCH_BROWSER must be chromium, firefox or webkit, not ${name}`);
  }
  return name as Engine;
})();

/**
 * The Layout Instability API (`layout-shift` entries) is Chromium's only: elsewhere a test that
 * measures layout shift skips that check with this reason. The slots' boxes are still compared.
 */
const NO_LAYOUT_SHIFT_API =
  BROWSER === 'chromium' ? false : `${BROWSER} has no Layout Instability API (layout-shift)`;

export const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
// A mid-range phone's viewport, touch and pixel density.
export const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2.75,
  // Firefox has no mobile emulation (meta viewport): Playwright refuses `isMobile` there.
  ...(BROWSER === 'firefox' ? {} : { isMobile: true }),
  hasTouch: true,
};

export interface Site {
  origin: string;
  browser: Browser;
  /** The directory that is served. */
  dir: string;
}

/**
 * Builds the demo in a directory of its own and serves it, and launches the browser, for the
 * tests of the calling file.
 */
export function serveDemo(): Site {
  const site = { origin: '', browser: undefined as unknown as Browser, dir: '' };
  let server: ChildProcess | undefined;
  before(async () => {
    site.dir = await tempDir();
    const args = ['scripts/demo.ts', '--out', site.dir, '--serve', '--port', '0'];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    server = child;
    site.origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /serving (http:\/\/\S+)\//.exec(output);
        if (match) resolve(match[1]!);
      });
      child.on('exit', (code) => reject(new Error(`demo exited with ${code}:\n${output}`)));
    });
    site.browser = await ENGINES[BROWSER].launch();
  });
  after(async () => {
    await site.browser?.close();
    server?.kill();
  });
  return site;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

/**
 * Serves the directory that `prepare` returns (after building it, say) and launches the browser,
 * for the tests of the calling file. `/path/` serves `path/index.html`.
 */
export function serveDir(prepare: () => Promise<string>): Site {
  const site = { origin: '', browser: undefined as unknown as Browser, dir: '' };
  let server: Server | undefined;
  before(async () => {
    const root = resolve(await prepare());
    site.dir = root;
    server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
      if (!file.startsWith(root + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      readFile(file).then(
        (body) => {
          res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          });
          res.end(body);
        },
        () => {
          res.writeHead(404);
          res.end('Not found');
        },
      );
    });
    const listening = server;
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
    const address = listening.address();
    site.origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    site.browser = await ENGINES[BROWSER].launch();
  });
  after(async () => {
    await site.browser?.close();
    server?.close();
  });
  return site;
}

/** A browser context, closed when the test ends, however it ends. */
export async function newContext(
  t: TestContext,
  site: Site,
  options: BrowserContextOptions = DESKTOP,
): Promise<BrowserContext> {
  const ctx = await site.browser.newContext(options);
  t.after(() => ctx.close());
  return ctx;
}

/** A context for the demo, whose visitor has turned personalization on (`consent`) or has not. */
export async function context(
  t: TestContext,
  site: Site,
  consent: boolean,
  options: BrowserContextOptions = DESKTOP,
): Promise<BrowserContext> {
  const ctx = await newContext(t, site, options);
  if (consent) {
    await ctx.addInitScript(() => localStorage.setItem('hunch-demo-consent', 'yes'));
  }
  return ctx;
}

/** Three of the demo's Food articles: reading them makes a profile about food. */
export const FOOD = ['sourdough-starter', 'baguette-shaping', 'rye-bread'];

/** Opens the demo's home page and waits for its lists. */
export async function home(site: Site, page: Page, query = ''): Promise<void> {
  await page.goto(`${site.origin}/${query}`);
  await ready(page, 'hunch-for-you');
  await ready(page, 'hunch-digest');
}

/**
 * Holds the manifest back until the returned function is called, so a test can look at the
 * server-rendered fallback first and a fast fill can't race it.
 */
export async function holdManifest(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/hunch/manifest.json', (route) => gate.then(() => route.continue()));
  return release;
}

/** Sums layout shifts from the first paint on (call before navigating). Chromium only. */
export async function observeLayoutShifts(page: Page): Promise<void> {
  if (NO_LAYOUT_SHIFT_API) return;
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

/**
 * Asserts, as a subtest, that nothing shifted since `observeLayoutShifts`: skipped, with the
 * reason, where the browser can't measure it.
 */
export async function assertNoLayoutShift(t: TestContext, page: Page): Promise<void> {
  await t.test('no layout shift', { skip: NO_LAYOUT_SHIFT_API }, async () => {
    // A fixed wait: no event says that nothing more will shift, so late shifts get this long.
    await page.waitForTimeout(300);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    assert.equal(cls, 0);
  });
}

export interface SlotContent {
  id: string;
  title: string;
  href: string;
}

export function slots(page: Page, element: string): Promise<SlotContent[]> {
  return page.$$eval(`${element} [data-hunch-slot]`, (els) =>
    els.map((el) => ({
      id: (el as HTMLElement).dataset.hunchId ?? '',
      title: el.querySelector('[data-hunch-title]')?.textContent ?? '',
      href: el.querySelector('a')?.getAttribute('href') ?? '',
    })),
  );
}

export async function ready(page: Page, element: string): Promise<void> {
  await page.waitForSelector(`${element}[data-hunch-state="ready"]`, { timeout: 10_000 });
}

/**
 * Waits until `check` resolves to true, asking again every 50 ms. One deadline for the whole
 * wait, a check that never settles included.
 */
async function eventually(check: () => Promise<boolean>, timeout: number): Promise<void> {
  const end = Date.now() + timeout;
  const late = (): Error => new Error(`waitUntil: still false after ${timeout} ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), timeout);
  });
  try {
    for (;;) {
      const checked = check();
      checked.catch(() => {}); // Settled after the deadline: nobody awaits it any more.
      const result = await Promise.race([checked, deadline]);
      if (Date.now() >= end) throw late();
      if (result) return;
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), deadline]);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until `check`, which may be async, returns true in the page. Not page.waitForFunction:
 * it doesn't wait for a returned promise, which counts as true at once, so an async check never
 * waited for anything.
 */
export function waitUntil<A>(
  page: Page,
  check: (arg: A) => boolean | Promise<boolean>,
  arg: A,
  timeout = 10_000,
): Promise<void> {
  // The argument is plain JSON here, which Playwright's Unboxed<A> type can't see.
  return eventually(
    () => page.evaluate(check as (arg: unknown) => Promise<boolean>, arg as unknown),
    timeout,
  );
}

/** The demo's signals, read from IndexedDB as the page's shared client sees them. */
export function storedSignals(page: Page): Promise<Signal[]> {
  return page.evaluate(async () => {
    const { Hunch: Client } = window as unknown as { Hunch: typeof Hunch };
    return (await (await Client.shared(document.body.dataset.manifest!)).export()).signals;
  });
}

/** Waits until one of the stored signals matches. */
export function waitForSignal(page: Page, match: (signal: Signal) => boolean): Promise<void> {
  return eventually(async () => (await storedSignals(page)).some(match), 10_000);
}

/**
 * Visits an article and waits until its view is stored. Leaving a page aborts its pending
 * IndexedDB writes, and Firefox can still be opening the database when the list is ready.
 */
export async function read(site: Site, page: Page, id: string): Promise<void> {
  const since = Date.now();
  await page.goto(`${site.origin}/items/${id}.html`);
  await ready(page, 'hunch-related');
  // This visit's view, not an earlier signal for the item.
  await waitForSignal(page, (s) => s.itemId === id && s.kind === 'view' && s.at >= since);
}

/** What `hunch:click` says about a click on a slot. */
export interface Click {
  id: string;
  url: string;
  position: number;
  list: string;
  personalized: boolean;
}

/**
 * From now on a click on a link keeps the page (after the components have seen it), and the
 * returned function gives the last `hunch:click` the page's analytics would have got.
 */
export async function captureClicks(page: Page): Promise<() => Promise<Click | undefined>> {
  await page.evaluate(() => {
    document.addEventListener('click', (event) => event.preventDefault());
    document.addEventListener('hunch:click', (event) => {
      (window as unknown as { clicked: unknown }).clicked = (event as CustomEvent).detail;
    });
  });
  return () => page.evaluate(() => (window as unknown as { clicked?: Click }).clicked);
}

/** The article a search finds first after `routeFakeTransformers`. */
export const TARGET = 'cold-brew';

/**
 * A stand-in for Transformers.js, served for the CDN URL: its "model" returns the vector of
 * the `TARGET` article, so that article must come first in a search.
 */
async function fakeTransformers(site: Site): Promise<string> {
  const manifest = JSON.parse(await readFile(join(site.dir, 'hunch/manifest.json'), 'utf8'));
  const ref = manifest.shards.find((s: { section: string }) => s.section === 'Food');
  const shard = await readShard(join(site.dir, 'hunch', ref.url));
  const row = shard.items.findIndex((item) => item.id === TARGET);
  // The article's vector, padded to the model's 768 dims: truncation gives it back exactly.
  const vector = new Array(manifest.model.nativeDims).fill(0);
  for (let d = 0; d < shard.dims; d++)
    vector[d] = shard.vectors[row * shard.dims + d]! * shard.invNorms[row]!;
  return `
    export const env = {};
    export const AutoTokenizer = { from_pretrained: async () => (texts) => ({ texts }) };
    export const AutoModel = {
      from_pretrained: async (id, options) => {
        globalThis.__model = { id, ...options };
        const model = async (inputs) => {
          globalThis.__inputs = inputs.texts;
          return { sentence_embedding: { dims: [1, ${vector.length}], data: Float32Array.from(${JSON.stringify(vector)}) } };
        };
        return model;
      },
    };`;
}

/** Serves `fakeTransformers` to the page where it asks the CDN for Transformers.js. */
export async function routeFakeTransformers(site: Site, page: Page): Promise<void> {
  const fake = await fakeTransformers(site);
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: fake,
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
}

const AXE = fileURLToPath(import.meta.resolve('axe-core/axe.min.js'));

/** An axe-core rule the page breaks, and where. */
export interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

/** axe-core's WCAG 2.2 A/AA and best-practice rules over the whole page. */
export async function axe(page: Page): Promise<Violation[]> {
  // The slots' fade-in would read as low contrast: check the page as it settles.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const { violations, passes } = await (
      window as unknown as {
        axe: {
          run(
            context: Document,
            options: object,
          ): Promise<{ violations: Violation[]; passes: unknown[] }>;
        };
      }
    ).axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    if (passes.length < 10) throw new Error(`axe checked only ${passes.length} rules`);
    return violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target }) => ({ target })),
    }));
  });
}

export function assertClean(violations: Violation[], state: string): void {
  assert.deepEqual(
    violations,
    [],
    `${state}:\n${violations.map((v) => `${v.id} (${v.impact}): ${v.help} ${JSON.stringify(v.nodes.map((n) => n.target))}`).join('\n')}`,
  );
}
