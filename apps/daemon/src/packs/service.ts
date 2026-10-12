// Licensed packs: install, upgrade and removal (Licensed Pack plan, Phase 1
// item 1). P1-2's HTTP routes and `od pack` CLI drive this service; consumers
// read installed content through the registry (registry.ts).
//
// Install pipeline, all under `<packsDir>/.staging/<uuid>/` so activation is a
// same-volume rename:
//
//   1. source:   github: → P1-3's GithubPackFetcher writes the tarball into
//                staging; local archive → must come with a sha256 (explicit
//                or a `<file>.sha256` sidecar) or the install fails
//                DIGEST_REQUIRED before a byte is read (owner decision,
//                2026-10-07; no override); folder → no extraction.
//   2. extract:  bounded extraction (archive.ts); the archive sha256 is
//                computed in the same pass and must equal the expected one.
//   3. verify:   pack.json (byte cap before parsing); for github: the
//                extracted pack.json must be byte-identical to the one the
//                fetcher read at the tag, and its version must match the tag.
//                Every listed file is checked against its size and sha256 and
//                only listed files are placed; repo extras are ignored.
//   4. decide:   not installed → installed; same version and digest →
//                unchanged (handlers repaired if needed); same version, other
//                digest → VERSION_CONFLICT unless force; higher → upgraded;
//                lower → VERSION_CONFLICT unless force. Two packs may not
//                provide the same content (CONTENT_CONFLICT).
//   5. activate: live → .trash, staged → live, receipt (atomic), generation
//                bump, handlers' activate, receipt update, trash deleted. A
//                failure before the receipt is written restores the previous
//                folder. registry.reconcile() repairs a crash at any step.
//
// Errors are PackError with fixed messages: no URL, token or absolute path
// ever reaches a message, an event or a receipt. The fetcher's own messages
// are not passed through; only its code is.

import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  comparePackVersions,
  packContentIdentities,
  packFilesUnder,
  PACK_MANIFEST_FILENAME,
  PACK_MANIFEST_MAX_BYTES,
  type InstalledPackContentSummary,
  type InstalledPackSummary,
  type PackContentKind,
  type PackInstallErrorCode,
  type PackInstallEvent,
  type PackInstallOutcome,
  type PackInstallPhase,
  type PackManifest,
} from '@mish/contracts';

import {
  assertFolderSourceSafe,
  DEFAULT_PACK_LIMITS,
  extractPackArchive,
  findPackRoot,
  placeVerifiedFiles,
  type PackArchiveLimits,
} from './archive.js';
import type { GithubPackFetcher, GithubPackFetchResult, PackFetchErrorCode } from './github-fetcher.js';
import {
  activatePackContent,
  createPackHandlerMap,
  pushedKinds,
  receiptRegisteredKinds,
  isRemotePackSource,
  retractByReceipt,
  retractPackContent,
  type AnyPackContentHandler,
  type PackHandlerMap,
} from './handlers.js';
import { createPackRootLock } from './lock.js';
import { isPackError, O_NOFOLLOW, PackError, readPackManifestFile, type ReadPackManifestResult } from './manifest.js';
import {
  ensureRealDir,
  isPackId,
  isRealDir,
  PACK_RECEIPTS_DIRNAME,
  receiptsDirState,
  PACK_STAGING_DIRNAME,
  PACK_TRASH_DIRNAME,
  packReceiptPath,
  trashNameFor,
  writePackReceipt,
  type InstalledPack,
  type PackReceipt,
  type PackRegistry,
  type PackRename,
} from './registry.js';

// The fetcher seam is declared once, by P1-3, in github-fetcher.ts.
export type {
  GithubPackFetcher,
  GithubPackFetchOptions,
  GithubPackFetchResult,
  PackFetchErrorCode,
} from './github-fetcher.js';
export { PackError } from './manifest.js';

export type PackInstallInput =
  | {
      kind: 'archive-file';
      /** Absolute path of a .tgz / .tar.gz / .tar file. */
      path: string;
      /** Display name for the receipt (`local:<name>`); defaults to the file name. */
      label?: string;
      /** sha256 hex of the archive; otherwise `<path>.sha256` must exist. */
      sha256?: string;
      force?: boolean;
    }
  | {
      kind: 'folder';
      path: string;
      /** sha256 hex of the folder's canonical pack.json (required; no sidecar). */
      sha256?: string;
      force?: boolean;
    }
  | { kind: 'github'; source: string; force?: boolean };

export interface PackInstallResult {
  outcome: PackInstallOutcome;
  pack: InstalledPackSummary;
  warnings: string[];
}

export interface PackRemoveResult {
  id: string;
  removedVersion: string;
  warnings: string[];
}

export interface PackServiceLimits extends PackArchiveLimits {
  manifestMaxBytes: number;
}

