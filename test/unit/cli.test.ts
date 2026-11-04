import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '../helpers.ts';

const run = promisify(execFile);
const inkling = (...args: string[]) => run(process.execPath, ['bin/inkling.js', ...args]);

test('inkling build, then inkling inspect', async () => {
  const out = await tempDir();
  const cache = join(out, 'cache');
  const args = [
    'build',
    '--source',
    'demo/feed.xml',
    '--out',
    out,
    '--provider',
    'hash',
    '--dims',
    '128',
    '--cache-dir',
    cache,
  ];
  const first = await inkling(...args);
  assert.match(first.stderr, /demo\/feed\.xml: 32 items/);
  assert.match(first.stderr, /32 items, 4 shards, .* \(128 dims, int8\); 32 embedded, 0 cached/);
  const second = await inkling(...args);
  assert.match(second.stderr, /0 embedded, 32 cached/);

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.model.id, 'inkling/hash');
  const { stdout } = await inkling('inspect', join(out, 'manifest.json'));
  assert.match(stdout, /model +inkling\/hash@1/);
  assert.match(stdout, /vectors +128 of 512 dims, int8/);
  assert.match(stdout, /Food +8 /);
});

test('errors are one line and exit 1', async () => {
  await assert.rejects(inkling('build', '--out', 'x'), (e: { code: number; stderr: string }) => {
    assert.equal(e.code, 1);
    assert.equal(e.stderr, 'inkling: build needs at least one --source\n');
    return true;
  });
  await assert.rejects(
    inkling('build', '--source', 'demo/feed.xml', '--quantization', 'int4'),
    /int8 or float32/,
  );
  await assert.rejects(inkling('nope'), /Unknown command nope/);
});

test('inkling --version prints the package version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal((await inkling('--version')).stdout.trim(), pkg.version);
});
