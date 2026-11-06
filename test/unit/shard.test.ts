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

test('the columns are read as written, the metadata only on demand', () => {
  const shard = decodeShard(copy(encodeShard({ space: 's', items }, vectors, 5, 'int8')));
  assert.equal(shard.version, 2);
  assert.equal(shard.count, 2);
  assert.deepEqual(shard.ids, ['a', 'b']);
  assert.deepEqual([...shard.prior], [1, 0.5]);
  assert.deepEqual([...shard.time], [NaN, Date.parse('2026-01-01T00:00:00.000Z')]);
  assert.deepEqual(shard.sections, ['x']);
  assert.deepEqual([...shard.section], [-1, 0]);
  assert.deepEqual(shard.item(1), items[1]);
  // Norms are computed from the rows as stored.
  for (let i = 0; i < 2; i++) {
    let sum = 0;
    for (let d = 0; d < 5; d++) sum += shard.vectors[i * 5 + d]! ** 2;
    assert.equal(shard.invNorms[i], Math.fround(1 / Math.sqrt(sum)));
  }
});

test('the columns and vectors are aligned whatever the header length', () => {
  for (const id of ['', 'x', 'xy', 'xyz', 'é', 'abcdefg']) {
    for (const quantization of ['int8', 'float32'] as const) {
      const bytes = encodeShard(
        { space: 's', items: [{ id, url: '/', title: 'T', prior: 1 }] },
        [vectors[0]!],
        5,
        quantization,
      );
      const buffer = copy(bytes);
      const view = new DataView(buffer);
      const columns = Math.ceil((24 + view.getUint32(16, true)) / 8) * 8;
      assert.equal(view.getFloat64(columns, true), 1, `${id}: the prior opens the columns`);
      const shard = decodeShard(buffer);
      assert.equal(shard.vectors.byteOffset % 4, 0);
      assert.deepEqual(shard.item(0), { id, url: '/', title: 'T', prior: 1 });
    }
  }
});

test('version 1 shards are still read', () => {
  const header = JSON.stringify({ space: 's', items });
  const text = new TextEncoder().encode(header);
  const start = Math.ceil((20 + text.length) / 4) * 4;
  const out = new Uint8Array(start + 2 * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x564b4e49, true);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, 4, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, text.length, true);
  out.set(text, 20);
  out.set([3, 4, 0, 0, 0, 0, 0, 2], start);
  const shard = decodeShard(out.buffer);
  assert.equal(shard.version, 1);
  assert.deepEqual(shard.items, items);
  assert.deepEqual(shard.ids, ['a', 'b']);
  assert.deepEqual([...shard.prior], [1, 0.5]);
  assert.deepEqual([...shard.time], [NaN, Date.parse('2026-01-01T00:00:00.000Z')]);
  assert.deepEqual(shard.sections, ['x']);
  assert.deepEqual([...shard.section], [-1, 0]);
  assert.deepEqual([...shard.invNorms], [Math.fround(0.2), 0.5]);
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
  for (const header of ['null', '{}', '{"space":"s","ids":[]}', '{"space":"s","sections":[]}']) {
    assert.throws(
      () => decodeShard(withHeader(header, 2)),
      /needs a space, sections and ids/,
      header,
    );
  }
  assert.throws(
    () => decodeShard(withHeader('{"space":"s","sections":[],"ids":["a"]}', 2)),
    /lists 1 items, not 0/,
  );
  // Metadata lengths that don't add up, or a section the header doesn't list.
  const good = encodeShard({ space: 's', items }, vectors, 5, 'int8');
  const view = new DataView(good.buffer);
  const lengths = Math.ceil((24 + view.getUint32(16, true)) / 8) * 8 + 16 * 2;
  const broken = good.slice();
  new DataView(broken.buffer).setUint32(lengths + 4, 10_000, true);
  assert.throws(() => decodeShard(copy(broken)), /bad metadata lengths/);
  const unlisted = good.slice();
  new DataView(unlisted.buffer).setUint16(lengths + 8 + 2, 1, true);
  assert.throws(() => decodeShard(copy(unlisted)), /section index is out of range/);
});

/** A shard with no items and the given raw JSON header. */
function withHeader(json: string, version = 1): ArrayBuffer {
  const text = new TextEncoder().encode(json);
  const start = version === 1 ? 20 : 24;
  // Room for an empty shard's columns (version 2: one metadata offset, 0).
  const out = new Uint8Array(start + text.length + 16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x564b4e49, true);
  view.setUint8(4, version);
  view.setUint8(5, 1);
  view.setUint32(8, 4, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, text.length, true);
  out.set(text, start);
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
