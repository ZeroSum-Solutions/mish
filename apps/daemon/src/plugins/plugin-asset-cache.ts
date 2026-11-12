// Local disk cache + same-origin proxy for the *external* images and videos
// that plugin preview HTML (example.html) references on cross-border CDNs
// (res.cloudinary.com, images.higgs.ai, motionsites.ai, Cloudflare, ...).
//
// Two problems this solves for the marketplace card + plugin-detail preview:
//   1. The sandbox CSP is `img-src 'self' data: blob:; media-src 'self' ...`,
//      so absolute third-party URLs are blocked outright in the iframe.
//   2. Even when reachable, those hosts have no nearby edge for many users,
//      so each iframe re-pays multi-second cross-border latency per asset.
//
// `rewritePluginAssetUrls` (apps/daemon/src/server.ts) rewrites the matching
// URLs to `/api/asset-cache?url=<encoded>`. That route is same-origin ('self'),
// so it passes CSP, and it is served from this cache: fetched once, validated,
// stored content-addressably on disk, and replayed instantly afterwards.
//
// SSRF is the load-bearing risk here: the route fetches a caller-supplied URL.
// Every fetch goes through the daemon egress guard (`http/egress-guard.ts`,
// policy `public`): `assertSafePublicUrl` rejects non-http(s) schemes, embedded
// credentials, localhost and literal non-public IPs up front; the guard checks
// every redirect hop at URL level and pins each connection to a validating DNS
// lookup, so the address that is *validated* is the exact address the socket
// *connects to*. The address table is the shared `classifyIp`.

import { createHash } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyIp } from '@mish/contracts/api/ip-policy';

import {
  assertFetchableUrl,
  createGuardedLookup,
  EgressRefusedError,
  guardedFetch,
  type EgressRedirectMode,
} from '../http/egress-guard.js';

/** Media extensions we are willing to cache + proxy. Anything else (HTML,
 *  CSS, JS, fonts) is intentionally left alone so this surface never becomes a
 *  general-purpose open proxy. */
export const CACHEABLE_MEDIA_EXT =
  /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|m4v|ogg|mp3|wav)(?:$|[?#])/i;

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** True when `raw` is an absolute http(s) URL pointing at a media file we are
 *  willing to route through the cache. Pure + side-effect free so the URL
 *  rewriter and tests can share the exact predicate. */
export function isCacheableExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  const pathOnly = value.split(/[?#]/)[0] ?? '';
  return CACHEABLE_MEDIA_EXT.test(pathOnly) || CACHEABLE_MEDIA_EXT.test(value);
}

/** Map a cacheable external URL to its same-origin proxy URL. */
export function assetCacheRewriteUrl(raw: string): string {
  return `/api/asset-cache?url=${encodeURIComponent(raw.trim())}`;
}

/** Error carrying the HTTP status the route should surface. */
export class AssetCacheError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AssetCacheError';
    this.status = status;
  }
}

/**
 * True for any address an external CDN must never resolve to.
 *
 * Invariant: this is exactly `classifyIp(addr) !== 'public'` — loopback,
 * private, link-local, CGNAT, ULA, multicast, unspecified, every IPv6
 * transition form, and anything that is not an IP literal.
 */
export function isPrivateAddress(addr: string): boolean {
  return classifyIp(addr) !== 'public';
}

/**
 * Cheap up-front rejection: http(s) only, no embedded credentials, no
 * localhost, and no *literal* non-public IP. This is NOT the DNS-rebinding
 * guard (that is the connect-time lookup the egress guard pins) — it only
 * fast-fails the obvious cases before any socket is opened.
 *
 * Invariant: a URL passes only if `assertFetchableUrl(url, 'public')` passes;
 * every refusal is an `AssetCacheError(400)`.
 */
export function assertSafePublicUrl(raw: string): URL {
  try {
    return assertFetchableUrl(raw, 'public');
  } catch (err) {
    if (err instanceof EgressRefusedError) throw new AssetCacheError(400, assetCacheRefusalMessage(err, raw));
    throw err;
  }
}

/** Keep this module's established refusal wording (callers surface it to users). */
function assetCacheRefusalMessage(err: EgressRefusedError, raw: string): string {
  switch (err.reason) {
    case 'invalid-url':
      return 'invalid url';
    case 'scheme':
      return 'unsupported url scheme';
    case 'credentials':
      return 'url credentials are not allowed';
    case 'non-public-host': {
      let host = '';
      try {
        host = new URL(raw).hostname.toLowerCase();
      } catch {
        // unreachable: the guard parsed it
      }
      return host === 'localhost' || host.endsWith('.localhost') ? 'localhost is not allowed' : 'url points at a private address';
    }
    default:
      return err.message;
  }
}

type DnsLookupCb = typeof dnsLookupCb;

/**
 * Wrap a `dns.lookup`-shaped resolver so a non-public answer is refused.
 * Exported so the guard can be unit-tested without standing up a server.
 *
 * Invariant: this is the egress guard's `createGuardedLookup('public')`; its
 * refusal is surfaced as `AssetCacheError(400)`.
 */
export function createValidatingLookup(lookupImpl: DnsLookupCb = dnsLookupCb) {
  const guarded = createGuardedLookup('public', lookupImpl) as unknown as (
    h: string,
    o: unknown,
    c: (err: Error | null, address?: unknown, family?: number) => void,
  ) => void;
  return function validatingLookup(
    hostname: string,
    options: unknown,
    callback?: (err: Error | null, address?: unknown, family?: number) => void,
  ): void {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address?: unknown,
      family?: number,
    ) => void;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    guarded(hostname, opts, (err, address, family) => {
      if (err instanceof EgressRefusedError) return cb(new AssetCacheError(400, err.message));
      if (err) return cb(err);
      return cb(null, address, family);
    });
  };
}

