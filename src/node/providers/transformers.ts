/**
 * EmbeddingGemma (or another sentence-embedding model) through Transformers.js, on the build
 * machine. `@huggingface/transformers` is an optional peer dependency: it is imported only when
 * an input misses the embedding cache, so cached builds and the client never load it.
 */

import type { EmbeddingProvider } from './types.ts';

/** EmbeddingGemma, the default model: its pinned revision, sizes and prompts. */
export const EMBEDDING_GEMMA = {
  /** The model's id on the Hugging Face Hub. */
  id: 'onnx-community/embeddinggemma-300m-ONNX',
  /** Pinned: the vectors of a space must never change under it. */
  revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
  /** The model's output size. */
  nativeDims: 768,
  /** The sizes the model was trained to be truncated to. */
  matryoshkaDims: [768, 512, 256, 128],
  /** How an item becomes the model's input. */
  documentPrompt: 'title: {title} | text: {text}',
  /** How a search query becomes the model's input. */
  queryPrompt: 'task: search result | query: {query}',
} as const;

/** Options for {@link transformersProvider}. */
export interface TransformersOptions {
  /** Model id on the Hugging Face Hub (default: EmbeddingGemma). */
  model?: string;
  /** Pinned revision (a commit hash); required for models other than EmbeddingGemma. */
  revision?: string;
  /** Weights variant, e.g. `fp32`, `q8`, `q4` (default `q8`). */
  dtype?: string;
  /** Required for models other than EmbeddingGemma. */
  nativeDims?: number;
  /** Template for items, `{title}` and `{text}` replaced (default: EmbeddingGemma's). */
  documentPrompt?: string;
  /** Template for search queries (`{query}`), published for the browser's query embedder. */
  queryPrompt?: string;
  /** Inputs per forward pass (default 8). */
  batchSize?: number;
  /** Truncate inputs to this many tokens (default 2048, EmbeddingGemma's context). */
  maxTokens?: number;
}

interface Tensor {
  dims: number[];
  data: Float32Array;
}
interface TransformersModule {
  AutoTokenizer: { from_pretrained(id: string, options: object): Promise<Tokenizer> };
  AutoModel: { from_pretrained(id: string, options: object): Promise<Model> };
}
type Tokenizer = (texts: string[], options: object) => Record<string, unknown>;
interface Model {
  (inputs: Record<string, unknown>): Promise<Record<string, Tensor | undefined>>;
  dispose?(): Promise<unknown>;
}

/**
 * A provider that embeds with a sentence-embedding model through Transformers.js (an optional
 * peer dependency, imported only when an input misses the embedding cache).
 */
export function transformersProvider(options: TransformersOptions = {}): EmbeddingProvider {
  const isGemma = !options.model || options.model === EMBEDDING_GEMMA.id;
  const id = options.model ?? EMBEDDING_GEMMA.id;
  const revision = options.revision ?? (isGemma ? EMBEDDING_GEMMA.revision : undefined);
  if (!revision) throw new Error(`Pin a revision for ${id} (--revision <commit>)`);
  const nativeDims = options.nativeDims ?? (isGemma ? EMBEDDING_GEMMA.nativeDims : undefined);
  if (!nativeDims) throw new Error(`Give the output size of ${id} (--native-dims <n>)`);
  const dtype = options.dtype ?? 'q8';
  const batchSize = options.batchSize ?? 8;
  let loaded: Promise<{ tokenizer: Tokenizer; model: Model }> | undefined;

  const load = async (): Promise<{ tokenizer: Tokenizer; model: Model }> => {
    let mod: TransformersModule;
    try {
      // A variable, so TypeScript does not resolve the optional dependency.
      const specifier = '@huggingface/transformers';
      mod = (await import(specifier)) as TransformersModule;
    } catch (error) {
      throw new Error(
        'The transformers provider needs @huggingface/transformers: npm install -D @huggingface/transformers',
        { cause: error },
      );
    }
    const [tokenizer, model] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(id, { revision }),
      mod.AutoModel.from_pretrained(id, { revision, dtype }),
    ]);
    return { tokenizer, model };
  };

  return {
    model: {
      id,
      revision,
      dtype,
      nativeDims,
      documentPrompt:
        options.documentPrompt ?? (isGemma ? EMBEDDING_GEMMA.documentPrompt : '{title}\n{text}'),
      queryPrompt: options.queryPrompt ?? (isGemma ? EMBEDDING_GEMMA.queryPrompt : '{query}'),
    },
    matryoshkaDims: isGemma ? EMBEDDING_GEMMA.matryoshkaDims : undefined,
    async embed(inputs) {
      loaded ??= load();
      const { tokenizer, model } = await loaded;
      const out: Float32Array[] = [];
      for (let start = 0; start < inputs.length; start += batchSize) {
        const batch = inputs.slice(start, start + batchSize);
        const encoded = tokenizer(batch, {
          padding: true,
          truncation: true,
          max_length: options.maxTokens ?? 2048,
        });
        const result = await model(encoded);
        const tensor = result.sentence_embedding;
        if (!tensor) throw new Error(`${id} has no sentence_embedding output`);
        const width = tensor.dims[1]!;
        if (width !== nativeDims)
          throw new Error(`${id} returned ${width} dims, not ${nativeDims}`);
        for (let row = 0; row < batch.length; row++) {
          out.push(Float32Array.from(tensor.data.subarray(row * width, (row + 1) * width)));
        }
      }
      return out;
    },
    async dispose() {
      if (loaded) await (await loaded).model.dispose?.();
    },
  };
}
