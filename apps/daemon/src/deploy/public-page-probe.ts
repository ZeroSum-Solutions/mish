/**
 * The anonymous GET that decides whether a deployed link is `public`.
 *
 * Three rules make it safe to trust:
 *
 * 1. Redirects are followed by hand, at most MAX_REDIRECT_HOPS of them. Every
 *    destination is checked BEFORE it is requested: https only, no IP literal
 *    or local name, and a host that is exactly the deployment's host (or, on
 *    a shared provider host such as `*.vercel.app`, inside the same tenant).
 * 2. Each request connects to the address that was checked. The host is
 *    resolved once per hop; every answer must be public (not loopback,
 *    private, link-local, CGNAT, metadata, multicast, reserved, NAT64 or an
 *    IPv6 form that embeds such an IPv4). The socket is then pinned to one of
 *    those checked addresses (`pinnedProbeDispatcher`), so a DNS answer that
 *    changes between the check and the connect (rebinding) is never used.
 *    TLS still verifies the certificate against the original host name.
 *    Within these rules, a deployed page cannot aim the daemon at a service
 *    on the user's machine or network.
 * 3. A 2xx HTML answer is not proof on its own. The body (read up to
 *    MAX_BODY_BYTES while streaming; a larger body is `false`) must be the
 *    page this daemon deployed: its `<title>` and content anchors taken from
 *    the uploaded entry HTML (`pageMarkerFromHtml`) must match, and it must
 *    not carry a login/password/challenge signal the deployed page itself
 *    lacks. A same-host wall page that renders the project's shell fails the
 *    match. The title match is exact: a provider that injected a suffix into
 *    `<title>` would make every page `unknown` (the safe direction).
 *
 * Any error, timeout or doubt is `false`, which callers report as `unknown`.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

import { Agent } from 'undici';
import { findRealElementRange, findRealTagEnd, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';

export const MAX_REDIRECT_HOPS = 5;
/** Bytes of response body the probe reads; a larger body is not proof. */
export const MAX_BODY_BYTES = 2_000_000;
const MAX_TITLE_CHARS = 200;
const MAX_ANCHOR_CHARS = 160;
const TEXT_ANCHOR_CHARS = 80;

/**
 * What the daemon knows about the page it deployed, kept in the deployment's
 * provider metadata so a later Retry can check the same thing.
 * `wallSignals` names the login/challenge signals the deployed page carries on
 * its own (a design of a sign-in screen has a password field), so only a
 * signal the deployed page LACKS counts as a wall.
 */
export type PageMarker = {
  title: string | null;
  raw: string[];
  text: string | null;
  wallSignals: string[];
};

const LOGIN_TITLE = /\b(?:authentication required|log\s?in|sign\s?in|access denied|password required|unauthori[sz]ed)\b/i;

