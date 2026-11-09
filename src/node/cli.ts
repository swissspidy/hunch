/** The `hunch` command line. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertManifest, type Quantization } from '../format/manifest.ts';
import { build } from './build.ts';
import { hashProvider } from './providers/hash.ts';
import { transformersProvider } from './providers/transformers.ts';
import type { EmbeddingProvider } from './providers/types.ts';
import { loadSource, type SourceKind } from './sources/index.ts';
import type { CatalogItem } from './types.ts';

const HELP = `Usage: hunch <command> [options]

Commands:
  build     Embed a catalog and write manifest.json and vector shards
  inspect   Summarize a manifest (a file or URL)

hunch build --source <file|url> [--source …] --out <dir> [options]
  --source <file|url>     JSON, RSS/Atom, sitemap, or a loader module (.js/.mjs/.ts)
  --source-kind <kind>    json | feed | sitemap | module (default: detected)
  --limit <n>             For sitemaps: pages to fetch at most
  --out <dir>             Output directory (default: hunch)
  --provider <name|file>  transformers (default) | hash | a provider module
  --model <id>            Transformers.js model (default: EmbeddingGemma)
  --revision <commit>     Pinned model revision
  --dtype <dtype>         Weights variant: fp32 | q8 (default) | q4 (experimental, smaller)
  --native-dims <n>       Output size of a model other than EmbeddingGemma
  --dims <n>              Published dimensions (Matryoshka truncation; default 256)
  --quantization <q>      int8 (default) | float32
  --shard-by <how>        section (default) | none
  --max-shard-items <n>   Most items in a shard (default 2000)
  --cache-dir <dir>       Embedding cache (default: .hunch-cache)
  --no-cache              Embed everything, keep nothing
  --quiet                 Print nothing but errors
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'build':
        await buildCommand(rest);
        return 0;
      case 'inspect':
        await inspectCommand(rest);
        return 0;
      case '--version':
      case '-v': {
        const pkg = JSON.parse(
          await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
        ) as { version: string };
        console.log(pkg.version);
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return command === undefined ? 1 : 0;
      default:
        console.error(`Unknown command ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    console.error(`hunch: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function buildCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      source: { type: 'string', multiple: true },
      'source-kind': { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string', default: 'hunch' },
      provider: { type: 'string', default: 'transformers' },
      model: { type: 'string' },
      revision: { type: 'string' },
      dtype: { type: 'string' },
      'native-dims': { type: 'string' },
      dims: { type: 'string' },
      quantization: { type: 'string', default: 'int8' },
      'shard-by': { type: 'string', default: 'section' },
      'max-shard-items': { type: 'string' },
      'cache-dir': { type: 'string', default: '.hunch-cache' },
      'no-cache': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
  });
  if (!values.source?.length) throw new Error('build needs at least one --source');
  const quantization = values.quantization as Quantization;
  if (quantization !== 'int8' && quantization !== 'float32') {
    throw new Error(`--quantization is int8 or float32, not ${quantization}`);
  }
  const shardBy = values['shard-by'];
  if (shardBy !== 'section' && shardBy !== 'none') {
    throw new Error(`--shard-by is section or none, not ${shardBy}`);
  }
  const log = values.quiet ? () => {} : (message: string) => console.error(message);

  const items: CatalogItem[] = [];
  for (const source of values.source) {
    const loaded = await loadSource(source, {
      kind: values['source-kind'] as SourceKind | undefined,
      limit: int(values.limit, '--limit'),
    });
    log(`${source}: ${loaded.length} items`);
    items.push(...loaded);
  }

  const provider = await resolveProvider(values.provider, {
    model: values.model,
    revision: values.revision,
    dtype: values.dtype,
    nativeDims: int(values['native-dims'], '--native-dims'),
  });
  try {
    const started = performance.now();
    const result = await build({
      items,
      outDir: values.out,
      provider,
      dims: int(values.dims, '--dims'),
      quantization,
      shardBy,
      maxShardItems: int(values['max-shard-items'], '--max-shard-items'),
      cacheDir: values['no-cache'] ? false : values['cache-dir'],
      log,
    });
    const m = result.manifest;
    log(
      `${values.out}/manifest.json: ${m.count} items, ${m.shards.length} shards, ` +
        `${kb(result.bytes)} (${m.dims} dims, ${m.quantization}); ` +
        `${result.embedded} embedded, ${result.cached} cached, ` +
        `${Math.round(performance.now() - started)} ms`,
    );
  } finally {
    await provider.dispose?.();
  }
}

async function resolveProvider(
  name: string,
  options: { model?: string; revision?: string; dtype?: string; nativeDims?: number },
): Promise<EmbeddingProvider> {
  if (name === 'transformers') return transformersProvider(options);
  if (name === 'hash') return hashProvider(options.nativeDims);
  if (!/\.(m?js|ts)$/.test(name)) {
    throw new Error(`--provider is transformers, hash or a module file, not ${name}`);
  }
  const mod = (await import(pathToFileURL(resolve(name)).href)) as { default?: unknown };
  const exported = mod.default;
  const provider = (
    typeof exported === 'function' ? await (exported as () => unknown)() : exported
  ) as EmbeddingProvider | undefined;
  if (!provider || typeof provider.embed !== 'function' || !provider.model) {
    throw new Error(`${name}: the default export is not an embedding provider`);
  }
  return provider;
}

async function inspectCommand(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true });
  const target = positionals[0] ?? 'hunch/manifest.json';
  let text: string;
  if (/^https?:\/\//.test(target)) {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${target} returned ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(target, 'utf8');
  }
  const manifest: unknown = JSON.parse(text);
  assertManifest(manifest);
  console.log(`version     ${manifest.version} (${manifest.generatedAt})`);
  console.log(`model       ${manifest.model.id}@${manifest.model.revision}`);
  console.log(
    `vectors     ${manifest.dims} of ${manifest.model.nativeDims} dims, ${manifest.quantization}`,
  );
  console.log(`items       ${manifest.count}`);
  for (const shard of manifest.shards) {
    console.log(
      `  ${(shard.section ?? '(none)').padEnd(20)} ${String(shard.count).padStart(6)}  ${kb(shard.bytes).padStart(9)}  ${shard.url}`,
    );
  }
  const total = manifest.shards.reduce((sum, s) => sum + s.bytes, 0);
  console.log(`total       ${kb(total)}`);
}

function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} is a positive integer, not ${value}`);
  return n;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
