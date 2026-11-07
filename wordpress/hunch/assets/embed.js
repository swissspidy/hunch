/**
 * Embeds posts in the editor's browser with the catalog's pinned model (EmbeddingGemma through
 * Transformers.js, q8 weights), as the Node build does, and stores the vectors on the site
 * (ADR 0007). The post's text comes from the site and goes nowhere else; the model's weights
 * come from the Hugging Face Hub (or wherever Transformers.js is configured to load them) and
 * stay in the browser's cache.
 *
 * window.hunchEmbed.embedPost(id) → { stored, skipped }
 * window.hunchEmbed.embed(input) → Float32Array (the model's full output)
 */
(function () {
  'use strict';
  const config = window.hunchEmbedConfig;
  let loaded;

  function load() {
    loaded ??= (async () => {
      const mod = await import(config.transformersUrl);
      const { id, revision, dtype, file } = config.model;
      const [tokenizer, model] = await Promise.all([
        mod.AutoTokenizer.from_pretrained(id, { revision }),
        mod.AutoModel.from_pretrained(id, {
          revision,
          dtype,
          ...(file && { model_file_name: file }),
        }),
      ]);
      return { tokenizer, model };
    })();
    // A failed load (offline, say) is tried again next time.
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  }

  /** The model's sentence embedding of an already-prompted input, at its full size. */
  async function embed(input) {
    const { tokenizer, model } = await load();
    const result = await model(
      tokenizer([input], { padding: true, truncation: true, max_length: 2048 }),
    );
    const tensor = result.sentence_embedding;
    const dims = config.model.nativeDims;
    if (!tensor || tensor.dims[1] !== dims) {
      throw new Error(`Hunch: ${config.model.id} did not return ${dims} dims`);
    }
    return Float32Array.from(tensor.data.subarray(0, dims));
  }

  /** Little-endian float32, base64: what the REST route expects. */
  function encode(vector) {
    const view = new DataView(new ArrayBuffer(vector.length * 4));
    vector.forEach((x, i) => view.setFloat32(i * 4, x, true));
    const bytes = new Uint8Array(view.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /** Embeds `{ id, input, hash }` and stores the vector. */
  async function store(post) {
    const vector = await embed(post.input);
    await wp.apiFetch({
      path: `/hunch/v1/posts/${post.id}/vector`,
      method: 'PUT',
      data: { hash: post.hash, vector: encode(vector) },
    });
  }

  /** Embeds a published post unless its stored vector is current. */
  async function embedPost(id) {
    const post = await wp.apiFetch({ path: `/hunch/v1/posts/${id}/input` });
    if (!post.indexed || post.current) return { stored: false, skipped: true };
    await store(post);
    return { stored: true, skipped: false };
  }

  window.hunchEmbed = { embed, embedPost, store, encode, load };
})();
