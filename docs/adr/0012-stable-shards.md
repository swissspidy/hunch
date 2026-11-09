# ADR 0012: Shards that stay the same when the catalog changes

- Status: Accepted
- Date: 2026-11-09
- Amends the shard grouping and the priors of [ADR 0001](0001-format-signals-ranking.md), before
  the first release

## Context

Shard files have content-hashed names and a long cache lifetime, so a reader downloads a shard
again only when it changed. Until now almost any change changed almost every shard:

- **Priors.** An item's `prior` was `(n − rank) / n`, its place in the site's order. A new post at
  the top moved every other post's rank and changed `n`, so every item's prior changed, and with
  it every shard's bytes.
- **Splitting.** A section larger than 2,000 items was cut into consecutive slices in catalog
  order. A new post at the top shifted every slice by one item.

So on a site with 50,000 posts, publishing one post made every returning reader download every
shard again (about 13 MB gzipped), and editing one made them download its section again.

## Decision

1. **Priors are counted from the end, over a power of two.** `prior = (n − rank) / s`, where `s`
   is the smallest power of two ≥ `n`. A new item at the top of the order (a new post in a
   newest-first catalog) gets the highest count, and no other item's count or `s` changes until
   the catalog reaches the next power of two. Priors stay in (0, 1] and in the same order as
   before, so the cold start and ties rank as they did. The top prior is between 0.5 and 1
   instead of exactly 1, which scales the prior term of a "for you" score by at most half; the
   order the prior gives among candidates is unchanged. The format is unchanged: `prior` is
   still a float64 in (0, 1].
2. **A section's items are spread over buckets by a hash of their id.** An item goes to bucket
   `h mod b`, where `h` is the first 32 bits (big-endian) of the SHA-256 of its id and `b` is
   a power of two: the smallest one that leaves an average of at most half of
   `maxShardItems` per bucket, doubled again while any bucket has more than `maxShardItems`.
   Items stay in catalog order within a bucket. A bucket is one shard, named after its section
   and its bucket number (`news-3`); a section that fits one bucket keeps the plain name. An
   item stays in its bucket as others come and go, so an edit or a new item changes one shard.
   When a section grows past a doubling, its items are redistributed once.

The Node build and the plugin's PHP writer do both, byte for byte (the cross-language test
checks it).

## Consequences

- Publishing a post or editing one rewrites one shard of its section and the manifest. A
  unit test builds 40 items in buckets of at most 10 and checks that an edit and a new post at
  the top each produce exactly one new shard file.
- Sections of more than half of `maxShardItems` (1,000 items by default) now have two or more
  shards where they had one. Readers fetch the shards of a section in parallel, so this costs a
  few requests, not time.
- Deleting an item, a backdated post, or a change in popularity still moves the priors of the
  items after it in the order, and so their shards. Those are rarer than publishing, and a
  popularity order is global by nature.
- Old clients read the new shards: the format is the same.
