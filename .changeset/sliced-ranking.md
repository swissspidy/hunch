---
'@swissspidy/inkling': patch
---

Large catalogs no longer block input while they load and rank: the client scores candidates in short slices and yields to the page between them (with `scheduler.yield()` where the browser has it, otherwise a new task), and decodes each shard in a task of its own. Results are unchanged, except that items with exactly equal scores now always come in manifest order instead of the order their shards arrived in. Ranking is also faster, because only the best candidates are kept in order instead of sorting all of them. No API or option changes (ADR 0008).
