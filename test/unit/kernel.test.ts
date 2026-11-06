import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compileKernel, KERNEL_TS } from '../../scripts/kernel.ts';
import type { Quantization } from '../../src/format/manifest.ts';
import { createVectorStore, MAX_SPAN } from '../../src/rank/kernel.ts';

function random(seed: number): () => number {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

function rows(count: number, dims: number, quantization: Quantization, seed: number) {
  const next = random(seed);
  return quantization === 'int8'
    ? Int8Array.from({ length: count * dims }, () => Math.round(next() * 127))
    : Float32Array.from({ length: count * dims }, next);
}

/** The dot products in float64, as a reference. */
function exact(query: Float32Array, data: Int8Array | Float32Array, dims: number, n: number) {
  return Array.from({ length: n }, (_, r) => {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += query[d]! * data[r * dims + d]!;
    return sum;
  });
}

test('kernel-wasm.ts is what kernel.wat compiles to (npm run kernel)', async () => {
  assert.equal(await readFile(KERNEL_TS, 'utf8'), await compileKernel());
});

for (const quantization of ['int8', 'float32'] as const) {
  for (const dims of [16, 64, 256, 768]) {
    test(`WebAssembly and JavaScript agree: ${quantization}, ${dims} dims`, () => {
      const wasm = createVectorStore(dims, quantization);
      const js = createVectorStore(dims, quantization, 'js');
      // Float32 rows always use JavaScript.
      assert.equal(wasm.kind, quantization === 'int8' ? 'wasm' : 'js');
      assert.equal(js.kind, 'js');
      const data = rows(300, dims, quantization, dims);
      // In two appends, the second at an offset: rows keep their numbers.
      for (const store of [wasm, js]) {
        assert.equal(store.append(data.subarray(0, 100 * dims), 100), 0);
        assert.equal(store.append(data.subarray(100 * dims), 200), 100);
        assert.equal(store.count, 300);
      }
      const next = random(7);
      const query = Float32Array.from({ length: dims }, next);
      const want = exact(query, data, dims, 300);
      const a = new Float64Array(300);
      const b = new Float64Array(300);
      wasm.dots(query, 0, 300, a);
      js.dots(query, 0, 300, b);
      // The split query keeps ~30 bits (WebAssembly); JavaScript sums in float64.
      const scale = quantization === 'int8' ? 127 * Math.sqrt(dims) : Math.sqrt(dims);
      const tolerance = quantization === 'int8' ? 1e-9 : 1e-12;
      for (let r = 0; r < 300; r++) {
        assert.ok(Math.abs(a[r]! - want[r]!) < tolerance * scale, `wasm row ${r}`);
        assert.ok(Math.abs(b[r]! - want[r]!) < 1e-12 * scale, `js row ${r}`);
      }
      // A range, written at an offset.
      const part = new Float64Array(20);
      wasm.dots(query, 150, 160, part, 10);
      assert.deepEqual([...part.subarray(10)], [...a.subarray(150, 160)]);
      assert.deepEqual([...wasm.row(123)], [...data.subarray(123 * dims, 124 * dims)]);
      assert.deepEqual([...js.row(123)], [...data.subarray(123 * dims, 124 * dims)]);
    });
  }
}

test('dims that are not a multiple of 16 fall back to JavaScript', () => {
  const store = createVectorStore(100, 'int8');
  assert.equal(store.kind, 'js');
  const data = rows(3, 100, 'int8', 1);
  store.append(data, 3);
  const query = Float32Array.from({ length: 100 }, random(2));
  const out = new Float64Array(3);
  store.dots(query, 0, 3, out);
  exact(query, data, 100, 3).forEach((want, r) => assert.ok(Math.abs(out[r]! - want) < 1e-2));
});

test('the store grows past its first allocation, and a full span works', () => {
  const dims = 64;
  for (const prefer of ['wasm', 'js'] as const) {
    const store = createVectorStore(dims, 'int8', prefer);
    const data = rows(MAX_SPAN + 500, dims, 'int8', 3);
    store.append(data, MAX_SPAN + 500);
    const query = Float32Array.from({ length: dims }, random(4));
    const out = new Float64Array(MAX_SPAN);
    store.dots(query, 500, 500 + MAX_SPAN, out);
    const want = exact(query, data.subarray(500 * dims), dims, MAX_SPAN);
    for (const r of [0, 1, MAX_SPAN - 1]) assert.ok(Math.abs(out[r]! - want[r]!) < 1e-2);
  }
});

test('without WebAssembly, or where it fails to compile, the store falls back to JavaScript', () => {
  const dims = 64;
  const data = rows(50, dims, 'int8', 5);
  const query = Float32Array.from({ length: dims }, random(6));
  const want = exact(query, data, dims, 50);
  const real = globalThis.WebAssembly;
  const g = globalThis as { WebAssembly?: typeof WebAssembly };
  const throwing = {
    ...real,
    // As a Content Security Policy without 'wasm-unsafe-eval' makes it.
    Module: function () {
      throw new real.CompileError('WebAssembly.Module(): Refused to compile');
    },
  } as unknown as typeof WebAssembly;
  for (const replacement of [undefined, throwing]) {
    g.WebAssembly = replacement;
    try {
      const store = createVectorStore(dims, 'int8');
      assert.equal(store.kind, 'js');
      store.append(data, 50);
      const out = new Float64Array(50);
      store.dots(query, 0, 50, out);
      want.forEach((w, r) => assert.ok(Math.abs(out[r]! - w) < 1e-9));
    } finally {
      g.WebAssembly = real;
    }
  }
});
