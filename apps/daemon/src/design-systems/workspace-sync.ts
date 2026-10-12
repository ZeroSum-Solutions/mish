import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { DesignSystemWorkspaceSyncConflict } from '@open-design/contracts';
import { normalizeArtifactRuntimeImports } from '../artifacts/runtime-compat.js';
import { validatePortableProjectPath } from '../projects.js';
import {
  deleteDesignSystemWorkspaceSyncBaseline,
  deleteDesignSystemWorkspaceSyncDir,
  deleteDesignSystemWorkspaceSyncState,
  readDesignSystemWorkspaceSyncBaselines,
  readDesignSystemWorkspaceSyncDirs,
  readDesignSystemWorkspaceSyncState,
  recordDesignSystemWorkspaceSyncDir,
  sha256Hex,
  writeDesignSystemWorkspaceSyncBaseline,
  writeDesignSystemWorkspaceSyncState,
} from './workspace-sync-baseline.js';

/**
 * Three-way sync of a design-system package into its `ds-<id>` workspace
 * project: package (now) vs project (now) vs the baseline recorded at the
 * last successful write. The rule throughout: when in doubt, keep the
 * user's bytes and report.
 *
 * - Unedited project files (hash equals the baseline) follow the package:
 *   rewritten when it changed, deleted when it dropped them.
 * - Edited project files are kept. They are reported while the package
 *   differs from the version they were synced from; the baseline does not
 *   advance, so the report returns on every sync until the user resolves it
 *   (makes the file equal the package, or deletes it).
 * - Files without a baseline (projects that predate sync tracking) are
 *   adopted only when byte-identical to the package, and replaced only when
 *   they are exactly the pre-migration form the daemon itself generated
 *   (see `isExactLegacyFormOf`). Anything else is kept and reported.
 * - Names are preserved exactly. Unportable names and names that collide
 *   under case folding + NFC are refused, never renamed or deleted.
 * - No path is touched through a symlink, dangling or not.
 *
 * All filesystem work here is local to this sync path on purpose: it uses
 * lstat walks, O_NOFOLLOW and temp-file renames instead of the general
 * project file helpers.
 */

export type DesignSystemPackageFile = { path: string; size?: number; updatedAt?: string };

export type DesignSystemWorkspaceSyncInput = {
  db: Database.Database;
  projectId: string;
  projectDir: string;
  packageFiles: DesignSystemPackageFile[];
  readPackageFile: (filePath: string) => Promise<{ bytes: Buffer } | null | undefined>;
  now: number;
};

/** Test seams, each named for the point it runs at:
 * - `beforeStage`: parent chain verified, temp file not yet created.
 * - `beforeCommit`: new content staged, target not yet re-checked.
 * - `beforeUnlink`: file hashed from its handle, path not yet re-checked.
 * - `onProjectFileRead`: a project file is read and hashed. */
type HookInfo = { path: string; absolutePath: string };
export const designSystemWorkspaceSyncTestHooks: {
  beforeStage?: (info: HookInfo) => Promise<void> | void;
  beforeCommit?: (info: HookInfo) => Promise<void> | void;
  beforeUnlink?: (info: HookInfo) => Promise<void> | void;
  onProjectFileRead?: (rel: string) => void;
  /** Runs before each rmdir of a sync-owned directory; throw to fail it. */
  beforeRmdir?: (dirRel: string) => Promise<void> | void;
} = {};

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
// Windows cannot open a directory as a file descriptor; there the chain
// checks rely on lstat identity alone.
const CAN_OPEN_DIRECTORIES = process.platform !== 'win32';

type DirIdentity = { path: string; dev: bigint; ino: bigint };

function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Opens every directory from the project root to `dirs[last]` with
 * O_DIRECTORY|O_NOFOLLOW and requires each descriptor to be the same
 * directory lstat reports at that path. Returns the identities, or null when
 * any component is missing, a symlink, or not the directory it claims to be.
 */
