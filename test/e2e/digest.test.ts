/**
 * "Since your last visit" in the demo: a first visit as of 15 September 2026, then a visit
 * today. The digest shows what was published in between, and the built-in Summarizer (faked
 * here: the test browsers have none) writes its summary.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { DESKTOP, assertNoLayoutShift, observeLayoutShifts, ready, serveDemo } from './site.ts';

const site = serveDemo();
const SEPT_15 = Date.parse('2026-09-15');

async function context(summarizer: boolean): Promise<BrowserContext> {
  const ctx = await site.browser.newContext(DESKTOP);
  await ctx.addInitScript(() => localStorage.setItem('hunch-demo-consent', 'yes'));
  if (summarizer) {
    await ctx.addInitScript(() => {
      (window as unknown as { Summarizer: unknown }).Summarizer = {
        availability: () => Promise.resolve('available'),
        create: () =>
          Promise.resolve({
            summarize: (text: string) =>
              Promise.resolve(`${text.split('\n').length} new articles while you were away.`),
            destroy() {},
          }),
      };
    });
  }
  return ctx;
}

async function digest(page: Page) {
  await ready(page, 'hunch-digest');
  return page.$eval('hunch-digest', (el) => ({
    new: (el as HTMLElement).dataset.hunchNew,
    summarized: (el as HTMLElement).dataset.hunchSummarized,
    summary: el.querySelector('[data-hunch-summary]')!.textContent,
    dates: [...el.querySelectorAll('[data-hunch-slot]:not([hidden]) time')].map((t) =>
      t.getAttribute('datetime'),
    ),
  }));
}

test('a returning visitor sees what was published since the last visit, summarized', async (t) => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/?as-of=2026-09-15`);
  const first = await digest(page);
  assert.equal(first.new, '0', 'a first visit has nothing new');
  assert.match(first.summary ?? '', /^The latest articles/);

  await observeLayoutShifts(page);
  await page.goto(`${site.origin}/`);
  const back = await digest(page);
  assert.equal(back.new, '3');
  // Every filled slot shows its date, and all of them are after the first visit.
  assert.equal(back.dates.length, Number(back.new));
  assert.ok(
    back.dates.every((d) => Date.parse(d!) > SEPT_15),
    back.dates.join(),
  );
  await page.waitForFunction(
    () => document.querySelector('hunch-digest')!.getAttribute('data-hunch-summarized') === 'true',
  );
  assert.equal(
    await page.locator('[data-hunch-summary]').textContent(),
    '3 new articles while you were away.',
  );
  await assertNoLayoutShift(t, page);
  await ctx.close();
});

test('without a built-in Summarizer the placeholder stays; without consent nothing changes', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/?as-of=2026-09-15`);
  await digest(page);
  await page.goto(`${site.origin}/`);
  const back = await digest(page);
  assert.equal(back.new, '3');
  assert.equal(back.summarized, 'false');
  assert.match(back.summary ?? '', /^The latest articles/);
  await ctx.close();

  const anonymous = await site.browser.newContext(DESKTOP);
  const other = await anonymous.newPage();
  await other.goto(`${site.origin}/?as-of=2026-09-15`);
  await digest(other);
  await other.goto(`${site.origin}/`);
  assert.equal((await digest(other)).new, '0');
  assert.deepEqual(await other.evaluate(() => indexedDB.databases()), []);
  await anonymous.close();
});
