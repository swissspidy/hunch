# ADR 0003: Personalization in the client: consent, signals, "for you", controls

- Status: Accepted (milestone 2)
- Date: 2026-11-04

## Context

[ADR 0001](0001-format-signals-ranking.md) set the signal schema, the derived profile and the
ranking function. Milestone 2 builds them into the client and the components. That leaves
decisions the first ADR didn't make: when the client may touch storage, how the visitor's
controls behave, how a server-rendered list stays stable for visitors without a profile, and
what the components need from the page.

## Decision

### Consent gates every read and write

- `Hunch.load({ manifest, consent })` takes `true` or a function. **Without it,
  personalization is off.** The client asks the function before every read or write of signals,
  not once, so withdrawing consent takes effect on the next call. A function that throws, or
  returns anything but `true`, means no.
- Without consent the client opens no database at all. The browser test checks that
  `indexedDB.databases()` stays empty. `recommend()` then returns the site's own order,
  `record()` returns `false`, and `export()` returns no signals.
- **`forget()` always works**, with or without consent. It deletes the whole database
  (`indexedDB.deleteDatabase`). A site should call it when the visitor withdraws consent, as the
  demo does. `forget(itemId)` deletes one item's signals, which also undoes a "not interested".
- Storage failures (private modes, quota, a blocked upgrade) turn personalization off for the
  call instead of throwing. The page keeps its fallback.

### Signals

- `record(kind, itemId, { seconds })` writes one signal with the weights of ADR 0001.
  `observe(itemId)` (and `<hunch-page>`) records a view, then dwell time as the page is hidden
  or left. Dwell counts visible time only, from 10 seconds on, and is written as increments, so
  one visit adds up to at most 2 however often the tab is hidden.
- **A followed item counts as seen.** The visitor already knows it, so "for you" leaves it out
  like a viewed item unless `includeSeen` is set. Of an item's follow and hide signals, the
  latest decides whether it is hidden.
- **Pruning** (2,000 signals, 180 days for implicit signals) runs on the first write of each
  page load. Explicit signals are pruned last.
- `pause()` and `resume()` set `paused` in the `meta` store. While paused nothing is recorded,
  but stored signals still rank.
- `export()` returns `{ format: "hunch/signals", formatVersion: 1, exportedAt,
  manifestVersion, signals: [{ itemId, kind, weight, at }] }`.
- `namespace` (database `hunch-<namespace>`) keeps several catalogs on one origin apart.
  `store` replaces IndexedDB (`MemoryStore` is used in tests and wherever there is no
  IndexedDB).

### Ranking with a profile

- `recommend({ n, sections, exclude, includeSeen })` ranks the catalog with the profile of
  ADR 0001. Before it builds the profile, it loads the shards of every item with signals, so a
  section filter on the candidates doesn't drop the visitor's history.
- **Without a profile (`conf = 0`) the site's order stands exactly.** Recency and diversity are
  off, so the cold start is the editorial or popularity order the site published, not a
  reshuffle of it. With signals, both come back as the profile takes over.
- `rank(ids)` reorders a list the server rendered. Here the list's own positions are the prior,
  so with no profile the list comes back unchanged. Unknown ids keep their order after the known
  ones, and hidden items go last. Nothing is dropped, so the server's markup can be reordered
  slot for slot.
- Every result's `why` adds `confidence` and `similarityShare`, the part of the score that
  similarity accounts for, and `because`, the visitor's items that contributed most with their
  share. When `similarityShare` is low, the item is there as an editors' pick, and a UI should
  say so instead of "because you read". The demo does this. `explain(itemId)` gives the same for
  one item, plus whether it is hidden or seen and how many signal items the current catalog no
  longer has.

### Components

- `Hunch.shared(manifest)` gives every component on a page one client, configured by
  `Hunch.configure({ consent, namespace, … })`. The consent hook is looked up whenever it's
  needed, so it can be configured after the components start. For the script-tag build,
  `window.HunchConfig`, set by an inline script before `hunch.global.js`, is applied before
  the components are registered.
- `<hunch-for-you>` fills its slots with `recommend()`. **Without a profile it leaves the
  server's slots untouched** and sets `data-hunch-personalized="false"`. A visitor without
  consent never sees the list change.
- `<hunch-related>` and `<hunch-for-you>` record a `click` when a slot with a
  `data-hunch-id` is clicked. This is best effort: the next page's view is recorded either way.
- **"Because you read …" and "Not interested" in the slots** (amended after milestone 2). A
  `<hunch-for-you>` slot may hold a `[data-hunch-because]` line and a `[data-hunch-hide]`
  button. The line names a read item only when the profile placed the recommendation
  (`similarityShare ≥ 0.5`) and the named item is close to it: each `because` entry carries its
  own cosine `similarity` to the recommendation, and the line takes the largest-share entry at
  or above `because-min` (default 0.35). The share alone isn't enough: shares always sum to 1,
  so the top one names something even when nothing read is close. After a hide lowered every
  similarity, an unrelated article was named. With EmbeddingGemma at 256 dimensions, unrelated
  demo articles reach 0.33 at the 90th percentile, so 0.35 is the default. The button is shown
  only with consent, since the signal can't be stored without it. After a hide the list ranks
  again at once, moving focus to the same slot's link instead of waiting for focus to leave as
  a refresh otherwise does, and a `[data-hunch-announce]` live region says what happened.
- `<hunch-page item>` calls `observe(item)` and renders nothing.
- `refresh()` ranks a list again, for example after a consent change.

### Performance on a phone

`npm run bench -- --browser` runs the synthetic catalog of ADR 0001 in Chromium, with the CPU
slowed 4× (DevTools' mid-range mobile preset) and 50 signals in IndexedDB:

| Catalog                   | Load first section / all | `related()` | `recommend()` | JS heap |
| ------------------------- | ------------------------ | ----------- | ------------- | ------- |
| 10,000 items, 10 sections | 96 / 409 ms              | 46 ms       | 61 ms         | 5.3 MB  |
| 1,000 items               | 112 / 130 ms             | 13 ms       | 15 ms         | 3.2 MB  |

Both run in idle time after the page has rendered. A catalog of 10,000 items is about at the
edge of a single 50 ms task on a slow phone. [ADR 0008](0008-sliced-ranking.md) splits loading
and ranking into short tasks, so larger catalogs do not block input.

### Shards are checked everywhere

SubtleCrypto exists only in secure contexts, so on a plain-HTTP site the client checks a shard's
SHA-256 with a small JavaScript implementation (`src/format/sha256.ts`, about 1 KB gzipped)
instead of skipping the check. A stale or mixed-up shard is refused on every site. (Since
[ADR 0011](0011-shard-columns.md), `fetch()` checks it there instead, as Subresource Integrity.)

## Consequences

- The core grows from 2.5 KB to 6.6 KB gzipped (7.9 KB with the three components), still under
  the 10 KB budget.
- A site that integrates only related items, or never configures consent, stores nothing.
- The first page after consent shows the editors' order. "For you" changes only after the
  visitor has read something, and gradually: three views give a confidence of 0.5.
- The browser tests cover milestone 2's acceptance: consent off by default with no database,
  "for you" following what was read, hide, forget, pause, export, dwell time, and a layout shift
  of 0 on desktop and phone viewports.
