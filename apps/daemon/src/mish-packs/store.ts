// Mish packs: install, list and remove.
//
// Layout under `<dataDir>/mish-packs/`:
//   <id>/                 an installed pack (its `mish-pack.json` and every file it provides)
//   .receipts/<id>.json   what activation did outside the pack folder (copied folders, MCP entries)
//   .staging/, .trash/    work areas; leftovers are removed on the next start
//
// Resources the daemon reads in place (catalogues, kits, assets) are not copied: the overlay reads
// them from the pack folder. Folders that scanners expect inside a user root (skills, design
// systems, studies) are copied there on install and removed again on remove; the receipt records
// exactly which folders the pack added so nothing else is touched, and a digest of each as placed.
// On remove, reinstall or a new version, a copy whose digest no longer matches (the user changed
// it) is moved to `<user root>/.mish-pack-backups/<id>-<time>/<name>` instead of being deleted, and
// the result names it. A receipt without digests (written before they existed) backs up every copy.

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

export interface MishPackStoreOptions {
  dataDir: string;
  /** MISH_PACKS_DIR: a read-only folder of pack folders (or one pack folder). */
  externalDir?: string | null;
  /** Roots the daemon scans for user skills and user design systems. */
  userRoots: { skills: string; designSystems: string };
  env?: NodeJS.ProcessEnv;
  limits?: MishPackLimits;
  now?: () => Date;
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
  /** Boot: repair crash residue, scan, activate every pack, apply allow-listed environment. */
  start(): Promise<void>;
  isBusy(): boolean;
}

const ID_RE = new RegExp(MISH_PACK_ID_PATTERN);
const CHILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const DIR_KEYS: readonly MishPackResourceKey[] = ['cultKit', 'cultCatalog', 'genui', 'twentyFirst', 'designSystems', 'skills', 'studies', 'pets', 'promptTemplates', 'styleCatalog'];
const FILE_KEYS: readonly MishPackResourceKey[] = ['cultAdapters', 'sections'];
const ALL_KEYS: readonly MishPackResourceKey[] = [...DIR_KEYS, ...FILE_KEYS];
const COPIED_KEYS = new Set<MishPackResourceKey>(['designSystems', 'skills', 'studies']);
const BACKUP_DIRNAME = '.mish-pack-backups';

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
}

function emptyReceipt(pack: { id: string; manifest: MishPackManifest }, now: Date): Receipt {
  return { id: pack.id, version: pack.manifest.version, installedAt: now.toISOString(), copied: { skills: [], designSystems: [] }, seededMcp: [], warnings: [] };
}

/** Digests a new version's receipt starts from: empty for a first install, none from a receipt that predates them. */
function carriedDigests(previous: Receipt | null): Pick<Receipt, 'digests'> {
  if (!previous) return { digests: { skills: {}, designSystems: {} } };
  return previous.digests ? { digests: previous.digests } : {};
}

