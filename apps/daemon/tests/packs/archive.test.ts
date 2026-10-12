// P1-1 specs 2, 2b and 2c: bounded pack extraction and folder-source safety.
//
// Archives are built in-test (tar.c, or hand-encoded tar blocks for entries
// tar.c never writes). Nothing touches the network or a real pack.

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import { Header } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

import { PACK_MANIFEST_MAX_BYTES, PACK_MAX_ENTRIES } from '@open-design/contracts';

import {
  assertFolderSourceSafe,
  DEFAULT_PACK_LIMITS,
  extractPackArchive,
  findPackRoot,
  placeVerifiedFiles,
} from '../../src/packs/archive.js';
import { PackError, readPackManifestFile } from '../../src/packs/manifest.js';
import {
  listDir,
  rawTar,
  sha256Hex,
  tarFixturePack,
  treeBytes,
  writeFixturePack,
  writeRawTgz,
  type RawTarEntry,
} from '../fixtures/licensed-pack/pack-fixture.js';

const MIB = 1024 * 1024;
const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function expectPackError(promise: Promise<unknown>, code: string): Promise<PackError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PackError);
  expect((error as PackError).code).toBe(code);
  return error as PackError;
}

/** A gzipped tar whose single file is `size` zero bytes, streamed so no buffer of that size exists. */
async function writeZeroFileTgz(files: { path: string; size: number }[]): Promise<string> {
  const dir = tempDir('od-pack-bomb-');
  const archivePath = path.join(dir, 'bomb.tgz');
  async function* blocks() {
    const zeros = Buffer.alloc(MIB);
    for (const file of files) {
      const header = Buffer.alloc(512);
      new Header({ path: file.path, type: 'File', size: file.size, mode: 0o644, mtime: new Date(0) }).encode(header, 0);
      yield header;
      let left = file.size;
      while (left > 0) {
        const chunk = Math.min(left, zeros.length);
        yield zeros.subarray(0, chunk);
        left -= chunk;
      }
      const pad = (512 - (file.size % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(blocks, createGzip({ level: 1 }), createWriteStream(archivePath));
  return archivePath;
}

describe('pack archive extraction (P1-1 spec 2)', () => {
  it("extraction refuses symlink, hard-link, device and FIFO entries, absolute, backslash and '..' segments, and stops a decompression bomb before the staging tree exceeds the byte budget", async () => {
    const ok: RawTarEntry = { path: 'pack/ok.txt', body: 'ok' };
    const refused: RawTarEntry[] = [
      { path: 'pack/link', type: 'SymbolicLink', linkpath: '/etc/hosts' },
      { path: 'pack/inner-link', type: 'SymbolicLink', linkpath: 'ok.txt' },
      { path: 'pack/hard', type: 'Link', linkpath: 'pack/ok.txt' },
      { path: 'pack/char', type: 'CharacterDevice' },
      { path: 'pack/block', type: 'BlockDevice' },
      { path: 'pack/fifo', type: 'FIFO' },
      { path: '/abs/evil.txt', body: 'x' },
      { path: 'pack\\evil.txt', body: 'x' },
      { path: '../evil.txt', body: 'x' },
      { path: 'pack/../../evil.txt', body: 'x' },
      { path: 'pack/./evil.txt', body: 'x' },
      { path: 'pack//evil.txt', body: 'x' },
    ];
    for (const entry of refused) {
      const destDir = tempDir('od-pack-x-');
      const archivePath = writeRawTgz([ok, entry]);
      cleanup.push(path.dirname(archivePath));
      const error = await expectPackError(extractPackArchive({ archivePath, destDir }), 'INVALID_ARCHIVE');
      // S10: every refusal names the offending entry, JSON-quoted so control
      // characters and quotes in an untrusted name stay escaped.
      expect(error.message).toContain(JSON.stringify(entry.path));
      expect(existsSync(path.join(destDir, 'pack', 'link'))).toBe(false);
      expect(existsSync(path.join(path.dirname(destDir), 'evil.txt'))).toBe(false);
    }

    // One 200 MiB zero file gzips to well under 1 MiB; refused at its header.
    const budget = 64 * MIB;
    const limits = { ...DEFAULT_PACK_LIMITS, extractedMaxBytes: budget };
    const single = await writeZeroFileTgz([{ path: 'pack/zero.bin', size: 200 * MIB }]);
    const singleDest = tempDir('od-pack-x-');
    await expectPackError(extractPackArchive({ archivePath: single, destDir: singleDest, limits }), 'TOO_LARGE');
    expect(treeBytes(singleDest)).toBeLessThanOrEqual(budget);

    // Five 20 MiB files: each under the per-file cap, together over the budget.
    const many = await writeZeroFileTgz(Array.from({ length: 5 }, (_, i) => ({ path: `pack/part-${i}.bin`, size: 20 * MIB })));
    const manyDest = tempDir('od-pack-x-');
    await expectPackError(extractPackArchive({ archivePath: many, destDir: manyDest, limits }), 'TOO_LARGE');
    expect(treeBytes(manyDest)).toBeLessThanOrEqual(budget);

    // A file over the per-file cap.
    const big = await writeZeroFileTgz([{ path: 'pack/big.bin', size: 3 * MIB }]);
    await expectPackError(
      extractPackArchive({ archivePath: big, destDir: tempDir('od-pack-x-'), limits: { ...DEFAULT_PACK_LIMITS, fileMaxBytes: 2 * MIB } }),
      'TOO_LARGE',
    );

    // Trailing zero padding after the end of the archive: the decompressed
    // stream is capped even when no entry claims the bytes.
    const paddedDir = tempDir('od-pack-pad-');
    const paddedPath = path.join(paddedDir, 'padded.tgz');
    async function* paddedBlocks() {
      yield rawTar([{ path: 'pack/tiny.txt', body: 'tiny' }]);
      for (let i = 0; i < 16; i++) yield Buffer.alloc(MIB);
    }
    await pipeline(paddedBlocks, createGzip({ level: 1 }), createWriteStream(paddedPath));
    await expectPackError(
      extractPackArchive({
        archivePath: paddedPath,
        destDir: tempDir('od-pack-x-'),
        limits: { ...DEFAULT_PACK_LIMITS, decompressedMaxBytes: 4 * MIB },
      }),
      'TOO_LARGE',
    );

    // The archive itself over its cap.
    await expectPackError(
      extractPackArchive({ archivePath: big, destDir: tempDir('od-pack-x-'), limits: { ...DEFAULT_PACK_LIMITS, archiveMaxBytes: 16 } }),
      'TOO_LARGE',
    );
  }, 120_000);

  it('extracts a gzipped or plain tarball and reports the archive sha256 and sizes', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    for (const gzip of [true, false]) {
      const archivePath = await tarFixturePack(pack.dir, { wrapper: 'acme-pack-0123abc', gzip });
      cleanup.push(path.dirname(archivePath));
      const destDir = tempDir('od-pack-x-');
      const progress: number[] = [];
      const result = await extractPackArchive({ archivePath, destDir, onProgress: (bytes) => progress.push(bytes) });
      expect(result.archiveSha256).toBe(sha256Hex(readFileSync(archivePath)));
      expect(result.archiveBytes).toBe(readFileSync(archivePath).length);
      expect(result.entries).toBeGreaterThan(pack.manifest.files.length);
      expect(progress.at(-1)).toBe(result.archiveBytes);
      const root = findPackRoot(destDir);
      expect(root).toBe(path.join(destDir, 'acme-pack-0123abc'));
      expect(readFileSync(path.join(root, 'pack.json'))).toEqual(pack.manifestBytes);
    }
  });

  it('accepts a leading ./ but refuses duplicate entries and archives that are not tar', async () => {
    const dotted = writeRawTgz([{ path: './pack.json', body: '{}' }]);
    cleanup.push(path.dirname(dotted));
    const dest = tempDir('od-pack-x-');
    await extractPackArchive({ archivePath: dotted, destDir: dest });
    expect(findPackRoot(dest)).toBe(dest);

    const dup = writeRawTgz([
      { path: 'pack/a.txt', body: 'one' },
      { path: 'pack/a.txt', body: 'two' },
    ]);
    cleanup.push(path.dirname(dup));
    await expectPackError(extractPackArchive({ archivePath: dup, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');

    const notTar = path.join(tempDir('od-pack-bad-'), 'bad.tgz');
    writeFileSync(notTar, Buffer.from('this is not an archive at all, just text'.repeat(40)));
    await expectPackError(extractPackArchive({ archivePath: notTar, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');
  });

  it('findPackRoot accepts pack.json at the root or inside exactly one wrapper directory', () => {
    const root = tempDir('od-pack-root-');
    writeFileSync(path.join(root, 'pack.json'), '{}');
    expect(findPackRoot(root)).toBe(root);

    const wrapped = tempDir('od-pack-root-');
    mkdirSync(path.join(wrapped, 'owner-repo-sha'));
    writeFileSync(path.join(wrapped, 'owner-repo-sha', 'pack.json'), '{}');
    expect(findPackRoot(wrapped)).toBe(path.join(wrapped, 'owner-repo-sha'));

    const two = tempDir('od-pack-root-');
    mkdirSync(path.join(two, 'a'));
    mkdirSync(path.join(two, 'b'));
    writeFileSync(path.join(two, 'a', 'pack.json'), '{}');
    expect(() => findPackRoot(two)).toThrow(PackError);

    const none = tempDir('od-pack-root-');
    mkdirSync(path.join(none, 'only'));
    expect(() => findPackRoot(none)).toThrow(PackError);
  });
});

describe('Sol hold (PR #191, P1-1): every archive entry, listed or not, is checked for aliases and unportable names', () => {
  async function refusedWithNothingAliased(entries: RawTarEntry[]): Promise<string> {
    const archivePath = writeRawTgz(entries);
    cleanup.push(path.dirname(archivePath));
    const dest = tempDir('od-pack-alias-');
    await expectPackError(extractPackArchive({ archivePath, destDir: dest }), 'INVALID_ARCHIVE');
    return dest;
  }

  it('refuses two entries that differ only by letter case, as files or as parent folders', async () => {
    await refusedWithNothingAliased([
      { path: 'pack/a.txt', body: 'one' },
      { path: 'pack/A.txt', body: 'two' },
    ]);
    await refusedWithNothingAliased([
      { path: 'pack/dir/one.txt', body: 'one' },
      { path: 'pack/DIR/two.txt', body: 'two' },
    ]);
    await refusedWithNothingAliased([
      { path: 'pack/x/', type: 'Directory' },
      { path: 'pack/X', body: 'file over the folder alias' },
    ]);
  });

  it('refuses two entries that differ only by Unicode normalisation (NFC vs NFD)', async () => {
    await refusedWithNothingAliased([
      { path: 'pack/caf\u00e9.txt', body: 'nfc' },
      { path: 'pack/cafe\u0301.txt', body: 'nfd' },
    ]);
  });

  it('refuses Windows reserved basenames, a trailing dot or space, and a colon in any entry', async () => {
    for (const bad of ['pack/CON', 'pack/aux.txt', 'pack/sub/Lpt1.js', 'pack/nul/', 'pack/name.', 'pack/name ', 'pack/a:b.txt', 'pack/file.txt:stream']) {
      const isDir = bad.endsWith('/');
      await refusedWithNothingAliased([
        { path: 'pack/pack.json', body: '{}' },
        isDir ? { path: bad, type: 'Directory' } : { path: bad, body: 'x' },
      ]);
    }
  });

  it('still accepts a folder entry followed by files inside it with the same spelling', async () => {
    const archivePath = writeRawTgz([
      { path: 'pack/', type: 'Directory' },
      { path: 'pack/Kits/', type: 'Directory' },
      { path: 'pack/Kits/a.txt', body: 'a' },
      { path: 'pack/pack.json', body: '{}' },
    ]);
    cleanup.push(path.dirname(archivePath));
    const dest = tempDir('od-pack-alias-ok-');
    await extractPackArchive({ archivePath, destDir: dest });
    expect(readFileSync(path.join(dest, 'pack', 'Kits', 'a.txt'), 'utf8')).toBe('a');
  });
});

describe('folder sources (P1-1 spec 2b)', () => {
  it('a folder source holding a symlinked file (to inside or outside the folder) is refused before any byte is copied', async () => {
    const outside = tempDir('od-pack-outside-');
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    const folder = tempDir('od-pack-folder-');
    mkdirSync(path.join(folder, 'kits'));
    writeFileSync(path.join(folder, 'kits', 'a.txt'), 'a');
    symlinkSync(path.join(folder, 'kits', 'a.txt'), path.join(folder, 'kits', 'inside-link.txt'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(folder, 'kits', 'outside-link.txt'));
    symlinkSync(outside, path.join(folder, 'dir-link'));

    expect(() => assertFolderSourceSafe(folder, ['kits/a.txt'])).not.toThrow();
    for (const listed of ['kits/inside-link.txt', 'kits/outside-link.txt', 'dir-link/secret.txt']) {
      let caught: unknown = null;
      try {
        assertFolderSourceSafe(folder, ['kits/a.txt', listed]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PackError);
      expect((caught as PackError).code).toBe('INVALID_ARCHIVE');
      expect((caught as PackError).message).not.toContain(folder);
    }
    // A parent folder swapped for a link after the check: the copy refuses the
    // file because its dev/ino is not the one the check vouched for.
    const raced = tempDir('od-pack-race-');
    mkdirSync(path.join(raced, 'kits'));
    writeFileSync(path.join(raced, 'kits', 'a.txt'), 'a');
    const identities = assertFolderSourceSafe(raced, ['kits/a.txt']);
    const elsewhere = tempDir('od-pack-elsewhere-');
    writeFileSync(path.join(elsewhere, 'a.txt'), 'a');
    renameSync(path.join(raced, 'kits'), path.join(raced, 'kits-moved'));
    symlinkSync(elsewhere, path.join(raced, 'kits'));
    const swapError = await placeVerifiedFiles({
      sourceRoot: raced,
      destRoot: tempDir('od-pack-dest-'),
      files: [{ path: 'kits/a.txt', bytes: 1, sha256: sha256Hex('a') }],
      mode: 'copy',
      identities,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((swapError as PackError).code).toBe('INVALID_ARCHIVE');
    // A missing listed file is an integrity failure, found before copying too.
    let missing: unknown = null;
    try {
      assertFolderSourceSafe(folder, ['kits/a.txt', 'kits/absent.txt']);
    } catch (error) {
      missing = error;
    }
    expect((missing as PackError).code).toBe('INTEGRITY_MISMATCH');
  });
});

describe('caps (P1-1 spec 2c)', () => {
  it('an archive over PACK_MAX_ENTRIES stops at the cap with TOO_LARGE; a pack.json over PACK_MANIFEST_MAX_BYTES is refused before parsing', async () => {
    expect(DEFAULT_PACK_LIMITS.maxEntries).toBe(PACK_MAX_ENTRIES);
    const entries: RawTarEntry[] = Array.from({ length: PACK_MAX_ENTRIES + 1 }, () => ({ path: 'pack/', type: 'Directory' }));
    const archivePath = writeRawTgz(entries);
    cleanup.push(path.dirname(archivePath));
    const destDir = tempDir('od-pack-x-');
    await expectPackError(extractPackArchive({ archivePath, destDir }), 'TOO_LARGE');
    expect(listDir(destDir)).toEqual(['pack']);

    const dir = tempDir('od-pack-manifest-');
    const manifestPath = path.join(dir, 'pack.json');
    // Not JSON at all: a parse would say INVALID_MANIFEST.
    writeFileSync(manifestPath, Buffer.alloc(PACK_MANIFEST_MAX_BYTES + 1, 0x7b));
    let caught: unknown = null;
    try {
      readPackManifestFile(manifestPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PackError);
    expect((caught as PackError).code).toBe('TOO_LARGE');

    writeFileSync(manifestPath, Buffer.alloc(64, 0x7b));
    let invalid: unknown = null;
    try {
      readPackManifestFile(manifestPath);
    } catch (error) {
      invalid = error;
    }
    expect((invalid as PackError).code).toBe('INVALID_MANIFEST');
  }, 120_000);
});

// S10 (QA sweep 2, J2 Licensed packs, P1): an ordinary macOS `tar czf`
// archive must install. `bsd-tar-pack.tgz` is a REAL archive made on macOS
// with /usr/bin/tar (bsdtar 3.5.3, libarchive 3.7.4), COPYFILE_DISABLE unset,
// from a synthetic writeFixturePack() folder (id `bsd-tar-pack`) whose root,
// pack.json and kits/demo/manifest.json carried an extended attribute:
//
//   xattr -w com.zerosum.fixture 1 . pack.json kits/demo/manifest.json
//   /usr/bin/tar -czf bsd-tar-pack.tgz -C <pack folder> .
//
// It starts with a `._.` AppleDouble file, then a `./` root folder, and every
// path carries a leading `./` with a `._<name>` sidecar beside it.
const BSD_TAR_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'licensed-pack', 'bsd-tar-pack.tgz');

function walkFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of listDir(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (existsSync(full) && listDir(full).length > 0) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/** An AppleDouble file body: the 0x00051607 magic, then `rest` zero bytes. */
function appleDouble(rest: number): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07]), Buffer.alloc(rest)]);
}

describe('BSD tar (macOS) archives (S10)', () => {
  it('extracts a real macOS `tar czf` archive: skips the ./ root, ._* AppleDouble files, and strips the leading ./', async () => {
    const destDir = tempDir('od-pack-bsd-');
    const result = await extractPackArchive({ archivePath: BSD_TAR_FIXTURE, destDir });
    expect(result.archiveSha256).toBe(sha256Hex(readFileSync(BSD_TAR_FIXTURE)));
    expect(findPackRoot(destDir)).toBe(destDir);
    const files = walkFiles(destDir);
    expect(files).toContain('pack.json');
    expect(files).toContain('kits/demo/manifest.json');
    expect(files.filter((rel) => rel.split('/').some((segment) => segment.startsWith('._')))).toEqual([]);
  });

  it('skips __MACOSX/ trees and ._* files written by other tools', async () => {
    const archivePath = writeRawTgz([
      { path: '.', type: 'Directory' },
      { path: '__MACOSX/', type: 'Directory' },
      { path: '__MACOSX/._pack.json', body: appleDouble(8) },
      { path: '__MACOSX/kits/._a.txt', body: 'not even AppleDouble' },
      { path: '._pack.json', body: appleDouble(8) },
      { path: 'pack.json', body: '{}' },
      { path: 'kits/a.txt', body: 'a' },
      { path: 'kits/._a.txt', body: appleDouble(30) },
    ]);
    cleanup.push(path.dirname(archivePath));
    const destDir = tempDir('od-pack-macosx-');
    await extractPackArchive({ archivePath, destDir });
    expect(walkFiles(destDir).sort()).toEqual(['kits/a.txt', 'pack.json']);
  });

  it('still refuses links, devices, absolute paths and .. traversal, including behind skipped-looking names, and names the entry', async () => {
    const refused: RawTarEntry[] = [
      { path: './link', type: 'SymbolicLink', linkpath: '/etc/hosts' },
      { path: './._link', type: 'SymbolicLink', linkpath: '/etc/hosts' },
      { path: '__MACOSX/link', type: 'SymbolicLink', linkpath: '/etc/hosts' },
      { path: './hard', type: 'Link', linkpath: 'pack.json' },
      { path: './._hard', type: 'Link', linkpath: 'pack.json' },
      { path: './fifo', type: 'FIFO' },
      { path: '._dev', type: 'CharacterDevice' },
      { path: '/abs/evil.txt', body: 'x' },
      { path: '/__MACOSX/evil.txt', body: 'x' },
      { path: '/._evil.txt', body: 'x' },
      { path: './../evil.txt', body: 'x' },
      { path: './../._evil.txt', body: 'x' },
      { path: '__MACOSX/../evil.txt', body: 'x' },
      { path: '__MACOSX/../../evil.txt', body: 'x' },
      { path: './__MACOSX/../evil.txt', body: 'x' },
      { path: 'kits/../../._evil.txt', body: 'x' },
      { path: '././pack.json', body: 'x' },
      { path: '.', body: 'a file, not the root folder' },
    ];
    for (const entry of refused) {
      const destDir = tempDir('od-pack-bsd-x-');
      const archivePath = writeRawTgz([{ path: './', type: 'Directory' }, { path: './pack.json', body: '{}' }, entry]);
      cleanup.push(path.dirname(archivePath));
      const error = await expectPackError(extractPackArchive({ archivePath, destDir }), 'INVALID_ARCHIVE');
      expect(error.message).toContain(JSON.stringify(entry.path));
      expect(existsSync(path.join(path.dirname(destDir), 'evil.txt'))).toBe(false);
      expect(existsSync(path.join(path.dirname(destDir), '._evil.txt'))).toBe(false);
    }
  });

  it('names the duplicate entry and keeps control characters escaped in the message', async () => {
    const dup = writeRawTgz([
      { path: './pack/a.txt', body: 'one' },
      { path: './pack/A.txt', body: 'two' },
    ]);
    cleanup.push(path.dirname(dup));
    const duplicate = await expectPackError(extractPackArchive({ archivePath: dup, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');
    expect(duplicate.message).toContain('"./pack/A.txt"');

    const control = writeRawTgz([{ path: 'pack/bad\u001bname.txt', body: 'x' }]);
    cleanup.push(path.dirname(control));
    const escaped = await expectPackError(extractPackArchive({ archivePath: control, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');
    expect(escaped.message).toContain('"pack/bad\\u001bname.txt"');
    expect(escaped.message).not.toContain('\u001b');
  });
});

describe('S10 review round (Sol on PR #207)', () => {
  it('BLOCK: skipped AppleDouble and __MACOSX files still count against the per-file and total byte caps', async () => {
    const perFile = { ...DEFAULT_PACK_LIMITS, fileMaxBytes: 16 };
    for (const entry of [
      { path: './._payload', body: appleDouble(13) },
      { path: '__MACOSX/._payload', body: appleDouble(13) },
      { path: '__MACOSX/payload.bin', body: Buffer.alloc(17) },
    ]) {
      const archivePath = writeRawTgz([{ path: './pack.json', body: '{}' }, entry]);
      cleanup.push(path.dirname(archivePath));
      const error = await expectPackError(
        extractPackArchive({ archivePath, destDir: tempDir('od-pack-cap-'), limits: perFile }),
        'TOO_LARGE',
      );
      expect(error.message).toContain(JSON.stringify(entry.path));
    }

    const total = { ...DEFAULT_PACK_LIMITS, extractedMaxBytes: 16 };
    const archivePath = writeRawTgz([
      { path: './._a', body: appleDouble(5) },
      { path: './._b', body: appleDouble(4) },
    ]);
    cleanup.push(path.dirname(archivePath));
    const error = await expectPackError(
      extractPackArchive({ archivePath, destDir: tempDir('od-pack-cap-'), limits: total }),
      'TOO_LARGE',
    );
    expect(error.message).toContain('"./._b"');
  });

  it('WARN: a ._* file without the AppleDouble magic is ordinary content and is extracted', async () => {
    const archivePath = writeRawTgz([
      { path: './', type: 'Directory' },
      { path: './pack.json', body: '{}' },
      { path: './kits/demo/._config', body: 'plain text config\n' },
      { path: './kits/demo/._tiny', body: 'ab' },
      { path: './kits/demo/._empty', body: '' },
      { path: './kits/demo/._near', body: Buffer.from([0x00, 0x05, 0x16, 0x08, 0x01]) },
      { path: './kits/demo/._meta', body: appleDouble(30) },
    ]);
    cleanup.push(path.dirname(archivePath));
    const destDir = tempDir('od-pack-dotunderscore-');
    await extractPackArchive({ archivePath, destDir });
    expect(walkFiles(destDir).sort()).toEqual([
      'kits/demo/._config',
      'kits/demo/._empty',
      'kits/demo/._near',
      'kits/demo/._tiny',
      'pack.json',
    ]);
    expect(readFileSync(path.join(destDir, 'kits', 'demo', '._config'), 'utf8')).toBe('plain text config\n');
    expect(readFileSync(path.join(destDir, 'kits', 'demo', '._near'))).toEqual(Buffer.from([0x00, 0x05, 0x16, 0x08, 0x01]));
  });

  it('WARN: a ._* content file still passes the portability and alias checks', async () => {
    for (const entries of [
      [{ path: './._name.', body: 'not AppleDouble' }],
      [
        { path: './kits/._Config', body: 'one' },
        { path: './kits/._config', body: 'two' },
      ],
    ] as RawTarEntry[][]) {
      const archivePath = writeRawTgz(entries);
      cleanup.push(path.dirname(archivePath));
      const error = await expectPackError(extractPackArchive({ archivePath, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');
      expect(error.message).toContain(JSON.stringify(entries.at(-1)!.path));
    }
  });

  it('NIT: entry-name diagnostics escape every Unicode Bidi_Control character, U+061C included', async () => {
    const name = 'pack/report\u061c-1\u200e2\u202e3\u2066.txt';
    const archivePath = writeRawTgz([{ path: name, type: 'SymbolicLink', linkpath: '/etc/hosts' }]);
    cleanup.push(path.dirname(archivePath));
    const error = await expectPackError(extractPackArchive({ archivePath, destDir: tempDir('od-pack-x-') }), 'INVALID_ARCHIVE');
    expect(error.message).toContain('"pack/report\\u061c-1\\u200e2\\u202e3\\u2066.txt"');
    expect(error.message).not.toMatch(/\p{Bidi_Control}/u);
  });
});
