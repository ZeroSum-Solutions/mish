// Synthetic licensed-pack fixtures for the P1-1 pack tests.
//
// Everything is generated at test time under os.tmpdir(); nothing here is a
// committed pack.json or licensed byte. The component kit reuses the
// throwaway kit from cult-kit-fixture.ts. This folder is the licence guard's
// exempt fixture root (P1-9, LICENSED_PACK_FIXTURE_ROOTS).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { c as tarCreate, Header } from 'tar';

import type { PackManifest } from '@mish/contracts';

import { writeFixtureKit } from '../../helpers/cult-kit-fixture.js';

export const FIXTURE_PACK_ID = 'synthetic-pack';
export const FIXTURE_KIT_ID = 'demo-kit';

export interface FixtureFile {
  path: string;
  content: string | Buffer;
}

export interface FixturePack {
  /** Folder holding pack.json and every file (listed and unlisted). */
  dir: string;
  manifest: PackManifest;
  manifestBytes: Buffer;
  manifestSha256: string;
}

export interface FixturePackOptions {
  id?: string;
  version?: string;
  title?: string;
  /** Listed files. Defaults to a synthetic component kit under `kits/demo/`. */
  files?: FixtureFile[];
  /** Files written into the folder but not listed in files[]. */
  unlisted?: FixtureFile[];
  contents?: PackManifest['contents'];
  /** Edit the manifest object before it is written (may make it invalid). */
  mutate?: (manifest: Record<string, unknown>) => Record<string, unknown>;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The synthetic component kit as pack files under `kits/demo/`. */
export function fixtureKitFiles(): FixtureFile[] {
  const { kitDir } = writeFixtureKit();
  const files: FixtureFile[] = [];
  for (const name of readdirSync(path.join(kitDir, 'registry')).sort()) {
    files.push({ path: `kits/demo/registry/${name}`, content: readFileSync(path.join(kitDir, 'registry', name)) });
  }
  files.push({
    path: 'kits/demo/manifest.json',
    content: `${JSON.stringify({ schemaVersion: 1, synthetic: true, registryItems: files.length })}\n`,
  });
  return files;
}

export function defaultContents(): PackManifest['contents'] {
  return [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: FIXTURE_KIT_ID, path: 'kits/demo' }];
}

/** Write a pack folder (pack.json + files) into a new temp dir. */
export function writeFixturePack(options: FixturePackOptions = {}): FixturePack {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-pack-src-'));
  const files = options.files ?? fixtureKitFiles();
  for (const file of [...files, ...(options.unlisted ?? [])]) {
    const target = path.join(dir, ...file.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  let manifest: Record<string, unknown> = {
    format: 'mishh-pack@1',
    id: options.id ?? FIXTURE_PACK_ID,
    version: options.version ?? '1.0.0',
    title: options.title ?? 'Synthetic pack',
    licence: { scope: 'Synthetic test fixture, no licensed content', evidence: [] },
    contents: options.contents ?? defaultContents(),
    files: files.map((file) => {
      const bytes = Buffer.from(file.content);
      return { path: file.path, bytes: bytes.length, sha256: sha256Hex(bytes) };
    }),
  };
  if (options.mutate) manifest = options.mutate(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(dir, 'pack.json'), manifestBytes);
  return { dir, manifest: manifest as unknown as PackManifest, manifestBytes, manifestSha256: sha256Hex(manifestBytes) };
}

/**
 * Tar (and gzip) a fixture pack folder. With `wrapper`, the archive holds one
 * top-level directory, like a GitHub repository tarball.
 */
export async function tarFixturePack(
  dir: string,
  options: { wrapper?: string; gzip?: boolean; outDir?: string } = {},
): Promise<string> {
  const outDir = options.outDir ?? mkdtempSync(path.join(tmpdir(), 'od-pack-tgz-'));
  const archivePath = path.join(outDir, options.gzip === false ? 'pack.tar' : 'pack.tgz');
  if (options.wrapper) {
    const holder = await mkdtemp(path.join(tmpdir(), 'od-pack-wrap-'));
    await cp(dir, path.join(holder, options.wrapper), { recursive: true });
    await tarCreate({ cwd: holder, gzip: options.gzip !== false, file: archivePath, portable: true }, [options.wrapper]);
    await rm(holder, { recursive: true, force: true });
  } else {
    const entries = readdirSync(dir).sort();
    await tarCreate({ cwd: dir, gzip: options.gzip !== false, file: archivePath, portable: true }, entries);
  }
  return archivePath;
}

/** Write `<archive>.sha256` in `sha256sum` format. */
export function writeSidecar(archivePath: string, digest?: string): string {
  const value = digest ?? sha256Hex(readFileSync(archivePath));
  writeFileSync(`${archivePath}.sha256`, `${value}  ${path.basename(archivePath)}\n`);
  return value;
}

export interface RawTarEntry {
  path: string;
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'CharacterDevice' | 'BlockDevice' | 'FIFO';
  body?: Buffer | string;
  linkpath?: string;
  /** Declared size when it should differ from the body (only for File). */
  size?: number;
}

/** Encode tar blocks by hand, so a test can write entries `tar.c` never would. */
export function rawTar(entries: RawTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'File';
    const body = entry.body === undefined ? Buffer.alloc(0) : Buffer.from(entry.body);
    const size = type === 'File' ? (entry.size ?? body.length) : 0;
    const header = new Header({
      path: entry.path,
      type,
      size,
      mode: type === 'Directory' ? 0o755 : 0o644,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
      ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
    });
    const block = Buffer.alloc(512);
    header.encode(block, 0);
    blocks.push(block);
    if (type === 'File' && body.length > 0) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Write a gzipped raw tar to a temp file. */
export function writeRawTgz(entries: RawTarEntry[]): string {
  const outDir = mkdtempSync(path.join(tmpdir(), 'od-pack-raw-'));
  const archivePath = path.join(outDir, 'raw.tgz');
  writeFileSync(archivePath, gzipSync(rawTar(entries)));
  return archivePath;
}

/** Total bytes of regular files under `dir` (missing dir: 0). */
export function treeBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/** Names directly inside `dir` (missing dir: []). */
export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