async function captureDirChain(dirs: string[]): Promise<DirIdentity[] | null> {
  const chain: DirIdentity[] = [];
  for (const dir of dirs) {
    let lstats: fs.BigIntStats;
    try {
      lstats = await fs.promises.lstat(dir, { bigint: true });
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    if (lstats.isSymbolicLink() || !lstats.isDirectory()) return null;
    if (CAN_OPEN_DIRECTORIES) {
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(dir, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (isAbsence(err) || code === 'ELOOP' || code === 'ENOTDIR') return null;
        throw err;
      }
      try {
        const fstats = await handle.stat({ bigint: true });
        if (!fstats.isDirectory() || !sameIdentity(fstats, lstats)) return null;
      } finally {
        await handle.close();
      }
    }
    chain.push({ path: dir, dev: lstats.dev, ino: lstats.ino });
  }
  return chain;
}

/** Re-lstats a captured chain; true only if every directory is unchanged. */
async function chainUnchanged(chain: DirIdentity[]): Promise<boolean> {
  for (const entry of chain) {
    try {
      const stats = await fs.promises.lstat(entry.path, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isDirectory() || !sameIdentity(stats, entry)) return false;
    } catch (err) {
      if (isAbsence(err)) return false;
      throw err;
    }
  }
  return true;
}

function parentDirs(projectDir: string, rel: string): string[] {
  const dirs = [projectDir];
  const segments = rel.split('/');
  for (const segment of segments.slice(0, -1)) dirs.push(path.join(dirs[dirs.length - 1] as string, segment));
  return dirs;
}

const projectLocks = new Map<string, Promise<void>>();

/** Serialises syncs of one project directory inside this daemon process. */
async function withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  projectLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(key) === tail) projectLocks.delete(key);
  }
}

export async function syncDesignSystemPackageIntoProject(
  input: DesignSystemWorkspaceSyncInput,
): Promise<DesignSystemWorkspaceSyncConflict[]> {
  return withProjectLock(path.resolve(input.projectDir), () => runSync(input));
}

/**
 * `blocked`: a real (non-symlink) entry of the other type is in the way —
 * a regular file where a parent directory must be (`at: 'parent'`), or a
 * directory where the file must be (`at: 'target'`). That is a file ↔
 * directory type change, not an unsafe path.
 */
type Inspected =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'blocked'; at: 'parent' | 'target' }
  | { kind: 'file'; stats: fs.BigIntStats; absolutePath: string };

type CurrentFile =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'blocked'; at: 'parent' | 'target' }
  | { kind: 'file'; bytes: Buffer; stats: fs.BigIntStats };

function isAbsence(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Walks `rel` from the project root with lstat. Any symlink on the way —
 * including a dangling one, and the project root itself — makes the path
 * unsafe, as does a non-directory where a directory must be or a
 * non-regular file at the end.
 */
async function inspectPath(projectDir: string, rel: string): Promise<Inspected> {
  let current = projectDir;
  const segments = rel.split('/');
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index] as string);
    let stats: fs.BigIntStats;
    try {
      stats = await fs.promises.lstat(current, { bigint: true });
    } catch (err) {
      if (isAbsence(err)) return { kind: 'missing' };
      throw err;
    }
    if (stats.isSymbolicLink()) return { kind: 'unsafe' };
    const isLast = index === segments.length - 1;
    if (!isLast && !stats.isDirectory()) {
      return index >= 0 && stats.isFile() ? { kind: 'blocked', at: 'parent' } : { kind: 'unsafe' };
    }
    if (isLast) {
      if (stats.isDirectory()) return { kind: 'blocked', at: 'target' };
      if (!stats.isFile()) return { kind: 'unsafe' };
      return { kind: 'file', stats, absolutePath: current };
    }
  }
  return { kind: 'missing' };
}

async function readCurrent(projectDir: string, rel: string): Promise<CurrentFile> {
  const inspected = await inspectPath(projectDir, rel);
  if (inspected.kind !== 'file') return inspected;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(inspected.absolutePath, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (isAbsence(err)) return { kind: 'missing' };
    if ((err as { code?: unknown }).code === 'ELOOP') return { kind: 'unsafe' };
    throw err;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || !sameIdentity(stats, inspected.stats)) return { kind: 'unsafe' };
    designSystemWorkspaceSyncTestHooks.onProjectFileRead?.(rel);
    return { kind: 'file', bytes: await handle.readFile(), stats };
  } finally {
    await handle.close();
  }
}

