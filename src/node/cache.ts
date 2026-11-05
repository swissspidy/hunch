/**
 * The embedding cache that makes rebuilds incremental: full-size vectors keyed by the SHA-256
 * of the model and the exact input, one file per model. Changing the dimensions or the
 * quantization re-uses it; changing the model, its revision or the prompt does not.
 *
 * File layout (little-endian): magic "INKC", u32 version (1), u32 dims, u32 count, then
 * `count` records of [32-byte key][dims float32].
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelInfo } from '../format/manifest.ts';

const MAGIC = 0x434b4e49; // "INKC"
const HEADER = 16;

/** The embedding cache: full-size vectors keyed by model and input, one file per model. */
export class EmbeddingCache {
  private readonly entries = new Map<string, Float32Array>();
  private readonly used = new Set<string>();
  private readonly file: string | undefined;
  private readonly model: ModelInfo;
  private dirty = false;

  private constructor(model: ModelInfo, file: string | undefined) {
    this.model = model;
    this.file = file;
  }

  /** Opens the cache for `model` in `dir`, or an in-memory cache without a directory. */
  static async open(model: ModelInfo, dir?: string): Promise<EmbeddingCache> {
    const file = dir ? join(dir, `${slug(model.id)}@${slug(model.revision)}.vec`) : undefined;
    const cache = new EmbeddingCache(model, file);
    if (file) await cache.read(file);
    return cache;
  }

  /** The cache key of an input (already prompted): a SHA-256 of the model and the input. */
  key(input: string): string {
    return createHash('sha256')
      .update(`${this.model.id}\0${this.model.revision}\0${this.model.dtype ?? ''}\0${input}`)
      .digest('hex');
  }

  /** The cached vector for `key`, if any; marks the entry as used by this build. */
  get(key: string): Float32Array | undefined {
    const v = this.entries.get(key);
    if (v) this.used.add(key);
    return v;
  }

  /** Caches a full-size vector for `key`. */
  set(key: string, vector: Float32Array): void {
    this.entries.set(key, vector);
    this.used.add(key);
    this.dirty = true;
  }

  /** Writes the cache, keeping only the entries this build used. */
  async save(): Promise<void> {
    if (!this.file) return;
    if (!this.dirty && this.used.size === this.entries.size) return;
    const dims = this.model.nativeDims;
    const keys = [...this.used].sort();
    const out = Buffer.alloc(HEADER + keys.length * (32 + dims * 4));
    out.writeUInt32LE(MAGIC, 0);
    out.writeUInt32LE(1, 4);
    out.writeUInt32LE(dims, 8);
    out.writeUInt32LE(keys.length, 12);
    let offset = HEADER;
    for (const key of keys) {
      out.write(key, offset, 'hex');
      offset += 32;
      const v = this.entries.get(key)!;
      for (let d = 0; d < dims; d++, offset += 4) out.writeFloatLE(v[d]!, offset);
    }
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(`${this.file}.tmp`, out);
    await rename(`${this.file}.tmp`, this.file);
  }

  private async read(file: string): Promise<void> {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const dims = this.model.nativeDims;
    if (data.length < HEADER || data.readUInt32LE(0) !== MAGIC || data.readUInt32LE(4) !== 1) {
      throw new Error(`${file} is not an Inkling embedding cache`);
    }
    if (data.readUInt32LE(8) !== dims) return; // A different model shape: start over.
    const count = data.readUInt32LE(12);
    let offset = HEADER;
    for (let i = 0; i < count; i++) {
      const key = data.toString('hex', offset, offset + 32);
      offset += 32;
      const v = new Float32Array(dims);
      for (let d = 0; d < dims; d++, offset += 4) v[d] = data.readFloatLE(offset);
      this.entries.set(key, v);
    }
  }
}

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
