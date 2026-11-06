/** Small vector helpers shared by the build step and the client. */

/** Returns `v` scaled to unit length (a new array; zero vectors stay zero). */
export function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const out = new Float32Array(v.length);
  if (sum === 0) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

/**
 * Matryoshka truncation: the first `dims` components, renormalized. Only meaningful for models
 * trained with Matryoshka representation learning (EmbeddingGemma: 768, 512, 256, 128).
 */
export function truncate(v: ArrayLike<number>, dims: number): Float32Array {
  if (dims > v.length) throw new RangeError(`Cannot truncate ${v.length} dims to ${dims}`);
  return normalize(Array.prototype.slice.call(v, 0, dims) as number[]);
}
