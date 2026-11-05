# Contributing to Inkling

Thanks for helping. This page covers setting up a checkout, the checks, and what a pull request
needs. The reasons behind the design are the [ADRs](docs/adr/README.md). Security reports don't
go here; see [SECURITY.md](SECURITY.md).

## Setup

Inkling needs Node.js 24 or later. Node runs the TypeScript sources directly, so a checkout needs
no build:

```sh
npm ci
npm test                        # unit tests (no network, no model)
npm run demo -- --serve         # the demo at http://127.0.0.1:4173/
node bin/inkling.js --help      # the CLI, from the sources
```

## Checks

| Command                | What it checks                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | TypeScript 7 over `src`, `test` and `scripts`                                                                                                         |
| `npm run lint`         | oxlint (type-aware) and knip (unused files, exports, dependencies)                                                                                    |
| `npm run format:check` | oxfmt (`npm run format` fixes it)                                                                                                                     |
| `npm test`             | Unit tests in `test/unit`                                                                                                                             |
| `npm run size`         | The client's gzipped size against its budget                                                                                                          |
| `npm run test:e2e`     | The demo and the Astro fixture in a browser: related items, layout shift, requests, accessibility (axe-core)                                          |
| `npm run test:pack`    | The packed package, installed into an empty project                                                                                                   |
| `npm run bench`        | Shard sizes and ranking time for 10,000 items (`-- --browser`: in Chromium, CPU 4× slower, with long tasks; `-- --items 10000,100000`: several sizes) |

The browser tests run in Chromium, or in the browser `INKLING_BROWSER` names (`chromium`,
`firefox` or `webkit`; CI runs all three). They need that browser for the installed
`playwright-core`: `npx playwright-core install chromium` (on Linux, add `install-deps` if it
doesn't start). Firefox and WebKit have no Layout Instability API, so there the layout-shift
checks are skipped, with that reason.

**The client stays dependency-free and Node-free.** oxlint rejects `node:*` and build-step
imports under `src/format`, `src/rank`, `src/client`, `src/elements`, `src/digest` and `src/query`.

## The API reference

`npm run api` writes the API reference to `demo/dist/api/` with TypeDoc, from the TSDoc
comments of the public entry points (run it after `npm run demo`, which empties `demo/dist`).
TypeDoc needs the TypeScript compiler API, which TypeScript 7 doesn't have, so it lives in
`docs/api/` with its own lockfile and TypeScript 6: install it once with
`npm ci --prefix docs/api`. It fails on an undocumented export or a broken `{@link}`.

## The WordPress plugin

[`wordpress/inkling/`](wordpress/inkling/readme.txt) is plain PHP with its own dev tools
([ADR 0007](docs/adr/0007-wordpress-plugin.md)). With PHP 7.4 or later and Composer:

```sh
cd wordpress/inkling
composer install
vendor/bin/phpunit              # the encoder, without WordPress
vendor/bin/phpcs                # WordPress coding standards
```

`npm test` also runs the PHP encoder against the Node build, byte for byte, when `php` is
installed. `npm run wordpress:build` bundles the client into the plugin and writes
`wordpress/inkling.zip`.

## The demo's embeddings

`demo/inkling-cache/` holds the demo's EmbeddingGemma vectors, so CI builds the demo without the
model. If you change `demo/feed.xml`, rebuild the cache with the model and commit it:

```sh
npm install --no-save @huggingface/transformers
npm run demo
```

## Pull requests

- **Add a changeset** (`npm run changeset`) when the package's behaviour changes. While the
  version is 0.x, a breaking change is a minor bump.
- **Record decisions.** A change to the manifest or shard format, the signal schema or the
  ranking function amends [ADR 0001](docs/adr/0001-format-signals-ranking.md) or adds an ADR,
  with its row in [`docs/adr/README.md`](docs/adr/README.md).
- **Keep the promises of [ADR 0009](docs/adr/0009-stability.md).** A format change needs a new
  format version and a new frozen fixture (never rebuild `test/fixtures/format-v1/`); a change to
  the signal schema needs a database version and a migration that keeps every signal.

## Releases

Merging the "Version packages" pull request that Changesets keeps open releases a version. CI
stages it on npm with trusted publishing, a maintainer approves the staged version with 2FA, and
the workflow tags it and creates its GitHub release
([ADR 0002](docs/adr/0002-tooling-and-releases.md)).
