/**
 * The Astro integration (`@swissspidy/hunch/astro`): builds the catalog from the pages Astro
 * emitted, writes `manifest.json` and the shards into the build output, and loads the web
 * components on every page with the manifest preset (ADR 0006).
 *
 * ```js
 * import hunch from '@swissspidy/hunch/astro';
 * export default defineConfig({ integrations: [hunch({ include: ['/blog/*'] })] });
 * ```
 *
 * @module @swissspidy/hunch/astro
 */

import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroConfig, AstroIntegration, AstroIntegrationLogger } from 'astro';
import type { Quantization } from '../format/manifest.ts';
import { build } from '../node/build.ts';
import { hashProvider } from '../node/providers/hash.ts';
import { transformersProvider, type TransformersOptions } from '../node/providers/transformers.ts';
import type { EmbeddingProvider } from '../node/providers/types.ts';
import { parsePage } from '../node/sources/sitemap.ts';
import type { CatalogItem } from '../node/types.ts';
import {
  checkOut,
  matcher,
  outDir,
  pagePath,
  readPage,
  resolveImage,
  type PathFilter,
} from './pages.ts';

export type { PathFilter } from './pages.ts';

/** A built page, as the `page` option receives it. */
export interface PageContext {
  /** The page's path without the site's `base`, as filters see it (e.g. `/blog/post/`). */
  path: string;
  /** The built HTML. */
  html: string;
}

/** What the `items` option receives. */
export interface ItemsContext {
  /** The built pages that passed the filters, as catalog items. */
  pages: CatalogItem[];
  /** The build output directory. */
  dir: URL;
  /** Astro's resolved config. */
  config: AstroConfig;
}

/** Options of the integration. Without any, every built page goes into the catalog. */
export interface HunchAstroOptions {
  /** Pages to include (default: all). */
  include?: PathFilter;
  /** Pages to leave out (default: none; 404 and 500 pages are always left out). */
  exclude?: PathFilter;
  /** Adjusts a page's item (its section, say), or drops it by returning `null`. */
  page?: (item: CatalogItem, page: PageContext) => CatalogItem | null | undefined;
  /** The catalog, in full: replaces the built pages (which it receives). */
  items?: (context: ItemsContext) => readonly CatalogItem[] | Promise<readonly CatalogItem[]>;
  /** Directory in the build output for `manifest.json` and the shards (default `hunch`). */
  out?: string;
  /** `transformers` (EmbeddingGemma; the default), `hash` (tests, offline), or a provider. */
  provider?: 'transformers' | 'hash' | EmbeddingProvider;
  /** Options of the `transformers` provider. */
  transformers?: TransformersOptions;
  /**
   * Embedding cache, relative to the project root (default `node_modules/.cache/hunch`);
   * `false` for none. Keep it between builds (in CI too) and only changed pages are embedded.
   */
  cacheDir?: string | false;
  /** Published dimensions, at most the model's (default 256, or the model's if smaller). */
  dims?: number;
  /** How the shards store vector components (default `int8`). */
  quantization?: Quantization;
  /** One shard per section (default), or a single shard. */
  shardBy?: 'section' | 'none';
  /** Most items in a shard (default 2000); larger sections are spread over several. */
  maxShardItems?: number;
  /** Characters of item text embedded (default 4000). */
  maxTextChars?: number;
  /** Load the web components on every page (default `true`). */
  script?: boolean;
}

const VIRTUAL = 'virtual:hunch/config';
const ALWAYS_EXCLUDED = [/^\/(404|500)\/?$/];

/**
 * The integration: add it to `integrations` in `astro.config.mjs`. After `astro build` the
 * catalog is in `dist/<out>/`; with `script`, every page loads the web components.
 */
