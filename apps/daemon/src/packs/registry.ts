// Licensed packs: the on-disk layout and the registry consumers query.
//
// Data path (maintainer decision, Devin, 2026-10-07, with the licensed-pack
// plan): every pack lives under `<RUNTIME_DATA_DIR>/packs/`, derived through
// `packsDirForDataDir(RUNTIME_DATA_DIR)` in server.ts. There is no default
// and no cwd fallback: `createPackRegistry` throws without an absolute
// `packsDir`.
//
//   packs/<id>/                   active pack: pack.json + exactly its files[]
//   packs/.staging/<uuid>/        extraction and assembly; never read here
//   packs/.staging/<upload>       P1-2's multipart uploads (same volume)
//   packs/.trash/<id>@<ms>-<hex>/ previous version during a swap or removal
//   packs/.receipts/<id>.json     install receipt (no tokens, no absolute paths)
//   packs/.credentials/           P1-3's token store: never read, listed,
//                                 moved or deleted by pack code
//
// Pack ids cannot contain a dot, so `list()` skips every dot entry, and
// `reconcile()` touches only `.staging`, `.trash` and `.receipts`.
//
// Consumers call the registry per request (or cache by `generation()` /
// `onChange`): a pack can be installed or removed while the daemon runs.
// `list()` reads pack.json and the receipt from disk, cached only while
// neither file nor the folder listing changes. A pack whose pack.json is
// missing, invalid, or whose canonical digest differs from its receipt is
// `damaged` and provides nothing. Per-file hashes are checked at install;
// the registry does not re-hash pack bytes (consumers that pin per-file
// hashes, like the Cult registry's KIT_DRIFT check, keep doing so).

import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  PACK_CONTENT_KINDS,
  PACK_ID_PATTERN,
  PACK_RELATIVE_PATH_PATTERN,
  packFilesUnder,
  type PackContentEntryOf,
  type PackContentKind,
  type PackFileEntry,
  type PackManifest,
} from '@mish/contracts';

import type { PackHandlerStatus } from './handlers.js';
import { isPackError, O_NOFOLLOW, PackError, readPackManifestFile } from './manifest.js';

export const PACKS_DIRNAME = 'packs';
export const PACK_STAGING_DIRNAME = '.staging';
export const PACK_TRASH_DIRNAME = '.trash';
export const PACK_RECEIPTS_DIRNAME = '.receipts';

const PACK_ID_RE = new RegExp(PACK_ID_PATTERN);
const RELATIVE_PATH_RE = new RegExp(PACK_RELATIVE_PATH_PATTERN, 'u');
const TRASH_NAME_RE = /^([a-z0-9][a-z0-9-]{0,63})@(\d{1,16})-[0-9a-f]{8}$/;
const RECEIPT_TMP_RE = /^[a-z0-9][a-z0-9-]{0,63}\.json\.tmp-/;
const RECEIPT_MAX_BYTES = 64 * 1024;

/** `<dataDir>/packs`. `dataDir` must be the daemon's resolved RUNTIME_DATA_DIR. */
export function packsDirForDataDir(dataDir: string): string {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('packsDirForDataDir needs the absolute daemon data root');
  }
  return path.join(dataDir, PACKS_DIRNAME);
}

export function isPackId(value: unknown): value is string {
  return typeof value === 'string' && PACK_ID_RE.test(value);
}


/**
 * Create `dir` (recursively) and prove it is a real folder, not a symlink.
 * The packs root holds `.credentials`; a `.staging`, `.trash` or `.receipts`
 * link must never redirect a write or a delete. Throws PackError on a link.
 */
export async function ensureRealDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  if (!isRealDir(dir)) throw new PackError('INTERNAL_ERROR', 'the packs folder layout is not safe (a working folder is a link)');
}

/** True when `dir` exists and is a folder, not a symlink. */
export function isRealDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- receipts

export interface PackReceipt {
  schemaVersion: 1;
  id: string;
  version: string;
  /** sha256 hex of the canonical manifest (`packManifestDigest`). */
  digest: string;
  /** `github:owner/repo[@version]`, `local:<file name>` or `folder:<folder name>`. */
  source: string;
  /** `pack@<version> <40-hex sha>` for a github install. */
  resolvedRef?: string;
  /** `sha256:<hex>` of the archive the pack came from. */
  archiveIntegrity?: string;
  /**
   * The version this install replaced, kept while any pushed kind is not yet
   * `active`, so a later activation (activatePending, a repair) can pass it
   * as `previousVersion`.
   */
  replacedVersion?: string;
  installedAt: string;
  /** Status of each pushed content kind (see handlers.ts). */
  handlers: Partial<Record<PackContentKind, PackHandlerStatus>>;
}