async function statKey(projectDir: string, rel: string): Promise<string> {
  const inspected = await inspectPath(projectDir, rel);
  if (inspected.kind === 'blocked') return `blocked-${inspected.at}`;
  if (inspected.kind !== 'file') return inspected.kind;
  const { size, mtimeNs, ino } = inspected.stats;
  return `${size}:${mtimeNs}:${ino}`;
}

function sameExpectation(current: CurrentFile, expectedSha256: string | null): boolean {
  if (expectedSha256 === null) return current.kind === 'missing';
  return current.kind === 'file' && sha256Hex(current.bytes) === expectedSha256;
}

type CommitResult = 'ok' | 'unsafe' | 'changed' | 'blocked';

/**
 * Replaces `rel` with `bytes` only if the target still holds the content
 * this sync decided on (`expectedSha256`, or absent when null).
 *
 * Every parent directory is opened with O_DIRECTORY|O_NOFOLLOW and pinned
 * by dev/ino. The temp file is created empty with O_EXCL|O_NOFOLLOW, and
 * the chain is re-verified after creating it (so a parent swapped for a
 * symlink cannot receive the content), after writing it, and immediately
 * before the rename, together with a re-hash of the target.
 *
 * Remaining windows, both well under a millisecond: between the last chain
 * check and the rename (Node has no renameat/openat to bind the operation
 * to the verified descriptors), and between the target re-hash and the
 * rename. Exploiting the first needs local write access to the project
 * directory, i.e. the same user; the second needs that user's editor to
 * save inside it. Both are acceptable for a single-user local daemon whose
 * syncs of one project are serialised by `withProjectLock`.
 */
