import type { Express, Response } from 'express';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import { REACT95_PREVIEW_CSP, React95PreviewUnverifiedError, type React95Materials } from '../workbench/kits/react95/materials.js';

export interface RegisterWorkbenchKitRoutesDeps {
  http: { sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown };
  react95: React95Materials;
}

/**
 * AC-R17.2 isolated kit preview. The response is the self-contained document
 * the G02 React95 receipt hashed (pinned React, styled-components and the
 * template inline), served with a policy that forbids every network fetch.
 * The canvas renders it in its sandboxed srcDoc frame and
 * `od workbench recipe preview --ref <refKey>` writes the same bytes. Its theme
 * switch lives inside the document; the host chrome never changes.
 */
export function registerWorkbenchKitRoutes(app: Express, deps: RegisterWorkbenchKitRoutesDeps): void {
  const { http, react95 } = deps;
  app.get('/api/workbench/kits/react95/:itemId/preview', async (req, res) => {
    const local = validateLocalDaemonRequest(req);
    if (!local.ok) return http.sendApiError(res, 403, 'FORBIDDEN', local.message, { details: local.details });
    try {
      const html = await react95.preview(req.params.itemId);
      if (html === null) return http.sendApiError(res, 404, 'NOT_FOUND', 'No preview exists for this kit item', { details: { kind: 'kit', reason: 'preview-unavailable' } });
      res.set({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': REACT95_PREVIEW_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      res.status(200).send(html);
    } catch (error) {
      if (error instanceof React95PreviewUnverifiedError) return http.sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', error.message, { retryable: false, details: { kind: 'kit', reason: error.reason } });
      return http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Kit preview failed');
    }
  });
}
