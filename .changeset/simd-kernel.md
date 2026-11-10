---
'@swissspidy/hunch': minor
---

Ranking a 100,000-item catalog takes about 12 ms in Node (ADR 0010). The client keeps the loaded catalog as columns (one contiguous block of vectors, and typed arrays for norms, priors, dates and sections) and computes similarities with a 332-byte WebAssembly SIMD kernel that splits the query into two int16 vectors and sums exactly in integers. Where WebAssembly SIMD is unavailable (older browsers, a Content Security Policy without `'wasm-unsafe-eval'`) or the catalog is float32, a JavaScript kernel gives the same results to within 1e-8. `Hunch.load({ kernel: 'js' })` forces it, and `hunch.kernel` says which one runs.
