/** The demo site, served for a browser test file, and helpers to look at its pages. */

import { spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, type TestContext } from 'node:test';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from 'playwright-core';

const ENGINES = { chromium, firefox, webkit };
type Engine = keyof typeof ENGINES;

/** The browser the tests run in: `INKLING_BROWSER=chromium` (the default), `firefox` or `webkit`. */
export const BROWSER: Engine = (() => {
  const name = process.env.INKLING_BROWSER || 'chromium';
  if (!(name in ENGINES)) {
    throw new Error(`INKLING_BROWSER must be chromium, firefox or webkit, not ${name}`);
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
