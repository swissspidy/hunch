/**
 * The Astro integration in Chromium: the fixture site, built by `astro build` with the hash
 * provider and served as static files. The related list fills from the manifest the
 * integration wrote, at the URL it preset, with no layout shift.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture } from '../fixtures/astro/build.ts';
import { tempDir } from '../helpers.ts';
import {
  assertNoLayoutShift,
  DESKTOP,
  observeLayoutShifts,
  ready,
  serveDir,
  slots,
} from './site.ts';

const site = serveDir(async () => {
  const out = await tempDir();
  await buildFixture(out, { cacheDir: false, include: '/blog/**' });
  return out;
});

test('the related list fills in place from the integration’s manifest', async (t) => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await observeLayoutShifts(page);
  // Hold the manifest until the server-rendered fallback has been read, so a fast fill can't
  // race the snapshot.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/hunch/manifest.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`${site.origin}/blog/rye-bread/`);
  const fallback = await slots(page, 'hunch-related');
  const box = await page.locator('hunch-related').boundingBox();
  release();

  await ready(page, 'hunch-related');
  const related = await slots(page, 'hunch-related');
  assert.equal(related.length, 3);
  // The hash embedding is lexical: the other sourdough article is the closest.
  assert.equal(related[0]!.id, '/blog/sourdough/', JSON.stringify(related));
  assert.notDeepEqual(related, fallback);
  assert.ok(related.every((r) => r.href === r.id && r.id.startsWith('/blog/')));
  assert.ok(!related.some((r) => r.id === '/blog/rye-bread/'));
  assert.equal(related[0]!.title, 'Keeping a sourdough starter alive');
  assert.deepEqual(await page.locator('hunch-related').boundingBox(), box);
  await assertNoLayoutShift(t, page);
  assert.ok(requests.includes('/hunch/manifest.json'), requests.join('\n'));
  // Without consent, <hunch-page> stores nothing.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await context.close();
});

test('the site’s HunchConfig keeps its consent hook and gets the manifest', async () => {
  const context = await site.browser.newContext(DESKTOP);
  // As an inline script in the site's <head> would.
  await context.addInitScript(() => {
    (window as unknown as { HunchConfig: object }).HunchConfig = { consent: () => true };
  });
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  // Nothing stored before an article page is opened.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await page.goto(`${site.origin}/blog/rye-bread/`);
  await ready(page, 'hunch-related');
  // <hunch-page> has no manifest attribute either: it recorded the view, with consent.
  await page.waitForFunction(
    async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === 'hunch')) return false;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('hunch');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        if (!db.objectStoreNames.contains('signals')) return false;
        const signals = await new Promise<{ itemId: string; kind: string }[]>((resolve, reject) => {
          const all = db.transaction('signals').objectStore('signals').getAll();
          all.onsuccess = () => resolve(all.result as { itemId: string; kind: string }[]);
          all.onerror = () => reject(all.error);
        });
        return signals.some((s) => s.itemId === '/blog/rye-bread/' && s.kind === 'view');
      } finally {
        db.close();
      }
    },
    undefined,
    { timeout: 5000, polling: 100 },
  );
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { HunchConfig: { manifest: string } }).HunchConfig.manifest,
    ),
    '/hunch/manifest.json',
  );
  await context.close();
});

test('a manifest attribute wins over HunchConfig.manifest', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${site.origin}/blog/rye-bread/`);
  await ready(page, 'hunch-related');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<hunch-related id="other" manifest="/elsewhere/manifest.json" item="/blog/rye-bread/">
        <ol><li data-hunch-slot><a href="/"><span data-hunch-title>Fallback</span></a></li></ol>
      </hunch-related>`,
    );
  });
  await page.waitForSelector('#other[data-hunch-state="error"]', { timeout: 10_000 });
  assert.ok(requests.includes('/elsewhere/manifest.json'), requests.join('\n'));
  // Its fallback stays.
  assert.equal(await page.locator('#other [data-hunch-title]').textContent(), 'Fallback');
  await context.close();
});
