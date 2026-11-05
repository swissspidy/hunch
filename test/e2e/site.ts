/** The demo site, served for a browser test file, and helpers to look at its pages. */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { after, before } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';

export const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
// A mid-range phone's viewport, touch and pixel density.
export const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2.75,
  isMobile: true,
  hasTouch: true,
};

export interface Site {
  origin: string;
  browser: Browser;
}

/** Builds and serves the demo, and launches Chromium, for the tests of the calling file. */
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
    site.browser = await chromium.launch();
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
 * Serves the directory that `prepare` returns (after building it, say) and launches Chromium,
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
    site.browser = await chromium.launch();
  });
  after(async () => {
    await site.browser?.close();
    server?.close();
  });
  return site;
}

/** Sums layout shifts from the first paint on (call before navigating). */
export async function observeLayoutShifts(page: Page): Promise<void> {
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

export function layoutShift(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

export interface SlotContent {
  id: string;
  title: string;
  href: string;
}

export function slots(page: Page, element: string): Promise<SlotContent[]> {
  return page.$$eval(`${element} [data-inkling-slot]`, (els) =>
    els.map((el) => ({
      id: (el as HTMLElement).dataset.inklingId ?? '',
      title: el.querySelector('[data-inkling-title]')?.textContent ?? '',
      href: el.querySelector('a')?.getAttribute('href') ?? '',
    })),
  );
}

export async function ready(page: Page, element: string): Promise<void> {
  await page.waitForSelector(`${element}[data-inkling-state="ready"]`, { timeout: 10_000 });
}
