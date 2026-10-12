import type { Express } from 'express';
import type { GenuiCatalogManifest, GenuiCatalogResponse } from '@open-design/contracts';
import { DEMO_CSP, demoDocument, genuiCatalog } from '@open-design/genui-catalog/data';
import { effectPreviewDocument } from './effect-preview-document.js';

/**
 * GET /api/genui/catalog — the owned GenUI component catalog manifest (catalog-design.md §E).
 *
 * The manifest comes from `@open-design/genui-catalog/data`, generated JS literals that survive
 * the daemon's esbuild prebundle. It is read-only, public-safe metadata (no source, no key), so
 * it follows the design-index taxonomy route (`GET /api/design-index/taxonomy`): no per-route
 * auth beyond the daemon's global middleware. That middleware is the `app.use('/api', ...)`
 * API-token check installed in `server.ts` (Plan §3.K1) when `apiTokenAuthEnabled` — active only
 * when `OD_API_TOKEN` is set; loopback requests (desktop UI, local CLI) bypass it, and every
 * other request must carry a matching bearer token or HTTP Basic credentials. Built component
 * assets stay out of the response; the web view renders demos from the same data module.
 */
export function registerGenuiCatalogRoutes(app: Express): void {
  const catalog: GenuiCatalogManifest = genuiCatalog.manifest;
  app.get('/api/genui/catalog', (_req, res) => {
    res.json({ catalog } satisfies GenuiCatalogResponse);
  });
  app.get('/api/genui/catalog/:id/preview', (req, res) => {
    const motion = req.query.reducedMotion;
    if (motion !== undefined && motion !== 'true' && motion !== 'false') {
      res.status(400).json({ error: { code: 'INVALID_MOTION', message: 'reducedMotion must be true or false' } });
      return;
    }
    const html = demoDocument(req.params.id, { reducedMotion: motion === 'true' });
    if (!html) {
      res.status(404).json({ error: { code: 'NO_DEMO', message: 'No live demo for this component' } });
      return;
    }
    res.setHeader('Content-Security-Policy', DEMO_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(effectPreviewDocument(html));
  });
}
