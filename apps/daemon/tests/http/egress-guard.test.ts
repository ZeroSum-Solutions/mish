// The daemon egress guard: every hop of a fetch the daemon did not hard-code
// is checked at URL level (Node never runs the connect-time lookup for an IP
// literal), and every DNS answer is checked at connect time.
//
// The guard module is imported inside each test, so on a tree without it the
// safeExternalFetch cases still show their real assertion failures.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { safeExternalFetch } from '../../src/plugins/plugin-asset-cache.js';

const loadGuard = () => import('../../src/http/egress-guard.js');

type Call = { url: string; init: RequestInit };

/** A fetch stub that answers each call with the next canned response. */
function chain(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const ok = (body = 'ok') => () => new Response(body, { status: 200 });

// Hops a public URL must never be redirected into.
const INTERNAL_HOPS = ['http://127.0.0.1:9/', 'http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://169.254.169.254/latest/meta-data/'];

describe('safeExternalFetch checks every redirect hop', () => {
  it.each(INTERNAL_HOPS)('refuses a 302 from a public URL to %s and never requests it', async (hop) => {
    const { impl, calls } = chain([redirectTo(hop), redirectTo('http://[::ffff:a9fe:a9fe]/'), ok()]);
    await expect(safeExternalFetch('https://cdn.example.com/a.png', {}, impl)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('follows a redirect to another public URL', async () => {
    const { impl, calls } = chain([redirectTo('https://other.example.com/b.png'), ok('image')]);
    const res = await safeExternalFetch('https://cdn.example.com/a.png', {}, impl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('image');
    expect(calls.map((call) => call.url)).toEqual(['https://cdn.example.com/a.png', 'https://other.example.com/b.png']);
  });

  it('returns the 3xx untouched when the caller asks for manual redirects (github-fetcher re-enters per hop)', async () => {
    const { impl, calls } = chain([redirectTo('http://127.0.0.1:9/')]);
    const res = await safeExternalFetch('https://api.github.com/x', { redirect: 'manual' }, impl);
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });
});

describe('guardedFetch redirect modes', () => {
  it.each(INTERNAL_HOPS)('follow-checked refuses a hop to %s after exactly one request', async (hop) => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo(hop), ok()]);
    await expect(
      guardedFetch('https://cdn.example.com/a.png', {}, { policy: 'public', redirects: 'follow-checked', fetchImpl: impl }),
    ).rejects.toThrow(/refus|non-public/i);
    expect(calls).toHaveLength(1);
  });

  it('follow-checked stops after maxRedirects hops', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo('https://a.example/1'), redirectTo('https://a.example/2'), redirectTo('https://a.example/3')]);
    await expect(
      guardedFetch('https://a.example/0', {}, { policy: 'public', redirects: 'follow-checked', maxRedirects: 2, fetchImpl: impl }),
    ).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(3);
  });

  it('error mode rejects any 3xx', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo('https://other.example.com/')]);
    await expect(
      guardedFetch('https://cdn.example.com/', {}, { policy: 'public', redirects: 'error', fetchImpl: impl }),
    ).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('error mode also rejects 300, 305 and 306, and passes 304 through', async () => {
    const { guardedFetch, EgressRefusedError } = await loadGuard();
    for (const status of [300, 305, 306]) {
      const { impl } = chain([redirectTo('http://127.0.0.1:9/', status)]);
      const err = await guardedFetch('https://cdn.example.com/', {}, { policy: 'public', redirects: 'error', fetchImpl: impl }).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(EgressRefusedError);
      expect((err as InstanceType<typeof EgressRefusedError>).reason).toBe('redirect');
    }
    const { impl } = chain([() => new Response(null, { status: 304 })]);
    const res = await guardedFetch('https://cdn.example.com/', {}, { policy: 'public', redirects: 'error', fetchImpl: impl });
    expect(res.status).toBe(304);
  });

  it('follow-checked checks a 300 Location like any other hop', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo('http://169.254.169.254/latest/meta-data/', 300)]);
    await expect(
      guardedFetch('https://cdn.example.com/', {}, { policy: 'public', redirects: 'follow-checked', fetchImpl: impl }),
    ).rejects.toThrow(/non-public/);
    expect(calls).toHaveLength(1);
  });

  it('egressRefusalOf finds a refusal wrapped in a fetch TypeError cause', async () => {
    const { egressRefusalOf, EgressRefusedError } = await loadGuard();
    const refusal = new EgressRefusedError('host resolves to a non-public address', 'non-public-host');
    expect(egressRefusalOf(refusal)).toBe(refusal);
    expect(egressRefusalOf(new TypeError('fetch failed', { cause: refusal }))).toBe(refusal);
    expect(egressRefusalOf(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))).toBeNull();
    expect(egressRefusalOf('nope')).toBeNull();
  });

  it('return mode hands back the 3xx untouched', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo('http://127.0.0.1:9/', 307)]);
    const res = await guardedFetch('https://cdn.example.com/', {}, { policy: 'public', redirects: 'return', fetchImpl: impl });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://127.0.0.1:9/');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('refuses a non-public entry URL before any request', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([ok()]);
    for (const url of ['http://[::a9fe:a9fe]/', 'http://[2002:a9fe:a9fe::]/', 'http://localhost/', 'http://user:pw@cdn.example.com/', 'file:///etc/passwd']) {
      await expect(guardedFetch(url, {}, { policy: 'public', redirects: 'error', fetchImpl: impl }), url).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it('drops credential headers on a cross-origin hop and keeps them on the same origin', async () => {
    const { guardedFetch } = await loadGuard();
    const { impl, calls } = chain([redirectTo('https://api.example.com/same'), redirectTo('https://cdn.other.example/elsewhere'), ok()]);
    const headers = { authorization: 'Bearer secret', cookie: 'sid=1', 'x-api-key': 'k', accept: 'application/json' };
    await guardedFetch('https://api.example.com/start', { headers }, { policy: 'public', redirects: 'follow-checked', fetchImpl: impl });
    expect(calls).toHaveLength(3);
    const sameOrigin = new Headers(calls[1]!.init.headers);
    expect(sameOrigin.get('authorization')).toBe('Bearer secret');
    const crossOrigin = new Headers(calls[2]!.init.headers);
    expect(crossOrigin.get('authorization')).toBeNull();
    expect(crossOrigin.get('cookie')).toBeNull();
    expect(crossOrigin.get('x-api-key')).toBeNull();
    expect(crossOrigin.get('accept')).toBe('application/json');
  });
});

