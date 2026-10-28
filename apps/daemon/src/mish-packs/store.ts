// Mish packs: install, list and remove.
//
// Layout under `<dataDir>/mish-packs/`:
//   <id>/                    an installed pack (its `mish-pack.json` and every file it provides)
//   .receipts/<id>.json      what activation did outside the pack folder (copied folders, projects, MCP entries)
//   .journal/<token>.json    an install that has not finished (see "Installing" below)
//   .incoming/<token>/       the new pack tree of that install
//   .previous/<token>/       the old pack tree a committed install is about to delete
//   .mcp-intent/<id>.json    an in-place MCP update about to be made (see `reseedMcp`)
//   .staging/, .trash/       work areas; leftovers are removed on the next start
//
// Resources the daemon reads in place (catalogues, kits, assets, design profiles) are not copied:
// the overlay reads them from the pack folder. Folders that scanners expect inside a user root
// (skills, design systems, studies) are copied there; the receipt records exactly which folders the
// pack added so nothing else is touched, and a digest of each as placed. On remove or a new
// version, a copy is first moved, in one rename, to `<user root>/.mish-pack-retiring/<id>-<time>/`
// and only then compared with that digest: a changed one (the user edited it) is moved to
// `<user root>/.mish-pack-backups/<id>-<time>/<name>` and the result names it; an unchanged one
// waits in `<user root>/.mish-pack-retired/` and is compared again, and deleted, at the first start
// a day or more later. Nothing is hashed and then deleted at once. A receipt without digests
// (written before they existed) backs up every copy.
//
// A pack never takes over a copy another pack placed: that copy is left to its owner and the
// warning names it. After an install or a removal the other packs are activated again, and a pack
// that provides a folder nobody has now places it. So when the parts of a split module
// (`build-pack --split`) trade folders between versions, nothing one part still provides is lost.
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
// a crash after the commit is finished by the next start and is never rolled back. While any pack
// has an install that is not fully settled, every new install or removal settles it first.
//
// The start never deletes a work folder it cannot match to a journal; it leaves it in place and
// says so in the log.

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
import type { McpServerConfig } from '../mcp-config.js';
import { readMcpConfig } from '../mcp-config.js';
import { packServerToConfig, restorePackMcpServers, seedPackMcpServers, unseedPackMcpServers, type SeededMcpServer } from './mcp.js';
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
export type MishPackInstallStep = 'staged' | 'committed' | 'swapped' | 'mcp-unseeded' | 'mcp-written' | 'cleanup';

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
  /** Test seam: runs when a copy being retired has been moved aside, before it is compared. */
  onRetireHeld?: (held: string, original: string) => void | Promise<void>;
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

