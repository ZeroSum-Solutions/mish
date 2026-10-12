// Materialises a local design-system kit as a real directory inside the
// daemon-managed design-system root.
//
// A local install used to symlink the user's folder into that root. Every
// later daemon write for the kit (metadata.json, revisions/, the derived
// README/SKILL.md set, a PATCHed DESIGN.md) then followed the link and landed
// inside the user's source tree. The invariant this module serves: install-
// owned files live in the installed entry under the managed root, and the
// source is only ever read.
//
// What the copy checks, on every source entry:
// - Directories: lstat before listing and after listing must name the same
//   directory (dev/ino), and its canonical path must stay inside the source.
//   Entries are streamed (opendir) so the entry budget applies before a huge
//   directory is loaded.
// - Files: lstat must show a regular file with one link (hard links are
//   refused); the file is opened with O_NOFOLLOW where the platform has it,
//   and the open handle's fstat must match the lstat (dev/ino); after the
//   copy its canonical path must still be inside the source.
// - Any symbolic link, special file, or identity change refuses the copy.
//   These checks narrow, but cannot fully close, the window in which a
//   concurrent writer could swap a path; what they guarantee is that the
//   bytes copied came from a regular, singly-linked file that was inside the
//   source when it was opened and when it was finished.
// - The copy has a hard budget (entries, bytes, depth); a kit over budget is
//   refused, never truncated.
// - The copy is staged inside the managed root and moved into place with one
//   rename. Destination files are created with O_EXCL inside a fresh staging
//   directory, so no write can follow a pre-existing link.
// - A dangling legacy link is refused, never followed to create a file.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export type KitCopyBudget = {
  /** Files plus directories, counted across the whole tree. */
  maxEntries: number;
  /** Sum of all file bytes. */
  maxBytes: number;
  /** Directory nesting below the kit root. */
  maxDepth: number;
};

// An Atlas kit is ~270 files and ~24 MB; these limits leave wide headroom
// while keeping one install from filling the data volume.
export const DEFAULT_KIT_COPY_BUDGET: KitCopyBudget = Object.freeze({
  maxEntries: 20_000,
  maxBytes: 512 * 1024 * 1024,
  maxDepth: 32,
});

/** Staging lives inside the managed root (same filesystem, so the final
 * rename is atomic). Its own top level never holds a DESIGN.md, so catalog
 * listings skip it. */
export const INSTALL_STAGING_DIRNAME = '.od-install-staging';

/**
 * Daemon bookkeeping at a kit's root. A fresh install never imports these
 * from the source: a stale metadata.json there (teamSynced, workspaceId,
 * projectId, status, artifactMode) or revisions/ belong to whatever daemon
 * wrote them, not to the kit.
 */
const ROOT_BOOKKEEPING_NAMES = new Set(['metadata.json', 'revisions', '.od-generated.json']);

const COPY_CHUNK_BYTES = 1024 * 1024;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const STALE_STAGING_MS = 60 * 60 * 1000;

export type KitMaterializeErrorCode =
  | 'SYMLINK'
  | 'HARDLINK'
  | 'UNSUPPORTED_ENTRY'
  | 'SOURCE_CHANGED'
  | 'BUDGET'
  | 'SOURCE_MISSING'
  | 'TARGET_EXISTS';

/** A refusal the caller should report to the user as-is. */
export class KitMaterializeError extends Error {
  constructor(
    readonly code: KitMaterializeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KitMaterializeError';
  }
}

type CopyState = { entries: number; bytes: number };

/**
 * Copy the kit at `sourceDir` (already canonical, already validated) into
 * `managedRoot/entryName` as a real directory with fresh bookkeeping.
 * Refuses when anything already occupies the target path, including a
 * dangling symlink.
 */
