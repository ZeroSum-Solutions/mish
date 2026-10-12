import path from 'node:path';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { OWNED_IMPORT_LIMITS } from '@mish/contracts';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { OwnedImportError, type OwnedImportStore } from '../workbench/owned-imports/owned-imports.js';

export interface RegisterWorkbenchOwnedImportRoutesDeps {
  store: OwnedImportStore;
  http: {
    sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown;
    isLocalSameOrigin: (req: Request, port: number) => boolean;
    resolvedPortRef: { current: number };
  };
}

/**
 * The largest JSON body a valid import can be: the advertised file bytes as
 * base64 (4/3, padded per file), every file's path at its 500-character cap in
 * up to 3 UTF-8 bytes per character with its keys, and a fixed envelope for
 * name, entry and ownership. The contract refuses anything larger after parse.
 */
export const OWNED_IMPORT_JSON_LIMIT_BYTES = Math.ceil(OWNED_IMPORT_LIMITS.bytes / 3) * 4
  + OWNED_IMPORT_LIMITS.files * (4 + 3 * 500 + 64)
  + 16 * 1024;
/**
 * Mounted by server.ts on /api/workbench/imports BEFORE the global 4mb JSON
 * parser (express.json is a no-op once a body is read); otherwise an import
 * near the advertised limit is refused before this route runs.
 */
export const ownedImportJsonParser: RequestHandler = express.json({ limit: OWNED_IMPORT_JSON_LIMIT_BYTES });

const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/**
 * AC-R12.4 owned-prototype imports: POST/GET /api/workbench/imports, GET /:id (reopen)
 * and GET /:id/files/<path> (isolated preview). The principal is server-derived (the
 * local owner, or the paired workspace member); imports are private to it.
 * Preview bytes are sandboxed: CSP sandbox, nosniff, no credentials, never inline on
 * the privileged origin with script authority.
 */
export function registerWorkbenchOwnedImportRoutes(app: Express, deps: RegisterWorkbenchOwnedImportRoutesDeps): void {
  const principal = (req: Request, res: Response): string | null => {
    if (!deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) { deps.http.sendApiError(res, 403, 'FORBIDDEN', 'Cross-origin request rejected'); return null; }
    const authority = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!authority.ok) { deps.http.sendApiError(res, authority.status, authority.code, authority.message); return null; }
    return authority.context ? `member:${authority.context.workspaceMemberId}` : 'local-owner';
  };
  const fail = (res: Response, error: unknown) => {
    if (error instanceof OwnedImportError) return deps.http.sendApiError(res, error.status, error.status === 400 ? 'BAD_REQUEST' : error.status === 404 ? 'NOT_FOUND' : 'PAYLOAD_TOO_LARGE', error.message, { details: { reason: error.code } });
    return deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Import request failed');
  };
  app.post('/api/workbench/imports', (req, res) => {
    const who = principal(req, res); if (!who) return;
    try { res.status(201).json(deps.store.create(who, req.body)); } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/imports', (req, res) => {
    const who = principal(req, res); if (!who) return;
    try { res.json({ imports: deps.store.list(who) }); } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/imports/:id', (req, res) => {
    const who = principal(req, res); if (!who) return;
    try { res.json(deps.store.read(who, String(req.params.id))); } catch (error) { fail(res, error); }
  });
  app.get(/^\/api\/workbench\/imports\/(import-[a-f0-9]{16})\/files\/(.+)$/u, (req, res) => {
    const who = principal(req, res); if (!who) return;
    try {
      const id = String(req.params[0]);
      // Express already decoded the captured path once; decoding again would turn a stored
      // `page%20v1.html` into `page v1.html` and serve (or miss) the wrong file.
      const file = String(req.params[1]);
      const bytes = deps.store.file(who, id, file);
      res.set({
        'Content-Type': PREVIEW_TYPES[path.posix.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      });
      res.send(bytes);
    } catch (error) { fail(res, error); }
  });
}