/** An in-place MCP update about to be made (`.mcp-intent/<id>.json`). */
interface McpIntent {
  /** The version the update is for. */
  to: string;
  /** Ids the person had in the MCP settings before the first attempt. */
  theirs: string[];
  /** Configs the attempt adds (and ones an earlier attempt it continues had added). */
  add: McpServerConfig[];
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
  /**
   * Ids the person had in the MCP settings before the install, other than the old generation's own
   * entries (null when the file could not be read: nothing is then claimed). Ids only, no values.
   */
  mcpTheirs?: string[] | null;
  /**
   * Ids of the old generation's entries that were in the MCP settings, unchanged, before the
   * install (null when the file could not be read). A failed MCP change puts back only these, never
   * an entry the person had already deleted.
   */
  mcpOldPresent?: string[] | null;
  /**
   * The MCP change this install makes, written before the MCP settings are touched: the entries
   * the old generation owns (removed) and the ones the new generation will own (added). A retry
   * uses it to take ownership of entries an earlier attempt wrote but did not record.
   */
  mcpIntent?: { remove: SeededMcpServer[]; add: McpServerConfig[] };
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
const RETIRING_DIRNAME = '.mish-pack-retiring';
const RETIRED_DIRNAME = '.mish-pack-retired';
/** In each `.mish-pack-retired/<id>-<stamp>/`: the digest each folder there had when it was set aside. */
const RETIRED_DIGESTS = '.digests.json';
/** How long an unchanged retired copy waits before it is deleted, so a late editor save lands in it first. */
const RETIRED_GRACE_MS = 24 * 60 * 60 * 1000;
/** `backupStamp` at the end of a `<id>-<stamp>` folder name, with the `-<n>` a taken name gets. */
const STAMP_RE = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?$/u;

// Warnings about a step that is retried. Each is taken away once that step succeeds.
const WARN_MCP_RETRY = 'MCP servers were not added because the MCP settings file could not be updated; the earlier ones were kept, and the app tries again when it starts';
const WARN_CLEANUP_RETRY = 'the earlier version could not be deleted yet; it is deleted when the app starts again';
const WARN_DB_CLOSED = 'the saved projects were not added because the project database is not open; they are added on the next start';
const PROJECT_RETRY_RE = /^projects\/[^ ]+ could not be added to the project list; it is tried again when the app starts$/u;

function dropWarnings(receipt: Receipt, drop: (text: string) => boolean): void {
  receipt.warnings = receipt.warnings.filter((text) => !drop(text));
}

/** A user-root name as the file system may compare it: without case, in one Unicode form. */
function fold(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Whether `list` has `name`, compared as the file system may (see `fold`). */
function hasName(list: readonly string[], name: string): boolean {
  return list.some((entry) => fold(entry) === fold(name));
}

/** The time in a `<id>-<stamp>` folder name, or null. */
function stampTime(name: string): number | null {
  const match = STAMP_RE.exec(name);
  if (!match) return null;
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * A copy left alone because it is in the way, named in a warning; the pack places it once it is
 * free. `label` is `<bucket>/<name>`, so a study and a design system of one name share it. The
 * receipt's earlier warning about that name goes first, so it never names an owner twice or one
 * that is gone.
 */
function noteCollision(receipt: Receipt, label: string, owner: string | null): void {
  dropCollision(receipt, [label]);
  receipt.warnings.push(collisionWarning(label, owner));
}

function collisionWarning(label: string, owner: string | null): string {
  return owner
    ? `${label} is provided by the pack ${owner} too, which placed it first; it was left as it is`
    : `${label} already exists and was left as it is`;
}

/** Drops the collision warnings about `name` once the pack has placed it. */
function dropCollision(receipt: Receipt, labels: readonly string[]): void {
  dropWarnings(receipt, (text) => text.endsWith('left as it is') && labels.some((label) => text.startsWith(`${label} `)));
}

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
  return {
    id: pack.id,
    version: pack.manifest.version,
    installedAt: now.toISOString(),
    copied: { skills: [], designSystems: [] },
    seededMcp: [],
    projects: [],
    warnings: [],
  };
}

/** Digests a new version's receipt starts from: empty for a first install, none from a receipt that predates them. */
function carriedDigests(previous: Receipt | null): Pick<Receipt, 'digests'> {
  if (!previous) return { digests: { skills: {}, designSystems: {} } };
  return previous.digests ? { digests: previous.digests } : {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && CHILD_RE.test(name));
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
  const mcpIntentRoot = path.join(root, '.mcp-intent');
  const step = async (name: MishPackInstallStep, packId: string) => options.onInstallStep?.(name, packId);
  let busy = false;

  const receiptFile = (id: string) => path.join(receiptsRoot, `${id}.json`);
  const journalFile = (token: string) => path.join(journalRoot, `${token}.json`);
  const bucketRoot = (bucket: CopyBucket) => (bucket === 'skills' ? options.userRoots.skills : options.userRoots.designSystems);
  const projectDb = () => (options.projectsDir ? options.db?.() ?? null : null);
  const userRoots = () => [...new Set([options.userRoots.skills, options.userRoots.designSystems])];

  /**
   * A journal is only trusted when every path in it is the one this build would derive from its id
   * and token: recovery deletes and renames those paths, so a damaged or planted journal must not
   * be able to name anything else.
   */
  function validJournal(value: unknown): value is Journal {
    const journal = value as Partial<Journal> | null;
    if (!journal || typeof journal.token !== 'string' || typeof journal.packId !== 'string') return false;
    if (journal.phase !== 'preparing' && journal.phase !== 'committed') return false;
    if (!UUID_RE.test(journal.token) || !ID_RE.test(journal.packId)) return false;
    if (journal.incomingTree !== path.join(incomingRoot, journal.token) || journal.previousTree !== path.join(previousRoot, journal.token)) return false;
    const stagingDirs = userRoots().map((userRoot) => path.join(userRoot, STAGING_DIRNAME, journal.token as string));
    if (!Array.isArray(journal.stagingDirs) || journal.stagingDirs.join('\n') !== stagingDirs.join('\n')) return false;
    if (!Array.isArray(journal.warnings) || !Array.isArray(journal.stagedCopies)) return false;
    for (const staged of journal.stagedCopies as Array<Partial<StagedCopy> | null>) {
      if (!staged || (staged.bucket !== 'skills' && staged.bucket !== 'designSystems')) return false;
      if (typeof staged.name !== 'string' || !CHILD_RE.test(staged.name)) return false;
      if (staged.path !== path.join(bucketRoot(staged.bucket), STAGING_DIRNAME, journal.token, staged.name)) return false;
    }
    const old = journal.oldReceipt as Partial<Receipt> | null | undefined;
    if (old === null || old === undefined) return true;
    return old.id === journal.packId && Array.isArray(old.seededMcp) && !!old.copied
      && isNameList(old.copied.skills) && isNameList(old.copied.designSystems);
  }

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

  const writeReceipt = (receipt: Receipt) => {
    receipt.warnings = [...new Set(receipt.warnings)];
    return writeJson(receiptFile(receipt.id), receipt);
  };
  const writeJournal = (journal: Journal) => writeJson(journalFile(journal.token), journal);

  /**
   * Splits the ids in the MCP settings into the person's own and the old generation's unchanged
   * entries. Both null when the file cannot be read.
   */
  async function mcpOwnership(oldOwned: readonly SeededMcpServer[]): Promise<{ theirs: string[] | null; oldPresent: string[] | null }> {
    try {
      const servers = (await readMcpConfig(options.dataDir)).servers;
      const isOld = (server: McpServerConfig) => oldOwned.some((entry) => entry.id === server.id && JSON.stringify(entry.config) === JSON.stringify(server));
      return {
        theirs: servers.filter((server) => !isOld(server)).map((server) => server.id),
        oldPresent: servers.filter(isOld).map((server) => server.id),
      };
    } catch {
      return { theirs: null, oldPresent: null };
    }
  }

  async function allReceipts(): Promise<Receipt[]> {
    let names: string[];
    try {
      names = (await fsp.readdir(receiptsRoot)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Receipt[] = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!ID_RE.test(id)) continue;
      const receipt = await readReceipt(id);
      if (receipt) out.push(receipt);
    }
    return out;
  }

  /** The id of another pack whose receipt lists `bucket/name`, if one does. Read only. */
  async function otherOwner(packId: string, bucket: CopyBucket, name: string): Promise<string | null> {
    const owner = (await allReceipts()).find((other) => other.id !== packId && isNameList(other.copied[bucket]) && hasName(other.copied[bucket], name));
    return owner?.id ?? null;
  }

  /** Adds `bucket/name` to the pack's receipt on disk, when it has one. */
  async function recordPlacement(packId: string, bucket: CopyBucket, name: string): Promise<void> {
    const onDisk = await readReceipt(packId);
    if (!onDisk || !isNameList(onDisk.copied[bucket]) || hasName(onDisk.copied[bucket], name)) return;
    onDisk.copied[bucket] = [...onDisk.copied[bucket], name];
    await writeReceipt(onDisk);
  }

  /** Ids of packs with an install journal: those are left to that install. */
  async function journalPackIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let names: string[];
    try {
      names = (await fsp.readdir(journalRoot)).filter((name) => name.endsWith('.json'));
    } catch {
      return ids;
    }
    for (const name of names) {
      try {
        const journal = JSON.parse(await fsp.readFile(path.join(journalRoot, name), 'utf8')) as unknown;
        if (validJournal(journal)) ids.add(journal.packId);
      } catch {
        // an unreadable journal names no pack
      }
    }
    return ids;
  }

  /** A free path `intoDir/<name>` (or `<name>-2`, ...), creating `intoDir`. */
  async function freeTarget(intoDir: string, name: string): Promise<string> {
    await fsp.mkdir(intoDir, { recursive: true });
    let target = path.join(intoDir, name);
    for (let n = 2; await exists(target); n += 1) target = path.join(intoDir, `${name}-${n}`);
    return target;
  }

  /** Moves `dir` into `intoDir/<name>` (a free name), creating `intoDir`. */
  async function moveInto(dir: string, intoDir: string, name: string): Promise<string> {
    const target = await freeTarget(intoDir, name);
    await fsp.rename(dir, target);
    return target;
  }

  async function readRetiredDigests(file: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      return {};
    }
  }