export async function materializeKitIntoManagedRoot(
  sourceDir: string,
  managedRoot: string,
  entryName: string,
  budget: KitCopyBudget = DEFAULT_KIT_COPY_BUDGET,
): Promise<string> {
  const target = path.join(managedRoot, entryName);
  if (await pathOccupied(target)) {
    throw new KitMaterializeError('TARGET_EXISTS', `"${entryName}" is already installed`);
  }
  // A fresh install replaces whatever a refused legacy link left remembered.
  refusedConversions.delete(target);
  const staged = await stageKitCopy(sourceDir, managedRoot, budget, { freshBookkeeping: true });
  try {
    const now = new Date().toISOString();
    await writeFile(
      path.join(staged, 'metadata.json'),
      `${JSON.stringify({ createdAt: now, updatedAt: now }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    if (await pathOccupied(target)) {
      throw new KitMaterializeError('TARGET_EXISTS', `"${entryName}" is already installed`);
    }
    await rename(staged, target);
  } catch (err) {
    await discardStaging(managedRoot, staged);
    throw err;
  }
  await removeEmptyStagingParent(managedRoot);
  return target;
}

export type LinkedEntryState = 'absent' | 'directory' | 'materialized';

const inFlight = new Map<string, Promise<LinkedEntryState>>();

/** A refused legacy conversion, remembered until anything in the source tree changes. */
const refusedConversions = new Map<string, { sourceKey: string; error: KitMaterializeError }>();

/**
 * Before any write to `managedRoot/entryName`: if the entry is a legacy
 * symlinked install, replace the link with a real copy of what it points at,
 * so the write lands under the managed root and not in the user's source.
 *
 * Install-owned files an earlier daemon wrote through the link (metadata.json
 * with the Workspace claim, revisions/) are copied too, so the entry keeps
 * the same state it had when it was read through the link. The source copy of
 * those files is left untouched.
 *
 * Returns 'absent' when nothing is there, 'directory' for an ordinary entry,
 * and 'materialized' after a swap. Throws KitMaterializeError when the link
 * dangles or its target cannot be copied safely; the caller must not write.
 * A refusal is remembered (keyed by a metadata signature of the whole source
 * tree, see `sourceTreeSignature`) and logged once, so repeated writes do not
 * re-copy a kit that will be refused again, while a repair anywhere in the
 * tree (a nested link removed, an oversized file truncated) is retried.
 */
export async function materializeLinkedEntryForWrite(
  managedRoot: string,
  entryName: string,
  budget: KitCopyBudget = DEFAULT_KIT_COPY_BUDGET,
): Promise<LinkedEntryState> {
  const entryPath = path.join(managedRoot, entryName);
  const pending = inFlight.get(entryPath);
  if (pending) return pending;
  const work = materializeLinkedEntryUnlocked(managedRoot, entryName, budget);
  inFlight.set(entryPath, work);
  try {
    return await work;
  } finally {
    inFlight.delete(entryPath);
  }
}

async function materializeLinkedEntryUnlocked(
  managedRoot: string,
  entryName: string,
  budget: KitCopyBudget,
): Promise<LinkedEntryState> {
  const entryPath = path.join(managedRoot, entryName);
  let stats;
  try {
    stats = await lstat(entryPath);
  } catch (err) {
    if (isAbsence(err)) return 'absent';
    throw err;
  }
  if (!stats.isSymbolicLink()) return 'directory';

  let sourceDir: string;
  try {
    sourceDir = await realpath(entryPath);
  } catch (err) {
    if (isAbsence(err)) {
      throw new KitMaterializeError(
        'SOURCE_MISSING',
        `The folder installed as "${entryName}" no longer exists. Reinstall it from a clean folder.`,
      );
    }
    throw err;
  }
  const sourceStats = await lstat(sourceDir);
  if (!sourceStats.isDirectory()) {
    throw new KitMaterializeError(
      'UNSUPPORTED_ENTRY',
      `"${entryName}" does not point at a folder. Reinstall it from a clean folder.`,
    );
  }

  // Taken before the copy: a repair made while the copy runs then differs
  // from the remembered key, so the next write retries.
  const signature = await sourceTreeSignature(sourceDir, budget);
  const sourceKey = signature === null ? null : `${sourceDir}:${signature}`;
  const refused = refusedConversions.get(entryPath);
  if (refused && sourceKey !== null && refused.sourceKey === sourceKey) throw refused.error;

  let staged: string;
  try {
    staged = await stageKitCopy(sourceDir, managedRoot, budget, { freshBookkeeping: false });
  } catch (err) {
    if (!(err instanceof KitMaterializeError)) throw err;
    const refusal = new KitMaterializeError(
      err.code,
      `${err.message}. Reinstall "${entryName}" from a clean folder (no symbolic or hard links, `
        + 'no .git or node_modules, within the install size limits).',
    );
    if (sourceKey !== null) refusedConversions.set(entryPath, { sourceKey, error: refusal });
    else refusedConversions.delete(entryPath);
    // Log once per refusal: a retry that ends in the same refusal stays quiet.
    if (refused?.error.message !== refusal.message) {
      console.warn(
        `[design-systems] cannot convert linked install "${entryName}" into a managed copy; `
          + `writes to it are refused until it is reinstalled: ${err.message}`,
      );
    }
    throw refusal;
  }
  refusedConversions.delete(entryPath);

  const stagingParent = path.join(managedRoot, INSTALL_STAGING_DIRNAME);
  const aside = path.join(stagingParent, `${entryName}.${randomUUID()}.link`);
  try {
    // Move the link itself (rename never follows it), then the copy into its place.
    await rename(entryPath, aside);
    // Another daemon on the same root may have swapped the entry between our
    // lstat and this rename. Only a link to the folder we copied may be
    // replaced; anything else goes back where it was.
    if (!(await isLinkTo(aside, sourceDir))) {
      await restoreAside(aside, entryPath, entryName);
      throw new Error(`"${entryName}" changed while it was being converted; retry the change`);
    }
    try {
      await rename(staged, entryPath);
    } catch (err) {
      await restoreAside(aside, entryPath, entryName);
      throw err;
    }
  } catch (err) {
    await discardStaging(managedRoot, staged);
    throw err;
  }
  await unlink(aside).catch(() => undefined);
  await removeEmptyStagingParent(managedRoot);
  return 'materialized';
}

/**
 * Daemon startup: repair what an interrupted install or conversion left in
 * the staging area. A link set aside by a conversion that never finished goes
 * back to its entry path when that path is empty (so the install stays
 * readable), and is dropped when the conversion did finish. Staging copies
 * older than an hour are removed; younger ones may belong to another daemon
 * process sharing the root and are left alone.
 */
export async function cleanupInstallStaging(
  managedRoot: string,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<void> {
  const stagingParent = path.join(managedRoot, INSTALL_STAGING_DIRNAME);
  try {
    if (!(await lstat(stagingParent)).isDirectory()) return;
  } catch {
    return;
  }
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_STAGING_MS;
  for (const entry of await readdir(stagingParent, { withFileTypes: true })) {
    const entryPath = path.join(stagingParent, entry.name);
    const asideMatch = /^(.+)\.[0-9a-f-]{8,36}\.link$/.exec(entry.name);
    if (entry.isSymbolicLink() && asideMatch) {
      const entryName = asideMatch[1]!;
      if (entryName === '.' || entryName === '..' || entryName === INSTALL_STAGING_DIRNAME) continue;
      const original = path.join(managedRoot, entryName);
      if (await pathOccupied(original)) {
        await unlink(entryPath).catch(() => undefined);
      } else {
        await rename(entryPath, original).catch((err) => {
          console.warn(`[design-systems] could not restore linked install "${entryName}":`, err);
        });
      }
      continue;
    }
    try {
      const stats = await lstat(entryPath);
      if (now - stats.mtimeMs < staleAfterMs) continue;
      await rm(entryPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[design-systems] could not clean install staging entry "${entry.name}":`, err);
    }
  }
  await removeEmptyStagingParent(managedRoot);
}

