# ADR 0002: Tooling, CI and releases

- Status: Accepted
- Date: 2026-11-04

## Context

Hunch ships two very different things in one package: a Node.js build step and a browser
client with no dependencies and a size budget. The tooling should be fast, need little
configuration, and keep the two apart. It follows
[swissspidy/sandburg](https://github.com/swissspidy/sandburg), whose setup has proven itself.

## Decision

- **Node.js 24 or later** (`engines.node`). Node runs the TypeScript sources directly (type
  stripping), so a checkout needs no build to test or to run `bin/hunch.js`. Sources use only
  erasable syntax (`erasableSyntaxOnly`) and import with `.ts` extensions.
- **TypeScript 7** (the native compiler) type-checks (`npm run typecheck`) and emits `dist/` with
  declarations (`npm run build`, run by `prepack`). `rewriteRelativeImportExtensions` turns the
  `.ts` imports into `.js`. esbuild bundles only the script-tag build (`hunch.global.js`) and
  the size check.
- **oxlint with type-aware rules** (`oxlint-tsgolint`), and **knip** for unused files, exports and
  dependencies (`npm run lint`). oxlint also enforces the client's boundary: files under
  `src/format`, `src/rank`, `src/client`, `src/elements`, `src/digest` and `src/query` can import neither `node:*` modules
  nor the build step's dependencies (ADR 0001: no dependencies, no model in the browser).
- **oxfmt** formats everything (`npm run format`; CI runs `format:check`).
- **Tests use `node:test`.** Unit tests in `test/unit` (with the `hash` provider, no network or
  model), the demo in Chromium, Firefox and WebKit through `playwright-core` in `test/e2e`, and the packed package
  installed into an empty project in `test/pack`.
- **The client's size is a CI check.** `npm run size` fails above 10 KB gzipped for the core
  and 12 KB with the web components, and writes the numbers into the job summary.
- **CI** (`.github/workflows/ci.yml`) runs type checking, lint, the format check, unit tests and
  the size check on Linux, unit tests on macOS and Windows, the browser tests, the package
  test, and the WordPress plugin's tests on the oldest and a current PHP. Actions are pinned to commits, checkouts don't persist credentials, and every workflow
  declares least-privilege permissions. zizmor checks the workflows.
- **Dependabot** updates npm and GitHub Actions weekly, grouped, after a 7-day cooldown.
- **Releases use Changesets and npm trusted publishing** (`.github/workflows/release.yml`), as in
  Sandburg: pull requests add changesets, and Changesets keeps a "Version packages" pull request
  open. When `main`'s version has no tag and isn't on npm, the workflow tests and packs the
  package in one job, then stages the tarball on npm in another. That job installs nothing and
  holds the OIDC token, and npm adds provenance. A staged version goes public once a maintainer
  approves it with 2FA. **Only then is it tagged**: the next run (the next push to `main`, or
  starting the workflow by hand) finds the version on npm without a tag, and tags the commit
  that set it and creates its GitHub release from the changelog. A rejected stage is never
  tagged, so it is staged again. The `0.0.0` placeholder is never released.
- **The package is `@swissspidy/hunch`** (`hunch` is taken on npm), and the version stays
  0.x while the API settles.
- **GitHub Pages hosts the site** (`.github/workflows/pages.yml`), built on every push to `main`:
  the front page, the demo, the API reference, and the WordPress plugin's zip with its Playground
  demo.

## Consequences

- No transpile step for development, tests or the CLI from a checkout. Only the npm package is
  compiled.
- The repository stores no npm token. Publishing needs the `npm` environment and a trusted
  publisher configured on npmjs.com for this workflow. It also needs a maintainer's approval
  for every version.
- The pull request that Changesets opens is pushed with `GITHUB_TOKEN`, so it gets no
  `pull_request` CI. The release workflow starts CI on its branch with `workflow_dispatch`
  instead.
