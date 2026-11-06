/**
 * The catalog's vectors in one contiguous block, and the loop the client spends its time in:
 * dot products of a float query with a range of rows (ADR 0010).
 *
 * Two implementations with the same interface. The WebAssembly one keeps the rows in the
 * module's memory and works on several lanes at a time (SIMD). For int8 rows it splits the
 * query into two int16 vectors and sums exactly in integers, which keeps about 30 bits of the
 * query: closer to float64 than float32 arithmetic would be. The JavaScript one, in float64, is
 * the fallback where WebAssembly or its SIMD is unavailable (old browsers, or a Content Security
 * Policy without `'wasm-unsafe-eval'`). For int8 rows the two agree to about 1e-9.
 */

import type { Quantization } from '../format/manifest.ts';
import { KERNEL_WASM } from './kernel-wasm.ts';

/** Rows of `dims` components, appended shard by shard; row numbers never change. */
export interface VectorStore {
  readonly dims: number;
  readonly quantization: Quantization;
  /** Rows stored. */
  readonly count: number;
  /** `'wasm'` or `'js'`: which implementation runs. */
  readonly kind: 'wasm' | 'js';
  /** Appends `rows` rows (row-major) and returns the first one's number. */
  append(vectors: Int8Array | Float32Array, rows: number): number;
  /**
   * out[at + k] = Σ_d query[d] · row[from + k][d] for k in [0, to - from). `query` has `dims`
   * components; `to - from` is at most {@link MAX_SPAN}.
   */
  dots(query: Float32Array, from: number, to: number, out: Float64Array, at?: number): void;
  /** Row `row`'s components (a view: valid until the next `append`). */
  row(row: number): Int8Array | Float32Array;
  /** Σ_d query[d] · row[d] for one row, in float64: for single rows, where a kernel call costs more. */
  dot(query: Float32Array, row: number): number;
}

/** Σ_d query[d] · data[at + d] in float64. */
function dotAt(
  query: Float32Array,
  data: Int8Array | Float32Array,
  at: number,
  dims: number,
): number {
  let sum = 0;
  for (let d = 0; d < dims; d++) sum += query[d]! * data[at + d]!;
  return sum;
}

/** The most rows one `dots` call takes. */
export const MAX_SPAN = 16384;

/**
 * A store for the given shape: WebAssembly SIMD where it runs and the shape suits it (int8 rows,
 * dims a multiple of 16), else JavaScript. `prefer: 'js'` forces the fallback. Float32 rows,
 * four times the bytes and no better rankings (docs/evaluation.md), stay in JavaScript.
 */
export function createVectorStore(
  dims: number,
  quantization: Quantization,
  prefer: 'wasm' | 'js' = 'wasm',
): VectorStore {
  if (prefer === 'wasm' && quantization === 'int8' && dims % 16 === 0) {
    const exports = instantiate();
    if (exports) return new WasmStore(exports, dims);
  }
  return new JsStore(dims, quantization);
}

interface KernelExports {
  memory: WebAssembly.Memory;
  dotsI8(
    hi: number,
    lo: number,
    rows: number,
    n: number,
    dims: number,
    out: number,
    scaleHi: number,
    scaleLo: number,
  ): void;
}

/** A fresh kernel instance, or `undefined` where WebAssembly SIMD can't run. */
function instantiate(): KernelExports | undefined {
  try {
    const W = globalThis.WebAssembly;
    if (!W) return undefined;
    const bytes = Uint8Array.from(atob(KERNEL_WASM), (c) => c.charCodeAt(0));
    // Synchronous: the module is under 1 KB, well within what browsers compile on the main
    // thread. Fails without SIMD, or where a CSP forbids compiling WebAssembly.
    return new W.Instance(new W.Module(bytes)).exports as unknown as KernelExports;
  } catch {
    return undefined;
  }
}

const PAGE = 65536;

/** int8 rows in the kernel's memory. */
class WasmStore implements VectorStore {
  readonly kind = 'wasm';
  readonly quantization = 'int8';
  count = 0;
  private readonly kernel: KernelExports;
  readonly dims: number;
  /** The query as two int16 vectors (hi at 0), then the output (MAX_SPAN × f64), then the rows. */
  private readonly loAt: number;
  private readonly outAt: number;
  private readonly rowsAt: number;
  /** Largest |hi| and |lo| that keep a row's i32 sum in range: 128 · limit · dims < 2^31. */
  private readonly limit: number;
  private view: Int8Array | undefined;

