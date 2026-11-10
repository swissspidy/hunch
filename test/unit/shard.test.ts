import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeShard, encodeShard } from '../../src/format/shard.ts';
import { normalize } from '../../src/rank/vector.ts';
import { arrayBuffer } from '../helpers.ts';

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
  const shard = decodeShard(arrayBuffer(encodeShard({ space: 's', items }, vectors, 5, 'float32')));
  assert.equal(shard.space, 's');
  assert.equal(shard.dims, 5);
  assert.equal(shard.quantization, 'float32');
  assert.deepEqual(shard.items, items);
  assert.deepEqual([...shard.vectors.subarray(0, 5)], [...vectors[0]!]);
  assert.ok(Math.abs(shard.invNorms[0]! - 1) < 1e-6);
});

test('int8 shards keep cosine similarity within 1%', () => {
  const shard = decodeShard(arrayBuffer(encodeShard({ space: 's', items }, vectors, 5, 'int8')));
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
  const shard = decodeShard(arrayBuffer(encodeShard({ space: 's', items }, vectors, 5, 'int8')));
  assert.equal(shard.version, 1);
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
      const buffer = arrayBuffer(bytes);
      const view = new DataView(buffer);
      const columns = Math.ceil((24 + view.getUint32(16, true)) / 8) * 8;
      assert.equal(view.getFloat64(columns, true), 1, `${id}: the prior opens the columns`);
      const shard = decodeShard(buffer);
      assert.equal(shard.vectors.byteOffset % 4, 0);
      assert.deepEqual(shard.item(0), { id, url: '/', title: 'T', prior: 1 });
    }
  }
});

test('bad input is rejected', () => {
  assert.throws(() => decodeShard(new ArrayBuffer(4)), /truncated/);
  assert.throws(() => decodeShard(new ArrayBuffer(64)), /magic/);
  const bytes = encodeShard({ space: 's', items }, vectors, 5, 'int8');
  assert.throws(() => decodeShard(arrayBuffer(bytes.subarray(0, bytes.length - 1))), /truncated/);
  assert.throws(
    () => encodeShard({ space: 's', items }, [vectors[0]!], 5, 'int8'),
    /2 items but 1 vectors/,
  );
  for (const header of ['null', '{}', '{"space":"s","ids":[]}', '{"space":"s","sections":[]}']) {
    assert.throws(() => decodeShard(withHeader(header)), /needs a space, sections and ids/, header);
  }
  assert.throws(
    () => decodeShard(withHeader('{"space":"s","sections":[],"ids":["a"]}')),
    /lists 1 items, not 0/,
  );
  // Metadata lengths that don't add up, or a section the header doesn't list.
  const good = encodeShard({ space: 's', items }, vectors, 5, 'int8');
  const view = new DataView(good.buffer);
  const lengths = Math.ceil((24 + view.getUint32(16, true)) / 8) * 8 + 16 * 2;
  const broken = good.slice();
  new DataView(broken.buffer).setUint32(lengths + 4, 10_000, true);
  assert.throws(() => decodeShard(arrayBuffer(broken)), /bad metadata lengths/);
  const unlisted = good.slice();
  new DataView(unlisted.buffer).setUint16(lengths + 8 + 2, 1, true);
  assert.throws(() => decodeShard(arrayBuffer(unlisted)), /section index is out of range/);
});

/** A shard with no items and the given raw JSON header. */
function withHeader(json: string): ArrayBuffer {
  const text = new TextEncoder().encode(json);
  const start = 24;
  const out = new Uint8Array(start + text.length + 16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x48434e48, true);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, 4, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, text.length, true);
  out.set(text, start);
  return out.buffer;
}

test('a shard holds up to 65,535 sections (0xffff means none)', () => {
  const shard = (sections: number) =>
    encodeShard(
      {
        space: 's',
        items: Array.from({ length: sections + 1 }, (_, i) => ({
          id: `${i}`,
          url: '/',
          title: '',
          ...(i < sections ? { section: `s${i}` } : {}),
          prior: 1,
        })),
      },
      Array.from({ length: sections + 1 }, () => Float32Array.of(1)),
      1,
      'int8',
    );
  const decoded = decodeShard(arrayBuffer(shard(0xffff)));
  assert.equal(decoded.sections.length, 0xffff);
  assert.deepEqual([...decoded.section.subarray(-2)], [0xfffe, -1]);
  assert.throws(() => shard(0x10000), /too many sections/);
});
