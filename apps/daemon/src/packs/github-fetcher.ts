// Private GitHub download for a licensed pack (Licensed Pack plan, Phase 1 item 3).
//
// `github:owner/repo[@version]` names git tag `pack@<version>` of a pack
// repository; no version means the highest `pack@*` tag. The committed tree at
// that tag is the pack. The fetcher:
//
//   1. lists tags (only when no version is given) and picks the highest pack@ tag;
//   2. resolves the tag to its commit sha through `commits/refs/tags/pack@<v>`
//      (`Accept: application/vnd.github.sha`), so a same-named branch never wins;
//   3. reads `pack.json` at that sha through the contents API, under a byte cap,
//      and returns its sha256 as `expectedManifestSha256`;
//   4. downloads `/tarball/{sha}` and streams it to `destPath` under `maxBytes`,
//      hashing as it writes.
//
// The tarball's own sha256 cannot be committed inside the tag it hashes, so the
// pack loader (P1-1) verifies the extracted `pack.json` against
// `expectedManifestSha256` and every extracted file against `files[]`.
// Steps 2 and 3 both use the sha, so the manifest and the tarball are the same
// commit even if the tag moves mid-install.
//
// Security invariants (spec 2 and spec 3 pin them):
//   - Redirects are followed here, never by undici (`redirect: 'manual'` on
//     every hop). A hop must be https, on the default port, without URL
//     credentials, to api.github.com or codeload.github.com, at most 3 hops.
//   - `Authorization` goes only to the origin https://api.github.com. Every
//     other origin gets a fresh header set without it, so the codeload hop
//     never sees the token.
//   - Every hop goes through `safeExternalFetch` (SSRF guard, DNS pinning).
//   - Errors are `PackFetchError` with a fixed message template and no
//     `cause`. Nothing here logs. No message, code, progress value or return
//     value carries the token, a URL (a signed codeload `Location` is itself
//     a short-lived credential) or a filesystem path.
//   - The partial file is deleted on every failure, including caller abort,
//     the idle timeout and the total-time cap. A file that already existed at
//     `destPath` is never opened, overwritten or deleted.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { PackGithubAccess } from '../integrations/github-auth.js';
import { safeExternalFetch } from '../plugins/plugin-asset-cache.js';

// ---------------------------------------------------------------- seam types
//
// P1-1 declares `GithubPackFetcher` once, in `packs/service.ts`. P1-3 landed
// first, so the pinned shape (P1-3 brief §5.1 as amended by Critic fix 2, and
// P1-1 decision (b) + fix 2) is declared here. P1-1 can re-export these
// (`export type { GithubPackFetcher } from './github-fetcher.js'`) or declare a
// structurally identical copy; either way no change is needed here.

export type PackFetchErrorCode = 'BAD_REQUEST' | 'AUTH_REQUIRED' | 'FETCH_FAILED' | 'TOO_LARGE';

export interface GithubPackFetchOptions {
  /** A new file inside the pack staging dir (same volume as the packs root). Must not exist yet. */
  destPath: string;
  /** Archive byte budget (P1-1's PACK_ARCHIVE_MAX_BYTES). */
  maxBytes: number;
  /** Caller cancellation (P1-2 aborts on client disconnect). */
  signal?: AbortSignal | undefined;
  /** Called at most once per MiB downloaded, plus once at the end. */
  onProgress?: ((bytes: number, totalBytes?: number) => void) | undefined;
}

export interface GithubPackFetchResult {
  /** === destPath. */
  archivePath: string;
  /** `pack@<version> <40-hex commit sha>`. */
  resolvedRef: string;
  /** `sha256:<hex>` of the bytes on disk. */
  archiveIntegrity: string;
  /** Lowercase hex sha256 of the committed `pack.json` at the resolved sha. */
  expectedManifestSha256: string;
  bytes: number;
}

export type GithubPackFetcher = (source: string, opts: GithubPackFetchOptions) => Promise<GithubPackFetchResult>;

/** The only error a `GithubPackFetcher` rejects with. `code` is a subset of P1-1's PackInstallErrorCode. */
export class PackFetchError extends Error {
  readonly code: PackFetchErrorCode;

