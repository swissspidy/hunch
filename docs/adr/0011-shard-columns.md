# ADR 0011: The shard as columns, and metadata read on demand

- Status: Accepted
- Date: 2026-11-06
- Replaces the shard layout of [ADR 0001](0001-format-signals-ranking.md), before the first
  release

## Context

[ADR 0010](0010-columnar-catalog-simd.md) made ranking about ten times faster. Loading did not
change, and ADR 0010 named the reason: ADR 0001's shard keeps every item's metadata in one JSON
header. Before the client can rank anything from a shard, it:

- parses the whole header, which builds an object per item with its title, URL, tags and image;
- parses every item's date with `Date.parse`, for recency;
- computes every row's norm.

It reads the title and URL of perhaps ten items per call. In a CPU profile of loading 100,000
items in Chromium with the CPU slowed 4×, decoding and indexing the shards took about 1 s of
main-thread time, as 50 tasks of about 20 ms each.

## Decision

### 1. The shard layout

The manifest doesn't change. The shard keeps ADR 0001's magic, quantization, `dims`, `count` and
vectors. What changes is everything else. The values the ranking reads for every item move to binary
columns, and the rest of each item moves to a block that is read only on demand:

| Offset | Size         | Field                                                                 |
| ------ | ------------ | --------------------------------------------------------------------- |
| 0      | 4            | Magic `HNCH`                                                          |
| 4      | 1            | Format version (1)                                                    |
| 5      | 1            | Quantization: 1 = int8, 2 = float32                                   |
| 6      | 2            | Reserved (0)                                                          |
| 8      | 4            | `dims`                                                                |
| 12     | 4            | `count` (n)                                                           |
| 16     | 4            | Header length `H`                                                     |
| 20     | 4            | Metadata length `M`                                                   |
| 24     | `H`          | UTF-8 JSON: `{ "space", "sections": string[], "ids": string[] }`      |
| …      | 0–7          | Zero padding to a multiple of 8                                       |
| …      | 8n           | `prior`, float64                                                      |
| …      | 8n           | Publication time in ms since the epoch, float64 (NaN: no date)        |
| …      | 4n           | Length of each item's metadata in bytes, uint32                       |
| …      | 2n           | Section: index into the header's `sections`, uint16 (`0xffff`: none)  |
| …      | 0–3          | Zero padding to a multiple of 4                                       |
| …      | n × dims × w | Vectors, row-major, as in ADR 0001                                    |
| …      | `M`          | Metadata: each item's other fields as UTF-8 JSON, one after the other |

- **The header keeps what must be known for every item and is a string:** the ids, which the
  client indexes to find items and to match the visitor's signals, and the section names, each
  once.
- **Each item's metadata is its own JSON object**: `{ url, title, tags?, date?, image? }`, the
  published item without `id`, `section` and `prior`, which the columns hold. The client decodes
  one only when a call returns that item. Unknown fields pass through, so an optional item field
  can be added without a new format version (ADR 0009).
- **The time is parsed when the catalog is built.** `Date.parse` reads ISO 8601 the same way in
  every browser, but other date formats differently. With the time in the file, recency no
  longer depends on the visitor's browser. The date string stays in the metadata, for display.
