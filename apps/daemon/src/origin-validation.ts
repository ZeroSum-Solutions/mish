import { isPluginFontAssetExtension } from './plugins/asset-content-types.js';

export interface ParsedHostHeader {
  hostname: string;
  host: string;
  port: string;
}

export interface RequestWithOriginHeaders {
  headers?: {
    host?: unknown;
    origin?: unknown;
    'sec-fetch-site'?: unknown;
  };
}

/** Only font GETs may cross the opaque-origin preview boundary. The static
 * route still authorizes the resource and checks the manifest allowlist. */
export function isSandboxDesignSystemFontRead(method: string, routePath: string, assetPath: unknown): boolean {
  if (method !== 'GET') return false;
  // Query form: /design-systems/:id/static?path=fonts/…
  // Path form:  /design-systems/:id/static/fonts/… (segments percent-decoded
  // one at a time; a segment that decodes to a separator is refused).
  let candidate: unknown;
  if (/^\/design-systems\/[^/]+\/static$/.test(routePath)) {
    candidate = assetPath;
  } else {
    const pathForm = /^\/design-systems\/[^/]+\/static\/(.+)$/.exec(routePath);
    if (!pathForm) return false;
    try {
      const segments = (pathForm[1] ?? '').split('/').map((segment) => decodeURIComponent(segment));
      if (segments.some((segment) => /[\\/]/.test(segment))) return false;
      candidate = segments.join('/');
    } catch {
      return false;
    }
  }
  return typeof candidate === 'string' && /^fonts\/(?:[\w.-]+\/)*[\w.-]+\.(?:woff2?|ttf|otf)$/i.test(candidate) &&
    !candidate.split('/').some((part) => part === '.' || part === '..');
}

/**
 * Origin: null font reads from bundled official plugins. A sandboxed plugin
 * preview has an opaque origin, so its `@font-face` fetch for a font shipped
 * in the plugin arrives with `Origin: null`. Only GET/HEAD of a font-extension
 * asset (`/plugins/:id/asset/<path>`, `routePath` mount-relative) of a plugin
 * that `isBundledPlugin` confirms passes. User, workspace and team plugins can
 * bundle licensed fonts, so they get no opaque-origin access. The asset route
 * re-checks the resolved plugin before it echoes CORS.
 */
export function isSandboxPluginFontRead(
  method: string,
  routePath: string,
  isBundledPlugin: (pluginId: string) => boolean,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const match = /^\/plugins\/([^/]+)\/asset\/(.+)$/.exec(routePath);
  if (!match) return false;
  let pluginId: string;
  let segments: string[];
  try {
    pluginId = decodeURIComponent(match[1] ?? '');
    segments = (match[2] ?? '').split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return false;
  }
  if (!pluginId || /[\\/]/.test(pluginId)) return false;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) {
    return false;
  }
  const base = segments[segments.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  if (!isPluginFontAssetExtension(base.slice(dot))) return false;
  return isBundledPlugin(pluginId);
}

/** Fail startup on an invalid allowlist rather than accepting only part of it. See docs/daemon-errors.md. */
export function configuredAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OD_ALLOWED_ORIGINS || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch (cause) {
        throw new Error(`OD_ALLOWED_ORIGINS has an invalid entry ${JSON.stringify(origin)}: expected a valid absolute URL`, { cause });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`OD_ALLOWED_ORIGINS has an invalid entry ${JSON.stringify(origin)}: only supports http:// and https:// origins`);
      }
      return parsed.origin;
    });
}

export function configuredAllowedHosts(origins = configuredAllowedOrigins()): string[] {
  return origins.map((origin) => new URL(origin).host);
}

