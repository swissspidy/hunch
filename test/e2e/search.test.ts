/**
 * Search in the demo: the query is embedded in the browser by the query module and ranked by
 * inkling.search(). Transformers.js is replaced by a fake module (no 200 MB download in CI)
 * whose "model" returns the vector of a known article, so that article must come first.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeShard } from '../../src/format/shard.ts';
import { DESKTOP, serveDemo } from './site.ts';

const site = serveDemo();
const TARGET = 'cold-brew';

async function fakeTransformers(): Promise<string> {
  const manifest = JSON.parse(await readFile('demo/dist/inkling/manifest.json', 'utf8'));
  const ref = manifest.shards.find((s: { section: string }) => s.section === 'Food');
  const shard = decodeShard(new Uint8Array(await readFile(`demo/dist/inkling/${ref.url}`)).buffer);
  const row = shard.items.findIndex((item) => item.id === TARGET);
  // The article's vector, padded to the model's 768 dims: truncation gives it back exactly.
  const vector = new Array(manifest.model.nativeDims).fill(0);
  for (let d = 0; d < shard.dims; d++)
    vector[d] = shard.vectors[row * shard.dims + d]! * shard.invNorms[row]!;
  return `
    export const env = {};
    export const AutoTokenizer = { from_pretrained: async () => (texts) => ({ texts }) };
    export const AutoModel = {
      from_pretrained: async (id, options) => {
        globalThis.__model = { id, ...options };
        const model = async (inputs) => {
          globalThis.__inputs = inputs.texts;
          return { sentence_embedding: { dims: [1, ${vector.length}], data: Float32Array.from(${JSON.stringify(vector)}) } };
        };
        return model;
      },
    };`;
}

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
    !requests.some((u) => u.includes('inkling-query.js') || u.includes('jsdelivr')),
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
