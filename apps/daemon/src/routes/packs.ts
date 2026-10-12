// Licensed packs install surface (Licensed Pack plan, Phase 1 item 2): the
// HTTP half that the web Settings → Licensed packs section and `od pack` both
// call.
//
//   GET    /api/packs                  installed packs (live registry read)
//   POST   /api/packs/install          JSON {source, force?, sha256?} or a
//                                      multipart upload; SSE progress, then
//                                      one success or error event
//   DELETE /api/packs/:id              remove one pack
//   GET    /api/packs/github-access    which GitHub token source is in effect
//   POST   /api/packs/github-access    store a pasted token ({token})
//   DELETE /api/packs/github-access    forget the pasted token
//
// A pack is a per-machine object, not a Workspace resource, so these routes
// take no Workspace headers. Every write is local-only
// (`requireLocalDaemonRequest`).
//
// Rules this module holds:
//   - Local paths must be absolute: relative and `~` paths are refused before
//     any file is read (the plugin route resolves those against the daemon's
//     cwd, which is the CLI trap this avoids). The path is realpath'd, and
//     only a .tgz/.tar.gz file or a folder is accepted.
//   - A failure before the first progress event is a JSON error with an HTTP
//     status (400/409/413/...); after it, an SSE `error` event. Clients handle
//     both.
//   - Error text is a fixed template. A message that carries a URL, an
//     absolute path or a token shape is replaced by the code's fixed message,
//     so nothing leaks even if a lower layer slips.
//   - The token appears in one place on the wire, the POST body. Nothing
//     returns it, logs it or echoes a rejected value; the status names only
//     the source.
//   - Abort on client disconnect uses `res.on('close')`, not `req.on('close')`
//     (which fires as soon as a POST body has been read).
//   - Browser cross-origin writes are refused on every write route, on top of
//     `requireLocalDaemonRequest` (which accepts any loopback Origin, so a
//     powered preview at http://localhost:P could post to 127.0.0.1:P):
//     a present `Sec-Fetch-Site` must be `same-origin` or `none`, and a
//     multipart upload must carry `X-OD-Pack-Upload: 1`, a custom header that
//     forces a CORS preflight. The CLI sends neither header and is unaffected.
//   - JSON bodies are parsed by `createPacksJsonParser()`, which server.ts
//     mounts on /api/packs before the global 4 MB parser, so a pack body is
//     capped at 64 KB. A malformed body reaches the global malformed-JSON
//     handler, which echoes nothing (the body may hold a token).

import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, promises as fsp, readSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';

import {
  classifyPackSource,
  isPackApiErrorCode,
  PACK_ARCHIVE_MAX_BYTES,
  PACK_ERROR_MESSAGES,
  PACK_INSTALL_FORM_FIELDS,
  type PackApiErrorCode,
  type PackGithubAccessStatus,
  type PackInstallEvent,
  type PackListResponse,
  type PackRemoveResponse,
} from '@mish/contracts';

import type { PackGithubAccess } from '../integrations/github-auth.js';
import { isPackError } from '../packs/manifest.js';
import { isPackId } from '../packs/registry.js';
import { toPackInstallEvent, type PackInstallInput, type PackService } from '../packs/service.js';
import type { RouteDeps } from '../server-context.js';

/** Header the web client sends on a multipart upload, so a browser must preflight it. */
export const PACK_UPLOAD_HEADER = 'x-od-pack-upload';
export const PACKS_JSON_BODY_LIMIT = '64kb';
export function createPacksJsonParser(): RequestHandler {
  return express.json({ limit: PACKS_JSON_BODY_LIMIT });
}

export type PackRoutesService = Pick<PackService, 'install' | 'remove' | 'list' | 'stagingDir' | 'isBusy'>;
export type PackRoutesGithubAccess = Pick<PackGithubAccess, 'status' | 'storePastedToken' | 'clearStoredToken'>;

