/**
 * Search in the demo: the query is embedded in the browser by the query module and ranked by
 * hunch.search(). Transformers.js is replaced by a fake module (no 200 MB download in CI)
 * whose "model" returns the vector of a known article, so that article must come first.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESKTOP, fakeTransformers, serveDemo, TARGET } from './site.ts';

const site = serveDemo();

test('a text search is embedded and ranked in the browser, and the query is not sent', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  const payloads: string[] = [];
  page.on('request', (r) => {
    requests.push(r.url());
    payloads.push(`${r.postData() ?? ''}\n${JSON.stringify(r.headers())}`);
  });
  const fake = await fakeTransformers();
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: fake,
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.goto(`${site.origin}/`);
  await page.waitForLoadState('networkidle');
  assert.ok(
    !requests.some((u) => u.includes('hunch-query.js') || u.includes('jsdelivr')),
    'nothing loads before a search',
  );

  await page.fill('input[name="q"]', 'something cold to drink');
  await page.click('#search button');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
  const first = await page.locator('#results li a').first().getAttribute('href');
  assert.equal(first, `/items/${TARGET}.html`);
  assert.match((await page.locator('#search-status').textContent()) ?? '', /Ranked on this device/);

  const model = await page.evaluate(() => (globalThis as unknown as { __model: unknown }).__model);
  assert.deepEqual(model, {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    dtype: 'q4',
    // Browsers can't run model_q4 (GatherBlockQuantized): the q4 file they can run.
    model_file_name: 'model_no_gather',
  });
  assert.deepEqual(
    await page.evaluate(() => (globalThis as unknown as { __inputs: unknown }).__inputs),
    ['task: search result | query: something cold to drink'],
  );
  // No request carries the query.
  assert.ok(
    !requests.some((u) => /cold|drink/.test(decodeURIComponent(u)) && !u.includes(TARGET)),
    requests.join('\n'),
  );
  assert.ok(!payloads.some((p) => /cold|drink/.test(p)), payloads.join('\n'));
  await context.close();
});
