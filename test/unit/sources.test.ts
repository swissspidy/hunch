import assert from 'node:assert/strict';
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
      id: '/a',
      url: 'https://e.com/a',
      title: 'A & a',
      text: 'A\nBody text.',
      section: 'News',
      tags: ['x', 'y'],
      date: '2026-01-02T00:00:00.000Z',
    },
    { id: '/b', url: 'https://e.com/b', title: 'B', text: 'Main text' },
  ]);
  assert.equal(parsePage('https://e.com/c', '<p>x</p>').title, 'https://e.com/c');
});

test('htmlToText drops markup and scripts', () => {
  assert.equal(
    htmlToText('<p>One&nbsp;&#x41;&#66;</p><style>p{}</style><!-- c --><ul><li>Two</li></ul>'),
    'One AB\nTwo',
  );
});