export function createMishPackStore(options: MishPackStoreOptions): MishPackStore {
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_MISH_PACK_LIMITS;
  const now = options.now ?? (() => new Date());
  const root = mishPacksInstallDir(options.dataDir);
  const stagingRoot = path.join(root, '.staging');
  const trashRoot = path.join(root, '.trash');
  const receiptsRoot = path.join(root, '.receipts');
  let busy = false;

  const receiptFile = (id: string) => path.join(receiptsRoot, `${id}.json`);

  async function readReceipt(id: string): Promise<Receipt | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(receiptFile(id), 'utf8')) as Receipt;
      if (parsed && parsed.id === id && Array.isArray(parsed.seededMcp) && parsed.copied) return parsed;
    } catch {
      // no receipt, or an unreadable one: treated as "nothing recorded"
    }
    return null;
  }

  async function writeReceipt(receipt: Receipt): Promise<void> {
    await fsp.mkdir(receiptsRoot, { recursive: true });
    const tmp = `${receiptFile(receipt.id)}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, receiptFile(receipt.id));
  }

  const bucketRoot = (bucket: CopyBucket) => (bucket === 'skills' ? options.userRoots.skills : options.userRoots.designSystems);

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
    const backupDir = path.join(destRoot, BACKUP_DIRNAME, `${receipt.id}-${stamp}`);
    await fsp.mkdir(backupDir, { recursive: true });
    let target = path.join(backupDir, name);
    for (let n = 2; await exists(target); n += 1) target = path.join(backupDir, `${name}-${n}`);
    await fsp.rename(dest, target);
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
      }
    }
  }

  async function removeUserRootCopies(receipt: Receipt): Promise<MishPackBackup[]> {
    const stamp = backupStamp(now());
    const backups: MishPackBackup[] = [];
    for (const bucket of ['skills', 'designSystems'] as const) {
      for (const child of receipt.copied[bucket]) {
        if (!CHILD_RE.test(child)) continue;
        const backup = await retireCopy(receipt, bucket, child, stamp);
        if (backup) backups.push(backup);
      }
    }
    return backups;
  }

  /**
   * Activation outside the pack folder; MCP entries are seeded only on a new version. `carried`
   * are backups an earlier step of the same operation made (a reinstall's removal): they are
   * reported with this receipt's warnings and in the returned list.
   */
  async function activate(pack: ActiveMishPack, carried: MishPackBackup[] = []): Promise<{ receipt: Receipt; backups: MishPackBackup[] }> {
    const previous = await readReceipt(pack.id);
    const receipt: Receipt = previous && previous.version === pack.manifest.version
      ? { ...previous, warnings: [] }
      : {
          ...emptyReceipt(pack, now()),
          installedAt: previous?.installedAt ?? now().toISOString(),
          copied: previous?.copied ?? { skills: [], designSystems: [] },
          ...carriedDigests(previous),
          seededMcp: previous?.seededMcp ?? [],
        };
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
    }
    await writeReceipt(receipt);
    return { receipt, backups };
  }

  /** Reverses activation; returns the copies that were moved aside because the user changed them. */
  async function deactivate(id: string): Promise<MishPackBackup[]> {
    const receipt = await readReceipt(id);
    if (!receipt) return [];
    await unseedPackMcpServers(options.dataDir, receipt.seededMcp);
    const backups = await removeUserRootCopies(receipt);
    await fsp.rm(receiptFile(id), { force: true });
    return backups;
  }

  async function summarize(pack: ActiveMishPack, receipt: Receipt | null): Promise<MishPackSummary> {
    const provides: MishPackProvided[] = [];
    for (const key of ALL_KEYS) {
      const resolved = packResourcePath(pack, key);
      if (!resolved) continue;
      provides.push({ resource: key, items: COPIED_KEYS.has(key) ? (await childDirs(resolved)).length : null });
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

  return {
    isBusy: () => busy,

    async start() {
      await fsp.mkdir(root, { recursive: true });
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

          const final = path.join(root, manifest.id);
          const replaced = await exists(final);
          const removalBackups = replaced ? await deactivate(manifest.id) : [];
          await fsp.mkdir(trashRoot, { recursive: true });
          if (replaced) await fsp.rename(final, path.join(trashRoot, randomUUID()));
          await fsp.rename(packRoot, final);
          await fsp.rm(trashRoot, { recursive: true, force: true });

          const packs = reload();
          const pack = packs.find((entry) => entry.id === manifest.id && entry.origin === 'installed');
          if (!pack) throw new MishPackError('INTERNAL_ERROR', 'the pack was placed but could not be read back');
          const { receipt, backups } = await activate(pack, removalBackups);
          return { pack: await summarize(pack, receipt), replaced, backups };
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
        const backups = await deactivate(id);
        await fsp.mkdir(trashRoot, { recursive: true });
        await fsp.rename(final, path.join(trashRoot, randomUUID()));
        await fsp.rm(trashRoot, { recursive: true, force: true });
        reload();
        return { removed: id, backups };
      });
    },
  };
}
