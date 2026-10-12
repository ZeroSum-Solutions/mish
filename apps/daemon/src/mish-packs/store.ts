// Mish packs: install, list and remove.
//
// Layout under `<dataDir>/mish-packs/`:
//   <id>/                    an installed pack (its `mish-pack.json` and every file it provides)
//   .receipts/<id>.json      what activation did outside the pack folder (copied folders, projects, MCP entries)
//   .journal/<token>.json    an install that has not finished (see "Installing" below)
//   .incoming/<token>/       the new pack tree of that install
//   .previous/<token>/       the old pack tree a committed install is about to delete
//   .staging/, .trash/       work areas; leftovers are removed on the next start
//
// Resources the daemon reads in place (catalogues, kits, assets, design profiles) are not copied:
// the overlay reads them from the pack folder. Folders that scanners expect inside a user root
// (skills, design systems, studies) are copied there; the receipt records exactly which folders the
// pack added so nothing else is touched, and a digest of each as placed. On remove or a new
// version, a copy whose digest no longer matches (the user changed it) is moved to
// `<user root>/.mish-pack-backups/<id>-<time>/<name>` instead of being deleted, and the result names
// it. A receipt without digests (written before they existed) backs up every copy.
//
// Saved projects are imported once and never deleted by the pack (see `projects.ts`). Remove and
// replace leave them in place; the receipt forgets them and the result lists them as kept.
//
// Installing is two-phase. Before the commit point nothing the current generation owns is touched:
// the new tree waits in `.incoming/<token>`, its copies wait in `<root>/.mish-pack-staging/<token>`,
// and a failure (or a crash, found by the next start) only deletes those. The commit is the
// journal's phase changing to `committed`. After it, the install only moves forward: the trees are
// swapped, the copies placed (retiring the old ones), MCP entries and projects applied, the old tree
// deleted. Every step is idempotent and the journal is written before each mutation, so a failure or
// a crash after the commit is finished by the next start and is never rolled back.

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
  type MishPackProvided,
  type MishPackRemoveResponse,
  type MishPackResourceKey,
  type MishPacksListResponse,
  type MishPackSummary,
} from '@mish/contracts';

import { MishPackError } from './errors.js';
import { applyPackEnv, packRequiredEnvNames } from './env.js';
import {
  copyMishPackFolder,
  copyTreeNoLinks,
  DEFAULT_MISH_PACK_LIMITS,
  extractMishPackZip,
  type MishPackLimits,
} from './extract.js';
import { seedPackMcpServers, unseedPackMcpServers, type SeededMcpServer } from './mcp.js';
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
  verifyPackProjects,
  type ProjectDb,
} from './projects.js';

/** Points of an install a test can stop or fail at. */
export type MishPackInstallStep = 'staged' | 'committed' | 'swapped' | 'cleanup';

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
  /** Test seam: runs at each step of an install; throwing there fails the install at that step. */
  onInstallStep?: (step: MishPackInstallStep, packId: string) => void | Promise<void>;
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
  /** Ids of the saved projects this pack imported. The pack never deletes them. */
  projects?: string[];
  /** The project being imported, so an interrupted import is completed rather than skipped. */
  importing?: string | null;
  /** True while the pack's projects still wait for the project database. */
  projectsPending?: boolean;
  /** The install that wrote this receipt. */
  token?: string;
  /** Set once that install placed its copies, so finishing it again does not repeat it. */
  copiesApplied?: boolean;
  /** Set once that install applied its MCP entries, so finishing it again does not repeat it. */
  mcpApplied?: boolean;
  warnings: string[];
}

/** A copied folder the user changed after install: moved aside instead of deleted. */
export interface MishPackBackup {
  /** The user root it was in: `skills`, or `designSystems` (design systems and studies). */
  resource: CopyBucket;
  name: string;
  /** Absolute path the folder now lives at. */
  path: string;
}

export interface MishPackStoreInstallResult extends MishPackInstallResponse {
  backups: MishPackBackup[];
}

export interface MishPackStoreRemoveResult extends MishPackRemoveResponse {
  backups: MishPackBackup[];
}