export interface RegisterPackRoutesDeps extends RouteDeps<'http'> {
  packs: PackRoutesService;
  /** P1-3's token store. Without it, status is "none" and writes fail CREDENTIAL_STORE_FAILED. */
  githubAccess?: PackRoutesGithubAccess | null;
  /** Upload cap; defaults to PACK_ARCHIVE_MAX_BYTES. Tests lower it. */
  archiveMaxBytes?: number;
}

/**
 * How long an install may run without its first progress event before the
 * route opens the SSE stream anyway (so the keepalive starts). Every service
 * path emits within a few file-system calls, so pre-stream refusals (409, 400)
 * arrive as JSON well before this.
 */
const PRE_STREAM_GRACE_MS = 1_500;
const TOKEN_MAX_LENGTH = 4096;
const SOURCE_MAX_LENGTH = 4096;
const NOT_CONFIGURED: PackGithubAccessStatus = { configured: false, source: 'none' };

const HTTP_STATUS: Partial<Record<PackApiErrorCode, number>> = {
  FORBIDDEN: 403,
  PACK_NOT_FOUND: 404,
  INSTALL_IN_PROGRESS: 409,
  VERSION_CONFLICT: 409,
  CONTENT_CONFLICT: 409,
  CREDENTIAL_STORE_UNSAFE: 409,
  TOO_LARGE: 413,
  FETCH_FAILED: 502,
  RETRACT_FAILED: 500,
  INTERNAL_ERROR: 500,
  CREDENTIAL_STORE_FAILED: 500,
};

function statusFor(code: PackApiErrorCode): number {
  return HTTP_STATUS[code] ?? 400;
}

// A URL, a token shape, a control character, or an absolute path (POSIX after
// a separator, or a Windows drive path).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[a-z][a-z0-9+.-]*:\/\/|gh[pousr]_[A-Za-z0-9]|github_pat_|[\u0000-\u001f\u007f]|(?:^|[\s'"(=,])\/[^\s/]|\b[A-Za-z]:[\\/]/i;
const PRIVATE_ROOTS = [tmpdir(), homedir()].filter((root) => root.length > 1);

/** The text a client may see for `code`: the given template if it is safe, else the code's fixed message. */
export function safePackMessage(code: PackApiErrorCode, message: unknown): string {
  if (typeof message !== 'string' || message.length === 0 || message.length > 400) return PACK_ERROR_MESSAGES[code];
  if (UNSAFE_TEXT_RE.test(message) || PRIVATE_ROOTS.some((root) => message.includes(root))) return PACK_ERROR_MESSAGES[code];
  return message;
}

function safeWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings.map((warning) =>
    typeof warning === 'string' && safePackMessage('INTERNAL_ERROR', warning) === warning
      ? warning
      : 'a pack content handler reported a problem',
  );
}

function errorCodeOf(error: unknown): PackApiErrorCode {
  return isPackError(error) && isPackApiErrorCode(error.code) ? error.code : 'INTERNAL_ERROR';
}

function isGithubAccessError(error: unknown): error is { code: 'INVALID_TOKEN_FORMAT' | 'CREDENTIAL_STORE_UNSAFE' } {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'PackGithubAccessError' && (code === 'INVALID_TOKEN_FORMAT' || code === 'CREDENTIAL_STORE_UNSAFE');
}

const ARCHIVE_NAME_RE = /\.(?:tgz|tar\.gz)$/i;

/** multer hands back latin1-decoded names; recover UTF-8 when the bytes round-trip. */
function uploadLabel(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

type InstallRequestResult =
  | { ok: true; input: PackInstallInput }
  | { ok: false; message: string; code?: PackApiErrorCode };

const SIDECAR_MAX_BYTES = 4096;
const SIDECAR_DIGEST_RE = /^[0-9a-fA-F]{64}$/;

/** `<file>.sha256` beside `file` (not followed if it is a link): its digest, null when absent. */
function readSidecarDigest(file: string): { ok: true; digest: string | null } | { ok: false; message: string } {
  let fd: number;
  try {
    fd = openSync(`${file}.sha256`, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, digest: null };
    return { ok: false, message: 'the .sha256 file beside the pack archive could not be read' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SIDECAR_MAX_BYTES) {
      return { ok: false, message: 'the .sha256 file beside the pack archive does not hold a sha256 digest' };
    }
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, length).toString('utf8').trim().split(/\s+/)[0] ?? '';
    if (!SIDECAR_DIGEST_RE.test(token)) {
      return { ok: false, message: 'the .sha256 file beside the pack archive does not hold a sha256 digest' };
    }
    return { ok: true, digest: token.toLowerCase() };
  } finally {
    closeSync(fd);
  }
}