// `login-title` is tested against the real `<title>` (see `titleOf`); the
// others against the whole document.
const WALL_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['password-input', /<input\b[^>]*\btype\s*=\s*["']?password\b/i],
  ['login-title', LOGIN_TITLE],
  ['vercel-auth', /Vercel Authentication|vercel\.com\/sso-api|_vercel_sso_nonce/i],
  ['cloudflare-access', /\/cdn-cgi\/access\/|cloudflareaccess\.com/i],
  ['challenge', /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\/|Vercel Security Checkpoint/i],
];
const WALL_SIGNAL_NAMES = new Set(WALL_SIGNALS.map(([name]) => name));

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Located structurally, never by text match: a `<title>` or `<body>` written
// into a script string or an attribute is content, not the element.
function titleOf(html: string): string | null {
  const range = findRealElementRange(html, HTML_TAG_PATTERNS.titleOpen, 'title');
  const title = range ? collapse(html.slice(range.contentStart, range.contentEnd)) : '';
  return title ? title.slice(0, MAX_TITLE_CHARS) : null;
}

function bodyPart(html: string): string {
  const end = findRealTagEnd(html, HTML_TAG_PATTERNS.bodyOpen);
  return end >= 0 ? html.slice(end) : html;
}

function visibleText(html: string): string {
  return collapse(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

function wallSignalsOf(html: string): string[] {
  const title = titleOf(html) ?? '';
  return WALL_SIGNALS
    .filter(([name, pattern]) => pattern.test(name === 'login-title' ? title : html))
    .map(([name]) => name);
}

/**
 * The marker of an entry HTML. Content anchors: the first and last
 * `data-od-id="…"` attributes (every Agency Site slot carries one) AND the
 * first visible text of the body, so a wall that echoes the raw anchors with
 * other content still fails. Returns null when the page offers nothing to
 * match, since then no body can be proven to be it. Markers stored before the
 * text anchor was always kept have `text: null` and still parse.
 */
export function pageMarkerFromHtml(html: string): PageMarker | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const ids = html.match(/data-od-id="[^"]{1,120}"/g) ?? [];
  const raw = [...new Set([ids[0], ids[ids.length - 1]].filter((id): id is string => Boolean(id)))];
  const textAll = visibleText(bodyPart(html));
  const text = textAll ? textAll.slice(0, TEXT_ANCHOR_CHARS) : null;
  const title = titleOf(html);
  if (!title && raw.length === 0 && !text) return null;
  return { title, raw, text, wallSignals: wallSignalsOf(html) };
}

/** The marker of the `index.html` a deploy uploads, or null. */
export function pageMarkerFromFiles(files: ReadonlyArray<{ file: string; data: Buffer | Uint8Array | string }>): PageMarker | null {
  const entry = files.find((file) => file.file === 'index.html');
  if (!entry) return null;
  const html = typeof entry.data === 'string' ? entry.data : Buffer.from(entry.data).toString('utf8');
  return pageMarkerFromHtml(html);
}

/** A stored marker, validated at the boundary; anything malformed is null. */
export function parsePageMarker(value: unknown): PageMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const title = source.title === null ? null : typeof source.title === 'string' && source.title.length <= MAX_TITLE_CHARS ? source.title : undefined;
  const text = source.text === null || source.text === undefined ? null : typeof source.text === 'string' && source.text.length <= MAX_ANCHOR_CHARS ? source.text : undefined;
  const raw = Array.isArray(source.raw) && source.raw.length <= 4 && source.raw.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_ANCHOR_CHARS)
    ? source.raw as string[]
    : undefined;
  const wallSignals = Array.isArray(source.wallSignals) && source.wallSignals.every((item) => typeof item === 'string' && WALL_SIGNAL_NAMES.has(item))
    ? source.wallSignals as string[]
    : undefined;
  if (title === undefined || text === undefined || raw === undefined || wallSignals === undefined) return null;
  if (!title && raw.length === 0 && !text) return null;
  return { title, raw, text, wallSignals };
}

/**
 * True when `html` is the deployed page the marker describes, and no wall.
 * Every stored anchor must match: the exact title, each raw `data-od-id`
 * anchor and the text anchor.
 */