  /**
   * Takes away a folder this pack copied. It is first moved out of the scanned root in one rename
   * (`<root>/.mish-pack-retiring/<packId>-<stamp>/<name>`), then the moved copy is compared with the
   * digest recorded at install: changed, it is moved to `<root>/.mish-pack-backups/<packId>-<stamp>/<name>`;
   * unchanged, it is moved to `<root>/.mish-pack-retired/<packId>-<stamp>/<name>` and deleted at the
   * next start, after a second comparison (`pruneRetired`). It is never deleted right after the
   * comparison, so an edit an open editor saves between the two is not lost. An edit saved while
   * this runs ends up in the backup, the retired folder or the old path, which is not touched
   * again. Returns the backup, or null when the folder was set aside unchanged or is already gone.
   */
  async function retireCopy(receipt: Receipt, bucket: CopyBucket, name: string, stamp: string): Promise<MishPackBackup | null> {
    const destRoot = bucketRoot(bucket);
    const dest = path.join(destRoot, name);
    if (!(await exists(dest))) return null;
    const holdDir = path.join(destRoot, RETIRING_DIRNAME, `${receipt.id}-${stamp}`);
    const held = await moveInto(dest, holdDir, name);
    await options.onRetireHeld?.(held, dest);
    const recorded = recordedDigest(receipt, bucket, name);
    let backup: MishPackBackup | null = null;
    if (recorded !== undefined && (await folderDigest(held)) === recorded) {
      const retiredDir = path.join(destRoot, RETIRED_DIRNAME, `${receipt.id}-${stamp}`);
      const digestsFile = path.join(retiredDir, RETIRED_DIGESTS);
      const digests = await readRetiredDigests(digestsFile);
      // The digest is written first: a folder there without one is kept as a backup, never deleted.
      const target = await freeTarget(retiredDir, name);
      await writeJson(digestsFile, { ...digests, [path.basename(target)]: recorded });
      await fsp.rename(held, target);
    } else {
      backup = { resource: bucket, name, path: await moveInto(held, path.join(destRoot, BACKUP_DIRNAME, `${receipt.id}-${stamp}`), name) };
    }
    await fsp.rmdir(holdDir).catch(() => undefined);
    await fsp.rmdir(path.join(destRoot, RETIRING_DIRNAME)).catch(() => undefined);
    return backup;
  }