function bad(message: string): InstallRequestResult {
  return { ok: false, message };
}

/** Validate a JSON install body and resolve a local path to the thing it names. */
function installInputFromJson(body: unknown): InstallRequestResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('send {"source": "..."} as JSON');
  const { source, force, sha256 } = body as Record<string, unknown>;
  if (force !== undefined && typeof force !== 'boolean') return bad('force must be true or false');
  if (sha256 !== undefined && typeof sha256 !== 'string') return bad('sha256 must be 64 hex characters');
  if (typeof source !== 'string' || source.length === 0 || source.length > SOURCE_MAX_LENGTH) {
    return bad('source must be github:owner/repo[@version] or an absolute path');
  }
  const kind = classifyPackSource(source);
  if (kind === 'github') return { ok: true, input: { kind: 'github', source, force: force === true } };
  if (kind !== 'path' || !path.isAbsolute(source) || source.includes('\0')) {
    return bad('a local pack source must be an absolute path to a .tgz or .tar.gz file or a pack folder');
  }
  let real: string;
  let stat: ReturnType<typeof statSync>;
  try {
    real = realpathSync(source);
    stat = statSync(real);
  } catch {
    return bad('the local pack source could not be read');
  }
  const digest = typeof sha256 === 'string' ? { sha256 } : {};
  if (stat.isDirectory()) return { ok: true, input: { kind: 'folder', path: real, force: force === true, ...digest } };
  if (stat.isFile() && ARCHIVE_NAME_RE.test(real)) {
    // The extractor reads the realpath (it refuses a link), and the service
    // looks for `<realpath>.sha256`. A sidecar sits beside the path the user
    // named, so when that is a link, read its sidecar here first.
    const given = path.resolve(source);
    let sidecar: string | null = null;
    if (given !== real) {
      const read = readSidecarDigest(given);
      if (!read.ok) return read;
      sidecar = read.digest;
    }
    const explicit = typeof sha256 === 'string' ? sha256.toLowerCase() : null;
    if (explicit && sidecar && explicit !== sidecar) {
      return { ok: false, code: 'INTEGRITY_MISMATCH', message: 'the sha256 given does not match the .sha256 file beside the pack archive' };
    }
    const expected = explicit ?? sidecar;
    return {
      ok: true,
      input: {
        kind: 'archive-file',
        path: real,
        label: path.basename(source),
        force: force === true,
        ...(expected ? { sha256: expected } : {}),
      },
    };
  }
  return bad('a local pack source must be a .tgz or .tar.gz file or a pack folder');
}

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/** A browser write from another origin or site (or a powered preview) is refused; non-browser clients send no Sec-Fetch-Site. */
function isCrossSiteBrowserWrite(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  return site !== undefined && !ALLOWED_FETCH_SITES.has(site.trim().toLowerCase());
}

function parseFormBoolean(value: unknown): boolean | null {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1' || value === 'on') return true;
  return null;
}