// Issue #3225 — operator-declared allowlist of internal hosts that are exempt
// from the default-deny SSRF guard for USER-CONFIGURED provider endpoints (an
// internally-hosted LiteLLM/Ollama on an RFC1918 address reachable only over
// VPN). Comma- or whitespace-separated; each entry may be a bare host
// (`10.0.0.5`), `host:port`, or a full URL — only the hostname is retained,
// since the SSRF block is host-based. IPv6 literals must be bracketed
// (`[fd00::1]` or `[fd00::1]:4000`) so the port is unambiguous; the brackets
// are stripped here so the result compares directly against a resolved
// address. An empty/unset value yields `[]`, preserving the strict default
// for every deployment that does not opt in.
//
// A malformed entry — or CIDR notation, which the host-based matcher cannot
// honor — is dropped with a warning rather than silently trusted, so a typo
// can never quietly widen (or quietly fail to widen) the guard. This list is
// threaded ONLY into the user-configured-endpoint validators, never the
// attacker-controllable asset-download guard (`assertExternalAssetUrl`).
export function configuredAllowedInternalHosts(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): string[] {
  const raw = env.OD_ALLOWED_INTERNAL_HOSTS || '';
  if (!raw.trim()) return [];
  const hosts: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const entry = part.trim();
    if (!entry) continue;
    // A bare `10.0.0.0/24` parses as host `10.0.0.0` + path `/24`, so keeping
    // it would silently trust a single network address the operator never
    // meant. Reject loudly. (A full URL whose path happens to look numeric
    // still carries a scheme, so exclude those from the CIDR heuristic.)
    if (!entry.includes('://') && /^[^/]+\/\d{1,3}$/.test(entry)) {
      warn(
        `[ssrf] ignoring CIDR entry in OD_ALLOWED_INTERNAL_HOSTS: ${JSON.stringify(entry)} — list individual hosts instead`,
      );
      continue;
    }
    let hostname = '';
    try {
      const url = new URL(entry.includes('://') ? entry : `http://${entry}`);
      hostname = url.hostname.toLowerCase();
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }
    } catch {
      hostname = '';
    }
    if (!hostname) {
      warn(
        `[ssrf] ignoring malformed OD_ALLOWED_INTERNAL_HOSTS entry: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    hosts.push(hostname);
  }
  return hosts;
}

export function allowedBrowserPorts(
  port: number | string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const ports = [];
  const primary = Number(port);
  if (primary) ports.push(primary);
  const webPort = Number(env.OD_WEB_PORT);
  if (webPort && webPort !== primary) ports.push(webPort);
  return ports;
}

export function parseHostHeader(value: unknown): ParsedHostHeader | null {
  const raw = String(headerValue(value) || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    return { hostname: parsed.hostname, host: parsed.host, port: parsed.port || '80' };
  } catch {
    return null;
  }
}

export function isPrivateIpv4(hostname: unknown): boolean {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isIpLiteralHostname(hostname: unknown): boolean {
  const host = String(hostname || '').trim();
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d+$/.test(part))) return false;
  return parts.map(Number).every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

export function isLoopbackOrPrivateLanHost(hostname: unknown): boolean {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host === '::' ||
    isPrivateIpv4(host)
  );
}

export function isAllowedBrowserHost(
  hostHeader: unknown,
  ports: number[],
  bindHost: string,
  extraAllowedOrigins: string[],
): boolean {
  const requestHost = parseHostHeader(hostHeader);
  if (!requestHost) return false;

  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  const explicitHosts = new Set([
    ...ports.flatMap((p) => [
      ...loopbackHosts.map((h) => `${h}:${p}`),
      `${bindHost}:${p}`,
    ]),
    ...configuredAllowedHosts(extraAllowedOrigins),
  ]);
  if (explicitHosts.has(requestHost.host)) return true;

  if (!ports.map(String).includes(requestHost.port)) return false;
  return isLoopbackOrPrivateLanHost(requestHost.hostname);
}

export function isAllowedBrowserOrigin(
  origin: unknown,
  hostHeader: unknown,
  ports: number[],
  bindHost: string,
  extraAllowedOrigins: string[],
): boolean {
  if (extraAllowedOrigins.includes(String(origin))) return true;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(String(origin));
  } catch {
    return false;
  }
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') return false;

  const requestHost = parseHostHeader(hostHeader);
  if (!requestHost) return false;

  const schemes = ['http', 'https'];
  const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
  const explicitOrigins = new Set(
    ports.flatMap((p) => [
      ...schemes.flatMap((s) => loopbackHosts.map((h) => `${s}://${h}:${p}`)),
      ...schemes.map((s) => `${s}://${bindHost}:${p}`),
    ]),
  );
  if (explicitOrigins.has(String(origin))) return true;

  const originPort = parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? '443' : '80');
  if (!ports.map(String).includes(originPort)) return false;
  if (parsedOrigin.hostname !== requestHost.hostname) return false;
  return isLoopbackOrPrivateLanHost(parsedOrigin.hostname);
}

