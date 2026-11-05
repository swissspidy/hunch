# Inkling

First-party, on-device personalization for websites. Inkling ranks your catalog in the
visitor's browser: related items, "for you" modules and "since your last visit" digests. Your
build step publishes a vector for each item, and the browser ranks them with plain arithmetic:
the ranking runs no model. Two optional extras do run one on the device: free-text search
embeds the query with the catalog's own model, and the digest summary uses the browser's
built-in Summarizer. There is no server-side profile, and nothing about the visitor
leaves the device.

**Status: milestones 1–5.** The CLI builds a manifest and vector
shards from a feed. The client ranks related items, and, with the site's consent, "for you"
and "since your last visit" from signals kept on the device, with `explain()` and the
visitor's controls. See the [roadmap](#roadmap). The format,
the signals and the ranking function are specified in
[ADR 0001](docs/adr/0001-format-signals-ranking.md), and personalization in the client in
[ADR 0003](docs/adr/0003-personalization-client.md).

## How it works

1. **At build time**, `inkling build` reads your catalog (RSS/Atom, JSON, a sitemap, or your own
   loader) and embeds every item with a pinned open model. The default is
   [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) through Transformers.js. It
   writes `manifest.json` and one small binary shard per section: 256-dimensional int8 vectors,
   about 260 KB gzipped per 1,000 items.
2. **In the browser**, the client (7.2 KB gzipped, no dependencies) fetches the manifest and
   the shards it needs. It ranks by cosine similarity, a small recency boost and diversity (MMR).
   For "for you", similarity is to a profile derived from the visitor's signals (what they read,
   followed or hid), which stay in the site's own IndexedDB.
3. **On the page**, the server renders a normal, non-personalized list. `<inkling-related>` and
   `<inkling-for-you>` swap its entries in idle time, slot for slot, with no layout shift.

## Quick start

Install the package, and Transformers.js for the build step:

```sh
npm install @swissspidy/inkling
npm install --save-dev @huggingface/transformers
```

Build the vectors from your feed into your public directory:

```sh
npx inkling build --source https://example.com/feed.xml --out public/inkling
```

The first build downloads the model (about 300 MB, once). Later builds embed only new or
changed items, from `.inkling-cache/`. Commit that directory and CI rebuilds without the model.

On an article page, render the fallback list as you would anyway, and wrap it:

```html
<script src="/inkling.global.js" defer></script>
<!-- copy it from node_modules/@swissspidy/inkling/dist/inkling.global.js, or bundle the module -->

<inkling-related manifest="/inkling/manifest.json" item="sourdough-starter" section="Food">
  <ol>
    <li data-inkling-slot>
      <a href="/food/rye-bread/"><span data-inkling-title>Dense, dark rye bread</span></a>
      <span data-inkling-section>Food</span> · <time data-inkling-date>Oct 9, 2026</time>
    </li>
    <!-- … one slot per item to show -->
  </ol>
</inkling-related>
```

`item` is the item's id in the catalog: the feed item's `guid`, or its link. Give the slots a
fixed height and clamp titles to a fixed number of lines (see
[`demo/style.css`](demo/style.css)). If your CSS removes the list's markers
(`list-style: none`), add `role="list"` to it: Safari then no longer reports it as a list. Each slot is replaced by a copy of itself with the related
item's link, title, section, date and image, so nothing moves. If the manifest can't be
loaded, the fallback stays. The element sets `data-inkling-state` to `loading`, `ready` or
`error`, and fires `inkling:ready` with the recommendations.

### "For you"

Personalization stays off until the site says the visitor agreed. Set the consent hook before
the script, record views on article pages, and wrap a list in the site's own order (the cold
start) on the home page:

```html
<script>
  window.InklingConfig = { consent: () => myConsentManager.allows('personalization') };
</script>
<script src="/inkling.global.js" defer></script>

<!-- On an article page: records the view, and dwell time from 10 seconds on. -->
<inkling-page manifest="/inkling/manifest.json" item="sourdough-starter"></inkling-page>

<!-- On the home page: the editors' picks, replaced once the visitor has a profile. -->
<inkling-for-you manifest="/inkling/manifest.json">
  <ol>
    <li data-inkling-slot data-inkling-id="night-train-alps">…</li>
    <!-- … -->
  </ol>
</inkling-for-you>
```