export interface PackServiceOptions {
  registry: PackRegistry;
  /** Optional; when given it must equal `registry.packsDir`. */
  packsDir?: string;
  handlers?: readonly AnyPackContentHandler[];
  /** P1-3's fetcher. Without it, `github:` sources fail SOURCE_UNSUPPORTED. */
  githubFetcher?: GithubPackFetcher | null;
  limits?: Partial<PackServiceLimits>;
  /** Test seam for fault injection on the activation renames. */
  fsOps?: { rename?: PackRename };
  now?: () => Date;
}

export interface PackService {
  /**
   * Install a pack. `emit` receives `progress` events only; the promise
   * resolves with the success payload or rejects with a PackError (use
   * `toPackInstallEvent` to turn either into the final SSE event).
   */
  install(
    input: PackInstallInput,
    emit?: (event: PackInstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<PackInstallResult>;
  /** Retract handled content, then remove the pack. Rejects with PackError. */
  remove(id: string): Promise<PackRemoveResult>;
  list(): InstalledPackSummary[];
  get(id: string): InstalledPackSummary | null;
  /** Run `activate` for content whose handler was missing or failed earlier (call at boot). */
  activatePending(): Promise<{ id: string; warnings: string[] }[]>;
  /** `<packsDir>/.staging`, created on demand: where P1-2's upload middleware writes. */
  stagingDir(): string;
  /**
   * True while an install, removal or repair pass holds the packs lock. A
   * hint for refusing early (P1-2 refuses an upload before reading it); the
   * lock itself still decides.
   */
  isBusy(): boolean;
}

// ---------------------------------------------------------------- summaries

function contentSummaries(manifest: PackManifest): InstalledPackContentSummary[] {
  return manifest.contents.map((entry) => {
    const summary: InstalledPackContentSummary = {
      kind: entry.kind,
      count: entry.kind === 'plugins' ? entry.ids.length : packFilesUnder(entry.path, manifest.files).length,
    };
    if (entry.kind === 'component-kit' || entry.kind === 'cult-catalog') summary.id = entry.id;
    return summary;
  });
}

/** The DTO for one installed pack. */
export function toInstalledPackSummary(pack: InstalledPack): InstalledPackSummary {
  const summary: InstalledPackSummary = {
    id: pack.id,
    version: pack.version ?? '',
    title: pack.title,
    licenceScope: pack.manifest?.licence.scope ?? '',
    contents: pack.manifest ? contentSummaries(pack.manifest) : [],
    status: pack.status,
    digest: pack.receipt?.digest ?? pack.digest ?? '',
    source: pack.receipt?.source ?? '',
    installedAt: pack.receipt?.installedAt ?? '',
  };
  if (pack.problem) summary.problem = pack.problem;
  return summary;
}

/** The final SSE event for an install outcome. */
export function toPackInstallEvent(outcome: PackInstallResult | unknown): PackInstallEvent {
  if (outcome && typeof outcome === 'object' && 'outcome' in outcome && 'pack' in outcome) {
    const result = outcome as PackInstallResult;
    return { event: 'success', data: { outcome: result.outcome, pack: result.pack, warnings: result.warnings } };
  }
  const error = isPackError(outcome) ? outcome : internalError();
  return {
    event: 'error',
    data: { code: error.code as PackInstallErrorCode, message: error.message, warnings: error.warnings },
  };
}

// ---------------------------------------------------------------- errors

function internalError(): PackError {
  return new PackError('INTERNAL_ERROR', 'the pack could not be installed because of an internal error');
}

function badRequest(message: string): PackError {
  return new PackError('BAD_REQUEST', message);
}

const FETCH_MESSAGES: Record<PackFetchErrorCode, string> = {
  BAD_REQUEST: 'the pack source is not valid: use github:owner/repo or github:owner/repo@<major>.<minor>.<patch>',
  AUTH_REQUIRED:
    'the configured GitHub access cannot read the pack repository; add a fine-grained token with read access to it in Settings → Licensed packs',
  FETCH_FAILED: 'the pack could not be downloaded from GitHub; try again later',
  TOO_LARGE: 'the pack archive exceeds the size limit',
};

function isPackFetchError(error: unknown): error is { code: PackFetchErrorCode } {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'PackFetchError' && typeof code === 'string' && code in FETCH_MESSAGES;
}

const cancelled = () => new PackError('CANCELLED', 'the pack install was cancelled');

// ---------------------------------------------------------------- inputs

const SHA256_INPUT_RE = /^[0-9a-fA-F]{64}$/;
const SIDECAR_MAX_BYTES = 4096;
const GITHUB_SOURCE_RE = /^github:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))?$/;
const RESOLVED_REF_RE = /^pack@(\S{1,64}) [0-9a-f]{40}$/;
const ARCHIVE_INTEGRITY_RE = /^sha256:([0-9a-f]{64})$/;
const MANIFEST_SHA_RE = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

