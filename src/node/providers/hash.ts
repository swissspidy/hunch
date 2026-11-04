/**
 * A deterministic, dependency-free lexical embedding: signed feature hashing of word unigrams
 * and bigrams with log term frequency. It is not a semantic model; it exists so tests, CI and
 * offline builds run without downloading one, and as a baseline in evaluations.
 */

import { hashEmbed } from '../../rank/hash.ts';
import type { EmbeddingProvider } from './types.ts';

export function hashProvider(nativeDims = 512): EmbeddingProvider {
  return {
    model: {
      id: 'inkling/hash',
      revision: '1',
      nativeDims,
      documentPrompt: '{title}\n{title}\n{text}',
      queryPrompt: '{query}',
    },
    embed: (inputs) => Promise.resolve(inputs.map((input) => hashEmbed(input, nativeDims))),
  };
}