export interface AssetCacheResult {
  buf: Buffer;
  contentType: string;
}

export interface PluginAssetCacheOptions {
  /** Directory the cache writes content-addressed blobs into. */
  cacheDir: string;
  /** Hard ceiling on a single asset's size. Default 64 MiB. */
  maxBytes?: number;
  /** Per-fetch timeout. Default 15s. */
  fetchTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable `dns.lookup` for the connection-time SSRF guard (tests). */
  lookupImpl?: DnsLookupCb;
}

export interface PluginAssetCache {
  get(rawUrl: string): Promise<AssetCacheResult>;
}

/** Map a caller's `init.redirect` onto the egress guard's redirect modes. */
function redirectModeFor(redirect: RequestInit['redirect']): EgressRedirectMode {
  if (redirect === 'manual') return 'return';
  if (redirect === 'error') return 'error';
  return 'follow-checked';
}

/**
 * Fetch a user-influenced external URL with SSRF protection.
 *
 * Invariant: every hop goes through `guardedFetch` with policy `public`. The
 * entry URL and every redirect `Location` are checked at URL level (Node never
 * runs the connect-time lookup for an IP literal) and every connection is
 * pinned to the validating DNS lookup. `init.redirect` maps to: `manual` →
 * the 3xx is returned (the caller re-enters this function per hop), `error` →
 * a 3xx is refused, anything else → the guard follows checked hops.
 *
 * Every daemon fetch of a user-supplied URL must route through this (or
 * `guardedFetch`) instead of a bare `fetch` that follows redirects unchecked.
 */
export async function safeExternalFetch(
  rawUrl: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSafePublicUrl(rawUrl);
  return guardedFetch(rawUrl, init, {
    policy: 'public',
    redirects: redirectModeFor(init.redirect),
    fetchImpl,
  });
}

/** Build a disk-backed cache for external preview media. Concurrent requests
 *  for the same URL share one in-flight fetch; completed fetches persist to
 *  `<cacheDir>/<sha256>` (+ `.json` sidecar) and are replayed from disk. */
