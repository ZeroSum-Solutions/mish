// Evidence egress for the R06.2 mechanical runner (B4-2). The browser itself
// never reaches the network: every request the page makes is paused by the
// CDP worker, and only a request to a host on the run's allow-list is handed
// to this session, which fetches it from the daemon under these rules:
//
// - exact hostnames only, https only, the listed port only (443 when none);
// - every hop resolves once, every A/AAAA answer must be public, and the
//   connection is pinned to the checked address (no second lookup, so DNS
//   rebinding cannot swap in a private address);
// - each redirect is re-checked against the list and the address rules;
// - nothing from the app or the browser is forwarded (no cookies, auth or
//   tokens); only a few safe response headers reach the page;
// - request, byte, time and redirect budgets; spending a run budget marks the
//   session exhausted so the run is inconclusive, never passed.
//
// Every attempt is recorded for the verification bundle.
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { addressParam, ev, evidenceLocation, evidenceUrl, evidenceVocabulary, hostParam, pageEnum, PageText, readPageText, RESOURCE_TYPES, type EvidenceContext, type EvidenceParam, type EvidenceText } from './evidence.js';
import { reviewEgressPolicySchema, WORKBENCH_REVIEW_EGRESS_LIMITS, WORKBENCH_REVIEW_EGRESS_SCHEMA, WORKBENCH_REVIEW_PREVIEW_HOST, type ReviewEgressEvidence, type ReviewEgressFetch, type StoredReviewEgressEvidence } from '@open-design/contracts';

export type EgressLimits = { -readonly [K in keyof Omit<typeof WORKBENCH_REVIEW_EGRESS_LIMITS, 'maxHosts'>]: number };
type MutableLimits = EgressLimits;

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type EgressResolver = (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;

export interface EgressTransportRequest {
  url: URL;
  /** The checked address to connect to; the transport never resolves the hostname itself. */
  address: string;
  family: 4 | 6;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  maxBytes: number;
  signal: AbortSignal;
}
export interface EgressTransportResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
export type EgressTransport = (request: EgressTransportRequest) => Promise<EgressTransportResponse>;

export class EgressBodyTooLarge extends Error {}

export type EgressAnswer =
  | { kind: 'response'; status: number; headers: { name: string; value: string }[]; body: Buffer }
  | { kind: 'refused'; reason: EvidenceText };

export interface EgressSummary {
  allowHosts: string[];
  limits: ReviewEgressEvidence['limits'];
  fetches: ReviewEgressFetch[];
  requests: number;
  bytes: number;
  exhausted: EvidenceText | null;
}

// One list per family: Node's BlockList also matches an IPv4 query against IPv6
// rules through its v4-mapped form, so a shared list with ::ffff:0:0/96 would
// refuse every IPv4 address.
const REFUSED_V4 = new BlockList();
const REFUSED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) REFUSED_V4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  // Unspecified/loopback/IPv4-compatible, IPv4-mapped, NAT64, discard, Teredo, documentation, 6to4, ULA, link-local, site-local, multicast.
  ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:2::', 48],
  ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) REFUSED_V6.addSubnet(network, prefix, 'ipv6');
/** IPv6 is allow-listed: only global unicast (2000::/3) is ever dialled, minus the refused ranges above. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

/**
 * Invariant: only globally routable unicast addresses are dialled. Anything
 * private, loopback, link-local, CGNAT, multicast, unspecified, reserved, an
 * IPv6 ULA/link-local, or a v6 form that embeds a v4 address is refused, as
 * is any string that is not an IP address.
 */
export function isRefusedAddress(address: string): boolean {
  // A scoped (zone-id) IPv6 address is link-local by construction.
  if (address.includes('%')) return true;
  try {
    const family = isIP(address);
    if (family === 4) return REFUSED_V4.check(address, 'ipv4');
    if (family === 6) return !GLOBAL_V6.check(address, 'ipv6') || REFUSED_V6.check(address, 'ipv6');
  } catch { /* unparseable: refused below */ }
  return true;
}

