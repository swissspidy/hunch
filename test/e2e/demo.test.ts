/**
 * Milestone 1's acceptance test: the demo site, in a browser. Related items are ranked in the
 * browser from the published vectors, no model is fetched, and the layout does not shift.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeShard, encodeShard } from '../../src/format/shard.ts';
import type { BrowserContextOptions, Page } from 'playwright-core';
import {
  DESKTOP,
  assertNoLayoutShift,
  BROWSER,
  observeLayoutShifts,
  PHONE,
  ready as readyFor,
  serveDemo,
  slots as slotsOf,
} from './site.ts';

const site = serveDemo();

async function open(path: string, options: BrowserContextOptions = DESKTOP, gate?: Promise<void>) {
  const context = await site.browser.newContext(options);
  const page = await context.newPage();
  // Holds the manifest back until `gate` settles, so a test can see the fallback first.
  if (gate)
    await page.route('**/hunch/manifest.json', (route) => gate.then(() => route.continue()));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await observeLayoutShifts(page);
  await page.goto(`${site.origin}${path}`);
  return { page, requests, close: () => context.close() };
}

const slots = (page: Page) => slotsOf(page, 'hunch-related');
const ready = (page: Page) => readyFor(page, 'hunch-related');

for (const [name, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`related items replace the fallback in place, with no layout shift (${name})`, async (t) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { page, requests, close } = await open('/items/stargazing-atacama.html', options, gate);
    const fallback = await slots(page);
    const box = await page.locator('hunch-related').boundingBox();
    assert.ok(fallback.every((f) => f.href === `/items/${f.id}.html`));
    release();
    await ready(page);
    const related = await slots(page);
    assert.equal(related.length, fallback.length);
    // EmbeddingGemma's vectors put the dark-sky article first, from another section.
    assert.equal(related[0]!.id, 'dark-sky-reserves', JSON.stringify(related));
    assert.notDeepEqual(related, fallback);
    assert.ok(related.every((r) => r.href === `/items/${r.id}.html`));
    assert.ok(!related.some((r) => r.id === 'stargazing-atacama'));
    assert.deepEqual(await page.locator('hunch-related').boundingBox(), box);
    await assertNoLayoutShift(t, page);

    // No model: the page fetched the manifest and the vector shards, nothing else of Hunch's.
    const paths = requests.map((url) => new URL(url).pathname);
    assert.ok(
      requests.every((url) => url.startsWith(site.origin)),
      requests.join('\n'),
    );
    assert.ok(!paths.some((p) => /\.onnx|tokenizer|transformers/i.test(p)), paths.join('\n'));
    let hunch = paths
      .filter((p) => p.startsWith('/hunch/'))
      .map((p) => p.replace(/\.[0-9a-f]{12}\.hunch$/, '.hunch'));
    // WebKit doesn't hand the `<link rel="preload" as="fetch">` response to the client's
    // fetch(), so it requests the manifest a second time.
    if (BROWSER === 'webkit') {
      const duplicate = hunch.indexOf('/hunch/manifest.json', 1);
      if (duplicate > 0) hunch.splice(duplicate, 1);
    }
    // The manifest, then the item's own section (the element's section hint), then the rest.
    assert.deepEqual(hunch.slice(0, 2), ['/hunch/manifest.json', '/hunch/shards/travel.hunch']);
    assert.deepEqual(hunch.slice(2).sort(), [
      '/hunch/shards/food.hunch',
      '/hunch/shards/science.hunch',
      '/hunch/shards/technology.hunch',
    ]);
    await close();
  });
}

test(`the WebAssembly SIMD kernel runs in ${BROWSER}, with the JavaScript one's results`, async () => {
  const { page, close } = await open('/items/cold-brew.html');
  await ready(page);
  const result = await page.evaluate(async () => {
    const { Hunch } = window as unknown as {
      Hunch: {
        load(o: object): Promise<{
          kernel: string;
          related(id: string, o: object): Promise<{ id: string; score: number }[]>;
        }>;
      };
    };
    const manifest = document.body.dataset.manifest!;
    const [wasm, js] = await Promise.all([
      Hunch.load({ manifest }),
      Hunch.load({ manifest, kernel: 'js' }),
    ]);
    return {
      kinds: [wasm.kernel, js.kernel],
      a: await wasm.related('cold-brew', { n: 8 }),
      b: await js.related('cold-brew', { n: 8 }),
    };
  });
  assert.deepEqual(result.kinds, ['wasm', 'js']);
  assert.deepEqual(
    result.a.map((r) => r.id),
    result.b.map((r) => r.id),
  );
  result.a.forEach((r, i) => assert.ok(Math.abs(r.score - result.b[i]!.score) < 1e-8));
  await close();
});

test('the explanation lists each item’s similarity', async () => {
  const { page, close } = await open('/items/cold-brew.html');
  await ready(page);
  const why = await page.locator('#why-list li').allTextContents();
  assert.equal(why.length, 4);
  assert.match(
    why[0]!,
    /^The chemistry of roasting coffee beans: similarity 0\.\d\d, recency 0\.\d\d$/,
  );
  await close();
});

