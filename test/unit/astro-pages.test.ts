/** The Astro integration's helpers: path filters, page files, ids, images and `out`. */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  checkOut,
  matcher,
  outDir,
  pagePath,
  readPage,
  resolveImage,
} from '../../src/astro/pages.ts';
import { tempDir } from '../helpers.ts';

test('a whole-segment * needs a character; a partial one does not', () => {
  const blog = matcher('/blog/*');
  assert.ok(blog('/blog/post/'));
  assert.ok(blog('/blog/post'));
  assert.ok(!blog('/blog/'));
  assert.ok(!blog('/blog'));
  assert.ok(!blog('/blog/a/b/'));
  const prefix = matcher('/blog/alpine-*');
  assert.ok(prefix('/blog/alpine-/'));
  assert.ok(prefix('/blog/alpine-hut'));
  assert.ok(matcher('/*/post')('/blog/post'));
  assert.ok(!matcher('/*/post')('//post'));
});

test('a trailing /** matches the path itself and anything below it', () => {
  const blog = matcher('/blog/**');
  for (const path of ['/blog', '/blog/', '/blog/post', '/blog/a/b/']) assert.ok(blog(path), path);
  assert.ok(!blog('/blogroll'));
  assert.ok(!blog('/'));
  // In the middle, ** is any number of segments.
  const deep = matcher('/**/alpine-*/');
  assert.ok(deep('/alpine-hut/'));
  assert.ok(deep('/blog/2026/alpine-hut/'));
  assert.ok(matcher('/')('/'));
});

test('a global or sticky RegExp matches every page, not every other one', () => {
  // Patterns that need the trailing slash: the slash-less retry can not hide a skipped match.
  for (const re of [/^\/blog\/\w\/$/g, /\/blog\/\w\/$/y]) {
    const match = matcher(re);
    for (const path of ['/blog/a/', '/blog/b/', '/blog/c/'])
      assert.ok(match(path), `${re} ${path}`);
  }
});

test('readPage finds the emitted file for each build.format, and rethrows read errors', async () => {
  const dir = await tempDir();
  const url = pathToFileURL(`${dir}/`);
  await mkdir(join(dir, 'blog/post'), { recursive: true });
  await writeFile(join(dir, 'index.html'), 'home');
  await writeFile(join(dir, 'blog/post.html'), 'flat');
  await writeFile(join(dir, 'blog/post/index.html'), 'index');
  await mkdir(join(dir, 'tags'));
  await writeFile(join(dir, 'tags/index.html'), 'tags');

  assert.deepEqual(await readPage(url, '/', 'directory'), { html: 'home', flat: false });
  // With `file`, the page is name.html; name/index.html would be a public file.
  assert.deepEqual(await readPage(url, '/blog/post', 'file'), { html: 'flat', flat: true });
  assert.deepEqual(await readPage(url, '/blog/post/', 'directory'), { html: 'index', flat: false });
  assert.deepEqual(await readPage(url, '/blog/post', 'preserve'), { html: 'index', flat: false });
  // An index page under `preserve` keeps the directory form.
  assert.deepEqual(await readPage(url, '/tags', 'preserve'), { html: 'tags', flat: false });
  assert.deepEqual(await readPage(url, '/tags', 'file'), { html: 'tags', flat: false });
  assert.equal(await readPage(url, '/missing/', 'directory'), undefined);
  assert.equal(await readPage(url, '/index.html/x', 'directory'), undefined); // ENOTDIR

  // Any other error is not "no page".
  await mkdir(join(dir, 'broken/index.html'), { recursive: true });
  await assert.rejects(readPage(url, '/broken/', 'directory'), { code: 'EISDIR' });
});

test('pagePath gives the id Astro.url.pathname has', () => {
  assert.equal(pagePath('/', '/', false, 'ignore'), '/');
  assert.equal(pagePath('/sub/', '/', false, 'never'), '/sub');
  assert.equal(pagePath('/', '/blog/post/', false, 'ignore'), '/blog/post/');
  assert.equal(pagePath('/sub/', '/blog/post', false, 'never'), '/sub/blog/post');
  // A `preserve` index page: no slash in the hook's pathname, one in Astro.url.pathname.
  assert.equal(pagePath('/', '/tags', false, 'ignore'), '/tags/');
  assert.equal(pagePath('/', '/tags', false, 'always'), '/tags/');
  assert.equal(pagePath('/', '/blog/post', true, 'ignore'), '/blog/post.html');
  assert.equal(pagePath('/sub/', '/tags', true, 'never'), '/sub/tags.html');
});

test('resolveImage resolves page-relative images against the page', () => {
  assert.equal(resolveImage('./cover.jpg', '/blog/post/'), '/blog/post/cover.jpg');
  assert.equal(resolveImage('cover.jpg?w=2', '/blog/post.html'), '/blog/cover.jpg?w=2');
  assert.equal(resolveImage('../img/a.png', '/sub/blog/post/'), '/sub/blog/img/a.png');
  assert.equal(resolveImage('/img/a.png', '/blog/post/'), '/img/a.png');
  assert.equal(resolveImage('https://cdn.example/a.png', '/blog/'), 'https://cdn.example/a.png');
  assert.equal(resolveImage('//cdn.example/a.png', '/blog/'), '//cdn.example/a.png');
  assert.equal(resolveImage('data:image/png;base64,AA', '/blog/'), 'data:image/png;base64,AA');
});

test('out must stay inside the build output', () => {
  assert.equal(checkOut(undefined), 'hunch');
  assert.equal(checkOut('/vectors/'), 'vectors');
  assert.equal(checkOut('assets/hunch'), 'assets/hunch');
  for (const out of [
    '',
    '/',
    '..',
    '../vectors',
    'a/../../b',
    './hunch',
    '%2e%2e/vectors',
    '.%2E/vectors',
    'file:///tmp/hunch',
    'C:\\hunch',
    'a//b',
  ]) {
    assert.throws(() => checkOut(out), /inside the build output/, out);
  }
  const dir = new URL('file:///site/dist/');
  assert.equal(outDir(dir, 'hunch').href, 'file:///site/dist/hunch/');
  assert.equal(outDir(new URL('file:///site/dist'), 'hunch').href, 'file:///site/dist/hunch/');
  assert.throws(() => outDir(dir, '%2e%2e/dist-other'), /not inside/);
  assert.throws(() => outDir(dir, 'file:///tmp/x'), /not inside/);
});
