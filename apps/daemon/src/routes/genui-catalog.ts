import type { Express } from 'express';
import type { GenuiCatalogManifest, GenuiCatalogResponse } from '@mish/contracts';
import { DEMO_CSP, demoDocument, genuiCatalog } from '@mish/genui-catalog/data';
import { effectPreviewDocument } from './effect-preview-document.js';
import { mishPackGeneration, packGenuiDemo, packGenuiEntries } from '../mish-packs/overlay.js';

/**
 * GET /api/genui/catalog — the owned GenUI component catalog manifest (catalog-design.md §E).
 *
 * The manifest comes from `@mish/genui-catalog/data`, generated JS literals that survive
 * the daemon's esbuild prebundle. It is read-only, public-safe metadata (no source, no key), so
 * it follows the design-index taxonomy route (`GET /api/design-index/taxonomy`): no per-route
 * auth beyond the daemon's global middleware. That middleware is the `app.use('/api', ...)`
 * API-token check installed in `server.ts` (Plan §3.K1) when `apiTokenAuthEnabled` — active only
 * when `OD_API_TOKEN` is set; loopback requests (desktop UI, local CLI) bypass it, and every
 * other request must carry a matching bearer token or HTTP Basic credentials. Built component
 * assets stay out of the response; the web view renders demos from the same data module.
 */
export function registerGenuiCatalogRoutes(app: Express): void {
  // The bundled manifest, plus the entries an installed Mish pack adds (a pack never replaces a
  // bundled entry). Rebuilt when the set of packs changes.
  let merged: { generation: number; catalog: GenuiCatalogManifest } | null = null;
  const currentCatalog = (): GenuiCatalogManifest => {
    const generation = mishPackGeneration();
    if (merged?.generation === generation) return merged.catalog;
    const bundled: GenuiCatalogManifest = genuiCatalog.manifest;
    const extra = packGenuiEntries();
    let catalog = bundled;
    if (extra.length > 0) {
      const ids = new Set(bundled.components.map((entry) => entry.id));
      const added = extra.filter((entry) => typeof entry.id === 'string' && !ids.has(entry.id as string));
      catalog = { ...bundled, components: [...bundled.components, ...(added as unknown as GenuiCatalogManifest['components'])] };
    }
    merged = { generation, catalog };
    return catalog;
  };
  app.get('/api/genui/catalog', (_req, res) => {
    res.json({ catalog: currentCatalog() } satisfies GenuiCatalogResponse);
  });
  app.get('/api/genui/catalog/:id/preview', (req, res) => {
    const motion = req.query.reducedMotion;
    if (motion !== undefined && motion !== 'true' && motion !== 'false') {
      res.status(400).json({ error: { code: 'INVALID_MOTION', message: 'reducedMotion must be true or false' } });
      return;
    }
    const html = demoDocument(req.params.id, { reducedMotion: motion === 'true' }) ?? packGenuiDemo(req.params.id);
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
