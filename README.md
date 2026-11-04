# Inkling

First-party, on-device personalization for websites. Inkling ranks your catalog in the
visitor's browser: related items now, and "for you" modules and "since your last visit"
summaries next. Your build step publishes a vector for each item, and the browser ranks them
with plain arithmetic. No model runs in the browser, there is no server-side profile, and nothing
about the visitor leaves the device.

**Status: milestone 1 of 5.** The CLI builds a manifest and vector shards from a feed, and the
client ranks related items. Signals, the "for you" profile and the privacy controls are next
(see the [roadmap](#roadmap)). The format and the ranking function are specified in
[ADR 0001](docs/adr/0001-format-signals-ranking.md).

## How it works

1. **At build time**, `inkling build` reads your catalog (RSS/Atom, JSON, a sitemap, or your own
   loader) and embeds every item with a pinned open model. The default is
   [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) through Transformers.js. It
   writes `manifest.json` and one small binary shard per section: 256-dimensional int8 vectors,
   about 260 KB gzipped per 1,000 items.
2. **In the browser**, the client (2.5 KB gzipped, no dependencies) fetches the manifest and
   the shards it needs. It ranks by cosine similarity, a small recency boost and diversity (MMR).
3. **On the page**, the server renders a normal, non-personalized list. `<inkling-related>`
   swaps its entries for related items in idle time, slot for slot, with no layout shift.

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
[`demo/style.css`](demo/style.css)). Each slot is replaced by a copy of itself with the related
item's link, title, section, date and image, so nothing moves. If the manifest can't be
loaded, the fallback stays. The element sets `data-inkling-state` to `loading`, `ready` or
`error`, and fires `inkling:ready` with the recommendations.

Or use the client directly:

```js
import { Inkling } from '@swissspidy/inkling';

const inkling = await Inkling.load({ manifest: '/inkling/manifest.json' });
const related = await inkling.related('sourdough-starter', { n: 4, sections: 'same' });
// [{ id, url, title, section, date, score, why: { similarity, relevance, recency, prior, redundancy } }, …]
```

## The demo

```sh
npm ci
npm run demo -- --serve     # http://127.0.0.1:4173/
```

[`demo/feed.xml`](demo/feed.xml) is a fictional publication with 32 articles in four sections.
Its EmbeddingGemma vectors come from the committed embedding cache, so the demo builds without
the model. Open an article: the "Related" list is ranked in your browser, and "Why these?" shows
each item's similarity. The browser test checks that the page fetches only `manifest.json` and
the shards, and that the layout shift is 0 on desktop and phone viewports.

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
- The "for you" profile (milestone 2) will be derived from a list of signals (item id, kind,
  weight, time) in the site's own IndexedDB. It will never be sent anywhere, and recording is off
  until the site enables it. `pause()`, `forget()` and `export()` give the visitor control.
- **Consent is the site's call.** Storing personalization signals on the visitor's device may
  need consent under the EU ePrivacy Directive (Art. 5(3)), even though nothing leaves the device.
  Inkling will call a consent hook before it reads or writes any signal.

## Roadmap

1. ✅ The CLI builds a manifest and vector shards from an RSS feed. The client recommends
   related items on a demo site with no model in the browser.
2. Signals, decay, profile derivation, "for you" ranking, `explain()`, user controls. CLS 0 on
   the demo.
3. Model switch: profiles recompute from signals with no migration, and the evaluation shows
   no quality loss.
4. Offline evaluation (nDCG@10, recall@10) against popularity and recency baselines.
5. Optional: query embedding in the browser, and a "since your last visit" digest with the
   built-in Summarizer.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [ADRs](docs/adr/README.md).

## License

Apache-2.0. EmbeddingGemma is distributed under the
[Gemma Terms of Use](https://ai.google.dev/gemma/terms). The vectors you publish are derived
from it, so check that its terms suit your use.
