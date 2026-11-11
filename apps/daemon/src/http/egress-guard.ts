// The daemon's single outbound egress guard: every path that fetches a URL it
// did not hard-code goes through here.
//
// Invariant: the daemon dials only an address that `classifyIp` calls
// `public`, unless the URL is the user's own endpoint (`user-endpoint`), which
// may also be loopback or an `OD_ALLOWED_INTERNAL_HOSTS` entry. The check runs
// at two points, because neither one is enough alone:
//
// 1. URL level, on every hop (`assertFetchableUrl`). Node never calls the
//    connect-time `lookup` for an IP literal, so a redirect to
//    `http://169.254.169.254/` or `http://[::ffff:7f00:1]/` is visible ONLY
//    here. `guardedFetch` therefore always handles redirects itself.
// 2. Connect time, for names (`createGuardedLookup`). The undici Agent's
//    `lookup` checks every DNS answer, so the address we check IS the address
//    the socket connects to and a rebinding name cannot swap in a private one.
//
// A URL that arrives inside a response, a document, a registry, a catalog or
// remote metadata is `public`. It inherits `user-endpoint` only when it has the
// same origin as the URL the user typed (`policyForLinkedUrl`).

import { lookup as dnsLookupCb } from 'node:dns';
import type { LookupFunction } from 'node:net';

import { Agent } from 'undici';

import { isAllowlistedInternalHost } from '@mish/contracts/api/connectionTest';
import { classifyIp, parseIp, type IpClass } from '@mish/contracts/api/ip-policy';

import { configuredAllowedInternalHosts } from '../origin-validation.js';

export type EgressPolicy = 'public' | 'user-endpoint';
export type EgressRedirectMode = 'error' | 'follow-checked' | 'return';

/** Why the guard refused: callers that keep their own error wording map on this. */
export type EgressRefusalReason = 'invalid-url' | 'scheme' | 'credentials' | 'non-public-host' | 'redirect';

/** Thrown when a URL, a DNS answer or a redirect breaks the egress invariant. */
export class EgressRefusedError extends Error {
  readonly code = 'EGRESS_REFUSED';
  readonly reason: EgressRefusalReason;
  constructor(message: string, reason: EgressRefusalReason) {
    super(message);
    this.name = 'EgressRefusedError';
    this.reason = reason;
  }
}

function normalizeHost(hostname: string): string {
  let host = String(hostname).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/** `name` = a DNS name the connect-time lookup must check. */
function classifyUrlHost(hostname: string): IpClass | 'name' {
  const host = normalizeHost(hostname);
  if (!host) return 'refused';
  if (isLocalhostName(host)) return 'loopback';
  if (parseIp(host)) return classifyIp(host);
  // Shaped like an IP literal but not one we can parse: never treat it as a name.
  if (host.includes(':') || /^[0-9.]+$/.test(host)) return 'refused';
  return 'name';
}

function isAllowlisted(...hosts: Array<string | undefined>): boolean {
  const allowed = configuredAllowedInternalHosts();
  if (allowed.length === 0) return false;
  return hosts.some((host) => typeof host === 'string' && host !== '' && isAllowlistedInternalHost(host, allowed));
}

/** True when `policy` may dial an address of class `cls` (for `host`, the URL or DNS name). */
function classAllowed(cls: IpClass, policy: EgressPolicy, ...hosts: Array<string | undefined>): boolean {
  if (cls === 'public') return true;
  if (policy !== 'user-endpoint') return false;
  return cls === 'loopback' || isAllowlisted(...hosts);
}

/**
 * Throw unless `url` may be fetched under `policy`: http(s) only, no userinfo,
 * and a literal host (IP, `localhost`, `*.localhost`) that the policy allows.
 * A DNS name passes here; the connect-time lookup checks its answers.
 * Returns the parsed URL.
 */
export function assertFetchableUrl(url: string | URL, policy: EgressPolicy): URL {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : new URL(url.href);
  } catch {
    throw new EgressRefusedError('invalid url', 'invalid-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressRefusedError(`unsupported url scheme: ${parsed.protocol}`, 'scheme');
  }
  if (parsed.username || parsed.password) {
    throw new EgressRefusedError('url credentials are not allowed', 'credentials');
  }
  const cls = classifyUrlHost(parsed.hostname);
  if (cls === 'name') return parsed;
  if (!classAllowed(cls, policy, normalizeHost(parsed.hostname))) {
    throw new EgressRefusedError(`refusing to fetch non-public host: ${parsed.hostname}`, 'non-public-host');
  }
  return parsed;
}

/**
 * True only for a host the user can type to mean "this machine": `localhost`,
 * `*.localhost`, `[::1]` and a dotted 127/8 literal. Mapped forms such as
 * `[::ffff:7f00:1]` never qualify, so they cannot unlock `user-endpoint`.
 */
export function isTypedLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (isLocalhostName(host)) return true;
  if (host === '::1') return true;
  const parsed = parseIp(host);
  return parsed !== null && parsed.family === 4 && parsed.groups[0] === 127;
}

/**
 * Policy for a URL found while fetching `entryUrl` (an include, a file, a
 * redirect, OAuth metadata): `entryPolicy` when it has the same origin as the
 * entry URL, otherwise `public`.
 */
