import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { egressEligible } from '../../src/workbench/review/cdp-worker.js';
import { PageText } from '../../src/workbench/review/evidence.js';
import { isReviewEvidenceMessage, renderReviewEvidenceMessage, WORKBENCH_REVIEW_EGRESS_LIMITS } from '@mish/contracts';
import { text } from './review-capture-fixture.js';

/** The value with every structured message rendered as its English text, for readable assertions. */
const readable = (value: unknown): unknown => isReviewEvidenceMessage(value) ? renderReviewEvidenceMessage(value)
  : Array.isArray(value) ? value.map(readable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readable(item)])) : value;
import {
  createSystemResolver, EgressSession, httpTransport, isRefusedAddress, MAX_CONCURRENT_EGRESS, type EgressResolver, type EgressTransport, type EgressTransportRequest,
} from '../../src/workbench/review/egress.js';

// B4-2 / AC-R06.2 external-resource pages. Never the real internet: a local
// fake server stands in for every allowed host, and the resolver is injected
// so "public" addresses never leave this machine.

const PUBLIC = '93.184.215.14';
const PUBLIC_B = '151.101.1.69';

interface Hit { path: string; headers: IncomingHttpHeaders }
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

/** One local HTTP server answering every "host"; routes by Host header and path. */
async function fakeInternet(routes: Record<string, (path: string) => { status: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number }>) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ path: `${req.headers.host}${req.url}`, headers: req.headers });
    const route = routes[String(req.headers.host).replace(/:\d+$/u, '')];
    const answer = route ? route(String(req.url)) : { status: 404, body: 'no route' };
    const send = () => { res.writeHead(answer.status, answer.headers ?? {}); res.end(answer.body ?? ''); };
    if (answer.delayMs) setTimeout(send, answer.delayMs); else send();
  });
  servers.push(server);
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const dialed: EgressTransportRequest[] = [];
  /** Dials the fake server whatever address the session pinned, and records the pinned address. */
  const transport: EgressTransport = request => { dialed.push(request); return httpTransport({ ...request, address: '127.0.0.1', family: 4, url: new URL(request.url.href.replace(/^https:/u, 'http:').replace(request.url.host, `${request.url.hostname}:${port}`)) }); };
  return { hits, dialed, transport };
}

const resolverFrom = (table: Record<string, string[]>): EgressResolver & { calls: string[] } => {
  const calls: string[] = [];
  const resolver = async (hostname: string) => { calls.push(hostname); return (table[hostname] ?? []).map(address => ({ address, family: address.includes(':') ? 6 as const : 4 as const })); };
  return Object.assign(resolver, { calls });
};

describe('address rules (SSRF floor)', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136::1', 'fe80::1%en0', 'not-an-ip',
  ])('refuses %s', address => { expect(isRefusedAddress(address)).toBe(true); });

  it.each([PUBLIC, PUBLIC_B, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5', '2a00:1450:4001::200e'])('allows public %s', address => {
    expect(isRefusedAddress(address)).toBe(false);
  });
});

