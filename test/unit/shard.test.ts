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
});

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
