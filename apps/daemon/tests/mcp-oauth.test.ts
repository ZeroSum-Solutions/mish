import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PendingAuthCache,
  beginAuth,
  buildAuthorizeUrl,
  deriveCodeChallenge,
  discoverAuthServer,
  discoverProtectedResource,
  exchangeCodeForToken,
  generateCodeVerifier,
  generateState,
  getOrRegisterClient,
  refreshAccessToken,
} from '../src/mcp-oauth.js';

// Tiny fetch mock — looks up the URL in a Map and returns canned JSON.
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function makeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const route = routes[url];
    if (!route) {
      return new Response(`unknown url ${url}`, { status: 404 });
    }
    void init;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('PKCE helpers', () => {
  it('generates a 43+ char code_verifier per RFC 7636', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a different verifier each call (randomness sanity check)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('derives a S256 challenge that matches the spec example', () => {
    // RFC 7636 Appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('derived challenge is exactly base64url(sha256(verifier))', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('generates a base64url-safe state token', () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeGreaterThan(20);
  });
});

describe('discoverProtectedResource', () => {
  it('discovers metadata relative to a provider function path after origin candidates fail', async () => {
    const resource = 'https://provider.example/functions/v1/mcp';
    const fetchImpl = makeFetch({
      'https://provider.example/.well-known/oauth-protected-resource/functions/v1/mcp': {
        status: 401, body: { error: 'gateway route requires authorization' },
      },
      [`${resource}/.well-known/oauth-protected-resource`]: {
        body: { resource, authorization_servers: ['https://provider.example/auth/v1'] },
      },
    });
    await expect(discoverProtectedResource(resource, fetchImpl as typeof fetch)).resolves.toEqual({
      resource, authorization_servers: ['https://provider.example/auth/v1'],
    });
  });

  it('skips malformed metadata instead of accepting an error document as discovery', async () => {
    const resource = 'https://provider.example/functions/v1/mcp';
    const fetchImpl = makeFetch({
      'https://provider.example/.well-known/oauth-protected-resource/functions/v1/mcp': {
        body: { authorization_servers: 'not-an-array' },
      },
      'https://provider.example/.well-known/oauth-protected-resource': {
        body: { authorization_servers: ['file:///private/auth'] },
      },
      [`${resource}/.well-known/oauth-protected-resource`]: {
        body: { resource, authorization_servers: ['https://provider.example/auth/v1'] },
      },
    });
    expect((await discoverProtectedResource(resource, fetchImpl as typeof fetch))?.authorization_servers)
      .toEqual(['https://provider.example/auth/v1']);
  });

  it('fetches the path-suffixed metadata when present', async () => {
    const fetchImpl = makeFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        body: {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['read'],
        },
      },
    });
    const out = await discoverProtectedResource(
      'https://mcp.example.com/mcp',
      fetchImpl as typeof fetch,
    );
    expect(out?.resource).toBe('https://mcp.example.com/mcp');
    expect(out?.authorization_servers).toEqual(['https://auth.example.com']);
  });

  it('falls back to the bare well-known when the path-suffixed form 404s', async () => {
    const fetchImpl = makeFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        status: 404,
        body: {},
      },
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        body: {
          resource: 'https://mcp.example.com',
          authorization_servers: ['https://mcp.example.com'],
        },
      },
    });
    const out = await discoverProtectedResource(
      'https://mcp.example.com/mcp',
      fetchImpl as typeof fetch,
    );
    expect(out?.authorization_servers).toEqual(['https://mcp.example.com']);
  });

  it('returns null when neither candidate responds', async () => {
    const fetchImpl = makeFetch({});
    const out = await discoverProtectedResource(
      'https://mcp.example.com/mcp',
      fetchImpl as typeof fetch,
    );
    expect(out).toBeNull();
  });
});

