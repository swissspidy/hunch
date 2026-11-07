import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { Fetch } from '../src/client/catalog.ts';
import { hashProvider } from '../src/node/providers/hash.ts';
import type { EmbeddingProvider } from '../src/node/providers/types.ts';

const dirs: string[] = [];
// Registered at the top level: an after() inside a hook would run when the hook ends.
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A fresh temporary directory, removed after the test file. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hunch-'));
  dirs.push(dir);
  return dir;
}

/** The hash provider, counting the inputs it embeds. */
export function countingProvider(dims?: number): EmbeddingProvider & { calls: string[] } {
  const inner = hashProvider(dims);
  const calls: string[] = [];
  return {
    model: inner.model,
    calls,
    embed(inputs) {
      calls.push(...inputs);
      return inner.embed(inputs);
    },
  };
}

/** `fetch` over a directory: `http://site/<path>` reads `<dir>/<path>`, and logs each URL. */
export function dirFetch(dir: string, log: string[] = []): Fetch {
  return async (input) => {
    const url = new URL(input);
    log.push(url.pathname);
    try {
      return new Response(await readFile(join(dir, url.pathname)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}
