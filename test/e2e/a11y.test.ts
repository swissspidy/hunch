/**
 * Accessibility of the demo and the components: axe-core in each of the demo's main states,
 * and by hand what axe can't see. Filled slots keep their accessible names and list semantics,
 * focus stays where the visitor put it while slots are filled, and the status messages are
 * live regions that speak when the visitor acts, not on every page load.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hunch } from '../../src/client/index.ts';
import {
  assertClean,
  axe,
  context,
  DESKTOP,
  FOOD,
  holdManifest,
  home,
  newContext,
  read,
  ready,
  routeFakeTransformers,
  serveDemo,
  slots,
} from './site.ts';

const site = serveDemo();

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe: the home page, cold (no consent), ${colorScheme}`, async (t) => {
    const ctx = await newContext(t, site, { ...DESKTOP, colorScheme });
    const page = await ctx.newPage();
    await home(site, page);
    assertClean(await axe(page), `cold, ${colorScheme}`);
  });
}

test('axe: an article page, with its related items', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/items/cold-brew.html`);
  await ready(page, 'hunch-related');
  assertClean(await axe(page), 'article');
});

test('axe: the home page, personalized', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(site, page);
  assert.equal(await page.getAttribute('hunch-for-you', 'data-hunch-personalized'), 'true');
  assertClean(await axe(page), 'personalized');
});

test('axe: the home page after a search', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await routeFakeTransformers(site, page);
  await home(site, page);
  await page.fill('input[name="q"]', 'something cold to drink');
  await page.click('#search button');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
  assertClean(await axe(page), 'search');
});

test('axe: the home page with a digest of what is new', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  await home(site, page, '?as-of=2026-09-15');
  await home(site, page);
  assert.equal(await page.getAttribute('hunch-digest', 'data-hunch-new'), '3');
  assertClean(await axe(page), 'digest');
});

test('filled slots stay a list of links named by their titles', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/items/cold-brew.html`);
  await ready(page, 'hunch-related');
  const filled = await slots(page, 'hunch-related');
  const tree = await page.locator('hunch-related').ariaSnapshot();
  assert.match(tree, /^- list:/, tree);
  assert.equal(tree.match(/^ {2}- listitem:/gm)?.length, filled.length, tree);
  for (const { title } of filled) {
    assert.equal(await page.getByRole('link', { name: title, exact: true }).count(), 1, title);
  }
});

test('a stale aria-label on a slot follows the item it now shows', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  // A site that names its links "Read: <title>" in an aria-label.
  await page.route('**/items/cold-brew.html', async (route) => {
    const html = await (await route.fetch()).text();
    const labelled = html.replace(
      /<a href="([^"]+)"><span class="title" data-hunch-title>([^<]+)</g,
      '<a href="$1" aria-label="Read: $2"><span class="title" data-hunch-title>$2<',
    );
    assert.notEqual(labelled, html);
    await route.fulfill({ body: labelled, contentType: 'text/html' });
  });
  const release = await holdManifest(page);
  await page.goto(`${site.origin}/items/cold-brew.html`);
  const original = (await slots(page, 'hunch-related')).map((s) => s.title);
  release();
  await ready(page, 'hunch-related');
  const labels = await page.$$eval('hunch-related [data-hunch-slot] a', (links) =>
    links.map((a) => [
      a.getAttribute('aria-label'),
      a.querySelector('[data-hunch-title]')!.textContent,
    ]),
  );
  assert.equal(labels.length, 4);
  for (const [label, title] of labels) assert.equal(label, `Read: ${title}`);
  assert.notDeepEqual(
    labels.map(([, title]) => title),
    original,
  );
});

test('focus stays on a focused slot while the list is ranked', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  const release = await holdManifest(page);
  await page.goto(`${site.origin}/items/stargazing-atacama.html`);
  const fallback = await slots(page, 'hunch-related');
  await page.focus('hunch-related [data-hunch-slot]:nth-child(2) a');
  release();
  // The ranking is done (the page's shared client has the shards), but the list waits until
  // focus leaves it.
  await page.evaluate(async () => {
    const { Hunch: Client } = window as unknown as { Hunch: typeof Hunch };
    await (await Client.shared(document.body.dataset.manifest!)).related('stargazing-atacama');
  });
  // A fixed wait: the element shows nothing while it waits for focus to leave, so that it
  // went on to fill the list could only show later.
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute('hunch-related', 'data-hunch-state'), 'loading');
  assert.deepEqual(await slots(page, 'hunch-related'), fallback);
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.closest('[data-hunch-slot]')?.getAttribute('data-hunch-id'),
    ),
    fallback[1]!.id,
  );
  // Moving focus to another slot doesn't fill it either.
  await page.focus('hunch-related [data-hunch-slot]:nth-child(1) a');
  // The element looks again in a task after the focus change: this later task comes after it.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  assert.equal(await page.getAttribute('hunch-related', 'data-hunch-state'), 'loading');
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.closest('[data-hunch-slot]')?.getAttribute('data-hunch-id'),
    ),
    fallback[0]!.id,
  );
  // Leaving the list fills it, and focus is where the visitor moved it.
  await page.focus('details.why summary');
  await ready(page, 'hunch-related');
  assert.notDeepEqual(await slots(page, 'hunch-related'), fallback);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY');
});

test('status messages: quiet on load, spoken when the visitor acts', async (t) => {
  const ctx = await context(t, site, true);
  const page = await ctx.newPage();
  await home(site, page);
  const status = page.locator('#status');
  assert.equal(await status.evaluate((el) => el.tagName), 'OUTPUT'); // role="status"
  await page.waitForFunction(() => /stored/.test(document.getElementById('status')!.textContent));
  // The count written on load is not announced: the region is off until the visitor acts.
  assert.equal(await status.getAttribute('aria-live'), 'off');
  await page.focus('#pause');
  assert.equal(await status.getAttribute('aria-live'), null);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /paused/.test(document.getElementById('status')!.textContent));
});

test('the privacy controls work from the keyboard and are labelled', async (t) => {
  const ctx = await context(t, site, false);
  const page = await ctx.newPage();
  await home(site, page);
  const consent = page.getByRole('checkbox', { name: 'Personalize this site on my device' });
  await consent.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => /stored/.test(document.getElementById('status')!.textContent));
  assert.equal(await consent.isChecked(), true);
  for (const name of ['Pause', 'Export my data', 'Forget everything']) {
    assert.equal(await page.getByRole('button', { name }).count(), 1, name);
  }
  await page.getByRole('button', { name: 'Pause' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /paused/.test(document.getElementById('status')!.textContent));
});
