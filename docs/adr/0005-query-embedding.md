# ADR 0005: Free-text search with the catalog's model, in the browser

- Status: Accepted (milestone 5, second part)
- Date: 2026-11-04

## Context

The brief's last optional enhancement is free-text features, such as matching a search query,
"with the same pinned model in the browser, versioned and cached". The catalog's vectors are
published, but a query only exists on the visitor's device. To compare a query with the
catalog, it has to be embedded there, by the same model, into the same space. That is the one
place where Inkling runs a model in the browser, so it must stay optional and lazy, and must not
weaken the guarantee that nothing about the visitor leaves the device.

## Decision

- **The manifest names the query prompt.** `model.queryPrompt` (EmbeddingGemma's is
  `task: search result | query: {query}`) is written by the build, next to the document prompt.
  It is optional: an older manifest falls back to `{query}`. Adding it keeps the format version.
- **`inkling.search(vector, options)` is in the core and takes a vector.** It accepts the
  model's full or truncated output, truncates it to the catalog's dimensions and renormalizes
  it (the build's own Matryoshka step), then ranks by cosine. It uses no recency and no
  diversity by default, because a search is about the query. Hidden items never appear. Seen
  items do, unless `excludeSeen` is set. `personalize` in [0, 1] blends the visitor's profile
  into the similarity (with consent). The core gains about 0.2 KB and no model.
- **`@swissspidy/inkling/query` embeds text** (`createQueryEmbedder(manifest, options)`), and is
  never imported by the core or the components.
  - For `inkling/hash` catalogs it runs the hash embedding in plain JavaScript; that code is now
    shared with the build in `src/rank/hash.ts`.
  - Otherwise it loads Transformers.js, which the site passes in (`transformers: () => import(…)`;
    by default `import('@huggingface/transformers')` for bundlers). Then it loads the manifest's
    model at the manifest's pinned revision.
  - **Versioned:** the model id and revision come only from the manifest, so a query is always
    embedded by the catalog's model. A new model in a new manifest means a new query model,
    with nothing to migrate.
  - **Cached:** Transformers.js keeps the weights in the browser's Cache Storage under their
    revision. Query vectors are cached in memory only (100 by default), never stored on the
    device, because a query is personal.
  - `configure(env)` adjusts Transformers.js's environment, for example to load the weights from
    the site's own origin instead of the Hugging Face Hub.
- **A smaller weights variant for the browser is allowed** (`dtype`, for example `q4` for a
  catalog built with `q8`). It is the same model, revision and prompt. On the demo catalog,
  EmbeddingGemma's q4 and q8 query vectors have cosine similarity 0.98 to 0.984. Six test
  queries gave the same top 5 with either, with one swap of neighbours in one query. q4 is
  197 MB instead of 309 MB, and the demo uses it.
  - _Update:_ those measurements ran in Node. Browsers can't run EmbeddingGemma's `model_q4`
    file: it quantizes the token embeddings with `GatherBlockQuantized`, which ONNX Runtime
    Web's WASM backend doesn't implement ("Can't create a session"). So q4 means
    `model_no_gather_q4` (195 MB), which keeps the token embeddings unquantized and runs in
    browsers and Node alike. Its vectors are within cosine 0.998 of `model_q4`'s and 0.97 of
    q8's. The manifest names the file (`model.file`, an optional field), it is part of the
    space and the embedding-cache key, and the query embedder loads it for a q4 catalog or a
    `dtype: 'q4'` override.
- **Privacy:** the query text is embedded on the device and never sent. The only requests are
  for the model's weights and Transformers.js's runtime. They are the same for every visitor
  and carry no query or profile data. They do reach the hosts the site chooses (by default
  jsDelivr and the Hugging Face Hub), which learn that this browser downloaded the model, so a
  site that wants none of that hosts the files itself.

## Consequences

- Search costs a one-time download of about 200 MB and a few seconds of model loading. That is
  acceptable behind an explicit search action, not on page load. Nothing in the query module
  loads until a site calls it, and the demo's browser test checks that a page without a search
  fetches neither the module nor the model.
- The browser test replaces Transformers.js with a fake module through request routing, so CI
  never downloads the model. It checks the pinned id, revision and `dtype`, the query prompt,
  that ranking happens in the page, and that no request carries the query. The real model was
  run through the same module in Node: "night trains across europe" finds the night-train and
  rail-budget articles first, and "how to bake bread at home" finds the three bread articles.
- A catalog built with a model Transformers.js can't run (or a custom provider) can still be
  searched: the site embeds the query itself and passes the vector to `search()`.
