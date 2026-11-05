---
'@swissspidy/inkling': minor
---

Astro integration: `@swissspidy/inkling/astro` builds the catalog from the pages `astro build` emitted (selected with `include`, `exclude` and `page`, or replaced with `items`), writes `manifest.json` and the shards into the build output with an incremental embedding cache in `node_modules/.cache/inkling`, and loads the web components on every page with the manifest preset. The components now take their manifest from `window.InklingConfig.manifest` when they have no `manifest` attribute, and the ES module build of the components applies `window.InklingConfig` too.
