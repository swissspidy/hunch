import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from '../helpers.ts';
import { test } from 'node:test';
import { parseFeed } from '../../src/node/sources/feed.ts';
import { loadSource } from '../../src/node/sources/index.ts';
import { parseJsonCatalog } from '../../src/node/sources/json.ts';
import { loadSitemap, parsePage } from '../../src/node/sources/sitemap.ts';
import { htmlToText } from '../../src/node/text.ts';

test('RSS items become catalog items', async () => {
  const items = await loadSource('demo/feed.xml');
  assert.equal(items.length, 32);
  assert.deepEqual(items[0], {
    id: 'sourdough-starter',
    url: 'https://example.com/food/sourdough-starter/',
    title: 'Keeping a sourdough starter alive through the summer',
    text: items[0]!.text,
    section: 'Food',
    tags: ['Food'],
    date: '2026-10-30T08:00:00.000Z',
  });
  assert.match(items[0].text, /^Warm kitchens make wild yeast/);
});

test('RSS: content:encoded wins over description, CDATA and entities are decoded', () => {
  const [item] =
    parseFeed(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
    <title>Fish &amp;amp; chips</title><link>https://e.com/a</link>
    <description>short</description>
    <content:encoded><![CDATA[<p>The <em>full</em> text &amp; more.</p>]]></content:encoded>
    <enclosure url="https://e.com/a.jpg" type="image/jpeg" length="1"/>
  </item></channel></rss>`);
  assert.equal(item!.id, 'https://e.com/a');
  assert.equal(item!.title, 'Fish & chips');
  assert.equal(item!.text, 'The full text & more.');
  assert.equal(item!.image, 'https://e.com/a.jpg');
});

test('Atom entries become catalog items', async () => {
  const items = await loadSource('test/fixtures/atom.xml');
  assert.deepEqual(items, [
    {
      id: 'urn:example:1',
      url: 'https://example.com/1',
      title: 'Tom & Jerry’s guide',
      text: 'A long story.',
      section: 'Cartoons',
      tags: ['Cartoons', 'history'],
      date: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'https://example.com/2',
      url: 'https://example.com/2',
      title: 'No id',
      text: 'Short.',
      date: '2026-10-02T10:00:00.000Z',
    },
  ]);
});

test('JSON catalogs are checked', () => {
  assert.deepEqual(parseJsonCatalog('{"items":[{"url":"/a","title":"A","popularity":3}]}'), [
    { id: '/a', url: '/a', title: 'A', text: '', popularity: 3 },
  ]);
  assert.throws(() => parseJsonCatalog('[{"title":"A"}]'), /no id or url/);
  assert.throws(() => parseJsonCatalog('[{"id":"a"}]'), /no title/);
  assert.throws(() => parseJsonCatalog('[{"id":"a","title":"A","tags":"x"}]'), /tags/);
  assert.throws(() => parseJsonCatalog('{"nope":1}'), /array/);
});

test('loader modules are called', async () => {
  const items = await loadSource('test/fixtures/loader.ts');
  assert.deepEqual(
    items.map((i) => i.id),
    ['one', 'two'],
  );
});

test('pages from a sitemap use their article meta tags', async () => {
  const pages: Record<string, string> = {
    'https://e.com/sitemap.xml':
      '<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>',
    'https://e.com/s1.xml':
      '<urlset><url><loc>https://e.com/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://e.com/b</loc></url></urlset>',
    'https://e.com/a': `<html><head><title>A | Site</title>
      <meta property="og:title" content="A &amp; a">
      <meta property="article:section" content="News">
      <meta property="article:tag" content="x"><meta property="article:tag" content="y">
      </head><body><nav>Menu</nav><article><h1>A</h1><p>Body text.</p></article></body></html>`,
    'https://e.com/b':
      '<html><head><title>B</title></head><body><main>Main text</main></body></html>',
  };
  const items = await loadSitemap('https://e.com/sitemap.xml', {
    fetchText: (url) => Promise.resolve(pages[url] ?? ''),
  });
  assert.deepEqual(items, [
    {
      id: 'https://e.com/a',
      url: 'https://e.com/a',
      title: 'A & a',
      text: 'A\nBody text.',
      section: 'News',
      tags: ['x', 'y'],
      date: '2026-01-02T00:00:00.000Z',
    },
    { id: 'https://e.com/b', url: 'https://e.com/b', title: 'B', text: 'Main text' },
  ]);
  assert.equal(parsePage('https://e.com/c', '<p>x</p>').title, 'https://e.com/c');
});

test('htmlToText drops markup and scripts', () => {
  assert.equal(
    htmlToText('<p>One&nbsp;&#x41;&#66;</p><style>p{}</style><!-- c --><ul><li>Two</li></ul>'),
    'One AB\nTwo',
  );
});

test('RSS 1.0 (RDF) items are read', () => {
  const items =
    parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://e.com/"><title>E</title></channel>
    <item rdf:about="https://e.com/1"><title>One</title><link>https://e.com/1</link><description>First</description><dc:date>2026-01-02T00:00:00Z</dc:date></item>
    <item rdf:about="https://e.com/2"><title>Two</title><description>Second</description></item>
  </rdf:RDF>`);
  assert.deepEqual(
    items.map((i) => [i.id, i.url, i.title, i.date]),
    [
      ['https://e.com/1', 'https://e.com/1', 'One', '2026-01-02T00:00:00.000Z'],
      ['https://e.com/2', 'https://e.com/2', 'Two', undefined],
    ],
  );
});

