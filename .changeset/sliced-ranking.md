---
'@swissspidy/hunch': patch
---

Large catalogs do not block input while they load and rank: the client scores candidates in short slices and yields to the page between them (with `scheduler.yield()` where the browser has it, otherwise a new task), and decodes each shard in a task of its own. Where the slices fall never changes a result: items with exactly equal scores come in manifest order, whatever order their shards arrived in (ADR 0008).
