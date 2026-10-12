import type { Express, Response } from 'express';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import { GSAP_PREVIEW_CSP, GsapRuntimeError, type GsapRecipeMaterials } from '../workbench/recipes/gsap/index.js';

export interface RegisterWorkbenchRecipeRoutesDeps {
  http: { sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown };
  gsap: GsapRecipeMaterials;
}

/**
 * AC-R08.5 isolated recipe preview. The response is a self-contained HTML
 * document (pinned runtime inline) served with a policy that forbids every
 * network fetch, so the web adapter renders it in its sandboxed srcDoc frame
 * and `od workbench recipe preview` writes the same bytes. Only HTML items
 * have a preview; a React item has no substitute rendering.
 */
export function registerWorkbenchRecipeRoutes(app: Express, deps: RegisterWorkbenchRecipeRoutesDeps): void {
  const { http, gsap } = deps;
  app.get('/api/workbench/recipes/gsap/:itemId/preview', async (req, res) => {
    const local = validateLocalDaemonRequest(req);
    if (!local.ok) return http.sendApiError(res, 403, 'FORBIDDEN', local.message, { details: local.details });
    try {
      const html = await gsap.preview(req.params.itemId);
      if (html === null) return http.sendApiError(res, 404, 'NOT_FOUND', 'No preview exists for this recipe item', { details: { kind: 'recipe', reason: 'preview-unavailable' } });
      res.set({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': GSAP_PREVIEW_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      res.status(200).send(html);
    } catch (error) {
      if (error instanceof GsapRuntimeError) return http.sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', error.message, { retryable: false, details: { kind: 'recipe', reason: error.reason } });
      return http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Recipe preview failed');
    }
  });
}
