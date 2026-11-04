---
'@swissspidy/inkling': minor
---

First release (milestone 1): `inkling build` embeds a catalog from JSON, RSS/Atom, a sitemap or a loader module with EmbeddingGemma (or a pluggable provider) into `manifest.json` and int8 vector shards, incrementally. The dependency-free client ranks related items in the browser with `const inkling = await Inkling.load({ manifest })` and `await inkling.related(id)`, and `<inkling-related>` fills server-rendered slots with them without layout shift.
