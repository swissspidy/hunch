# ADR 0001: The manifest and vector format, the signal schema, and the ranking function

- Status: Accepted (milestone 1 built the format and `related()`, milestone 2 the signals and
  the profile). Amended by [ADR 0003](0003-personalization-client.md): followed items count as
  seen, and the cold start keeps the site's order exactly. Its shard
  layout was replaced before the first release by [ADR 0011](0011-shard-columns.md): the
  per-item values in binary columns, the other metadata decoded on demand. Its shard grouping and
  priors were amended, also before the first release, by [ADR 0012](0012-stable-shards.md).
- Date: 2026-11-04

## Context

Hunch ranks a site's catalog in the visitor's browser: "for you" modules, related items,
"since your last visit". The visitor's interests never leave the device. The site precomputes a
vector for every item at build time, and the browser only does arithmetic on those vectors. No
model runs in the browser for the core features.

Three decisions shape everything else, so they are settled first:

1. **What the site publishes.** It has to be static files a CDN can cache, small enough for a
   phone, loadable a section at a time, and tied to exactly one embedding model.
2. **What the browser stores.** The profile has to survive a model change without a
   migration. Nothing stored may need a server to interpret it.
3. **How items are ranked.** The function has to be deterministic, explainable item by item,
   cheap on a phone, and it has to keep its meaning when the model (and so the range of
   similarity values) changes.

The constraints come from the project brief: a client under 10 KB gzipped with no dependencies,
no layout shift (CLS 0), first-party only, adoptable in an afternoon, and no profile data in any
request.

## Decision

### 1. The manifest

The build writes `manifest.json` and a `shards/` directory next to it. The manifest is the only
file the client fetches before it knows what it needs, so it stays small (it lists shards, not
items) and should be served with a short cache lifetime. Shards have content-hashed names and
can be cached forever.

```json
{
  "format": "hunch/manifest",
  "formatVersion": 1,
  "version": "e74f7eb05ce1b5c4",
  "generatedAt": "2026-11-01T00:00:00.000Z",
  "space": "onnx-community/embeddinggemma-300m-ONNX@5090578d…|dtype=q8|native=768|dims=256|prompt=03e0cd9b",
  "model": {
    "id": "onnx-community/embeddinggemma-300m-ONNX",
    "revision": "5090578d9565bb06545b4552f76e6bc2c93e4a66",
    "dtype": "q8",
    "nativeDims": 768,
    "documentPrompt": "title: {title} | text: {text}"
  },
  "dims": 256,
  "quantization": "int8",
  "count": 32,
  "sections": ["Food", "Science", "Technology", "Travel"],
  "shards": [
    {
      "url": "shards/food.f1b06d57a5ac.hunch",
      "section": "Food",
      "count": 8,
      "bytes": 3748,
      "sha256": "f1b06d57…"
    }
  ]
}
```

- **`space` names the embedding space**: the model id, pinned revision, weights variant
  (`dtype`), native and published dimensions, and a fingerprint of the document prompt. Two
  vectors may be compared only if their spaces are equal. Every shard repeats the space in its
  header, and the client refuses a shard whose space or SHA-256 does not match the manifest
  ([`catalog.ts`](../../src/client/catalog.ts)). So a stale CDN entry or a half-deployed
  rebuild fails loudly instead of mixing models.
- **`version`** is a hash of the space, the quantization and every shard's hash. The same
  input gives the same version, and then the build keeps the previous `generatedAt`, so an
  unchanged rebuild is byte-identical.
- **Shard URLs are relative to the manifest.** A site can host the directory anywhere.
- **Format versioning.** `formatVersion` is an integer. A client accepts only versions it
  knows. Adding optional fields does not bump it; changing the meaning of a field does. How
  long readers keep reading older versions: [ADR 0009](0009-stability.md).

### 2. Vector shards

> Replaced before the first release by [ADR 0011](0011-shard-columns.md), which keeps the
> vectors and the per-shard grouping below, and replaces the JSON header with columns and
> per-item metadata. No release wrote the layout below.

One shard per section (in catalog order), split at 2,000 items, plus one shard (`all`) for
items without a section. (Large sections are now spread over buckets by a hash of each item's
id, and priors are counted from the end of the order: [ADR 0012](0012-stable-shards.md).) A page that only needs related items from its own section loads one
shard.

The binary layout (little-endian, [`shard.ts`](../../src/format/shard.ts)):

| Offset | Size                      | Field                                                   |
| ------ | ------------------------- | ------------------------------------------------------- |
| 0      | 4                         | Magic `HNCH`                                            |
| 4      | 1                         | Format version (1)                                      |
| 5      | 1                         | Quantization: 1 = int8, 2 = float32                     |
| 6      | 2                         | Reserved (0)                                            |
| 8      | 4                         | `dims`                                                  |
| 12     | 4                         | `count`                                                 |
| 16     | 4                         | Header length `H`                                       |
| 20     | `H`                       | UTF-8 JSON: `{ "space": string, "items": ShardItem[] }` |
| …      | 0–3                       | Zero padding to a multiple of 4                         |
| …      | `count × dims × (1 or 4)` | Vectors, row-major                                      |