/**
 * A digest of the source tree's metadata (type, inode, size, mtime, link
 * count of every entry, in listing order) that changes whenever anything
 * that decides a copy's outcome changes: a link added or removed at any
 * depth, a file grown or truncated, an entry swapped. No file bytes are read.
 * The walk stops one entry past the copy budget and does not descend past its
 * depth limit (a tree that large is refused by the budget either way), so its
 * cost stays bounded. Returns null when the tree changed mid-walk or could
 * not be read; the caller then does not reuse a remembered refusal.
 */
async function sourceTreeSignature(sourceDir: string, budget: KitCopyBudget): Promise<string | null> {
  const hash = createHash('sha256');
  let entries = 0;
  const describe = (rel: string, stats: Stats): string => {
    const type = stats.isSymbolicLink() ? 'L' : stats.isDirectory() ? 'D' : stats.isFile() ? 'F' : 'O';
    return `${type}\0${rel}\0${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.nlink}\n`;
  };
  async function walk(dir: string, rel: string, depth: number): Promise<boolean> {
    const dirHandle = await opendir(dir);
    for await (const entry of dirHandle) {
      entries += 1;
      if (entries > budget.maxEntries + 1) {
        hash.update('overflow\n');
        return false;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childPath = path.join(dir, entry.name);
      const stats = await lstat(childPath);
      hash.update(describe(childRel, stats));
      if (stats.isDirectory() && depth + 1 <= budget.maxDepth) {
        if (!(await walk(childPath, childRel, depth + 1))) return false;
      }
    }
    return true;
  }
  try {
    hash.update(describe('.', await lstat(sourceDir)));
    await walk(sourceDir, '', 0);
  } catch {
    return null;
  }
  return hash.digest('hex');
}

async function stageKitCopy(
  sourceDir: string,
  managedRoot: string,
  budget: KitCopyBudget,
  options: { freshBookkeeping: boolean },
): Promise<string> {
  await mkdir(managedRoot, { recursive: true });
  if (isSameOrInside(await realpath(managedRoot), sourceDir)) {
    // Copying a folder that contains the managed root would copy the staging
    // area into itself until the budget ran out.
    throw new KitMaterializeError(
      'UNSUPPORTED_ENTRY',
      'Cannot install a folder that contains the managed design-system directory',
    );
  }
  const stagingParent = path.join(managedRoot, INSTALL_STAGING_DIRNAME);
  await mkdir(stagingParent, { recursive: true });
  const parentStats = await lstat(stagingParent);
  if (!parentStats.isDirectory()) {
    throw new Error(`install staging path is not a directory: ${stagingParent}`);
  }
  const staged = path.join(stagingParent, randomUUID());
  await mkdir(staged);
  try {
    await copyTree({
      sourceRoot: sourceDir,
      sourceDir,
      destDir: staged,
      relDir: '',
      depth: 0,
      state: { entries: 0, bytes: 0 },
      budget,
      skipRootNames: options.freshBookkeeping ? ROOT_BOOKKEEPING_NAMES : null,
    });
  } catch (err) {
    await discardStaging(managedRoot, staged);
    throw err;
  }
  return staged;
}

type CopyTreeInput = {
  sourceRoot: string;
  sourceDir: string;
  destDir: string;
  relDir: string;
  depth: number;
  state: CopyState;
  budget: KitCopyBudget;
  skipRootNames: Set<string> | null;
};

async function copyTree(input: CopyTreeInput): Promise<void> {
  const { sourceRoot, sourceDir, destDir, relDir, depth, state, budget } = input;
  const label = relDir || '.';
  const before = await lstat(sourceDir);
  if (before.isSymbolicLink()) throw symlinkRefusal(label);
  if (!before.isDirectory()) throw changedRefusal(label);

  const dir = await opendir(sourceDir);
  // for-await closes the directory handle on completion and on throw.
  for await (const entry of dir) {
    if (depth === 0 && input.skipRootNames?.has(entry.name)) continue;
    state.entries += 1;
    if (state.entries > budget.maxEntries) {
      throw new KitMaterializeError(
        'BUDGET',
        `Design system folder has too many files to install (limit ${budget.maxEntries})`,
      );
    }
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) throw symlinkRefusal(rel);
    if (entry.isDirectory()) {
      if (depth + 1 > budget.maxDepth) {
        throw new KitMaterializeError(
          'BUDGET',
          `Design system folder is nested too deeply to install (limit ${budget.maxDepth}): ${rel}`,
        );
      }
      await mkdir(to);
      await copyTree({
        ...input,
        sourceDir: from,
        destDir: to,
        relDir: rel,
        depth: depth + 1,
        skipRootNames: null,
      });
      continue;
    }
    if (!entry.isFile()) throw unsupportedRefusal(rel);
    await copyRegularFile(sourceRoot, from, to, rel, state, budget);
  }

  const after = await lstat(sourceDir);
  if (!after.isDirectory() || !sameIdentity(before, after)) throw changedRefusal(label);
  if (!isSameOrInside(await realpath(sourceDir), sourceRoot)) throw changedRefusal(label);
}