describe('EgressSession: allowed exact hosts only', () => {
  it('default-deny: an empty allow-list matches nothing and fetches nothing', async () => {
    const internet = await fakeInternet({});
    const session = new EgressSession([], { resolver: resolverFrom({}), transport: internet.transport });
    expect(session.matches(new URL('https://fonts.example-cdn.com/a.css'))).toBe(false);
    expect(internet.dialed).toHaveLength(0);
    expect(session.summary().fetches).toEqual([]);
  });

  it('fetches an allowed exact host over the checked, pinned address and records url, address, status, bytes, digest and timing', async () => {
    const internet = await fakeInternet({ 'fonts.example-cdn.com': () => ({ status: 200, headers: { 'content-type': 'text/css', 'set-cookie': 'track=1', 'access-control-allow-origin': '*' }, body: 'body{color:#111}' }) });
    const resolver = resolverFrom({ 'fonts.example-cdn.com': [PUBLIC] });
    const session = new EgressSession(['fonts.example-cdn.com'], { resolver, transport: internet.transport });
    const url = new URL('https://fonts.example-cdn.com/css/site.css?v=1');
    expect(session.matches(url)).toBe(true);
    const answer = await session.fetch({ url: PageText.of(url.href), method: PageText.of('GET'), resourceType: PageText.of('Stylesheet'), origin: PageText.of('http://project.od-review.localhost'), requestHeaders: { Cookie: 'sid=secret', Authorization: 'Bearer app-token', 'X-OD-Tool-Token': 'x' } });
    expect(answer).toMatchObject({ kind: 'response', status: 200 });
    if (answer.kind !== 'response') throw new Error('expected a response');
    expect(answer.body.toString()).toBe('body{color:#111}');
    // Only a small, safe set of response headers reaches the page; cookies never do.
    expect(answer.headers.map(header => header.name.toLowerCase()).sort()).toEqual(['access-control-allow-origin', 'cache-control', 'content-type']);
    // The connection went to the address that was checked, and nothing from the app was forwarded.
    expect(internet.dialed.map(request => request.address)).toEqual([PUBLIC]);
    const sent = internet.hits[0]!.headers;
    expect(sent.cookie).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
    expect(sent['x-od-tool-token']).toBeUndefined();
    expect(sent.origin).toBe('http://project.od-review.localhost');
    const [record] = session.summary().fetches;
    expect(record).toMatchObject({ origin: 'https://fonts.example-cdn.com', pathDepth: 2, pathQuerySha256: createHash('sha256').update('/css/site.css?v=1').digest('hex'), queryLength: 3, host: 'fonts.example-cdn.com', resourceType: 'Stylesheet', outcome: 'fetched', reason: null, resolvedAddress: PUBLIC, status: 200, bytes: 16, redirects: [] });
    // Sol round 3: no external path or query is ever persisted in a fetch record.
    expect(JSON.stringify(record)).not.toMatch(/site\.css|\/css|v=1/u);
    expect(record!.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses http, a different port, credentials in the URL and non-GET methods for a listed host', async () => {
    const internet = await fakeInternet({ 'fonts.example-cdn.com': () => ({ status: 200, body: 'x' }) });
    const session = new EgressSession(['fonts.example-cdn.com', 'api.example-cdn.com:8443'], { resolver: resolverFrom({ 'fonts.example-cdn.com': [PUBLIC], 'api.example-cdn.com': [PUBLIC] }), transport: internet.transport });
    const refused = async (url: string, method = 'GET') => session.fetch({ url: PageText.of(url), method: PageText.of(method), resourceType: PageText.of('Script') });
    expect(readable(await refused('http://fonts.example-cdn.com/a.js'))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/https/u) });
    expect(readable(await refused('https://fonts.example-cdn.com:8443/a.js'))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/port/u) });
    expect(readable(await refused('https://api.example-cdn.com/a.js'))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/port/u) });
    expect(readable(await refused('https://user:pw@fonts.example-cdn.com/a.js'))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/credentials/u) });
    expect(readable(await refused('https://fonts.example-cdn.com/a.js', 'POST'))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/GET/u) });
    expect(session.matches(new URL('https://sub.fonts.example-cdn.com/a.js'))).toBe(false);
    expect(internet.dialed).toHaveLength(0);
    expect(session.summary().fetches.every(record => record.outcome === 'refused' && record.reason)).toBe(true);
  });

  it('refuses a listed host that resolves to any private, loopback or link-local address, including a mixed answer', async () => {
    const internet = await fakeInternet({});
    const resolver = resolverFrom({ 'a.example-cdn.com': ['10.0.0.5'], 'b.example-cdn.com': [PUBLIC, '127.0.0.1'], 'c.example-cdn.com': ['169.254.169.254'], 'd.example-cdn.com': ['fd00::1'], 'e.example-cdn.com': [] });
    const session = new EgressSession(['a.example-cdn.com', 'b.example-cdn.com', 'c.example-cdn.com', 'd.example-cdn.com', 'e.example-cdn.com'], { resolver, transport: internet.transport });
    for (const host of ['a', 'b', 'c', 'd']) {
      expect(readable(await session.fetch({ url: PageText.of(`https://${host}.example-cdn.com/x`), method: PageText.of('GET'), resourceType: PageText.of('Image') })), host).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/non-public address/u) });
    }
    expect(readable(await session.fetch({ url: PageText.of('https://e.example-cdn.com/x'), method: PageText.of('GET'), resourceType: PageText.of('Image') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/did not resolve/u) });
    expect(internet.dialed).toHaveLength(0);
  });

  it('DNS rebinding: resolves once per hop and pins the connection to the checked address', async () => {
    const internet = await fakeInternet({ 'rebind.example-cdn.com': () => ({ status: 200, body: 'ok' }) });
    // A rebinding resolver answers public first and loopback on every later lookup.
    let first = true; const calls: string[] = [];
    const resolver: EgressResolver = async hostname => { calls.push(hostname); const address = first ? PUBLIC : '127.0.0.1'; first = false; return [{ address, family: 4 }]; };
    const session = new EgressSession(['rebind.example-cdn.com'], { resolver, transport: internet.transport });
    expect(readable(await session.fetch({ url: PageText.of('https://rebind.example-cdn.com/a'), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'response', status: 200 });
    expect(calls).toEqual(['rebind.example-cdn.com']);
    expect(internet.dialed.map(request => request.address)).toEqual([PUBLIC]);
    // The next request resolves again, sees loopback and is refused before any connection.
    expect(readable(await session.fetch({ url: PageText.of('https://rebind.example-cdn.com/b'), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'refused' });
    expect(internet.dialed).toHaveLength(1);
  });
});

describe('EgressSession: redirects are re-checked hop by hop', () => {
  it('follows a redirect to another allowed host and records the chain', async () => {
    const internet = await fakeInternet({
      'a.example-cdn.com': () => ({ status: 302, headers: { location: 'https://b.example-cdn.com/final.css' } }),
      'b.example-cdn.com': () => ({ status: 200, headers: { 'content-type': 'text/css' }, body: 'p{}' }),
    });
    const session = new EgressSession(['a.example-cdn.com', 'b.example-cdn.com'], { resolver: resolverFrom({ 'a.example-cdn.com': [PUBLIC], 'b.example-cdn.com': [PUBLIC_B] }), transport: internet.transport });
    expect(readable(await session.fetch({ url: PageText.of('https://a.example-cdn.com/start.css'), method: PageText.of('GET'), resourceType: PageText.of('Stylesheet') }))).toMatchObject({ kind: 'response', status: 200 });
    expect(session.summary().fetches[0]).toMatchObject({ outcome: 'fetched', host: 'b.example-cdn.com', resolvedAddress: PUBLIC_B, status: 200, redirects: [{ origin: 'https://a.example-cdn.com', pathDepth: 1, pathQuerySha256: createHash('sha256').update('/start.css').digest('hex'), status: 302, resolvedAddress: PUBLIC }] });
    expect(session.summary().requests).toBe(2);
  });

  it.each([
    ['a host outside the allow-list', 'https://evil.example.com/x', /outside the allow-list/u],
    ['plain http on an allowed host', 'http://b.example-cdn.com/x', /https/u],
    ['an IP literal', 'https://169.254.169.254/latest/meta-data/', /outside the allow-list/u],
    ['an allowed host that resolves privately', 'https://private.example-cdn.com/x', /non-public address/u],
  ])('refuses a redirect to %s', async (_label, location, reason) => {
    const internet = await fakeInternet({ 'a.example-cdn.com': () => ({ status: 301, headers: { location } }) });
    const session = new EgressSession(['a.example-cdn.com', 'b.example-cdn.com', 'private.example-cdn.com'], { resolver: resolverFrom({ 'a.example-cdn.com': [PUBLIC], 'b.example-cdn.com': [PUBLIC_B], 'private.example-cdn.com': ['192.168.0.10'] }), transport: internet.transport });
    expect(readable(await session.fetch({ url: PageText.of('https://a.example-cdn.com/start'), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(reason) });
    expect(internet.dialed).toHaveLength(1);
  });

  it('stops after the redirect limit', async () => {
    let hop = 0;
    const internet = await fakeInternet({ 'a.example-cdn.com': () => ({ status: 302, headers: { location: `https://a.example-cdn.com/${++hop}` } }) });
    const session = new EgressSession(['a.example-cdn.com'], { resolver: resolverFrom({ 'a.example-cdn.com': [PUBLIC] }), transport: internet.transport });
    expect(readable(await session.fetch({ url: PageText.of('https://a.example-cdn.com/0'), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/redirect/u) });
    expect(internet.dialed).toHaveLength(WORKBENCH_REVIEW_EGRESS_LIMITS.maxRedirects + 1);
  });
});

describe('EgressSession: budgets make the run inconclusive, never passed', () => {
  const host = 'a.example-cdn.com';
  const resolver = () => resolverFrom({ [host]: [PUBLIC] });

  it('exhausts the request budget', async () => {
    const internet = await fakeInternet({ [host]: () => ({ status: 200, body: 'x' }) });
    const session = new EgressSession([host], { resolver: resolver(), transport: internet.transport, limits: { maxRequests: 2 } });
    for (let index = 0; index < 2; index++) expect((await session.fetch({ url: PageText.of(`https://${host}/${index}`), method: PageText.of('GET'), resourceType: PageText.of('Image') })).kind).toBe('response');
    expect(readable(await session.fetch({ url: PageText.of(`https://${host}/2`), method: PageText.of('GET'), resourceType: PageText.of('Image') }))).toMatchObject({ kind: 'refused' });
    expect(text(session.summary().exhausted)).toMatch(/2 requests/u);
  });

  it('refuses a response over the per-request limit and exhausts the run byte budget', async () => {
    const internet = await fakeInternet({ [host]: path => ({ status: 200, body: Buffer.alloc(path === '/big' ? 2048 : 600) }) });
    const perRequest = new EgressSession([host], { resolver: resolver(), transport: internet.transport, limits: { maxResponseBytes: 1024, maxBytes: 10_000 } });
    expect(readable(await perRequest.fetch({ url: PageText.of(`https://${host}/big`), method: PageText.of('GET'), resourceType: PageText.of('Image') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/1024 bytes/u) });
    expect(perRequest.summary().exhausted).toBeNull();
    const perRun = new EgressSession([host], { resolver: resolver(), transport: internet.transport, limits: { maxResponseBytes: 1024, maxBytes: 1000 } });
    expect((await perRun.fetch({ url: PageText.of(`https://${host}/a`), method: PageText.of('GET'), resourceType: PageText.of('Image') })).kind).toBe('response');
    expect(readable(await perRun.fetch({ url: PageText.of(`https://${host}/b`), method: PageText.of('GET'), resourceType: PageText.of('Image') }))).toMatchObject({ kind: 'refused' });
    expect(text(perRun.summary().exhausted)).toMatch(/bytes/u);
  });

  it('times out a slow host as failed', async () => {
    const internet = await fakeInternet({ [host]: () => ({ status: 200, body: 'late', delayMs: 300 }) });
    const session = new EgressSession([host], { resolver: resolver(), transport: internet.transport, limits: { requestTimeoutMs: 50 } });
    expect(readable(await session.fetch({ url: PageText.of(`https://${host}/slow`), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/timed out/u) });
    expect(session.summary().fetches[0]).toMatchObject({ outcome: 'failed' });
  });

  it('holds at most MAX_CONCURRENT_EGRESS fetches in flight, so buffered bytes stay bounded', async () => {
    let active = 0; let peak = 0; const release: (() => void)[] = [];
    const transport: EgressTransport = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => release.push(resolve));
      active--;
      return { status: 200, headers: {}, body: Buffer.from('x') };
    };
    const session = new EgressSession([host], { resolver: resolver(), transport });
    const all = Promise.all(Array.from({ length: MAX_CONCURRENT_EGRESS + 3 }, (_, index) => session.fetch({ url: PageText.of(`https://${host}/${index}`), method: PageText.of('GET'), resourceType: PageText.of('Image') })));
    for (let round = 0; round < 20 && release.length < MAX_CONCURRENT_EGRESS + 3; round++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      release.splice(0).forEach(done => done());
    }
    release.splice(0).forEach(done => done());
    expect((await all).every(answer => answer.kind === 'response')).toBe(true);
    expect(peak).toBe(MAX_CONCURRENT_EGRESS);
  });

  it('times out a resolver that never answers', async () => {
    const internet = await fakeInternet({});
    const session = new EgressSession([host], { resolver: () => new Promise(() => undefined), transport: internet.transport, limits: { resolveTimeoutMs: 30 } });
    expect(readable(await session.fetch({ url: PageText.of(`https://${host}/x`), method: PageText.of('GET'), resourceType: PageText.of('Script') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/timed out/u) });
  });
});

describe('the real transport pins the connection', () => {
  it('connects to the given address without resolving the hostname, and sends the hostname as Host', async () => {
    const internet = await fakeInternet({});
    const server = servers[servers.length - 1]!;
    const port = (server.address() as AddressInfo).port;
    const response = await httpTransport({ url: new URL(`http://unresolvable.invalid:${port}/probe`), address: '127.0.0.1', family: 4, method: 'GET', headers: { accept: '*/*' }, maxBytes: 1024, signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(404);
    expect(internet.hits[0]!.path).toBe(`unresolvable.invalid:${port}/probe`);
  });
});

describe('security review follow-ups (B4-2 W3, W4, N1, N3, N4)', () => {
  const host = 'a.example-cdn.com';

  it('N1: only global unicast IPv6 (2000::/3) is dialled, minus reserved and special ranges', () => {
    for (const address of ['3fff::1', '3fff:fff::1', '5f00::1', '2001:2::1', '2001:10::1', '2001:1f::1', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '4000::1', '1::1', 'e000::1']) {
      expect(isRefusedAddress(address), address).toBe(true);
    }
    for (const address of ['2606:4700:4700::1111', '2a00:1450:4001::200e', '2001:4860:4860::8888', '2620:4f:8000::1']) expect(isRefusedAddress(address), address).toBe(false);
  });

  it('N3: a session refuses an allow-list that would not pass the contract (persisted data is re-validated)', () => {
    for (const bad of [['10.0.0.1'], ['*.example-cdn.com'], ['localhost'], [host, host]]) {
      expect(() => new EgressSession(bad), JSON.stringify(bad)).toThrow(/allow-list/u);
    }
  });

  it('N4: records the query length and its SHA-256 without storing the query', async () => {
    const internet = await fakeInternet({ [host]: () => ({ status: 200, body: 'x' }) });
    const session = new EgressSession([host], { resolver: resolverFrom({ [host]: [PUBLIC] }), transport: internet.transport });
    await session.fetch({ url: PageText.of(`https://${host}/css?family=Inter&token=abc`), method: PageText.of('GET'), resourceType: PageText.of('Stylesheet') });
    await session.fetch({ url: PageText.of(`https://${host}/plain.css`), method: PageText.of('GET'), resourceType: PageText.of('Stylesheet') });
    const [withQuery, plain] = session.summary().fetches;
    expect(withQuery).toMatchObject({ origin: `https://${host}`, pathDepth: 1, queryLength: 'family=Inter&token=abc'.length, pathQuerySha256: createHash('sha256').update('/css?family=Inter&token=abc').digest('hex') });
    expect(JSON.stringify(withQuery)).not.toMatch(/token|family/u);
    expect(plain).toMatchObject({ queryLength: 0, pathQuerySha256: createHash('sha256').update('/plain.css').digest('hex') });
  });

  it('W3: caps concurrent resolutions at 2 and aborts a resolution that times out', async () => {
    let active = 0; let peak = 0; const signals: AbortSignal[] = [];
    const resolver: EgressResolver = (_hostname, signal) => { active++; peak = Math.max(peak, active); signals.push(signal); return new Promise((_, reject) => signal.addEventListener('abort', () => { active--; reject(new Error('cancelled')); }, { once: true })); };
    const session = new EgressSession([host], { resolver, transport: async () => ({ status: 200, headers: {}, body: Buffer.from('x') }), limits: { resolveTimeoutMs: 40 } });
    const answers = await Promise.all(Array.from({ length: 4 }, (_, index) => session.fetch({ url: PageText.of(`https://${host}/${index}`), method: PageText.of('GET'), resourceType: PageText.of('Image') })));
    expect(answers.every(answer => answer.kind === 'refused' && /timed out/u.test(text(answer.reason)))).toBe(true);
    expect(peak).toBe(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('W3: the system resolver uses c-ares and cancels a lookup that never answers', async () => {
    const blackhole = createSocket('udp4');
    await new Promise<void>(resolve => blackhole.bind(0, '127.0.0.1', resolve));
    try {
      const resolver = createSystemResolver({ servers: [`127.0.0.1:${blackhole.address().port}`] });
      const controller = new AbortController();
      const started = Date.now();
      const lookup = resolver('never-answers.example-cdn.com', controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(lookup).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally { blackhole.close(); }
  });

  it('W4: closing the session aborts in-flight egress and refuses queued and later requests', async () => {
    const signals: AbortSignal[] = [];
    const transport: EgressTransport = request => { signals.push(request.signal); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
    const session = new EgressSession([host], { resolver: resolverFrom({ [host]: [PUBLIC] }), transport });
    const pending = Array.from({ length: MAX_CONCURRENT_EGRESS + 2 }, (_, index) => session.fetch({ url: PageText.of(`https://${host}/${index}`), method: PageText.of('GET'), resourceType: PageText.of('Image') }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signals).toHaveLength(MAX_CONCURRENT_EGRESS);
    const started = Date.now();
    session.close();
    const answers = await Promise.all(pending);
    expect(Date.now() - started).toBeLessThan(500);
    expect(answers.every(answer => answer.kind === 'refused' && /closed/u.test(text(answer.reason)))).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(signals).toHaveLength(MAX_CONCURRENT_EGRESS);
    expect(readable(await session.fetch({ url: PageText.of(`https://${host}/late`), method: PageText.of('GET'), resourceType: PageText.of('Image') }))).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/closed/u) });
  });
});

describe('B1/W1: which paused requests may be fetched from an allowed host', () => {
  const url = 'https://good.example-cdn.com/x';
  const base = { url, method: 'GET', resourceType: 'Stylesheet', mainFrame: true, probing: false, navigationReason: 'initialFrameNavigation' as string | null, staticFrameSource: true };
  it('fetches subresources and static subframe documents, never a main-frame document, a document during a click probe, or a submission', () => {
    expect(readable(egressEligible(base, new Set()))).toEqual({ eligible: true });
    expect(readable(egressEligible({ ...base, resourceType: 'Document', mainFrame: false }, new Set()))).toEqual({ eligible: true });
    expect(readable(egressEligible({ ...base, resourceType: 'Document' }, new Set()))).toMatchObject({ eligible: false, reason: expect.stringMatching(/main-frame/u) });
    // W-A: while a click probe may still be acting, nothing reaches an allowed host, whatever its type.
    for (const resourceType of ['Document', 'Fetch', 'XHR', 'Ping', 'Image', 'Stylesheet']) {
      expect(readable(egressEligible({ ...base, resourceType, mainFrame: false, probing: true }, new Set())), resourceType).toMatchObject({ eligible: false, reason: expect.stringMatching(/click probe/u) });
    }
    expect(readable(egressEligible({ ...base, method: 'POST', resourceType: 'XHR' }, new Set()))).toMatchObject({ eligible: false });
  });
});

describe('Sol round 3 BLOCK 1: a subframe document is fetched only as a static, query-free, initial frame load', () => {
  const base = { url: 'https://good.example-cdn.com/embed', method: 'GET', resourceType: 'Document', mainFrame: false, probing: false, navigationReason: 'initialFrameNavigation' as string | null, staticFrameSource: true };
  it('accepts only initialFrameNavigation of a src declared in served markup, with no query or fragment', () => {
    expect(readable(egressEligible(base, new Set()))).toEqual({ eligible: true });
    for (const navigationReason of ['formSubmissionGet', 'formSubmissionPost', 'scriptInitiated', 'metaTagRefresh', 'httpHeaderRefresh', 'reload', 'anchorClick', 'other', null]) {
      expect(readable(egressEligible({ ...base, navigationReason }, new Set())), String(navigationReason)).toMatchObject({ eligible: false });
    }
    expect(readable(egressEligible({ ...base, navigationReason: 'formSubmissionGet' }, new Set()))).toMatchObject({ reason: expect.stringMatching(/Form submissions/u) });
    expect(readable(egressEligible({ ...base, url: 'https://good.example-cdn.com/embed?email=a' }, new Set()))).toMatchObject({ eligible: false, reason: expect.stringMatching(/query/u) });
    expect(readable(egressEligible({ ...base, staticFrameSource: false }, new Set()))).toMatchObject({ eligible: false, reason: expect.stringMatching(/markup/u) });
    // Subresources do not depend on a navigation cause.
    expect(readable(egressEligible({ ...base, resourceType: 'Image', navigationReason: null, staticFrameSource: false }, new Set()))).toEqual({ eligible: true });
  });
});