export function bodyMatchesPageMarker(html: string, marker: PageMarker): boolean {
  const allowedSignals = new Set(marker.wallSignals);
  if (wallSignalsOf(html).some((signal) => !allowedSignals.has(signal))) return false;
  if (titleOf(html) !== marker.title) return false;
  if (!marker.raw.every((anchor) => html.includes(anchor))) return false;
  if (marker.text && !visibleText(bodyPart(html)).includes(marker.text)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Redirect destinations
// ---------------------------------------------------------------------------

/** Hosts whose every subdomain belongs to a different tenant. */
const SHARED_HOST_SUFFIXES = ['vercel.app', 'pages.dev'];

function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

/** `<tenant>.<shared suffix>` for a host on a shared provider host, else null. */
function providerTenantHost(host: string): string | null {
  const labels = host.split('.');
  for (const suffix of SHARED_HOST_SUFFIXES) {
    if (host.endsWith(`.${suffix}`)) return labels.slice(-(suffix.split('.').length + 1)).join('.');
  }
  return null;
}

/**
 * Whether a redirect may go to `host` while probing `deploymentHost`: only the
 * exact deployment host, or, on a shared provider host (`*.vercel.app`,
 * `*.pages.dev`), a name inside the same `<tenant>.<suffix>`. There is no
 * "last two labels" rule: `victim.co.uk` and `attacker.co.uk` are different
 * owners, and without a public-suffix list the probe cannot tell them apart.
 */
export function sameDeploymentOwner(host: string, deploymentHost: string): boolean {
  const a = normalizeHost(host);
  const b = normalizeHost(deploymentHost);
  if (!a || !b) return false;
  if (a === b) return true;
  const tenant = providerTenantHost(b);
  return tenant !== null && providerTenantHost(a) === tenant;
}

function ipv4Forbidden(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** The eight 16-bit groups of a valid IPv6 address (no zone id), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const parts = dotted[2]!.split('.').map(Number);
    if (parts.some((part) => part > 255)) return null;
    tail.push((parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!);
    text = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const known = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function ipv6Forbidden(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::/128, ::1, IPv4-compatible ::a.b.c.d (deprecated) and IPv4-mapped
  // ::ffff:a.b.c.d: forbidden when the embedded IPv4 is, and :: / ::1 always.
  if (firstFiveZero && g5 === 0) return (g6 === 0 && g7 <= 1) || ipv4Forbidden(embeddedIpv4(g6, g7));
  if (firstFiveZero && g5 === 0xffff) return ipv4Forbidden(embeddedIpv4(g6, g7));
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48: a
  // translator on the path can reach any IPv4, loopback included.
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  // 6to4 2002::/16 carries an IPv4 in groups 1-2.
  if (g0 === 0x2002) return ipv4Forbidden(embeddedIpv4(g1, g2));
  // Teredo 2001::/32, discard 100::/64, documentation 2001:db8::/32.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // ULA fc00::/7 (includes fd00:ec2::254 metadata), link-local fe80::/10,
  // site-local fec0::/10, multicast ff00::/8.
  return (g0 & 0xfe00) === 0xfc00
    || (g0 & 0xffc0) === 0xfe80
    || (g0 & 0xffc0) === 0xfec0
    || (g0 & 0xff00) === 0xff00;
}

/**
 * Loopback, private, link-local, CGNAT, metadata, multicast or reserved, as
 * IPv4 or any IPv6 form: mapped, compatible, NAT64 (`64:ff9b::/96`), 6to4
 * with a forbidden embedded IPv4, Teredo, ULA, link-local, multicast. A
 * scoped (`%zone`) or unparsable address is forbidden too.
 */
export function isForbiddenProbeAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare.includes('%')) return true;
  const family = isIP(bare);
  if (family === 4) return ipv4Forbidden(bare);
  if (family !== 6) return true;
  const groups = ipv6Groups(bare);
  return groups === null || ipv6Forbidden(groups);
}

type ResolveHost = (host: string) => Promise<string[]>;

/**
 * Tests replace name resolution through this global slot (tests/setup.ts), so
 * no daemon test depends on real DNS. Production never sets it.
 */
const RESOLVER_SYMBOL = Symbol.for('open-design.daemon.publicProbeResolveHost');

const defaultResolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

function resolveHost(): ResolveHost {
  const override = (globalThis as Record<symbol, unknown>)[RESOLVER_SYMBOL];
  return typeof override === 'function' ? override as ResolveHost : defaultResolveHost;
}

export type PinnedAddress = { address: string; family: 4 | 6 };

/**
 * The checked address the probe may connect to for `target` while checking
 * `origin`, or null when it may not request it at all: https, no IP literal
 * or local name, the deployment's own host (`sameDeploymentOwner`), and every
 * address the name resolves to is public. The name is resolved ONCE here;
 * the request is then pinned to the returned address, never re-resolved.
 */
export async function probeDestinationAddress(target: URL, origin: URL): Promise<PinnedAddress | null> {
  if (target.protocol !== 'https:') return null;
  if (target.username || target.password) return null;
  const host = normalizeHost(target.hostname);
  if (!host) return null;
  if (isIP(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  if (!sameDeploymentOwner(host, origin.hostname)) return null;
  let addresses: string[];
  try {
    addresses = await resolveHost()(host);
  } catch {
    return null;
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return null;
  if (!addresses.every((address) => typeof address === 'string' && !isForbiddenProbeAddress(address))) return null;
  const address = addresses[0]!.replace(/^\[|\]$/g, '');
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

/** Boolean form of `probeDestinationAddress`. */
export async function probeDestinationAllowed(target: URL, origin: URL): Promise<boolean> {
  return (await probeDestinationAddress(target, origin)) !== null;
}

/**
 * A `lookup` that answers every name with the one pinned address and never
 * touches DNS. Handles both call shapes Node's socket code uses (`all: true`
 * from happy-eyeballs, and the single-address form).
 */
export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  const pinnedLookup = (_hostname: string, options: unknown, callback?: (...args: unknown[]) => void): void => {
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
    if (wantsAll) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
  return pinnedLookup as unknown as LookupFunction;
}

const pinnedAddresses = new WeakMap<object, PinnedAddress>();

/**
 * An undici dispatcher whose sockets connect to `pinned` whatever the URL's
 * host resolves to at connect time. The URL's host is still sent as SNI and
 * `Host`, and the certificate is still verified against it.
 */
export function pinnedProbeDispatcher(pinned: PinnedAddress): Agent {
  const agent = new Agent({ connect: { lookup: createPinnedLookup(pinned) } });
  pinnedAddresses.set(agent, pinned);
  return agent;
}

/** The address a dispatcher from `pinnedProbeDispatcher` connects to (tests). */
export function pinnedAddressOf(dispatcher: unknown): PinnedAddress | undefined {
  return typeof dispatcher === 'object' && dispatcher !== null ? pinnedAddresses.get(dispatcher) : undefined;
}

async function discard(resp: Response) {
  try {
    await resp.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/**
 * True only when an anonymous GET, following at most MAX_REDIRECT_HOPS
 * validated redirects (so at most MAX_REDIRECT_HOPS + 1 requests), each sent
 * to its own pinned, checked address, ends in a 2xx on the host that was asked, outside
 * Cloudflare Access's `/cdn-cgi/access/` path, with no challenge header, and
 * an HTML body that `bodyMatchesPageMarker` accepts. No marker, no proof.
 */
export async function confirmAnonymousPageGet(
  url: string,
  { timeoutMs = 8_000, marker }: { timeoutMs?: number; marker: PageMarker | null | undefined },
): Promise<boolean> {
  if (!url || !marker) return false;
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatchers: Agent[] = [];
  try {
    let current = origin;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const pinned = await probeDestinationAddress(current, origin);
      if (!pinned) return false;
      const dispatcher = pinnedProbeDispatcher(pinned);
      dispatchers.push(dispatcher);
      const resp = await fetch(hop === 0 ? url : current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers?.get?.('location');
        await discard(resp);
        if (!location) return false;
        try {
          current = new URL(location, current);
        } catch {
          return false;
        }
        continue;
      }
      return await isDeployedPage(resp, current, origin, marker);
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // Every body is consumed or cancelled by now; nothing is left in flight.
    for (const dispatcher of dispatchers) void dispatcher.destroy().catch(() => {});
  }
}

/**
 * The body as text, read from the stream and stopped at `maxBytes`: a body
 * larger than that is cancelled unread and answers null, so an endless or
 * huge response never lands in memory.
 */
export async function readBodyCapped(resp: Response, maxBytes: number): Promise<string | null> {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function isDeployedPage(resp: Response, finalUrl: URL, origin: URL, marker: PageMarker): Promise<boolean> {
  const headers = resp.headers;
  if (resp.status < 200 || resp.status >= 300
    || /challenge/i.test(headers?.get?.('x-vercel-mitigated') || '')
    || /challenge/i.test(headers?.get?.('cf-mitigated') || '')
    || /_vercel_sso_nonce/i.test(headers?.get?.('set-cookie') || '')
    || finalUrl.hostname.toLowerCase() !== origin.hostname.toLowerCase()
    || finalUrl.pathname.startsWith('/cdn-cgi/access/')) {
    await discard(resp);
    return false;
  }
  const body = await readBodyCapped(resp, MAX_BODY_BYTES);
  if (body === null) return false;
  const contentType = headers?.get?.('content-type') || '';
  const looksHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || /^\s*(?:<!doctype html|<html)/i.test(body);
  if (!looksHtml || !body.trim()) return false;
  return bodyMatchesPageMarker(body, marker);
}