/** Egress fetches in flight at once per run; with the per-response cap this bounds buffered bytes. */
export const MAX_CONCURRENT_EGRESS = 4;
/** DNS resolutions in flight at once per run. */
export const MAX_CONCURRENT_RESOLUTIONS = 2;

/**
 * Re-validates an allow-list with the request contract. Persisted or
 * in-process data never skips the rules an HTTP request would face.
 */
export function validatedAllowHosts(allowHosts: readonly string[]): string[] {
  const parsed = reviewEgressPolicySchema.safeParse({ allowHosts: [...allowHosts] });
  if (!parsed.success) throw new Error(`The egress allow-list is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ').slice(0, 300)}`);
  return parsed.data.allowHosts;
}

/** The only response headers that reach the page: enough for type sniffing and CORS, never cookies. */
const PASSED_RESPONSE_HEADERS = ['content-type', 'access-control-allow-origin', 'access-control-expose-headers', 'cross-origin-resource-policy', 'timing-allow-origin'];
const USER_AGENT = 'OpenDesign-Review/1 (evidence egress)';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
/**
 * The path-free location a fetch record keeps (egress records v3). Records
 * exist only for allow-listed hosts, so the origin is one the run vouches for.
 */
function locationOf(url: URL): Pick<ReviewEgressFetch, 'origin' | 'pathDepth' | 'pathDepthCapped' | 'pathQuerySha256'> {
  const location = evidenceLocation(PageText.of(url.href), { served: () => false, allowedOrigin: () => true })!;
  return { origin: url.origin, pathDepth: location.pathDepth, pathDepthCapped: location.pathDepthCapped, pathQuerySha256: location.pathQuerySha256 ?? sha256(`${url.pathname}${url.search}`) };
}
const elapsed = (from: number, to: number) => Math.max(0, Math.round(to - from));

/** Canonical JSON (sorted keys) so a digest survives any re-serialization of the record. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Digest over everything the bundle claims about egress. */
/** Digest over everything the bundle claims about egress; the same fields in every records version. */
export function egressDigest(evidence: Omit<StoredReviewEgressEvidence, 'digest'>): string {
  const { allowHosts, limits, fetches, requests, bytes, exhausted } = evidence;
  // Versioned sections (v2, v3) digest their version string too; the unversioned v1 section never did.
  if ('schema' in evidence && evidence.schema !== undefined) return sha256(canonical({ schema: evidence.schema, allowHosts, limits, fetches, requests, bytes, exhausted }));
  return sha256(canonical({ allowHosts, limits, fetches, requests, bytes, exhausted }));
}

export function egressEvidence(summary: EgressSummary): ReviewEgressEvidence {
  const body = { schema: WORKBENCH_REVIEW_EGRESS_SCHEMA, allowHosts: summary.allowHosts, limits: summary.limits, fetches: summary.fetches, requests: summary.requests, bytes: summary.bytes, exhausted: summary.exhausted };
  return { ...body, digest: egressDigest(body) };
}

/** Throws when a stored bundle's egress records no longer match their digest. */
export function assertEgressDigest(evidence: StoredReviewEgressEvidence | undefined): void {
  if (evidence && egressDigest(evidence) !== evidence.digest) throw new Error('The verification bundle egress records do not match their digest');
}

/**
 * The production resolver: c-ares (`dns.promises.Resolver`), not getaddrinfo,
 * so a lookup never occupies a libuv threadpool slot and is cancelled when the
 * signal aborts. It reads the system's DNS servers; /etc/hosts is not
 * consulted (a hosts-file entry cannot point an allowed name at a private host).
 */
