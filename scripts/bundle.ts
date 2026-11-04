/** esbuild bundles of the client: the script-tag build, and the core for the size budget. */

import { build, type BuildOptions } from 'esbuild';

const common: BuildOptions = {
  bundle: true,
  minify: true,
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'warning',
};

/** `inkling.global.js`: the client as `window.Inkling` and the web components registered. */
export async function bundleGlobal(outfile: string): Promise<void> {
  await build({ ...common, entryPoints: ['src/elements/global.ts'], format: 'iife', outfile });
}

/** A minified ESM bundle of an entry point, in memory. */
export async function bundleEsm(entry: string): Promise<Uint8Array> {
  const result = await build({ ...common, entryPoints: [entry], format: 'esm', write: false });
  return result.outputFiles[0]!.contents;
}