`ShardItem` is `{ id, url, title, section?, tags?, date?, image?, prior }`: what a component
needs to render a recommendation without another request. The item's text is embedded but
never published. `prior` is the site's cold-start order in (0, 1]: by `popularity` where items
have one, then by catalog order (the site's editorial order). It was `(n − rank) / n`, the first
item 1 and the last 1/n; [ADR 0012](0012-stable-shards.md) divides by the smallest power of two
≥ n instead, so the first item gets between 0.5 and 1.

- **One file per shard, header and vectors together.** One request, and the metadata can't
  disagree with the vectors. A JSON header keeps the format extensible without a schema
  compiler. The 4-byte alignment lets a `Float32Array` view the buffer without a copy.
- **Vectors are unit vectors, truncated before quantization.** EmbeddingGemma is trained with
  Matryoshka representation learning, so its first 512, 256 or 128 components, renormalized,
  are a usable embedding. The default is 256.
- **int8 by default: `round(v / max|v| × 127)` per row, with no stored scale.** Cosine
  similarity doesn't depend on scale. The client computes each row's norm once at load
  (`invNorms`) and scores with `dot(q, row) × invNorm`, so int8 rows are never expanded into
  floats. In the unit test, quantization error moves cosines by less than 1%. float32 stays
  available (`--quantization float32`) for evaluations and small catalogs.

### 3. The build and the embedding cache

`hunch build` reads a catalog (JSON, RSS/Atom, a sitemap plus page text, or a loader module),
embeds each item's `documentPrompt` filled with its title and text (truncated to 4,000
characters), and writes the manifest and shards ([`build.ts`](../../src/node/build.ts)).

- **The default model is EmbeddingGemma** (`onnx-community/embeddinggemma-300m-ONNX`, q8
  weights) through Transformers.js, **pinned to a commit**. Providers are pluggable: a module
  that exports `{ model, embed(inputs) }`. A deterministic lexical provider (`hash`) runs without
  a model, for tests, CI and as an evaluation baseline. It isn't semantic.
  `@huggingface/transformers` is an optional peer dependency, imported only on a cache miss.
- **Rebuilds are incremental.** Full-size vectors are cached, keyed by the SHA-256 of model id,
  revision, dtype and the exact input. Changing `dims` or the quantization re-uses the cache.
  Changing the model doesn't. Each build prunes cache entries it didn't use.
- **Clients holding the previous manifest keep working.** A build deletes shard files that
  neither the new nor the previous manifest names.

### 4. Size budget

`npm run bench` ([`scripts/bench.ts`](../../scripts/bench.ts)) measures a synthetic catalog of
10,000 news-like items in 10 sections. The numbers below are from Node 24 on the development
machine. [ADR 0003](0003-personalization-client.md) adds the same catalog in Chromium with a
CPU slowed to a mid-range phone's.

| Encoding                 | Shards  | Of which vectors | Gzipped | `related()`, all items |
| ------------------------ | ------- | ---------------- | ------- | ---------------------- |
| 256 dims, int8 (default) | 5.1 MB  | 2.4 MB           | 2.6 MB  | 11 ms                  |
| 128 dims, int8           | 3.9 MB  | 1.2 MB           | 1.4 MB  | 9 ms                   |
| 256 dims, float32        | 12.4 MB | 9.8 MB           | 9.1 MB  | 11 ms                  |

The budget for 10,000 items is **about 2.6 MB over the wire at the default encoding, about 260 KB
per 1,000-item section**. Vectors barely compress, but the metadata compresses about tenfold.
Sites with more items, or whose pages need every section, use 128 dimensions. Loading and
scoring happen in idle time, after the page has rendered.

### 5. The signal schema

Signals are the only thing stored about the visitor. They live in IndexedDB, in the site's own
origin:

- Database `hunch` (the name takes a site-chosen suffix when several catalogs share an
  origin), version 1.
- Object store `signals`, `keyPath: "seq"`, auto-increment (no indexes: every read is of all signals):

  ```ts
  interface Signal {
    seq?: number; // assigned by IndexedDB
    itemId: string; // the catalog's stable id: never a vector, never a URL of another site
    kind: 'view' | 'click' | 'dwell' | 'follow' | 'hide';
    weight: number; // signed; see below
    at: number; // epoch milliseconds
  }
  ```

- Object store `meta`, `keyPath: "key"`: `{ key: "state", paused: boolean }`.