export function createSystemResolver(options: { servers?: string[] } = {}): EgressResolver {
  return async (hostname, signal) => {
    if (signal.aborted) throw new Error('DNS resolution was cancelled');
    const resolver = new Resolver({ timeout: WORKBENCH_REVIEW_EGRESS_LIMITS.resolveTimeoutMs, tries: 1 });
    if (options.servers) resolver.setServers(options.servers);
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      if (signal.aborted) throw new Error('DNS resolution was cancelled');
      const addresses = [
        ...(v4.status === 'fulfilled' ? v4.value.map(address => ({ address, family: 4 as const })) : []),
        ...(v6.status === 'fulfilled' ? v6.value.map(address => ({ address, family: 6 as const })) : []),
      ];
      if (!addresses.length && v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason instanceof Error ? v4.reason : new Error('DNS resolution failed');
      return addresses;
    } finally { signal.removeEventListener('abort', cancel); }
  };
}
export const systemResolver: EgressResolver = createSystemResolver();

/**
 * Real transport: dials `address` directly (Node does no lookup for an IP
 * host), sends the hostname as Host and as TLS SNI, and verifies the
 * certificate against the hostname. No agent, so no pooled connection is
 * reused across checks. The body is capped at `maxBytes`.
 */
export const httpTransport: EgressTransport = request => new Promise((resolve, reject) => {
  const secure = request.url.protocol === 'https:';
  const options: https.RequestOptions = {
    host: request.address, family: request.family, port: request.url.port || (secure ? 443 : 80),
    path: `${request.url.pathname}${request.url.search}`, method: request.method,
    headers: { ...request.headers, host: request.url.host }, agent: false, signal: request.signal,
    ...(secure && !isIP(request.url.hostname) ? { servername: request.url.hostname } : {}),
  };
  const req = (secure ? https : http).request(options, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > request.maxBytes) { res.destroy(); reject(new EgressBodyTooLarge(`larger than ${request.maxBytes} bytes`)); return; }
      chunks.push(chunk);
    });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end();
});

class EgressClosed extends Error {}
const CLOSED_REASON = 'The review closed before this request to an allowed host finished';
const CLOSED_EVIDENCE = ev('egress.closed');

/** Runs `work` with a signal aborted on timeout or when `outer` (the session) aborts. */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string, outer: AbortSignal): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const onClose = () => { clearTimeout(timer); controller.abort(); reject(new EgressClosed(CLOSED_REASON)); };
    const timer = setTimeout(() => { outer.removeEventListener('abort', onClose); controller.abort(); reject(new Error(`${label} timed out after ${ms} ms`)); }, ms); timer.unref?.();
    if (outer.aborted) { onClose(); return; }
    outer.addEventListener('abort', onClose, { once: true });
    work(controller.signal).then(
      value => { clearTimeout(timer); outer.removeEventListener('abort', onClose); resolve(value); },
      error => { clearTimeout(timer); outer.removeEventListener('abort', onClose); reject(error); },
    );
  });
}

/** A FIFO counting semaphore whose queued waiters are released (and refused) when the session closes. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number, private readonly closed: AbortSignal) {
    closed.addEventListener('abort', () => { for (const next of this.waiting.splice(0)) next(); }, { once: true });
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed.aborted) throw new EgressClosed(CLOSED_REASON);
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
      if (this.closed.aborted) throw new EgressClosed(CLOSED_REASON);
    } else this.active++;
    try { return await work(); } finally {
      const next = this.closed.aborted ? undefined : this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

export interface EgressOptions {
  resolver?: EgressResolver;
  transport?: EgressTransport;
  limits?: Partial<EgressLimits>;
  now?: () => number;
}

/** A paused browser request: every field is page-controlled, so every field is PageText. */
export interface EgressRequest {
  url: PageText;
  method: PageText;
  resourceType: PageText;
  /** The page's Origin header; forwarded only when it is the preview origin, so CORS answers match. */
  origin?: PageText | null;
  /** The browser's request headers. Deliberately ignored: nothing the app or page set is forwarded. */
  requestHeaders?: Record<string, string>;
}

type Hop = { entry: string } | { refused: EvidenceText };