describe('guardedFetch on real sockets', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; hits: () => number }> {
    let count = 0;
    const server = createServer((req, res) => {
      count += 1;
      handler!(req, res);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { port: (server.address() as AddressInfo).port, hits: () => count };
  }

  /** A `dns.lookup` stand-in that answers 127.0.0.1 for every name. */
  function loopbackLookup() {
    const names: string[] = [];
    const impl = ((hostname: string, options: unknown, callback?: unknown) => {
      const cb = (typeof options === 'function' ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      names.push(hostname);
      if (all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
      else cb(null, '127.0.0.1', 4);
    }) as unknown as typeof import('node:dns').lookup;
    return { impl, names };
  }

  it('refuses a public name whose DNS answer is loopback, and the canary is never hit', async () => {
    const { guardedFetch } = await loadGuard();
    const canary = await listen((_req, res) => res.end('canary'));
    const lookup = loopbackLookup();
    await expect(
      guardedFetch(`http://public.test:${canary.port}/`, {}, { policy: 'public', redirects: 'error', lookupImpl: lookup.impl }),
    ).rejects.toThrow();
    expect(lookup.names).toContain('public.test');
    expect(canary.hits()).toBe(0);
  });

  it('control: the same name and answer pass under user-endpoint (the lookup is the one that refused)', async () => {
    const { guardedFetch } = await loadGuard();
    const canary = await listen((_req, res) => res.end('canary'));
    const lookup = loopbackLookup();
    const res = await guardedFetch(`http://public.test:${canary.port}/`, {}, { policy: 'user-endpoint', redirects: 'error', lookupImpl: lookup.impl });
    expect(await res.text()).toBe('canary');
    expect(canary.hits()).toBe(1);
  });

  it('a user-endpoint redirector cannot bounce the daemon to another loopback origin', async () => {
    const { guardedFetch } = await loadGuard();
    const canary = await listen((_req, res) => res.end('canary'));
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${canary.port}/secret` });
      res.end();
    });
    await expect(
      guardedFetch(`http://127.0.0.1:${redirector.port}/`, {}, { policy: 'user-endpoint', redirects: 'follow-checked' }),
    ).rejects.toThrow(/non-public/);
    expect(redirector.hits()).toBe(1);
    expect(canary.hits()).toBe(0);
  });
});