describe('discoverAuthServer', () => {
  it('discovers OIDC metadata beneath the issuer path', async () => {
    const issuer = 'https://provider.example/auth/v1';
    const fetchImpl = makeFetch({
      [`${issuer}/.well-known/openid-configuration`]: {
        body: { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` },
      },
    });
    expect((await discoverAuthServer(issuer, fetchImpl as typeof fetch))?.issuer).toBe(issuer);
  });

  it('rejects metadata containing non-HTTP credential endpoints', async () => {
    const fetchImpl = makeFetch({
      'https://provider.example/.well-known/oauth-authorization-server': {
        body: { issuer: 'https://provider.example', authorization_endpoint: 'file:///private/authorize', token_endpoint: 'https://provider.example/token' },
      },
    });
    expect(await discoverAuthServer('https://provider.example', fetchImpl as typeof fetch)).toBeNull();
  });

  it('parses an oauth-authorization-server document', async () => {
    const fetchImpl = makeFetch({
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        body: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        },
      },
    });
    const out = await discoverAuthServer(
      'https://auth.example.com',
      fetchImpl as typeof fetch,
    );
    expect(out?.token_endpoint).toBe('https://auth.example.com/token');
    expect(out?.registration_endpoint).toBe('https://auth.example.com/register');
  });

  it('falls back to openid-configuration when oauth-authorization-server is absent', async () => {
    const fetchImpl = makeFetch({
      'https://auth.example.com/.well-known/openid-configuration': {
        body: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/oidc/auth',
          token_endpoint: 'https://auth.example.com/oidc/token',
        },
      },
    });
    const out = await discoverAuthServer(
      'https://auth.example.com',
      fetchImpl as typeof fetch,
    );
    expect(out?.authorization_endpoint).toBe('https://auth.example.com/oidc/auth');
  });
});

describe('buildAuthorizeUrl', () => {
  it('emits all the required PKCE-flow parameters', () => {
    const url = buildAuthorizeUrl({
      authServer: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
      clientId: 'client-xyz',
      redirectUri: 'https://app.example.com/api/mcp/oauth/callback',
      state: 'state-abc',
      codeChallenge: 'challenge-pqr',
      scope: 'openid email',
      resource: 'https://mcp.example.com/mcp',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client-xyz');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/mcp/oauth/callback',
    );
    expect(parsed.searchParams.get('state')).toBe('state-abc');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-pqr');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('openid email');
    expect(parsed.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
  });
});

describe('client registration cache', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mcp-oauth-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers a fresh client and persists it for reuse', async () => {
    let registerHits = 0;
    const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://auth.example.com/register') {
        registerHits++;
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.redirect_uris).toEqual([
          'https://app.example.com/api/mcp/oauth/callback',
        ]);
        return new Response(
          JSON.stringify({ client_id: 'fresh-client-id' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;

    const meta = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
    };

    const a = await getOrRegisterClient(
      dataDir,
      meta,
      'https://app.example.com/api/mcp/oauth/callback',
      fetchImpl,
    );
    expect(a.clientId).toBe('fresh-client-id');
    expect(registerHits).toBe(1);

    const b = await getOrRegisterClient(
      dataDir,
      meta,
      'https://app.example.com/api/mcp/oauth/callback',
      fetchImpl,
    );
    expect(b.clientId).toBe('fresh-client-id');
    expect(registerHits).toBe(1); // cached, no second register

    const cacheFile = JSON.parse(
      await readFile(path.join(dataDir, 'mcp-oauth-clients.json'), 'utf8'),
    );
    expect(cacheFile.clients).toHaveLength(1);
    expect(cacheFile.clients[0].clientId).toBe('fresh-client-id');
  });

  it('does not register when the cache file already pins a matching client', async () => {
    await writeFile(
      path.join(dataDir, 'mcp-oauth-clients.json'),
      JSON.stringify({
        clients: [
          {
            authServerIssuer: 'https://auth.example.com',
            redirectUri: 'https://app.example.com/api/mcp/oauth/callback',
            clientId: 'pinned-client',
            registeredAt: 0,
          },
        ],
      }),
    );
    const fetchImpl = (async () => {
      throw new Error('fetch should not be called when cache hits');
    }) as unknown as typeof fetch;
    const out = await getOrRegisterClient(
      dataDir,
      {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      },
      'https://app.example.com/api/mcp/oauth/callback',
      fetchImpl,
    );
    expect(out.clientId).toBe('pinned-client');
  });
});

describe('OAuth discovery refusals', () => {
  it('reports a connect-time egress refusal instead of "no metadata here"', async () => {
    const { EgressRefusedError } = await import('../src/http/egress-guard.js');
    let calls = 0;
    const refusing = (async () => {
      calls += 1;
      throw new TypeError('fetch failed', { cause: new EgressRefusedError('host resolves to a non-public address: mcp.example.com -> 10.0.0.5', 'non-public-host') });
    }) as typeof fetch;
    await expect(discoverProtectedResource('https://mcp.example.com/mcp', refusing)).rejects.toMatchObject({ code: 'MCP_OAUTH_URL_REFUSED' });
    expect(calls).toBe(1);
  });

  it('refuses a discovery redirect into an internal address, even when the caller injects plain fetch', async () => {
    const urls: string[] = [];
    const redirecting = (async (input: FetchInput) => {
      urls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }) as typeof fetch;
    await expect(discoverAuthServer('https://auth.example.com', redirecting)).rejects.toMatchObject({ code: 'MCP_OAUTH_URL_REFUSED' });
    expect(urls).toHaveLength(1);
  });

  it('follows a same-origin discovery redirect (trailing slash)', async () => {
    const urls: string[] = [];
    const metadata = { authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token' };
    const fetchImpl = (async (input: FetchInput) => {
      const url = String(input);
      urls.push(url);
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return new Response(null, { status: 301, headers: { location: '/.well-known/oauth-authorization-server/' } });
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/') {
        return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await expect(discoverAuthServer('https://auth.example.com', fetchImpl)).resolves.toMatchObject(metadata);
    expect(urls.at(-1)).toBe('https://auth.example.com/.well-known/oauth-authorization-server/');
  });

  it('a configured public host name gets no loopback allowance (only typed loopback does)', async () => {
    const { configuredEndpointPolicy } = await import('../src/http/egress-guard.js');
    expect(configuredEndpointPolicy('https://attacker.example:11434/mcp')).toBe('public');
    expect(configuredEndpointPolicy('http://127.0.0.1:3333/mcp')).toBe('user-endpoint');
    expect(configuredEndpointPolicy('http://localhost:3333/mcp')).toBe('user-endpoint');
    expect(configuredEndpointPolicy('http://[::1]:3333/mcp')).toBe('user-endpoint');
    expect(configuredEndpointPolicy('not a url')).toBe('public');
  });
});

describe('exchangeCodeForToken / refreshAccessToken', () => {
  it.each([
    { status: 307, flow: 'exchange' }, { status: 308, flow: 'exchange' },
    { status: 307, flow: 'refresh' }, { status: 308, flow: 'refresh' },
  ])('refuses HTTP $status for $flow without reposting credential bodies to another origin', async ({ status, flow }) => {
    const sourceBodies: string[] = [];
    const destinationBodies: string[] = [];
    const servers: Server[] = [];
    const listen = async (server: Server) => {
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    try {
      const destination = await listen(createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk.toString();
        destinationBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fixture-rotated-token' }));
      }));
      const issuer = await listen(createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk.toString();
        sourceBodies.push(body);
        res.writeHead(status, { location: `${destination}/capture` }); res.end();
      }));
      // The loopback token endpoint is the configured server's own origin.
      const common = { tokenEndpoint: `${issuer}/token`, clientId: 'fixture-client', clientSecret: 'fixture-client-secret', serverOrigin: issuer };
      const request = flow === 'exchange'
        ? exchangeCodeForToken({ ...common, code: 'fixture-authorization-code', codeVerifier: 'fixture-pkce-verifier', redirectUri: 'http://127.0.0.1/callback' })
        : refreshAccessToken({ ...common, refreshToken: 'fixture-refresh-token' });
      const error = await request.then(() => null, reason => reason);
      expect(sourceBodies).toHaveLength(1);
      const sent = new URLSearchParams(sourceBodies[0]);
      expect(sent.get('grant_type')).toBe(flow === 'exchange' ? 'authorization_code' : 'refresh_token');
      expect(sent.get(flow === 'exchange' ? 'code' : 'refresh_token')).toBe(flow === 'exchange' ? 'fixture-authorization-code' : 'fixture-refresh-token');
      if (flow === 'exchange') expect(sent.get('code_verifier')).toBe('fixture-pkce-verifier');
      expect(destinationBodies).toEqual([]);
      // The guard sees the 3xx itself and refuses it as a typed policy error.
      expect(error).toMatchObject({ code: 'MCP_OAUTH_URL_REFUSED' });
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });

  it('POSTs the form-encoded grant_type=authorization_code with PKCE verifier', async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://auth.example.com/token') {
        captured = {
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ''),
        };
        return new Response(
          JSON.stringify({
            access_token: 'tok-xyz',
            token_type: 'Bearer',
            refresh_token: 'ref-xyz',
            expires_in: 3600,
            scope: 'a b',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;

    const out = await exchangeCodeForToken(
      {
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'cid',
        redirectUri: 'https://app.example.com/cb',
        code: 'AUTHCODE',
        codeVerifier: 'verifier-1',
        resource: 'https://mcp.example.com/mcp',
      },
      fetchImpl,
    );
    expect(out.access_token).toBe('tok-xyz');
    expect(captured).not.toBeNull();
    const params = new URLSearchParams(captured!.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('AUTHCODE');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('code_verifier')).toBe('verifier-1');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(params.get('resource')).toBe('https://mcp.example.com/mcp');
  });

  it('refresh exchange uses grant_type=refresh_token', async () => {
    let captured = '';
    const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://auth.example.com/token') {
        captured = String(init?.body ?? '');
        return new Response(
          JSON.stringify({ access_token: 'rotated', token_type: 'Bearer' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;

    const out = await refreshAccessToken(
      {
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'cid',
        refreshToken: 'old-refresh',
      },
      fetchImpl,
    );
    expect(out.access_token).toBe('rotated');
    const params = new URLSearchParams(captured);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('old-refresh');
  });

  it('throws when the token endpoint returns a non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response('access_denied', { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'cid',
          redirectUri: 'https://app.example.com/cb',
          code: 'AUTHCODE',
          codeVerifier: 'verifier-1',
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe('PendingAuthCache', () => {
  it('round-trips a value through put/consume', () => {
    const cache = new PendingAuthCache(60_000);
    cache.put('state-1', {
      serverId: 'higgsfield',
      authServerIssuer: 'https://auth.example.com',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'cid',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'verifier',
      createdAt: Date.now(),
    });
    expect(cache.size()).toBe(1);
    const got = cache.consume('state-1');
    expect(got?.serverId).toBe('higgsfield');
    expect(cache.consume('state-1')).toBeNull();
    cache.stop();
  });

  it('drops entries past TTL', () => {
    const cache = new PendingAuthCache(10);
    cache.put('s', {
      serverId: 'x',
      authServerIssuer: 'i',
      tokenEndpoint: 't',
      clientId: 'c',
      redirectUri: 'r',
      codeVerifier: 'v',
      createdAt: Date.now() - 1000,
    });
    expect(cache.consume('s')).toBeNull();
    cache.stop();
  });
});

describe('beginAuth (end-to-end with mocked discovery + DCR)', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mcp-begin-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reconnects the configured provider path using its resource audience and existing cached client', async () => {
    const serverUrl = 'https://provider.example/functions/v1/mcp';
    const issuer = 'https://provider.example/auth/v1';
    const redirectUri = 'https://app.example.com/api/mcp/oauth/callback';
    await writeFile(path.join(dataDir, 'mcp-oauth-clients.json'), JSON.stringify({ clients: [{
      authServerIssuer: issuer, redirectUri, clientId: 'existing-client', registeredAt: Date.now(),
    }] }));
    const fetchImpl = makeFetch({
      [`${serverUrl}/.well-known/oauth-protected-resource`]: {
        body: { resource: serverUrl, authorization_servers: [issuer], scopes_supported: ['mcp:tools'] },
      },
      'https://provider.example/.well-known/oauth-authorization-server/auth/v1': {
        body: { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` },
      },
    });
    const out = await beginAuth({ serverId: 'motionsites', serverUrl, redirectUri, dataDir, fetchImpl: fetchImpl as typeof fetch });
    const url = new URL(out.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${issuer}/oauth/authorize`);
    expect(url.searchParams.get('resource')).toBe(serverUrl);
    expect(url.searchParams.get('client_id')).toBe('existing-client');
    expect(url.searchParams.get('scope')).toBe('mcp:tools');
    expect(out.pending).toMatchObject({ serverId: 'motionsites', authServerIssuer: issuer, resourceUrl: serverUrl, tokenEndpoint: `${issuer}/oauth/token` });
  });

  it('discovers, registers, generates PKCE, returns a usable authorize URL', async () => {
    let registerHits = 0;
    const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const routes: Record<string, { status?: number; body: unknown }> = {
        'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
          body: {
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['mcp:tools'],
          },
        },
        'https://auth.example.com/.well-known/oauth-authorization-server': {
          body: {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          },
        },
      };
      if (url === 'https://auth.example.com/register') {
        registerHits++;
        return new Response(
          JSON.stringify({ client_id: 'cid-1' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      const route = routes[url];
      if (!route) return new Response('404', { status: 404 });
      void init;
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
    }) as typeof fetch;

    const out = await beginAuth({
      serverId: 'higgsfield',
      serverUrl: 'https://mcp.example.com/mcp',
      redirectUri: 'https://app.example.com/api/mcp/oauth/callback',
      dataDir,
      fetchImpl,
    });

    expect(registerHits).toBe(1);
    const u = new URL(out.authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://auth.example.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid-1');
    expect(u.searchParams.get('state')).toBe(out.state);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('mcp:tools');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(out.pending.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(out.pending.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(out.pending.serverId).toBe('higgsfield');
  });

  it('falls back to the resource origin when no protected-resource metadata is published', async () => {
    const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Both discovery probes for the resource come back 404 — caller falls
      // back to assuming the origin IS the auth server.
      if (url.endsWith('/oauth-protected-resource/mcp')) {
        return new Response('404', { status: 404 });
      }
      if (url.endsWith('/oauth-protected-resource')) {
        return new Response('404', { status: 404 });
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            issuer: 'https://mcp.example.com',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
            registration_endpoint: 'https://mcp.example.com/register',
          }),
        );
      }
      if (url === 'https://mcp.example.com/register') {
        return new Response(JSON.stringify({ client_id: 'cid-fallback' }), { status: 201 });
      }
      void init;
      return new Response('?', { status: 404 });
    }) as typeof fetch;

    const out = await beginAuth({
      serverId: 'h',
      serverUrl: 'https://mcp.example.com/',
      redirectUri: 'https://app.example.com/cb',
      dataDir,
      fetchImpl,
    });
    expect(new URL(out.authorizeUrl).origin).toBe('https://mcp.example.com');
  });

  it('throws when the auth server cannot be discovered', async () => {
    const fetchImpl = (async () => new Response('404', { status: 404 })) as unknown as typeof fetch;
    await expect(
      beginAuth({
        serverId: 'h',
        serverUrl: 'https://mcp.example.com/',
        redirectUri: 'https://app.example.com/cb',
        dataDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/could not discover/i);
  });
});

// Every URL the OAuth module learns from remote metadata is `public`; only the
// configured MCP server's own origin may be loopback or an allow-listed host.
describe('MCP OAuth egress guard', () => {
  let dataDir: string;
  const servers: Server[] = [];
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mcp-egress-'));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(dataDir, { recursive: true, force: true });
  });

  function recordingFetch(routes: Record<string, { status?: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string }> = [];
    const impl = (async (input: FetchInput, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      const route = routes[url];
      if (route) {
        return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      // Anything else "succeeds", so only the guard can stop the flow.
      if (method === 'POST') {
        return new Response(JSON.stringify({ client_id: 'leaked', access_token: 'leaked' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
  }

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('never contacts an authorization server at the metadata address 169.254.169.254', async () => {
    const serverUrl = 'https://mcp.example.com/mcp';
    const { impl, calls } = recordingFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        body: { resource: serverUrl, authorization_servers: ['http://169.254.169.254/'] },
      },
    });
    await expect(
      beginAuth({ serverId: 's', serverUrl, redirectUri: 'https://app.example.com/cb', dataDir, fetchImpl: impl }),
    ).rejects.toThrow();
    expect(calls.map((call) => new URL(call.url).hostname)).not.toContain('169.254.169.254');
  });

  it('sends no registration POST to a private registration_endpoint', async () => {
    const serverUrl = 'https://mcp.example.com/mcp';
    const { impl, calls } = recordingFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        body: { resource: serverUrl, authorization_servers: ['https://auth.example.com'] },
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        body: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'http://10.0.0.5/register',
        },
      },
    });
    await expect(
      beginAuth({ serverId: 's', serverUrl, redirectUri: 'https://app.example.com/cb', dataDir, fetchImpl: impl }),
    ).rejects.toThrow();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it.each(['refresh', 'exchange'] as const)('%s sends nothing to a stored private token endpoint of a public server', async (flow) => {
    const { impl, calls } = recordingFetch({});
    const common = { tokenEndpoint: 'http://10.0.0.5/token', clientId: 'cid', serverOrigin: 'https://mcp.example.com/mcp' };
    const request = flow === 'refresh'
      ? refreshAccessToken({ ...common, refreshToken: 'fixture-refresh-token' }, impl)
      : exchangeCodeForToken({ ...common, code: 'c', codeVerifier: 'v', redirectUri: 'https://app.example.com/cb' }, impl);
    await expect(request).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses an authorization server on another loopback origin than the configured server', async () => {
    const other = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const serverOrigin = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: [other] }));
    });
    const seen: string[] = [];
    const impl = (async (input: FetchInput, init?: FetchInit) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return fetch(input, init);
    }) as typeof fetch;
    await expect(
      beginAuth({ serverId: 's', serverUrl: `${serverOrigin}/mcp`, redirectUri: 'https://app.example.com/cb', dataDir, fetchImpl: impl }),
    ).rejects.toThrow();
    expect(seen.filter((url) => url.startsWith(other))).toEqual([]);
  });

  it('still completes discovery and registration for a same-origin loopback server', async () => {
    let origin = '';
    origin = await listen(async (req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      }
      if (req.url === '/register' && req.method === 'POST') {
        for await (const _chunk of req) { /* drain */ }
        return json(201, { client_id: 'loopback-client' });
      }
      return json(404, {});
    });
    const out = await beginAuth({ serverId: 's', serverUrl: `${origin}/mcp`, redirectUri: 'https://app.example.com/cb', dataDir });
    expect(new URL(out.authorizeUrl).origin).toBe(origin);
    expect(out.pending.clientId).toBe('loopback-client');
  });
});