export function isLocalSameOrigin(
  req: RequestWithOriginHeaders,
  port: number | string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const host = String(headerValue(req.headers?.host) || '');
  const origin = headerValue(req.headers?.origin);
  const ports = allowedBrowserPorts(port, env);
  const bindHost = env.OD_BIND_HOST || '127.0.0.1';
  const extraAllowedOrigins = configuredAllowedOrigins(env);
  const ipOnlyExtraOrigins = extraAllowedOrigins.filter((o) =>
    isIpLiteralHostname(new URL(o).hostname),
  );

  const localHostAllowed = isAllowedBrowserHost(host, ports, bindHost, ipOnlyExtraOrigins);
  if (origin == null || origin === '') {
    if (localHostAllowed) return true;
    // Browsers (Firefox, Chrome) omit Origin on same-origin GET subresource
    // requests per the Fetch spec, which made hostname entries in
    // OD_ALLOWED_ORIGINS unreachable for legitimate same-origin GETs
    // through a reverse proxy. Sec-Fetch-Site is set by the user agent and
    // cannot be modified by JavaScript, so a value of "same-origin"
    // attests that the request originated from the same origin as the
    // target — a cross-site `<img>`/`<script>` exploit would carry
    // "cross-site" instead. Only consult the broader allow-list once that
    // signal is present.
    const fetchSite = headerValue(req.headers?.['sec-fetch-site']);
    if (fetchSite === 'same-origin') {
      return isAllowedBrowserHost(host, ports, bindHost, extraAllowedOrigins);
    }
    return false;
  }
  // Reverse-proxy deployments (e.g. Nginx in front of the daemon) terminate
  // the browser connection at the proxy and open a fresh upstream
  // connection to the daemon. The Host header the daemon sees is the
  // proxy upstream's address, not the browser-visible origin, so the host
  // check below fails even when the user explicitly listed their proxy
  // origin in OD_ALLOWED_ORIGINS. Trust the Origin header in that case:
  // a client-supplied origin that exactly matches an explicitly allow-
  // listed entry is the documented escape hatch for these deployments.
  if (extraAllowedOrigins.includes(origin)) return true;
  if (!isAllowedBrowserHost(host, ports, bindHost, extraAllowedOrigins)) return false;
  return isAllowedBrowserOrigin(origin, host, ports, bindHost, extraAllowedOrigins);
}

function headerValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return first == null ? undefined : String(first);
  }
  return value == null ? undefined : String(value);
}

/**
 * Zero-config OD Clipper bypass for the `/api` origin middleware.
 *
 * `apiRelativePath` MUST be `req.path` as observed INSIDE `app.use('/api', …)`.
 * Express strips the mounted `/api` prefix there, so a request to
 * `/api/library/ingest` arrives as `/library/ingest`. Matching `'/library/'`
 * is therefore the correct (and only working) prefix — matching
 * `'/api/library/'` here would never fire because the mount prefix is gone.
 *
 * Returns true only for a locally-installed browser extension (an origin a web
 * page cannot forge) targeting the narrow OD Clipper bootstrap surface: the
 * dedicated probe route and the ingest endpoint. Library reads still require
 * normal same-origin / allow-list validation so an unrelated installed
 * extension cannot enumerate or download the user's library.
 */
