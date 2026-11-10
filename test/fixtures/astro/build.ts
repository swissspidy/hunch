/** The fixture Astro site with the integration, from the sources: `astro build` and `astro dev`. */

import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, dev, type AstroInlineConfig } from 'astro';
import hunch, { type HunchAstroOptions } from '../../../src/astro/index.ts';
import { tempDir } from '../../helpers.ts';

const BUILDS = fileURLToPath(new URL('./.builds/', import.meta.url));

/**
 * A fresh output directory for a build, removed after the test file. It is inside the checkout
 * (and gitignored): for an `outDir` outside the working directory, Astro prerenders in
 * `<cwd>/.astro` instead, the same directory for every build, and two builds at once collide.
 */
export async function buildDir(): Promise<string> {
  await mkdir(BUILDS, { recursive: true });
  return tempDir(BUILDS);
}

function config(
  outDir: string,
  options: HunchAstroOptions,
  extra: AstroInlineConfig,
): AstroInlineConfig {
  return {
    root: fileURLToPath(new URL('./', import.meta.url)),
    configFile: false,
    outDir,
    site: 'https://example.com',
    logLevel: 'error',
    // The package's own entry point, from the sources rather than dist.
    vite: {
      resolve: {
        alias: {
          '@swissspidy/hunch/elements': fileURLToPath(
            new URL('../../../src/elements/index.ts', import.meta.url),
          ),
        },
      },
    },
    ...extra,
    // Others after Hunch's.
    integrations: [hunch({ provider: 'hash', ...options }), ...(extra.integrations ?? [])],
  };
}

export async function buildFixture(
  outDir: string,
  options: HunchAstroOptions,
  extra: AstroInlineConfig = {},
): Promise<void> {
  await build(config(outDir, options, extra));
}

/** `astro dev` on a free port; `outDir` is where the last build is. */
export async function devFixture(
  outDir: string,
  options: HunchAstroOptions,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  // An earlier `astro build` in this process left NODE_ENV at production, and Astro then skips
  // the integrations' dev server hooks.
  process.env.NODE_ENV = 'development';
  const server = await dev(config(outDir, options, { server: { port: 0, host: '127.0.0.1' } }));
  return { origin: `http://127.0.0.1:${server.address.port}`, stop: () => server.stop() };
}
