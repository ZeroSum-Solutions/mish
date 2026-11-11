// SSRF guard for brand-extraction outbound requests. The seed/logo/imagery
// fallbacks, the primary prefetch, and the font harvester all take a
// user-supplied site URL and then follow
// sub-resource URLs (`<link rel=stylesheet>`, `@font-face src`, favicon,
// og:image, `<img>`) discovered inside the fetched HTML. Those hrefs are
// attacker-influenced, so without a guard a page can point the daemon at
// cloud-metadata (169.254.169.254), RFC1918/CGNAT, link-local, or loopback
// services — a blind (second-order) SSRF.
//
// A brand's public website is never on a private/loopback address, so we reject
// every non-public host. Unlike the shared `assertExternalAssetUrl`, this also
// blocks loopback (that guard allows it for local API providers, which is wrong
// here) and resolves the hostname so a public name that A/AAAA-records into
// private space is caught too. Redirects are followed manually with a hop limit
// and every `Location` re-validated before the next request, so ordinary
// public-to-public redirects (http->https, apex->www, CDN hops) still work while
// a public host that 3xx's into private space is refused.
//
// DNS rebinding (a name that resolves public during validation but private when
// the platform fetch re-resolves for the socket) is defeated by pinning the
// validation to the connection: `fetchExternalBrandAsset` installs a
// connection-time `lookup` (see `createValidatingLookup`) that rejects the
// socket if the resolved address is non-public, so the address we validate IS
// the address we connect to — no separate pre-validation lookup to rebind
// around. Both the per-hop check and the lookup come from the shared egress
// guard (`src/http/egress-guard.ts`, policy `public`).

import { promises as dnsPromises, lookup as dnsLookupCb } from 'node:dns';
import type { LookupFunction } from 'node:net';

import { classifyIp, parseIp } from '@mish/contracts/api/ip-policy';

import { createGuardedLookup, guardedFetch } from '../http/egress-guard.js';

/**
 * Invariant: a brand host is public only when `classifyIp` says so for an IP
 * literal; `localhost` and `*.localhost` are never public. A DNS name is not an
 * IP, so it is not "non-public" here; callers check its answers.
 */
function isNonPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (parseIp(h)) return classifyIp(h) !== 'public';
  // Shaped like an IP literal but unparseable (zone id, octal): refuse.
  return h.includes(':') || /^[0-9.]+$/.test(h);
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Throw unless `url` is an http(s) URL whose host is a public address — checked
 * both as the literal host and, for a hostname, against every DNS answer.
 * A hostname that does not resolve passes by default (the later fetch reports
 * it); `requireResolvable` refuses it instead, for callers with no fetch of
 * their own to surface that failure. `lookup` replaces the system resolver
 * (tests inject a stub so no real DNS query is made).
 */
export type PublicUrlHostLookup = (host: string) => Promise<Array<{ address: string }>>;

export async function assertPublicBrandUrl(
  url: string,
  options: { requireResolvable?: boolean; lookup?: PublicUrlHostLookup } = {},
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid brand asset url: ${String(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported brand asset protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (isNonPublicHost(host)) {
    throw new Error(`blocked non-public brand asset host: ${host}`);
  }
  if (!isIpLiteral(host)) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = options.lookup
        ? await options.lookup(host)
        : await dnsPromises.lookup(host, { all: true });
    } catch {
      if (options.requireResolvable) {
        throw new Error(`brand asset host does not resolve: ${host}`);
      }
      // Let the actual fetch surface a resolution failure rather than masking it.
      return;
    }
    if (options.requireResolvable && addresses.length === 0) {
      throw new Error(`brand asset host does not resolve: ${host}`);
    }
    for (const { address } of addresses) {
      if (isNonPublicHost(String(address))) {
        throw new Error(
          `brand asset host resolves to a non-public address: ${host} -> ${address}`,
        );
      }
    }
  }
}

type DnsLookupCb = typeof dnsLookupCb;

/**
 * Wrap a `dns.lookup`-shaped resolver so the resolved address is rejected when
 * it is non-public. Installed as the undici Agent's connection-time `lookup`, so
 * the address we validate IS the one the socket connects to — closing the
 * DNS-rebinding / TOCTOU gap that a separate pre-validation lookup leaves open
 * (an attacker-controlled name answering public for the check and private for
 * the connect). It is the egress guard's `public` lookup, so the connect-time
 * and pre-check block sets (both `classifyIp`) can't drift. Exported so the
 * guard can be unit-tested without a live server.
 */
export function createValidatingLookup(lookupImpl: DnsLookupCb = dnsLookupCb): LookupFunction {
  return createGuardedLookup('public', lookupImpl);
}

const MAX_BRAND_REDIRECTS = 5;

/**
 * Fetch a brand URL through the egress guard (`public`, redirects followed and
 * re-checked per hop, at most 5, DNS answers pinned at connect time).
 */
export async function fetchExternalBrandAsset(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return guardedFetch(url, init, {
    policy: 'public',
    redirects: 'follow-checked',
    maxRedirects: MAX_BRAND_REDIRECTS,
  });
}
