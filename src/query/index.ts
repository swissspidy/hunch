/**
 * Free-text search on the device (`@swissspidy/hunch/query`): embeds a query with the catalog's
 * own pinned model, in the browser, so it lands in the same space as the published vectors.
 * Optional and lazy: nothing here loads until a site asks, and the core never imports it.
 *
 * ```js
 * const embedder = await createQueryEmbedder(hunch.manifest, {
 *   transformers: () => import('@huggingface/transformers'),
 * });
 * const results = await hunch.search(await embedder.embed('night trains'), { n: 5 });
 * ```
 *
 * The query text never leaves the device. The model's weights are fetched once (from the
 * Hugging Face Hub unless the site hosts them, see `configure`) and kept in the browser's cache
 * by Transformers.js; the requests carry no query or profile data.
 *
 * @module @swissspidy/hunch/query
 */

import type { Manifest } from '../format/manifest.ts';
import { hashEmbed } from '../rank/hash.ts';
import { normalize } from '../rank/vector.ts';

/** Files of q4 weights that browsers can run, per model (see `EMBEDDING_GEMMA.files`). */
const Q4_FILES: Record<string, string | undefined> = {
  'onnx-community/embeddinggemma-300m-ONNX': 'model_no_gather',
};

/** Embeds search queries into the catalog's space. */
export interface QueryEmbedder {
  /** The model the vectors come from (the manifest's). */
  readonly model: string;
  /** A unit vector in the catalog's space (the manifest's `dims`), cached per query. */
  embed(query: string): Promise<Float32Array>;
  /** Releases the model. */
  dispose(): Promise<void>;
}

/** A model output tensor, as far as this module reads it. */
export interface TransformersTensor {
  /** The tensor's shape. */
  dims: number[];
  /** The tensor's values, row-major. */
  data: Float32Array;
}
/** A Transformers.js model, as far as this module uses it. */
export interface TransformersModel {
  /** Runs the model on tokenized inputs. */
  (inputs: Record<string, unknown>): Promise<Record<string, TransformersTensor | undefined>>;
  /** Releases the model. */
  dispose?(): Promise<unknown>;
}
/** A Transformers.js tokenizer, as far as this module uses it. */
export type TransformersTokenizer = (texts: string[], options: object) => Record<string, unknown>;
/** The part of `@huggingface/transformers` this module uses. */
export interface TransformersModule {
  /** Loads the model's tokenizer. */
  AutoTokenizer: {
    /** Loads a tokenizer from the Hub (or the configured host). */
    from_pretrained(id: string, options: object): Promise<TransformersTokenizer>;
  };
  /** Loads the model. */
  AutoModel: {
    /** Loads a model from the Hub (or the configured host). */
    from_pretrained(id: string, options: object): Promise<TransformersModel>;
  };
  /** Transformers.js's settings, passed to `configure`. */
  env?: object;
}

/** Options for {@link createQueryEmbedder}. */
export interface QueryEmbedderOptions {
  /**
   * Transformers.js, or a function that imports it. The default imports the bare specifier
   * `@huggingface/transformers` at run time, which bundlers leave alone: it works in Node and
   * with an import map, so bundled sites pass `() => import('@huggingface/transformers')`.
   * Script-tag sites pass e.g.
   * `() => import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2')`.
   */
  transformers?: TransformersModule | (() => Promise<TransformersModule>);
  /**
   * Weights variant (default: the manifest's, e.g. `q8`). A smaller variant of the same model,
   * such as `q4`, downloads less; ADR 0005 measures how little it changes the results.
   */
  dtype?: string;
  /** `wasm` (default) or `webgpu`. */
  device?: string;
  /** Adjusts Transformers.js's `env` first, e.g. to load the weights from the site itself. */
  configure?: (env: object) => void;
  /** Queries kept in memory (default 100). Never stored on the device. */
  cacheSize?: number;
}

/** A query embedder for the manifest's model: in plain JavaScript for `hunch/hash`, else Transformers.js. */
export async function createQueryEmbedder(
  manifest: Manifest,
  options: QueryEmbedderOptions = {},
): Promise<QueryEmbedder> {
  const { model, dims } = manifest;
  const prompt = model.queryPrompt ?? '{query}';
  const input = (query: string) => prompt.replaceAll('{query}', () => query.trim());
  let embedFull: (text: string) => Promise<Float32Array>;
  let dispose: () => Promise<void> = () => Promise.resolve();

  if (model.id === 'hunch/hash') {
    embedFull = (text) => Promise.resolve(hashEmbed(text, model.nativeDims));
  } else {
    const loaded =
      typeof options.transformers === 'function'
        ? await options.transformers()
        : options.transformers;
    // A variable, so neither TypeScript nor a bundler tries to resolve the optional dependency.
    const specifier = '@huggingface/transformers';
    const mod = loaded ?? ((await import(/* @vite-ignore */ specifier)) as TransformersModule);
    if (mod.env && options.configure) options.configure(mod.env);
    const dtype = options.dtype ?? model.dtype;
    const settings: Record<string, string | undefined> = { revision: model.revision, dtype };
    // The catalog's own file, or for another variant the one browsers can run (EmbeddingGemma's
    // q4 file needs an operator browsers' ONNX Runtime lacks).
    const file =
      dtype === model.dtype ? model.file : options.dtype === 'q4' ? Q4_FILES[model.id] : undefined;
    if (file) settings.model_file_name = file;
    if (options.device) settings.device = options.device;
    const [tokenizerResult, netResult] = await Promise.allSettled([
      mod.AutoTokenizer.from_pretrained(model.id, { revision: model.revision }),
      mod.AutoModel.from_pretrained(model.id, settings),
    ]);
    if (tokenizerResult.status === 'rejected') {
      // Release a model that loaded anyway, then report the tokenizer's error.
      if (netResult.status === 'fulfilled') await netResult.value.dispose?.();
      throw tokenizerResult.reason;
    }
    if (netResult.status === 'rejected') throw netResult.reason;
    const tokenizer = tokenizerResult.value;
    const net = netResult.value;
    embedFull = async (text) => {
      const result = await net(tokenizer([text], { padding: true, truncation: true }));
      const tensor = result.sentence_embedding;
      if (!tensor) throw new Error(`Hunch: ${model.id} has no sentence_embedding output`);
      if (tensor.dims[1] !== model.nativeDims) {
        throw new Error(
          `Hunch: ${model.id} returned ${tensor.dims[1]} dims, not ${model.nativeDims}`,
        );
      }
      return Float32Array.from(tensor.data.subarray(0, model.nativeDims));
    };
    dispose = async () => {
      await net.dispose?.();
    };
  }

  const cache = new Map<string, Promise<Float32Array>>();
  const cacheSize = options.cacheSize ?? 100;
  return {
    model: model.id,
    embed(query) {
      const text = input(query);
      let vector = cache.get(text);
      if (!vector) {
        // Matryoshka truncation to the catalog's dimensions, renormalized: the build's own step.
        vector = embedFull(text).then((full) =>
          normalize(Array.prototype.slice.call(full, 0, dims) as number[]),
        );
        const pending = vector;
        pending.catch(() => {
          if (cache.get(text) === pending) cache.delete(text);
        });
        cache.set(text, vector);
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
      }
      return vector;
    },
    dispose,
  };
}
