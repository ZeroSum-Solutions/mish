import type { NextFunction, Request, Response } from 'express';

/**
 * The browser authority powered previews are served from: the loopback
 * spelling the daemon does NOT report (127.0.0.1 <-> localhost) on the
 * daemon's own port. See apps/web/src/runtime/powered-preview.ts.
 */
export interface PoweredPreviewAuthority {
  hostname: string;
  port: string;
}

/** Path (mount-relative to `/api`) of the only route powered documents need. */
const POWERED_FILE_ROUTE_RE = /^\/projects\/[^/]+\/powered\/.+$/u;

/** Routes that serve project files, powered bytes or run artifacts verbatim. */
const AGENT_CONTENT_PATH_RE = /^(?:\/api\/projects\/[^/]+\/(?:raw|powered)\/.+|\/artifacts\/.+)$/u;

/**
 * Applied to daemon content reached by a cross-site navigation. Scripts,
 * forms, popups and downloads keep working; `allow-same-origin` is absent, so
 * the document always gets an opaque origin.
 */
export const CROSS_SITE_NAVIGATION_SANDBOX_POLICY =
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

export function poweredPreviewAuthority(
  reportHost: string,
  port: number | null | undefined,
): PoweredPreviewAuthority | null {
  if (!port) return null;
  const host = normalizeAuthorityHostname(reportHost);
  if (host === '127.0.0.1') return { hostname: 'localhost', port: String(port) };
  if (host === 'localhost') return { hostname: '127.0.0.1', port: String(port) };
  return null;
}

/**
 * True when `origin` is the powered-preview origin.
 *
 * Invariant: agent-generated HTML runs at this origin with
 * `allow-scripts allow-same-origin`, so the origin is untrusted. A browser
 * request that carries it must never reach a daemon API handler — whatever
 * Host it targets, whichever method it uses — except the powered file route
 * on the powered host, and must never receive an
 * Access-Control-Allow-Origin echo. Hostnames are compared after the same
 * normalization the loopback checks use (case, trailing dot, brackets), and
 * both schemes match, so no spelling of the origin escapes the predicate.
 */
export function isPoweredPreviewOrigin(
  origin: unknown,
  authority: PoweredPreviewAuthority | null,
): boolean {
  if (!authority) return false;
  const raw = firstHeaderValue(origin);
  if (!raw || raw === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return normalizeAuthorityHostname(parsed.hostname) === authority.hostname && port === authority.port;
}

/** True when the Host header names the powered-preview authority. */
export function isPoweredPreviewHost(
  hostHeader: unknown,
  authority: PoweredPreviewAuthority | null,
): boolean {
  if (!authority) return false;
  const raw = firstHeaderValue(hostHeader)?.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    return normalizeAuthorityHostname(parsed.hostname) === authority.hostname &&
      (parsed.port || '80') === authority.port;
  } catch {
    return false;
  }
}