async function commitFile(
  projectDir: string,
  rel: string,
  bytes: Buffer,
  expectedSha256: string | null,
  onDirectoryCreated: (dirRel: string) => void,
): Promise<CommitResult> {
  const before = await inspectPath(projectDir, rel);
  if (before.kind === 'unsafe') return 'unsafe';
  if (before.kind === 'blocked') return 'blocked';

  const dirs = parentDirs(projectDir, rel);
  const segments = rel.split('/');
  await fs.promises.mkdir(projectDir, { recursive: true });
  for (const [index, dir] of dirs.entries()) {
    if (index === 0) continue;
    const parent = await captureDirChain(dirs.slice(0, index));
    if (!parent) return 'unsafe';
    try {
      await fs.promises.mkdir(dir);
      // Only a directory this mkdir created is the sync's to remove later;
      // EEXIST means someone else (possibly the user) made it.
      onDirectoryCreated(segments.slice(0, index).join('/'));
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    }
  }
  const chain = await captureDirChain(dirs);
  if (!chain) return 'unsafe';

  const dir = dirs[dirs.length - 1] as string;
  const target = path.join(dir, rel.split('/').pop() as string);
  const staged = path.join(dir, `.od-ds-sync-${randomUUID()}.tmp`);
  const hookInfo = { path: rel, absolutePath: target };
  await designSystemWorkspaceSyncTestHooks.beforeStage?.(hookInfo);
  // Re-verify right before creating the temp file too, so a swapped parent
  // is normally caught before anything is created through it.
  if (!(await chainUnchanged(chain))) return 'unsafe';

  const handle = await fs.promises.open(
    staged,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    0o644,
  );
  let stagedIdentity: fs.BigIntStats | null = null;
  /** Removes the temp file only if the path still names the file we created. */
  const discardStaged = async () => {
    try {
      const stats = await fs.promises.lstat(staged, { bigint: true });
      if (stagedIdentity && stats.isFile() && sameIdentity(stats, stagedIdentity)) await fs.promises.unlink(staged);
    } catch (err) {
      if (!isAbsence(err)) throw err;
    }
  };
  try {
    stagedIdentity = await handle.stat({ bigint: true });
    if (!(await chainUnchanged(chain))) {
      await handle.close();
      await discardStaged();
      return 'unsafe';
    }
    await handle.writeFile(bytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await designSystemWorkspaceSyncTestHooks.beforeCommit?.(hookInfo);
    const current = await readCurrent(projectDir, rel);
    if (current.kind === 'unsafe' || current.kind === 'blocked' || !(await chainUnchanged(chain))) {
      await discardStaged();
      return 'unsafe';
    }
    if (!sameExpectation(current, expectedSha256)) {
      await discardStaged();
      return 'changed';
    }
    // rename() replaces the directory entry itself and never follows a
    // symlink at the target; the parents were re-verified just above.
    await fs.promises.rename(staged, target);
    return 'ok';
  } catch (err) {
    await discardStaged();
    throw err;
  }
}

type UnlinkResult = 'ok' | 'missing' | 'unsafe' | 'changed' | 'protected';

/**
 * Deletes `rel` only if the file still hashes to `expectedSha256` and is not
 * the same physical file as a path the sync keeps. The hash comes from an
 * O_NOFOLLOW handle; right before the unlink the path is lstat-ed again and
 * must still be that file (dev, ino, size, mtime) under an unchanged
 * parent chain. Same remaining window and rationale as `commitFile`.
 */
async function unlinkFile(
  projectDir: string,
  rel: string,
  expectedSha256: string,
  keptInodes: Set<string>,
): Promise<UnlinkResult> {
  const chain = await captureDirChain(parentDirs(projectDir, rel));
  if (!chain) {
    const inspected = await inspectPath(projectDir, rel);
    // A regular file where a parent directory was means the tracked file
    // cannot exist any more.
    if (inspected.kind === 'missing' || (inspected.kind === 'blocked' && inspected.at === 'parent')) return 'missing';
    return 'unsafe';
  }
  const current = await readCurrent(projectDir, rel);
  // A directory where the tracked file was is the user's: keep it.
  if (current.kind === 'blocked') return current.at === 'parent' ? 'missing' : 'changed';
  if (current.kind !== 'file') return current.kind;
  if (keptInodes.has(`${current.stats.dev}:${current.stats.ino}`)) return 'protected';
  if (sha256Hex(current.bytes) !== expectedSha256) return 'changed';
  const absolutePath = path.join(...parentDirs(projectDir, rel).slice(-1), rel.split('/').pop() as string);
  await designSystemWorkspaceSyncTestHooks.beforeUnlink?.({ path: rel, absolutePath });
  if (!(await chainUnchanged(chain))) return 'unsafe';
  let recheck: fs.BigIntStats;
  try {
    recheck = await fs.promises.lstat(absolutePath, { bigint: true });
  } catch (err) {
    if (isAbsence(err)) return 'missing';
    throw err;
  }
  if (
    !recheck.isFile()
    || !sameIdentity(recheck, current.stats)
    || recheck.size !== current.stats.size
    || recheck.mtimeNs !== current.stats.mtimeNs
  ) {
    return 'changed';
  }
  await fs.promises.unlink(absolutePath);
  return 'ok';
}

/** Case-fold + NFC key used for every collision comparison. */
function foldKey(value: string): string {
  return value.normalize('NFC').toLowerCase().normalize('NFC');
}

/** Content fingerprint of the package: sorted path + sha256 of every file.
 * Computed fresh on every ensure (package files are small and daemon-owned),
 * so changed bytes with a preserved size and mtime are still noticed. */
function packageFingerprint(contents: Map<string, Buffer | null>): string {
  return sha256Hex(Buffer.from(JSON.stringify(
    [...contents.entries()]
      .map(([filePath, bytes]) => [filePath, bytes ? sha256Hex(bytes) : null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )));
}

/** Mirrors the private `rewriteLegacyPackageReferences` in
 * design-systems/index.ts, which migrates a package's own docs from the old
 * artifact names. Keep the two in step. */
function rewriteLegacyPackageReferences(text: string): string {
  return text
    .replaceAll('preview/colors-ui-palette.html', 'preview/colors-primary.html')
    .replaceAll('preview/colors-node-types.html', 'preview/colors-theme-light.html and preview/colors-theme-dark.html')
    .replaceAll('preview/typography-scale.html', 'preview/typography-specimens.html')
    .replaceAll('preview/spacing-system.html', 'preview/spacing-tokens.html, preview/spacing-radius.html, and preview/spacing-shadows.html')
    .replaceAll('preview/logo-variants.html', 'preview/brand-assets.html')
    .replaceAll('ui_kits/generated_interface/index.html', 'ui_kits/app/index.html')
    .replaceAll('ui_kits/generated_interface/', 'ui_kits/app/')
    .replaceAll('ui_kits/generated_interface', 'ui_kits/app');
}

const LEGACY_DOC_PATHS = new Set(['DESIGN.md', 'README.md', 'SKILL.md', 'ui_kits/app/README.md']);

/**
 * True when `current` is exactly the package doc as an earlier daemon wrote
 * it: applying the daemon's own legacy-reference migration to it yields the
 * package bytes. The two then differ only in tokens the daemon migrates, so
 * replacing it loses nothing the user wrote; any other edit fails the byte
 * comparison and the file is kept.
 */
function isExactLegacyFormOf(filePath: string, current: Buffer, pristine: Buffer): boolean {
  if (!LEGACY_DOC_PATHS.has(filePath)) return false;
  const text = current.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(current)) return false;
  const rewritten = rewriteLegacyPackageReferences(text);
  return rewritten !== text && Buffer.from(rewritten, 'utf8').equals(pristine);
}

function materialisedBytes(filePath: string, bytes: Buffer): Buffer {
  const normalized = normalizeArtifactRuntimeImports(filePath, bytes);
  return Buffer.isBuffer(normalized) ? normalized : Buffer.from(normalized as string | Uint8Array);
}

async function runSync({
  db,
  projectId,
  projectDir,
  packageFiles,
  readPackageFile,
  now,
}: DesignSystemWorkspaceSyncInput): Promise<DesignSystemWorkspaceSyncConflict[]> {
  const packagePaths = packageFiles.map((file) => file.path);
  const packageContents = new Map<string, Buffer | null>();
  for (const rel of packagePaths) packageContents.set(rel, (await readPackageFile(rel))?.bytes ?? null);
  const fingerprint = packageFingerprint(packageContents);

  const observedPaths = () => [
    ...new Set([...packagePaths, ...readDesignSystemWorkspaceSyncBaselines(db, projectId).keys()]),
  ].sort();

  // Fast path: package content unchanged and every project path the last
  // full sync looked at still has the same type, size, mtime and inode. A
  // changed package fingerprint always re-plans.
  const state = readDesignSystemWorkspaceSyncState(db, projectId);
  if (state && state.packageFingerprint === fingerprint) {
    const paths = observedPaths();
    if (paths.length === Object.keys(state.observed).length) {
      let unchanged = true;
      for (const rel of paths) {
        if (state.observed[rel] !== await statKey(projectDir, rel)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return state.conflicts;
    }
  }

  // A pass that changed the project may have unblocked work for the next
  // one, so its conflicts are not final. Re-run until a pass changes
  // nothing; only that fixpoint result is cached for the fast path, so the
  // cache never holds a conflict the next sync would resolve on its own.
  const MAX_PASSES = 3;
  let result: SyncPassResult = { conflicts: [], mutated: false };
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    result = await syncPass({
      db, projectId, projectDir, packagePaths, packageContents, now,
    });
    if (result.retryNeeded) break;
    if (!result.mutated) {
      const observed: Record<string, string> = {};
      for (const rel of observedPaths()) observed[rel] = await statKey(projectDir, rel);
      writeDesignSystemWorkspaceSyncState(
        db,
        projectId,
        { packageFingerprint: fingerprint, observed, conflicts: result.conflicts },
        now,
      );
      return result.conflicts;
    }
  }
  // Not a fixpoint (or a directory removal failed and must be retried):
  // drop any cached result so the next ensure runs a full sync.
  deleteDesignSystemWorkspaceSyncState(db, projectId);
  return result.conflicts;
}

type SyncPassResult = {
  conflicts: DesignSystemWorkspaceSyncConflict[];
  mutated: boolean;
  /** A sync-owned directory could not be removed; retry on the next ensure. */
  retryNeeded?: boolean;
};

/**
 * One planned pass, in a fixed order:
 * 1. names (portability, case/NFC collisions);
 * 2. removals of files the package dropped, then rmdir (never recursive) of
 *    empty directories the sync itself created — so a file → directory or
 *    directory → file change first clears the old entry;
 * 3. installs and updates of package files.
 * An entry of the other type still in the way after step 2 is the user's
 * (edited, untracked, or a directory the sync did not create — every
 * directory of a project that predates directory records) and is reported
 * as `type-change`.
 */
async function syncPass({
  db,
  projectId,
  projectDir,
  packagePaths,
  packageContents,
  now,
}: {
  db: Database.Database;
  projectId: string;
  projectDir: string;
  packagePaths: string[];
  packageContents: Map<string, Buffer | null>;
  now: number;
}): Promise<SyncPassResult> {
  const packagePathSet = new Set(packagePaths);
  const baselines = readDesignSystemWorkspaceSyncBaselines(db, projectId);
  let mutated = false;
  const conflicts: DesignSystemWorkspaceSyncConflict[] = [];
  const report = (filePath: string, reason: DesignSystemWorkspaceSyncConflict['reason']) => {
    conflicts.push({ path: filePath, reason });
  };

  // 1. Names: portable, and unique under case folding + NFC — among the
  //    package paths (and their directory prefixes) and against the real
  //    entries already in the project.
  const eligible: string[] = [];
  for (const rel of packagePaths) {
    try {
      if (validatePortableProjectPath(rel) === rel) {
        eligible.push(rel);
        continue;
      }
    } catch {
      // fall through
    }
    report(rel, 'unsupported-name');
  }

  const collisionKeys = new Set<string>();
  const exactByFold = new Map<string, Set<string>>();
  for (const rel of eligible) {
    const segments = rel.split('/');
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join('/');
      const key = foldKey(prefix);
      const exact = exactByFold.get(key) ?? new Set<string>();
      exact.add(prefix);
      exactByFold.set(key, exact);
    }
  }
  for (const [key, exact] of exactByFold) if (exact.size > 1) collisionKeys.add(key);

  const dirEntries = new Map<string, string[] | null>();
  const readEntries = async (dir: string) => {
    if (!dirEntries.has(dir)) {
      try {
        dirEntries.set(dir, await fs.promises.readdir(dir));
      } catch (err) {
        if (!isAbsence(err)) throw err;
        dirEntries.set(dir, null);
      }
    }
    return dirEntries.get(dir) ?? null;
  };
  const collidesWithProject = async (rel: string) => {
    let dir = projectDir;
    for (const segment of rel.split('/')) {
      const entries = await readEntries(dir);
      if (!entries) return false;
      const key = foldKey(segment);
      if (entries.some((entry) => entry !== segment && foldKey(entry) === key)) return true;
      if (!entries.includes(segment)) return false;
      dir = path.join(dir, segment);
    }
    return false;
  };

  const syncable: string[] = [];
  for (const rel of eligible) {
    const segments = rel.split('/');
    const collides = segments.some((_, index) =>
      collisionKeys.has(foldKey(segments.slice(0, index + 1).join('/'))));
    if (collides || await collidesWithProject(rel)) {
      collisionKeys.add(foldKey(rel));
      report(rel, 'name-collision');
      continue;
    }
    syncable.push(rel);
  }

  // 2. Files the package dropped. Never delete the physical file behind a
  //    path the package still has (case-insensitive or normalising disks).
  const keptInodes = new Set<string>();
  for (const rel of eligible) {
    const inspected = await inspectPath(projectDir, rel);
    if (inspected.kind === 'file') keptInodes.add(`${inspected.stats.dev}:${inspected.stats.ino}`);
  }
  for (const baseline of baselines.values()) {
    if (packagePathSet.has(baseline.path)) continue;
    if (collisionKeys.has(foldKey(baseline.path))) {
      report(baseline.path, 'name-collision');
      continue;
    }
    const outcome = await unlinkFile(projectDir, baseline.path, baseline.projectSha256, keptInodes);
    if (outcome === 'ok' || outcome === 'missing') {
      deleteDesignSystemWorkspaceSyncBaseline(db, projectId, baseline.path);
      if (outcome === 'ok') mutated = true;
    } else if (outcome === 'unsafe') {
      report(baseline.path, 'unsafe-path');
    } else if (outcome === 'protected') {
      report(baseline.path, 'name-collision');
    } else {
      // Edited after the last sync: keep the file and its baseline row so
      // the conflict is reported again until the user deletes the file.
      report(baseline.path, 'removed-upstream-edited');
    }
  }
  const directories = await removeOwnedEmptyDirectories(db, projectId, projectDir);
  if (directories.removed) mutated = true;

  // 3. Package files.
  for (const rel of syncable) {
    const packageBytes = packageContents.get(rel);
    if (!packageBytes) continue;
    const packageSha256 = sha256Hex(packageBytes);
    const pristine = materialisedBytes(rel, packageBytes);
    const pristineSha256 = sha256Hex(pristine);
    const baseline = baselines.get(rel);
    const current = await readCurrent(projectDir, rel);
    if (current.kind === 'unsafe') {
      report(rel, 'unsafe-path');
      continue;
    }
    if (current.kind === 'blocked') {
      report(rel, 'type-change');
      continue;
    }

    const commit = async (expectedSha256: string | null) => {
      const outcome = await commitFile(projectDir, rel, pristine, expectedSha256, (dirRel) => {
        recordDesignSystemWorkspaceSyncDir(db, projectId, dirRel, now);
      });
      if (outcome === 'ok') {
        mutated = true;
        writeDesignSystemWorkspaceSyncBaseline(
          db,
          projectId,
          { path: rel, packageSha256, projectSha256: pristineSha256 },
          now,
        );
      } else if (outcome === 'unsafe') {
        report(rel, 'unsafe-path');
      } else if (outcome === 'blocked') {
        report(rel, 'type-change');
      } else {
        report(rel, baseline ? 'edited' : 'no-baseline');
      }
    };

    if (current.kind === 'missing') {
      await commit(null);
      continue;
    }
    const currentSha256 = sha256Hex(current.bytes);
    if (currentSha256 === pristineSha256) {
      if (baseline?.packageSha256 !== packageSha256 || baseline.projectSha256 !== pristineSha256) {
        writeDesignSystemWorkspaceSyncBaseline(
          db,
          projectId,
          { path: rel, packageSha256, projectSha256: pristineSha256 },
          now,
        );
      }
      continue;
    }
    if (!baseline) {
      // The legacy replacement applies only to files never tracked: a
      // baseline row always wins, so a tracked file is never judged by it.
      if (isExactLegacyFormOf(rel, current.bytes, pristine)) await commit(currentSha256);
      else report(rel, 'no-baseline');
      continue;
    }
    if (currentSha256 === baseline.projectSha256) {
      await commit(currentSha256);
      continue;
    }
    if (baseline.packageSha256 !== packageSha256) report(rel, 'edited');
  }

  conflicts.sort((a, b) => (a.path === b.path ? a.reason.localeCompare(b.reason) : a.path < b.path ? -1 : 1));
  return { conflicts, mutated, retryNeeded: directories.failed };
}

/**
 * Removes, deepest first and with plain rmdir (never recursive), the empty
 * directories the sync itself created (`design_system_workspace_sync_dirs`).
 * A directory the sync did not create is never removed — the user's, or
 * any directory of a project that predates directory records — and neither
 * is the project root. A directory record is deleted only after its rmdir
 * succeeds (or the directory is already gone), so a failed removal is
 * retried by the next ensure.
 */
async function removeOwnedEmptyDirectories(
  db: Database.Database,
  projectId: string,
  projectDir: string,
): Promise<{ removed: boolean; failed: boolean }> {
  const owned = readDesignSystemWorkspaceSyncDirs(db, projectId)
    .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
  let removed = false;
  let failed = false;
  for (const rel of owned) {
    const dirs = parentDirs(projectDir, `${rel}/_`);
    const chain = await captureDirChain(dirs);
    if (!chain) {
      // Not a plain directory chain any more. Drop the record only when the
      // directory is simply gone; anything else in its place is left alone.
      try {
        await fs.promises.lstat(dirs[dirs.length - 1] as string);
      } catch (err) {
        if (!isAbsence(err)) throw err;
        deleteDesignSystemWorkspaceSyncDir(db, projectId, rel);
      }
      continue;
    }
    try {
      const entries = await fs.promises.readdir(dirs[dirs.length - 1] as string);
      if (entries.length > 0) continue;
      await designSystemWorkspaceSyncTestHooks.beforeRmdir?.(rel);
      if (!(await chainUnchanged(chain))) continue;
      await fs.promises.rmdir(dirs[dirs.length - 1] as string);
      deleteDesignSystemWorkspaceSyncDir(db, projectId, rel);
      removed = true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') continue;
      if (isAbsence(err)) {
        deleteDesignSystemWorkspaceSyncDir(db, projectId, rel);
        continue;
      }
      // Keep the record; the next ensure retries this directory.
      failed = true;
    }
  }
  return { removed, failed };
}