  constructor(code: PackFetchErrorCode, message: string) {
    super(message);
    this.name = 'PackFetchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- constants

/** Mirrors P1-1's contracts `PACK_MANIFEST_MAX_BYTES` (8 MiB); server.ts may pass the contracts value. */
export const PACK_MANIFEST_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const PACK_FETCH_IDLE_TIMEOUT_MS_DEFAULT = 30_000;
export const PACK_FETCH_TOTAL_TIMEOUT_MS_DEFAULT = 15 * 60_000;

const API_ORIGIN = 'https://api.github.com';
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['api.github.com', 'codeload.github.com']);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 10;
const TAGS_PAGE_MAX_BYTES = 1024 * 1024;
const COMMIT_SHA_MAX_BYTES = 1024;
const PROGRESS_STEP_BYTES = 1024 * 1024;
const USER_AGENT = 'open-design-pack-fetcher';
const GITHUB_API_VERSION = '2022-11-28';

const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_SHA = 'application/vnd.github.sha';
const ACCEPT_RAW = 'application/vnd.github.raw+json';

const SOURCE_RE = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:@([^\s]*))?$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACK_TAG_RE = /^pack@(.+)$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

// Fixed message templates: nothing is interpolated into any of them.
const FAILURES = {
  badSource: ['BAD_REQUEST', 'pack source must be github:owner/repo or github:owner/repo@<major>.<minor>.<patch>'],
  badOptions: ['BAD_REQUEST', 'pack download options are invalid'],
  noAccess: [
    'AUTH_REQUIRED',
    'no GitHub access configured for this pack: add a token in Settings → Licensed packs or sign in with gh',
  ],
  denied: ['AUTH_REQUIRED', 'GitHub refused access to the pack repository with the configured token'],
  noPackTag: ['FETCH_FAILED', 'no pack tag found in the pack repository'],
  tooManyTags: ['FETCH_FAILED', 'the pack repository has too many tags to search'],
  versionNotFound: ['FETCH_FAILED', 'that pack version was not found'],
  badCommit: ['FETCH_FAILED', 'GitHub returned an unexpected commit reference'],
  badResponse: ['FETCH_FAILED', 'GitHub returned an unexpected response'],
  rateLimited: ['FETCH_FAILED', 'GitHub rate limit reached; try again later'],
  upstream: ['FETCH_FAILED', 'GitHub download failed'],
  network: ['FETCH_FAILED', 'could not reach GitHub'],
  idleTimeout: ['FETCH_FAILED', 'GitHub download stalled'],
  totalTimeout: ['FETCH_FAILED', 'GitHub download took too long'],
  cancelled: ['FETCH_FAILED', 'pack download cancelled'],
  redirectRefused: ['FETCH_FAILED', 'GitHub redirect was refused'],
  writeFailed: ['FETCH_FAILED', 'could not write the pack archive'],
  archiveTooLarge: ['TOO_LARGE', 'pack archive exceeds the size limit'],
  manifestTooLarge: ['TOO_LARGE', 'pack manifest exceeds the size limit'],
  tagMoved: ['FETCH_FAILED', 'the pack tag changed during download; try again'],
  downloadLinkFailed: ['FETCH_FAILED', 'the GitHub download link failed or expired; try again'],
} as const satisfies Record<string, readonly [PackFetchErrorCode, string]>;

type FailureKey = keyof typeof FAILURES;

function fail(key: FailureKey): PackFetchError {
  const [code, message] = FAILURES[key];
  return new PackFetchError(code, message);
}

// ---------------------------------------------------------------- factory