Without consent nothing is stored (not even an empty database) and the list never changes.
With consent, items the visitor has read are left out, hidden items never come back, and the
profile takes over gradually as signals accumulate.

### The client

```js
import { Inkling } from '@swissspidy/inkling';

const inkling = await Inkling.load({
  manifest: '/inkling/manifest.json',
  consent: () => myConsentManager.allows('personalization'), // asked before every read or write
});

await inkling.related('sourdough-starter', { n: 4, sections: 'same' }); // no visitor data
inkling.observe('sourdough-starter'); // a view now, dwell time as the page is left
await inkling.record('follow', 'rye-bread'); // or 'hide', 'click', 'view', 'dwell'
await inkling.recommend({ n: 4 }); // "for you"
await inkling.rank(['a', 'b', 'c']); // reorder a server-rendered list
await inkling.explain('cold-brew'); // { similarity, confidence, because: [{ id, title, share }], … }

// The visitor's controls
await inkling.pause(); // and resume(), paused()
await inkling.export(); // { format: 'inkling/signals', signals: [{ itemId, kind, weight, at }] }
await inkling.forget(); // deletes everything; forget(itemId) one item's signals
```

The [API reference](https://swissspidy.github.io/inkling/api/) documents every entry point:
the client, `/elements`, `/digest`, `/query`, `/format` and `/build`.

### "Since your last visit"

`<inkling-digest>` shows what was published since the visitor's previous visit (with consent),
ranked by their interests. Where the browser has a built-in Summarizer with its on-device model,
it also writes a one-line summary. Elsewhere the placeholder stays:

```html
<inkling-digest manifest="/inkling/manifest.json">
  <p data-inkling-summary>The latest articles.</p>
  <ol>
    <li data-inkling-slot data-inkling-id="newest-post">…</li>
  </ol>
</inkling-digest>
```

In code: `await inkling.sinceLastVisit({ n: 5 })`, and `summarize(items)` from
`@swissspidy/inkling/digest`. A visit ends after 30 minutes without activity
([ADR 0004](docs/adr/0004-since-your-last-visit.md)).

### Search

`@swissspidy/inkling/query` embeds a query on the device with the catalog's own pinned model
(Transformers.js, loaded on the first search), and `inkling.search()` ranks the catalog against
it. The query text is never sent ([ADR 0005](docs/adr/0005-query-embedding.md)):

```js
import { createQueryEmbedder } from '@swissspidy/inkling/query';

const embedder = await createQueryEmbedder(inkling.manifest, {
  transformers: () => import('@huggingface/transformers'),
  dtype: 'q4', // the same model in smaller weights: ~200 MB, once, then cached
});
const results = await inkling.search(await embedder.embed('night trains'), { n: 5 });
```

`personalize: 0.3` blends in the visitor's profile; hidden items never appear.

Every result has `why`: `similarity`, `relevance`, `recency`, `prior`, `redundancy`,
`confidence`, `similarityShare` (how much of the score the profile accounts for: low means an
editors' pick) and `because` (the visitor's items it leans on).

## The demo

**Live:** [swissspidy.github.io/inkling](https://swissspidy.github.io/inkling/), with the
[API reference](https://swissspidy.github.io/inkling/api/), deployed from `main` by
[`pages.yml`](.github/workflows/pages.yml). To run it locally:

```sh
npm ci
npm run demo -- --serve     # http://127.0.0.1:4173/
```

[`demo/feed.xml`](demo/feed.xml) is a fictional publication with 32 articles in four sections.
Its EmbeddingGemma vectors come from the committed embedding cache, so the demo builds without
the model. Open an article: the "Related" list is ranked in your browser, and "Why these?" shows
each item's similarity. On the home page, turn on personalization under "Your data", read a few
articles, and "For you" follows. "More like this" and "Not interested" on an article are
explicit signals, and pause, export and forget are on the home page. To try "since your last
visit", follow the home page's link to visit as if it were 15 September 2026, then come back
today. The search box embeds your query in the browser with EmbeddingGemma (a one-time
download of about 200 MB) and ranks the articles against it. The browser tests check
that the pages fetch only `manifest.json` and the shards, that nothing is stored without
consent, and that the layout shift is 0 on desktop and phone viewports.

## The CLI

```
inkling build --source <file|url> [--source …] --out <dir> [options]
  --source <file|url>     JSON, RSS/Atom, sitemap, or a loader module (.js/.mjs/.ts)
  --provider <name|file>  transformers (default) | hash | a provider module
  --dims <n>              Published dimensions (Matryoshka truncation; default 256)
  --quantization <q>      int8 (default) | float32
  --shard-by <how>        section (default) | none
  --cache-dir <dir>       Embedding cache (default: .inkling-cache)
inkling inspect [manifest.json]
```

`inkling --help` lists every option. A JSON catalog is an array of
`{ id, url, title, text, section?, tags?, date?, image?, popularity? }`. A loader module's default
export returns that array. `popularity` (or, without it, catalog order) sets the cold-start
order. The same build step is a library, `@swissspidy/inkling/build`, for build helpers in
Astro, Next.js or static site generators.

The `hash` provider is a deterministic lexical embedding that needs no model. It is for tests
and baselines, not for production.

## Privacy

- Related items use no visitor data and store nothing on the device.
- The "for you" profile is derived on every page from a list of signals (item id, kind, weight,
  time) in the site's own IndexedDB, and never stored itself. Nothing is sent anywhere: the
  only requests are for the manifest and the shards, which are the same for every visitor.
- Recording is off until the site's consent hook says yes, and the hook is asked before every
  read or write. `pause()`, `export()` and `forget()` give the visitor control. `forget()`
  deletes the database and works even without consent, so call it when consent is withdrawn.
- **Consent is the site's call.** Storing personalization signals on the visitor's device may
  need consent under the EU ePrivacy Directive (Art. 5(3)), even though nothing leaves the
  device.

## Roadmap

1. ✅ The CLI builds a manifest and vector shards from an RSS feed. The client recommends
   related items on a demo site with no model in the browser.
2. ✅ Signals, decay, profile derivation, "for you" ranking, `explain()`, user controls. CLS 0
   on the demo.
3. ✅ Model switch: profiles recompute from signals with no migration, and the evaluation shows
   no quality loss ([docs/evaluation.md](docs/evaluation.md)).
4. ✅ Offline evaluation: on MIND, nDCG@10 0.390 vs 0.308 for popularity.
5. ✅ Optional: a "since your last visit" digest with the built-in Summarizer, and free-text
   search with the catalog's model in the browser.

## Stability

Inkling is 0.x: a breaking change comes in a minor release, with a changeset that says what to
do. [ADR 0009](docs/adr/0009-stability.md) says what counts as breaking:

- **Published files.** A client refuses a manifest or shard format version it doesn't know (the
  fallback stays), and keeps reading older versions for at least two minor releases after the
  build stops writing them. A frozen fixture in the tests pins format version 1.
- **The visitor's data.** Upgrades migrate the signals in IndexedDB without losing any or
  changing what they mean. An older client leaves a newer database alone.
- **The API.** The entry points' exports, the elements' attributes and events, and the CLI
  follow semantic versioning from 1.0.
- **Not stable:** the ranking. Weights, scores and the order of results may change in any
  release.

## Evaluation

[`eval/`](eval/README.md) replays click logs through the real client and compares Inkling with
random and popularity rankings: a synthetic dataset in CI, and
[MIND](https://msnews.github.io/) (Microsoft News) on demand. The results are in
[docs/evaluation.md](docs/evaluation.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [ADRs](docs/adr/README.md).

## License

Apache-2.0. EmbeddingGemma is distributed under the
[Gemma Terms of Use](https://ai.google.dev/gemma/terms). The vectors you publish are derived
from it, so check that its terms suit your use.