export function registerPackRoutes(app: Express, ctx: RegisterPackRoutesDeps): void {
  const { packs } = ctx;
  const access = ctx.githubAccess ?? null;
  const archiveMaxBytes = ctx.archiveMaxBytes ?? PACK_ARCHIVE_MAX_BYTES;
  const localOnly = (req: Request, res: Response, next: NextFunction) => ctx.http.requireLocalDaemonRequest(req, res, next);
  const sameOriginOnly = (req: Request, res: Response, next: NextFunction) => {
    if (isCrossSiteBrowserWrite(req)) return sendPackError(res, 'FORBIDDEN', 'pack changes are accepted only from this app');
    next();
  };
  /** Every write route: loopback peer and host, then no cross-site browser request. */
  const local = (req: Request, res: Response, next: NextFunction) => localOnly(req, res, () => sameOriginOnly(req, res, next));

  function sendPackError(res: Response, code: PackApiErrorCode, message?: unknown): void {
    if (res.headersSent) return;
    ctx.http.sendApiError(res, statusFor(code), code, safePackMessage(code, message));
  }

  async function runInstall(res: Response, input: PackInstallInput, after?: () => Promise<void>): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let stream: { send: (event: string, data: unknown) => boolean; end: () => void } | null = null;
    const open = () => {
      if (!stream) stream = ctx.http.createSseResponse(res);
      return stream!;
    };
    const send = (event: PackInstallEvent) => {
      if (event.event === 'error') {
        open().send('error', {
          code: event.data.code,
          message: safePackMessage(event.data.code, event.data.message),
          warnings: safeWarnings(event.data.warnings),
        });
      } else if (event.event === 'success') {
        open().send('success', { ...event.data, warnings: safeWarnings(event.data.warnings) });
      } else {
        open().send('progress', event.data);
      }
    };
    const grace = setTimeout(open, PRE_STREAM_GRACE_MS);
    grace.unref?.();
    let final: PackInstallEvent;
    try {
      const result = await packs.install(
        input,
        (event) => {
          if (event.event === 'progress') send(event);
        },
        controller.signal,
      );
      final = toPackInstallEvent(result);
    } catch (error) {
      final = toPackInstallEvent(error);
    } finally {
      clearTimeout(grace);
      // Temp files go before the response ends, so a client that sees the
      // final event never sees them.
      if (after) await after().catch(() => undefined);
    }
    if (final.event === 'error') {
      const code = isPackApiErrorCode(final.data.code) ? final.data.code : 'INTERNAL_ERROR';
      if (stream) send({ event: 'error', data: { ...final.data, code } });
      else sendPackError(res, code, final.data.message);
    } else {
      send(final);
    }
    (stream as { end: () => void } | null)?.end();
  }

  // ------------------------------------------------------------ uploads

  const UPLOAD_PATHS = Symbol('packUploadPaths');
  type UploadRequest = Request & { [UPLOAD_PATHS]?: string[] };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        try {
          callback(null, packs.stagingDir());
        } catch (error) {
          callback(error as Error, '');
        }
      },
      filename: (req, _file, callback) => {
        const name = `upload-${randomUUID()}.tgz`;
        try {
          const paths = ((req as UploadRequest)[UPLOAD_PATHS] ??= []);
          paths.push(path.join(packs.stagingDir(), name));
          callback(null, name);
        } catch (error) {
          callback(error as Error, '');
        }
      },
    }),
    limits: { files: 1, fileSize: archiveMaxBytes, fields: 4, fieldSize: 1024, parts: 6, headerPairs: 100 },
  }).single(PACK_INSTALL_FORM_FIELDS.archive);

  function handleUpload(req: Request, res: Response): void {
    const removeUploads = async () => {
      const paths = (req as UploadRequest)[UPLOAD_PATHS] ?? [];
      await Promise.all(paths.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
    };
    upload(req, res, (error?: unknown) => {
      void (async () => {
        if (error) {
          await removeUploads();
          const multerCode = (error as { code?: unknown }).code;
          if (multerCode === 'LIMIT_FILE_SIZE') return sendPackError(res, 'TOO_LARGE');
          if (isPackError(error)) return sendPackError(res, errorCodeOf(error), error.message);
          return sendPackError(res, 'BAD_REQUEST', 'the upload must hold one pack archive and its sha256');
        }
        const file = req.file;
        const fields = (req.body ?? {}) as Record<string, unknown>;
        const force = parseFormBoolean(fields[PACK_INSTALL_FORM_FIELDS.force]);
        const sha256 = fields[PACK_INSTALL_FORM_FIELDS.sha256];
        if (!file) {
          await removeUploads();
          return sendPackError(res, 'BAD_REQUEST', `attach the pack archive as the "${PACK_INSTALL_FORM_FIELDS.archive}" field`);
        }
        if (force === null || (sha256 !== undefined && typeof sha256 !== 'string')) {
          await removeUploads();
          return sendPackError(res, 'BAD_REQUEST', 'force must be true or false and sha256 must be 64 hex characters');
        }
        const input: PackInstallInput = {
          kind: 'archive-file',
          path: file.path,
          label: uploadLabel(file.originalname),
          force,
          // An upload has no sidecar: a missing sha256 fails DIGEST_REQUIRED (owner decision, 2026-10-07).
          ...(typeof sha256 === 'string' && sha256.length > 0 ? { sha256 } : {}),
        };
        await runInstall(res, input, removeUploads);
      })();
    });
  }

  // ------------------------------------------------------------ packs

  app.get('/api/packs', (_req, res) => {
    const body: PackListResponse = { packs: packs.list() };
    res.json(body);
  });

  app.post('/api/packs/install', local, (req, res) => {
    if (req.is('multipart/form-data')) {
      // A custom header makes a browser preflight the upload, so a page on
      // another origin cannot send it as a CORS-simple request.
      if (req.get(PACK_UPLOAD_HEADER) !== '1') {
        return sendPackError(res, 'FORBIDDEN', 'a pack upload must come from this app');
      }
      // Refuse before multer reads a byte of a large archive.
      if (packs.isBusy()) return sendPackError(res, 'INSTALL_IN_PROGRESS');
      handleUpload(req, res);
      return;
    }
    const parsed = installInputFromJson(req.body);
    if (!parsed.ok) return sendPackError(res, parsed.code ?? 'BAD_REQUEST', parsed.message);
    void runInstall(res, parsed.input);
  });

  // ------------------------------------------------------------ GitHub access
  // Registered before DELETE /api/packs/:id, which would otherwise take it.

  async function currentStatus(): Promise<PackGithubAccessStatus> {
    if (!access) return NOT_CONFIGURED;
    try {
      const status = await access.status();
      // Re-project: only these two fields ever leave the daemon.
      return status.configured ? { configured: true, source: status.source } : NOT_CONFIGURED;
    } catch {
      return NOT_CONFIGURED;
    }
  }

  app.get('/api/packs/github-access', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await currentStatus());
  });

  app.post('/api/packs/github-access', local, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body as Record<string, unknown> | undefined;
    const token = body && typeof body === 'object' && !Array.isArray(body) ? body.token : undefined;
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
      return sendPackError(res, 'BAD_REQUEST', 'send the token as {"token": "..."}');
    }
    if (!access) return sendPackError(res, 'CREDENTIAL_STORE_FAILED');
    try {
      await access.storePastedToken(token);
    } catch (error) {
      // Fixed messages only: never the input, the store path or the error text.
      return sendPackError(res, isGithubAccessError(error) ? error.code : 'CREDENTIAL_STORE_FAILED');
    }
    res.json(await currentStatus());
  });

  app.delete('/api/packs/github-access', local, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!access) return sendPackError(res, 'CREDENTIAL_STORE_FAILED');
    try {
      await access.clearStoredToken();
    } catch (error) {
      return sendPackError(res, isGithubAccessError(error) ? error.code : 'CREDENTIAL_STORE_FAILED');
    }
    res.json(await currentStatus());
  });

  // ------------------------------------------------------------ remove

  app.delete('/api/packs/:id', local, async (req, res) => {
    const id = req.params.id;
    if (!isPackId(id)) return sendPackError(res, 'BAD_REQUEST', 'the pack id is not valid');
    try {
      const removed = await packs.remove(id);
      const body: PackRemoveResponse = { ok: true, id: removed.id, removedVersion: removed.removedVersion };
      res.json(body);
    } catch (error) {
      sendPackError(res, errorCodeOf(error), isPackError(error) ? error.message : undefined);
    }
  });
}