| Kind                                    | Default weight             | Decays                            |
| --------------------------------------- | -------------------------- | --------------------------------- |
| `view` (the item's page was shown)      | 1                          | yes                               |
| `click` (a recommendation was followed) | 2                          | yes                               |
| `dwell` (10 s or more on the page)      | `2 × min(seconds / 60, 1)` | yes                               |
| `follow` (explicit)                     | 5                          | no                                |
| `hide` (explicit)                       | −5                         | no; the item is never shown again |

Implicit signals decay with a 21-day half-life: `w × 0.5^(age / 21 d)`. The store keeps at most
2,000 signals and none older than 180 days. Older ones are pruned on write. `pause()` stops
recording. `forget()` deletes the database. `export()` returns the signals as JSON.

**The profile is never stored.** It is derived on every page from the signals and the current
manifest's vectors:

```
s_i  = Σ decayed weights of the signals of item i
P+   = normalize( Σ_{s_i > 0} s_i · v_i )        P- = normalize( Σ_{s_i < 0} |s_i| · v_i )
m    = Σ_{s_i > 0} s_i                            conf = m / (m + 3)
sim(c) = cos(c, P+) − 0.5 · max(0, cos(c, P-))
```

So **a model change needs no migration.** A new manifest means new vectors for the same item
ids, and the next page recomputes `P+` and `P-` from them. Items that left the catalog drop out,
and `explain()` reports how many. The device stores no vector, so it has no vectors from two
spaces to mix.

**Consent.** Recording is off until the site enables it, through a consent hook the client calls
before any IndexedDB access. `related()` reads and writes nothing on the device, so it works
without consent. Whether local storage for personalization needs consent under the ePrivacy
Directive (Art. 5(3)) is the site's call. The README says so.

### 6. The ranking function

One function ranks every list ([`rank.ts`](../../src/rank/rank.ts)). For each candidate `c`:

```
rel(c)  = (sim(c) − min sim) / (max sim − min sim)      over the candidates, in [0, 1]
rec(c)  = 0.5 ^ (age(c) / 30 days)                       (0 without a date)
base(c) = 1.0 · conf · rel(c)  +  0.5 · (1 − conf) · prior(c)  +  0.1 · rec(c)
red(c)  = max over already picked s of rescaled cos(c, s)
pick    = argmax_c  (1 − λ) · base(c) − λ · red(c)       (MMR, λ = 0.2)
```

- **`related(itemId)`** takes `sim` as the cosine to the item's vector and `conf = 1`. It uses
  no visitor data.
- **"For you"** takes `sim` from the profile above and `conf` from its mass. With
  no signals, `conf = 0` and the site's own order (`prior`) decides. That is the cold start. As
  signals accumulate, the profile takes over gradually.
- **Similarity is rescaled over the candidate set.** Each model uses its own band of cosines
  (for EmbeddingGemma documents, about 0.25 to 0.6). Raw, a recency weight of 0.1 means
  something different for every model. Rescaled, `rel`, `prior` and `rec` are all on [0, 1].
  The weights then carry over when the model changes, which the model-change test (milestone 3)
  depends on. Diversity uses the same rescaling.
- **Diversity is maximal marginal relevance** over a pool of the best `max(4n, 50)` candidates
  by `base`. It is greedy and quadratic only in the pool, not the catalog.
- **Filters run before scoring:** the item itself, `exclude` ids, sections, and (for "for you")
  hidden items and, by default, items already seen.
- **Deterministic.** Ties go to the higher prior, then catalog order.
- **Explainable.** Every result carries its terms (`similarity`, `relevance`, `recency`, `prior`,
  `redundancy`, `confidence`, and `similarityShare`, the part of the score similarity accounts
  for). For "for you", `because` lists the signal items that contributed most, by
  `s_i · cos(c, v_i)`, and `explain(itemId)` gives the same for any item.

## Consequences

- The client was 2.5 KB gzipped with `related()` alone, and 6.6 KB with personalization and the
  hash check's fallback at milestone 2 (7.9 KB with the web components). With search, visits and
  the similarity kernel it is 9.4 KB (12 KB with the components), against budgets of 10 KB and
  12 KB. `npm run size` checks this in CI.
- Related items need no consent and no storage. They are the safe first integration.
- A site can switch models by rebuilding, with no migration on any device. The price is that
  the first page after a switch fetches new shards, and that items removed from the catalog
  lose their history.
- Publishing item metadata in the shards makes the catalog public, which it already is on the
  site itself. Item text isn't published.
- The `hash` provider makes CI hermetic, but it says nothing about recommendation quality. The
  demo uses EmbeddingGemma vectors from the committed embedding cache (`demo/hunch-cache`), so
  CI builds them without the model.
- Open for later ADRs: how the free-text query embedding is cached and versioned (milestone 5),
  and per-section weights.
