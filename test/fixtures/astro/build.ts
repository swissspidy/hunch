/** The fixture Astro site with the integration, from the sources: `astro build` and `astro dev`. */

import { fileURLToPath } from 'node:url';
import { build, dev, type AstroInlineConfig } from 'astro';
import inkling, { type InklingAstroOptions } from '../../../src/astro/index.ts';

function config(
  outDir: string,
  options: InklingAstroOptions,
  extra: AstroInlineConfig,
): AstroInlineConfig {
  return {
    root: fileURLToPath(new URL('./', import.meta.url)),
    configFile: false,
    outDir,
    site: 'https://example.com',
    logLevel: 'error',
    integrations: [inkling({ provider: 'hash', ...options })],
    // The package's own entry point, from the sources rather than dist.
    vite: {
      resolve: {
        alias: {
          '@swissspidy/inkling/elements': fileURLToPath(
            new URL('../../../src/elements/index.ts', import.meta.url),
          ),
        },
      },
    },
    ...extra,
  };
}

export async function buildFixture(
  outDir: string,
  options: InklingAstroOptions,
  extra: AstroInlineConfig = {},
): Promise<void> {
  await build(config(outDir, options, extra));
}

/** `astro dev` on a free port; `outDir` is where the last build is. */
export async function devFixture(
  outDir: string,
  options: InklingAstroOptions,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  // An earlier `astro build` in this process left NODE_ENV at production, and Astro then skips
  // the integrations' dev server hooks.
  process.env.NODE_ENV = 'development';
  const server = await dev(config(outDir, options, { server: { port: 0, host: '127.0.0.1' } }));
  return { origin: `http://127.0.0.1:${server.address.port}`, stop: () => server.stop() };
}
