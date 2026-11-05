# ADR 0008: Large catalogs without long tasks: ranking in slices on the main thread

- Status: Accepted
- Date: 2026-11-05

## Context

The client loads shards and ranks the whole catalog on the main thread. At 10,000 items that
is about one 50 ms task on a slow phone ([ADR 0003](0003-personalization-client.md)). Sites with
50,000 to 200,000 items would block input for much longer: while a returning visitor's page
loads the catalog and ranks "for you", taps and scrolling wait.

`npm run bench -- --browser` now counts long tasks (over 50 ms) during load and the first
`recommend()` of a returning visitor with 50 signals in IndexedDB, in Chromium with the CPU
slowed 4×. `--items` takes a list (`--items 10000,50000,100000`). The synthetic catalog now
splits sections into shards of at most 2,000 items, as `inkling build` does by default (before,
a 100,000-item catalog was benchmarked as ten 10,000-item shards, which no build produces).

Before this change (median of three runs):

| Catalog       | Shards | Long tasks | Longest | Blocking | `recommend()` |
| ------------- | ------ | ---------- | ------- | -------- | ------------- |
| 10,000 items  | 10     | 1          | 156 ms  | 106 ms   | 59 ms         |
| 50,000 items  | 30     | 1          | 465 ms  | 415 ms   | 384 ms        |
| 100,000 items | 50     | 4          | 946 ms  | 913 ms   | 757 ms        |

"Blocking" is the total blocking time: the sum of each long task's time over 50 ms.
`recommend()` is the average of ten calls once everything is loaded. The machine was shared
with other jobs (4 cores), so the benchmark ran at a higher scheduling priority; without that,
other processes stretch tasks past 50 ms whatever Inkling does.

Where the time went, from Chromium profiles of the 100,000-item run:

- **Ranking** was one task: a dot product per candidate (or two, with a negative profile), a
  `Date.parse` per candidate for recency, an object per candidate, then a sort of all of them,
  although only the best 50 feed MMR. About 1 s at 100,000 items.
- **Filtering the candidates** (hidden, seen, excluded, sections): about 10 ms in Node at
  100,000 items, so about 40 ms with the CPU slowed 4×.
- **Shards** are decoded one by one, but shards that arrive together were hashed and decoded in
  the same task. Decoding a 2,000-item shard (JSON header, row norms) and indexing its items
  takes 10 to 40 ms.
- The rest of the long tasks during load contain no Inkling code: the browser receiving 50
  response bodies (about 51 MB), and garbage collection. A page that only fetches the 50 shards
  and hashes them, with no Inkling code at all, has 0 to 4 long tasks of 50 to 70 ms on the same
  machine.

## Options

1. **A dedicated Worker** fetches, verifies and decodes the shards and computes the dot
   products. The main thread keeps signals, consent and IndexedDB, and sends the profile or
   query vector over. The Worker would have to own the items too, or send every shard's
   metadata back by structured clone (which costs about what the `JSON.parse` it saved).
   `item()`, `rank(ids)`, `explain()`, `because` and the profile need items and vectors, so
   each would become a round trip. It needs a second bundle, an option for its same-origin URL
   (to work under a CSP without `blob:`), `worker-src` in the site's CSP, and a fallback when
   the Worker can't start. Ranking would also run in parallel with the page, which is faster
   overall on a phone with spare cores.
2. **Slices on the main thread.** The same code, split into short tasks that yield to the page
   with `scheduler.yield()`. No new bundle, option or CSP requirement.

The brief prefers the simpler option if it removes the long tasks at 100,000 items. It does
(below), so the Worker is not built.

## Decision

- **Ranking runs in slices.** `ranking()` in `src/rank/rank.ts` is the ranking function as a
  generator that pauses after every 512 candidates, while scoring and while picking the pool,
  and after every MMR pick (each compares the rest of the pool, which matters for long
  `rank(ids)` lists).
  `rank()` runs it to the end in one go (the build, the eval, the tests). The client drives it
  and, at each pause, yields to the page once the current slice has run 10 ms
  (`src/client/slices.ts`). Filtering the candidates is sliced the same way.
