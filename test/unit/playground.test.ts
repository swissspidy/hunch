// scripts/playground.ts: the plugin's zip and its Playground demo, for the Pages site.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers.ts';

test('the Playground demo: 32 posts with their vectors, and a blueprint for the site URL', async () => {
  const out = await tempDir();
  const run = spawnSync(
    process.execPath,
    ['scripts/playground.ts', '--url', 'https://example.github.io/hunch', '--out', out],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok((await stat(join(out, 'hunch.zip'))).size > 10_000);
  assert.equal(
    await readFile(join(out, 'import.php'), 'utf8'),
    await readFile('wordpress/playground/import.php', 'utf8'),
  );

  const { posts } = JSON.parse(await readFile(join(out, 'demo.json'), 'utf8'));
  assert.equal(posts.length, 32);
  for (const post of posts) {
    // EmbeddingGemma's 768 float32 components, as the plugin stores them.
    assert.equal(Buffer.from(post.vector, 'base64').length, 768 * 4, post.title);
    assert.match(post.content, /^<!-- wp:paragraph -->\n<p>[^<]+<\/p>\n<!-- \/wp:paragraph -->$/);
    assert.ok(post.section && post.date, post.title);
  }

  const blueprint = JSON.parse(await readFile(join(out, 'blueprint.json'), 'utf8'));
  const urls = blueprint.steps.flatMap(
    (step: { pluginData?: { url?: string }; data?: { url?: string } }) =>
      [step.pluginData?.url, step.data?.url].filter(Boolean),
  );
  assert.deepEqual(urls, [
    'https://example.github.io/hunch/wordpress/hunch.zip',
    'https://example.github.io/hunch/wordpress/demo.json',
    'https://example.github.io/hunch/wordpress/import.php',
  ]);
  const page = await readFile(join(out, 'playground.html'), 'utf8');
  assert.ok(
    page.includes(
      `https://playground.wordpress.net/?blueprint-url=${encodeURIComponent('https://example.github.io/hunch/wordpress/blueprint.json')}`,
    ),
  );
});
