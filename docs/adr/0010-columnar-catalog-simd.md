# ADR 0010: The catalog as columns, and a WebAssembly SIMD kernel

- Status: Accepted
- Date: 2026-11-06

## Context

After [ADR 0008](0008-sliced-ranking.md), ranking no longer blocked input, but it was slow:
`related()` over 100,000 items took 130 ms in Node and 376 ms in Chromium with the CPU slowed 4×.
A CPU profile showed that the dot products, the work that can't be avoided, were only about a
fifth of that. The rest went around them:

- an object per loaded item (`{ item, shard, row }`), and closures per candidate for
  similarity, prior and recency;
- `Date.parse` of every candidate's date, on every call, for recency;
- an object per pool candidate, and garbage collection after all of it.

Rewriting the same loop over contiguous arrays in plain JavaScript gained almost nothing (33 ms
against 40 ms per 100,000 dot products): V8 already runs that loop well. Going much faster
needs more arithmetic per instruction, which WebAssembly SIMD gives, and SIMD needs the vectors
in one contiguous block. So the data has to change shape first.

## Decision

### 1. The catalog is a table of columns

Every loaded item is a row number. The client keeps:

- the vectors of all loaded shards in one contiguous block (in WebAssembly memory where the
  kernel runs), appended shard by shard;
- typed arrays indexed by row: the 1 / norm of each vector, the prior, the publication time
  (parsed once, when the shard loads; NaN without a date) and the section's index in the
  manifest;
- the published metadata (title, URL, …) in an array, read only for the items a call returns.

Choosing candidates reads no strings. Exclusions, hidden and seen items become a byte per row;
sections a byte per section; "published after" compares the time column.

### 2. Similarities come from a kernel, in one pass per query

`cosines(query, rows)` sends runs of nearby rows (gaps of up to 16 rows are computed and
dropped) to the kernel in one call each, with a pause between calls of about 8,000 rows
(ADR 0008). A profile with a negative part is two passes; `search()` with personalization is
three.

The kernel (`src/rank/kernel.wat`, 332 bytes compiled, inlined as base64) takes int8 rows. The
float query is split into two int16 vectors, q ≈ (hi + lo / s₂) / s₁. `i32x4.dot_i16x8_s`
multiplies eight pairs per instruction, and each row's two integer sums are exact (`|hi|` and
`|lo|` are bounded so a 768-dim sum stays within 32 bits). The result keeps about 30 bits of
the query, more than float32 arithmetic would. Against float64 sums, the error is below 1e-9
(float32 sums: about 1e-6), so rankings match the previous client's: the same ids, and scores
within 1e-8 on the 20,000-item fixture.

The JavaScript fallback sums in float64. It runs where WebAssembly SIMD doesn't (browsers from
before 2021–2023), where a Content Security Policy forbids compiling WebAssembly (it needs
`'wasm-unsafe-eval'`), for float32 catalogs, and for dims that aren't a multiple of 16.
`Hunch.load({ kernel: 'js' })` forces it, and `hunch.kernel` says which one runs. Both give
the same results to within 1e-8; a browser test checks that in Chromium, Firefox and WebKit.
Single rows (diversity, explanations) are computed in JavaScript, where a kernel call costs
more than the row.

### 3. Ranking reads columns

`ranking(columns, options)` takes the similarity, prior and recency of each candidate as arrays,
computes the base score in one loop, and chooses the pool by index (a threshold selection over
an `Int32Array`); objects exist only for the pool. Recency is one multiplication per row: for a
half-life h, 0.5^(age / h) = 2^((t − t₀) / h) · 2^((t₀ − now) / h), and the catalog keeps the
first factor per row. The old `rank(candidates, input)` stays, as a thin adapter, so the
ranking's tests check the same behaviour.

## Results

`npm run bench`, the same machine, main and this change back to back (int8, 256 dims, 50
signals for `recommend()`):

| Catalog       | Where                   | Call          | Before  | After   | Speed-up |
| ------------- | ----------------------- | ------------- | ------- | ------- | -------- |
| 100,000 items | Node                    | `related()`   | 130 ms  | 11.3 ms | 11.5×    |
| 100,000 items | Node                    | `recommend()` | 132 ms  | 12.0 ms | 11×      |
| 10,000 items  | Node                    | `related()`   | 12.8 ms | 2.3 ms  | 5.6×     |
| 100,000 items | Chromium, CPU 4× slower | `related()`   | 376 ms  | 66 ms   | 5.7×     |
| 100,000 items | Chromium, CPU 4× slower | `recommend()` | 383 ms  | 75 ms   | 5.1×     |
| 10,000 items  | Chromium, CPU 4× slower | `related()`   | 34.7 ms | 7.6 ms  | 4.6×     |

Browser runs vary by about ±10 ms between runs on this shared machine.

- **In the browser the gain is about half Node's.** The old code ran relatively faster in
  Chromium's newer V8 than in Node's. Of what is left, about a third is the kernel, a quarter is
  native time (allocating and zeroing typed arrays, garbage collection), and the rest is the
  ranking and the passes around the kernel. `recommend()` also reads the signals from
  IndexedDB on every call.
- **Loading is about as before** (3.2 s against 3.6 s for every shard at 100,000 items, Chromium):
  it is the shards' JSON headers, the hash and the network, not ranking. A binary format for
  the per-item columns is the next step there ([ADR 0011](0011-format-v2-columns.md)).
- **Float32 catalogs** use the JavaScript kernel: 138 ms → 95 ms at 100,000 items in Node. They
  are four times the bytes and rank no better ([evaluation](../evaluation.md)).
- **Size:** the client is 9.72 KB gzipped (budget 10 KB), up from 7.61 KB: the kernel, its
  JavaScript fallback and the columns.

## Alternatives considered

- **An int8 query** (one `i8×i8` pass): about twice as fast again, but it moves each cosine by
  up to 6e-4, which reorders near ties. Not without a reason to accept different rankings.
- **One int16 query vector** (no `lo`): 1.9 ms against 2.8 ms per 100,000 rows, but an error of
  3e-5, worse than float32.
- **A float32 kernel** (int8 widened to f32, `f32x4` multiply-add): 5.1 ms per 100,000 rows,
  slower and less exact than the split query. It was the first version of this change.
- **A Web Worker:** frees the main thread but not the time, adds a copy of the catalog or shared
  memory (which needs cross-origin isolation on the site), and a second script to load. Slicing
  (ADR 0008) already keeps input responsive.
- **Relaxed SIMD** (`i32x4.relaxed_dot_i8x16_i7x16_add_s`): faster still, but not in every
  browser, and its results may differ between them.

## Consequences

- The format is unchanged; only the client changed. The public API gains `kernel` (an option
  and a getter).
- Scores can differ from the previous release's in the ninth decimal; ids and their order on the
  test fixtures are the same.
- `npm run kernel` regenerates `src/rank/kernel-wasm.ts` from `kernel.wat` (with `wabt`, a dev
  dependency); a unit test fails if the two disagree.