- **Yielding uses `scheduler.yield()`** where the browser has it (the ranking resumes ahead of
  other tasks, so it does not take longer than it must). Elsewhere it falls back to a new task
  through `setTimeout`, which every browser (and Node) has, at the cost of a few milliseconds
  per slice.
- **Automatic, with a time threshold, not an option.** The results are identical with or
  without slices, so there is nothing for a site to choose. A ranking that finishes within
  10 ms never yields, which is the size threshold measured in time: it adapts to the device
  instead of guessing a number of items. The API and its options do not change.
- **Each shard gets its own tasks.** The client yields after a shard's body has arrived, after
  its hash is checked and after it is decoded, so shards that arrive together are verified,
  decoded and indexed one task at a time.
- **The pool is selected, not sorted.** MMR only looks at the best `max(4n, 50)` candidates
  by `base`. Candidates that can still make it are now collected and, whenever there are twice
  that many, sorted and cut back, instead of sorting all of them; anything that ranks after the
  last cut's worst is skipped. The comparison is the same (base, then prior, then candidate
  index), and it is a strict order, so the pool is exactly what the full sort put first. This
  is O(count log pool). `rank(ids)` keeps every candidate (`n` is the list's length), so it
  sorts once, as before. (A first version kept the pool sorted by insertion, which made a
  100,000-id `rank()` with ascending priors take 8.6 s instead of 41 ms.)
- **Entries come in manifest order.** `loaded()` used to list entries in the order their shards
  arrived, so two items with exactly the same score could swap places depending on the
  network. It now lists them in manifest order, as its comment always said.

### Same results

A unit test checks `rank()` against the previous implementation (kept in
`test/reference-rank.ts`) on 60 input sets, many with ties. Another loads a synthetic catalog of
20,000 items and compares `related()`, `recommend()` (cold, with signals, with sections, without
diversity), `search()` (plain and personalized) and `rank(ids)` with the ids and scores the
client returned before this change (`test/fixtures/large-catalog.json`): once with a clock that
makes every pause yield, and once without `scheduler.yield()`.

### After

The same benchmark after this change, run alternately with the one above:

| Catalog       | Shards | Long tasks | Longest | Blocking | `recommend()` |
| ------------- | ------ | ---------- | ------- | -------- | ------------- |
| 10,000 items  | 10     | 0          | —       | 0 ms     | 43 ms         |
| 50,000 items  | 30     | 0          | —       | 0 ms     | 185 ms        |
| 100,000 items | 50     | 0          | —       | 0 ms     | 317 ms        |

None of the nine runs had a long task. `recommend()` is faster than before because the pool is
no longer a full sort. Loading everything took about as long as before (3.0 s instead of 3.3 s
at 100,000 items, from a local server).

The browser test (`test/e2e/large.test.ts`) slows the CPU 4×, loads 50,000 items, records 50
signals and ranks once, and checks that no task in all of that reaches 100 ms (twice the
long-task line, for slow CI machines). Then it checks that no task during one more
`recommend()` reaches 100 ms or half the call. It runs once with `scheduler.yield()` and once
without. With the previous client, the check fails: `recommend()` was one task of about
600 ms. A unit test answers the shards in reverse manifest order and checks that ties still
come in manifest order.

## Consequences

- Large catalogs no longer block input while they rank. A ranking takes a little longer in
  wall time when the page is busy, because the page's own tasks run in between.
- The core grows by 0.4 KB gzipped (7.2 to 7.6 KB of the 10 KB budget). No new entry point,
  bundle or option.
- CSP: nothing changes. There is no Worker, no `blob:` URL and no `eval`.
- Concurrent calls interleave at the pauses. Each call works on its own snapshot of candidates
  and signals, as before at its awaits.
- What remains on the main thread at load is the browser's own work on the responses, garbage
  collection, and decoding one shard at a time. If catalogs grow past what this covers (more
  items per shard, 768 dimensions, or 200,000 items on slow phones, which was not measured), the Worker of option 1 is
  the next step: `ranking()` and the shard decoder already run without the DOM.
- `npm run bench` reports long tasks, so a regression shows up in the numbers.
