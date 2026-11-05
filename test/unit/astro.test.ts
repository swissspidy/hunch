/**
 * The Astro integration, with the real `astro build` of test/fixtures/astro and the hash
 * provider: the catalog from the built pages, the filters, the cache, and the injected script.
 */

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Manifest, ShardItem } from '../../src/format/manifest.ts';
import { decodeShard } from '../../src/format/shard.ts';
import { buildFixture, devFixture } from '../fixtures/astro/build.ts';
import { countingProvider, tempDir } from '../helpers.ts';

const POSTS = [
  '/blog/alpine-hut/',
  '/blog/cold-brew/',
  '/blog/night-train/',
  '/blog/rye-bread/',
  '/blog/sourdough/',
];

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
}

async function shardItems(dir: string, manifest: Manifest): Promise<ShardItem[]> {
  const items: ShardItem[] = [];
  for (const shard of manifest.shards) {
    const bytes = new Uint8Array(await readFile(join(dir, shard.url)));
    items.push(...decodeShard(bytes.buffer).items);
  }
  return items;
}

/** The JavaScript a built page loads, inline or from files. */
async function pageScripts(out: string, page: string, base = '/'): Promise<string> {
  const html = await readFile(join(out, page), 'utf8');
  let code = '';
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\bsrc="([^"]+)"/.exec(attrs!)?.[1];
    code += src ? await readFile(join(out, src.slice(base.length)), 'utf8') : body;
  }
  return code;
}

test('builds the catalog from the built pages, and rebuilds from the cache', async () => {
  const out = await tempDir();
  const cacheDir = await tempDir();
  const first = countingProvider();
  await buildFixture(out, { provider: first, cacheDir });

  const manifest = await readManifest(join(out, 'inkling'));
  // Every page but the 404 page.
  assert.equal(manifest.count, 7);
  assert.equal(first.calls.length, 7);
  assert.deepEqual(manifest.sections, ['Travel', 'Food']);
  const items = await shardItems(join(out, 'inkling'), manifest);
  assert.deepEqual(items.map((item) => item.id).sort(), ['/', ...POSTS, '/tags/']);
  const rye = items.find((item) => item.id === '/blog/rye-bread/');
  assert.deepEqual(
    { ...rye, prior: undefined },
    {
      id: '/blog/rye-bread/',
      url: '/blog/rye-bread/',
      title: 'Dense, dark rye bread',
      section: 'Food',
      date: '2026-10-09T00:00:00.000Z',
      prior: undefined,
    },
  );
  // A page-relative og:image is resolved against its page; an absolute one is kept.
  const image = (id: string) => items.find((item) => item.id === id)?.image;
  assert.equal(image('/blog/alpine-hut/'), '/blog/alpine-hut/hut.jpg');
  assert.equal(image('/blog/sourdough/'), 'https://images.example.com/starter.jpg');
  // The article's text is embedded, not the page around it.
  assert.ok(first.calls.some((input) => /sourdough starter, flour, water/.test(input)));
  assert.ok(!first.calls.some((input) => /Related/.test(input)));
  const files = await readdir(join(out, 'inkling/shards'));
  assert.deepEqual(files.sort(), manifest.shards.map((s) => s.url.slice('shards/'.length)).sort());

  // A second build embeds nothing, and publishes the same vectors.
  const second = countingProvider();
  await buildFixture(out, { provider: second, cacheDir });
  assert.equal(second.calls.length, 0);
  assert.equal((await readManifest(join(out, 'inkling'))).version, manifest.version);

  // One changed page is the only one embedded.
  const third = countingProvider();
  await buildFixture(out, {
    provider: third,
    cacheDir,
    page: (item) => (item.id === '/tags/' ? { ...item, text: 'Food, travel and more.' } : item),
  });
  assert.equal(third.calls.length, 1);
});

