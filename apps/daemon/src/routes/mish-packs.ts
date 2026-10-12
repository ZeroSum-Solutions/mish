// Mish packs install surface: the HTTP half that Settings -> Packs and `od packs` both call.
//
//   GET    /api/mish-packs              installed and external packs
//   POST   /api/mish-packs/install      JSON {source} (absolute path of a folder or .zip) or a
//                                       multipart upload of a .zip (field "file")
//   DELETE /api/mish-packs/:id          remove one installed pack
//   GET    /api/mish-packs/runtime      values the web app needs from the active packs
//   GET    /api/mish-packs/assets/...   style-picker preview images a pack provides
//
// Every write is local-only (`requireLocalDaemonRequest`) and a browser write from another site is
// refused. A multipart upload must carry `X-OD-Pack-Upload: 1`, a custom header that forces a CORS
// preflight. Error text is a fixed message per code plus bounded, secret-free detail.

import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';

import type { Express, NextFunction, Request, Response } from 'express';
import multer from 'multer';

import {
  MISH_PACK_LIMITS,
  mishPackEnvProblem,
  type MishPackErrorCode,
  type MishPackRuntimeResponse,
} from '@mish/contracts';

import { isMishPackError, mishPackHttpStatus } from '../mish-packs/errors.js';
import { packStyleCatalogDir } from '../mish-packs/overlay.js';
import type { MishPackStore } from '../mish-packs/store.js';
import type { RouteDeps } from '../server-context.js';

export const MISH_PACK_UPLOAD_HEADER = 'x-od-pack-upload';
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);
const STYLE_ASSET_PREFIX = '/style-catalog/v1/';
const STYLE_ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|avif|gif)$/u;
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

export interface RegisterMishPackRoutesDeps extends RouteDeps<'http'> {
  packs: Pick<MishPackStore, 'list' | 'install' | 'remove'>;
  /** Folder multer writes uploads to; created on demand and emptied after each request. */
  uploadDir: string;
  archiveMaxBytes?: number;
}

function isCrossSiteBrowserWrite(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  return site !== undefined && !ALLOWED_FETCH_SITES.has(site.trim().toLowerCase());
}

/** The message a client may see: the code's detail is already bounded and path-free by construction. */
function safeMessage(error: unknown): { code: MishPackErrorCode; message: string } {
  if (isMishPackError(error)) {
    const message = error.message.length > 400 ? `${error.message.slice(0, 400)}...` : error.message;
    return { code: error.code, message };
  }
  return { code: 'INTERNAL_ERROR', message: 'the pack operation failed' };
}

export function registerMishPackRoutes(app: Express, ctx: RegisterMishPackRoutesDeps): void {
  const { packs } = ctx;
  const local = (req: Request, res: Response, next: NextFunction) => ctx.http.requireLocalDaemonRequest(req, res, () => {
    if (isCrossSiteBrowserWrite(req)) return ctx.http.sendApiError(res, 403, 'FORBIDDEN', 'pack changes are accepted only from this app');
    next();
  });

  const fail = (res: Response, error: unknown) => {
    if (res.headersSent) return;
    const { code, message } = safeMessage(error);
    if (code === 'INTERNAL_ERROR') console.warn('[mish-packs] request failed', error instanceof Error ? error.name : 'error');
    ctx.http.sendApiError(res, mishPackHttpStatus(code), code, message);
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = path.join(ctx.uploadDir, randomUUID());
        (req as Request & { mishPackUploadDir?: string }).mishPackUploadDir = dir;
        fsp.mkdir(dir, { recursive: true }).then(() => cb(null, dir), (error) => cb(error as Error, dir));
      },
      filename: (_req, _file, cb) => cb(null, 'pack.zip'),
    }),
    limits: { fileSize: ctx.archiveMaxBytes ?? MISH_PACK_LIMITS.archiveMaxBytes, files: 1, fields: 4 },
  });

  app.get('/api/mish-packs', async (_req, res) => {
    try {
      res.json(await packs.list());
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/mish-packs/runtime', (_req, res) => {
    const origin = process.env.MISH_STYLE_PREVIEW_ORIGIN?.trim();
    const body: MishPackRuntimeResponse = {
      styleCatalogPath: packStyleCatalogDir() ? '/api/mish-packs/assets' : null,
      styleCatalogOrigin: origin && mishPackEnvProblem('MISH_STYLE_PREVIEW_ORIGIN', origin) === null ? origin : null,
    };
    res.json(body);
  });

  app.post('/api/mish-packs/install', local, async (req, res) => {
    const isMultipart = (req.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');
    if (!isMultipart) {
      const source = (req.body as { source?: unknown } | undefined)?.source;
      if (typeof source !== 'string' || source.length === 0 || source.length > 4096) {
        return ctx.http.sendApiError(res, 400, 'SOURCE_NOT_FOUND', 'send {"source": "<absolute path of a pack folder or .zip>"} as JSON');
      }
      try {
        return void res.json(await packs.install(source));
      } catch (error) {
        return fail(res, error);
      }
    }
    if (req.get(MISH_PACK_UPLOAD_HEADER) !== '1') {
      return ctx.http.sendApiError(res, 403, 'FORBIDDEN', 'a pack upload needs the X-OD-Pack-Upload header');
    }
    upload.single('file')(req, res, async (uploadError?: unknown) => {
      const file = (req as Request & { file?: { path: string } }).file;
      const dir = (req as Request & { mishPackUploadDir?: string }).mishPackUploadDir;
      // The upload folder goes before the response is sent, so a client that sees the answer never sees leftovers.
      const cleanup = async () => { if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined); };
      if (uploadError) {
        await cleanup();
        const tooLarge = (uploadError as { code?: string }).code === 'LIMIT_FILE_SIZE';
        return ctx.http.sendApiError(res, tooLarge ? 413 : 400, tooLarge ? 'TOO_LARGE' : 'INVALID_ARCHIVE', tooLarge ? 'the pack upload is larger than the size limit' : 'the pack upload could not be read');
      }
      if (!file) {
        await cleanup();
        return ctx.http.sendApiError(res, 400, 'SOURCE_NOT_FOUND', 'attach the pack as a .zip file in the "file" field');
      }
      let result;
      try {
        result = await packs.install(file.path);
      } catch (error) {
        await cleanup();
        return fail(res, error);
      }
      await cleanup();
      res.json(result);
    });
  });

  app.delete('/api/mish-packs/:id', local, async (req, res) => {
    try {
      res.json(await packs.remove(String(req.params.id ?? '')));
    } catch (error) {
      fail(res, error);
    }
  });

  // Style-picker previews: `<origin>/style-catalog/v1/<file>`, optionally behind the CDN transform
  // prefix the web client adds (`/cdn-cgi/image/<options>/`), which a local server just ignores.
  app.get(/^\/api\/mish-packs\/assets\//u, async (req, res) => {
    const dir = packStyleCatalogDir();
    const rest = req.path.slice('/api/mish-packs/assets'.length).replace(/^\/cdn-cgi\/image\/[^/]*(?=\/)/u, '');
    if (!dir || !rest.startsWith(STYLE_ASSET_PREFIX)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    let name: string;
    try {
      name = decodeURIComponent(rest.slice(STYLE_ASSET_PREFIX.length));
    } catch {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    }
    if (!STYLE_ASSET_FILE.test(name)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    const file = path.join(dir, name);
    try {
      const real = await fsp.realpath(file);
      if (path.dirname(real) !== (await fsp.realpath(dir)) || !(await fsp.stat(real)).isFile()) throw new Error('outside');
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      createReadStream(real).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    }
  });
}