export interface MishPackStore {
  list(): Promise<MishPacksListResponse>;
  install(source: string): Promise<MishPackStoreInstallResult>;
  remove(id: string): Promise<MishPackStoreRemoveResult>;
  /** Boot: finish or discard an interrupted install, repair crash residue, scan, activate every pack, apply allow-listed environment. */
  start(): Promise<void>;
  isBusy(): boolean;
}

/** A new copy waiting in a user root's staging folder. */
interface StagedCopy {
  bucket: CopyBucket;
  name: string;
  path: string;
  digest: string | null;
}

/** An install that has not finished. Written before every mutation it describes. */
interface Journal {
  token: string;
  packId: string;
  version: string;
  /** `preparing`: nothing the current generation owns was touched. `committed`: the install only moves forward. */
  phase: 'preparing' | 'committed';
  /** The new pack tree. */
  incomingTree: string;
  /** Where the old pack tree goes before it is deleted. */
  previousTree: string;
  /** `<root>/.mish-pack-staging/<token>` for every user root. */
  stagingDirs: string[];
  stagedCopies: StagedCopy[];
  /** The receipt of the generation being replaced; null on a first install. */
  oldReceipt: Receipt | null;
  /** `mcp-config.json` as it was before the install (null when absent), kept for restoring by hand. */
  mcpBefore: string | null;
  warnings: string[];
}

const ID_RE = new RegExp(MISH_PACK_ID_PATTERN);
const CHILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const DIR_KEYS: readonly MishPackResourceKey[] = ['cultKit', 'cultCatalog', 'genui', 'twentyFirst', 'designSystems', 'skills', 'studies', 'pets', 'promptTemplates', 'styleCatalog', 'projects', 'designIndex'];
const FILE_KEYS: readonly MishPackResourceKey[] = ['cultAdapters', 'sections'];
const ALL_KEYS: readonly MishPackResourceKey[] = [...DIR_KEYS, ...FILE_KEYS];
const COPIED_KEYS = new Set<MishPackResourceKey>(['designSystems', 'skills', 'studies']);
const COPY_TARGETS: ReadonlyArray<{ key: MishPackResourceKey; bucket: CopyBucket }> = [
  { key: 'skills', bucket: 'skills' },
  { key: 'designSystems', bucket: 'designSystems' },
  { key: 'studies', bucket: 'designSystems' },
];
const BACKUP_DIRNAME = '.mish-pack-backups';
const STAGING_DIRNAME = '.mish-pack-staging';

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

