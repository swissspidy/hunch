import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '../helpers.ts';

const run = promisify(execFile);
const hunch = (...args: string[]) => run(process.execPath, ['bin/hunch.js', ...args]);

test('hunch build, then hunch inspect', async () => {
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
  const first = await hunch(...args);
  assert.match(first.stderr, /demo\/feed\.xml: 32 items/);
  assert.match(first.stderr, /32 items, 4 shards, .* \(128 dims, int8\); 32 embedded, 0 cached/);
  const second = await hunch(...args);
  assert.match(second.stderr, /0 embedded, 32 cached/);

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.model.id, 'hunch/hash');
  const { stdout } = await hunch('inspect', join(out, 'manifest.json'));
  assert.match(stdout, /model +hunch\/hash@1/);
  assert.match(stdout, /vectors +128 of 512 dims, int8/);
  assert.match(stdout, /Food +8 /);
});

test('errors are one line and exit 1', async () => {
  await assert.rejects(hunch('build', '--out', 'x'), (e: { code: number; stderr: string }) => {
    assert.equal(e.code, 1);
    assert.equal(e.stderr, 'hunch: build needs at least one --source\n');
    return true;
  });
  await assert.rejects(
    hunch('build', '--source', 'demo/feed.xml', '--quantization', 'int4'),
    /int8 or float32/,
  );
  await assert.rejects(hunch('nope'), /Unknown command nope/);
});

test('hunch --version prints the package version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal((await hunch('--version')).stdout.trim(), pkg.version);
});

test('hunch inspect fails on an HTTP error, whatever the body', async () => {
  // A body that looks like a manifest: only the status says it isn't one.
  const body = JSON.stringify({ format: 'hunch/manifest' });
  const server = createServer((_req, res) => res.writeHead(404).end(body));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await assert.rejects(
      hunch('inspect', `http://127.0.0.1:${port}/manifest.json`),
      /returned 404/,
    );
  } finally {
    server.close();
  }
});
