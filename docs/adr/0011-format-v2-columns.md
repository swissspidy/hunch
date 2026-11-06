# ADR 0011: Format version 2: per-item columns, and metadata read on demand

- Status: Accepted
- Date: 2026-11-06
- Amends [ADR 0001](0001-format-signals-ranking.md) (the shard layout); follows the rules of
  [ADR 0009](0009-stability.md)

## Context

[ADR 0010](0010-columnar-catalog-simd.md) made ranking about ten times faster. Loading did not
change, and ADR 0010 named the reason: a version 1 shard keeps every item's metadata in one JSON
header. Before the client can rank anything from a shard, it:

- parses the whole header, which builds an object per item with its title, URL, tags and image;
- parses every item's date with `Date.parse`, for recency;
- computes every row's norm.

It reads the title and URL of perhaps ten items per call. In a CPU profile of loading 100,000
items in Chromium with the CPU slowed 4×, decoding and indexing the shards took about 1 s of
main-thread time, as 50 tasks of about 20 ms each.

## Decision

### 1. Version 2 of the shard

The manifest's `formatVersion` and the shard's version byte become 2. The manifest's fields don't
change. The shard keeps its magic, quantization, `dims` and `count`, and its vectors. What
changes is everything else. The values the ranking reads for every item move to binary
columns, and the rest of each item moves to a block that is read only on demand:

| Offset | Size         | Field                                                                 |
| ------ | ------------ | --------------------------------------------------------------------- |
| 0      | 4            | Magic `INKV`                                                          |
| 4      | 1            | Format version (2)                                                    |
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
| …      | n × dims × w | Vectors, row-major, as in version 1                                   |
| …      | `M`          | Metadata: each item's other fields as UTF-8 JSON, one after the other |

- **The header keeps what must be known for every item and is a string:** the ids, which the
  client indexes to find items and to match the visitor's signals, and the section names, each
  once.
- **Each item's metadata is its own JSON object**: `{ url, title, tags?, date?, image? }`, the
  published item without `id`, `section` and `prior`, which the columns hold. The client decodes
  one only when a call returns that item. Unknown fields pass through, as optional item fields
  did in version 1 (ADR 0009).
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

### 2. Readers read both versions; the build writes version 2

As ADR 0009 requires, `decodeShard()` and `assertManifest()` read versions 1 and 2. For a
version 1 shard, the client derives the same columns from its header. A frozen fixture,
`test/fixtures/format-v2/`, holds the same catalog as `format-v1/`. The stability test checks
that both decode to the same items, columns and vectors, and that both rank.

A page with a client from before this change refuses a version 2 manifest, so its elements
keep their server-rendered fallback until the script is refreshed. That is the case
ADR 0009 plans for. Upgrading the client before rebuilding avoids it.

`DecodedShard` gains the columns (`ids`, `prior`, `time`, `sections`, `section`), `count`,
`version` and `item(i)`. `items` remains and decodes every item.

## Results

The benchmark's synthetic catalog, main and this change back to back on the same machine:

| Catalog       | Measure                                            | Version 1      | Version 2      |
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
- **Size:** the client is 9.96 KB gzipped (budget 10 KB). Reading two versions costs about
  0.5 KB. To fit, the JavaScript SHA-256 (for plain-HTTP pages, where `crypto.subtle` is
  missing) computes its constants from the first 64 primes instead of listing them. Each lies at
  least 0.005 units from a rounding boundary, so no engine's `Math.cbrt` can get one wrong. The
  test checks them against `node:crypto`.

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
- **Shorter priors (float32):** half the bytes, but scores would move in the eighth decimal, and
  version 1 and 2 would no longer rank exactly alike.

## Consequences

- Format version 2 is a minor release with a changeset (ADR 0009). Sites rebuild to get it.
  Clients from this release read both versions, and keep reading version 1 for at least two
  more minor releases.
- The `./format` entry point's `DecodedShard` has the columns and `item(i)`. Code that read
  `decodeShard(…).items` still works.
- The next costs of loading are the network and the hash, not the format.