test('loads the web components on every page, with the manifest preset', async () => {
  const out = await tempDir();
  await buildFixture(out, { cacheDir: false });
  for (const page of ['index.html', 'blog/rye-bread/index.html']) {
    const code = await pageScripts(out, page);
    assert.match(code, /InklingConfig/);
    // Set before the components register: first in the bundle.
    assert.match(code, /^globalThis\.InklingConfig=\{manifest:["'`]\/inkling\/manifest\.json["'`]/);
    assert.match(code, /inkling-related/);
  }
  // The page renders the slots; the integration adds no markup to them.
  const html = await readFile(join(out, 'blog/rye-bread/index.html'), 'utf8');
  assert.match(html, /<inkling-related item="\/blog\/rye-bread\/" section="Food"/);
});

test('include, exclude and page select the pages', async () => {
  const out = await tempDir();
  await buildFixture(out, {
    cacheDir: false,
    include: ['/blog/*'],
    exclude: (path) => path === '/blog/cold-brew/',
    page: (item) => (item.id === '/blog/alpine-hut/' ? null : { ...item, section: 'Posts' }),
  });
  const manifest = await readManifest(join(out, 'inkling'));
  const items = await shardItems(join(out, 'inkling'), manifest);
  assert.deepEqual(items.map((item) => item.id).sort(), [
    '/blog/night-train/',
    '/blog/rye-bread/',
    '/blog/sourdough/',
  ]);
  assert.deepEqual(manifest.sections, ['Posts']);

  // Globs: ** for any depth, a RegExp, and trailing slashes either way.
  const globbed = await tempDir();
  await buildFixture(globbed, {
    cacheDir: false,
    exclude: ['/', '/tags', /cold|night/, '/**/alpine-*/'],
  });
  const left = await shardItems(
    join(globbed, 'inkling'),
    await readManifest(join(globbed, 'inkling')),
  );
  assert.deepEqual(left.map((item) => item.id).sort(), ['/blog/rye-bread/', '/blog/sourdough/']);
});

test('items replaces the catalog, and base and out move it', async () => {
  const out = await tempDir();
  await buildFixture(
    out,
    {
      cacheDir: false,
      out: '/vectors/',
      items: ({ pages }) => [
        ...pages.filter((page) => page.section),
        { id: 'extra', url: '/sub/extra/', title: 'Not a page', text: 'From somewhere else' },
      ],
    },
    { base: '/sub' },
  );
  const manifest = await readManifest(join(out, 'vectors'));
  const items = await shardItems(join(out, 'vectors'), manifest);
  assert.deepEqual(items.map((item) => item.id).sort(), [
    ...POSTS.map((path) => `/sub${path}`),
    'extra',
  ]);
  assert.match(
    await pageScripts(out, 'index.html', '/sub/'),
    /manifest:["'`]\/sub\/vectors\/manifest\.json["'`]/,
  );
  const html = await readFile(join(out, 'blog/rye-bread/index.html'), 'utf8');
  assert.match(html, /<inkling-related item="\/sub\/blog\/rye-bread\/"/);
});

test('ids follow build.format, as Astro.url.pathname does', async () => {
  // A public file where the directory form of a page would be: not the page.
  const publicDir = await tempDir();
  await mkdir(join(publicDir, 'blog/rye-bread'), { recursive: true });
  await writeFile(
    join(publicDir, 'blog/rye-bread/index.html'),
    '<title>A public file</title><body>Not the page</body>',
  );
  const out = await tempDir();
  await buildFixture(out, { cacheDir: false }, { build: { format: 'file' }, publicDir });
  const items = await shardItems(join(out, 'inkling'), await readManifest(join(out, 'inkling')));
  assert.deepEqual(items.map((item) => item.id).sort(), [
    '/',
    ...POSTS.map((path) => path.replace(/\/$/, '.html')),
    '/tags.html',
  ]);
  assert.equal(
    items.find((item) => item.id === '/blog/rye-bread.html')?.title,
    'Dense, dark rye bread',
  );
  const html = await readFile(join(out, 'blog/rye-bread.html'), 'utf8');
  assert.match(html, /<inkling-related item="\/blog\/rye-bread\.html"/);
  // The fixture's fallback links are in the same form, and leave out the page itself.
  const fallback = [...html.matchAll(/data-inkling-id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(fallback.length, 3);
  assert.ok(fallback.every((id) => id!.endsWith('.html') && id !== '/blog/rye-bread.html'));

  // `preserve`: index pages keep the directory form, other pages end in .html. The tags page
  // prints its Astro.url.pathname.
  for (const trailingSlash of ['ignore', 'never'] as const) {
    const preserved = await tempDir();
    await buildFixture(
      preserved,
      { cacheDir: false },
      { build: { format: 'preserve' }, trailingSlash },
    );
    const ids = (
      await shardItems(join(preserved, 'inkling'), await readManifest(join(preserved, 'inkling')))
    ).map((item) => item.id);
    const tags = await readFile(join(preserved, 'tags/index.html'), 'utf8');
    const tagsPath = /data-path="([^"]+)"/.exec(tags)![1]!;
    assert.ok(ids.includes(tagsPath), `${trailingSlash}: ${tagsPath} in ${ids.join(' ')}`);
    assert.ok(ids.includes('/blog/rye-bread.html'), ids.join(' '));
  }
});

test('the manifest URL uses the final base, after every integration', async () => {
  const out = await tempDir();
  await buildFixture(
    out,
    { cacheDir: false },
    {
      // An integration after Inkling's that sets base.
      integrations: [
        {
          name: 'late-base',
          hooks: {
            'astro:config:setup': ({ updateConfig }) => void updateConfig({ base: '/late' }),
          },
        },
      ],
    },
  );
  assert.match(
    await pageScripts(out, 'index.html', '/late/'),
    /manifest:["'`]\/late\/inkling\/manifest\.json["'`]/,
  );
});

test('astro dev serves the last build’s vectors and the components', async () => {
  const out = await tempDir();
  const server = await devFixture(out, { cacheDir: false });
  try {
    // No build yet: no vectors, and the page still renders its fallback.
    assert.equal((await fetch(`${server.origin}/inkling/manifest.json`)).status, 404);
    await buildFixture(out, { cacheDir: false });
    const manifest = await fetch(`${server.origin}/inkling/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal(((await manifest.json()) as Manifest).count, 7);
    const html = await (await fetch(`${server.origin}/blog/rye-bread/`)).text();
    assert.match(html, /<inkling-related item="\/blog\/rye-bread\/"/);
    const script = await (await fetch(`${server.origin}/@id/astro:scripts/page.js`)).text();
    assert.match(script, /virtual:inkling\/config[\s\S]*elements/);
    // Directories are not files: no 200 with an error after it.
    for (const path of ['/inkling/', '/inkling/shards/', '/inkling/shards']) {
      assert.notEqual((await fetch(`${server.origin}${path}`)).status, 200, path);
    }
    // A site with on-demand pages has its vectors in the client directory.
    await rm(join(out, 'inkling'), { recursive: true });
    await mkdir(join(out, 'client/inkling'), { recursive: true });
    await writeFile(join(out, 'client/inkling/manifest.json'), '{"count":1}');
    const client = await fetch(`${server.origin}/inkling/manifest.json`);
    assert.equal(client.status, 200);
    assert.deepEqual(await client.json(), { count: 1 });
  } finally {
    await server.stop();
  }
});