export function packReceiptPath(packsDir: string, id: string): string {
  return path.join(packsDir, PACK_RECEIPTS_DIRNAME, `${id}.json`);
}

const HANDLER_STATUS_RE = /^(active|pending|unhandled|failed:[A-Z][A-Z0-9_]{0,63})$/;

function parseReceipt(value: unknown): PackReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const isString = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (r.schemaVersion !== 1 || !isPackId(r.id) || !isString(r.version, 64) || !isString(r.source)) return null;
  if (typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest) || !isString(r.installedAt, 64)) return null;
  if (r.resolvedRef !== undefined && !isString(r.resolvedRef)) return null;
  if (r.replacedVersion !== undefined && !isString(r.replacedVersion, 64)) return null;
  if (r.archiveIntegrity !== undefined && !(typeof r.archiveIntegrity === 'string' && /^sha256:[0-9a-f]{64}$/.test(r.archiveIntegrity))) {
    return null;
  }
  const handlers: Partial<Record<PackContentKind, PackHandlerStatus>> = {};
  if (!r.handlers || typeof r.handlers !== 'object' || Array.isArray(r.handlers)) return null;
  for (const [kind, status] of Object.entries(r.handlers as Record<string, unknown>)) {
    if (!(PACK_CONTENT_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof status !== 'string' || !HANDLER_STATUS_RE.test(status)) return null;
    handlers[kind as PackContentKind] = status as PackHandlerStatus;
  }
  const receipt: PackReceipt = {
    schemaVersion: 1,
    id: r.id,
    version: r.version,
    digest: r.digest,
    source: r.source,
    installedAt: r.installedAt,
    handlers,
  };
  if (typeof r.resolvedRef === 'string') receipt.resolvedRef = r.resolvedRef;
  if (typeof r.archiveIntegrity === 'string') receipt.archiveIntegrity = r.archiveIntegrity;
  if (typeof r.replacedVersion === 'string') receipt.replacedVersion = r.replacedVersion;
  return receipt;
}

/** `.receipts` is absent, a real folder, or something else (a link): unsafe to read or delete through. */
export function receiptsDirState(packsDir: string): 'missing' | 'ok' | 'unsafe' {
  const dir = path.join(packsDir, PACK_RECEIPTS_DIRNAME);
  try {
    lstatSync(dir);
  } catch {
    return 'missing';
  }
  return isRealDir(dir) ? 'ok' : 'unsafe';
}

/** The receipt for `id`: the parsed receipt, `null` when absent, or `'invalid'`. */
export function readPackReceipt(packsDir: string, id: string): PackReceipt | null | 'invalid' {
  // Never read through a `.receipts` link (it could point at `.credentials`).
  const receiptsState = receiptsDirState(packsDir);
  if (receiptsState === 'missing') return null;
  if (receiptsState === 'unsafe') return 'invalid';
  let fd: number;
  try {
    fd = openSync(packReceiptPath(packsDir, id), fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'invalid';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RECEIPT_MAX_BYTES) return 'invalid';
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return parseReceipt(JSON.parse(buffer.subarray(0, length).toString('utf8'))) ?? 'invalid';
  } catch {
    return 'invalid';
  } finally {
    closeSync(fd);
  }
}

export type PackRename = (from: string, to: string) => Promise<void>;

