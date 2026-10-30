/**
 * Link pages (`@mish/linkpage`): build a creator's page from the places they already have online,
 * keep it, render it and export it as a site. Contract: `packages/contracts/src/api/linkpage.ts`.
 * CLI: `od linkpage …` (`../linkpage-cli.ts`).
 *
 *   POST   /api/linkpages/build           build (and by default save) a page
 *   GET    /api/linkpages                 list saved pages
 *   GET    /api/linkpages/:slug           one saved page
 *   PUT    /api/linkpages/:slug           replace a saved page's spec
 *   DELETE /api/linkpages/:slug           delete a page
 *   GET    /api/linkpages/:slug/render    the page as HTML
 *   GET    /api/linkpages/:slug/export    index.html, llms.txt, links.json, spec.json, assets
 *   POST   /api/linkpages/:slug/publish   the file list ready to deploy (no host yet: published is false)
 *   PUT    /api/linkpages/:slug/assets/:name   a picture (raw body, png/jpeg/webp/gif, at most 2 MB)
 *   GET    /api/linkpages/:slug/assets/:name   the picture, so a preview resolves `assets/<name>`
 *   POST   /api/linkpages/:slug/events    a view, click or signup from local preview (local log)
 *
 * Input is checked at this boundary (slug pattern, request shape, origin); reads of other sites go
 * through the SSRF guard in `../linkpage/safe-fetch.ts`.
 */
import express from 'express';
import type { Express } from 'express';
import {
  LINKPAGE_ASSET_MAX_BYTES,
  isLinkPageAssetName,
  isLinkPageSlug,
  parseLinkPageBuildRequest,
  parseLinkPagePublishRequest,
  parseLinkPagePutRequest,
} from '@mish/contracts';
import type {
  LinkPageDeleteResponse,
  LinkPageGetResponse,
  LinkPageListResponse,
} from '@mish/contracts';
import { LinkPageError } from '../linkpage/service.js';
import type { LinkPageService } from '../linkpage/service.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterLinkPageRoutesDeps extends RouteDeps<'http'> {
  linkpage: LinkPageService;
}

/** `?origin=https://links.example.com`, the page's public address, or nothing. */
function originOf(value: unknown): string | null {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export function registerLinkPageRoutes(app: Express, ctx: RegisterLinkPageRoutesDeps): void {
  const { sendApiError } = ctx.http;
  const { linkpage } = ctx;

  const fail = (res: Parameters<typeof sendApiError>[0], error: unknown) => {
    if (error instanceof LinkPageError) return sendApiError(res, error.status, error.code, error.message);
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'link page request failed');
  };

  app.post('/api/linkpages/build', async (req, res) => {
    const parsed = parseLinkPageBuildRequest(req.body);
    if (!parsed.ok) return sendApiError(res, 400, 'BAD_REQUEST', parsed.error);
    try {
      return res.json(await linkpage.build(parsed.value));
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/api/linkpages', async (_req, res) => {
    try {
      const body: LinkPageListResponse = { pages: await linkpage.list() };
      return res.json(body);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/api/linkpages/:slug', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    try {
      const body: LinkPageGetResponse = { page: await linkpage.get(req.params.slug) };
      return res.json(body);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.put('/api/linkpages/:slug', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    const parsed = parseLinkPagePutRequest(req.body);
    if (!parsed.ok) return sendApiError(res, 400, 'BAD_REQUEST', parsed.error);
    try {
      const body: LinkPageGetResponse = { page: await linkpage.put(req.params.slug, parsed.value) };
      return res.json(body);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.delete('/api/linkpages/:slug', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    try {
      await linkpage.delete(req.params.slug);
      const body: LinkPageDeleteResponse = { slug: req.params.slug, deleted: true };
      return res.json(body);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/api/linkpages/:slug/render', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    const origin = originOf(req.query.origin);
    if (origin === null) return sendApiError(res, 400, 'BAD_REQUEST', 'origin must be an http(s) address');
    try {
      const html = await linkpage.render(req.params.slug, { origin });
      // The page runs its own script; keep it in an opaque origin so it cannot reach the daemon's.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.type('html').send(html);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.get('/api/linkpages/:slug/export', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    const origin = originOf(req.query.origin);
    if (origin === null) return sendApiError(res, 400, 'BAD_REQUEST', 'origin must be an http(s) address');
    try {
      return res.json(await linkpage.export(req.params.slug, { origin }));
    } catch (error) {
      return fail(res, error);
    }
  });

  app.post('/api/linkpages/:slug/publish', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    const parsed = parseLinkPagePublishRequest(req.body && Object.keys(req.body).length ? req.body : undefined);
    if (!parsed.ok) return sendApiError(res, 400, 'BAD_REQUEST', parsed.error);
    try {
      return res.json(await linkpage.publish(req.params.slug, parsed.value));
    } catch (error) {
      return fail(res, error);
    }
  });

  const rawImage = express.raw({ type: () => true, limit: LINKPAGE_ASSET_MAX_BYTES });
  app.put(
    '/api/linkpages/:slug/assets/:name',
    (req, res, next) => {
      if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
      if (!isLinkPageAssetName(req.params.name)) return sendApiError(res, 400, 'BAD_REQUEST', 'the file name must end .png, .jpg, .webp or .gif');
      return rawImage(req, res, (error?: unknown) => {
        if ((error as { type?: string } | undefined)?.type === 'entity.too.large') return sendApiError(res, 413, 'BAD_REQUEST', 'the picture is too large');
        return error ? next(error) : next();
      });
    },
    async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        return res.json(await linkpage.putAsset(req.params.slug!, req.params.name!, bytes, req.header('content-type') ?? ''));
      } catch (error) {
        return fail(res, error);
      }
    },
  );

  app.get('/api/linkpages/:slug/assets/:name', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    try {
      const asset = await linkpage.asset(req.params.slug, req.params.name);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.type(asset.contentType).send(asset.bytes);
    } catch (error) {
      return fail(res, error);
    }
  });

  app.post('/api/linkpages/:slug/events', async (req, res) => {
    if (!isLinkPageSlug(req.params.slug)) return sendApiError(res, 400, 'BAD_REQUEST', 'slug must be lowercase letters, numbers and dashes');
    try {
      return res.json(await linkpage.recordEvent(req.params.slug, req.body));
    } catch (error) {
      return fail(res, error);
    }
  });
}
