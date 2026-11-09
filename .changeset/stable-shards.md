---
'@swissspidy/hunch': minor
---

Shards stay the same when the catalog changes, so returning readers download only what changed. Priors are counted from the end of the site's order over a power of two, so a new post at the top changes no other item's prior. A section's items are spread over buckets by a hash of their id (sections of more than half of `maxShardItems` get several shards), so an edit or a new post rewrites one shard. The format is unchanged.
