// A small streaming .zip writer for `scripts/build-pack.mjs`. It writes straight to a file, one
// entry at a time, so a multi-gigabyte pack never sits in memory (each entry is read whole, so an
// entry must fit in memory: the pack format caps one file at 512 MiB). It writes ZIP64 records
// when the entry count or an offset passes the classic limits, and fixed timestamps and sorted
// input make the output reproducible.

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { crc32, deflateRawSync } from 'node:zlib';

const STORE_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.avif', '.gz', '.zip', '.woff', '.woff2', '.mp4', '.webm', '.mov', '.mp3', '.pdf']);
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}
function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}
function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

export class ZipWriter {
  #stream;
  #offset = 0;
  #entries = [];
  #names = new Set();

  constructor(file) {
    this.#stream = createWriteStream(file, { flags: 'wx', mode: 0o644 });
  }

  get entryCount() {
    return this.#entries.length;
  }

  async #write(buffer) {
    this.#offset += buffer.length;
    if (!this.#stream.write(buffer)) await once(this.#stream, 'drain');
  }

  /** Adds a file whose bytes are on disk. */
  async addFile(name, absolutePath) {
    await this.addBuffer(name, await readFile(absolutePath));
  }

  /** Adds an entry from memory. */
  async addBuffer(name, data) {
    if (!/^[^/\\\0][^\\\0]*$/.test(name) || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`unsafe zip entry name: ${JSON.stringify(name)}`);
    }
    if (this.#names.has(name.toLowerCase())) throw new Error(`duplicate zip entry: ${JSON.stringify(name)}`);
    this.#names.add(name.toLowerCase());
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${JSON.stringify(name)}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    let method = 0;
    let body = data;
    if (data.length > 0 && !STORE_EXTENSIONS.has(extension)) {
      const deflated = deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    const crc = crc32(data);
    const offset = this.#offset;
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    await this.#write(header);
    await this.#write(body);
    this.#entries.push({ nameBytes, method, crc, compressed: body.length, size: data.length, offset });
  }

  /** Writes the central directory and closes the file. */
  async finish() {
    const centralStart = this.#offset;
    for (const entry of this.#entries) {
      const needsZip64 = entry.offset >= UINT32_MAX;
      const extra = needsZip64 ? Buffer.concat([u16(0x0001), u16(8), u64(entry.offset)]) : Buffer.alloc(0);
      await this.#write(Buffer.concat([
        u32(0x02014b50), u16((3 << 8) | (needsZip64 ? 45 : 20)), u16(needsZip64 ? 45 : 20), u16(0x0800), u16(entry.method),
        u16(DOS_TIME), u16(DOS_DATE), u32(entry.crc), u32(entry.compressed), u32(entry.size),
        u16(entry.nameBytes.length), u16(extra.length), u16(0), u16(0), u16(0),
        u32((0o100644 << 16) >>> 0), u32(needsZip64 ? UINT32_MAX : entry.offset), entry.nameBytes, extra,
      ]));
    }
    const centralSize = this.#offset - centralStart;
    const count = this.#entries.length;
    if (count >= UINT16_MAX || centralStart >= UINT32_MAX || centralSize >= UINT32_MAX) {
      const zip64Start = this.#offset;
      await this.#write(Buffer.concat([
        u32(0x06064b50), u64(44), u16((3 << 8) | 45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(centralSize), u64(centralStart),
      ]));
      await this.#write(Buffer.concat([u32(0x07064b50), u32(0), u64(zip64Start), u32(1)]));
      await this.#write(Buffer.concat([
        u32(0x06054b50), u16(0), u16(0), u16(UINT16_MAX), u16(UINT16_MAX), u32(UINT32_MAX), u32(UINT32_MAX), u16(0),
      ]));
    } else {
      await this.#write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(centralSize), u32(centralStart), u16(0)]));
    }
    this.#stream.end();
    await once(this.#stream, 'finish');
  }

  abort() {
    this.#stream.destroy();
  }
}