export function isZeroConfigClipperLibraryRequest(
  method: string,
  apiRelativePath: string,
  origin: unknown,
): boolean {
  const normalizedMethod = method.toUpperCase();
  const isAllowedClipperPath =
    (normalizedMethod === 'GET' && apiRelativePath === '/library/clipper-probe') ||
    ((normalizedMethod === 'OPTIONS' || normalizedMethod === 'POST') &&
      apiRelativePath === '/library/ingest');
  if (!isAllowedClipperPath) return false;
  return (
    typeof origin === 'string' &&
    (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))
  );
}

/** Headers that can name the host a client asked for (see `requestHostRefusal`). */
export interface RequestHostHeaders {
  host?: unknown;
  'x-od-client-host'?: unknown;
  'x-forwarded-host'?: unknown;
}

/**
 * Hostnames from `OD_ALLOWED_DEV_ORIGINS` (exact names or `*.suffix`
 * wildcards), the list the web sidecar and Next dev server already accept for
 * custom development hosts. Malformed entries are skipped.
 */
export function configuredAllowedDevHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OD_ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => {
      if (entry.startsWith('*.')) return [entry];
      const parsed = parseHostHeader(entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0]);
      return parsed ? [parsed.hostname.toLowerCase()] : [];
    });
}

function matchesAllowedHost(hostname: string, allowed: string): boolean {
  if (!allowed.startsWith('*.')) return hostname === allowed;
  const suffix = allowed.slice(1);
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

/**
 * True when `hostHeader` names this daemon by a host that an attacker's DNS
 * cannot answer for: an IP literal, `localhost` / `*.localhost` (browsers
 * resolve those to loopback themselves), the configured bind host, or a host
 * the operator listed in `OD_ALLOWED_ORIGINS` / `OD_ALLOWED_DEV_ORIGINS`. The
 * port is ignored on purpose: rebinding is defeated by the name, and daemon and
 * web ports differ between dev, desktop and packaged runs.
 */
export function isRebindingSafeHost(
  hostHeader: unknown,
  bindHost: string,
  allowedHosts: string[],
): boolean {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIpLiteralHostname(hostname)) return true;
  const bind = parseHostHeader(bindHost)?.hostname.toLowerCase().replace(/\.$/, '');
  if (bind && hostname === bind) return true;
  return allowedHosts.some((allowed) => matchesAllowedHost(hostname, allowed));
}

/** Hostnames the operator allowed through `OD_ALLOWED_ORIGINS` and `OD_ALLOWED_DEV_ORIGINS`. */
export function rebindingAllowedHosts(
  extraAllowedOrigins: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const originHosts = configuredAllowedHosts(extraAllowedOrigins.filter((origin) => /^https?:\/\//i.test(origin)))
    .flatMap((host) => {
      const parsed = parseHostHeader(host);
      return parsed ? [parsed.hostname.toLowerCase()] : [];
    });
  return [...new Set([...originHosts, ...configuredAllowedDevHosts(env)])];
}

/**
 * DNS-rebinding guard. A page on `attacker.example` whose name re-resolves to
 * 127.0.0.1 is same-origin with itself, so its GETs reach the daemon with no
 * Origin header and, over plain http, no fetch metadata either; they pass the
 * Origin check. Its Host header (or, through the web sidecar or a dev rewrite
 * proxy, `X-OD-Client-Host` / `X-Forwarded-Host`) still carries the foreign
 * name, so every request must name the daemon by a rebinding-safe host.
 * Returns the refused header's name, or null when the request may proceed.
 */
export function requestHostRefusal(
  headers: RequestHostHeaders,
  bindHost: string,
  allowedHosts: string[],
): string | null {
  if (!isRebindingSafeHost(headers.host, bindHost, allowedHosts)) return 'host';
  for (const name of ['x-od-client-host', 'x-forwarded-host'] as const) {
    const raw = headers[name];
    if (raw == null) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(','));
    if (values.some((value) => !isRebindingSafeHost(value.trim(), bindHost, allowedHosts))) {
      return name;
    }
  }
  return null;
}