async function copyRegularFile(
  sourceRoot: string,
  from: string,
  to: string,
  rel: string,
  state: CopyState,
  budget: KitCopyBudget,
): Promise<void> {
  const linkStats = await lstat(from);
  if (linkStats.isSymbolicLink()) throw symlinkRefusal(rel);
  if (!linkStats.isFile()) throw unsupportedRefusal(rel);
  if (linkStats.nlink > 1) throw hardlinkRefusal(rel);

  let input;
  try {
    input = await open(from, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') throw symlinkRefusal(rel);
    throw err;
  }
  try {
    const stats = await input.stat();
    if (!stats.isFile() || !sameIdentity(stats, linkStats)) throw changedRefusal(rel);
    if (stats.nlink > 1) throw hardlinkRefusal(rel);
    assertWithinByteBudget(state.bytes + stats.size, budget);
    // Owner read/write is kept even for a read-only (frozen) source file:
    // the installed copy is daemon-owned and later edits must succeed.
    const output = await open(to, 'wx', (stats.mode & 0o777) | 0o600);
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        state.bytes += bytesRead;
        assertWithinByteBudget(state.bytes, budget);
        await writeAllToHandle(output, buffer, bytesRead);
        copied += bytesRead;
      }
      // The staged file must hold every byte that was read before it can be
      // promoted into the installed kit.
      const written = (await output.stat()).size;
      if (written !== copied) {
        throw new Error(`kit copy of ${rel} is incomplete: wrote ${written} of ${copied} bytes`);
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
  if (!isSameOrInside(await realpath(from), sourceRoot)) throw changedRefusal(rel);
}

/** The part of a file handle `writeAllToHandle` needs (a `FileHandle` fits). */
export type WritableHandle = {
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
};

/**
 * Writes `buffer[0, length)` to `handle` in full. A write may report fewer
 * bytes than requested; the remainder is written again from where it stopped.
 * A write that makes no progress throws instead of looping.
 */
export async function writeAllToHandle(handle: WritableHandle, buffer: Buffer, length: number): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset);
    if (bytesWritten <= 0) {
      throw new Error(`kit copy write made no progress: wrote ${offset} of ${length} bytes`);
    }
    offset += bytesWritten;
  }
}