export default function hunch(options: HunchAstroOptions = {}): AstroIntegration {
  const out = checkOut(options.out);
  let config: AstroConfig;
  return {
    name: '@swissspidy/hunch',
    hooks: {
      'astro:config:setup': ({ updateConfig, injectScript }) => {
        if (options.script === false) return;
        // Read when the module loads, after every integration had its say on `base`.
        const manifest = () => `${withSlash(config.base)}${out}/manifest.json`;
        updateConfig({ vite: { plugins: [configModule(manifest)] } });
        // The config module runs first: the components read the manifest as they register.
        injectScript('page', `import '${VIRTUAL}';\nimport '@swissspidy/hunch/elements';`);
      },
      'astro:config:done': ({ config: doneConfig }) => {
        config = doneConfig;
      },
      'astro:server:setup': ({ server, logger }) => {
        // Serve the last build's vectors, if there is one: `astro dev` builds no catalog.
        // Where astro:build:done wrote it: the output directory, or for a site with on-demand
        // pages, its client directory.
        const prefix = `${withSlash(config.base)}${out}/`;
        const roots = [outDir(config.outDir, out), outDir(config.build.client, out)];
        let warned = false;
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          if (!path?.startsWith(prefix)) return next();
          // Small files, read synchronously: this is the dev server.
          const file = roots
            .map((root) => new URL(path.slice(prefix.length), root))
            .find((url, i) => url.href.startsWith(roots[i]!.href) && isFile(url));
          if (!file) {
            if (!warned) {
              warned = true;
              logger.warn(
                `no ${out}/ in ${fileURLToPath(config.outDir)}: run astro build to see recommendations in dev`,
              );
            }
            return next();
          }
          const type =
            extname(file.pathname) === '.json' ? 'application/json' : 'application/octet-stream';
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
          res.end(readFileSync(file));
        });
      },
      'astro:build:done': async ({ pages, dir, logger }) => {
        const started = performance.now();
        const built = await builtPages(pages, dir, config, options, logger);
        const items = options.items ? await options.items({ pages: built, dir, config }) : built;
        if (items.length === 0) {
          logger.warn('no pages for the catalog: nothing to embed');
          return;
        }
        const provider = resolveProvider(options);
        try {
          const result = await build({
            items,
            outDir: fileURLToPath(outDir(dir, out)),
            provider,
            dims: options.dims,
            quantization: options.quantization,
            shardBy: options.shardBy,
            maxShardItems: options.maxShardItems,
            maxTextChars: options.maxTextChars,
            cacheDir:
              options.cacheDir === false
                ? false
                : resolve(
                    fileURLToPath(config.root),
                    options.cacheDir ?? 'node_modules/.cache/hunch',
                  ),
            log: (message) => logger.info(message),
          });
          logger.info(
            `${out}/manifest.json: ${result.manifest.count} items, ${result.manifest.shards.length} shards; ` +
              `${result.embedded} embedded, ${result.cached} cached, ${Math.round(performance.now() - started)} ms`,
          );
        } finally {
          if (typeof options.provider !== 'object') await provider.dispose?.();
        }
      },
    },
  };
}

/** The catalog items of the built pages, filtered, in path order. */
async function builtPages(
  pages: readonly { pathname: string }[],
  dir: URL,
  config: AstroConfig,
  options: HunchAstroOptions,
  logger: AstroIntegrationLogger,
): Promise<CatalogItem[]> {
  const include = options.include === undefined ? () => true : matcher(options.include);
  const exclude = options.exclude === undefined ? () => false : matcher(options.exclude);
  const base = withSlash(config.base);
  const items: CatalogItem[] = [];
  const paths = pages
    .map((page) => `/${page.pathname.replace(/^\/+/, '')}`)
    .filter(
      (path) => !ALWAYS_EXCLUDED.some((re) => re.test(path)) && include(path) && !exclude(path),
    )
    .sort();
  for (const path of new Set(paths)) {
    const page = await readPage(dir, path, config.build.format);
    if (!page) {
      logger.debug(`${path}: no HTML file (rendered on demand?), left out`);
      continue;
    }
    // The id and link are the page's path with the base, as `Astro.url.pathname` gives it.
    const id = pagePath(base, path, page.flat, config.trailingSlash);
    const parsed = parsePage(id, page.html);
    const item = parsed.image ? { ...parsed, image: resolveImage(parsed.image, id) } : parsed;
    const adjusted = options.page ? options.page(item, { path, html: page.html }) : item;
    if (adjusted) items.push(adjusted);
  }
  return items;
}

function resolveProvider(options: HunchAstroOptions): EmbeddingProvider {
  const provider = options.provider ?? 'transformers';
  if (provider === 'transformers') return transformersProvider(options.transformers);
  if (provider === 'hash') return hashProvider();
  if (typeof provider === 'object' && typeof provider.embed === 'function') return provider;
  throw new Error(`hunch: provider is transformers, hash or a provider, not ${String(provider)}`);
}

/** The module that sets `window.HunchConfig.manifest`, unless the page set one. */
function configModule(manifest: () => string) {
  const resolved = `\0${VIRTUAL}`;
  return {
    name: 'hunch:config',
    resolveId: (id: string) => (id === VIRTUAL ? resolved : undefined),
    load: (id: string) =>
      id === resolved
        ? `globalThis.HunchConfig = { manifest: ${JSON.stringify(manifest())}, ...globalThis.HunchConfig };\n`
        : undefined,
  };
}

function isFile(url: URL): boolean {
  try {
    return statSync(url).isFile();
  } catch {
    return false;
  }
}

function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}