/** A powered document reading its own bytes or sibling assets. */
export function isPoweredFileRead(method: string, apiRelativePath: string): boolean {
  const normalized = method.toUpperCase();
  return (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') &&
    POWERED_FILE_ROUTE_RE.test(apiRelativePath);
}

/**
 * Whether a powered-origin request may proceed: only a powered file read on
 * the powered host. Everything else carrying the powered origin is refused.
 */
export function poweredPreviewOriginAllowed(
  req: Pick<Request, 'method' | 'path' | 'headers'>,
  authority: PoweredPreviewAuthority | null,
): boolean {
  return isPoweredPreviewHost(req.headers.host, authority) && isPoweredFileRead(req.method, req.path);
}

/**
 * True for a browser navigation started by another site (a nested frame,
 * popup or self-navigation from a document on a different origin). Fetch
 * metadata is set by the user agent and cannot be forged by page script.
 */
export function isCrossSiteBrowserNavigation(headers: Request['headers']): boolean {
  const mode = firstHeaderValue(headers['sec-fetch-mode']);
  const site = firstHeaderValue(headers['sec-fetch-site']);
  return (mode === 'navigate' || mode === 'nested-navigate') &&
    (site === 'cross-site' || site === 'same-site');
}

/**
 * True for a document load into a frame (iframe, frame, embed, object).
 *
 * Raw project URLs never grant CORS to opaque-origin documents: any opaque
 * document (any sandboxed preview, including one a powered preview nests)
 * can name any project's raw URL, so a grant there would let it read or
 * import another project's files. Embedded raw HTML therefore gets the
 * project-bound, unguessable `/projects/:id/preview/:scope/` base, which is
 * where its fonts, module scripts and script reads load from.
 */
export function isEmbeddedDocumentNavigation(headers: Request['headers']): boolean {
  const dest = firstHeaderValue(headers['sec-fetch-dest']);
  return dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
}

/**
 * True when a request looks like a browser document load (its Accept names
 * HTML) but carries no fetch metadata to say who started it.
 */
export function isUnattributedBrowserNavigation(headers: Request['headers']): boolean {
  const site = firstHeaderValue(headers['sec-fetch-site']);
  const mode = firstHeaderValue(headers['sec-fetch-mode']);
  if (site !== undefined && mode !== undefined) return false;
  return /\btext\/html\b/iu.test(firstHeaderValue(headers.accept) ?? '');
}

/** Full request paths whose bytes are project, artifact or agent output. */
export function isAgentContentPath(fullPath: string): boolean {
  return AGENT_CONTENT_PATH_RE.test(fullPath);
}

/**
 * Middleware for routes that serve project, artifact or agent bytes.
 *
 * Invariant: daemon content reached by a cross-site navigation renders with
 * an opaque origin, and so does agent content (raw, powered, /artifacts)
 * reached by a browser navigation whose initiator the fetch metadata does not
 * name. A powered preview's `allow-same-origin` sandbox flag is inherited by
 * nested frames and popups and survives self-navigation, so without this a
 * powered document could navigate to agent HTML on the app host, or to a
 * daemon page that reflects request data, and run it with the app's own
 * origin. Same-origin and user-initiated navigations are unchanged, and the
 * powered file route on the powered host keeps its origin (powered previews
 * need it). There are no other exemptions: OAuth callback pages are reached
 * cross-site by design, render untrusted query text, and report back through
 * `window.opener.postMessage`, which an opaque origin still has. The policy
 * is appended as an extra CSP at header-write time, so a route's own CSP can
 * neither drop nor replace it.
 */
export function createCrossSiteNavigationSandbox(
  getAuthority: () => PoweredPreviewAuthority | null,
) {
  return function crossSiteNavigationSandbox(req: Request, res: Response, next: NextFunction): void {
    const fullPath = `${req.baseUrl}${req.path}`;
    const needsSandbox =
      isCrossSiteBrowserNavigation(req.headers) ||
      (isUnattributedBrowserNavigation(req.headers) && isAgentContentPath(fullPath));
    if (!needsSandbox) return next();
    if (
      req.baseUrl === '/api' &&
      isPoweredPreviewHost(req.headers.host, getAuthority()) &&
      isPoweredFileRead(req.method, req.path)
    ) {
      return next();
    }
    forceOpaqueOriginSandbox(res);
    next();
  };
}

function forceOpaqueOriginSandbox(res: Response): void {
  const writeHead = res.writeHead;
  let applied = false;
  res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]) {
    if (!applied) {
      applied = true;
      const existing = this.getHeader('Content-Security-Policy');
      const policies = existing === undefined
        ? []
        : (Array.isArray(existing) ? existing.map(String) : [String(existing)]);
      this.setHeader('Content-Security-Policy', [...policies, CROSS_SITE_NAVIGATION_SANDBOX_POLICY]);
    }
    return (writeHead as (...writeArgs: unknown[]) => Response).apply(this, args);
  } as Response['writeHead'];
}

function normalizeAuthorityHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/u, '');
}

function firstHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] == null ? undefined : String(value[0]);
  return value == null ? undefined : String(value);
}
