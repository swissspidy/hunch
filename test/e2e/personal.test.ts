/**
 * Milestone 2's acceptance test, in a browser: signals are recorded only with consent, "for you"
 * follows what the visitor reads, the visitor's controls work, and the layout does not shift.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Hunch } from '../../src/client/index.ts';
import { loadSource } from '../../src/node/sources/index.ts';
import {
  assertNoLayoutShift,
  captureClicks,
  context,
  DESKTOP,
  FOOD,
  home,
  observeLayoutShifts,
  PHONE,
  read,
  ready,
  serveDemo,
  slots,
  storedSignals,
  waitForSignal,
} from './site.ts';

const site = serveDemo();

async function visit(page: Page, id: string): Promise<void> {
  await page.goto(`${site.origin}/items/${id}.html`);
  await ready(page, 'hunch-related');
}

test('without consent nothing is stored and "for you" is the editors’ order', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await visit(page, FOOD[0]!);
  await page.click('[data-signal="follow"]');
  assert.match((await page.locator('#feedback').textContent()) ?? '', /Turn on personalization/);
  await home(site, page);
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'false');
  // The editors' order: the feed's first items, as the demo renders them (scripts/demo.ts).
  const editorial = (await loadSource('demo/feed.xml')).slice(0, 4).map((item) => item.id);
  assert.deepEqual(
    (await slots(page, 'hunch-for-you')).map((s) => s.id),
    editorial,
  );
  // Not even an empty database was created.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
});

for (const [name, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`reading food articles makes "for you" about food, without layout shift (${name})`, async (t) => {
    const ctx = await context(t, site, true, options);
    const page = await ctx.newPage();
    for (const id of FOOD) await read(site, page, id);
    const signals = await storedSignals(page);
    assert.deepEqual(
      signals.filter((s) => s.kind === 'view').map((s) => s.itemId),
      FOOD,
    );

    await observeLayoutShifts(page);
    await home(site, page);
    assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'true');
    const recs = await slots(page, 'hunch-for-you');
    assert.equal(recs.length, 4);
    assert.ok(!recs.some((r) => FOOD.includes(r.id)), 'already read');
    const sections = await page.$$eval('hunch-for-you [data-hunch-section]', (els) =>
      els.map((el) => el.textContent),
    );
    assert.ok(sections.filter((s) => s === 'Food').length >= 2, sections.join(', '));
    assert.equal(sections[0], 'Food');
    const why = await page.locator('#why-list li').first().textContent();
    assert.match(why ?? '', /because you read “/);
    await assertNoLayoutShift(t, page);
  });
}

test('"Not interested" hides an item for good; "Forget everything" starts over', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(site, page);
  const first = (await slots(page, 'hunch-for-you'))[0]!.id;

  await visit(page, first);
  await page.click('[data-signal="hide"]');
  await page.waitForFunction(() => document.getElementById('feedback')!.textContent !== '');
  await home(site, page);
  // The hidden item is gone, and so is the visit to it (seen items are not recommended).
  assert.ok(!(await slots(page, 'hunch-for-you')).some((r) => r.id === first));
  // Hidden even where seen items are allowed: the hide signal, not the view, keeps it out.
  const withSeen = await page.evaluate(async () => {
    const { Hunch: Client } = window as unknown as { Hunch: typeof Hunch };
    const hunch = await Client.shared(document.body.dataset.manifest!);
    return (await hunch.recommend({ n: 40, includeSeen: true })).map((r) => r.id);
  });
  assert.ok(withSeen.length > 20);
  assert.ok(!withSeen.includes(first), `${first} came back with includeSeen`);

  await page.click('#forget');
  await page.waitForFunction(() =>
    document.getElementById('status')!.textContent.startsWith('0 signals'),
  );
  // Without a reload: the refreshed list is the server's again, and so are its reasons.
  const editorial = (await loadSource('demo/feed.xml')).slice(0, 4).map((item) => item.id);
  await page.waitForFunction(
    (ids) =>
      [...document.querySelectorAll<HTMLElement>('hunch-for-you [data-hunch-slot]')]
        .map((el) => el.dataset.hunchId)
        .join() === ids.join(),
    editorial,
  );
  assert.equal(await page.locator('#why-list li').count(), 0);
  await page.reload();
  await ready(page, 'hunch-for-you');
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'false');
});

test('pause stops recording; withdrawing consent deletes the data; export downloads it', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  await read(site, page, FOOD[0]!);
  await home(site, page);
  await page.waitForFunction(() =>
    document.getElementById('status')!.textContent.startsWith('1 signal stored'),
  );

  const download = page.waitForEvent('download');
  await page.click('#export');
  const file = await download;
  assert.equal(file.suggestedFilename(), 'hunch-signals.json');
  const exported = JSON.parse(await readFile(await file.path(), 'utf8'));
  assert.equal(exported.format, 'hunch/signals');
  assert.deepEqual(
    exported.signals.map((s: { itemId: string }) => s.itemId),
    [FOOD[0]],
  );

  await page.click('#pause');
  await page.waitForFunction(() => /paused/.test(document.getElementById('status')!.textContent));
  await visit(page, FOOD[1]!);
  assert.equal((await storedSignals(page)).length, 1);

  await home(site, page);
  await page.uncheck('#consent');
  await page.waitForFunction(() => /off/.test(document.getElementById('status')!.textContent));
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
});

test('staying on an article records dwell time', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  // A clock that runs 30 seconds while the page is visible.
  await page.clock.install();
  await visit(page, FOOD[0]!);
  await page.clock.fastForward(30_000);
  // Leaving the page (hidden) flushes the dwell time.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForSignal(page, (s) => s.kind === 'dwell');
  const dwell = (await storedSignals(page)).find((s) => s.kind === 'dwell')!;
  assert.ok(dwell.weight > 0.9 && dwell.weight <= 1.1, String(dwell.weight));
});

test('an item hidden before there is a profile leaves the fallback', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  await home(site, page);
  const editorial = (await loadSource('demo/feed.xml')).slice(0, 5).map((item) => item.id);
  // Only a hide: no profile, but the editors' first pick must go.
  await page.evaluate(async (id) => {
    const { Hunch: Client } = window as unknown as { Hunch: typeof Hunch };
    await (await Client.shared(document.body.dataset.manifest!)).record('hide', id);
  }, editorial[0]!);
  await page.reload();
  await ready(page, 'hunch-for-you');
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'false');
  assert.deepEqual(
    (await slots(page, 'hunch-for-you')).map((s) => s.id),
    editorial.slice(1),
  );
});

test('"For you" says why, and its × button hides an item in place', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await observeLayoutShifts(page);
  await home(site, page);
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'true');
  // "Because you read …" names one of the articles read, on the items the profile placed.
  const because = await page.$$eval('hunch-for-you [data-hunch-because]', (els) =>
    els.map((el) => el.textContent ?? ''),
  );
  assert.ok(
    because.some((text) => text !== ''),
    because.join(' | '),
  );
  const titles = new Map((await loadSource('demo/feed.xml')).map((item) => [item.id, item.title]));
  for (const text of because.filter(Boolean)) {
    assert.ok(
      FOOD.some((id) => text === `Because you read ${titles.get(id)}`),
      text,
    );
  }

  const before = (await slots(page, 'hunch-for-you')).map((s) => s.id);
  const button = page
    .locator('hunch-for-you [data-hunch-slot]')
    .first()
    .locator('[data-hunch-hide]');
  assert.ok(await button.isVisible());
  assert.match((await button.getAttribute('aria-label')) ?? '', /^Not interested: /);
  await button.click();
  await page.waitForFunction(
    (first) =>
      document.querySelector<HTMLElement>('hunch-for-you [data-hunch-slot]')?.dataset.hunchId !==
      first,
    before[0],
  );
  await ready(page, 'hunch-for-you');
  const after = (await slots(page, 'hunch-for-you')).map((s) => s.id);
  assert.ok(!after.includes(before[0]!), after.join(', '));
  // Focus moved to the first slot's link, and the change was announced.
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.closest('[data-hunch-slot]') ===
      document.querySelector('hunch-for-you [data-hunch-slot]')
        ? document.activeElement?.localName
        : null,
    ),
    'a',
  );
  assert.match((await page.locator('[data-hunch-announce]').textContent()) ?? '', /^Hidden/);
  assert.ok((await storedSignals(page)).some((s) => s.kind === 'hide' && s.itemId === before[0]));
  await assertNoLayoutShift(t, page);
});

test('without consent the × buttons stay hidden', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await home(site, page);
  assert.equal(await page.locator('hunch-for-you [data-hunch-hide]:visible').count(), 0);
  assert.deepEqual(
    await page.$$eval('hunch-for-you [data-hunch-because]', (els) =>
      els.map((el) => el.textContent),
    ),
    ['', '', '', ''],
  );
});

test('a double click on × records one hide', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(site, page);
  const first = (await slots(page, 'hunch-for-you'))[0]!.id;
  await page
    .locator('hunch-for-you [data-hunch-slot]')
    .first()
    .locator('[data-hunch-hide]')
    .dblclick();
  await page.waitForFunction(
    (id) =>
      document.querySelector<HTMLElement>('hunch-for-you [data-hunch-slot]')?.dataset.hunchId !==
      id,
    first,
  );
  await ready(page, 'hunch-for-you');
  const hides = (await storedSignals(page)).filter((s) => s.kind === 'hide');
  assert.deepEqual(
    hides.map((s) => s.itemId),
    [first],
  );
});

test('a click in a personalized "for you" list reports personalized: true', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(site, page);
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'true');
  const first = (await slots(page, 'hunch-for-you'))[0]!.id;
  const clicked = await captureClicks(page);
  await page.locator('hunch-for-you [data-hunch-slot] a').first().click();
  const { url: _, ...detail } = (await clicked())!;
  assert.deepEqual(detail, {
    id: first,
    list: 'hunch-for-you',
    position: 1,
    personalized: true,
  });
});
