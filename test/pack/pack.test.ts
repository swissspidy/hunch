/**
 * The package as a consumer gets it: packed, installed into an empty project, imported, and its
 * CLI run. Slow (it builds and installs); `npm run test:pack`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '../helpers.ts';

const run = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let project = '';
let files: string[] = [];

before(async () => {
  const work = await tempDir();
  const { stdout } = await run(npm, ['pack', '--json', '--pack-destination', work], {
    shell: process.platform === 'win32',
    maxBuffer: 1 << 24,
  });
  const [info] = JSON.parse(stdout.slice(stdout.indexOf('['))) as {
    filename: string;
    files: { path: string }[];
  }[];
  files = info!.files.map((f) => f.path).sort();
  project = join(work, 'consumer');
  await cp('test/fixtures/consumer', project, { recursive: true });
  await run(npm, ['install', '--no-audit', '--no-fund', resolve(work, info!.filename)], {
    cwd: project,
    shell: process.platform === 'win32',
  });
});

test('the package holds dist, bin and the docs, and no sources or tests', () => {
  assert.ok(files.includes('bin/inkling.js'));
  assert.ok(files.includes('dist/client/index.js'));
  assert.ok(files.includes('dist/client/index.d.ts'));
  assert.ok(files.includes('dist/inkling.global.js'));
  assert.ok(files.includes('dist/node/cli.js'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('LICENSE'));
  assert.deepEqual(
    files.filter(
      (f) =>
        /^(src|test|scripts|demo|wordpress)\//.test(f) ||
        (f.endsWith('.ts') && !f.endsWith('.d.ts')),
    ),
    [],
  );
});

test('the installed CLI builds a catalog, and the client ranks it', async () => {
  await run(
    process.execPath,
    [
      'node_modules/@swissspidy/inkling/bin/inkling.js',
      'build',
      '--source',
      'catalog.json',
      '--out',
      'public/inkling',
      '--provider',
      'hash',
      '--no-cache',
      '--quiet',
    ],
    { cwd: project },
  );
  const manifest = JSON.parse(
    await readFile(join(project, 'public/inkling/manifest.json'), 'utf8'),
  );
  assert.equal(manifest.count, 4);
  const { stdout } = await run(process.execPath, ['related.mjs'], { cwd: project });
  assert.equal(stdout.trim(), 'banana-bread');
});

test('the library typechecks from a consumer', async () => {
  await writeFile(
    join(project, 'check.ts'),
    `import { Inkling, type Recommendation } from '@swissspidy/inkling';
import { build, hashProvider, type CatalogItem } from '@swissspidy/inkling/build';
import { InklingRelatedElement } from '@swissspidy/inkling/elements';
const items: CatalogItem[] = [];
void build({ items, outDir: 'x', provider: hashProvider() });
const r: Promise<Recommendation[]> = Inkling.load({ manifest: '/m.json' }).then((i) => i.related('a'));
void r;
void InklingRelatedElement;
`,
  );
  const tsc = resolve('node_modules/typescript/bin/tsc');
  await run(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--strict',
      '--module',
      'nodenext',
      '--target',
      'es2022',
      '--lib',
      'es2024,dom',
      '--types',
      'node',
      '--typeRoots',
      resolve('node_modules/@types'),
      'check.ts',
    ],
    { cwd: project },
  );
});

test('the browser entry points typecheck without Node.js types', async () => {
  await writeFile(
    join(project, 'check-browser.ts'),
    `import { Inkling } from '@swissspidy/inkling';
import { InklingRelatedElement } from '@swissspidy/inkling/elements';
import { decodeShard, encodeShard } from '@swissspidy/inkling/format';
void Inkling;
void InklingRelatedElement;
void decodeShard;
void encodeShard;
`,
  );
  await writeFile(
    join(project, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'nodenext',
        target: 'es2022',
        lib: ['es2024', 'dom'],
        // No ambient types at all: a Node.js type in the browser declarations would fail here.
        types: [],
      },
      files: ['check-browser.ts'],
    }),
  );
  await run(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.browser.json'],
    {
      cwd: project,
    },
  );
});