/** Write a receipt atomically: a temp file in `.receipts/`, then a rename. */
export async function writePackReceipt(
  packsDir: string,
  receipt: PackReceipt,
  rename: PackRename = (from, to) => fsp.rename(from, to),
): Promise<void> {
  const dir = path.join(packsDir, PACK_RECEIPTS_DIRNAME);
  await ensureRealDir(dir);
  const target = packReceiptPath(packsDir, receipt.id);
  const temp = `${target}.tmp-${randomUUID()}`;
  await fsp.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  try {
    await rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A unique `.trash` folder name for a pack being replaced or removed. */
export function trashNameFor(id: string): string {
  return `${id}@${Date.now()}-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------- registry

export interface InstalledPack {
  id: string;
  /** `<packsDir>/<id>` (not realpath'd; use `resolvePath` for containment). */
  dir: string;
  status: 'ready' | 'degraded' | 'damaged';
  /** Fixed text naming the problem when degraded or damaged. Never a path. */
  problem?: string;
  /** Null when pack.json is missing or invalid. */
  manifest: PackManifest | null;
  version: string | null;
  title: string;
  /** Canonical digest of the pack.json on disk, when it parses. */
  digest: string | null;
  receipt: PackReceipt | null;
}

export interface ResolvedPackContent<K extends PackContentKind = PackContentKind> {
  packId: string;
  packVersion: string;
  /** `<packsDir>/<packId>`. */
  packDir: string;
  kind: K;
  /** `component-kit` / `cult-catalog` id. */
  id?: string;
  schema: string;
  /** The entry's path relative to the pack folder. */
  path: string;
  /** Absolute path of the entry. Resolve files under it with `resolvePath`. */
  absPath: string;
  entry: PackContentEntryOf<K>;
  /** The listed files under `path`, with their sha256 and size. */
  files: PackFileEntry[];
  /** The pack's canonical digest (equal to its receipt digest). */
  digest: string;
  /** Registry generation the answer was computed at. */
  generation: number;
}

export interface ReconcileReport {
  /** Entries removed from `.staging`. */
  stagingRemoved: number;
  /** Packs moved back from `.trash` because their folder was missing. */
  restored: string[];
  /** Packs whose half-finished swap was undone (new bytes, old receipt). */
  rolledBack: string[];
  /** `.trash` entries deleted. */
  trashRemoved: number;
  /** Receipts deleted because their pack folder is gone. */
  orphanReceiptsRemoved: number;
  /** Packs still damaged after reconciliation. */
  damaged: string[];
}

export interface PackRegistry {
  readonly packsDir: string;
  /** Increases on every install, upgrade, removal and reconciliation that changed something. */
  generation(): number;
  /** Installed packs, sorted by id, read from disk. */
  list(): InstalledPack[];
  get(id: string): InstalledPack | null;
  /** The first ready or degraded pack providing `kind` (and `contentId`, when given). */
  provider<K extends PackContentKind>(kind: K, contentId?: string): ResolvedPackContent<K> | null;
  contents<K extends PackContentKind>(kind: K): ResolvedPackContent<K>[];
  /**
   * Absolute real path of `rel` inside an installed, undamaged pack, or null
   * when `rel` is unsafe, missing, or resolves (through any symlink) outside
   * the pack's real folder.
   */
  resolvePath(packId: string, rel: string): string | null;
  onChange(listener: (generation: number) => void): () => void;
  /** Bump the generation and notify listeners. Called by the pack service. */
  invalidate(): number;
  /**
   * Boot-time repair after a crash: clear `.staging`, finish or undo a
   * half-done swap from `.trash`, drop leftover trash, temp receipts and
   * orphan receipts. Never touches `.credentials` or any other dot entry.
   */
  reconcile(): Promise<ReconcileReport>;
}

function statKey(target: string): string {
  try {
    const stat = lstatSync(target);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '-';
  }
}

function problemFor(error: unknown): string {
  if (isPackError(error)) {
    if (error.code === 'TOO_LARGE') return 'pack.json exceeds the manifest size limit';
    if (error.message === 'pack.json is missing') return 'pack.json is missing';
    return 'pack.json is not a valid manifest';
  }
  return 'pack.json could not be read';
}

function hasFailedHandler(receipt: PackReceipt): boolean {
  return Object.values(receipt.handlers).some((status) => typeof status === 'string' && status.startsWith('failed:'));
}

function hasPendingHandler(receipt: PackReceipt): boolean {
  return Object.values(receipt.handlers).some((status) => status === 'pending');
}

function readInstalledPack(packsDir: string, id: string): InstalledPack {
  const dir = path.join(packsDir, id);
  const base = { id, dir, manifest: null, version: null, title: id, digest: null } as const;
  const receiptRead = readPackReceipt(packsDir, id);
  const receipt = receiptRead === 'invalid' ? null : receiptRead;
  const damaged = (problem: string, extra: Partial<InstalledPack> = {}): InstalledPack => ({
    ...base,
    version: receipt?.version ?? null,
    receipt,
    ...extra,
    status: 'damaged',
    problem,
  });

  try {
    if (lstatSync(dir).isSymbolicLink()) return damaged('the pack folder is a link');
  } catch {
    return damaged('the pack folder could not be read');
  }
  let read;
  try {
    read = readPackManifestFile(path.join(dir, 'pack.json'));
  } catch (error) {
    return damaged(problemFor(error));
  }
  const { manifest, digest } = read;
  const known = { manifest, version: manifest.version, title: manifest.title, digest };
  if (manifest.id !== id) return damaged('pack.json names a different pack id than its folder', known);
  if (receiptRead === 'invalid') return damaged('the install receipt is unreadable', known);
  if (!receipt) return damaged('the pack has no install receipt', known);
  if (receipt.id !== id || receipt.version !== manifest.version || receipt.digest !== digest) {
    return damaged('pack.json does not match its install receipt', known);
  }
  if (hasFailedHandler(receipt)) {
    return { ...base, ...known, receipt, status: 'degraded', problem: 'some pack content could not be registered; re-install the pack to repair it' };
  }
  if (hasPendingHandler(receipt)) {
    return { ...base, ...known, receipt, status: 'degraded', problem: 'pack content registration did not finish; re-install the pack to repair it' };
  }
  return { ...base, ...known, receipt, status: 'ready' };
}

export function createPackRegistry(opts: { packsDir: string }): PackRegistry {
  if (!opts || typeof opts.packsDir !== 'string' || !path.isAbsolute(opts.packsDir)) {
    throw new TypeError('createPackRegistry needs an absolute packsDir derived from RUNTIME_DATA_DIR');
  }
  const packsDir = path.resolve(opts.packsDir);
  let generation = 0;
  const listeners = new Set<(generation: number) => void>();
  let cache: { key: string; packs: InstalledPack[] } | null = null;

  function packIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(packsDir);
    } catch {
      return [];
    }
    return names.filter(isPackId).sort();
  }

  function list(): InstalledPack[] {
    const ids = packIds();
    const key = [
      generation,
      ...ids.map(
        (id) =>
          `${id}|${statKey(path.join(packsDir, id))}|${statKey(path.join(packsDir, id, 'pack.json'))}|${statKey(packReceiptPath(packsDir, id))}`,
      ),
    ].join('\n');
    if (cache && cache.key === key) return cache.packs;
    const packs = ids.map((id) => readInstalledPack(packsDir, id));
    cache = { key, packs };
    return packs;
  }

  function get(id: string): InstalledPack | null {
    if (!isPackId(id)) return null;
    return list().find((pack) => pack.id === id) ?? null;
  }

  function resolveContent<K extends PackContentKind>(pack: InstalledPack, entry: PackContentEntryOf<K>): ResolvedPackContent<K> {
    const manifest = pack.manifest!;
    const resolved: ResolvedPackContent<K> = {
      packId: pack.id,
      packVersion: manifest.version,
      packDir: pack.dir,
      kind: entry.kind as K,
      schema: entry.schema,
      path: entry.path,
      absPath: path.join(pack.dir, ...entry.path.split('/')),
      entry,
      files: packFilesUnder(entry.path, manifest.files),
      digest: pack.digest!,
      generation,
    };
    if ('id' in entry && typeof entry.id === 'string') resolved.id = entry.id;
    return resolved;
  }

  function contents<K extends PackContentKind>(kind: K, contentId?: string): ResolvedPackContent<K>[] {
    const out: ResolvedPackContent<K>[] = [];
    for (const pack of list()) {
      if (pack.status === 'damaged' || !pack.manifest) continue;
      for (const entry of pack.manifest.contents) {
        if (entry.kind !== kind) continue;
        if (contentId !== undefined && !('id' in entry && entry.id === contentId)) continue;
        out.push(resolveContent(pack, entry as PackContentEntryOf<K>));
      }
    }
    return out;
  }

  function resolvePath(packId: string, rel: string): string | null {
    if (!isPackId(packId) || typeof rel !== 'string' || !RELATIVE_PATH_RE.test(rel) || rel.length > 1024) return null;
    const pack = get(packId);
    if (!pack || pack.status === 'damaged') return null;
    try {
      const root = realpathSync(path.join(packsDir, packId));
      const real = realpathSync(path.join(packsDir, packId, ...rel.split('/')));
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return real;
    } catch {
      return null;
    }
  }

  function invalidate(): number {
    generation += 1;
    cache = null;
    for (const listener of [...listeners]) {
      try {
        listener(generation);
      } catch {
        // A listener failure must not break the install that triggered it.
      }
    }
    return generation;
  }

  async function reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      stagingRemoved: 0,
      restored: [],
      rolledBack: [],
      trashRemoved: 0,
      orphanReceiptsRemoved: 0,
      damaged: [],
    };
    let changed = false;
    const stagingDir = path.join(packsDir, PACK_STAGING_DIRNAME);
    const trashDir = path.join(packsDir, PACK_TRASH_DIRNAME);
    const receiptsDir = path.join(packsDir, PACK_RECEIPTS_DIRNAME);
    // A working folder that is a link is never traversed (fail closed).
    const names = (dir: string): string[] => {
      if (!isRealDir(dir)) return [];
      try {
        return readdirSync(dir).sort();
      } catch {
        return [];
      }
    };
    const remove = async (target: string): Promise<void> => {
      await fsp.rm(target, { recursive: true, force: true });
    };
    const digestOf = (dir: string): string | null => {
      try {
        if (!lstatSync(dir).isDirectory()) return null;
        return readPackManifestFile(path.join(dir, 'pack.json')).digest;
      } catch {
        return null;
      }
    };
    const exists = (target: string): boolean => {
      try {
        lstatSync(target);
        return true;
      } catch {
        return false;
      }
    };

    for (const name of names(stagingDir)) {
      await remove(path.join(stagingDir, name));
      report.stagingRemoved += 1;
    }

    for (const name of names(receiptsDir)) {
      if (RECEIPT_TMP_RE.test(name)) {
        await remove(path.join(receiptsDir, name));
        changed = true;
      }
    }

    // Group trash by pack id, newest first.
    const groups = new Map<string, { name: string; at: number }[]>();
    for (const name of names(trashDir)) {
      const match = TRASH_NAME_RE.exec(name);
      if (!match) {
        await remove(path.join(trashDir, name));
        report.trashRemoved += 1;
        continue;
      }
      const list = groups.get(match[1]!) ?? [];
      list.push({ name, at: Number(match[2]) });
      groups.set(match[1]!, list);
    }
    for (const [id, entries] of groups) {
      entries.sort((a, b) => b.at - a.at);
      const live = path.join(packsDir, id);
      const receipt = readPackReceipt(packsDir, id);
      const receiptDigest = receipt && receipt !== 'invalid' ? receipt.digest : null;
      const candidate = receiptDigest
        ? entries.find((entry) => digestOf(path.join(trashDir, entry.name)) === receiptDigest)
        : undefined;
      if (candidate) {
        if (!exists(live)) {
          await fsp.rename(path.join(trashDir, candidate.name), live);
          report.restored.push(id);
          changed = true;
        } else if (digestOf(live) !== receiptDigest) {
          await ensureRealDir(stagingDir);
          const aside = path.join(stagingDir, `rollback-${randomUUID()}`);
          await fsp.rename(live, aside);
          await fsp.rename(path.join(trashDir, candidate.name), live);
          await remove(aside);
          report.rolledBack.push(id);
          changed = true;
        }
      }
      for (const entry of entries) {
        const target = path.join(trashDir, entry.name);
        if (!exists(target)) continue;
        await remove(target);
        report.trashRemoved += 1;
        changed = true;
      }
    }

    for (const name of names(receiptsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!isPackId(id) || exists(path.join(packsDir, id))) continue;
      await remove(path.join(receiptsDir, name));
      report.orphanReceiptsRemoved += 1;
      changed = true;
    }

    if (changed || report.stagingRemoved > 0) invalidate();
    report.damaged = list()
      .filter((pack) => pack.status === 'damaged')
      .map((pack) => pack.id);
    return report;
  }

  return {
    packsDir,
    generation: () => generation,
    list,
    get,
    provider: (kind, contentId) => contents(kind, contentId)[0] ?? null,
    contents: (kind) => contents(kind),
    resolvePath,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    reconcile,
  };
}
