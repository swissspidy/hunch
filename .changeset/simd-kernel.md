---
'@swissspidy/inkling': minor
---

Ranking is about 11× faster in Node and 5× faster in a throttled browser on a 100,000-item catalog (ADR 0010). The client keeps the loaded catalog as columns (one contiguous block of vectors, and typed arrays for norms, priors, dates and sections) and computes similarities with a 332-byte WebAssembly SIMD kernel that splits the query into two int16 vectors and sums exactly in integers. Results match the previous release to within 1e-8. Where WebAssembly SIMD is unavailable (older browsers, a Content Security Policy without `'wasm-unsafe-eval'`) or the catalog is float32, a JavaScript kernel gives the same results. New: `Inkling.load({ kernel: 'js' })` forces it, and `inkling.kernel` says which one runs.