export function createGithubPackFetcher(deps: {
  access: PackGithubAccess;
  /** Tests inject a fake; production uses the global fetch. Every hop still goes through safeExternalFetch. */
  fetchImpl?: typeof fetch;
  /** No bytes (or no response headers) for this long → FETCH_FAILED. Default 30 s. */
  idleTimeoutMs?: number;
  /** Whole fetch (tags, manifest, tarball) longer than this → FETCH_FAILED. Default 15 min. */
  totalTimeoutMs?: number;
  /** pack.json byte cap. Default 8 MiB (P1-1's PACK_MANIFEST_MAX_BYTES). */
  manifestMaxBytes?: number;
}): GithubPackFetcher {
  const idleTimeoutMs = deps.idleTimeoutMs ?? PACK_FETCH_IDLE_TIMEOUT_MS_DEFAULT;
  const totalTimeoutMs = deps.totalTimeoutMs ?? PACK_FETCH_TOTAL_TIMEOUT_MS_DEFAULT;
  const manifestMaxBytes = deps.manifestMaxBytes ?? PACK_MANIFEST_MAX_BYTES_DEFAULT;

  return async function fetchGithubPack(source, opts) {
    const target = parsePackSource(source);
    if (!target) throw fail('badSource');
    if (
      !opts ||
      typeof opts.destPath !== 'string' ||
      !path.isAbsolute(opts.destPath) ||
      !Number.isSafeInteger(opts.maxBytes) ||
      opts.maxBytes <= 0
    ) {
      throw fail('badOptions');
    }
    if (opts.signal?.aborted) throw fail('cancelled');

    const session = new FetchSession(opts.signal, idleTimeoutMs, totalTimeoutMs);
    try {
      const resolved = await deps.access.resolveToken().catch(() => null);
      const client = new GithubClient(session, deps.fetchImpl, resolved?.token ?? null);
      const repoApi = `${API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

      let version = target.version;
      let listedSha: string | null = null;
      if (version === null) {
        const highest = await client.highestPackTag(repoApi);
        version = highest.version;
        listedSha = highest.commitSha;
      }
      const tag = `pack@${version}`;

      const sha = await client.resolveCommit(repoApi, tag);
      if (listedSha !== null && listedSha !== sha) throw fail('tagMoved');

      const manifest = await client.readManifest(repoApi, sha, manifestMaxBytes);
      const expectedManifestSha256 = createHash('sha256').update(manifest).digest('hex');

      const download = await client.downloadTarball(repoApi, sha, opts);
      return {
        archivePath: opts.destPath,
        resolvedRef: `${tag} ${sha}`,
        archiveIntegrity: `sha256:${download.sha256}`,
        expectedManifestSha256,
        bytes: download.bytes,
      };
    } catch (error) {
      throw session.toFetchError(error, 'network');
    } finally {
      session.dispose();
    }
  };
}

// ---------------------------------------------------------------- source

interface PackTarget {
  owner: string;
  repo: string;
  /** `major.minor.patch`, or null for "highest pack@ tag". */
  version: string | null;
}

function parsePackSource(source: unknown): PackTarget | null {
  if (typeof source !== 'string') return null;
  const match = SOURCE_RE.exec(source);
  if (!match) return null;
  const [, owner, repo, version] = match;
  if (!owner || !repo || repo === '.' || repo === '..') return null;
  if (version === undefined) return { owner, repo, version: null };
  if (!VERSION_RE.test(version)) return null;
  return { owner, repo, version };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => BigInt(part));
  const pb = b.split('.').map((part) => BigInt(part));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0n;
    const y = pb[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------- session

type AbortReason = 'caller' | 'idle' | 'total';

/** One fetch's cancellation: caller signal, idle timer and total-time cap, folded into one AbortSignal. */
class FetchSession {
  private readonly controller = new AbortController();
  private reason: AbortReason | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private readonly onCallerAbort = () => this.abort('caller');

  constructor(
    private readonly callerSignal: AbortSignal | undefined,
    private readonly idleTimeoutMs: number,
    totalTimeoutMs: number,
  ) {
    callerSignal?.addEventListener('abort', this.onCallerAbort, { once: true });
    this.totalTimer = setTimeout(() => this.abort('total'), totalTimeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Re-arm the idle timer: call before every request and after every chunk. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.abort('idle'), this.idleTimeoutMs);
  }

  /**
   * Settle with `work`, or reject as soon as the session aborts, even when the
   * underlying fetch or body read ignores its signal. A late `work` result is
   * dropped; a late response body is cancelled.
   */
  race<T>(work: Promise<T>): Promise<T> {
    this.throwIfAborted();
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error('aborted'));
        work.then(
          (late) => {
            if (late instanceof Response) discardBody(late);
          },
          () => undefined,
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** Throws the abort's PackFetchError when the session has been aborted. */
  throwIfAborted(): void {
    if (this.reason) throw this.reasonError();
  }

  /** Map anything thrown inside the session to a PackFetchError, never carrying the original. */
  toFetchError(error: unknown, fallback: FailureKey): PackFetchError {
    if (error instanceof PackFetchError) return error;
    if (this.reason) return this.reasonError();
    return fail(fallback);
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    clearTimeout(this.totalTimer);
    this.callerSignal?.removeEventListener('abort', this.onCallerAbort);
  }

  private abort(reason: AbortReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }

  private reasonError(): PackFetchError {
    if (this.reason === 'idle') return fail('idleTimeout');
    if (this.reason === 'total') return fail('totalTimeout');
    return fail('cancelled');
  }
}

// ---------------------------------------------------------------- client

class GithubClient {
  constructor(
    private readonly session: FetchSession,
    private readonly fetchImpl: typeof fetch | undefined,
    private readonly token: string | null,
  ) {}

  async highestPackTag(repoApi: string): Promise<{ version: string; commitSha: string | null }> {
    let best: { version: string; commitSha: string | null } | null = null;
    for (let page = 1; ; page++) {
      const { res, url } = await this.get(`${repoApi}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`, ACCEPT_JSON);
      this.ensureOk(res, url);
      const hasNext = hasNextPage(res);
      const body = await readCapped(res, TAGS_PAGE_MAX_BYTES, this.session, 'badResponse');
      const entries = parseTagsPage(body);
      if (!entries) throw fail('badResponse');
      for (const entry of entries) {
        const version = PACK_TAG_RE.exec(entry.name)?.[1];
        if (!version || !VERSION_RE.test(version)) continue;
        if (!best || compareVersions(version, best.version) > 0) {
          best = { version, commitSha: entry.commitSha };
        }
      }
      if (!hasNext) break;
      // Fail only when the cap is reached and GitHub still says there is more.
      if (page >= MAX_TAG_PAGES) throw fail('tooManyTags');
    }
    if (!best) throw fail('noPackTag');
    return best;
  }

  async resolveCommit(repoApi: string, tag: string): Promise<string> {
    // refs/tags/ pins the lookup to the tag; a bare name would also match a branch.
    const { res, url } = await this.get(`${repoApi}/commits/refs/tags/${encodeURIComponent(tag)}`, ACCEPT_SHA);
    if (res.status === 422) {
      discardBody(res);
      throw fail('versionNotFound');
    }
    this.ensureOk(res, url);
    const sha = (await readCapped(res, COMMIT_SHA_MAX_BYTES, this.session, 'badCommit')).toString('utf8').trim();
    if (!COMMIT_SHA_RE.test(sha)) throw fail('badCommit');
    return sha;
  }

  async readManifest(repoApi: string, sha: string, maxBytes: number): Promise<Buffer> {
    const { res, url } = await this.get(`${repoApi}/contents/pack.json?ref=${sha}`, ACCEPT_RAW);
    this.ensureOk(res, url);
    return readCapped(res, maxBytes, this.session, 'manifestTooLarge');
  }

  async downloadTarball(
    repoApi: string,
    sha: string,
    opts: GithubPackFetchOptions,
  ): Promise<{ sha256: string; bytes: number }> {
    const { res, url } = await this.get(`${repoApi}/tarball/${sha}`, ACCEPT_JSON);
    this.ensureOk(res, url);
    const declared = contentLength(res);
    if (declared !== null && declared > opts.maxBytes) {
      discardBody(res);
      throw fail('archiveTooLarge');
    }
    return streamToFile(res, declared, opts, this.session);
  }

  /** GET with manual redirects. Authorization only on the api.github.com origin. Returns the final hop's URL too. */
  private async get(startUrl: string, accept: string): Promise<{ res: Response; url: URL }> {
    let current = new URL(startUrl);
    for (let redirects = 0; ; redirects++) {
      this.session.throwIfAborted();
      this.session.touch();
      let res: Response;
      try {
        res = await this.session.race(
          safeExternalFetch(
            current.href,
            { method: 'GET', headers: this.headersFor(current, accept), redirect: 'manual', signal: this.session.signal },
            this.fetchImpl,
          ),
        );
      } catch (error) {
        throw this.session.toFetchError(error, 'network');
      }
      if (!REDIRECT_STATUSES.has(res.status)) return { res, url: current };

      const location = res.headers.get('location');
      discardBody(res);
      if (redirects >= MAX_REDIRECTS || !location) throw fail('redirectRefused');
      const next = allowedRedirect(location, current);
      if (!next) throw fail('redirectRefused');
      current = next;
    }
  }

  private headersFor(url: URL, accept: string): Record<string, string> {
    if (url.origin !== API_ORIGIN) return { 'User-Agent': USER_AGENT };
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * 200 passes. On api.github.com, 401/403/404 → AUTH_REQUIRED, except a 403
   * that is a rate limit (`x-ratelimit-remaining: 0` or `retry-after`). A 4xx
   * from any other origin (an expired codeload link) is FETCH_FAILED, since
   * the token was never sent there. Everything else → FETCH_FAILED.
   */
  private ensureOk(res: Response, url: URL): void {
    if (res.status === 200) return;
    discardBody(res);
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null));
    if (rateLimited) throw fail('rateLimited');
    if (url.origin !== API_ORIGIN) {
      throw fail(res.status >= 400 && res.status < 500 ? 'downloadLinkFailed' : 'upstream');
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) throw fail(this.token ? 'denied' : 'noAccess');
    throw fail('upstream');
  }
}

function allowedRedirect(location: string, current: URL): URL | null {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== 'https:') return null;
  if (next.port !== '' || next.username !== '' || next.password !== '') return null;
  if (!ALLOWED_HOSTS.has(next.hostname)) return null;
  return next;
}

/** True when the response's `Link` header has a rel="next" entry. */
function hasNextPage(res: Response): boolean {
  const link = res.headers.get('link');
  if (!link) return false;
  return link.split(',').some((part) => /;\s*rel="?(?:[^"]*\s)?next(?:\s[^"]*)?"?\s*(?:;|$)/i.test(part));
}

function parseTagsPage(body: Buffer): { name: string; commitSha: string | null }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: { name: string; commitSha: string | null }[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const record = item as { name?: unknown; commit?: { sha?: unknown } | null };
    if (typeof record.name !== 'string') return null;
    const sha = record.commit && typeof record.commit === 'object' ? record.commit.sha : undefined;
    entries.push({ name: record.name, commitSha: typeof sha === 'string' && COMMIT_SHA_RE.test(sha) ? sha : null });
  }
  return entries;
}

// ---------------------------------------------------------------- bodies

function contentLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/** Read one chunk, rejecting as soon as the session aborts even if the body never settles. */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  session: FetchSession,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  return session.race(reader.read());
}

/** Buffer a small body (tags page, commit sha, pack.json) under `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, session: FetchSession, overflow: FailureKey): Promise<Buffer> {
  const declared = contentLength(res);
  if (declared !== null && declared > maxBytes) {
    discardBody(res);
    throw fail(overflow);
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      session.touch();
      const { done, value } = await readChunk(reader, session);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw fail(overflow);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw session.toFetchError(error, 'network');
  }
  return Buffer.concat(chunks, total);
}

/** Stream the tarball to a new 0600 file, hashing as it writes; delete it on any failure. */
async function streamToFile(
  res: Response,
  declared: number | null,
  opts: GithubPackFetchOptions,
  session: FetchSession,
): Promise<{ sha256: string; bytes: number }> {
  let handle: FileHandle;
  try {
    // 'wx' = O_CREAT | O_EXCL: never follow or reuse an existing path.
    handle = await fsp.open(opts.destPath, 'wx', 0o600);
  } catch {
    discardBody(res);
    throw fail('writeFailed');
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let reported = 0;
  let closed = false;
  const reader = res.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        session.touch();
        const { done, value } = await readChunk(reader, session);
        if (done) break;
        if (bytes + value.byteLength > opts.maxBytes) throw fail('archiveTooLarge');
        await writeFully(handle, value);
        hash.update(value);
        bytes += value.byteLength;
        if (opts.onProgress && bytes - reported >= PROGRESS_STEP_BYTES) {
          reported = bytes;
          reportProgress(opts, bytes, declared);
        }
      }
    }
    if (declared !== null && bytes !== declared) throw fail('upstream');
    await handle.close();
    closed = true;
    if (opts.onProgress && reported !== bytes) reportProgress(opts, bytes, declared);
    return { sha256: hash.digest('hex'), bytes };
  } catch (error) {
    reader?.cancel().catch(() => undefined);
    if (!closed) await handle.close().catch(() => undefined);
    await fsp.rm(opts.destPath, { force: true }).catch(() => undefined);
    throw session.toFetchError(error, 'network');
  }
}

function reportProgress(opts: GithubPackFetchOptions, bytes: number, declared: number | null): void {
  if (declared !== null) opts.onProgress?.(bytes, declared);
  else opts.onProgress?.(bytes);
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset));
    } catch {
      throw fail('writeFailed');
    }
    if (bytesWritten <= 0) throw fail('writeFailed');
    offset += bytesWritten;
  }
}