test('an RSS guid is a link only if it is a permalink URL', () => {
  const feed = (guid: string) =>
    `<rss version="2.0"><channel><item><title>T</title>${guid}</item></channel></rss>`;
  assert.equal(parseFeed(feed('<guid>https://e.com/p</guid>'))[0]!.url, 'https://e.com/p');
  assert.throws(
    () => parseFeed(feed('<guid isPermaLink="false">https://e.com/p</guid>')),
    /has no link/,
  );
  assert.throws(() => parseFeed(feed('<guid>post-1</guid>')), /\(post-1\) has no link/);
});

test('a local sitemap index can name local sitemaps', async () => {
  const dir = await tempDir();
  const child = pathToFileURL(join(dir, 'pages.xml')).href;
  await writeFile(
    join(dir, 'index.xml'),
    `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`,
  );
  await writeFile(join(dir, 'pages.xml'), '<urlset><url><loc>https://e.com/a</loc></url></urlset>');
  await mkdir(join(dir, 'x'), { recursive: true });
  const fetched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    fetched.push(String(input));
    return Promise.resolve(new Response('<title>A</title>'));
  };
  try {
    const items = await loadSource(join(dir, 'index.xml'));
    assert.deepEqual(
      items.map((i) => i.title),
      ['A'],
    );
    assert.deepEqual(fetched, ['https://e.com/a']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a sitemap limit stops fetching child sitemaps; concurrency must be positive', async () => {
  const fetched: string[] = [];
  const pages: Record<string, string> = {
    'https://e.com/index.xml':
      '<sitemapindex><sitemap><loc>https://e.com/1.xml</loc></sitemap><sitemap><loc>https://e.com/2.xml</loc></sitemap></sitemapindex>',
    'https://e.com/1.xml':
      '<urlset><url><loc>https://e.com/a</loc></url><url><loc>https://e.com/b</loc></url></urlset>',
  };
  const fetchText = (url: string) => {
    fetched.push(url);
    return Promise.resolve(pages[url] ?? '<title>page</title>');
  };
  const items = await loadSitemap('https://e.com/index.xml', { fetchText, limit: 2 });
  assert.equal(items.length, 2);
  assert.ok(!fetched.includes('https://e.com/2.xml'), fetched.join(', '));
  await assert.rejects(
    loadSitemap('https://e.com/index.xml', { fetchText, concurrency: 0 }),
    /concurrency/,
  );
});
