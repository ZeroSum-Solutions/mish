// Mish packs: install, list and remove.
//
// Layout under `<dataDir>/mish-packs/`:
//   <id>/                 an installed pack (its `mish-pack.json` and every file it provides)
//   .receipts/<id>.json   what activation did outside the pack folder (copied folders, projects, MCP entries)
//   .previous/<token>/    the generation a replacement is taking over from, kept until the new one is active
//   .previous/<token>.json   the journal that can put that generation back
//   .staging/, .trash/    work areas; leftovers are removed on the next start
//
// Resources the daemon reads in place (catalogues, kits, assets, design profiles) are not copied:
// the overlay reads them from the pack folder. Folders that scanners expect inside a user root
// (skills, design systems, studies) are copied there on install and removed again on remove; the
// receipt records exactly which folders the pack added so nothing else is touched, and a digest of
// each as placed. Saved projects are copied into the projects folder under their own ids with their
// rows (see `projects.ts`). On remove, reinstall or a new version, a copy whose digest no longer
// matches (the user changed it) is moved to `<user root>/.mish-pack-backups/<id>-<time>/<name>`
// instead of being deleted, and the result names it. A receipt without digests (written before
// they existed) backs up every copy.
//
// Replacing a pack is recoverable. The old generation's pack tree, its untouched copies and
// projects are moved aside (not deleted), the MCP entries and project rows it took away are kept in
// a journal, and only when the new generation has activated is the old one let go. If activation
// fails, what the new generation placed is taken away again and the old one is put back exactly.
// The journal also lets the next start finish that rollback after a crash.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';

import {
  MISH_PACK_ID_PATTERN,
  MISH_PACK_LIMITS,
  MISH_PACK_MANIFEST_FILENAME,
  mishPackManifestSchema,
  type MishPackInstallResponse,
  type MishPackManifest,
  type MishPackProjectRow,
  type MishPackProvided,
  type MishPackRemoveResponse,
  type MishPackResourceKey,
  type MishPacksListResponse,
  type MishPackSummary,
} from '@mish/contracts';

import type { McpServerConfig } from '../mcp-config.js';
import { MishPackError } from './errors.js';
import { applyPackEnv, packRequiredEnvNames } from './env.js';
import {
  copyMishPackFolder,
  copyTreeNoLinks,
  DEFAULT_MISH_PACK_LIMITS,
  extractMishPackZip,
  type MishPackLimits,
} from './extract.js';
import { restorePackMcpServers, seedPackMcpServers, unseedPackMcpServers, type SeededMcpServer } from './mcp.js';
import {
  activeMishPacks,
  configureMishPacks,
  declaredPackPath,
  mishPacksInstallDir,
  packResourcePath,
  refreshMishPacks,
  resolvePackPath,
  type ActiveMishPack,
} from './overlay.js';
import {
  insertPackProjectRow,
  prepareProjectRow,
  projectRowExists,
  readPackProjectRows,
  retirePackProject,
  verifyPackProjects,
  type PackProjectRecord,
  type ProjectDb,
} from './projects.js';

export interface MishPackStoreOptions {
  dataDir: string;
  /** MISH_PACKS_DIR: a read-only folder of pack folders (or one pack folder). */
  externalDir?: string | null;
  /** Roots the daemon scans for user skills and user design systems. */
  userRoots: { skills: string; designSystems: string };
  /** The managed-project root. Without it (and `db`) a pack's projects are not placed. */
  projectsDir?: string;
  /** The project database, once it is open. */
  db?: () => ProjectDb | null;
  env?: NodeJS.ProcessEnv;
  limits?: MishPackLimits;
  now?: () => Date;
  /** Test seam: runs after a pack activated during install; throwing makes the install roll back. */
  afterActivate?: (packId: string) => void | Promise<void>;
}

type CopyBucket = 'skills' | 'designSystems';

interface Receipt {
  id: string;
  version: string;
  installedAt: string;
  copied: Record<CopyBucket, string[]>;
  /** `folderDigest` of each copied folder as placed. Absent in receipts written before digests. */
  digests?: Record<CopyBucket, Record<string, string>>;
  seededMcp: SeededMcpServer[];
  /** Saved projects this pack placed, by id. */
  projects?: Record<string, PackProjectRecord>;
  /** True while the pack's projects still wait for the project database. */
  projectsPending?: boolean;
  /** The install that wrote this receipt, so a rollback after a crash knows which generation it belongs to. */
  token?: string;
  warnings: string[];
}

/** A copied folder the user changed after install: moved aside instead of deleted. */
export interface MishPackBackup {
  /** The root it was in: `skills`, `designSystems` (design systems and studies) or `projects`. */
  resource: CopyBucket | 'projects';
  name: string;
  /** Absolute path the folder now lives at. */
  path: string;
}

