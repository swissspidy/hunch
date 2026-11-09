/**
 * Milestone 2's acceptance test, in a browser: signals are recorded only with consent, "for you"
 * follows what the visitor reads, the visitor's controls work, and the layout does not shift.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { loadSource } from '../../src/node/sources/index.ts';
import {
  DESKTOP,
  assertNoLayoutShift,
  observeLayoutShifts,
  PHONE,
  read,
  ready,
  serveDemo,
  slots,
  waitUntil,
} from './site.ts';

const site = serveDemo();
const FOOD = ['sourdough-starter', 'baguette-shaping', 'rye-bread'];

async function context(consent: boolean, options = DESKTOP): Promise<BrowserContext> {
  const ctx = await site.browser.newContext(options);
  if (consent) {
    await ctx.addInitScript(() => localStorage.setItem('hunch-demo-consent', 'yes'));
  }
  return ctx;
}

async function visit(page: Page, id: string): Promise<void> {
  await page.goto(`${site.origin}/items/${id}.html`);
  await ready(page, 'hunch-related');
}

/** The demo's signals, read from IndexedDB as the page sees them. */
function storedSignals(page: Page): Promise<{ itemId: string; kind: string }[]> {
  return page.evaluate(async () => {
    const hunch = await (
      window as unknown as {
        Hunch: {
          shared(
            m: string,
          ): Promise<{ export(): Promise<{ signals: { itemId: string; kind: string }[] }> }>;
        };
      }
    ).Hunch.shared(document.body.dataset.manifest!);
    return (await hunch.export()).signals;
  });
}

async function home(page: Page): Promise<void> {
  await page.goto(`${site.origin}/`);
  await ready(page, 'hunch-for-you');
}

test('without consent nothing is stored and "for you" is the editors’ order', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await visit(page, FOOD[0]!);
  await page.click('[data-signal="follow"]');
  assert.match((await page.locator('#feedback').textContent()) ?? '', /Turn on personalization/);
  await home(page);
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'false');
  // The editors' order: the feed's first items, as the demo renders them (scripts/demo.ts).
  const editorial = (await loadSource('demo/feed.xml')).slice(0, 4).map((item) => item.id);
  assert.deepEqual(
    (await slots(page, 'hunch-for-you')).map((s) => s.id),
    editorial,
  );
  // Not even an empty database was created.
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await ctx.close();
});

for (const [name, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`reading food articles makes "for you" about food, without layout shift (${name})`, async (t) => {
    const ctx = await context(true, options);
    const page = await ctx.newPage();
    for (const id of FOOD) await read(site, page, id);
    const signals = await storedSignals(page);
    assert.deepEqual(
      signals.filter((s) => s.kind === 'view').map((s) => s.itemId),
      FOOD,
    );

    await observeLayoutShifts(page);
    await home(page);
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
    await ctx.close();
  });
}

test('"Not interested" hides an item for good; "Forget everything" starts over', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(page);
  const first = (await slots(page, 'hunch-for-you'))[0]!.id;

  await visit(page, first);
  await page.click('[data-signal="hide"]');
  await page.waitForFunction(() => document.getElementById('feedback')!.textContent !== '');
  await home(page);
  // The hidden item is gone, and so is the visit to it (seen items are not recommended).
  assert.ok(!(await slots(page, 'hunch-for-you')).some((r) => r.id === first));
  // Hidden even where seen items are allowed: the hide signal, not the view, keeps it out.
  const withSeen = await page.evaluate(async () => {
    const shared = (
      window as unknown as {
        Hunch: {
          shared(m: string): Promise<{ recommend(o: object): Promise<{ id: string }[]> }>;
        };
      }
    ).Hunch.shared;
    const hunch = await shared(document.body.dataset.manifest!);
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
  await ctx.close();
});

test('pause stops recording; withdrawing consent deletes the data; export downloads it', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  await read(site, page, FOOD[0]!);
  await home(page);
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

  await home(page);
  await page.uncheck('#consent');
  await page.waitForFunction(() => /off/.test(document.getElementById('status')!.textContent));
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  await ctx.close();
});

test('staying on an article records dwell time', async () => {
  const ctx = await context(true);
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
  await waitUntil(
    page,
    async () => {
      const hunch = await (
        window as unknown as {
          Hunch: {
            shared(m: string): Promise<{ export(): Promise<{ signals: { kind: string }[] }> }>;
          };
        }
      ).Hunch.shared(document.body.dataset.manifest!);
      return (await hunch.export()).signals.some((s) => s.kind === 'dwell');
    },
    undefined,
  );
  const dwell = (await storedSignals(page)).find((s) => s.kind === 'dwell') as unknown as {
    weight: number;
  };
  assert.ok(dwell.weight > 0.9 && dwell.weight <= 1.1, String(dwell.weight));
  await ctx.close();
});

test('an item hidden before there is a profile leaves the fallback', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  await home(page);
  const editorial = (await loadSource('demo/feed.xml')).slice(0, 5).map((item) => item.id);
  // Only a hide: no profile, but the editors' first pick must go.
  await page.evaluate(async (id) => {
    const shared = (
      window as unknown as {
        Hunch: {
          shared(m: string): Promise<{ record(k: string, id: string): Promise<boolean> }>;
        };
      }
    ).Hunch.shared;
    await (await shared(document.body.dataset.manifest!)).record('hide', id);
  }, editorial[0]!);
  await page.reload();
  await ready(page, 'hunch-for-you');
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'false');
  assert.deepEqual(
    (await slots(page, 'hunch-for-you')).map((s) => s.id),
    editorial.slice(1),
  );
  await ctx.close();
});

test('"For you" says why, and its × button hides an item in place', async (t) => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await observeLayoutShifts(page);
  await home(page);
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
  await ctx.close();
});

test('without consent the × buttons stay hidden', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await home(page);
  assert.equal(await page.locator('hunch-for-you [data-hunch-hide]:visible').count(), 0);
  assert.deepEqual(
    await page.$$eval('hunch-for-you [data-hunch-because]', (els) =>
      els.map((el) => el.textContent),
    ),
    ['', '', '', ''],
  );
  await ctx.close();
});

test('a double click on × records one hide', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(page);
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
  await ctx.close();
});
