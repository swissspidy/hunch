---
'@swissspidy/hunch': minor
---

Shards keep each item's prior, publication time and section in binary columns, list the item ids in a small JSON header, and keep the rest of each item's metadata (title, URL, tags, date, image) as separate JSON that the client decodes only for the items a call returns ([ADR 0011](https://github.com/swissspidy/hunch/blob/main/docs/adr/0011-shard-columns.md)). With 100,000 items loaded in Chromium the JS heap is about 5 MB, and recency does not depend on how the visitor's browser parses dates. On plain-HTTP pages, where `crypto.subtle` is missing, `fetch()` checks each shard's hash as Subresource Integrity, so a custom `fetch` must honour `init.integrity`. `decodeShard()` from `@swissspidy/hunch/format` returns the columns (`ids`, `prior`, `time`, `sections`, `section`), `count`, `version` and `item(i)`, alongside `items`.