type ValidInput =
  | { kind: 'archive-file'; path: string; label: string; sha256: string | null; force: boolean }
  | { kind: 'folder'; path: string; label: string; sha256: string | null; force: boolean }
  | { kind: 'github'; source: string; force: boolean };

function displayName(value: string): string {
  const name = path.basename(value).replace(CONTROL_RE, '').trim().slice(0, 128);
  return name || 'pack';
}

function checkSha256Input(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || !SHA256_INPUT_RE.test(value))) {
    throw badRequest('sha256 must be 64 hex characters');
  }
}

function folderDigestRequired(): PackError {
  return new PackError(
    'DIGEST_REQUIRED',
    'a pack folder install needs the digest of its pack.json, which od pack digest prints (it is not the plain sha256 of the file); pass it with the install',
  );
}

function validateInput(input: unknown): ValidInput {
  if (!input || typeof input !== 'object') throw badRequest('the install request is not valid');
  const record = input as Record<string, unknown>;
  if (record.force !== undefined && typeof record.force !== 'boolean') throw badRequest('force must be true or false');
  const force = record.force === true;
  const absolutePath = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !path.isAbsolute(value) || value.includes('\0')) {
      throw badRequest('a local pack source must be an absolute path');
    }
    return path.resolve(value);
  };
  switch (record.kind) {
    case 'archive-file': {
      const filePath = absolutePath(record.path);
      checkSha256Input(record.sha256);
      if (record.label !== undefined && typeof record.label !== 'string') throw badRequest('label must be a string');
      return {
        kind: 'archive-file',
        path: filePath,
        label: displayName(typeof record.label === 'string' && record.label.trim() ? record.label : filePath),
        sha256: typeof record.sha256 === 'string' ? record.sha256.toLowerCase() : null,
        force,
      };
    }
    case 'folder': {
      const folderPath = absolutePath(record.path);
      checkSha256Input(record.sha256);
      return {
        kind: 'folder',
        path: folderPath,
        label: displayName(folderPath),
        sha256: typeof record.sha256 === 'string' ? record.sha256.toLowerCase() : null,
        force,
      };
    }
    case 'github': {
      const source = record.source;
      if (typeof source !== 'string' || source.length > 300 || !GITHUB_SOURCE_RE.test(source)) {
        throw badRequest('a GitHub pack source must look like github:owner/repo or github:owner/repo@<major>.<minor>.<patch>');
      }
      return { kind: 'github', source, force };
    }
    default:
      throw badRequest('the install request is not valid');
  }
}

/** The sha256 a local archive must have: explicit and/or `<file>.sha256`, which must agree. */
function expectedArchiveDigest(archivePath: string, explicit: string | null): string {
  let sidecar: string | null = null;
  let fd: number | null = null;
  try {
    fd = openSync(`${archivePath}.sha256`, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw badRequest('the .sha256 file beside the pack archive could not be read');
    }
  }
  if (fd !== null) {
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > SIDECAR_MAX_BYTES) {
        throw badRequest('the .sha256 file beside the pack archive does not hold a sha256 digest');
      }
      const buffer = Buffer.alloc(stat.size);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      const token = buffer.subarray(0, read).toString('utf8').trim().split(/\s+/)[0] ?? '';
      if (!SHA256_INPUT_RE.test(token)) {
        throw badRequest('the .sha256 file beside the pack archive does not hold a sha256 digest');
      }
      sidecar = token.toLowerCase();
    } finally {
      closeSync(fd);
    }
  }
  if (explicit && sidecar && explicit !== sidecar) {
    throw new PackError('INTEGRITY_MISMATCH', 'the sha256 given does not match the .sha256 file beside the pack archive');
  }
  const expected = explicit ?? sidecar;
  if (!expected) {
    throw new PackError(
      'DIGEST_REQUIRED',
      'a local pack archive needs its sha256: put it in a .sha256 file beside the archive or pass it with the install',
    );
  }
  return expected;
}

// ---------------------------------------------------------------- service

type InstallDecision = { outcome: PackInstallOutcome; unchanged: boolean };

