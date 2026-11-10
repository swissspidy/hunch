---
'@swissspidy/hunch': minor
---

EmbeddingGemma's q4 weights load `model_no_gather_q4`, the q4 file browsers can run: `model_q4` needs an ONNX Runtime operator (`GatherBlockQuantized`) that browsers lack. The manifest names the file in an optional `model.file` field, and it is part of the space and the embedding-cache key.