function symlinkRefusal(rel: string): KitMaterializeError {
  return new KitMaterializeError(
    'SYMLINK',
    `Design system folder contains a symbolic link, which is not allowed: ${rel}`,
  );
}

function hardlinkRefusal(rel: string): KitMaterializeError {
  return new KitMaterializeError(
    'HARDLINK',
    `Design system folder contains a hard link, which is not allowed: ${rel}`,
  );
}

function unsupportedRefusal(rel: string): KitMaterializeError {
  return new KitMaterializeError(
    'UNSUPPORTED_ENTRY',
    `Design system folder contains an entry that is not a regular file or folder: ${rel}`,
  );
}

function changedRefusal(rel: string): KitMaterializeError {
  return new KitMaterializeError(
    'SOURCE_CHANGED',
    `Design system folder changed while it was being copied: ${rel}`,
  );
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertWithinByteBudget(bytes: number, budget: KitCopyBudget): void {
  if (bytes > budget.maxBytes) {
    throw new KitMaterializeError(
      'BUDGET',
      `Design system folder is too large to install (limit ${Math.floor(budget.maxBytes / (1024 * 1024))} MB)`,
    );
  }
}

async function isLinkTo(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    if (!(await lstat(linkPath)).isSymbolicLink()) return false;
    return (await realpath(linkPath)) === expectedTarget;
  } catch {
    return false;
  }
}

async function restoreAside(aside: string, entryPath: string, entryName: string): Promise<void> {
  try {
    await rename(aside, entryPath);
  } catch (err) {
    // Startup cleanup (cleanupInstallStaging) retries the restore.
    console.warn(
      `[design-systems] could not restore "${entryName}" after an interrupted conversion; `
        + `it is parked at ${aside}:`,
      err,
    );
  }
}

async function pathOccupied(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if (isAbsence(err)) return false;
    throw err;
  }
}

async function discardStaging(managedRoot: string, staged: string): Promise<void> {
  await rm(staged, { recursive: true, force: true }).catch(() => undefined);
  await removeEmptyStagingParent(managedRoot);
}

async function removeEmptyStagingParent(managedRoot: string): Promise<void> {
  // rmdir only removes an empty directory; a concurrent install keeps it.
  await rmdir(path.join(managedRoot, INSTALL_STAGING_DIRNAME)).catch(() => undefined);
}

/** True when `candidate` is `dir` or lies below it (both canonical paths). */
export function isSameOrInside(candidate: string, dir: string): boolean {
  if (candidate === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return candidate.startsWith(prefix);
}

function isAbsence(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
