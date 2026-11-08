/**
 * The front page of the GitHub Pages site (site/): accessible, readable at phone width, and
 * loading nothing but its own files, as a page about a privacy-first project should.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertClean, axe, DESKTOP, PHONE, serveDir } from './site.ts';

const site = serveDir(() => Promise.resolve('site'));

for (const [name, options] of [
  ['desktop, light', { ...DESKTOP, colorScheme: 'light' }],
  ['desktop, dark', { ...DESKTOP, colorScheme: 'dark' }],
  ['phone', PHONE],
] as const) {
  test(`the front page passes axe (${name})`, async () => {
    const context = await site.browser.newContext(options);
    const page = await context.newPage();
    await page.goto(`${site.origin}/`);
    assertClean(await axe(page), name);
    await context.close();
  });
}

test('the front page loads only its own files and stores nothing', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every((url) => url.startsWith(site.origin)),
    requests.filter((url) => !url.startsWith(site.origin)).join('\n'),
  );
  assert.deepEqual(
    await page.evaluate(async () => [
      document.cookie,
      localStorage.length,
      (await indexedDB.databases()).length,
    ]),
    ['', 0, 0],
  );
  await context.close();
});

test('the front page fits a phone screen and links to the demos, the plugin and the API reference', async () => {
  const context = await site.browser.newContext(PHONE);
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  const [scrollWidth, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  assert.ok(scrollWidth <= width, `${scrollWidth} > ${width}`);
  const hrefs = await page.$$eval('a', (as) => as.map((a) => a.getAttribute('href')));
  for (const href of [
    'demo/',
    'api/',
    'wordpress/hunch.zip',
    'wordpress/playground.html',
    'https://github.com/swissspidy/hunch',
  ]) {
    assert.ok(hrefs.includes(href), href);
  }
  await context.close();
});