test('no animation when the visitor prefers reduced motion', async () => {
  const { page, close } = await open('/items/cold-brew.html', {
    ...DESKTOP,
    reducedMotion: 'reduce',
  });
  await ready(page);
  const animations = await page.evaluate(() => document.getAnimations().length);
  assert.equal(animations, 0);
  await close();
});

test('a javascript: URL in the catalog never becomes a link', async () => {
  // The Food shard, re-encoded with a script URL for every item, and the manifest to match.
  const manifest = JSON.parse(await readFile('demo/dist/hunch/manifest.json', 'utf8'));
  const ref = manifest.shards.find((s: { section: string }) => s.section === 'Food');
  const shard = decodeShard(new Uint8Array(await readFile(`demo/dist/hunch/${ref.url}`)).buffer);
  const vectors = shard.items.map((_, i) => {
    const row = Float32Array.from(shard.vectors.subarray(i * shard.dims, (i + 1) * shard.dims));
    return row.map((x) => x * shard.invNorms[i]!);
  });
  const bytes = encodeShard(
    {
      space: shard.space,
      items: shard.items.map((item) => ({ ...item, url: 'javascript:alert(1)' })),
    },
    vectors,
    shard.dims,
    'int8',
  );
  ref.sha256 = createHash('sha256').update(bytes).digest('hex');
  ref.bytes = bytes.length;
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.route('**/hunch/manifest.json', (route) => route.fulfill({ json: manifest }));
  await page.route(`**/hunch/${ref.url}`, (route) => route.fulfill({ body: Buffer.from(bytes) }));
  await page.goto(`${site.origin}/items/cold-brew.html`);
  await ready(page);
  const links = await page.$$eval('hunch-related [data-hunch-slot]', (els) =>
    els.map((el) => [
      el.querySelector('[data-hunch-section]')?.textContent,
      el.querySelector('a')?.getAttribute('href') ?? null,
    ]),
  );
  const food = links.filter(([section]) => section === 'Food');
  assert.ok(food.length > 0, JSON.stringify(links));
  assert.ok(
    food.every(([, href]) => href === null),
    JSON.stringify(links),
  );
  assert.ok(links.every(([, href]) => !href?.startsWith('javascript:')));
  await context.close();
});

test('the server-rendered fallback stays when the manifest cannot load', async () => {
  const context = await site.browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.route('**/hunch/manifest.json', (route) => route.fulfill({ status: 503 }));
  await page.goto(`${site.origin}/items/cold-brew.html`);
  const fallback = await slots(page);
  await page.waitForSelector('hunch-related[data-hunch-state="error"]');
  assert.deepEqual(await slots(page), fallback);
  await context.close();
});

test('on a plain-HTTP site (no SubtleCrypto), fetch checks the shards’ hashes', async () => {
  // The demo under an origin that isn't localhost, so the page is not a secure context.
  const context = await site.browser.newContext(DESKTOP);
  let tamper = false;
  await context.route('http://hunch.test/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${site.origin}${url.pathname}${url.search}` });
    if (tamper && url.pathname.endsWith('.hunch')) {
      // One vector component changed: still a valid shard, so only the hash can tell.
      const body = Buffer.from(await response.body());
      const at = body.length - body.readUInt32LE(20) - 1;
      body[at] = body[at]! ^ 1;
      return route.fulfill({ response, body });
    }
    return route.fulfill({ response });
  });
  const page = await context.newPage();
  await page.goto('http://hunch.test/items/cold-brew.html');
  assert.deepEqual(
    await page.evaluate(() => [isSecureContext, Boolean(globalThis.crypto?.subtle)]),
    [false, false],
  );
  await ready(page);
  assert.ok((await slots(page)).every((slot) => slot.title));
  // A shard that doesn't match the manifest's hash: refused, the fallback stays.
  tamper = true;
  await page.reload();
  await page.waitForSelector('hunch-related[data-hunch-state="error"]');
  await context.close();
});

test('a click on a slot fires hunch:click for the site’s analytics, and sends nothing', async () => {
  const { page, requests, close } = await open('/items/sourdough-starter.html');
  await ready(page);
  const ranked = await slots(page);
  await page.evaluate(() => {
    // Keep the page: stop the link, after the component has seen the click.
    document.addEventListener('click', (event) => event.preventDefault());
    document.addEventListener('hunch:click', (event) => {
      (window as unknown as { clicked: unknown }).clicked = (event as CustomEvent).detail;
    });
  });
  const before = requests.length;
  await page.locator('hunch-related [data-hunch-slot] a').nth(1).click();
  const detail = await page.evaluate(() => (window as unknown as { clicked: unknown }).clicked);
  assert.deepEqual(detail, {
    id: ranked[1]!.id,
    url: new URL(ranked[1]!.href, site.origin).href,
    position: 2,
    list: 'hunch-related',
    personalized: false,
  });
  assert.deepEqual(requests.slice(before), []);
  await close();
});
