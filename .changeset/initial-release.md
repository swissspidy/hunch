---
'@swissspidy/hunch': minor
---

First release (milestone 1): `hunch build` embeds a catalog from JSON, RSS/Atom, a sitemap or a loader module with EmbeddingGemma (or a pluggable provider) into `manifest.json` and int8 vector shards, incrementally. The dependency-free client ranks related items in the browser with `const hunch = await Hunch.load({ manifest })` and `await hunch.related(id)`, and `<hunch-related>` fills server-rendered slots with them without layout shift.
