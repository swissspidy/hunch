# ADR 0004: "Since your last visit" and the built-in Summarizer

- Status: Accepted (milestone 5, first part)
- Date: 2026-11-04

## Context

The brief asks for a "since your last visit" summary, written by the browser's built-in
Summarizer where one is available and silently skipped elsewhere. That needs two things the
client didn't have: when the visitor's previous visit was, and a way to summarize items on the
device without making the core larger or calling any service.

## Decision

- **Visits live in the state the client already keeps.** The `meta` store's `state` record
  (ADR 0001) gains `lastSeen` (the last activity) and `previousVisit` (the last activity of the
  visit before this one). `visit()` updates them in one read-modify-write (`SignalStore.updateState()`, a single IndexedDB transaction), so a concurrent `pause()` is never overwritten, and a `forget()` is never undone. More than `visitGapMinutes` (default 30)
  without activity starts a new visit, and the old visit's last activity becomes
  `previousVisit`. Within a visit nothing changes, so every component on every page may call
  it. `observe()`, `<hunch-page>` and `sinceLastVisit()` do. Like signals, visits are recorded
  only with consent and not while paused, and `forget()` deletes them with everything else.
  `export()` doesn't include them: they are timestamps of the visitor's own activity, not
  signals about items. `visit()` returns them to any page that asks.
- **`sinceLastVisit(options)` is `recommend()` restricted to items dated after the previous
  visit.** It uses the new `after` option, so the ranking, the exclusions (seen, hidden) and the
  cold start all stay the same. With a profile, the new items most like the visitor's interests
  come first. Without one, they keep the site's order. On a first visit, or without consent,
  the result is empty.
- **The Summarizer lives in its own module** (`@swissspidy/hunch/digest`, `src/digest/`), not
  in the core. `summarize(items)` uses the Summarizer API (`Summarizer.availability()`,
  `Summarizer.create({ type: 'tldr', format: 'plain-text', length: 'short', sharedContext })`)
  on the items' titles and sections. It runs only when the model is already `available`;
  `allowDownload: true` also accepts `downloadable`, since a download usually needs a user
  gesture. Everywhere else it returns `null` and the caller keeps its placeholder. The model
  runs on the device, so this sends nothing either.
- **`<hunch-digest>`** fills server-rendered slots with `sinceLastVisit()`, like
  `<hunch-for-you>`, and writes the summary into a `[data-hunch-summary]` element when there
  is one. With nothing new, the fallback (for example the latest items) and its placeholder text
  stay as they are. `data-hunch-new` and `data-hunch-summarized` say what happened.
- **The demo can time-travel.** Its catalog is fixed, so a visit "today" never sees anything
  new. `?as-of=2026-09-15` makes the client's clock that day (through `HunchConfig.now`). A
  visit like that followed by one today shows the digest.

## Consequences

- The core grows by `visit()`, `sinceLastVisit()` and the `after` filter, to 7.0 KB gzipped. The
  Summarizer wrapper adds about 0.4 KB, to the components' bundle only.
- The summary needs a browser with the built-in Summarizer (Chrome's, with Gemini Nano), and only
  appears once its model is on the device. The browser tests fake the API, because headless
  Chromium has none. They check that the summary is written when the API answers, kept as
  placeholder text when it's absent, and that the layout doesn't shift either way.
- "Since your last visit" depends on item dates. Undated items are never "new".
