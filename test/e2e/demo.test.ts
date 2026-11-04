/**
 * Milestone 1's acceptance test: the demo site, in Chromium. Related items are ranked in the
 * browser from the published vectors, no model is fetched, and the layout does not shift.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';

let server: ChildProcess;
let origin = '';
let browser: Browser;

before(async () => {
  server = spawn(process.execPath, ['scripts/demo.ts', '--serve', '--port', '0'], {
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    server.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /serving (http:\/\/\S+)\//.exec(output);
      if (match) resolve(match[1]!);
    });
    server.on('exit', (code) => reject(new Error(`demo exited with ${code}:\n${output}`)));
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
// A mid-range phone's viewport, touch and pixel density.
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2.75,
  isMobile: true,
  hasTouch: true,
};

async function open(path: string, options: BrowserContextOptions = DESKTOP, gate?: Promise<void>) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  // Holds the manifest back until `gate` settles, so a test can see the fallback first.
  if (gate)
    await page.route('**/inkling/manifest.json', (route) => gate.then(() => route.continue()));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  // Start observing layout shifts before anything renders.
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
  await page.goto(`${origin}${path}`);
  return { page, requests, close: () => context.close() };
}

async function slots(page: Page): Promise<{ id: string; title: string; href: string }[]> {
  return page.$$eval('inkling-related [data-inkling-slot]', (els) =>
    els.map((el) => ({
      id: (el as HTMLElement).dataset.inklingId ?? '',
      title: el.querySelector('[data-inkling-title]')?.textContent ?? '',
      href: el.querySelector('a')?.getAttribute('href') ?? '',
    })),
  );
}

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('inkling-related[data-inkling-state="ready"]', { timeout: 10_000 });
}

for (const [name, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`related items replace the fallback in place, with no layout shift (${name})`, async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { page, requests, close } = await open('/items/stargazing-atacama.html', options, gate);
    const fallback = await slots(page);
    const box = await page.locator('inkling-related').boundingBox();
    assert.ok(fallback.every((f) => f.href === `/items/${f.id}.html`));
    release();
    await ready(page);
    const related = await slots(page);
    assert.equal(related.length, fallback.length);
    // EmbeddingGemma's vectors put the dark-sky article first, from another section.
    assert.equal(related[0]!.id, 'dark-sky-reserves', JSON.stringify(related));
    assert.notDeepEqual(related, fallback);
    assert.ok(related.every((r) => r.href === `/items/${r.id}.html`));
    assert.ok(!related.some((r) => r.id === 'stargazing-atacama'));
    assert.deepEqual(await page.locator('inkling-related').boundingBox(), box);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => (window as unknown as { __cls: number }).__cls), 0);

    // No model: the page fetched the manifest and the vector shards, nothing else of Inkling's.
    const paths = requests.map((url) => new URL(url).pathname);
    assert.ok(
      requests.every((url) => url.startsWith(origin)),
      requests.join('\n'),
    );
    assert.ok(!paths.some((p) => /\.onnx|tokenizer|transformers/i.test(p)), paths.join('\n'));
    const inkling = paths
      .filter((p) => p.startsWith('/inkling/'))
      .map((p) => p.replace(/\.[0-9a-f]{12}\.ink$/, '.ink'));
    // The manifest, then the item's own section (the element's section hint), then the rest.
    assert.deepEqual(inkling.slice(0, 2), ['/inkling/manifest.json', '/inkling/shards/travel.ink']);
    assert.deepEqual(inkling.slice(2).sort(), [
      '/inkling/shards/food.ink',
      '/inkling/shards/science.ink',
      '/inkling/shards/technology.ink',
    ]);
    await close();
  });
}

test('the explanation lists each item’s similarity', async () => {
  const { page, close } = await open('/items/cold-brew.html');
  await ready(page);
  const why = await page.locator('#why-list li').allTextContents();
  assert.equal(why.length, 4);
  assert.match(
    why[0]!,
    /^The chemistry of roasting coffee beans: similarity 0\.\d\d, recency 0\.\d\d$/,
  );
  await close();
});

test('no animation when the visitor prefers reduced motion', async () => {
  const { page, close } = await open('/items/cold-brew.html', {
    ...DESKTOP,
    reducedMotion: 'reduce',
  });
  await ready(page);
  const animations = await page.evaluate(() => document.getAnimations().length);
  assert.equal(animations, 0);
  await close();
});

test('the server-rendered fallback stays when the manifest cannot load', async () => {
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.route('**/inkling/manifest.json', (route) => route.fulfill({ status: 503 }));
  await page.goto(`${origin}/items/cold-brew.html`);
  const fallback = await slots(page);
  await page.waitForSelector('inkling-related[data-inkling-state="error"]');
  assert.deepEqual(await slots(page), fallback);
  await context.close();
});
