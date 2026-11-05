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
  await page.goto(`${site.origin}/blog/rye-bread/`);
  const fallback = await slots(page, 'inkling-related');
  const box = await page.locator('inkling-related').boundingBox();

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
  await page.goto(`${site.origin}/blog/rye-bread/`);
  await ready(page, 'inkling-related');
  // <inkling-page> has no manifest attribute either: it recorded the view, with consent.
  await page.waitForFunction(
    async () => (await indexedDB.databases()).some((db) => db.name === 'inkling'),
    undefined,
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { InklingConfig: { manifest: string } }).InklingConfig.manifest,
    ),
    '/inkling/manifest.json',
  );
  await context.close();
});
