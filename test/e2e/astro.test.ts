/**
 * The Astro integration in Chromium: the fixture site, built by `astro build` with the hash
 * provider and served as static files. The related list fills from the manifest the
 * integration wrote, at the URL it preset, with no layout shift.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture } from '../fixtures/astro/build.ts';
import { tempDir } from '../helpers.ts';
import { DESKTOP, layoutShift, observeLayoutShifts, ready, serveDir, slots } from './site.ts';

const site = serveDir(async () => {
  const out = await tempDir();
  await buildFixture(out, { cacheDir: false, include: '/blog/**' });
  return out;
});

test('the related list fills in place from the integration’s manifest', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await observeLayoutShifts(page);
  // Hold the manifest until the server-rendered fallback has been read, so a fast fill can't
  // race the snapshot.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/inkling/manifest.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`${site.origin}/blog/rye-bread/`);
  const fallback = await slots(page, 'inkling-related');
  const box = await page.locator('inkling-related').boundingBox();
  release();

  await ready(page, 'inkling-related');
  const related = await slots(page, 'inkling-related');
  assert.equal(related.length, 3);
  // The hash embedding is lexical: the other sourdough article is the closest.
  assert.equal(related[0]!.id, '/blog/sourdough/', JSON.stringify(related));
  assert.notDeepEqual(related, fallback);
  assert.ok(related.every((r) => r.href === r.id && r.id.startsWith('/blog/')));
  assert.ok(!related.some((r) => r.id === '/blog/rye-bread/'));
  assert.equal(related[0]!.title, 'Keeping a sourdough starter alive');
  assert.deepEqual(await page.locator('inkling-related').boundingBox(), box);
  await page.waitForTimeout(300);
  assert.equal(await layoutShift(page), 0);
  assert.ok(requests.includes('/inkling/manifest.json'), requests.join('\n'));
  // Without consent, <inkling-page> stores nothing.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await context.close();
});

test('the site’s InklingConfig keeps its consent hook and gets the manifest', async () => {
  const context = await site.browser.newContext(DESKTOP);
  // As an inline script in the site's <head> would.
  await context.addInitScript(() => {
    (window as unknown as { InklingConfig: object }).InklingConfig = { consent: () => true };
  });
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  // Nothing stored before an article page is opened.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await page.goto(`${site.origin}/blog/rye-bread/`);
  await ready(page, 'inkling-related');
  // <inkling-page> has no manifest attribute either: it recorded the view, with consent.
  await page.waitForFunction(
    async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === 'inkling')) return false;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('inkling');
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
      () => (window as unknown as { InklingConfig: { manifest: string } }).InklingConfig.manifest,
    ),
    '/inkling/manifest.json',
  );
  await context.close();
});

test('a manifest attribute wins over InklingConfig.manifest', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${site.origin}/blog/rye-bread/`);
  await ready(page, 'inkling-related');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<inkling-related id="other" manifest="/elsewhere/manifest.json" item="/blog/rye-bread/">
        <ol><li data-inkling-slot><a href="/"><span data-inkling-title>Fallback</span></a></li></ol>
      </inkling-related>`,
    );
  });
  await page.waitForSelector('#other[data-inkling-state="error"]', { timeout: 10_000 });
  assert.ok(requests.includes('/elsewhere/manifest.json'), requests.join('\n'));
  // Its fallback stays.
  assert.equal(await page.locator('#other [data-inkling-title]').textContent(), 'Fallback');
  await context.close();
});
