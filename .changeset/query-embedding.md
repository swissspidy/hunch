---
'@swissspidy/hunch': minor
---

Free-text search on the device: the build publishes the model's query prompt (`model.queryPrompt`), `hunch.search(vector, options)` ranks the catalog against a query vector (optionally blended with the profile), and `@swissspidy/hunch/query` embeds the query in the browser with the catalog's own pinned model through Transformers.js (or in plain JavaScript for `hash` catalogs). The query text never leaves the device.