/** One run's egress: the allow-list, its budgets and every attempt. */
export class EgressSession {
  /** The list as the run froze it (recorded in the bundle). */
  private readonly declared: string[];
  /** The entries that can become egress (the page's own preview host never does). */
  private readonly allowHosts: string[];
  private readonly limits: MutableLimits;
  private readonly resolver: EgressResolver;
  private readonly transport: EgressTransport;
  private readonly now: () => number;
  private readonly records: ReviewEgressFetch[] = [];
  private readonly linkCache = new Map<string, Promise<{ status: number } | { reason: EvidenceText }>>();
  /** Origins the allow-list names; the only external origins evidence may name. */
  private readonly allowedOrigins: ReadonlySet<string>;
  readonly evidenceContext: EvidenceContext;
  private attempts = 0;
  private requests = 0;
  private bytes = 0;
  /** Bytes reserved by responses still downloading, so concurrent fetches cannot overrun the run budget. */
  private reserved = 0;
  /** Aborted by close(): in-flight requests stop and queued ones are refused. */
  private readonly lifetime = new AbortController();
  private readonly fetchSlots = new Slots(MAX_CONCURRENT_EGRESS, this.lifetime.signal);
  private readonly resolveSlots = new Slots(MAX_CONCURRENT_RESOLUTIONS, this.lifetime.signal);
  exhausted: EvidenceText | null = null;

  constructor(allowHosts: readonly string[], options: EgressOptions = {}) {
    // The page's own origin is always served from the project; it never becomes egress.
    this.declared = validatedAllowHosts(allowHosts);
    this.allowHosts = this.declared.filter(host => host !== WORKBENCH_REVIEW_PREVIEW_HOST);
    this.allowedOrigins = new Set(this.allowHosts.map(entry => new URL(`https://${entry}`).origin));
    this.evidenceContext = { served: () => false, allowedOrigin: origin => this.allowedOrigins.has(origin) };
    this.limits = { ...WORKBENCH_REVIEW_EGRESS_LIMITS, ...options.limits } as MutableLimits;
    this.resolver = options.resolver ?? systemResolver;
    this.transport = options.transport ?? httpTransport;
    this.now = options.now ?? (() => performance.now());
  }

  /** True when the URL's hostname is listed (whatever its scheme or port); such requests are decided and recorded here. */
  matches(url: URL): boolean {
    const hostname = url.hostname.toLowerCase();
    return this.allowHosts.some(entry => entry.split(':')[0] === hostname);
  }

  /** Evidence for a URL: an allow-listed origin stays readable, every other origin and every path is a digest. */
  private urlText(url: URL): EvidenceParam { return evidenceUrl(PageText.of(url.href), this.evidenceContext); }

  /** Exact host match: https only, and the listed port (443 when the entry names none). */
  private hop(url: URL, redirected: boolean): Hop {
    const where = redirected ? ev('egress.redirectedTo') : ev('egress.wentTo');
    const hostname = url.hostname.toLowerCase();
    const candidates = this.allowHosts.filter(entry => entry.split(':')[0] === hostname);
    if (!candidates.length) return { refused: ev('egress.offList', where, this.urlText(url)) };
    if (url.protocol !== 'https:') return { refused: ev('egress.notHttps', where, this.urlText(url)) };
    if (url.username || url.password) return { refused: ev('egress.credentials', where) };
    const port = url.port || '443';
    const entry = candidates.find(candidate => (candidate.split(':')[1] ?? '443') === port);
    // The hostname matched an allow-list entry, so naming it is safe; the port is a number.
    if (!entry) return { refused: ev('egress.portNotListed', where, Number(port), hostParam(candidates[0]!)) };
    return { entry };
  }

  private record(record: ReviewEgressFetch): void {
    if (this.records.length < this.limits.maxRecords) this.records.push(record);
  }

  /** Stops every in-flight request and refuses queued and later ones. Called when the browser session closes. */
  close(): void { this.lifetime.abort(); }