export function policyForLinkedUrl(url: string | URL, entryUrl: string | URL, entryPolicy: EgressPolicy): EgressPolicy {
  try {
    const a = new URL(typeof url === 'string' ? url : url.href);
    const b = new URL(typeof entryUrl === 'string' ? entryUrl : entryUrl.href);
    return a.origin === b.origin ? entryPolicy : 'public';
  } catch {
    return 'public';
  }
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;
type DnsLookupCb = typeof dnsLookupCb;

/**
 * A `dns.lookup`-shaped resolver for an undici Agent's `connect.lookup`. Every
 * answer must be allowed under `policy`, or the socket is refused. It protects
 * names only: Node does not call it for IP literals (that is
 * `assertFetchableUrl`'s job, on every hop).
 */
export function createGuardedLookup(policy: EgressPolicy, lookupImpl: DnsLookupCb = dnsLookupCb): LookupFunction {
  const guardedLookup = (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts = (typeof options === 'function' ? {} : (options ?? {})) as Record<string, unknown>;
    (lookupImpl as unknown as (h: string, o: unknown, c: LookupCallback) => void)(hostname, opts, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (list.length === 0) return cb(new EgressRefusedError(`host did not resolve: ${hostname}`, 'non-public-host'));
      for (const entry of list) {
        const addr = String(typeof entry === 'string' ? entry : (entry as { address: unknown }).address);
        if (!classAllowed(classifyIp(addr), policy, addr, normalizeHost(hostname))) {
          return cb(new EgressRefusedError(`host resolves to a non-public address: ${hostname} -> ${addr}`, 'non-public-host'));
        }
      }
      return cb(null, address, family);
    });
  };
  return guardedLookup as unknown as LookupFunction;
}

type Dispatcher = NonNullable<RequestInit['dispatcher']>;

// One long-lived Agent per policy (and per injected resolver in tests). A
// per-request Agent leaks keep-alive sockets; closing one per request would
// wait for the caller to finish reading the body.
const sharedDispatchers = new Map<EgressPolicy, Agent>();
const customDispatchers = new WeakMap<DnsLookupCb, Map<EgressPolicy, Agent>>();

/** The pinned dispatcher `guardedFetch` attaches for `policy`. */
export function egressDispatcher(policy: EgressPolicy, lookupImpl?: DnsLookupCb): Dispatcher {
  let byPolicy = sharedDispatchers;
  if (lookupImpl) {
    byPolicy = customDispatchers.get(lookupImpl) ?? new Map();
    customDispatchers.set(lookupImpl, byPolicy);
  }
  let agent = byPolicy.get(policy);
  if (!agent) {
    agent = new Agent({ connect: { lookup: createGuardedLookup(policy, lookupImpl) } });
    byPolicy.set(policy, agent);
  }
  return agent as unknown as Dispatcher;
}

export interface GuardedFetchOptions {
  policy: EgressPolicy;
  /**
   * `error`: any 3xx is refused. `return`: a 3xx is returned untouched (the
   * caller re-enters the guard per hop). `follow-checked`: the guard follows
   * up to `maxRedirects` hops and checks each `Location` before requesting it.
   */
  redirects: EgressRedirectMode;
  maxRedirects?: number | undefined;
  /** Resolver for the connect-time lookup (tests). */
  lookupImpl?: DnsLookupCb | undefined;
  /** Defaults to the global `fetch`, read at call time so test stubs apply. */
  fetchImpl?: typeof fetch | undefined;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers that carry the caller's credentials; never sent to another origin. */
const CROSS_ORIGIN_DROPPED_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];

function replayableBody(body: RequestInit['body']): boolean {
  return body == null || typeof body === 'string' || body instanceof URLSearchParams || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

/**
 * Fetch `url` under the egress invariant. Every hop is checked at URL level
 * (with the hop's own policy: a redirect to another origin is `public`) and
 * dialled through the pinned dispatcher for its policy. Credential headers are
 * dropped when a hop changes origin.
 */
export async function guardedFetch(url: string | URL, init: RequestInit = {}, options: GuardedFetchOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const entry = assertFetchableUrl(url, options.policy);
  let target = entry;
  let policy = options.policy;
  // Passed through untouched until a hop has to change them.
  let headers: RequestInit['headers'] = init.headers;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; ; hop += 1) {
    const requestInit: RequestInit = {
      ...init,
      ...(method === undefined ? {} : { method }),
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
      // The native `error` mode refuses a 3xx before any body is read; the
      // status check below covers fetch implementations that ignore it.
      redirect: options.redirects === 'error' ? 'error' : 'manual',
    };
    if (headers === undefined) delete (requestInit as { headers?: unknown }).headers;
    if (body === undefined) delete (requestInit as { body?: unknown }).body;
    (requestInit as { dispatcher?: unknown }).dispatcher = egressDispatcher(policy, options.lookupImpl);
    const res = await fetchImpl(target.href, requestInit);
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    if (options.redirects === 'return') return res;
    if (res.body) await res.body.cancel().catch(() => {});
    if (options.redirects === 'error') {
      throw new EgressRefusedError(`redirect refused (HTTP ${res.status}) from ${target.origin}`, 'redirect');
    }
    const location = res.headers.get('location');
    if (!location) throw new EgressRefusedError(`redirect without a location from ${target.origin}`, 'redirect');
    if (hop >= maxRedirects) throw new EgressRefusedError(`too many redirects (> ${maxRedirects})`, 'redirect');
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new EgressRefusedError('redirect to an invalid url', 'redirect');
    }
    policy = policyForLinkedUrl(next, entry, options.policy);
    assertFetchableUrl(next, policy);
    if (next.origin !== target.origin) {
      const stripped = new Headers(headers);
      for (const name of CROSS_ORIGIN_DROPPED_HEADERS) stripped.delete(name);
      headers = stripped;
    }
    const verb = (method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && verb === 'POST')) {
      method = verb === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
      const rewritten = new Headers(headers);
      rewritten.delete('content-type');
      rewritten.delete('content-length');
      headers = rewritten;
    } else if (!replayableBody(body)) {
      throw new EgressRefusedError('cannot replay a streamed request body across a redirect', 'redirect');
    }
    target = next;
  }
}