export function createPluginAssetCache(opts: PluginAssetCacheOptions): PluginAssetCache {
  const cacheDir = opts.cacheDir;
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.fetchTimeoutMs ?? 15_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const inflight = new Map<string, Promise<AssetCacheResult>>();

  function keyFor(rawUrl: string): string {
    return createHash('sha256').update(rawUrl).digest('hex');
  }

  async function readFromDisk(key: string): Promise<AssetCacheResult | null> {
    const blobPath = path.join(cacheDir, key);
    const metaPath = `${blobPath}.json`;
    try {
      const [buf, metaRaw] = await Promise.all([readFile(blobPath), readFile(metaPath, 'utf8')]);
      const meta = JSON.parse(metaRaw) as { contentType?: unknown };
      const contentType =
        typeof meta.contentType === 'string' && meta.contentType ? meta.contentType : 'application/octet-stream';
      return { buf, contentType };
    } catch {
      return null;
    }
  }

  async function writeToDisk(key: string, result: AssetCacheResult): Promise<void> {
    await mkdir(cacheDir, { recursive: true });
    const blobPath = path.join(cacheDir, key);
    const tmpPath = `${blobPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, result.buf);
    await rename(tmpPath, blobPath);
    await writeFile(`${blobPath}.json`, JSON.stringify({ contentType: result.contentType }));
  }

  function resolveContentType(headerValue: string | null, url: URL): string {
    const header = (headerValue ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (/^(?:image|video|audio)\//.test(header)) return header;
    const ext = path.posix.extname(url.pathname).toLowerCase();
    const guessed = EXT_TO_MIME[ext];
    if (guessed) return guessed;
    throw new AssetCacheError(415, `unsupported content-type: ${header || 'unknown'}`);
  }

  /** Drain the body, aborting the moment the accumulated size exceeds
   *  `maxBytes`. A response without a trustworthy Content-Length must never be
   *  fully buffered first — that would turn this caller-supplied proxy into a
   *  memory-exhaustion path. */
  async function readBodyCapped(response: Response, controller: AbortController): Promise<Buffer> {
    const body = response.body;
    if (!body) {
      const ab = await response.arrayBuffer();
      if (ab.byteLength > maxBytes) throw new AssetCacheError(413, 'asset exceeds size limit');
      return Buffer.from(ab);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort(); // stop pulling more bytes from upstream
          throw new AssetCacheError(413, 'asset exceeds size limit');
        }
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // reader already closed / errored — nothing to release
      }
    }
    return Buffer.concat(chunks);
  }

  async function fetchAndStore(rawUrl: string, key: string): Promise<AssetCacheResult> {
    const url = assertSafePublicUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        // The egress guard pins the connection-time DNS check and refuses any
        // 3xx, so a validated public URL cannot redirect into private space.
        response = await guardedFetch(url, { signal: controller.signal }, {
          policy: 'public',
          redirects: 'error',
          fetchImpl,
          lookupImpl: opts.lookupImpl,
        });
      } catch (err) {
        throw new AssetCacheError(502, `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!response.ok) {
        throw new AssetCacheError(502, `upstream responded ${response.status}`);
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new AssetCacheError(413, 'asset exceeds size limit');
      }
      const contentType = resolveContentType(response.headers.get('content-type'), url);
      const buf = await readBodyCapped(response, controller);
      const result: AssetCacheResult = { buf, contentType };
      try {
        await writeToDisk(key, result);
      } catch {
        // A cache-write failure must not fail the request; serve from memory.
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(rawUrl: string): Promise<AssetCacheResult> {
    if (!isCacheableExternalUrl(rawUrl)) {
      throw new AssetCacheError(400, 'url is not a cacheable external media url');
    }
    const key = keyFor(rawUrl.trim());
    const cached = await readFromDisk(key);
    if (cached) return cached;
    const existing = inflight.get(key);
    if (existing) return existing;
    const pending = fetchAndStore(rawUrl.trim(), key).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  return { get };
}

/** Exposed for tests that need to assert the on-disk key layout. */
export function assetCacheKey(rawUrl: string): string {
  return createHash('sha256').update(rawUrl.trim()).digest('hex');
}