function decide(
  existing: InstalledPack | null,
  manifest: PackManifest,
  digest: string,
  force: boolean,
  sourceLabel: string,
): InstallDecision {
  if (!existing) return { outcome: 'installed', unchanged: false };
  if (existing.status === 'damaged' || !existing.manifest) return { outcome: 'installed', unchanged: false };
  const order = comparePackVersions(manifest.version, existing.manifest.version);
  if (order === 0) {
    // Force re-copies and re-verifies the same bytes (repairs a tampered install).
    // A switch between a local (.tgz, folder) and a remote (github:) source
    // is a replacement too: the receipt takes the new source, and content
    // handlers apply its defaults (the plugins handler's trust).
    const sourceSwitched = isRemotePackSource(existing.receipt?.source) !== isRemotePackSource(sourceLabel);
    if (existing.digest === digest) {
      return force || sourceSwitched ? { outcome: 'installed', unchanged: false } : { outcome: 'unchanged', unchanged: true };
    }
    if (!force) {
      throw new PackError(
        'VERSION_CONFLICT',
        'this pack version is already installed with different contents; install with force to replace it',
      );
    }
    return { outcome: 'installed', unchanged: false };
  }
  if (order > 0) return { outcome: 'upgraded', unchanged: false };
  if (!force) {
    throw new PackError('VERSION_CONFLICT', 'a newer version of this pack is installed; install with force to downgrade');
  }
  return { outcome: 'installed', unchanged: false };
}