  async fetch(request: EgressRequest): Promise<EgressAnswer> {
    try { return await this.fetchSlots.run(() => this.fetchNow(request)); } catch (error) {
      if (error instanceof EgressClosed) return { kind: 'refused', reason: CLOSED_EVIDENCE };
      throw error;
    }
  }

  private async fetchNow(request: EgressRequest): Promise<EgressAnswer> {
    const started = this.now();
    let current: URL;
    try { current = new URL(readPageText(request.url)); } catch { return { kind: 'refused', reason: ev('egress.invalidUrl') }; }
    // Only a request this session matches is decided (and recorded) here; anything else stays blocked by the worker.
    if (!this.matches(current)) return { kind: 'refused', reason: ev('egress.outsideAllowList', this.urlText(current)) };
    const first = current;
    const resourceType = pageEnum(readPageText(request.resourceType), RESOURCE_TYPES, 'Other');
    const redirects: ReviewEgressFetch['redirects'] = [];
    // The query is described, never stored: it may carry page-supplied identifiers.
    const query = first.search.replace(/^\?/u, '');
    const queryFields = { ...locationOf(first), queryLength: query.length };
    const hostname = current.hostname.toLowerCase();
    // The record names the allow-list entry the request matched.
    let host = this.allowHosts.find(entry => entry.split(':')[0] === hostname)!;
    const finish = (outcome: 'refused' | 'failed', reason: EvidenceText, address: string | null = null): EgressAnswer => {
      this.record({ ...queryFields, host, resourceType, outcome, reason, resolvedAddress: address, status: null, bytes: 0, sha256: null, durationMs: elapsed(started, this.now()), redirects });
      return { kind: 'refused', reason };
    };

    if (++this.attempts > this.limits.maxRecords) {
      this.exhausted ??= ev('egress.recordLimit', this.limits.maxRecords);
      return { kind: 'refused', reason: this.exhausted };
    }
    const firstHop = this.hop(current, false);
    if ('entry' in firstHop) host = firstHop.entry;
    const rawMethod = readPageText(request.method);
    if (rawMethod !== 'GET' && rawMethod !== 'HEAD') return finish('refused', ev('egress.method', evidenceVocabulary(request.method, 'method')));
    const method: 'GET' | 'HEAD' = rawMethod;

    for (let hops = 0; ; hops++) {
      const hop = hops === 0 ? firstHop : this.hop(current, true);
      if ('refused' in hop) return finish('refused', hop.refused);
      // The record names the entry that served the bytes; the earlier hops stay in `redirects`.
      host = hop.entry;
      if (this.exhausted) return finish('refused', this.exhausted);
      if (this.requests >= this.limits.maxRequests) {
        this.exhausted = ev('egress.requestLimit', this.limits.maxRequests);
        return finish('refused', this.exhausted);
      }
      this.requests++;
      // From here the hostname is an allow-list entry's, so naming it in evidence is safe.
      const hostText = hostParam(host);

      let addresses: ResolvedAddress[];
      try {
        addresses = await withTimeout(signal => this.resolveSlots.run(() => {
          if (signal.aborted) throw new Error(`Resolving ${current.hostname} timed out`);
          return this.resolver(current.hostname, signal);
        }), this.limits.resolveTimeoutMs, `Resolving ${current.hostname}`, this.lifetime.signal);
      } catch (error) {
        if (error instanceof EgressClosed || this.lifetime.signal.aborted) return finish('refused', CLOSED_EVIDENCE);
        return finish('failed', error instanceof Error && /timed out/u.test(error.message) ? ev('egress.resolveTimeout', hostText, this.limits.resolveTimeoutMs) : ev('egress.unresolved', hostText));
      }
      if (!addresses.length) return finish('failed', ev('egress.noAddress', hostText));
      const refused = addresses.find(item => isRefusedAddress(item.address));
      // The resolver's answer is an address string the daemon parsed (isIP), not page text.
      if (refused) return finish('refused', ev('egress.privateAddress', hostText, addressParam(refused.address)));
      const pinned = addresses[0]!;

      const runRemaining = this.limits.maxBytes - this.bytes - this.reserved;
      const cap = Math.max(0, Math.min(this.limits.maxResponseBytes, runRemaining));
      const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': USER_AGENT };
      if (request.origin && readPageText(request.origin) === `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`) headers.origin = `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`;
      let response: EgressTransportResponse;
      this.reserved += cap;
      try {
        response = await withTimeout(signal => this.transport({ url: current, address: pinned.address, family: pinned.family, method, headers, maxBytes: cap, signal }), this.limits.requestTimeoutMs, `The request to ${current.hostname}`, this.lifetime.signal);
        if (response.body.length > cap) throw new EgressBodyTooLarge(`larger than ${cap} bytes`);
      } catch (error) {
        this.reserved -= cap;
        if (error instanceof EgressClosed || this.lifetime.signal.aborted) return finish('refused', CLOSED_EVIDENCE, pinned.address);
        if (error instanceof EgressBodyTooLarge) {
          if (cap < this.limits.maxResponseBytes) {
            this.exhausted = ev('egress.byteLimit', this.limits.maxBytes);
            return finish('refused', this.exhausted, pinned.address);
          }
          return finish('refused', ev('egress.tooLarge', hostText, this.limits.maxResponseBytes), pinned.address);
        }
        return finish('failed', error instanceof Error && /timed out/u.test(error.message) ? ev('egress.requestTimeout', hostText, this.limits.requestTimeoutMs) : ev('egress.requestFailed', hostText), pinned.address);
      }
      this.reserved -= cap;
      this.bytes += response.body.length;

      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && typeof location === 'string') {
        if (redirects.length >= this.limits.maxRedirects) return finish('refused', ev('egress.tooManyRedirects', this.limits.maxRedirects), pinned.address);
        let next: URL;
        try { next = new URL(location, current); } catch { return finish('failed', ev('egress.badRedirect', hostText), pinned.address); }
        redirects.push({ ...locationOf(current), status: response.status, resolvedAddress: pinned.address });
        current = next;
        continue;
      }

      const status = response.status >= 100 && response.status <= 599 ? response.status : 502;
      this.record({ ...queryFields, host, resourceType, outcome: 'fetched', reason: null, resolvedAddress: pinned.address, status, bytes: response.body.length, sha256: sha256(response.body), durationMs: elapsed(started, this.now()), redirects });
      const passed = PASSED_RESPONSE_HEADERS.flatMap(name => {
        const value = response.headers[name];
        return typeof value === 'string' ? [{ name, value }] : [];
      });
      return { kind: 'response', status, headers: [...passed, { name: 'cache-control', value: 'no-store' }], body: method === 'HEAD' ? Buffer.alloc(0) : response.body };
    }
  }

  /** Status of an external link destination on an allowed host; probed once per URL per run. */
  linkStatus(href: PageText): Promise<{ status: number } | { reason: EvidenceText }> {
    const key = readPageText(href).split('#')[0]!;
    const cached = this.linkCache.get(key);
    if (cached) return cached;
    const probe = this.fetch({ url: PageText.of(key), method: PageText.of('GET'), resourceType: PageText.of('Link') }).then(answer => answer.kind === 'response' ? { status: answer.status } : { reason: answer.reason });
    this.linkCache.set(key, probe);
    return probe;
  }

  summary(): EgressSummary {
    const { maxRequests, maxBytes, maxResponseBytes, requestTimeoutMs, maxRedirects } = this.limits;
    return { allowHosts: [...this.declared], limits: { maxRequests, maxBytes, maxResponseBytes, requestTimeoutMs, maxRedirects }, fetches: this.records.map(record => ({ ...record, redirects: [...record.redirects] })), requests: this.requests, bytes: this.bytes, exhausted: this.exhausted };
  }
}
