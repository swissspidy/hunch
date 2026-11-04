/**
 * Milestone 1's acceptance test: the demo site, in Chromium. Related items are ranked in the
 * browser from the published vectors, no model is fetched, and the layout does not shift.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContextOptions, Page } from 'playwright-core';
import {
  DESKTOP,
  layoutShift,
  observeLayoutShifts,
  PHONE,
  ready as readyFor,
  serveDemo,
  slots as slotsOf,
} from './site.ts';

const site = serveDemo();

async function open(path: string, options: BrowserContextOptions = DESKTOP, gate?: Promise<void>) {
  const context = await site.browser.newContext(options);
  const page = await context.newPage();
  // Holds the manifest back until `gate` settles, so a test can see the fallback first.
  if (gate)
    await page.route('**/inkling/manifest.json', (route) => gate.then(() => route.continue()));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await observeLayoutShifts(page);
  await page.goto(`${site.origin}${path}`);
  return { page, requests, close: () => context.close() };
}

const slots = (page: Page) => slotsOf(page, 'inkling-related');
const ready = (page: Page) => readyFor(page, 'inkling-related');

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
    assert.equal(await layoutShift(page), 0);

    // No model: the page fetched the manifest and the vector shards, nothing else of Inkling's.
    const paths = requests.map((url) => new URL(url).pathname);
    assert.ok(
      requests.every((url) => url.startsWith(site.origin)),
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
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.route('**/inkling/manifest.json', (route) => route.fulfill({ status: 503 }));
  await page.goto(`${site.origin}/items/cold-brew.html`);
  const fallback = await slots(page);
  await page.waitForSelector('inkling-related[data-inkling-state="error"]');
  assert.deepEqual(await slots(page), fallback);
  await context.close();
});
