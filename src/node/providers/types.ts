import type { ModelInfo } from '../../format/manifest.ts';

/**
 * Turns item texts into vectors. A provider is pinned: the same model info always yields the
 * same vectors, so its output can be cached and its space compared across builds.
 */
export interface EmbeddingProvider {
  /** The model, as the manifest names it. */
  readonly model: ModelInfo;
  /** Dimensions the model was trained to be truncated to (Matryoshka), if any. */
  readonly matryoshkaDims?: readonly number[];
  /** Embeds already-prompted inputs; returns one vector of `model.nativeDims` per input. */
  embed(inputs: readonly string[]): Promise<Float32Array[]>;
  /** Releases the model, if one was loaded. */
  dispose?(): Promise<void>;
}

/** Fills a model's document prompt with an item's title and text. */
export function documentInput(prompt: string, title: string, text: string): string {
  // Functions: in a replacement string, a `$&` or `$$` in a title or text would be a pattern.
  return prompt.replaceAll('{title}', () => title || 'none').replaceAll('{text}', () => text);
}