  constructor(kernel: KernelExports, dims: number) {
    this.kernel = kernel;
    this.dims = dims;
    this.loAt = dims * 2;
    this.outAt = dims * 4;
    this.rowsAt = this.outAt + MAX_SPAN * 8;
    this.limit = Math.min(32767, Math.floor((2 ** 31 - 1) / (128 * dims)));
    this.reserve(0);
  }

  append(vectors: Int8Array | Float32Array, rows: number): number {
    const first = this.count;
    this.reserve(first + rows);
    this.rows().set(vectors.subarray(0, rows * this.dims), first * this.dims);
    this.count += rows;
    return first;
  }

  dots(query: Float32Array, from: number, to: number, out: Float64Array, at = 0): void {
    const n = to - from;
    if (n <= 0) return;
    const { dims, limit } = this;
    const { buffer } = this.kernel.memory;
    // q ≈ (hi + lo / s2) / s1, with |hi| and |lo| at most `limit`.
    let max = 0;
    for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(query[d]!));
    const s1 = max > 0 ? limit / max : 0;
    const s2 = 2 * limit;
    const hi = new Int16Array(buffer, 0, dims);
    const lo = new Int16Array(buffer, this.loAt, dims);
    for (let d = 0; d < dims; d++) {
      const x = query[d]! * s1;
      hi[d] = Math.round(x);
      lo[d] = Math.round((x - hi[d]!) * s2);
    }
    const scale = s1 > 0 ? 1 / s1 : 0;
    this.kernel.dotsI8(
      0,
      this.loAt,
      this.rowsAt + from * dims,
      n,
      dims,
      this.outAt,
      scale,
      scale / s2,
    );
    out.set(new Float64Array(buffer, this.outAt, n), at);
  }

  row(row: number): Int8Array {
    return this.rows().subarray(row * this.dims, (row + 1) * this.dims);
  }

  dot(query: Float32Array, row: number): number {
    return dotAt(query, this.rows(), row * this.dims, this.dims);
  }

  /** A view of the rows, renewed when the memory grows (growing detaches the old buffer). */
  private rows(): Int8Array {
    const { buffer } = this.kernel.memory;
    if (this.view?.buffer !== buffer) this.view = new Int8Array(buffer, this.rowsAt);
    return this.view;
  }

  private reserve(rows: number): void {
    const { memory } = this.kernel;
    const needed = this.rowsAt + rows * this.dims;
    const size = memory.buffer.byteLength;
    // Grow by at least half again, so appending shard by shard stays linear.
    if (needed > size) memory.grow(Math.ceil((Math.max(needed, size * 1.5) - size) / PAGE));
  }
}

class JsStore implements VectorStore {
  readonly kind = 'js';
  count = 0;
  private data: Int8Array | Float32Array;

  readonly dims: number;
  readonly quantization: Quantization;

  constructor(dims: number, quantization: Quantization) {
    this.dims = dims;
    this.quantization = quantization;
    this.data = this.allocate(1024 * dims);
  }

  append(vectors: Int8Array | Float32Array, rows: number): number {
    const first = this.count;
    const needed = (first + rows) * this.dims;
    if (needed > this.data.length) {
      const grown = this.allocate(Math.max(needed, this.data.length * 1.5));
      grown.set(this.data.subarray(0, first * this.dims));
      this.data = grown;
    }
    this.data.set(vectors.subarray(0, rows * this.dims), first * this.dims);
    this.count += rows;
    return first;
  }

  dots(query: Float32Array, from: number, to: number, out: Float64Array, at = 0): void {
    const { dims, data } = this;
    for (let r = from; r < to; r++) out[at + r - from] = dotAt(query, data, r * dims, dims);
  }

  row(row: number): Int8Array | Float32Array {
    return this.data.subarray(row * this.dims, (row + 1) * this.dims);
  }

  dot(query: Float32Array, row: number): number {
    return dotAt(query, this.data, row * this.dims, this.dims);
  }

  private allocate(length: number): Int8Array | Float32Array {
    const n = Math.ceil(length);
    return this.quantization === 'int8' ? new Int8Array(n) : new Float32Array(n);
  }
}
