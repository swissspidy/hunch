/**
 * `npm run wordpress:build`: bundles the script-tag client into the WordPress plugin
 * (wordpress/inkling/assets/inkling.global.js, the same bundle as dist/inkling.global.js) and
 * zips the plugin for upload: wordpress/inkling.zip, without its tests and dev tools (ADR 0007).
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { bundleGlobal } from './bundle.ts';

const PLUGIN = 'wordpress/inkling';
const ZIP = 'wordpress/inkling.zip';
/** What the plugin ships: the rest of the directory is for development. */
const SHIPPED = ['inkling.php', 'uninstall.php', 'readme.txt', 'includes', 'assets'];

await bundleGlobal(join(PLUGIN, 'assets', 'inkling.global.js'));

const files: string[] = [];
for (const entry of SHIPPED) {
  const path = join(PLUGIN, entry);
  if (entry.includes('.')) files.push(path);
  else {
    for (const file of await readdir(path, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) files.push(join(file.parentPath, file.name));
    }
  }
}
files.sort();

const zip = zipFiles(
  await Promise.all(
    files.map(async (file) => ({
      name: `inkling/${relative(PLUGIN, file).split(sep).join('/')}`,
      data: await readFile(file),
    })),
  ),
);
await writeFile(ZIP, zip);
console.log(`${ZIP}: ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`);

/** A plain zip archive (deflate), with a fixed date so the same files give the same bytes. */
function zipFiles(entries: { name: string; data: Buffer }[]): Buffer {
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01, DOS format
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
