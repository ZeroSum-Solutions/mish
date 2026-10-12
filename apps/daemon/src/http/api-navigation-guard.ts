import type { NextFunction, Request, Response } from 'express';

/**
 * R07 round 3 (Sol r2 BLOCK): a preview document can navigate its own frame
 * (a meta refresh, a `location` assignment, a link) and nothing in its CSP
 * stops that, so it could replace its sandboxed srcdoc with an /api response
 * that carries none of the preview floor policy. The daemon is the one party
 * a preview cannot bypass, so it refuses a frame or document navigation to
 * /api that another site started.
 *
 * "Another site" is what the user agent reports in Sec-Fetch-Site, which page
 * script cannot set: `cross-site` or `same-site`. A sandboxed (opaque-origin)
 * frame always reports `cross-site`. Same-origin navigations (the app framing
 * its own routes), user-initiated ones (`none`: typed URL, bookmark),
 * requests without fetch metadata (CLI, API clients) and every non-navigation
 * request (fetch, XHR, subresources) are left to the existing guards.
 *
 * Exempt are the routes that are meant to be reached by such a navigation:
 * OAuth callbacks (the provider redirects there), the scoped project preview
 * base, raw and powered project documents (multi-page prototypes link between
 * their pages; SEC-1 already forces an opaque sandbox on them), and the
 * preview document routes the workbench and viewers frame. They render
 * preview content, never the JSON of other API routes. SEC-1's guards
 * (powered origin refusal, cross-site navigation sandbox, opaque-origin
 * read limits) run unchanged after this one.
 */
const NAVIGABLE_API_ROUTES: readonly RegExp[] = [
  /^\/mcp\/oauth\/callback$/u,
  /^\/connectors\/oauth\/callback\/[^/]+$/u,
  /^\/projects\/[^/]+\/(?:raw|powered)\/.+$/u,
  /^\/projects\/[^/]+\/preview\/[^/]+\/.+$/u,
  /^\/projects\/[^/]+\/files\/[^/]+\/preview$/u,
  /^\/design-systems\/[^/]+\/(?:preview|showcase|static(?:\/.+)?)$/u,
  /^\/plugins\/[^/]+\/(?:preview|example\/[^/]+)$/u,
  /^\/skills\/[^/]+\/example$/u,
  /^\/genui\/catalog\/[^/]+\/preview$/u,
  /^\/sections\/[^/]+\/preview$/u,
  /^\/cult\/(?:preview\/[^/]+(?:\/frame)?|catalog\/[^/]+\/preview|21st\/[^/]+\/(?:preview|reference-preview))$/u,
  /^\/live-artifacts\/[^/]+\/preview$/u,
  /^\/library\/assets\/[^/]+\/preview$/u,
  /^\/workbench\/resources\/[^/]+\/preview$/u,
  /^\/workbench\/recipes\/gsap\/[^/]+\/preview$/u,
  /^\/workbench\/fonts\/specimen$/u,
];
const NAVIGATION_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] == null ? undefined : String(value[0]);
  return value == null ? undefined : String(value);
}

/** Whether `apiRelativePath` (inside `app.use('/api', …)`) may be reached by a navigation another site started. */
export function isNavigableApiRoute(apiRelativePath: string): boolean {
  return NAVIGABLE_API_ROUTES.some(route => route.test(apiRelativePath));
}

/** A frame or document navigation that a different site (or an opaque-origin frame) started. */
export function isForeignApiNavigation(headers: Request['headers']): boolean {
  const mode = first(headers['sec-fetch-mode']);
  const site = first(headers['sec-fetch-site']);
  const dest = first(headers['sec-fetch-dest']);
  return (mode === 'navigate' || mode === 'nested-navigate')
    && (site === 'cross-site' || site === 'same-site')
    && dest !== undefined && NAVIGATION_DESTINATIONS.has(dest);
}

/** Mount on `/api` before the routes (and before SEC-1's navigation sandbox). */
export function createApiNavigationGuard() {
  return function apiNavigationGuard(req: Request, res: Response, next: NextFunction): void {
    if (!isForeignApiNavigation(req.headers) || isNavigableApiRoute(req.path)) return next();
    res.status(403);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'no-store');
    res.end('This API route cannot be opened by a navigation from another site or a sandboxed preview.\n');
  };
}