- **Norms are not stored.** Computing them takes the client about as long as downloading them
  would (4 bytes an item, which don't compress) on a slow phone network.
- **Lengths, not offsets.** The lengths of similar items are similar, so they compress to almost
  nothing (0.5 KB per 10,000 items in the benchmark, against 28 KB for offsets).
- The f64 columns start at a multiple of 8, and the vectors at a multiple of 4, so a reader can
  view them without copying.

The WordPress plugin writes the same bytes as the Node build
([ADR 0007](0007-wordpress-plugin.md)). PHP reads ISO 8601 dates as `Date.parse` does. It
writes NaN for any other format, which the plugin never writes.

### 2. One format version at the first release

No release has written ADR 0001's layout, so it is dropped rather than kept as a second
version: the first release reads and writes this layout, as format version 1 (the manifest's
`formatVersion` and the shard's version byte). ADR 0009's rules start from it, and the frozen
fixture `test/fixtures/format-v1/` pins it. Dropping the old reader saves about 0.5 KB gzipped.

`DecodedShard` has the columns (`ids`, `prior`, `time`, `sections`, `section`), `count`,
`version` and `item(i)`. `items` decodes every item.

### 3. Who checks the hash

Every shard is checked against the manifest's SHA-256 before its vectors are used (ADR 0001).
Where `crypto.subtle` exists, that is, on every secure page, the client hashes with
`subtle.digest()` as before. On plain-HTTP pages it doesn't exist, and the client passes the
hash to `fetch()` as Subresource Integrity (`integrity: "sha256-…"`) instead: the browser
refuses a response that doesn't match. This replaces the JavaScript SHA-256 that ADR 0003 added
for those pages, about 0.7 KB gzipped. A custom `fetch` (the client's `fetch` option) must honour
`integrity` for the check to happen there.

Integrity is not used everywhere because it is slower. Fetching 50 shards of 1 MB, against
fetching them and hashing with `subtle.digest()`:

| Browser                 | `fetch` + `digest()` | `fetch` with `integrity` |
| ----------------------- | -------------------- | ------------------------ |
| Chromium, CPU 4× slower | 1.28–1.39 s          | 1.49–1.51 s              |
| WebKit                  | 353–361 ms           | 418–519 ms               |
| Firefox                 | 218–358 ms           | 264–296 ms               |

In Chromium and WebKit both block the main thread for the whole time, so integrity doesn't move
the cost elsewhere either. All three refuse a mismatched shard, on secure and plain-HTTP pages
alike; a browser test checks this on a page that isn't a secure context, with a shard whose
vectors were changed.

## Results

The benchmark's synthetic catalog, ADR 0001's layout and this one back to back on the same machine:

| Catalog       | Measure                                            | JSON header    | Columns        |
| ------------- | -------------------------------------------------- | -------------- | -------------- |
| 100,000 items | Decoding and indexing the shards, Chromium, CPU 4× | about 1.05 s   | about 0.75 s   |
| 100,000 items | JS heap after loading, Chromium                    | 33 MB          | 5 MB           |
| 100,000 items | Loading every shard, Chromium, CPU 4×, gzip, local | 2.6–3.4 s      | 2.35–2.95 s    |
| 100,000 items | Loading every shard, Node                          | 392–574 ms     | 271–385 ms     |
| 100,000 items | Shards / gzipped                                   | 51.2 / 26.0 MB | 49.2 / 26.5 MB |
| 10,000 items  | Shards / gzipped                                   | 5.08 / 2.61 MB | 4.89 / 2.64 MB |

- **The decoding itself is about six times faster** (546 ms → 94 ms in the profile), and
  indexing reads typed arrays instead of objects. What remains is computing the norms (185 ms),
  indexing the ids (310 ms) and copying the columns.
- **The JS heap is 85% smaller.** The metadata stays as bytes (about 25 MB at 100,000 items)
  until an item is returned.
- **Hashing is now the largest fixed cost, after the network.** Chromium computes
  `crypto.subtle.digest` on the main thread: about 7 ms per MB with the CPU slowed 4×
  (440 ms at 100,000 items). The check stays, because a shard that doesn't match its manifest
  must never be ranked (ADR 0001). Loading in the browser is mostly network now.
- **Bytes over the wire are about the same.** The float columns compress less well than the
  JSON numbers they replace: +1.2% gzipped at 10,000 items, +1.8% at 100,000. Uncompressed, the
  shards are 4% smaller.
- **Size:** the client is 9.34 KB gzipped (budget 10 KB), down from 9.80 KB with ADR 0001's
  layout: the columns cost a little, and one format version and no JavaScript SHA-256 save more.

## Alternatives considered

- **Metadata in a separate file per shard**, fetched only for returned items: it saves bytes
  that compress tenfold anyway (about 10% of the gzipped shard). It would cost a round trip
  before the first results render, plus a second file to hash, cache and prune. Lazy decoding
  within the same file saves the CPU without the round trip.
- **Storing the norms:** about 0.2 s less at 100,000 items with the CPU slowed 4×, but 32 KB more
  gzipped per 10,000 items. Not stored, for now.
- **Byte-shuffling the float columns** (all first bytes, then all second bytes, …): the time
  column compresses 2.4× better, the prior column worse. It would add a step to every reader and
  writer for 0.8% of the bytes.
- **The date only as a time**, with the ISO string rebuilt from it: about 15 KB less per 10,000
  items. But a date the site wrote in another form would come back changed.
- **Shorter priors (float32):** half the bytes, but scores would move in the eighth decimal.
- **Keeping ADR 0001's layout as a second version:** 0.5 KB of reader for files no release wrote.
- **Integrity everywhere, or a hash in a Web Worker:** integrity is slower (above); a worker
  adds a second script and a copy of each shard for a cost of about 7 ms per MB.

## Consequences

- The first release writes and reads format version 1 as described here; ADR 0009's promises
  apply to it from then on.
- The `./format` entry point's `DecodedShard` has the columns and `item(i)`.
- Plain-HTTP sites keep their shard check, done by the browser; a custom `fetch` must pass
  `integrity` on.
- The next costs of loading are the network and the hash, not the format.