  /**
   * Copies the pack's skill, design-system and study folders into the user roots. Idempotent. On a
   * new version (`refresh`) the copies are replaced and the ones the new version no longer has are
   * taken away; a copy the user changed is moved aside, never deleted.
   */
  async function copyIntoUserRoots(pack: ActiveMishPack, receipt: Receipt, refresh: boolean, backups: MishPackBackup[]): Promise<void> {
    const stamp = backupStamp(now());
    const keep = (backup: MishPackBackup | null) => {
      if (!backup) return;
      backups.push(backup);
      receipt.warnings.push(backupWarning(backup));
    };
    const provided = new Set<string>();
    for (const { key, bucket } of COPY_TARGETS) {
      const source = packResourcePath(pack, key);
      if (!source) continue;
      const destRoot = bucketRoot(bucket);
      const list = receipt.copied[bucket];
      await fsp.mkdir(destRoot, { recursive: true });
      for (const child of await childDirs(source)) {
        // A study and a design system of one name land in the same root: the first one is used.
        if (provided.has(`${bucket}/${fold(child)}`)) {
          receipt.warnings.push(`${key}/${child} is provided twice by the pack; the first one is used`);
          continue;
        }
        provided.add(`${bucket}/${fold(child)}`);
        const dest = path.join(destRoot, child);
        const mine = hasName(list, child);
        if (await exists(dest)) {
          if (!mine) {
            noteCollision(receipt, `${bucket}/${child}`, await otherOwner(receipt.id, bucket, child));
            continue;
          }
          // Already copied by this pack at this version: a restart does not copy it again.
          if (!refresh) continue;
          keep(await retireCopy(receipt, bucket, child, stamp));
        } else if (!mine) {
          // Claimed on disk before it is placed: a crash before the receipt below is written leaves
          // a folder this pack owns (and backs up rather than deletes, having no digest for it).
          await recordPlacement(receipt.id, bucket, child);
        }
        // Built in the staging folder, which the scanners do not read, then renamed into place.
        const tmpDir = path.join(destRoot, STAGING_DIRNAME, `copy-${randomUUID()}`);
        const tmp = path.join(tmpDir, child);
        let digest: string | null;
        try {
          await copyTreeNoLinks(path.join(source, child), tmp);
          digest = await folderDigest(tmp);
          await fsp.rename(tmp, dest);
        } finally {
          await fsp.rm(tmpDir, { recursive: true, force: true });
          await fsp.rmdir(path.join(destRoot, STAGING_DIRNAME)).catch(() => undefined);
        }
        if (!mine) list.push(child);
        if (digest !== null) recordDigest(receipt, bucket, child, digest);
        dropCollision(receipt, [`${key}/${child}`, `${bucket}/${child}`]);
      }
    }
    if (!refresh) return;
    // Copies of the earlier version that this one no longer has.
    for (const bucket of ['skills', 'designSystems'] as const) {
      for (const name of [...receipt.copied[bucket]]) {
        if (provided.has(`${bucket}/${fold(name)}`)) continue;
        if (CHILD_RE.test(name)) keep(await retireCopy(receipt, bucket, name, stamp));
        receipt.copied[bucket] = receipt.copied[bucket].filter((entry) => entry !== name);
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
      receipt.warnings.push(WARN_DB_CLOSED);
      return;
    }
    const projectsDir = options.projectsDir;
    // This attempt says again what still has to wait.
    dropWarnings(receipt, (text) => text === WARN_DB_CLOSED || PROJECT_RETRY_RE.test(text));
    const mine = new Set(receiptProjects(receipt));
    // A project another pack imported is known already (the parts of a split module trade
    // projects between versions). It is listed here too, which is harmless because packs never
    // delete projects, so one the person deleted stays deleted whichever pack is removed first.
    const others = new Set((await allReceipts()).filter((other) => other.id !== receipt.id).flatMap((other) => receiptProjects(other)));
    const existing: string[] = [];
    // A project keeps its design system only when this pack placed that design system, or provides
    // it and another pack placed it first (the same folder, as with the parts of a split module).
    const packDesignSystems = new Set(receipt.copied.designSystems);
    const placedByOthers = new Set((await allReceipts()).filter((other) => other.id !== receipt.id).flatMap((other) => (isNameList(other.copied.designSystems) ? other.copied.designSystems : [])));
    for (const key of ['designSystems', 'studies'] as const) {
      const dir = packResourcePath(pack, key);
      if (!dir) continue;
      for (const name of await childDirs(dir)) if (placedByOthers.has(name)) packDesignSystems.add(name);
    }
    let droppedLinks = 0;
    let droppedOther = 0;
    let failedInserts = 0;
    await fsp.mkdir(projectsDir, { recursive: true });
    for (const packRow of await readPackProjectRows(source)) {
      if (mine.has(packRow.id)) continue;
      if (others.has(packRow.id)) {
        mine.add(packRow.id);
        continue;
      }
      const prepared = prepareProjectRow(packRow, packDesignSystems);
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
      // A resumed import owns the folder it staged before the crash.
      let created = resuming;
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
          // The folder goes only when no row names it: a row that exists owns its folder.
          if (created && !projectRowExists(db, row.id)) await fsp.rm(dest, { recursive: true, force: true });
          receipt.importing = null;
          receipt.projectsPending = true;
          failedInserts += 1;
          receipt.warnings.push(`projects/${row.id} could not be added to the project list; it is tried again when the app starts`);
          await writeReceipt(receipt);
          continue;
        }
      }
      if (prepared.dropped.includes('linkedDirs')) droppedLinks += 1;
      if (prepared.dropped.some((key) => key !== 'linkedDirs')) droppedOther += 1;
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
    if (droppedOther > 0) receipt.warnings.push(`${droppedOther} saved project(s) were added without settings tied to the computer they came from (design system, picker or workspace links)`);
    receipt.projects = [...mine];
    receipt.projectsPending = failedInserts > 0;
  }

