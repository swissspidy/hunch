import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeShard, encodeShard } from '../../src/format/shard.ts';
import { normalize } from '../../src/rank/vector.ts';

const items = [
  { id: 'a', url: '/a', title: 'A', prior: 1 },
  {
    id: 'b',
    url: '/b',
    title: 'B',
    section: 'x',
    tags: ['t'],
    date: '2026-01-01T00:00:00.000Z',
    prior: 0.5,
  },
];
const vectors = [normalize([3, -4, 0, 1, 2]), normalize([0.1, 0.2, -0.3, 0.4, -0.5])];

test('float32 shards round-trip exactly', () => {
  const shard = decodeShard(copy(encodeShard({ space: 's', items }, vectors, 5, 'float32')));
  assert.equal(shard.space, 's');
  assert.equal(shard.dims, 5);
  assert.equal(shard.quantization, 'float32');
  assert.deepEqual(shard.items, items);
  assert.deepEqual([...shard.vectors.subarray(0, 5)], [...vectors[0]!]);
  assert.ok(Math.abs(shard.invNorms[0]! - 1) < 1e-6);
});

test('int8 shards keep cosine similarity within 1%', () => {
  const shard = decodeShard(copy(encodeShard({ space: 's', items }, vectors, 5, 'int8')));
  assert.equal(shard.quantization, 'int8');
  for (let i = 0; i < 2; i++) {
    let dot = 0;
    for (let d = 0; d < 5; d++) dot += vectors[i]![d]! * shard.vectors[i * 5 + d]!;
    assert.ok(
      Math.abs(dot * shard.invNorms[i]! - 1) < 0.01,
      `row ${i}: ${dot * shard.invNorms[i]!}`,
    );
  }
});

test('the vector data is 4-byte aligned whatever the header length', () => {
  for (const title of ['', 'x', 'xy', 'xyz', 'é']) {
    const bytes = encodeShard(
      { space: 's', items: [{ id: 'a', url: '/', title, prior: 1 }] },
      [vectors[0]!],
      5,
      'float32',
    );
    assert.equal(decodeShard(copy(bytes)).vectors.byteOffset % 4, 0);
  }
});

test('bad input is rejected', () => {
  assert.throws(() => decodeShard(new ArrayBuffer(4)), /truncated/);
  assert.throws(() => decodeShard(new ArrayBuffer(64)), /magic/);
  const bytes = encodeShard({ space: 's', items }, vectors, 5, 'int8');
  assert.throws(() => decodeShard(copy(bytes.subarray(0, bytes.length - 1))), /truncated/);
  assert.throws(
    () => encodeShard({ space: 's', items }, [vectors[0]!], 5, 'int8'),
    /2 items but 1 vectors/,
  );
  for (const header of ['null', '{}', '{"items":[]}', '{"space":"s"}']) {
    assert.throws(
      () => decodeShard(withHeader(header)),
      /needs a string space and an items array/,
      header,
    );
  }
});

/** A shard with no vectors and the given raw JSON header. */
function withHeader(json: string): ArrayBuffer {
  const text = new TextEncoder().encode(json);
  const out = new Uint8Array(20 + text.length + 3);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x564b4e49, true);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, 4, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, text.length, true);
  out.set(text, 20);
  return out.buffer;
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

test('the JavaScript SHA-256 matches node:crypto', async () => {
  const { createHash } = await import('node:crypto');
  const { sha256Hex } = await import('../../src/format/sha256.ts');
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
    assert.equal(
      sha256Hex(bytes),
      createHash('sha256').update(bytes).digest('hex'),
      `length ${length}`,
    );
  }
});
