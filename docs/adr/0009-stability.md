# ADR 0009: What 0.x promises: formats, stored data, API

- Status: Accepted (before 0.1.0)
- Date: 2026-11-05

## Context

0.1.0 is the first release sites can depend on. Three kinds of thing outlive a deploy and so
need rules before then:

- **Published files.** A site publishes `manifest.json` and shards built by one version of
  Hunch, and pages run the client of another: a cached script after a rebuild, a rebuild
  after an upgrade, a CDN that serves an old shard for a while.
- **The visitor's data.** Signals stay in the visitor's IndexedDB for months, across every
  upgrade of the site. A visitor can't redo what a bad migration lost, and must not be
  recommended things because an old record was read with a new meaning.
- **The API.** Sites call the client and the build step, and write markup for the elements.

CONTRIBUTING.md already says that in 0.x a breaking change is a minor bump. This ADR says what
counts as breaking, and what is not promised at all.

## Decision

### Manifest and shard format

- **`formatVersion` (manifest) and the version byte (shard) name the format.** Both are 1. A
  change that a reader must understand to read the file correctly bumps the version: a field
  that changes meaning, a new required field, a new encoding, a new layout. Adding an optional
  manifest field, or an optional item field in the shard header, does not; readers ignore what
  they don't know, and must not depend on it (as `model.queryPrompt` was added, ADR 0005). The
  shard's reserved bytes are written as 0 and not read. The `space` string is opaque: readers
  only compare it for equality, and its spelling may change with any rebuild.
- **A reader refuses a version it doesn't know.** `assertManifest()` and `decodeShard()` throw,
  so `Hunch.load()` rejects (for the manifest), or the call that first needs the shard does
  (shards load lazily), and the elements keep the server-rendered fallback
  (`data-hunch-state="error"`). Nothing guesses at a newer format, and nothing mixes it with
  vectors it can read.
- **The build writes one version, the newest.** A release that introduces version N + 1 is a
  minor release in 0.x (a major from 1.0), with a changeset that says so.
- **Readers keep reading older versions.** A release that writes version N + 1 still reads N,
  and so do the next two minor releases in 0.x (from 1.0, the whole major). Dropping a version
  is itself a breaking change, with a changeset. So a site can upgrade the client before it
  rebuilds, and a page with a cached older client fails safe (the fallback) on a newer
  manifest until its script is refreshed.
- **A frozen fixture pins each version.** `test/fixtures/format-v1/` is a tiny catalog built
  with version 1 and never rebuilt. [`test/unit/stability.test.ts`](../../test/unit/stability.test.ts)
  checks that it still decodes byte for byte and ranks, that the writer still writes version 1,
  and that a newer version is refused. A format change fails it; a new version adds its own
  fixture next to the old ones, which stay for as long as readers read them.

### The visitor's data in IndexedDB

- **The schema has a version: the IndexedDB database version**, 1 today (ADR 0001, "The signal
  schema"). A new store, index or record field that older readers would misread, or a new
  signal kind, bumps it.
- **Migrations keep everything.** An upgrade (`onupgradeneeded` from an older version) keeps
  every signal and the state record, adding or deriving fields. It never deletes a signal it
  can't convert and never changes what an existing record means; if a meaning has to change,
  the new meaning gets a new field or a new kind, and the old record stays readable as it was.
  Pruning (at most 2,000 signals, implicit ones for at most 180 days) is the only deletion
  besides the visitor's own `forget()`, and a migration doesn't prune.
- **An older client leaves a newer database alone.** Opening a database whose version is newer
  than the client's fails (`VersionError`). The client then treats personalization as
  unavailable: the cold start, nothing written, nothing deleted. A newer client's upgrade asks
  older tabs to close their connection (`versionchange`), and they do.
- **Unknown signal kinds are kept and ignored.** Should a record of a kind the client doesn't
  know reach it anyway, it is neither scored nor treated as a view, and it isn't pruned by age;
  only the count cap drops it, after the known implicit signals.
- **The export format is versioned too.** `export()` returns `format: "hunch/signals"`,
  `formatVersion: 1`. Its fields keep their meaning; a change bumps the version.
- **The profile is never stored**, so a new model or new ranking needs no migration (ADR 0001).

### The public API

- **What is public:** the exports of the package's entry points (`.`, `./elements`,
  `./digest`, `./query`, `./format`, `./build`, `./astro`, `./hunch.global.js`) and their TypeScript
  types, as the [API reference](https://swissspidy.github.io/hunch/api/) lists them;
  `window.HunchConfig`; the elements' names, attributes, events (`hunch:ready`,
  `hunch:error`, `hunch:summary`, `hunch:click` and its `detail`) and the `data-hunch-*` attributes they read and set
  (`data-hunch-slot`, `-id`, `-title`, `-section`, `-date`, `-image`, `-href`, `-summary`,
  `-state` and its values, `-personalized`, `-new`, `-summarized`); the CLI's commands, options
  and exit codes; and the manifest, shard and export formats above.
- **Semantic versioning from 1.0.** In 0.x, a breaking change is a minor release and anything
  else is a patch or a minor; every one has a changeset that says what breaks and what to do.
  Removing or renaming any of the above, changing a default that changes what a page shows or
  stores, or a type change that breaks a caller's code, is breaking.
- **Not public:** everything else. Modules outside the entry points (`src/rank`, the internals
  of `src/client`), members marked `@internal` (the elements' lifecycle callbacks), the
  embedding cache's file format (a change re-embeds; the cache has its own version), log and
  error message wording, the demo, and the bundle's size within its budget.

### Explicitly not stable

- **Ranking.** The ranking function's weights and defaults (`ScoreWeights`, decay half-lives,
  diversity, the confidence curve), and so the order of results, `score`, and the numbers in
  `why` and `explain()`, may change in any release, a patch included. Results should get
  better; they won't stay the same. Tests and sites must not pin them. Which terms `why`
  reports, and what each one means, is kept.
- **The `hunch/hash` provider's vectors.** They change only with its model revision, which
  changes the space; a rebuild picks it up.
- **The Summarizer's text**, which is the browser's.

## Consequences

- A site can upgrade Hunch and rebuild in either order, and a page never shows vectors it
  misread: at worst, the fallback.
- A visitor's signals survive every 0.x and 1.x upgrade, and a rollback leaves them untouched.
- Format and schema changes cost more: a version, a migration or a second reader, a fixture,
  and a changeset. That is the point.
- Ranking can keep improving without a major release.
