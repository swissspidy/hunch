/**
 * The package as a consumer gets it: packed, installed into an empty project, imported, and its
 * CLI run. Slow (it builds and installs); `npm run test:pack`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
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
  let tarball: string;
  // The release tests the tarball it publishes (HUNCH_TARBALL_DIR holds it); otherwise pack one.
  const packed = process.env.HUNCH_TARBALL_DIR;
  if (packed) {
    const names = (await readdir(packed)).filter((name) => name.endsWith('.tgz'));
    assert.equal(names.length, 1, `one tarball in ${packed}, not ${names.length}`);
    tarball = resolve(packed, names[0]!);
    const { stdout } = await run('tar', ['-tzf', tarball], { maxBuffer: 1 << 24 });
    files = stdout
      .split('\n')
      .filter((path) => path && !path.endsWith('/'))
      .map((path) => path.replace(/^package\//, ''))
      .sort();
  } else {
    const { stdout } = await run(npm, ['pack', '--json', '--pack-destination', work], {
      shell: process.platform === 'win32',
      maxBuffer: 1 << 24,
    });
    const [info] = JSON.parse(stdout.slice(stdout.indexOf('['))) as {
      filename: string;
      files: { path: string }[];
    }[];
    files = info!.files.map((f) => f.path).sort();
    tarball = resolve(work, info!.filename);
  }
  project = join(work, 'consumer');
  await cp('test/fixtures/consumer', project, { recursive: true });
  await run(npm, ['install', '--no-audit', '--no-fund', tarball], {
    cwd: project,
    shell: process.platform === 'win32',
  });
});

test('the package holds dist, bin and the docs, and no sources or tests', () => {
  assert.ok(files.includes('bin/hunch.js'));
  assert.ok(files.includes('dist/client/index.js'));
  assert.ok(files.includes('dist/client/index.d.ts'));
  assert.ok(files.includes('dist/hunch.global.js'));
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

test('the Astro integration loads without Astro installed', async () => {
  assert.ok(files.includes('dist/astro/index.js'));
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import hunch from '@swissspidy/hunch/astro';
const integration = hunch({ provider: 'hash' });
console.log(integration.name, Object.keys(integration.hooks).join(','));`,
    ],
    { cwd: project },
  );
  assert.equal(
    stdout.trim(),
    '@swissspidy/hunch astro:config:setup,astro:config:done,astro:server:setup,astro:build:done',
  );
});

test('the installed CLI builds a catalog, and the client ranks it', async () => {
  await run(
    process.execPath,
    [
      'node_modules/@swissspidy/hunch/bin/hunch.js',
      'build',
      '--source',
      'catalog.json',
      '--out',
      'public/hunch',
      '--provider',
      'hash',
      '--no-cache',
      '--quiet',
    ],
    { cwd: project },
  );
  const manifest = JSON.parse(await readFile(join(project, 'public/hunch/manifest.json'), 'utf8'));
  assert.equal(manifest.count, 4);
  const { stdout } = await run(process.execPath, ['related.mjs'], { cwd: project });
  assert.equal(stdout.trim(), 'banana-bread');
});

test('the library typechecks from a consumer', async () => {
  await writeFile(
    join(project, 'check.ts'),
    `import { Hunch, type Recommendation } from '@swissspidy/hunch';
import { build, hashProvider, type CatalogItem } from '@swissspidy/hunch/build';
import { HunchRelatedElement } from '@swissspidy/hunch/elements';
const items: CatalogItem[] = [];
void build({ items, outDir: 'x', provider: hashProvider() });
const r: Promise<Recommendation[]> = Hunch.load({ manifest: '/m.json' }).then((i) => i.related('a'));
void r;
void HunchRelatedElement;
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
    `import { Hunch } from '@swissspidy/hunch';
import { HunchRelatedElement } from '@swissspidy/hunch/elements';
import { decodeShard, encodeShard } from '@swissspidy/hunch/format';
void Hunch;
void HunchRelatedElement;
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
