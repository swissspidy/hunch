/**
 * A deterministic, dependency-free lexical embedding: signed feature hashing of word unigrams
 * and bigrams with log term frequency. It is not a semantic model; it exists so tests, CI and
 * offline builds run without downloading one, and as a baseline in evaluations.
 */

import type { EmbeddingProvider } from './types.ts';

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have in is it its of on or that the this to was ' +
    'were will with not no none title text they their them you your we our i he she his her'
  ).split(' '),
);

export function hashProvider(nativeDims = 512): EmbeddingProvider {
  return {
    model: {
      id: 'inkling/hash',
      revision: '1',
      nativeDims,
      documentPrompt: '{title}\n{title}\n{text}',
    },
    embed: (inputs) => Promise.resolve(inputs.map((input) => hashEmbed(input, nativeDims))),
  };
}

function hashEmbed(input: string, dims: number): Float32Array {
  const words = (
    input
      .toLowerCase()
      .normalize('NFKD')
      .match(/\p{L}[\p{L}\p{N}]*|\p{N}+/gu) ?? []
  )
    .map(stem)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const counts = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    counts.set(words[i]!, (counts.get(words[i]!) ?? 0) + 1);
    if (i > 0) {
      const bigram = `${words[i - 1]} ${words[i]}`;
      counts.set(bigram, (counts.get(bigram) ?? 0) + 0.5);
    }
  }
  const v = new Float32Array(dims);
  for (const [term, count] of counts) {
    const h = murmur(term);
    v[h % dims]! += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(count));
  }
  return v;
}

function stem(word: string): string {
  return word.length > 4 ? word.replace(/(ing|ies|es|ed|s)$/, '') : word;
}

/** MurmurHash3's 32-bit finalizer over FNV-1a: well-mixed and stable across platforms. */
function murmur(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