/** A project the pack added that the person used or changed: it stays as their own. */
export interface MishPackKept {
  resource: 'projects';
  name: string;
  reason: string;
}

export interface MishPackStoreInstallResult extends MishPackInstallResponse {
  backups: MishPackBackup[];
}

export interface MishPackStoreRemoveResult extends MishPackRemoveResponse {
  backups: MishPackBackup[];
  /** Present only when a project was kept. */
  kept?: MishPackKept[];
}

export interface MishPackStore {
  list(): Promise<MishPacksListResponse>;
  install(source: string): Promise<MishPackStoreInstallResult>;
  remove(id: string): Promise<MishPackStoreRemoveResult>;
  /** Boot: finish an interrupted replacement, repair crash residue, scan, activate every pack, apply allow-listed environment. */
  start(): Promise<void>;
  isBusy(): boolean;
}

/** Everything a replacement took from the old generation, so a failure can put it back. */
interface Journal {
  token: string;
  packId: string;
  /** The old generation's receipt as it was; null on a first install. */
  receipt: Receipt | null;
  /** Where the old pack tree waits; null when there was none. */
  packDir: string | null;
  /** Folders moved out of their place: `from` is where each belongs, `held` ones are deleted on success. */
  moved: Array<{ from: string; to: string; held: boolean }>;
  /** Project rows taken away. */
  rows: MishPackProjectRow[];
  /** MCP entries taken away. */
  mcp: McpServerConfig[];
  /** Set once the new generation is active: from then on the journal only needs cleaning up. */
  committed: boolean;
}

const ID_RE = new RegExp(MISH_PACK_ID_PATTERN);
const CHILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const DIR_KEYS: readonly MishPackResourceKey[] = ['cultKit', 'cultCatalog', 'genui', 'twentyFirst', 'designSystems', 'skills', 'studies', 'pets', 'promptTemplates', 'styleCatalog', 'projects', 'designIndex'];
const FILE_KEYS: readonly MishPackResourceKey[] = ['cultAdapters', 'sections'];
const ALL_KEYS: readonly MishPackResourceKey[] = [...DIR_KEYS, ...FILE_KEYS];
const COPIED_KEYS = new Set<MishPackResourceKey>(['designSystems', 'skills', 'studies', 'projects']);
const BACKUP_DIRNAME = '.mish-pack-backups';
const HOLD_DIRNAME = '.mish-pack-previous';

