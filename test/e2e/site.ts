/** The demo site, served for a browser test file, and helpers to look at its pages. */

import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { after, before, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from 'playwright-core';
import { decodeShard } from '../../src/format/shard.ts';

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
export const NO_LAYOUT_SHIFT_API =
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
}

/** Builds and serves the demo, and launches the browser, for the tests of the calling file. */
export function serveDemo(): Site {
  const site = { origin: '', browser: undefined as unknown as Browser };
  let server: ChildProcess | undefined;
  before(async () => {
    const child = spawn(process.execPath, ['scripts/demo.ts', '--serve', '--port', '0'], {
      stdio: ['ignore', 'inherit', 'pipe'],
    });
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
  const site = { origin: '', browser: undefined as unknown as Browser };
  let server: Server | undefined;
  before(async () => {
    const root = resolve(await prepare());
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
 * Visits an article and waits until its view is stored. Leaving a page aborts its pending
 * IndexedDB writes, and Firefox can still be opening the database when the list is ready.
 */
/**
 * Waits until `check`, which may be async, returns true in the page. Not page.waitForFunction:
 * it doesn't wait for a returned promise, which counts as true at once, so an async check never
 * waited for anything.
 */
export async function waitUntil<A>(
  page: Page,
  check: (arg: A) => boolean | Promise<boolean>,
  arg: A,
  timeout = 10_000,
): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    // The argument is plain JSON here, which Playwright's Unboxed<A> type can't see.
    if (await page.evaluate(check as (arg: unknown) => Promise<boolean>, arg as unknown)) return;
    if (Date.now() > end) throw new Error(`waitUntil: still false after ${timeout} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function read(site: Site, page: Page, id: string): Promise<void> {
  const since = Date.now();
  await page.goto(`${site.origin}/items/${id}.html`);
  await ready(page, 'hunch-related');
  await waitUntil(
    page,
    async (item) => {
      const hunch = await (
        window as unknown as {
          Hunch: {
            shared(m: string): Promise<{
              export(): Promise<{ signals: { itemId: string; kind: string; at: number }[] }>;
            }>;
          };
        }
      ).Hunch.shared(document.body.dataset.manifest!);
      // This visit's view, not an earlier signal for the item.
      return (await hunch.export()).signals.some(
        (s) => s.itemId === item.id && s.kind === 'view' && s.at >= item.since,
      );
    },
    { id, since },
  );
}

/** The article a search with `fakeTransformers` finds first. */
export const TARGET = 'cold-brew';

/**
 * A stand-in for Transformers.js, served for the CDN URL: its "model" returns the vector of
 * the `TARGET` article, so that article must come first in a search.
 */
export async function fakeTransformers(): Promise<string> {
  const manifest = JSON.parse(await readFile('demo/dist/hunch/manifest.json', 'utf8'));
  const ref = manifest.shards.find((s: { section: string }) => s.section === 'Food');
  const shard = decodeShard(new Uint8Array(await readFile(`demo/dist/hunch/${ref.url}`)).buffer);
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
