---
'@swissspidy/hunch': minor
---

EmbeddingGemma's q4 weights now load `model_no_gather_q4`, the q4 file browsers can run. `model_q4` needs an ONNX Runtime operator (`GatherBlockQuantized`) that browsers lack, so `createQueryEmbedder(manifest, { dtype: 'q4' })` failed in browsers. The manifest names the file in an optional `model.file` field, and it is part of the space and the embedding-cache key, so a catalog built with `--dtype q4` before this release is re-embedded (q8 catalogs are unchanged).