export function isMishPackId(value: string): boolean {
  return ID_RE.test(value);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function childDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && CHILD_RE.test(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * sha256 over a folder's contents: every entry's relative path in sorted order, with each file's
 * own sha256 and each link's target. It does not depend on where the folder sits, so a copy hashed
 * in its temp folder matches itself after the rename. Null when `dir` is not a folder.
 */
export async function folderDigest(dir: string): Promise<string | null> {
  try {
    if (!(await fsp.lstat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const lines: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        lines.push(JSON.stringify(['dir', childRel]));
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        lines.push(JSON.stringify(['file', childRel, await fileDigest(childAbs)]));
      } else if (entry.isSymbolicLink()) {
        lines.push(JSON.stringify(['link', childRel, await fsp.readlink(childAbs)]));
      } else {
        lines.push(JSON.stringify(['other', childRel]));
      }
    }
  };
  await walk(dir, '');
  const hash = createHash('sha256');
  for (const line of lines.sort()) hash.update(`${line}\n`);
  return hash.digest('hex');
}

function recordedDigest(receipt: Receipt, bucket: CopyBucket, name: string): string | undefined {
  const map = receipt.digests?.[bucket];
  if (!map || typeof map !== 'object' || !Object.hasOwn(map, name)) return undefined;
  const value = map[name];
  return typeof value === 'string' ? value : undefined;
}

function recordDigest(receipt: Receipt, bucket: CopyBucket, name: string, digest: string): void {
  const digests = receipt.digests ?? { skills: {}, designSystems: {} };
  receipt.digests = { ...digests, [bucket]: { ...(digests[bucket] ?? {}), [name]: digest } };
}

/** Filesystem-safe timestamp for a backup folder name. */
function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function backupWarning(backup: MishPackBackup): string {
  return `${backup.resource}/${backup.name} had changed since the pack added it and was moved to ${backup.path}`;
}

function keptWarning(kept: MishPackKept): string {
  return `${kept.resource}/${kept.name} was kept as your own project because ${kept.reason}`;
}

function issueText(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.length ? issue.path.join('.') : 'manifest'}: ${issue.message}`).join('; ');
}

/** Parses manifest bytes strictly; throws INVALID_MANIFEST with a bounded, secret-free message. */
export function parseMishPackManifestText(text: string): MishPackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MishPackError('INVALID_MANIFEST', `${MISH_PACK_MANIFEST_FILENAME} is not valid JSON`);
  }
  const parsed = mishPackManifestSchema.safeParse(raw);
  if (!parsed.success) throw new MishPackError('INVALID_MANIFEST', `${MISH_PACK_MANIFEST_FILENAME} is invalid: ${issueText(parsed.error)}`);
  return parsed.data;
}

async function readManifest(root: string): Promise<MishPackManifest> {
  const file = path.join(root, MISH_PACK_MANIFEST_FILENAME);
  let info;
  try {
    info = await fsp.stat(file);
  } catch {
    throw new MishPackError('INVALID_MANIFEST', `the pack has no ${MISH_PACK_MANIFEST_FILENAME} at its top level`);
  }
  if (!info.isFile() || info.size > MISH_PACK_LIMITS.manifestMaxBytes) throw new MishPackError('INVALID_MANIFEST', `${MISH_PACK_MANIFEST_FILENAME} is missing or too large`);
  return parseMishPackManifestText(await fsp.readFile(file, 'utf8'));
}

/** The folder holding `mish-pack.json`: the staging root, or its only child folder (a zipped folder). */
async function locatePackRoot(staging: string): Promise<string> {
  if (await exists(path.join(staging, MISH_PACK_MANIFEST_FILENAME))) return staging;
  const children = (await fsp.readdir(staging, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.'));
  if (children.length === 1 && children[0]!.isDirectory()) {
    const nested = path.join(staging, children[0]!.name);
    if (await exists(path.join(nested, MISH_PACK_MANIFEST_FILENAME))) return nested;
  }
  throw new MishPackError('INVALID_MANIFEST', `the pack has no ${MISH_PACK_MANIFEST_FILENAME} at its top level`);
}

/** Each declared path must exist inside the pack and have the expected type; required marker files must be there. */
async function verifyProvides(root: string, manifest: MishPackManifest): Promise<void> {
  const pack: ActiveMishPack = { id: manifest.id, root, manifest, origin: 'installed' };
  for (const key of ALL_KEYS) {
    const declared = declaredPackPath(manifest, key);
    if (declared === undefined) continue;
    const resolved = resolvePackPath(pack, declared);
    if (!resolved) throw new MishPackError('MISSING_RESOURCE', `the pack declares ${key} at ${JSON.stringify(declared)}, which is not in the pack`);
    const info = await fsp.stat(resolved);
    if (DIR_KEYS.includes(key) && !info.isDirectory()) throw new MishPackError('MISSING_RESOURCE', `${key} must be a folder`);
    if (FILE_KEYS.includes(key) && !info.isFile()) throw new MishPackError('MISSING_RESOURCE', `${key} must be a file`);
  }
  const need = (key: MishPackResourceKey, file: string) => {
    const resolved = packResourcePath(pack, key);
    if (resolved && !existsSync(path.join(resolved, file))) throw new MishPackError('MISSING_RESOURCE', `${key} must contain ${file}`);
  };
  need('cultKit', 'manifest.json');
  need('cultCatalog', 'catalog.json');
  need('genui', 'overlay.json');
  need('twentyFirst', '21st-thumbnails.json');
  need('designIndex', 'index.json');
  const projects = packResourcePath(pack, 'projects');
  if (projects) await verifyPackProjects(projects);
}

function emptyReceipt(pack: { id: string; manifest: MishPackManifest }, now: Date): Receipt {
  return { id: pack.id, version: pack.manifest.version, installedAt: now.toISOString(), copied: { skills: [], designSystems: [] }, seededMcp: [], projects: {}, warnings: [] };
}

/** Digests a new version's receipt starts from: empty for a first install, none from a receipt that predates them. */
function carriedDigests(previous: Receipt | null): Pick<Receipt, 'digests'> {
  if (!previous) return { digests: { skills: {}, designSystems: {} } };
  return previous.digests ? { digests: previous.digests } : {};
}

function isJournal(value: unknown): value is Journal {
  const journal = value as Partial<Journal> | null;
  return !!journal && typeof journal.token === 'string' && typeof journal.packId === 'string' && Array.isArray(journal.moved)
    && Array.isArray(journal.rows) && Array.isArray(journal.mcp) && typeof journal.committed === 'boolean';
}

export function createMishPackStore(options: MishPackStoreOptions): MishPackStore {
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_MISH_PACK_LIMITS;
  const now = options.now ?? (() => new Date());
  const root = mishPacksInstallDir(options.dataDir);
  const stagingRoot = path.join(root, '.staging');
  const trashRoot = path.join(root, '.trash');
  const receiptsRoot = path.join(root, '.receipts');
  const previousRoot = path.join(root, '.previous');
  let busy = false;

  const receiptFile = (id: string) => path.join(receiptsRoot, `${id}.json`);
  const journalFile = (token: string) => path.join(previousRoot, `${token}.json`);
  const projectDb = () => (options.projectsDir ? options.db?.() ?? null : null);

  async function readReceipt(id: string): Promise<Receipt | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(receiptFile(id), 'utf8')) as Receipt;
      if (parsed && parsed.id === id && Array.isArray(parsed.seededMcp) && parsed.copied) return parsed;
    } catch {
      // no receipt, or an unreadable one: treated as "nothing recorded"
    }
    return null;
  }

  async function writeJson(file: string, value: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  const writeReceipt = (receipt: Receipt) => writeJson(receiptFile(receipt.id), receipt);
  const writeJournal = (journal: Journal) => writeJson(journalFile(journal.token), journal);

  const bucketRoot = (bucket: CopyBucket) => (bucket === 'skills' ? options.userRoots.skills : options.userRoots.designSystems);

  /** Moves `dir` into `intoDir/<name>` (a free name), creating `intoDir`. */
  async function moveInto(dir: string, intoDir: string, name: string): Promise<string> {
    await fsp.mkdir(intoDir, { recursive: true });
    let target = path.join(intoDir, name);
    for (let n = 2; await exists(target); n += 1) target = path.join(intoDir, `${name}-${n}`);
    await fsp.rename(dir, target);
    return target;
  }

  /**
   * Takes away a folder this pack copied: deleted when it still matches the digest recorded at
   * install (or, during a replacement, moved into the hold folder so it can come back), otherwise
   * moved to `<root>/.mish-pack-backups/<packId>-<stamp>/<name>`. Returns the backup, or null when
   * the folder was deleted, held or is already gone.
   */
  async function retireCopy(receipt: Receipt, bucket: CopyBucket, name: string, stamp: string, journal?: Journal): Promise<MishPackBackup | null> {
    const destRoot = bucketRoot(bucket);
    const dest = path.join(destRoot, name);
    if (!(await exists(dest))) return null;
    const recorded = recordedDigest(receipt, bucket, name);
    if (recorded !== undefined && (await folderDigest(dest)) === recorded) {
      if (!journal) {
        await fsp.rm(dest, { recursive: true, force: true });
        return null;
      }
      const held = await moveInto(dest, path.join(destRoot, HOLD_DIRNAME, journal.token), name);
      journal.moved.push({ from: dest, to: held, held: true });
      await writeJournal(journal);
      return null;
    }
    const target = await moveInto(dest, path.join(destRoot, BACKUP_DIRNAME, `${receipt.id}-${stamp}`), name);
    if (journal) {
      journal.moved.push({ from: dest, to: target, held: false });
      await writeJournal(journal);
    }
    return { resource: bucket, name, path: target };
  }

  /** Copies the pack's skill, design-system and study folders into the user roots. Idempotent. */
  async function copyIntoUserRoots(pack: ActiveMishPack, receipt: Receipt, refresh: boolean, backups: MishPackBackup[]): Promise<void> {
    const targets: Array<{ key: MishPackResourceKey; bucket: CopyBucket }> = [
      { key: 'skills', bucket: 'skills' },
      { key: 'designSystems', bucket: 'designSystems' },
      { key: 'studies', bucket: 'designSystems' },
    ];
    const stamp = backupStamp(now());
    for (const { key, bucket } of targets) {
      const source = packResourcePath(pack, key);
      if (!source) continue;
      const destRoot = bucketRoot(bucket);
      const list = receipt.copied[bucket];
      await fsp.mkdir(destRoot, { recursive: true });
      for (const child of await childDirs(source)) {
        const dest = path.join(destRoot, child);
        const mine = list.includes(child);
        if (await exists(dest)) {
          if (!mine) {
            receipt.warnings.push(`${key}/${child} already exists and was left as it is`);
            continue;
          }
          // Already copied by this pack at this version: a restart does not copy it again.
          if (!refresh) continue;
          // A new version replaces the copy; one the user changed is moved aside, never deleted.
          const backup = await retireCopy(receipt, bucket, child, stamp);
          if (backup) {
            backups.push(backup);
            receipt.warnings.push(backupWarning(backup));
          }
        }
        const tmp = path.join(destRoot, `.mish-pack-${randomUUID()}`);
        let digest: string | null;
        try {
          await copyTreeNoLinks(path.join(source, child), tmp);
          digest = await folderDigest(tmp);
          await fsp.rename(tmp, dest);
        } catch (error) {
          await fsp.rm(tmp, { recursive: true, force: true });
          throw error;
        }
        if (!mine) list.push(child);
        if (digest !== null) recordDigest(receipt, bucket, child, digest);
        await writeReceipt(receipt);
      }
    }
  }

  /**
   * Places the pack's saved projects (see `projects.ts`). A project id the person already has is
   * left alone. On a new version, a project this pack placed earlier is retired first; one the
   * person used stays theirs and the new version's copy is not placed over it.
   */
  async function placeProjects(pack: ActiveMishPack, receipt: Receipt, backups: MishPackBackup[]): Promise<void> {
    const source = packResourcePath(pack, 'projects');
    if (!source) {
      receipt.projectsPending = false;
      return;
    }
    const db = projectDb();
    if (!db || !options.projectsDir) {
      receipt.projectsPending = true;
      receipt.warnings.push('the saved projects were not added because the project database is not open; they are added on the next start');
      return;
    }
    const projectsDir = options.projectsDir;
    const records = receipt.projects ?? {};
    receipt.projects = records;
    const stamp = backupStamp(now());
    let droppedLinks = 0;
    await fsp.mkdir(projectsDir, { recursive: true });
    for (const packRow of await readPackProjectRows(source)) {
      const prepared = prepareProjectRow(packRow);
      if ('skip' in prepared) {
        receipt.warnings.push(`projects/${packRow.id} was not added because ${prepared.skip}`);
        continue;
      }
      if (prepared.dropped.length > 0) droppedLinks += 1;
      const row = prepared.row;
      const folder = path.join(source, row.id);
      const info = await fsp.lstat(folder).catch(() => null);
      if (info && !info.isDirectory()) {
        receipt.warnings.push(`projects/${row.id} is not a folder in the pack and was not added`);
        continue;
      }
      const dest = path.join(projectsDir, row.id);
      const mine = Object.hasOwn(records, row.id);
      if (projectRowExists(db, row.id) || (await exists(dest))) {
        if (!mine) {
          receipt.warnings.push(`projects/${row.id} already exists and was left as it is`);
          continue;
        }
        const outcome = await retirePackProject({
          db, projectsDir, id: row.id, record: records[row.id]!, digest: folderDigest,
          backupDir: path.join(projectsDir, BACKUP_DIRNAME, `${receipt.id}-${stamp}`),
        });
        if (outcome.kind === 'kept') {
          delete records[row.id];
          receipt.warnings.push(keptWarning({ resource: 'projects', name: row.id, reason: outcome.reason }));
          await writeReceipt(receipt);
          continue;
        }
        if (outcome.kind === 'backup') {
          const backup: MishPackBackup = { resource: 'projects', name: row.id, path: outcome.path };
          backups.push(backup);
          receipt.warnings.push(backupWarning(backup));
        }
      }
      const tmp = path.join(projectsDir, `.mish-pack-${randomUUID()}`);
      let digest: string | null;
      try {
        // No folder in the pack: a project with no files, placed as an empty folder.
        if (info) await copyTreeNoLinks(folder, tmp);
        else await fsp.mkdir(tmp, { recursive: true });
        digest = await folderDigest(tmp);
        await fsp.rename(tmp, dest);
      } catch (error) {
        await fsp.rm(tmp, { recursive: true, force: true });
        throw error;
      }
      try {
        insertPackProjectRow(db, row);
      } catch {
        await fsp.rm(dest, { recursive: true, force: true });
        delete records[row.id];
        receipt.warnings.push(`projects/${row.id} could not be added to the project list`);
        await writeReceipt(receipt);
        continue;
      }
      records[row.id] = { digest, name: row.name, updatedAt: row.updatedAt };
      await writeReceipt(receipt);
    }
    if (droppedLinks > 0) receipt.warnings.push(`${droppedLinks} saved project(s) linked folders on another computer; those links were left out`);
    receipt.projectsPending = false;
  }

  /** Takes away the projects this pack placed. Projects the person used are kept and reported. */
  async function retireProjects(receipt: Receipt, stamp: string, journal?: Journal): Promise<{ backups: MishPackBackup[]; kept: MishPackKept[] }> {
    const backups: MishPackBackup[] = [];
    const kept: MishPackKept[] = [];
    const records = receipt.projects ?? {};
    const ids = Object.keys(records).filter((id) => CHILD_RE.test(id));
    if (ids.length === 0) return { backups, kept };
    const db = projectDb();
    if (!db || !options.projectsDir) {
      // Nothing can be checked without the database: every project stays, as the person's own.
      for (const id of ids) kept.push({ resource: 'projects', name: id, reason: 'the project database was not open' });
      return { backups, kept };
    }
    for (const id of ids) {
      const outcome = await retirePackProject({
        db, projectsDir: options.projectsDir, id, record: records[id]!, digest: folderDigest,
        backupDir: path.join(options.projectsDir, BACKUP_DIRNAME, `${receipt.id}-${stamp}`),
        ...(journal ? { holdDir: path.join(options.projectsDir, HOLD_DIRNAME, journal.token) } : {}),
      });
      if (outcome.kind === 'kept') kept.push({ resource: 'projects', name: id, reason: outcome.reason });
      if (outcome.kind === 'backup') backups.push({ resource: 'projects', name: id, path: outcome.path });
      if (journal && (outcome.kind === 'held' || outcome.kind === 'backup' || outcome.kind === 'deleted')) {
        if (outcome.kind !== 'deleted') journal.moved.push({ from: path.join(options.projectsDir, id), to: outcome.path, held: outcome.kind === 'held' });
        if (outcome.row) journal.rows.push(outcome.row);
        await writeJournal(journal);
      }
    }
    return { backups, kept };
  }

  async function removeUserRootCopies(receipt: Receipt, journal?: Journal): Promise<{ backups: MishPackBackup[]; kept: MishPackKept[] }> {
    const stamp = backupStamp(now());
    const backups: MishPackBackup[] = [];
    for (const bucket of ['skills', 'designSystems'] as const) {
      for (const child of receipt.copied[bucket]) {
        if (!CHILD_RE.test(child)) continue;
        const backup = await retireCopy(receipt, bucket, child, stamp, journal);
        if (backup) backups.push(backup);
      }
    }
    const projects = await retireProjects(receipt, stamp, journal);
    return { backups: [...backups, ...projects.backups], kept: projects.kept };
  }

  /**
   * Activation outside the pack folder; MCP entries are seeded only on a new version. `carried`
   * are backups an earlier step of the same operation made (a reinstall's removal): they are
   * reported with this receipt's warnings and in the returned list. `progress.receipt` is the
   * receipt being built, so a failure part way can be undone.
   */
  async function activate(
    pack: ActiveMishPack,
    carried: MishPackBackup[] = [],
    progress: { receipt?: Receipt } = {},
    token?: string,
  ): Promise<{ receipt: Receipt; backups: MishPackBackup[] }> {
    const previous = await readReceipt(pack.id);
    const receipt: Receipt = previous && previous.version === pack.manifest.version
      ? { ...previous, warnings: [] }
      : {
          ...emptyReceipt(pack, now()),
          installedAt: previous?.installedAt ?? now().toISOString(),
          copied: previous?.copied ?? { skills: [], designSystems: [] },
          ...carriedDigests(previous),
          seededMcp: previous?.seededMcp ?? [],
          projects: previous?.projects ?? {},
        };
    if (token) receipt.token = token;
    progress.receipt = receipt;
    const isNewVersion = !previous || previous.version !== pack.manifest.version;
    const backups = [...carried];
    receipt.warnings.push(...carried.map(backupWarning));
    await copyIntoUserRoots(pack, receipt, isNewVersion, backups);
    if (isNewVersion && (pack.manifest.provides.mcpServers?.length ?? 0) > 0) {
      try {
        const known = new Set(receipt.seededMcp.map((entry) => entry.id));
        const { seeded, skipped } = await seedPackMcpServers(options.dataDir, pack.manifest.provides.mcpServers ?? []);
        receipt.seededMcp.push(...seeded.filter((entry) => !known.has(entry.id)));
        for (const id of skipped) receipt.warnings.push(`MCP server ${id} already exists and was left as it is`);
      } catch {
        // An unreadable MCP file must not undo the rest of the install; say so and carry on.
        receipt.warnings.push('MCP servers were not added because the MCP settings file could not be updated');
      }
      await writeReceipt(receipt);
    }
    if (isNewVersion || receipt.projectsPending) await placeProjects(pack, receipt, backups);
    await writeReceipt(receipt);
    return { receipt, backups };
  }

  /**
   * Reverses activation; returns the copies that were moved aside because the user changed them.
   * With a journal (a replacement) nothing is deleted: untouched copies and projects are held, and
   * the MCP entries and project rows taken away are recorded, so `rollBack` can put them back.
   */
  async function deactivate(id: string, journal?: Journal): Promise<{ backups: MishPackBackup[]; kept: MishPackKept[] }> {
    const receipt = await readReceipt(id);
    if (!receipt) return { backups: [], kept: [] };
    if (journal) {
      journal.receipt = receipt;
      await writeJournal(journal);
    }
    const removedIds = await unseedPackMcpServers(options.dataDir, receipt.seededMcp);
    if (journal) {
      journal.mcp.push(...receipt.seededMcp.filter((entry) => removedIds.includes(entry.id)).map((entry) => entry.config));
      await writeJournal(journal);
    }
    const result = await removeUserRootCopies(receipt, journal);
    await fsp.rm(receiptFile(id), { force: true });
    return result;
  }

  /**
   * Undoes a replacement or a first install that did not finish: takes away what the new
   * generation placed (its receipt, `partial`, records it), then puts back the old pack tree, the
   * folders that were moved, the project rows and MCP entries, and the old receipt.
   */
  async function rollBack(journal: Journal, partial: Receipt | null): Promise<void> {
    const final = path.join(root, journal.packId);
    if (partial) {
      await unseedPackMcpServers(options.dataDir, partial.seededMcp).catch(() => []);
      await removeUserRootCopies(partial).catch(() => undefined);
    }
    await fsp.rm(receiptFile(journal.packId), { force: true });
    if (await exists(final)) {
      await fsp.mkdir(trashRoot, { recursive: true });
      await fsp.rename(final, path.join(trashRoot, randomUUID()));
    }
    if (journal.packDir && (await exists(journal.packDir))) await fsp.rename(journal.packDir, final);
    for (const move of [...journal.moved].reverse()) {
      if ((await exists(move.from)) || !(await exists(move.to))) continue;
      await fsp.mkdir(path.dirname(move.from), { recursive: true });
      await fsp.rename(move.to, move.from);
      // A backup folder this replacement made, now empty again, goes too (rmdir keeps a non-empty one).
      if (!move.held) {
        await fsp.rmdir(path.dirname(move.to)).catch(() => undefined);
        await fsp.rmdir(path.dirname(path.dirname(move.to))).catch(() => undefined);
      }
    }
    const db = projectDb();
    if (db) {
      for (const row of journal.rows) {
        if (!projectRowExists(db, row.id)) insertPackProjectRow(db, row);
      }
    }
    await restorePackMcpServers(options.dataDir, journal.mcp).catch(() => []);
    if (journal.receipt) await writeReceipt(journal.receipt);
    await discardJournal(journal);
  }

  /** Lets the old generation go once the new one is active: held folders and the old pack tree are deleted. */
  async function commit(journal: Journal): Promise<void> {
    journal.committed = true;
    await writeJournal(journal);
    await discardJournal(journal);
  }

  /** Removes the journal and every hold folder it names. Backups stay where they are. */
  async function discardJournal(journal: Journal): Promise<void> {
    for (const move of journal.moved) if (move.held) await fsp.rm(move.to, { recursive: true, force: true });
    if (journal.packDir) await fsp.rm(journal.packDir, { recursive: true, force: true });
    const holdRoots = [options.userRoots.skills, options.userRoots.designSystems, ...(options.projectsDir ? [options.projectsDir] : [])];
    for (const holdRoot of holdRoots) {
      await fsp.rm(path.join(holdRoot, HOLD_DIRNAME, journal.token), { recursive: true, force: true });
      await fsp.rmdir(path.join(holdRoot, HOLD_DIRNAME)).catch(() => undefined);
    }
    await fsp.rm(journalFile(journal.token), { force: true });
    await fsp.rmdir(previousRoot).catch(() => undefined);
    await fsp.rm(trashRoot, { recursive: true, force: true });
  }

  /** Start: a replacement the last run did not finish is rolled back (or, once committed, cleaned up). */
  async function recoverInterrupted(): Promise<void> {
    let names: string[];
    try {
      names = (await fsp.readdir(previousRoot)).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      let journal: unknown;
      try {
        journal = JSON.parse(await fsp.readFile(path.join(previousRoot, name), 'utf8'));
      } catch {
        journal = null;
      }
      if (!isJournal(journal)) {
        console.warn(`[mish-packs] an unreadable replacement journal was left in place: ${name}`);
        continue;
      }
      try {
        if (journal.committed) {
          await discardJournal(journal);
          continue;
        }
        const current = await readReceipt(journal.packId);
        await rollBack(journal, current && current.token === journal.token ? current : null);
        console.warn(`[mish-packs] ${journal.packId}: an interrupted install was rolled back`);
      } catch {
        console.warn(`[mish-packs] ${journal.packId}: an interrupted install could not be rolled back`);
      }
    }
  }

  async function summarize(pack: ActiveMishPack, receipt: Receipt | null): Promise<MishPackSummary> {
    const provides: MishPackProvided[] = [];
    for (const key of ALL_KEYS) {
      const resolved = packResourcePath(pack, key);
      if (!resolved) continue;
      // Projects count their rows: a project with no files has no folder in the pack.
      const items = key === 'projects'
        ? (await readPackProjectRows(resolved).catch(() => [])).length
        : COPIED_KEYS.has(key) ? (await childDirs(resolved)).length : null;
      provides.push({ resource: key, items });
    }
    const required = packRequiredEnvNames(pack);
    return {
      id: pack.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description ?? null,
      origin: pack.origin,
      provides,
      envKeys: Object.keys(pack.manifest.provides.env ?? {}).sort(),
      mcpServerIds: (pack.manifest.provides.mcpServers ?? []).map((server) => server.id),
      requiredEnv: required.map((name) => ({ name, set: Boolean(env[name]) })),
      installedAt: receipt?.installedAt ?? null,
      warnings: [...(receipt?.warnings ?? [])],
    };
  }

  async function withLock<T>(task: () => Promise<T>): Promise<T> {
    if (busy) throw new MishPackError('BUSY', 'another pack install or removal is running');
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  }

  function reload(): ActiveMishPack[] {
    const packs = refreshMishPacks();
    applyPackEnv(packs, env);
    return packs;
  }

  /**
   * Swaps the staged pack in. The old generation is held, not deleted, until the new one has
   * activated; any failure puts the old one back and rethrows.
   */
  async function replaceWith(packRoot: string, manifest: MishPackManifest): Promise<MishPackStoreInstallResult> {
    const final = path.join(root, manifest.id);
    const replaced = await exists(final);
    const journal: Journal = { token: randomUUID(), packId: manifest.id, receipt: null, packDir: null, moved: [], rows: [], mcp: [], committed: false };
    await writeJournal(journal);
    const progress: { receipt?: Receipt } = {};
    try {
      const removal = replaced ? await deactivate(manifest.id, journal) : { backups: [], kept: [] };
      if (replaced) {
        const held = path.join(previousRoot, journal.token);
        await fsp.mkdir(previousRoot, { recursive: true });
        await fsp.rename(final, held);
        journal.packDir = held;
        await writeJournal(journal);
      }
      await fsp.rename(packRoot, final);

      const packs = reload();
      const pack = packs.find((entry) => entry.id === manifest.id && entry.origin === 'installed');
      if (!pack) throw new MishPackError('INTERNAL_ERROR', 'the pack was placed but could not be read back');
      const { receipt, backups } = await activate(pack, removal.backups, progress, journal.token);
      receipt.warnings.push(...removal.kept.map(keptWarning));
      await writeReceipt(receipt);
      await options.afterActivate?.(manifest.id);
      await commit(journal);
      return { pack: await summarize(pack, receipt), replaced, backups };
    } catch (error) {
      try {
        await rollBack(journal, progress.receipt ?? null);
      } catch {
        console.warn(`[mish-packs] ${manifest.id}: the install failed and the previous state could not be fully restored`);
      }
      reload();
      throw error;
    }
  }

  return {
    isBusy: () => busy,

    async start() {
      await fsp.mkdir(root, { recursive: true });
      await recoverInterrupted();
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      await fsp.rm(trashRoot, { recursive: true, force: true });
      configureMishPacks({ dataDir: options.dataDir, externalDir: options.externalDir ?? null });
      const packs = reload();
      for (const pack of packs) {
        try {
          await activate(pack);
        } catch (error) {
          console.warn(`[mish-packs] ${pack.id}: activation failed (${(error as { code?: string }).code ?? 'error'})`);
        }
      }
    },

    async list() {
      const packs = reload();
      const summaries: MishPackSummary[] = [];
      for (const pack of packs) summaries.push(await summarize(pack, await readReceipt(pack.id)));
      return { packs: summaries, installDir: root, externalDir: options.externalDir ?? null };
    },

    install(source: string) {
      return withLock(async () => {
        if (typeof source !== 'string' || !path.isAbsolute(source)) throw new MishPackError('SOURCE_NOT_FOUND', 'the pack path must be absolute');
        let info;
        try {
          info = await fsp.stat(source);
        } catch {
          throw new MishPackError('SOURCE_NOT_FOUND', 'no file or folder exists at that path');
        }
        if (!info.isDirectory() && !(info.isFile() && source.toLowerCase().endsWith('.zip'))) {
          throw new MishPackError('INVALID_ARCHIVE', 'the source must be a pack folder or a .zip file');
        }
        const staging = path.join(stagingRoot, randomUUID());
        await fsp.mkdir(staging, { recursive: true });
        try {
          try {
            if (info.isDirectory()) await copyMishPackFolder(source, staging, limits);
            else await extractMishPackZip(source, staging, limits);
          } catch (error) {
            if (error instanceof MishPackError) throw error;
            throw new MishPackError('INVALID_ARCHIVE', 'the pack could not be unpacked; check that the archive is complete');
          }
          const packRoot = await locatePackRoot(staging);
          const manifest = await readManifest(packRoot);
          await verifyProvides(packRoot, manifest);
          return await replaceWith(packRoot, manifest);
        } finally {
          await fsp.rm(staging, { recursive: true, force: true });
        }
      });
    },

    remove(id: string) {
      return withLock(async () => {
        if (!ID_RE.test(id)) throw new MishPackError('NOT_FOUND', 'no installed pack has that id');
        const final = path.join(root, id);
        if (!(await exists(final))) {
          const external = activeMishPacks().find((pack) => pack.id === id && pack.origin === 'external');
          if (external) throw new MishPackError('READ_ONLY', 'this pack comes from MISH_PACKS_DIR; remove it from that folder');
          throw new MishPackError('NOT_FOUND', 'no installed pack has that id');
        }
        const { backups, kept } = await deactivate(id);
        await fsp.mkdir(trashRoot, { recursive: true });
        await fsp.rename(final, path.join(trashRoot, randomUUID()));
        await fsp.rm(trashRoot, { recursive: true, force: true });
        reload();
        return { removed: id, backups, ...(kept.length > 0 ? { kept } : {}) };
      });
    },
  };
}