/** Project ids a receipt records. Tolerates a receipt written by an earlier build in another shape. */
function receiptProjects(receipt: Receipt | null): string[] {
  const value = receipt?.projects as unknown;
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

/** Filesystem-safe timestamp for a backup folder name. */
function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function backupWarning(backup: MishPackBackup): string {
  return `${backup.resource}/${backup.name} had changed since the pack added it and was moved to ${backup.path}`;
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
  return { id: pack.id, version: pack.manifest.version, installedAt: now.toISOString(), copied: { skills: [], designSystems: [] }, seededMcp: [], projects: [], warnings: [] };
}

/** Digests a new version's receipt starts from: empty for a first install, none from a receipt that predates them. */
function carriedDigests(previous: Receipt | null): Pick<Receipt, 'digests'> {
  if (!previous) return { digests: { skills: {}, designSystems: {} } };
  return previous.digests ? { digests: previous.digests } : {};
}

function isJournal(value: unknown): value is Journal {
  const journal = value as Partial<Journal> | null;
  return !!journal && typeof journal.token === 'string' && typeof journal.packId === 'string'
    && (journal.phase === 'preparing' || journal.phase === 'committed')
    && typeof journal.incomingTree === 'string' && typeof journal.previousTree === 'string'
    && Array.isArray(journal.stagingDirs) && Array.isArray(journal.stagedCopies) && Array.isArray(journal.warnings);
}

export function createMishPackStore(options: MishPackStoreOptions): MishPackStore {
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_MISH_PACK_LIMITS;
  const now = options.now ?? (() => new Date());
  const root = mishPacksInstallDir(options.dataDir);
  const stagingRoot = path.join(root, '.staging');
  const trashRoot = path.join(root, '.trash');
  const receiptsRoot = path.join(root, '.receipts');
  const journalRoot = path.join(root, '.journal');
  const incomingRoot = path.join(root, '.incoming');
  const previousRoot = path.join(root, '.previous');
  const step = async (name: MishPackInstallStep, packId: string) => options.onInstallStep?.(name, packId);
  let busy = false;

  const receiptFile = (id: string) => path.join(receiptsRoot, `${id}.json`);
  const journalFile = (token: string) => path.join(journalRoot, `${token}.json`);
  const projectDb = () => (options.projectsDir ? options.db?.() ?? null : null);
  const bucketRoot = (bucket: CopyBucket) => (bucket === 'skills' ? options.userRoots.skills : options.userRoots.designSystems);
  const userRoots = () => [...new Set([options.userRoots.skills, options.userRoots.designSystems])];

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

  async function readMcpText(): Promise<string | null> {
    try {
      return await fsp.readFile(path.join(options.dataDir, 'mcp-config.json'), 'utf8');
    } catch {
      return null;
    }
  }

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
   * install, otherwise moved to `<root>/.mish-pack-backups/<packId>-<stamp>/<name>`. Returns the
   * backup, or null when the folder was deleted or is already gone.
   */
  async function retireCopy(receipt: Receipt, bucket: CopyBucket, name: string, stamp: string): Promise<MishPackBackup | null> {
    const destRoot = bucketRoot(bucket);
    const dest = path.join(destRoot, name);
    if (!(await exists(dest))) return null;
    const recorded = recordedDigest(receipt, bucket, name);
    if (recorded !== undefined && (await folderDigest(dest)) === recorded) {
      await fsp.rm(dest, { recursive: true, force: true });
      return null;
    }
    const target = await moveInto(dest, path.join(destRoot, BACKUP_DIRNAME, `${receipt.id}-${stamp}`), name);
    return { resource: bucket, name, path: target };
  }

  /** Copies the pack's skill, design-system and study folders into the user roots. Idempotent. */
  async function copyIntoUserRoots(pack: ActiveMishPack, receipt: Receipt, refresh: boolean, backups: MishPackBackup[]): Promise<void> {
    const stamp = backupStamp(now());
    for (const { key, bucket } of COPY_TARGETS) {
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
      }
    }
  }

  /**
   * Imports the pack's saved projects (see `projects.ts`): each id the person does not have yet is
   * copied and added once. An id the receipt already lists is left alone, even if the person has
   * deleted that project since. Each import is recorded before it starts, so one cut short by a
   * crash is completed next time rather than taken for the person's own project.
   */
  async function importProjects(pack: ActiveMishPack, receipt: Receipt): Promise<void> {
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
    const mine = new Set(receiptProjects(receipt));
    const existing: string[] = [];
    let droppedLinks = 0;
    await fsp.mkdir(projectsDir, { recursive: true });
    for (const packRow of await readPackProjectRows(source)) {
      if (mine.has(packRow.id)) continue;
      const prepared = prepareProjectRow(packRow);
      if ('skip' in prepared) {
        receipt.warnings.push(`projects/${packRow.id} was not added because ${prepared.skip}`);
        continue;
      }
      const row = prepared.row;
      const folder = path.join(source, row.id);
      const info = await fsp.lstat(folder).catch(() => null);
      if (info && !info.isDirectory()) {
        receipt.warnings.push(`projects/${row.id} is not a folder in the pack and was not added`);
        continue;
      }
      const dest = path.join(projectsDir, row.id);
      const resuming = receipt.importing === row.id;
      if (!resuming && (projectRowExists(db, row.id) || (await exists(dest)))) {
        existing.push(row.id);
        continue;
      }
      receipt.importing = row.id;
      await writeReceipt(receipt);
      let created = false;
      if (!(await exists(dest))) {
        const tmp = path.join(projectsDir, `.mish-pack-${randomUUID()}`);
        try {
          // No folder in the pack: a project with no files, placed as an empty folder.
          if (info) await copyTreeNoLinks(folder, tmp);
          else await fsp.mkdir(tmp, { recursive: true });
          await fsp.rename(tmp, dest);
          created = true;
        } catch (error) {
          await fsp.rm(tmp, { recursive: true, force: true });
          throw error;
        }
      }
      if (!projectRowExists(db, row.id)) {
        try {
          insertPackProjectRow(db, row);
        } catch {
          if (created) await fsp.rm(dest, { recursive: true, force: true });
          receipt.importing = null;
          receipt.warnings.push(`projects/${row.id} could not be added to the project list`);
          await writeReceipt(receipt);
          continue;
        }
      }
      if (prepared.dropped.length > 0) droppedLinks += 1;
      mine.add(row.id);
      receipt.projects = [...mine];
      receipt.importing = null;
      await writeReceipt(receipt);
    }
    if (existing.length > 0) {
      const shown = existing.slice(0, 5).join(', ');
      receipt.warnings.push(`${existing.length} saved project(s) already exist and were left as they are: ${shown}${existing.length > 5 ? ', ...' : ''}`);
    }
    if (droppedLinks > 0) receipt.warnings.push(`${droppedLinks} saved project(s) linked folders on another computer; those links were left out`);
    receipt.projectsPending = false;
  }

  async function seedMcp(pack: ActiveMishPack, receipt: Receipt): Promise<void> {
    try {
      const known = new Set(receipt.seededMcp.map((entry) => entry.id));
      const { seeded, skipped } = await seedPackMcpServers(options.dataDir, pack.manifest.provides.mcpServers ?? []);
      receipt.seededMcp.push(...seeded.filter((entry) => !known.has(entry.id)));
      for (const id of skipped) receipt.warnings.push(`MCP server ${id} already exists and was left as it is`);
    } catch {
      // An unreadable MCP file must not undo the rest of the install; say so and carry on.
      receipt.warnings.push('MCP servers were not added because the MCP settings file could not be updated');
    }
  }

  /**
   * Boot activation of a pack that is already in place (an installed pack after a restart, or a
   * pack in MISH_PACKS_DIR). MCP entries are seeded and projects imported only on a new version.
   */
  async function activate(pack: ActiveMishPack): Promise<{ receipt: Receipt; backups: MishPackBackup[] }> {
    const previous = await readReceipt(pack.id);
    const receipt: Receipt = previous && previous.version === pack.manifest.version
      ? { ...previous, warnings: [] }
      : {
          ...emptyReceipt(pack, now()),
          installedAt: previous?.installedAt ?? now().toISOString(),
          copied: previous?.copied ?? { skills: [], designSystems: [] },
          ...carriedDigests(previous),
          seededMcp: previous?.seededMcp ?? [],
          projects: receiptProjects(previous),
        };
    const isNewVersion = !previous || previous.version !== pack.manifest.version;
    const backups: MishPackBackup[] = [];
    await copyIntoUserRoots(pack, receipt, isNewVersion, backups);
    if (isNewVersion && (pack.manifest.provides.mcpServers?.length ?? 0) > 0) await seedMcp(pack, receipt);
    if (isNewVersion || receipt.projectsPending || receipt.importing) await importProjects(pack, receipt);
    await writeReceipt(receipt);
    return { receipt, backups };
  }

  /**
   * Removal: MCP entries and copies go, projects stay. Returns the copies that were moved aside
   * because the user changed them, and the projects kept.
   */
  async function deactivate(id: string): Promise<{ backups: MishPackBackup[]; keptProjects: string[] }> {
    const receipt = await readReceipt(id);
    if (!receipt) return { backups: [], keptProjects: [] };
    await unseedPackMcpServers(options.dataDir, receipt.seededMcp);
    const stamp = backupStamp(now());
    const backups: MishPackBackup[] = [];
    for (const bucket of ['skills', 'designSystems'] as const) {
      for (const child of receipt.copied[bucket]) {
        if (!CHILD_RE.test(child)) continue;
        const backup = await retireCopy(receipt, bucket, child, stamp);
        if (backup) backups.push(backup);
      }
    }
    await fsp.rm(receiptFile(id), { force: true });
    return { backups, keptProjects: receiptProjects(receipt) };
  }

  // -------------------------------------------------------------------------------------------
  // Installing: prepare (touches nothing current) -> commit -> finish (only moves forward)
  // -------------------------------------------------------------------------------------------

  /** Copies the new generation's user-root folders into each root's staging folder. Nothing in place changes. */
  async function stageCopies(pack: ActiveMishPack, journal: Journal): Promise<void> {
    const staged = new Set<string>();
    for (const { key, bucket } of COPY_TARGETS) {
      const source = packResourcePath(pack, key);
      if (!source) continue;
      const stagingDir = path.join(bucketRoot(bucket), STAGING_DIRNAME, journal.token);
      for (const child of await childDirs(source)) {
        if (staged.has(`${bucket}/${child}`)) {
          journal.warnings.push(`${key}/${child} is provided twice by the pack; the first one is used`);
          continue;
        }
        staged.add(`${bucket}/${child}`);
        const target = path.join(stagingDir, child);
        await copyTreeNoLinks(path.join(source, child), target);
        journal.stagedCopies.push({ bucket, name: child, path: target, digest: await folderDigest(target) });
      }
    }
  }

  /** Before the commit: deletes what the install staged. The current generation was never touched. */
  async function discardPrepared(journal: Journal): Promise<void> {
    await fsp.rm(journal.incomingTree, { recursive: true, force: true });
    for (const dir of journal.stagingDirs) await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(journalFile(journal.token), { force: true });
    await removeEmptyWorkDirs();
  }

  async function removeEmptyWorkDirs(): Promise<void> {
    for (const dir of [journalRoot, incomingRoot, previousRoot, ...userRoots().map((userRoot) => path.join(userRoot, STAGING_DIRNAME))]) {
      await fsp.rmdir(dir).catch(() => undefined);
    }
  }

  /**
   * After the commit: brings the new generation fully in and lets the old one go. Every step can
   * run again after a crash or a failure and lands in the same place; nothing is rolled back.
   */
  async function finish(journal: Journal, backups: MishPackBackup[]): Promise<{ pack: ActiveMishPack; receipt: Receipt; cleanupFailed: boolean }> {
    const final = path.join(root, journal.packId);
    const old = journal.oldReceipt;
    await step('committed', journal.packId);

    // 1. Trees: the old one moves aside, the new one takes its place.
    if (await exists(journal.incomingTree)) {
      if (await exists(final)) {
        await fsp.mkdir(path.dirname(journal.previousTree), { recursive: true });
        if (await exists(journal.previousTree)) await fsp.rm(journal.previousTree, { recursive: true, force: true });
        await fsp.rename(final, journal.previousTree);
      }
      await fsp.rename(journal.incomingTree, final);
    }
    const pack = reload().find((entry) => entry.id === journal.packId && entry.origin === 'installed');
    if (!pack) throw new MishPackError('INTERNAL_ERROR', 'the pack was placed but could not be read back');
    await step('swapped', journal.packId);

    // 2. The new receipt, continued when an earlier attempt already started it.
    const current = await readReceipt(journal.packId);
    const receipt: Receipt = current && current.token === journal.token
      ? current
      : {
          ...emptyReceipt(pack, now()),
          installedAt: old?.installedAt ?? now().toISOString(),
          digests: { skills: {}, designSystems: {} },
          projects: receiptProjects(old),
          token: journal.token,
          warnings: [...journal.warnings],
        };
    await writeReceipt(receipt);

    // 3. Copies: each staged one replaces the old copy of the same name, or takes a free name.
    const stamp = backupStamp(now());
    const keep = (backup: MishPackBackup | null) => {
      if (!backup) return;
      backups.push(backup);
      receipt.warnings.push(backupWarning(backup));
    };
    for (const staged of receipt.copiesApplied ? [] : journal.stagedCopies) {
      const dest = path.join(bucketRoot(staged.bucket), staged.name);
      const list = receipt.copied[staged.bucket];
      if (list.includes(staged.name)) continue;
      if (!(await exists(staged.path))) {
        // Placed by an earlier attempt that stopped before the receipt was written.
        if (await exists(dest)) {
          list.push(staged.name);
          if (staged.digest !== null) recordDigest(receipt, staged.bucket, staged.name, staged.digest);
          await writeReceipt(receipt);
        }
        continue;
      }
      if (await exists(dest)) {
        if (!old?.copied[staged.bucket].includes(staged.name)) {
          receipt.warnings.push(`${staged.bucket}/${staged.name} already exists and was left as it is`);
          continue;
        }
        keep(await retireCopy(old, staged.bucket, staged.name, stamp));
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(staged.path, dest);
      list.push(staged.name);
      if (staged.digest !== null) recordDigest(receipt, staged.bucket, staged.name, staged.digest);
      await writeReceipt(receipt);
    }
    // Old copies the new generation no longer has.
    if (old && !receipt.copiesApplied) {
      for (const bucket of ['skills', 'designSystems'] as const) {
        const carried = new Set(journal.stagedCopies.filter((staged) => staged.bucket === bucket).map((staged) => staged.name));
        for (const name of old.copied[bucket]) {
          if (!CHILD_RE.test(name) || carried.has(name)) continue;
          keep(await retireCopy(old, bucket, name, stamp));
        }
      }
    }
    receipt.copiesApplied = true;
    await writeReceipt(receipt);

    // 4. MCP entries: the old generation's (unchanged ones) go, the new one's are added. Once.
    if (!receipt.mcpApplied) {
      try {
        if (old) await unseedPackMcpServers(options.dataDir, old.seededMcp);
      } catch {
        receipt.warnings.push('the earlier version\'s MCP servers were not removed because the MCP settings file could not be updated');
      }
      if ((pack.manifest.provides.mcpServers?.length ?? 0) > 0) await seedMcp(pack, receipt);
      receipt.mcpApplied = true;
      await writeReceipt(receipt);
    }

    // 5. Saved projects: imported once, never removed.
    await importProjects(pack, receipt);
    await writeReceipt(receipt);

    // 6. Cleanup. A failure here is retried at the next start; the new generation stays.
    let cleanupFailed = false;
    try {
      await step('cleanup', journal.packId);
      await fsp.rm(journal.previousTree, { recursive: true, force: true });
      for (const dir of journal.stagingDirs) await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(journalFile(journal.token), { force: true });
      await removeEmptyWorkDirs();
    } catch {
      cleanupFailed = true;
      console.warn(`[mish-packs] ${journal.packId}: the old version could not be deleted yet; it is retried at the next start`);
    }
    return { pack, receipt, cleanupFailed };
  }

  /** Start: finishes committed installs and discards ones that never reached the commit. Idempotent. */
  async function recoverInterrupted(): Promise<Set<string>> {
    const unfinished = new Set<string>();
    let names: string[];
    try {
      names = (await fsp.readdir(journalRoot)).filter((name) => name.endsWith('.json'));
    } catch {
      return unfinished;
    }
    for (const name of names) {
      let journal: unknown;
      try {
        journal = JSON.parse(await fsp.readFile(path.join(journalRoot, name), 'utf8'));
      } catch {
        journal = null;
      }
      if (!isJournal(journal)) {
        console.warn(`[mish-packs] an unreadable install journal was left in place: ${name}`);
        continue;
      }
      try {
        if (journal.phase === 'preparing') {
          await discardPrepared(journal);
          console.warn(`[mish-packs] ${journal.packId}: an install that did not finish was discarded; the installed version is unchanged`);
        } else {
          const { cleanupFailed } = await finish(journal, []);
          if (cleanupFailed) unfinished.add(journal.packId);
          console.warn(`[mish-packs] ${journal.packId}: an interrupted install was finished`);
        }
      } catch {
        unfinished.add(journal.packId);
        console.warn(`[mish-packs] ${journal.packId}: an interrupted install could not be finished yet; it is retried at the next start`);
      }
    }
    return unfinished;
  }

  /** Removes work folders no journal refers to (left by a crash before a journal was written). */
  async function removeStrayWorkDirs(): Promise<void> {
    const referenced = new Set<string>();
    try {
      for (const name of await fsp.readdir(journalRoot)) referenced.add(name.replace(/\.json$/u, ''));
    } catch {
      // no journals
    }
    for (const dir of [incomingRoot, previousRoot, ...userRoots().map((userRoot) => path.join(userRoot, STAGING_DIRNAME))]) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) if (!referenced.has(entry)) await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
    }
    await removeEmptyWorkDirs();
  }

  /** An install of `packId` that is committed but not finished: finished now, or refused. */
  async function finishPending(packId: string): Promise<void> {
    let names: string[];
    try {
      names = (await fsp.readdir(journalRoot)).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      let journal: unknown;
      try {
        journal = JSON.parse(await fsp.readFile(path.join(journalRoot, name), 'utf8'));
      } catch {
        continue;
      }
      if (!isJournal(journal) || journal.packId !== packId) continue;
      if (journal.phase === 'preparing') await discardPrepared(journal);
      else await finish(journal, []);
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

  /** Brings the staged pack in: prepare, commit, finish (see the top of this file). */
  async function installStaged(packRoot: string, manifest: MishPackManifest): Promise<MishPackStoreInstallResult> {
    // A committed install of the same pack that has not finished goes first.
    await finishPending(manifest.id);
    const token = randomUUID();
    const final = path.join(root, manifest.id);
    const replaced = await exists(final);
    const journal: Journal = {
      token,
      packId: manifest.id,
      version: manifest.version,
      phase: 'preparing',
      incomingTree: path.join(incomingRoot, token),
      previousTree: path.join(previousRoot, token),
      stagingDirs: userRoots().map((userRoot) => path.join(userRoot, STAGING_DIRNAME, token)),
      stagedCopies: [],
      oldReceipt: replaced ? await readReceipt(manifest.id) : null,
      mcpBefore: await readMcpText(),
      warnings: [],
    };
    await writeJournal(journal);
    try {
      await fsp.mkdir(incomingRoot, { recursive: true });
      await fsp.rename(packRoot, journal.incomingTree);
      await stageCopies({ id: manifest.id, root: journal.incomingTree, manifest, origin: 'installed' }, journal);
      await writeJournal(journal);
      await step('staged', manifest.id);
    } catch (error) {
      await discardPrepared(journal).catch(() => {
        console.warn(`[mish-packs] ${manifest.id}: what the failed install staged could not be deleted yet; it is retried at the next start`);
      });
      throw error;
    }

    // The commit point. From here on the install only moves forward.
    journal.phase = 'committed';
    await writeJournal(journal);
    const backups: MishPackBackup[] = [];
    let finished;
    try {
      finished = await finish(journal, backups);
    } catch {
      reload();
      throw new MishPackError('INTERNAL_ERROR', 'the pack is installed but did not finish activating; it finishes when the app starts again');
    }
    const { pack, receipt, cleanupFailed } = finished;
    if (cleanupFailed) {
      receipt.warnings.push('the earlier version could not be deleted yet; it is deleted when the app starts again');
      await writeReceipt(receipt);
    }
    return { pack: await summarize(pack, receipt), replaced, backups };
  }

  return {
    isBusy: () => busy,

    async start() {
      await fsp.mkdir(root, { recursive: true });
      configureMishPacks({ dataDir: options.dataDir, externalDir: options.externalDir ?? null });
      const unfinished = await recoverInterrupted();
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      await fsp.rm(trashRoot, { recursive: true, force: true });
      await removeStrayWorkDirs();
      const packs = reload();
      for (const pack of packs) {
        // A pack whose install is still finishing is left to that install.
        if (unfinished.has(pack.id)) continue;
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
          return await installStaged(packRoot, manifest);
        } finally {
          await fsp.rm(staging, { recursive: true, force: true });
        }
      });
    },

    remove(id: string) {
      return withLock(async () => {
        if (!ID_RE.test(id)) throw new MishPackError('NOT_FOUND', 'no installed pack has that id');
        await finishPending(id);
        const final = path.join(root, id);
        if (!(await exists(final))) {
          const external = activeMishPacks().find((pack) => pack.id === id && pack.origin === 'external');
          if (external) throw new MishPackError('READ_ONLY', 'this pack comes from MISH_PACKS_DIR; remove it from that folder');
          throw new MishPackError('NOT_FOUND', 'no installed pack has that id');
        }
        const { backups, keptProjects } = await deactivate(id);
        await fsp.mkdir(trashRoot, { recursive: true });
        await fsp.rename(final, path.join(trashRoot, randomUUID()));
        await fsp.rm(trashRoot, { recursive: true, force: true });
        reload();
        return { removed: id, backups, ...(keptProjects.length > 0 ? { keptProjects } : {}) };
      });
    },
  };
}
