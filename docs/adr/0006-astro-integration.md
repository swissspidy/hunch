# ADR 0006: The Astro integration

- Status: Accepted
- Date: 2026-11-05

## Context

An Astro site can already use Inkling: run `inkling build` on its sitemap after `astro build`,
copy the elements script, and write the `manifest` attribute on every component. That is a
second build step, a second source of truth for item ids, and a script to keep in sync. Astro
has an integration API that runs code at build time, adds scripts to every page and changes
the Vite config. With it, adding Inkling to an Astro site can be one line in
`astro.config.mjs`.

## Decision

- **A subpath export, `@swissspidy/inkling/astro`, not a separate package.** It is Node code
  (`src/astro`) that reuses the build step: `build()` from `src/node/build.ts`, the embedding
  cache, the providers, and `parsePage()` from the sitemap source. `astro` is an optional peer
  dependency (`^7`). The integration only imports Astro's types, so the module loads without
  Astro installed.
- **The catalog is the built site, by default.** At `astro:build:done` the integration reads
  the HTML file of every page Astro emitted and extracts it as the sitemap source does: the
  title from `og:title` or `<title>`, the text from `<article>`, `<main>` or `<body>`, the
  section from `article:section`, the tags from `article:tag`, the date from
  `article:published_time`, and the image from `og:image`. Reading the output, not the
  sources, means it works the same for Markdown, MDX, content collections and `.astro` pages,
  and the catalog holds what visitors see.
  - `include` and `exclude` select pages by path (without `base`): globs (`*` is one segment,
    `**` any number), regular expressions or a function. 404 and 500 pages are always left out.
  - `page(item, { path, html })` adjusts an item (its section, say) or drops it.
  - `items(context)` replaces the catalog. It receives the built pages as items, so a site can
    filter or enrich them, or return items that are not pages. Content collections can't be
    read from an integration hook (`getCollection()` only works in Astro's runtime), so a site
    that wants them as the source exports what it needs from a static endpoint or reads its
    own files.
  - Pages rendered on demand have no HTML file at build time and are left out. A site with
    them uses `items`.
- **An item's id and link are its path, with `base`, as `Astro.url.pathname` gives it while
  the page is built.** Astro's page pathnames already follow `trailingSlash`; with
  `build.format: 'file'` the integration adds `.html`, as `Astro.url.pathname` does. So a
  layout writes `item={Astro.url.pathname}` and matches the catalog. Paths, not absolute URLs,
  so the same manifest works on preview deployments and on `localhost`, and changing `site`
  does not change ids (signals refer to items by id). `site` is not needed.
- **The vectors go into the build output**, `inkling/` by default (`out`), next to the pages,
  so they deploy with the site and the manifest URL is `${base}inkling/manifest.json`.
- **The embedding cache lives in `node_modules/.cache/inkling`** by default (`cacheDir`), the
  conventional place for tool caches that survive rebuilds but are not committed. Astro empties
  the build output on every build, so the cache can't live there. In CI, `actions/cache` on
  that directory keeps rebuilds incremental, which replaces a dedicated GitHub Action. A site
  that would rather commit the cache, as the CLI suggests, sets `cacheDir: '.inkling-cache'`.
- **The provider is EmbeddingGemma by default**, through Transformers.js as an optional peer
  dependency, as for the CLI. `provider: 'hash'` is for tests and offline builds, and a
  provider object can be passed.
- **The components load on every page** with `injectScript('page', …)`, which Astro bundles
  with the site's own scripts. It imports a virtual module that sets
  `window.InklingConfig.manifest` (keeping any `InklingConfig` the page already set), then
  `@swissspidy/inkling/elements`. Module imports run in order, so the manifest is known before
  the components register. `script: false` turns this off for sites that load the components
  themselves.
- **The components take a default manifest from `window.InklingConfig.manifest`** when they
  have no `manifest` attribute, and the ES module build of the components now applies
  `window.InklingConfig` when it registers them, as the script-tag build always did. That is
  how the integration tells the components the manifest URL, and it lets an Astro site set its
  consent hook the same way as any other site: an inline script in `<head>`. Pages still
  server-render the slots, so there is still no layout shift.
- **No `.astro` components.** The slot markup is the site's own (its classes, its fallback
  query), and a component would have to guess both. The README shows the markup for a layout.
- **`astro dev` serves the last build's vectors.** The dev server builds no catalog (it renders
  pages on request, so there is no set of built pages), but the integration serves `inkling/`
  from the build output directory if a build left one there. Before the first build the lists
  keep their fallback, and the dev server logs why once.

## Consequences

- Adding Inkling to an Astro site is the integration, the slot markup in a layout, and caching
  one directory in CI.
- The unit tests build a fixture site with the real `astro build` (hash provider): the
  catalog from the built pages, the filters, `items`, `base`, `build.format`, a second build
  that embeds nothing, the injected script, and the dev server. A browser test serves the
  built fixture and checks that a related list fills in place with no layout shift, and that a
  page's own `InklingConfig` keeps its consent hook. Each build takes about half a second to a
  few seconds.
- Reading the built HTML with regular expressions, as the sitemap source does, depends on the
  site's meta tags. A page without `article:section` has no section, and `page` or `items`
  sets one.
- The integration follows Astro's integration API (version 7). A breaking change there needs
  a new release; the peer dependency range says which versions are supported.
