/**
 * Accessibility of the demo and the components: axe-core in each of the demo's main states,
 * and by hand what axe can't see. Filled slots keep their accessible names and list semantics,
 * focus stays where the visitor put it while slots are filled, and the status messages are
 * live regions that speak when the visitor acts, not on every page load.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { DESKTOP, fakeTransformers, read, ready, serveDemo, slots } from './site.ts';

const site = serveDemo();
const AXE = fileURLToPath(import.meta.resolve('axe-core/axe.min.js'));
const FOOD = ['sourdough-starter', 'baguette-shaping', 'rye-bread'];

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

/** axe-core's WCAG 2.2 A/AA and best-practice rules over the whole page. */
async function axe(page: Page): Promise<Violation[]> {
  // The slots' fade-in would read as low contrast: check the page as it settles.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const { violations, passes } = await (
      window as unknown as {
        axe: {
          run(
            context: Document,
            options: object,
          ): Promise<{ violations: Violation[]; passes: unknown[] }>;
        };
      }
    ).axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    if (passes.length < 10) throw new Error(`axe checked only ${passes.length} rules`);
    return violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target }) => ({ target })),
    }));
  });
}

function assertClean(violations: Violation[], state: string): void {
  assert.deepEqual(
    violations,
    [],
    `${state}:\n${violations.map((v) => `${v.id} (${v.impact}): ${v.help} ${JSON.stringify(v.nodes.map((n) => n.target))}`).join('\n')}`,
  );
}

async function context(consent: boolean): Promise<BrowserContext> {
  const ctx = await site.browser.newContext(DESKTOP);
  if (consent) {
    await ctx.addInitScript(() => localStorage.setItem('inkling-demo-consent', 'yes'));
  }
  return ctx;
}

async function home(page: Page, query = ''): Promise<void> {
  await page.goto(`${site.origin}/${query}`);
  await ready(page, 'inkling-for-you');
  await ready(page, 'inkling-digest');
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe: the home page, cold (no consent), ${colorScheme}`, async () => {
    const ctx = await site.browser.newContext({ ...DESKTOP, colorScheme });
    const page = await ctx.newPage();
    await home(page);
    assertClean(await axe(page), `cold, ${colorScheme}`);
    await ctx.close();
  });
}

test('axe: an article page, with its related items', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/items/cold-brew.html`);
  await ready(page, 'inkling-related');
  assertClean(await axe(page), 'article');
  await ctx.close();
});

test('axe: the home page, personalized', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  for (const id of FOOD) await read(site, page, id);
  await home(page);
  assert.equal(await page.getAttribute('inkling-for-you', 'data-inkling-personalized'), 'true');
  assertClean(await axe(page), 'personalized');
  await ctx.close();
});

test('axe: the home page after a search', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  const fake = await fakeTransformers();
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: fake,
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await home(page);
  await page.fill('input[name="q"]', 'something cold to drink');
  await page.click('#search button');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
  assertClean(await axe(page), 'search');
  await ctx.close();
});

test('axe: the home page with a digest of what is new', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  await home(page, '?as-of=2026-09-15');
  await home(page);
  assert.equal(await page.getAttribute('inkling-digest', 'data-inkling-new'), '3');
  assertClean(await axe(page), 'digest');
  await ctx.close();
});

test('filled slots stay a list of links named by their titles', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/items/cold-brew.html`);
  await ready(page, 'inkling-related');
  const filled = await slots(page, 'inkling-related');
  const tree = await page.locator('inkling-related').ariaSnapshot();
  assert.match(tree, /^- list:/, tree);
  assert.equal(tree.match(/^ {2}- listitem:/gm)?.length, filled.length, tree);
  for (const { title } of filled) {
    assert.equal(await page.getByRole('link', { name: title, exact: true }).count(), 1, title);
  }
  await ctx.close();
});

test('a stale aria-label on a slot follows the item it now shows', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  // A site that names its links "Read: <title>" in an aria-label.
  await page.route('**/items/cold-brew.html', async (route) => {
    const html = await (await route.fetch()).text();
    const labelled = html.replace(
      /<a href="([^"]+)"><span class="title" data-inkling-title>([^<]+)</g,
      '<a href="$1" aria-label="Read: $2"><span class="title" data-inkling-title>$2<',
    );
    assert.notEqual(labelled, html);
    await route.fulfill({ body: labelled, contentType: 'text/html' });
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/inkling/manifest.json', (route) => gate.then(() => route.continue()));
  await page.goto(`${site.origin}/items/cold-brew.html`);
  const original = (await slots(page, 'inkling-related')).map((s) => s.title);
  release();
  await ready(page, 'inkling-related');
  const labels = await page.$$eval('inkling-related [data-inkling-slot] a', (links) =>
    links.map((a) => [
      a.getAttribute('aria-label'),
      a.querySelector('[data-inkling-title]')!.textContent,
    ]),
  );
  assert.equal(labels.length, 4);
  for (const [label, title] of labels) assert.equal(label, `Read: ${title}`);
  assert.notDeepEqual(
    labels.map(([, title]) => title),
    original,
  );
  await ctx.close();
});

test('focus stays on a focused slot while the list is ranked', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/inkling/manifest.json', (route) => gate.then(() => route.continue()));
  await page.goto(`${site.origin}/items/stargazing-atacama.html`);
  const fallback = await slots(page, 'inkling-related');
  await page.focus('inkling-related [data-inkling-slot]:nth-child(2) a');
  release();
  // The ranking is done (the page's shared client has the shards), but the list waits until
  // focus leaves it.
  await page.evaluate(async () => {
    const { Inkling } = window as unknown as {
      Inkling: { shared(m: string): Promise<{ related(id: string): Promise<unknown> }> };
    };
    await (await Inkling.shared(document.body.dataset.manifest!)).related('stargazing-atacama');
  });
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute('inkling-related', 'data-inkling-state'), 'loading');
  assert.deepEqual(await slots(page, 'inkling-related'), fallback);
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.closest('[data-inkling-slot]')?.getAttribute('data-inkling-id'),
    ),
    fallback[1]!.id,
  );
  // Leaving the list fills it, and focus is where the visitor moved it.
  await page.focus('details.why summary');
  await ready(page, 'inkling-related');
  assert.notDeepEqual(await slots(page, 'inkling-related'), fallback);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY');
  await ctx.close();
});

test('status messages: quiet on load, spoken when the visitor acts', async () => {
  const ctx = await context(true);
  const page = await ctx.newPage();
  await home(page);
  const status = page.locator('#status');
  assert.equal(await status.evaluate((el) => el.tagName), 'OUTPUT'); // role="status"
  await page.waitForFunction(() => /stored/.test(document.getElementById('status')!.textContent));
  // The count written on load is not announced: the region is off until the visitor acts.
  assert.equal(await status.getAttribute('aria-live'), 'off');
  await page.focus('#pause');
  assert.equal(await status.getAttribute('aria-live'), null);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /paused/.test(document.getElementById('status')!.textContent));
  await ctx.close();
});

test('the privacy controls work from the keyboard and are labelled', async () => {
  const ctx = await context(false);
  const page = await ctx.newPage();
  await home(page);
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
  await ctx.close();
});
