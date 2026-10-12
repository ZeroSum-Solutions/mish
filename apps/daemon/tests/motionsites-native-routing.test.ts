import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionSitesCatalogResponse } from '@open-design/contracts/api/motionsites';
import type { SectionsListResponse } from '@open-design/contracts/api/section-catalog';

import { writeMcpConfig } from '../src/mcp-config.js';
import { getToken, setToken } from '../src/mcp-tokens.js';
import { registerMotionSitesRoutes } from '../src/routes/motionsites.js';
import { registerSectionsRoutes } from '../src/routes/sections.js';
import { sendApiError } from '../src/http/api-errors.js';
import { fetchMotionSitesDesignReference } from '../src/motionsites/design-reference.js';
import { MotionSitesLoginRequiredError } from '../src/motionsites/errors.js';
import { resetLocalCorpusCache } from '../src/motionsites/local-corpus-source.js';

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// Real HTTP plus the production route registrar and saved MCP config/token. No shared daemon,
// provider account, paid generation, or test-only route injection. The old hardcoded URL cannot
// reach this provider; requests to a wrong provider path fail rather than passing a permissive mock.
describe('native MotionSites routing through the configured connection', () => {
  let dataDir: string;
  let native: Awaited<ReturnType<typeof listen>>;
  let provider: Awaited<ReturnType<typeof listen>>;
  let endpoint: string;
  let calls: Array<{ method: string; tool?: string; args?: unknown }>;
  let expectedAuthorization: string;
  let refreshResources: unknown[];

  async function configure(enabled = true, url = endpoint, authMode: 'oauth' | 'none' = 'oauth'): Promise<void> {
    await writeMcpConfig(dataDir, { servers: [{
      id: 'motionsites', enabled, transport: 'http', authMode, url,
      headers: { 'X-Provider-Access': 'fixture-header' },
    }] });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-motionsites-routing-'));
    resetLocalCorpusCache([]);
    calls = [];
    expectedAuthorization = 'Bearer fixture-token';
    refreshResources = [];
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.post('/token', (req, res) => {
      refreshResources.push(req.body.resource);
      res.json({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 });
    });
    app.post('/functions/v1/mcp', (req, res) => {
      // The native bridge must reuse OAuth and configured provider headers on every request.
      if (req.get('Authorization') !== expectedAuthorization || req.get('X-Provider-Access') !== 'fixture-header') {
        res.status(401).end();
        return;
      }
      const { id, method, params } = req.body;
      calls.push({ method, ...(params?.name ? { tool: params.name, args: params.arguments } : {}) });
      if (method === 'notifications/initialized') {
        res.status(202).end();
        return;
      }
      const result = method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
        : params.name === 'get_prompt' ? { structuredContent: { text: 'Invented transient design guidance for this test.' } }
          : { content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'fixture-hero', title: 'Fixture Hero', category: 'Hero', kind: 'website', access: 'free', url: 'https://motionsites.ai/?prompt=fixture-hero' }] }) }] };
      res.json({ jsonrpc: '2.0', id, result });
    });
    provider = await listen(app);
    endpoint = `${provider.url}/functions/v1/mcp`;
    await configure();
    await setToken(dataDir, 'motionsites', {
      accessToken: 'fixture-token', tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint(endpoint), resourceUrl: endpoint, savedAt: Date.now(),
    });
    const nativeApp = express();
    const ctx: Parameters<typeof registerMotionSitesRoutes>[1] = {
      http: { sendApiError } as Parameters<typeof registerMotionSitesRoutes>[1]['http'],
      paths: { RUNTIME_DATA_DIR: dataDir } as Parameters<typeof registerMotionSitesRoutes>[1]['paths'],
    };
    registerMotionSitesRoutes(nativeApp, ctx);
    registerSectionsRoutes(nativeApp, ctx);
    native = await listen(nativeApp);
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith(`${native.url}/`) || url.startsWith(`${provider.url}/`)
        ? realFetch(input, init) : Promise.resolve(new Response(null, { status: 404 }));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const runtime of [native, provider]) {
      await new Promise<void>((resolve, reject) => runtime.server.close((err) => err ? reject(err) : resolve()));
    }
    resetLocalCorpusCache(null);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves the existing UI/od catalog API from the configured provider path', async () => {
    const response = await fetch(`${native.url}/api/sections`);
    expect(response.status).toBe(200);
    const body = await response.json() as SectionsListResponse;
    expect(body.upstream).toBeUndefined();
    expect(body.catalog.entries.filter((entry: { sourceKind: string }) => entry.sourceKind === 'motionsites-prompt')
      .map((entry: { id: string }) => entry.id)).toEqual(['motionsites-prompt:fixture-hero']);
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(calls[2]).toMatchObject({ tool: 'list_prompts', args: {} });
  });

  it('routes native search and the build reference through the same saved connection', async () => {
    const response = await fetch(`${native.url}/api/motionsites/catalog?query=hero&limit=1`);
    const body = await response.json() as MotionSitesCatalogResponse;
    expect(body.upstream).toBeUndefined();
    expect(body.catalog.entries).toHaveLength(1);
    expect(calls[2]).toMatchObject({ tool: 'search_prompts', args: { query: 'hero', limit: 1 } });
    await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:fixture-hero')).resolves.toEqual({
      promptId: 'motionsites-prompt:fixture-hero', text: 'Invented transient design guidance for this test.',
    });
    expect(calls[5]).toMatchObject({ tool: 'get_prompt', args: { id: 'fixture-hero' } });
    for (const filename of ['mcp-config.json', 'mcp-tokens.json']) {
      expect(await readFile(path.join(dataDir, filename), 'utf8')).not.toContain('Invented transient design guidance');
    }
  });

  it('does not contact or report a disabled source as connected', async () => {
    await configure(false);
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.connection).toBe('not_connected');
    expect(body.catalog.entries).toEqual([]);
    await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:fixture-hero')).rejects.toThrow(MotionSitesLoginRequiredError);
    expect(calls).toEqual([]);
  });

  it('does not forward a resource-bound token after the configured endpoint changes', async () => {
    await configure(true, `${provider.url}/other-mcp`);
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.connection).toBe('not_connected');
    expect(body.catalog.entries).toEqual([]);
    await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:fixture-hero')).rejects.toThrow(MotionSitesLoginRequiredError);
    expect(calls).toEqual([]);
  });

  it('does not use a stored OAuth token when managed OAuth is disabled', async () => {
    await configure(true, endpoint, 'none');
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.connection).toBe('not_connected');
    expect(body.catalog.entries).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reports an unsupported configured transport without silently calling the default URL', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'motionsites', enabled: true, transport: 'stdio', command: 'fixture-mcp' }] });
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.connection).toBe('not_connected');
    expect(body.upstream?.code).toBe('MOTIONSITES_UPSTREAM_UNAVAILABLE');
    expect(body.catalog.entries).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    { 'invalid name': 'private-fixture' },
    { 'X-Private-Fixture': 'private-fixture\nextra' },
    { 'X-Private-Fixture': 'private-fixture\u2014' },
  ])('degrades malformed saved headers to a sanitized catalog error', async (headers) => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'motionsites', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint, headers }] });
    for (const route of ['/api/sections', '/api/motionsites/catalog']) {
      const response = await fetch(`${native.url}${route}`);
      expect(response.status).toBe(200);
      const body = await response.json() as MotionSitesCatalogResponse;
      expect(body.upstream).toEqual({ code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: 'Configured MotionSites headers are not valid HTTP headers' });
      expect(JSON.stringify(body)).not.toContain('private-fixture');
    }
    expect(calls).toEqual([]);
  });

  it('treats an unset loopback auth mode as managed OAuth disabled', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'motionsites', enabled: true, transport: 'http', url: endpoint }] });
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.connection).toBe('not_connected');
    expect(body.upstream).toBeUndefined();
    await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:fixture-hero')).rejects.toThrow(MotionSitesLoginRequiredError);
    expect(calls).toEqual([]);
  });

  it('preserves a case-insensitive pinned Authorization header on every MCP request', async () => {
    expectedAuthorization = 'Bearer pinned-fixture';
    await writeMcpConfig(dataDir, { servers: [{ id: 'motionsites', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint,
      headers: { aUtHoRiZaTiOn: expectedAuthorization, 'X-Provider-Access': 'fixture-header' } }] });
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.upstream).toBeUndefined();
    expect(body.catalog.entries).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it('refreshes an expired token with its audience and preserves that binding', async () => {
    await setToken(dataDir, 'motionsites', { accessToken: 'expired-fixture', refreshToken: 'refresh-fixture',
      tokenType: 'Bearer', expiresAt: 0, tokenEndpoint: `${provider.url}/token`, clientId: 'fixture-client', endpointFingerprint: mcpEndpointFingerprint(endpoint), resourceUrl: endpoint, savedAt: 0 });
    const body = await (await fetch(`${native.url}/api/motionsites/catalog`)).json() as MotionSitesCatalogResponse;
    expect(body.upstream).toBeUndefined();
    expect(body.catalog.entries).toHaveLength(1);
    expect(refreshResources).toEqual([endpoint]);
    expect(await getToken(dataDir, 'motionsites')).toMatchObject({ accessToken: 'fixture-token', endpointFingerprint: mcpEndpointFingerprint(endpoint), resourceUrl: endpoint, refreshToken: 'refresh-fixture' });
  });
});