async function retryingRename(rename: PackRename, from: string, to: string): Promise<void> {
  // Windows refuses to rename a folder with an open handle (EBUSY / EPERM),
  // for example a preview being streamed. Retry briefly, then give up with
  // the previous version intact.
  const attempts = process.platform === 'win32' ? 5 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

function exists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

const PROGRESS_STEP = 4 * 1024 * 1024;

export function createPackService(options: PackServiceOptions): PackService {
  const registry = options.registry;
  if (!registry || typeof registry.packsDir !== 'string') throw new TypeError('createPackService needs a pack registry');
  const packsDir = registry.packsDir;
  if (options.packsDir !== undefined && path.resolve(options.packsDir) !== packsDir) {
    throw new TypeError('createPackService: packsDir differs from the registry packsDir');
  }
  const handlers: PackHandlerMap = createPackHandlerMap(options.handlers ?? []);
  const fetcher = options.githubFetcher ?? null;
  const limits: PackServiceLimits = {
    ...DEFAULT_PACK_LIMITS,
    manifestMaxBytes: PACK_MANIFEST_MAX_BYTES,
    ...options.limits,
  };
  const rename: PackRename = options.fsOps?.rename ?? ((from, to) => fsp.rename(from, to));
  const now = options.now ?? (() => new Date());
  const lock = createPackRootLock();
  const stagingRoot = path.join(packsDir, PACK_STAGING_DIRNAME);
  const trashRoot = path.join(packsDir, PACK_TRASH_DIRNAME);

  function summaryOf(id: string): InstalledPackSummary {
    const pack = registry.get(id);
    if (!pack) throw internalError();
    return toInstalledPackSummary(pack);
  }

  async function fetchFromGithub(
    source: string,
    work: string,
    emit: (event: PackInstallEvent) => void,
    signal: AbortSignal | undefined,
  ): Promise<GithubPackFetchResult & { tagVersion: string; archiveSha256: string }> {
    if (!fetcher) throw internalError();
    emit({ event: 'progress', data: { phase: 'resolving' } });
    const destPath = path.join(work, 'download.tgz');
    let result: GithubPackFetchResult;
    try {
      result = await fetcher(source, {
        destPath,
        maxBytes: limits.archiveMaxBytes,
        signal,
        onProgress: (bytes, totalBytes) => {
          const data: { phase: PackInstallPhase; bytes: number; totalBytes?: number } = { phase: 'downloading', bytes };
          if (typeof totalBytes === 'number') data.totalBytes = totalBytes;
          emit({ event: 'progress', data });
        },
      });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (isPackFetchError(error)) throw new PackError(error.code, FETCH_MESSAGES[error.code]);
      throw new PackError('FETCH_FAILED', FETCH_MESSAGES.FETCH_FAILED);
    }
    const ref = typeof result?.resolvedRef === 'string' ? RESOLVED_REF_RE.exec(result.resolvedRef) : null;
    const integrity = typeof result?.archiveIntegrity === 'string' ? ARCHIVE_INTEGRITY_RE.exec(result.archiveIntegrity) : null;
    if (
      !ref ||
      !integrity ||
      result.archivePath !== destPath ||
      typeof result.expectedManifestSha256 !== 'string' ||
      !MANIFEST_SHA_RE.test(result.expectedManifestSha256)
    ) {
      throw new PackError('FETCH_FAILED', 'the pack download returned an unexpected result');
    }
    return { ...result, tagVersion: ref[1]!, archiveSha256: integrity[1]! };
  }

  /**
   * Write a receipt whose handler statuses changed, then bump the generation
   * so consumers that cache by it see the new status (N7). `replacedVersion`
   * is kept only while some pushed kind is not yet `active` (N6).
   */
  async function writeStatusReceipt(receipt: PackReceipt): Promise<void> {
    const settled: PackReceipt = { ...receipt };
    const allActive = Object.values(settled.handlers).every((status) => status === 'active');
    if (allActive || !settled.replacedVersion) delete settled.replacedVersion;
    await writePackReceipt(packsDir, settled, rename);
    registry.invalidate();
  }

  /**
   * Retract `kinds` of an installed pack. The receipt first marks them
   * `pending` (a durable intent): a crash mid-retract leaves the pack
   * degraded and activatePending() re-registers it at boot. With a manifest,
   * a failed retract activates the kinds again; without one (pack.json
   * unreadable) the handlers retract by the receipt's id and version alone
   * and nothing can be re-activated. Either way a failure throws
   * RETRACT_FAILED and the pack stays installed.
   */
  async function retractOrRestore(
    receipt: PackReceipt | null,
    manifest: PackManifest | null,
    packDir: string,
    kinds: PackContentKind[],
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (receipt) {
      const pending = Object.fromEntries(kinds.map((kind) => [kind, 'pending' as const]));
      await writeStatusReceipt({ ...receipt, handlers: { ...receipt.handlers, ...pending } });
    }
    const retracted = manifest
      ? await retractPackContent({ handlers, manifest, packDir, installSource: receipt?.source, signal, kinds })
      : receipt
        ? await retractByReceipt({ handlers, packId: receipt.id, version: receipt.version, packDir, installSource: receipt.source, signal, kinds })
        : ({ ok: true, warnings: [] } as const);
    warnings.push(...retracted.warnings);
    if (retracted.ok) return;
    if (manifest) await restoreKinds(receipt, manifest, packDir, kinds, warnings, signal);
    throw new PackError(
      'RETRACT_FAILED',
      `${retracted.kind} content could not be unregistered (${retracted.code}); the pack is still installed`,
      [...warnings],
    );
  }

  /** Activate `kinds` of an installed version again and write their statuses to its receipt. */
  async function restoreKinds(
    receipt: PackReceipt | null,
    manifest: PackManifest,
    packDir: string,
    kinds: PackContentKind[],
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const restored = await activatePackContent({
      handlers,
      manifest,
      packDir,
      previousVersion: receipt?.replacedVersion ?? null,
      installSource: receipt?.source,
      repair: true,
      signal,
      kinds,
    });
    warnings.push(...restored.warnings);
    if (receipt) {
      await writeStatusReceipt({ ...receipt, handlers: { ...receipt.handlers, ...restored.statuses } }).catch(() => undefined);
    }
  }

  async function install(
    rawInput: PackInstallInput,
    emitArg?: (event: PackInstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<PackInstallResult> {
    const emit = (event: PackInstallEvent): void => {
      try {
        emitArg?.(event);
      } catch {
        // A broken listener (closed SSE stream) must not break the install.
      }
    };
    const input = validateInput(rawInput);
    if (input.kind === 'github' && !fetcher) {
      throw new PackError('SOURCE_UNSUPPORTED', 'GitHub pack sources are not available in this build');
    }
    const release = lock.tryAcquire();
    if (!release) throw new PackError('INSTALL_IN_PROGRESS', 'another pack install or removal is running');
    let work: string | null = null;
    const warnings: string[] = [];
    let restoreDropped: (() => Promise<void>) | null = null;
    try {
      if (signal?.aborted) throw cancelled();

      // 1. Source checks that need no staging space.
      let expectedArchiveSha: string | null = null;
      let sourceLabel: string;
      let folderRoot: string | null = null;
      if (input.kind === 'archive-file') {
        expectedArchiveSha = expectedArchiveDigest(input.path, input.sha256);
        let stat;
        try {
          stat = statSync(input.path);
        } catch {
          throw badRequest('the pack archive could not be read');
        }
        if (!stat.isFile()) throw badRequest('the pack archive is not a file');
        if (stat.size > limits.archiveMaxBytes) throw new PackError('TOO_LARGE', 'the pack archive exceeds the size limit');
        sourceLabel = `local:${input.label}`;
      } else if (input.kind === 'folder') {
        if (!input.sha256) throw folderDigestRequired();
        try {
          folderRoot = realpathSync(input.path);
          if (!statSync(folderRoot).isDirectory()) throw new Error('not a folder');
        } catch {
          throw badRequest('the pack folder could not be read');
        }
        sourceLabel = `folder:${input.label}`;
      } else {
        sourceLabel = input.source;
      }

      // 2. Staging space on the packs volume.
      await ensureRealDir(stagingRoot);
      work = path.join(stagingRoot, randomUUID());
      await fsp.mkdir(work);

      // 3. Archive → extracted tree, or the folder itself.
      let sourceRoot: string;
      let fetched: Awaited<ReturnType<typeof fetchFromGithub>> | null = null;
      if (input.kind === 'folder') {
        sourceRoot = findPackRoot(folderRoot!);
      } else {
        let archivePath: string;
        if (input.kind === 'github') {
          fetched = await fetchFromGithub(input.source, work, emit, signal);
          archivePath = fetched.archivePath;
          expectedArchiveSha = fetched.archiveSha256;
        } else {
          archivePath = input.path;
        }
        const extractDir = path.join(work, 'extract');
        await fsp.mkdir(extractDir);
        let reported = -PROGRESS_STEP;
        emit({ event: 'progress', data: { phase: 'extracting', bytes: 0 } });
        const extracted = await extractPackArchive({
          archivePath,
          destDir: extractDir,
          limits,
          signal,
          onProgress: (bytes, totalBytes) => {
            if (bytes - reported < PROGRESS_STEP && bytes !== totalBytes) return;
            reported = bytes;
            emit({ event: 'progress', data: { phase: 'extracting', bytes, totalBytes } });
          },
        });
        if (extracted.archiveSha256 !== expectedArchiveSha) {
          throw new PackError('INTEGRITY_MISMATCH', 'the pack archive does not match its expected sha256; run od pack digest <folder or file> to get the expected value');
        }
        sourceRoot = findPackRoot(extractDir);
      }

      // 4. Manifest.
      emit({ event: 'progress', data: { phase: 'verifying' } });
      const read: ReadPackManifestResult = readPackManifestFile(path.join(sourceRoot, PACK_MANIFEST_FILENAME), {
        maxBytes: limits.manifestMaxBytes,
      });
      const { manifest, digest } = read;
      if (input.kind === 'folder' && digest !== input.sha256) {
        throw new PackError('INTEGRITY_MISMATCH', 'the pack folder\'s pack.json does not match the sha256 given; run od pack digest <folder or file> (the digest is not the plain file sha256)');
      }
      if (fetched) {
        if (read.bytesSha256 !== fetched.expectedManifestSha256) {
          throw new PackError('INTEGRITY_MISMATCH', 'pack.json differs from the manifest committed at the pack tag');
        }
        if (fetched.tagVersion !== manifest.version) {
          throw new PackError('INTEGRITY_MISMATCH', 'pack.json names a different version than its pack tag');
        }
      }

      // 5. Version and content decisions.
      const existing = registry.get(manifest.id);
      const decision = decide(existing, manifest, digest, input.force, sourceLabel);
      const identities = new Set(manifest.contents.flatMap(packContentIdentities));
      for (const other of registry.list()) {
        if (other.id === manifest.id || other.status === 'damaged' || !other.manifest) continue;
        if (other.manifest.contents.flatMap(packContentIdentities).some((identity) => identities.has(identity))) {
          throw new PackError('CONTENT_CONFLICT', `installed pack ${other.id} already provides this content`);
        }
      }
      // 6. Verify and assemble exactly the listed files.
      const assembled = path.join(work, 'pack');
      await fsp.mkdir(assembled);
      const fileIdentities =
        input.kind === 'folder' ? assertFolderSourceSafe(sourceRoot, manifest.files.map((file) => file.path)) : undefined;
      await placeVerifiedFiles({
        sourceRoot,
        destRoot: assembled,
        files: manifest.files,
        mode: input.kind === 'folder' ? 'copy' : 'move',
        ...(fileIdentities ? { identities: fileIdentities } : {}),
        ...(signal ? { signal } : {}),
      });
      await fsp.writeFile(path.join(assembled, PACK_MANIFEST_FILENAME), read.bytes, { flag: 'wx', mode: 0o644 });
      if (signal?.aborted) throw cancelled();

      // Same version and digest: the candidate verified above is discarded.
      // Every handled pushed kind is activated again, `active` ones included:
      // activate is an idempotent upsert, so a plain re-install repairs a
      // registration that was deleted or changed since (a removed plugin
      // folder). A pack with no pushed kinds pays nothing here.
      if (decision.unchanged && existing?.receipt) {
        const repair = pushedKinds(manifest).filter((kind) => handlers.has(kind));
        if (repair.length > 0) {
          emit({ event: 'progress', data: { phase: 'activating' } });
          const activated = await activatePackContent({
            handlers,
            manifest,
            packDir: existing.dir,
            previousVersion: existing.receipt.replacedVersion ?? null,
            installSource: existing.receipt.source,
            repair: true,
            signal,
            kinds: repair,
          });
          warnings.push(...activated.warnings);
          await writeStatusReceipt({
            ...existing.receipt,
            handlers: { ...existing.receipt.handlers, ...activated.statuses },
          });
        }
        return { outcome: 'unchanged', pack: summaryOf(manifest.id), warnings };
      }

      // Before the swap, retract what the replaced pack registered and the
      // new one will not: an upgrade's dropped kinds (against the old
      // manifest, while the old bytes are live), or, over a damaged pack,
      // every kind its receipt registered (by receipt id and version, W2).
      // If the upgrade fails before the new receipt is committed, the
      // dropped kinds are activated again on the old version (W1).
      const previous = existing && existing.status !== 'damaged' ? existing.manifest : null;
      if (existing?.receipt) {
        if (previous) {
          const kept = new Set<PackContentKind>(pushedKinds(manifest));
          const dropped = pushedKinds(previous).filter((kind) => !kept.has(kind) && handlers.has(kind));
          if (dropped.length > 0) {
            await retractOrRestore(existing.receipt, previous, existing.dir, dropped, warnings, signal);
            const oldReceipt = existing.receipt;
            const oldDir = existing.dir;
            restoreDropped = () => restoreKinds(oldReceipt, previous, oldDir, dropped, warnings, signal);
          }
        } else if (existing.status === 'damaged') {
          const registered = receiptRegisteredKinds(existing.receipt.handlers).filter((kind) => handlers.has(kind));
          if (registered.length > 0) await retractOrRestore(existing.receipt, null, existing.dir, registered, warnings, signal);
        }
      }

      // 7. Activate.
      emit({ event: 'progress', data: { phase: 'activating' } });
      const live = path.join(packsDir, manifest.id);
      await ensureRealDir(trashRoot);
      await ensureRealDir(path.join(packsDir, PACK_RECEIPTS_DIRNAME));
      let trashed: string | null = null;
      if (exists(live)) {
        trashed = path.join(trashRoot, trashNameFor(manifest.id));
        try {
          await retryingRename(rename, live, trashed);
        } catch {
          throw new PackError('INTERNAL_ERROR', 'the installed pack version could not be moved aside; it is still installed');
        }
      }
      const restorePrevious = async (): Promise<void> => {
        if (trashed && !exists(live)) await retryingRename(rename, trashed, live).catch(() => undefined);
      };
      try {
        await retryingRename(rename, assembled, live);
      } catch {
        await restorePrevious();
        throw new PackError('INTERNAL_ERROR', 'the new pack version could not be activated; the previous version is still installed');
      }

      const receipt: PackReceipt = {
        schemaVersion: 1,
        id: manifest.id,
        version: manifest.version,
        digest,
        source: sourceLabel,
        installedAt: now().toISOString(),
        handlers: Object.fromEntries(pushedKinds(manifest).map((kind) => [kind, 'pending'])),
      };
      if (previous) receipt.replacedVersion = previous.version;
      if (fetched) receipt.resolvedRef = fetched.resolvedRef;
      if (expectedArchiveSha) receipt.archiveIntegrity = `sha256:${expectedArchiveSha}`;
      try {
        await writePackReceipt(packsDir, receipt, rename);
      } catch {
        // Undo the swap: the old receipt is still in place and matches the old folder.
        await retryingRename(rename, live, path.join(work, 'rejected')).catch(() => undefined);
        await restorePrevious();
        throw new PackError('INTERNAL_ERROR', 'the pack install receipt could not be written; the previous version is still installed');
      }
      restoreDropped = null;
      registry.invalidate();

      // 8. Content handlers.
      const activated = await activatePackContent({
        handlers,
        manifest,
        packDir: live,
        previousVersion: previous?.version ?? null,
        installSource: receipt.source,
        signal,
      });
      warnings.push(...activated.warnings);
      try {
        await writeStatusReceipt({ ...receipt, handlers: activated.statuses });
      } catch {
        warnings.push('the pack install receipt could not be updated; re-install the pack to repair it');
      }
      if (trashed) await fsp.rm(trashed, { recursive: true, force: true }).catch(() => undefined);
      return { outcome: decision.outcome, pack: summaryOf(manifest.id), warnings };
    } catch (error) {
      const failure = isPackError(error) ? error : signal?.aborted ? cancelled() : internalError();
      // The old version is still live: give back what the dropped-kind retract took.
      if (restoreDropped) await restoreDropped().catch(() => undefined);
      failure.warnings = [...warnings, ...failure.warnings];
      throw failure;
    } finally {
      if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
      release();
    }
  }

  async function remove(id: string): Promise<PackRemoveResult> {
    if (!isPackId(id)) throw badRequest('the pack id is not valid');
    const release = lock.tryAcquire();
    if (!release) throw new PackError('INSTALL_IN_PROGRESS', 'another pack install or removal is running');
    try {
      const pack = registry.get(id);
      if (!pack) throw new PackError('PACK_NOT_FOUND', `pack ${id} is not installed`);
      // N4: never read or delete a receipt through a `.receipts` link.
      if (receiptsDirState(packsDir) === 'unsafe') {
        throw new PackError('INTERNAL_ERROR', 'the packs folder layout is not safe (a working folder is a link)');
      }
      // Sol hold (PR #191, BLOCK 2): `.trash` must be a real folder before
      // anything is retracted or the receipt is touched.
      await ensureRealDir(trashRoot);
      const warnings: string[] = [];
      let retracted: { manifest: PackManifest | null; kinds: PackContentKind[] } | null = null;
      if (pack.manifest && pack.manifest.id === id && pack.status !== 'damaged') {
        const kinds = pushedKinds(pack.manifest).filter((kind) => handlers.has(kind));
        if (kinds.length > 0) {
          await retractOrRestore(pack.receipt, pack.manifest, pack.dir, kinds, warnings);
          retracted = { manifest: pack.manifest, kinds };
        }
      } else if (pack.receipt) {
        // W2: pack.json unreadable or untrusted; retract by the receipt alone.
        const kinds = receiptRegisteredKinds(pack.receipt.handlers).filter((kind) => handlers.has(kind));
        if (kinds.length > 0) {
          await retractOrRestore(pack.receipt, null, pack.dir, kinds, warnings);
          retracted = { manifest: null, kinds };
        }
      }
      const trashed = path.join(trashRoot, trashNameFor(id));
      try {
        // Receipt first: a crash after this leaves a damaged pack (visible,
        // removable), never a restorable one.
        await fsp.rm(packReceiptPath(packsDir, id), { force: true });
        await ensureRealDir(trashRoot);
        await retryingRename(rename, pack.dir, trashed);
      } catch {
        // The folder is still live: put back the receipt and the registrations
        // the retract took, so the pack is exactly as it was before remove().
        await restoreAfterFailedRemove(pack.receipt, pack.dir, retracted, warnings);
        registry.invalidate();
        throw new PackError('INTERNAL_ERROR', 'the pack folder could not be removed; remove it again after closing open previews', warnings);
      }
      registry.invalidate();
      await fsp.rm(trashed, { recursive: true, force: true }).catch(() => undefined);
      return { id, removedVersion: pack.version ?? '', warnings };
    } catch (error) {
      if (isPackError(error)) throw error;
      throw new PackError('INTERNAL_ERROR', 'the pack could not be removed because of an internal error');
    } finally {
      release();
    }
  }

  async function restoreAfterFailedRemove(
    receipt: PackReceipt | null,
    packDir: string,
    retracted: { manifest: PackManifest | null; kinds: PackContentKind[] } | null,
    warnings: string[],
  ): Promise<void> {
    if (!receipt) return;
    try {
      await writePackReceipt(packsDir, receipt, rename);
    } catch {
      warnings.push('the pack install receipt could not be restored; re-install the pack to repair it');
      return;
    }
    if (!retracted) return;
    if (retracted.manifest) {
      await restoreKinds(receipt, retracted.manifest, packDir, retracted.kinds, warnings).catch(() => undefined);
      return;
    }
    // Retracted by receipt alone (no trusted manifest): nothing can be re-activated,
    // so the receipt records the truth, those kinds are pending.
    const pending = Object.fromEntries(retracted.kinds.map((kind) => [kind, 'pending' as const]));
    await writeStatusReceipt({ ...receipt, handlers: { ...receipt.handlers, ...pending } }).catch(() => undefined);
  }

  async function activatePending(): Promise<{ id: string; warnings: string[] }[]> {
    const release = lock.tryAcquire();
    if (!release) throw new PackError('INSTALL_IN_PROGRESS', 'another pack install or removal is running');
    try {
      const report: { id: string; warnings: string[] }[] = [];
      for (const pack of registry.list()) {
        if (pack.status === 'damaged' || !pack.manifest || !pack.receipt) continue;
        const receipt = pack.receipt;
        const kinds = pushedKinds(pack.manifest).filter((kind) => handlers.has(kind) && receipt.handlers[kind] !== 'active');
        if (kinds.length === 0) continue;
        const activated = await activatePackContent({
          handlers,
          manifest: pack.manifest,
          packDir: pack.dir,
          previousVersion: receipt.replacedVersion ?? null,
          installSource: receipt.source,
          repair: true,
          kinds,
        });
        await writeStatusReceipt({ ...receipt, handlers: { ...receipt.handlers, ...activated.statuses } });
        report.push({ id: pack.id, warnings: activated.warnings });
      }
      return report;
    } finally {
      release();
    }
  }

  return {
    install,
    remove,
    list: () => registry.list().map(toInstalledPackSummary),
    get: (id) => {
      const pack = registry.get(id);
      return pack ? toInstalledPackSummary(pack) : null;
    },
    activatePending,
    isBusy: () => lock.held,
    stagingDir() {
      mkdirSync(stagingRoot, { recursive: true });
      if (!isRealDir(stagingRoot)) throw new PackError('INTERNAL_ERROR', 'the packs folder layout is not safe (a working folder is a link)');
      return stagingRoot;
    },
  };
}
