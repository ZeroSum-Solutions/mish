// Mish packs: the bounded extractor. Zips are built in the test from invented bytes; nothing here is
// licensed content.

import { existsSync, promises as fsp, rmSync, type Dirent } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyMishPackFolder, extractMishPackZip } from '../../src/mish-packs/extract.js';
import { cleanupDirs, tempDir, writeFile } from './pack-fixture.js';

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function zipTo(zip: JSZip, options: JSZip.JSZipGeneratorOptions<'nodebuffer'> = { type: 'nodebuffer' }): Promise<string> {
  const file = path.join(tempDir('mish-zip-'), 'p.zip');
  await fsp.writeFile(file, await zip.generateAsync(options));
  return file;
}

/** Offsets of the central-directory headers (signature 0x02014b50) in a zip buffer. */
function centralHeaders(buffer: Buffer): number[] {
  const found: number[] = [];
  for (let at = buffer.length - 46; at >= 0; at -= 1) if (buffer.readUInt32LE(at) === 0x02014b50) found.unshift(at);
  return found;
}

describe('extractMishPackZip checksums', () => {
  it('extracts an intact stored and deflated entry', async () => {
    const zip = new JSZip();
    zip.file('stored.txt', 'stored bytes', { compression: 'STORE' });
    zip.file('deflated.txt', 'deflated '.repeat(200), { compression: 'DEFLATE' });
    const staging = tempDir('mish-stage-');
    await extractMishPackZip(await zipTo(zip), staging);
    expect(await fsp.readFile(path.join(staging, 'stored.txt'), 'utf8')).toBe('stored bytes');
    expect(await fsp.readFile(path.join(staging, 'deflated.txt'), 'utf8')).toBe('deflated '.repeat(200));
  });

  it('rejects a stored entry whose bytes changed but kept their length', async () => {
    const zip = new JSZip();
    zip.file('stored.txt', 'AAAAAAAAAA', { compression: 'STORE' });
    const file = await zipTo(zip);
    const buffer = await fsp.readFile(file);
    const at = buffer.indexOf('AAAAAAAAAA');
    expect(at).toBeGreaterThan(0);
    buffer[at + 3] = 0x42;
    await fsp.writeFile(file, buffer);
    await expect(extractMishPackZip(file, tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/damaged/) });
  });

  it('rejects a deflated entry whose central-directory checksum does not match', async () => {
    const zip = new JSZip();
    zip.file('deflated.txt', 'deflated '.repeat(200), { compression: 'DEFLATE' });
    const file = await zipTo(zip);
    const buffer = await fsp.readFile(file);
    const [header] = centralHeaders(buffer);
    expect(header).toBeDefined();
    buffer.writeUInt32LE((buffer.readUInt32LE(header! + 16) ^ 0xffffffff) >>> 0, header! + 16);
    await fsp.writeFile(file, buffer);
    await expect(extractMishPackZip(file, tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/damaged/) });
  });

  it('reports a damaged deflate stream as an invalid archive', async () => {
    const zip = new JSZip();
    zip.file('deflated.txt', Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 251)), { compression: 'DEFLATE' });
    const file = await zipTo(zip);
    const buffer = await fsp.readFile(file);
    const name = buffer.indexOf('deflated.txt');
    for (let i = 0; i < 40; i += 1) buffer[name + 'deflated.txt'.length + 10 + i] = 0xff;
    await fsp.writeFile(file, buffer);
    await expect(extractMishPackZip(file, tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });
});

describe('extractMishPackZip folder collisions', () => {
  it('refuses entries whose parent folders differ only by letter case', async () => {
    const zip = new JSZip();
    zip.file('skills/Foo/a.md', '1', { createFolders: false });
    zip.file('skills/foo/b.md', '2', { createFolders: false });
    await expect(extractMishPackZip(await zipTo(zip), tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/letter case/) });
  });

  it('refuses a folder entry that collides with a deeper folder by case', async () => {
    const zip = new JSZip();
    zip.file('skills/Foo/', null, { dir: true });
    zip.file('skills/foo/b.md', '2', { createFolders: false });
    await expect(extractMishPackZip(await zipTo(zip), tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/letter case/) });
  });

  it('refuses parent folders that differ only by Unicode form', async () => {
    const zip = new JSZip();
    zip.file('skills/café/a.md', '1');
    zip.file('skills/café/b.md', '2');
    await expect(extractMishPackZip(await zipTo(zip), tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/Unicode form/) });
  });

  it('refuses a name used both as a file and as a folder', async () => {
    const zip = new JSZip();
    zip.file('skills/foo', '1', { createFolders: false });
    zip.file('skills/foo/b.md', '2', { createFolders: false });
    await expect(extractMishPackZip(await zipTo(zip), tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('still accepts many files that share one folder spelling, with an explicit folder entry', async () => {
    const zip = new JSZip();
    zip.file('skills/Foo/', null, { dir: true });
    zip.file('skills/Foo/a.md', '1', { createFolders: false });
    zip.file('skills/Foo/b.md', '2', { createFolders: false });
    zip.file('skills/Foo/deep/c.md', '3', { createFolders: false });
    const staging = tempDir('mish-stage-');
    await extractMishPackZip(await zipTo(zip), staging);
    expect(await fsp.readFile(path.join(staging, 'skills', 'Foo', 'deep', 'c.md'), 'utf8')).toBe('3');
  });
});

describe('copyMishPackFolder collisions', () => {
  /**
   * Puts `twin` beside the first entry of `parent`. A strict volume (Linux) holds both names, so
   * the twin is written for real. A case- or normalisation-insensitive volume (macOS, Windows)
   * cannot, so there the directory listing is made to return the twin as well; the twin resolves
   * to the real entry, which is exactly how a stricter volume would hand it over.
   */
  async function addTwin(parent: string, twin: string): Promise<() => void> {
    if (!existsSync(path.join(parent, twin))) {
      const [original] = await fsp.readdir(parent);
      await fsp.cp(path.join(parent, original!), path.join(parent, twin), { recursive: true });
      return () => {};
    }
    const real = fsp.readdir.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation((async (dir: unknown, options: unknown) => {
      const listing = (await real(dir, options)) as Dirent[];
      if (String(dir) !== parent) return listing;
      const source = listing[0]!;
      const copy = Object.assign(Object.create(Object.getPrototypeOf(source)) as Dirent, source, { name: twin });
      return [...listing, copy];
    }) as never);
    return () => spy.mockRestore();
  }

  it('refuses sibling folders that differ only by letter case', async () => {
    const source = tempDir('mish-src-');
    writeFile(source, 'skills/Foo/a.md', '1');
    const restore = await addTwin(path.join(source, 'skills'), 'foo');
    try {
      await expect(copyMishPackFolder(source, tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/letter case/) });
    } finally {
      restore();
    }
  });

  it('refuses sibling files that differ only by Unicode form', async () => {
    const source = tempDir('mish-src-');
    writeFile(source, 'caf\u00e9.txt', '1');
    const restore = await addTwin(source, 'cafe\u0301.txt');
    try {
      await expect(copyMishPackFolder(source, tempDir('mish-stage-'))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE', message: expect.stringMatching(/Unicode form/) });
    } finally {
      restore();
    }
  });

  it('copies a normal tree', async () => {
    const source = tempDir('mish-src-');
    writeFile(source, 'skills/Foo/a.md', '1');
    writeFile(source, 'skills/Foo/b.md', '2');
    const staging = tempDir('mish-stage-');
    await copyMishPackFolder(source, staging);
    expect(await fsp.readFile(path.join(staging, 'skills', 'Foo', 'b.md'), 'utf8')).toBe('2');
  });
});
