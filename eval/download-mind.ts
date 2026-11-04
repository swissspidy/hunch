/**
 * Downloads MIND small (the dev set, and the training clicks for popularity) for the evaluation.
 *
 *   node eval/download-mind.ts --accept-license [--out eval/.data/mind]
 *
 * MIND is licensed under the Microsoft Research License Terms
 * (https://github.com/msnews/MIND/blob/master/MSR%20License_Data.pdf): non-commercial research
 * use. Its original download no longer allows public access; this fetches the unmodified files
 * from a mirror on Hugging Face and checks them against their SHA-256. They are not committed.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const MIRROR = 'https://huggingface.co/datasets/huyva/MIND-small/resolve/main';
const FILES: Record<string, string> = {
  'dev/news.tsv': 'e5d144667558c449d16084fe6bfa01940c2f5d5785ea9f9110292bc3b94eb822',
  'dev/behaviors.tsv': 'b6c460e33b1a8693252ded6e626da7d3ccf78920eea2ec11889020bb7d8443ef',
  'train/behaviors.tsv': 'a424547c8fa17c9ea4879c2110221c2b2f2709f4f7615ede0b0d8e4765158658',
};

const { values } = parseArgs({
  options: {
    'accept-license': { type: 'boolean', default: false },
    out: { type: 'string', default: 'eval/.data/mind' },
  },
});
if (!values['accept-license']) {
  console.error(
    'MIND is licensed under the Microsoft Research License Terms (non-commercial research):\n' +
      'https://github.com/msnews/MIND/blob/master/MSR%20License_Data.pdf\n' +
      'Read them, then run again with --accept-license.',
  );
  process.exit(1);
}

for (const [path, sha256] of Object.entries(FILES)) {
  const target = join(values.out, path);
  const existing = await readFile(target).catch(() => undefined);
  if (existing && hash(existing) === sha256) {
    console.error(`${path}: already there`);
    continue;
  }
  console.error(`${path}: downloading`);
  const response = await fetch(`${MIRROR}/${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} from the mirror`);
  const body = Buffer.from(await response.arrayBuffer());
  if (hash(body) !== sha256) throw new Error(`${path}: SHA-256 does not match the MIND release`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}
console.error(`MIND small is in ${values.out}`);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