  /**
   * Of the entries `seedPackMcpServers` skipped because the id was taken, the ones an earlier
   * attempt of this change wrote but did not record: exactly the planned config, under an id the
   * person did not have before (`theirs`; null when that is unknown, and nothing is claimed). The
   * others are named in a warning.
   */
  async function claimSkipped(skipped: readonly string[], planned: readonly McpServerConfig[], theirs: readonly string[] | null, receipt: Receipt): Promise<SeededMcpServer[]> {
    const before = theirs ? new Set(theirs) : null;
    const current = skipped.length > 0 ? (await readMcpConfig(options.dataDir)).servers : [];
    const claimed: SeededMcpServer[] = [];
    for (const id of skipped) {
      const config = planned.find((entry) => entry.id === id);
      const present = current.find((server) => server.id === id);
      if (config && present && before && !before.has(id) && JSON.stringify(config) === JSON.stringify(present)) claimed.push({ id, config });
      else receipt.warnings.push(`MCP server ${id} already exists and was left as it is`);
    }
    return claimed;
  }

  /** What an in-place update of the MCP entries is about to do (see `reseedMcp`). */
  const mcpIntentFile = (packId: string) => path.join(mcpIntentRoot, `${packId}.json`);

  async function readMcpIntent(packId: string): Promise<McpIntent | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(mcpIntentFile(packId), 'utf8')) as Partial<McpIntent> | null;
      if (!parsed || typeof parsed.to !== 'string' || !Array.isArray(parsed.theirs) || !Array.isArray(parsed.add)) return null;
      if (!parsed.theirs.every((id) => typeof id === 'string')) return null;
      if (!parsed.add.every((config) => !!config && typeof config === 'object' && typeof (config as { id?: unknown }).id === 'string')) return null;
      return parsed as McpIntent;
    } catch {
      return null;
    }
  }

  async function clearMcpIntent(packId: string): Promise<void> {
    await fsp.rm(mcpIntentFile(packId), { force: true });
    await fsp.rmdir(mcpIntentRoot).catch(() => undefined);
  }

  /**
   * A new version of a pack activated in place: the earlier version's entries (the unchanged ones)
   * go and the new version's are added, so a changed config is updated. Before the settings are
   * touched, the ids the person had and the configs this attempt adds are written down with the
   * version they are for. An attempt cut short before its receipt was written is found by the next
   * one, which takes away what it wrote (exactly those configs, under ids the person did not have)
   * before it adds its own, whatever version it is for now. An intent for the version the receipt
   * already has is left over from an attempt that finished and is not used (`settledVersion`; null
   * when retrying the receipt's own version). A failure puts back what this call took away, keeps
   * the earlier entries recorded as the pack's, and is retried at the next start.
   */
  async function reseedMcp(pack: ActiveMishPack, receipt: Receipt, previous: readonly SeededMcpServer[], settledVersion: string | null): Promise<void> {
    const servers = pack.manifest.provides.mcpServers ?? [];
    const planned = servers.map((server) => packServerToConfig(server)).filter((config): config is McpServerConfig => config !== null);
    let removed: string[] = [];
    try {
      const found = await readMcpIntent(pack.id);
      const attempt = found && found.to !== settledVersion ? found : null;
      const theirs = attempt ? attempt.theirs : (await mcpOwnership(previous)).theirs;
      const written: SeededMcpServer[] = attempt
        ? attempt.add.filter((config) => !attempt.theirs.includes(config.id)).map((config) => ({ id: config.id, config }))
        : [];
      if (theirs !== null) await writeJson(mcpIntentFile(pack.id), { to: pack.manifest.version, theirs, add: [...written.map((entry) => entry.config), ...planned] } satisfies McpIntent);
      removed = await unseedPackMcpServers(options.dataDir, [...previous, ...written]);
      const { seeded, skipped } = await seedPackMcpServers(options.dataDir, servers);
      receipt.seededMcp = seeded;
      for (const id of skipped) receipt.warnings.push(`MCP server ${id} already exists and was left as it is`);
      receipt.mcpApplied = true;
      dropWarnings(receipt, (text) => text === WARN_MCP_RETRY);
    } catch {
      // An unreadable MCP file must not undo the rest of the update; say so and try again later.
      const taken = new Set(removed);
      await restorePackMcpServers(options.dataDir, previous.filter((entry) => taken.has(entry.id)).map((entry) => entry.config)).catch(() => []);
      receipt.seededMcp = [...previous];
      receipt.mcpApplied = false;
      receipt.warnings.push(WARN_MCP_RETRY);
    }
  }

  /**
   * Boot activation of a pack that is already in place (an installed pack after a restart, or a
   * pack in MISH_PACKS_DIR). MCP entries are seeded and projects imported only on a new version.
   */
  async function activate(pack: ActiveMishPack): Promise<{ receipt: Receipt; backups: MishPackBackup[] }> {
    const previous = await readReceipt(pack.id);
    const receipt: Receipt = previous && previous.version === pack.manifest.version
      ? { ...previous }
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
    const previousMcp = previous?.seededMcp ?? [];
    const hasMcp = (pack.manifest.provides.mcpServers?.length ?? 0) > 0 || previousMcp.length > 0;
    if (isNewVersion && hasMcp) await reseedMcp(pack, receipt, previousMcp, previous?.version ?? null);
    else if (receipt.mcpApplied === false) await reseedMcp(pack, receipt, previousMcp, null);
    if (isNewVersion || receipt.projectsPending || receipt.importing) await importProjects(pack, receipt);
    await writeReceipt(receipt);
    if (receipt.mcpApplied !== false) await clearMcpIntent(pack.id);
    return { receipt, backups };
  }

  /**
   * After an install or a removal, the other packs are activated again, so one that provides a
   * folder nobody has now places it (see the top of this file). A failure is logged; the next
   * start tries again.
   */
  async function reactivateOthers(packId: string): Promise<void> {
    const pending = await journalPackIds();
    for (const pack of activeMishPacks()) {
      if (pack.id === packId || pending.has(pack.id)) continue;
      try {
        await activate(pack);
      } catch (error) {
        console.warn(`[mish-packs] ${pack.id}: activation failed (${(error as { code?: string }).code ?? 'error'})`);
      }
    }
  }

  /**
   * Removal: MCP entries and copies go, projects stay. Returns the copies that were moved aside
   * because the user changed them, and the projects kept.
   */
  async function deactivate(id: string): Promise<{ backups: MishPackBackup[]; keptProjects: string[] }> {
    const receipt = await readReceipt(id);
    if (!receipt) return { backups: [], keptProjects: [] };
    try {
      await unseedPackMcpServers(options.dataDir, receipt.seededMcp);
    } catch {
      console.warn(`[mish-packs] ${id}: its MCP servers were left in the MCP settings because that file could not be updated`);
    }
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
    await clearMcpIntent(id);
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
        if (staged.has(`${bucket}/${fold(child)}`)) {
          journal.warnings.push(`${key}/${child} is provided twice by the pack; the first one is used`);
          continue;
        }
        staged.add(`${bucket}/${fold(child)}`);
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
  async function finish(journal: Journal, backups: MishPackBackup[]): Promise<{ pack: ActiveMishPack; receipt: Receipt; settled: boolean }> {
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
      if (hasName(list, staged.name)) continue;
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
        // The old generation's copy is replaced; anything else is another pack's or the person's.
        const owner = await otherOwner(receipt.id, staged.bucket, staged.name);
        if (!old || !hasName(old.copied[staged.bucket], staged.name) || owner) {
          noteCollision(receipt, `${staged.bucket}/${staged.name}`, owner);
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
        const carried = new Set(journal.stagedCopies.filter((staged) => staged.bucket === bucket).map((staged) => fold(staged.name)));
        for (const name of old.copied[bucket]) {
          if (!CHILD_RE.test(name) || carried.has(fold(name))) continue;
          // Placed by another pack since (a folder the old generation had let go): not this one's.
          if (await otherOwner(receipt.id, bucket, name)) continue;
          keep(await retireCopy(old, bucket, name, stamp));
        }
      }
    }
    receipt.copiesApplied = true;
    await writeReceipt(receipt);

    // 4. MCP entries: the old generation's (unchanged ones) go, the new one's are added. The intent
    //    is in the journal before the settings change; a failure puts the old entries back, keeps
    //    the journal and is retried at the next start.
    let mcpFailed = false;
    if (!receipt.mcpApplied) {
      const servers = pack.manifest.provides.mcpServers ?? [];
      if (!journal.mcpIntent) {
        const add = servers.map((server) => packServerToConfig(server)).filter((config): config is McpServerConfig => config !== null);
        journal.mcpIntent = { remove: old?.seededMcp ?? [], add };
        await writeJournal(journal);
      }
      const intent = journal.mcpIntent;
      try {
        if (intent.remove.length > 0) await unseedPackMcpServers(options.dataDir, intent.remove);
        await step('mcp-unseeded', journal.packId);
        const { seeded, skipped } = servers.length > 0 ? await seedPackMcpServers(options.dataDir, servers) : { seeded: [], skipped: [] };
        await step('mcp-written', journal.packId);
        receipt.seededMcp = [...seeded, ...(await claimSkipped(skipped, intent.add, journal.mcpTheirs ?? null, receipt))];
        receipt.mcpApplied = true;
        dropWarnings(receipt, (text) => text === WARN_MCP_RETRY);
        await writeReceipt(receipt);
      } catch {
        mcpFailed = true;
        // Only entries that were in the settings before the install go back: one the person
        // deleted earlier stays deleted. Unknown (the file was unreadable then): none.
        const present = new Set(journal.mcpOldPresent ?? []);
        await restorePackMcpServers(options.dataDir, intent.remove.filter((entry) => present.has(entry.id)).map((entry) => entry.config)).catch(() => []);
        receipt.warnings.push(WARN_MCP_RETRY);
        await writeReceipt(receipt);
      }
    }

    // 5. Saved projects: imported once, never removed.
    await importProjects(pack, receipt);
    await writeReceipt(receipt);

    // 6. Cleanup, only once everything above is done. A failure here is retried at the next start;
    //    the new generation stays.
    if (mcpFailed) return { pack, receipt, settled: false };
    try {
      await step('cleanup', journal.packId);
      await fsp.rm(journal.previousTree, { recursive: true, force: true });
      for (const dir of journal.stagingDirs) await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(journalFile(journal.token), { force: true });
      await removeEmptyWorkDirs();
    } catch {
      receipt.warnings.push(WARN_CLEANUP_RETRY);
      await writeReceipt(receipt);
      console.warn(`[mish-packs] ${journal.packId}: the old version could not be deleted yet; it is retried at the next start`);
      return { pack, receipt, settled: false };
    }
    if (receipt.warnings.includes(WARN_CLEANUP_RETRY)) {
      dropWarnings(receipt, (text) => text === WARN_CLEANUP_RETRY);
      await writeReceipt(receipt);
    }
    return { pack, receipt, settled: true };
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
      if (!validJournal(journal)) {
        console.warn(`[mish-packs] an unreadable install journal was left in place: ${name}`);
        continue;
      }
      try {
        if (journal.phase === 'preparing') {
          await discardPrepared(journal);
          console.warn(`[mish-packs] ${journal.packId}: an install that did not finish was discarded; the installed version is unchanged`);
        } else {
          const { settled } = await finish(journal, []);
          if (!settled) unfinished.add(journal.packId);
          console.warn(`[mish-packs] ${journal.packId}: an interrupted install was finished`);
        }
      } catch {
        unfinished.add(journal.packId);
        console.warn(`[mish-packs] ${journal.packId}: an interrupted install could not be finished yet; it is retried at the next start`);
      }
    }
    return unfinished;
  }

  /**
   * A copy still in `.mish-pack-retiring` was moved out of its place by an update or removal that
   * stopped before it was compared. It may hold the person's edits, so it is not compared or
   * deleted: it is moved to `.mish-pack-backups` and named in its pack's warnings.
   */
  async function backUpHeldCopies(): Promise<void> {
    let ids: string[] = [];
    try {
      ids = (await fsp.readdir(receiptsRoot)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    } catch {
      // no receipts
    }
    for (const userRoot of userRoots()) {
      const retiring = path.join(userRoot, RETIRING_DIRNAME);
      let holds: string[];
      try {
        holds = await fsp.readdir(retiring);
      } catch {
        continue;
      }
      for (const hold of holds) {
        const holdDir = path.join(retiring, hold);
        const kept: string[] = [];
        try {
          for (const name of await fsp.readdir(holdDir)) kept.push(await moveInto(path.join(holdDir, name), path.join(userRoot, BACKUP_DIRNAME, hold), name));
          await fsp.rmdir(holdDir);
        } catch {
          console.warn(`[mish-packs] a copy set aside by an interrupted update could not be moved to the backups yet: ${holdDir}`);
          continue;
        }
        await noteKept(ids, hold, kept, 'set aside by an interrupted update');
      }
      await fsp.rmdir(retiring).catch(() => undefined);
    }
  }

  /**
   * Deletes the unchanged copies an update or removal set aside in `.mish-pack-retired` a day or
   * more ago, each after comparing it again with the digest it had then. One that changed since (an editor that still
   * had it open saved into it) or has no digest is moved to `.mish-pack-backups` and named in its
   * pack's warnings.
   */
  async function pruneRetired(): Promise<void> {
    const ids = (await allReceipts()).map((receipt) => receipt.id);
    for (const userRoot of userRoots()) {
      const retired = path.join(userRoot, RETIRED_DIRNAME);
      let holds: string[];
      try {
        holds = await fsp.readdir(retired);
      } catch {
        continue;
      }
      for (const hold of holds) {
        const setAside = stampTime(hold);
        if (setAside !== null && now().getTime() - setAside < RETIRED_GRACE_MS) continue;
        const holdDir = path.join(retired, hold);
        const digestsFile = path.join(holdDir, RETIRED_DIGESTS);
        const digests = await readRetiredDigests(digestsFile);
        const kept: string[] = [];
        try {
          for (const name of await fsp.readdir(holdDir)) {
            if (name === RETIRED_DIGESTS) continue;
            const abs = path.join(holdDir, name);
            // Not a copy (a digest file a crash left half-written, `.DS_Store`): nothing of the person's.
            if (!CHILD_RE.test(name)) {
              await fsp.rm(abs, { recursive: true, force: true });
              continue;
            }
            const recorded = Object.hasOwn(digests, name) ? digests[name] : undefined;
            if (recorded !== undefined && (await folderDigest(abs)) === recorded) await fsp.rm(abs, { recursive: true, force: true });
            else kept.push(await moveInto(abs, path.join(userRoot, BACKUP_DIRNAME, hold), name));
          }
          await fsp.rm(digestsFile, { force: true });
          await fsp.rmdir(holdDir);
        } catch {
          console.warn(`[mish-packs] a copy an update set aside could not be cleared yet: ${holdDir}`);
        }
        await noteKept(ids, hold, kept, 'changed after an update set it aside');
      }
      await fsp.rmdir(retired).catch(() => undefined);
    }
  }

  /** Logs folders moved to the backups at start and names them in the warnings of the pack `hold` belongs to. */
  async function noteKept(ids: readonly string[], hold: string, kept: readonly string[], why: string): Promise<void> {
    if (kept.length === 0) return;
    const stamp = STAMP_RE.exec(hold);
    const owner = stamp ? hold.slice(0, stamp.index).replace(/-$/u, '') : null;
    const packId = owner && ids.includes(owner) ? owner : undefined;
    const receipt = packId ? await readReceipt(packId) : null;
    for (const target of kept) {
      console.warn(`[mish-packs] a copy ${why} was kept at ${target}`);
      receipt?.warnings.push(`a copy ${why} was kept at ${target}`);
    }
    if (receipt) await writeReceipt(receipt);
  }

  /** A removal that stopped after the tree reached the trash: its copies and MCP entries go now. */
  async function finishRemovals(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(trashRoot);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (ID_RE.test(name) && !(await exists(path.join(root, name)))) await deactivate(name);
        await fsp.rm(path.join(trashRoot, name), { recursive: true, force: true });
      } catch {
        console.warn(`[mish-packs] ${name}: an interrupted removal could not be finished yet; it is retried at the next start`);
      }
    }
    await fsp.rmdir(trashRoot).catch(() => undefined);
  }

  /**
   * Work folders no journal refers to (left by an older build, or by a crash at a moment this build
   * cannot attribute). They are never deleted here: they may hold the only copy of something. They
   * are named in the log so a person can look.
   */
  async function reportStrayWorkDirs(): Promise<void> {
    const referenced = new Set<string>();
    try {
      for (const name of await fsp.readdir(journalRoot)) referenced.add(name.replace(/\.json$/u, ''));
    } catch {
      // no journals
    }
    const roots = [incomingRoot, previousRoot, ...userRoots().flatMap((userRoot) => [path.join(userRoot, STAGING_DIRNAME), path.join(userRoot, RETIRING_DIRNAME)])];
    for (const dir of roots) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      const stray = entries.filter((entry) => !referenced.has(entry) && !referenced.has(entry.replace(/\.json$/u, '')));
      if (stray.length > 0) console.warn(`[mish-packs] left in place, not matched to an install: ${stray.map((entry) => path.join(dir, entry)).join(', ')}`);
    }
  }

  /**
   * Ends an install that only has MCP or cleanup work left, so one failing step cannot block the
   * pack for good. The MCP entries stay as they are (the old generation's stay recorded as owned),
   * the receipt says so, and the journal goes. Refused while the new tree is not in place yet.
   */
  async function forceSettle(journal: Journal): Promise<boolean> {
    try {
      if (await exists(journal.incomingTree)) return false;
      const receipt = await readReceipt(journal.packId);
      if (!receipt || receipt.token !== journal.token || !receipt.copiesApplied) return false;
      if (!receipt.mcpApplied) {
        receipt.seededMcp = journal.mcpIntent?.remove ?? receipt.seededMcp;
        receipt.mcpApplied = true;
        receipt.warnings.push('the MCP servers of this version were not added because the MCP settings file could not be updated');
      }
      // Nothing is retried after this.
      dropWarnings(receipt, (text) => text === WARN_MCP_RETRY || text === WARN_CLEANUP_RETRY);
      await writeReceipt(receipt);
      await fsp.rm(journal.previousTree, { recursive: true, force: true });
      for (const dir of journal.stagingDirs) await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rm(journalFile(journal.token), { force: true });
      await removeEmptyWorkDirs();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every install that is not fully settled (committed but unfinished, or finished with a cleanup
   * or MCP step still to retry), of any pack: settled now, or the new operation is refused. So an
   * older journal is never replayed over a newer install, removal, or a folder another pack placed
   * since.
   */
  async function settlePending(): Promise<void> {
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
      if (!validJournal(journal)) continue;
      if (journal.phase === 'preparing') {
        await discardPrepared(journal);
        continue;
      }
      let settled = false;
      try {
        settled = (await finish(journal, [])).settled;
      } catch {
        settled = false;
      }
      if (!settled && !(await forceSettle(journal))) {
        throw new MishPackError('BUSY', `an earlier install of ${journal.packId} could not be completed; restart the app and try again`);
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

  /** Brings the staged pack in: prepare, commit, finish (see the top of this file). */
  async function installStaged(packRoot: string, manifest: MishPackManifest): Promise<MishPackStoreInstallResult> {
    await settlePending();
    const token = randomUUID();
    const final = path.join(root, manifest.id);
    const replaced = await exists(final);
    const oldReceipt = replaced ? await readReceipt(manifest.id) : null;
    const mcp = await mcpOwnership(oldReceipt?.seededMcp ?? []);
    const journal: Journal = {
      token,
      packId: manifest.id,
      version: manifest.version,
      phase: 'preparing',
      incomingTree: path.join(incomingRoot, token),
      previousTree: path.join(previousRoot, token),
      stagingDirs: userRoots().map((userRoot) => path.join(userRoot, STAGING_DIRNAME, token)),
      stagedCopies: [],
      oldReceipt,
      mcpTheirs: mcp.theirs,
      mcpOldPresent: mcp.oldPresent,
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
    const { pack, receipt } = finished;
    await reactivateOthers(manifest.id);
    return { pack: await summarize(pack, receipt), replaced, backups };
  }

  return {
    isBusy: () => busy,

    async start() {
      await fsp.mkdir(root, { recursive: true });
      configureMishPacks({ dataDir: options.dataDir, externalDir: options.externalDir ?? null });
      // First, so copies this start sets aside wait for the next one.
      await pruneRetired();
      const unfinished = await recoverInterrupted();
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      await backUpHeldCopies();
      await finishRemovals();
      await reportStrayWorkDirs();
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
        await settlePending();
        const final = path.join(root, id);
        if (!(await exists(final))) {
          const external = activeMishPacks().find((pack) => pack.id === id && pack.origin === 'external');
          if (external) throw new MishPackError('READ_ONLY', 'this pack comes from MISH_PACKS_DIR; remove it from that folder');
          throw new MishPackError('NOT_FOUND', 'no installed pack has that id');
        }
        // The tree goes to the trash first and the receipt is deleted last. A crash in between is
        // finished at the next start (see `finishRemovals`) and the pack is never re-activated.
        const trashed = path.join(trashRoot, id);
        await fsp.mkdir(trashRoot, { recursive: true });
        await fsp.rm(trashed, { recursive: true, force: true });
        await fsp.rename(final, trashed);
        reload();
        const { backups, keptProjects } = await deactivate(id);
        await fsp.rm(trashed, { recursive: true, force: true });
        await fsp.rmdir(trashRoot).catch(() => undefined);
        await reactivateOthers(id);
        return { removed: id, backups, ...(keptProjects.length > 0 ? { keptProjects } : {}) };
      });
    },
  };
}
