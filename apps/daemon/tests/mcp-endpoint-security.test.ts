import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginAuth, exchangeCodeForToken } from '../src/mcp-oauth.js';
import { writeMcpConfig } from '../src/mcp-config.js';
import { setToken } from '../src/mcp-tokens.js';
import { resolveDaemonMcpConnection } from '../src/workbench/connectors/mcp-binding.js';

let dataDir: string;
beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-endpoint-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
const endpoint = 'https://mcp.example.test/mcp?accessKey=synthetic-query-canary';
const fingerprint = (url: string) => createHash('sha256').update(url).digest('hex');
const match = { serverId: 'test', hosts: [] };
const discovery = (resource?: string): typeof fetch => async input => {
  const url = String(input);
  if (url.includes('oauth-protected-resource')) return resource ? Response.json({ resource, authorization_servers: ['https://auth.example.test'] }) : new Response('', { status: 404 });
  if (url.includes('oauth-authorization-server')) return Response.json({ issuer: resource ? 'https://auth.example.test' : 'https://mcp.example.test', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token', registration_endpoint: 'https://auth.example.test/register' });
  if (url.endsWith('/register')) return Response.json({ client_id: 'synthetic-client' });
  return new Response('', { status: 404 });
};
const auth = (resource?: string) => beginAuth({ serverId: 'test', serverUrl: endpoint, redirectUri: 'https://app.example.test/callback', dataDir, fetchImpl: discovery(resource) });

describe('OAuth endpoint identity stays private and exact', () => {
  // Anonymous public PRM checked 2026-10-11; no live OAuth/registration in this fixture test.
  it.each([
    ['higgsfield', 'https://mcp.higgsfield.ai/mcp'],
    ['motionsites', 'https://xgdzyqfalbibzelpdpvr.supabase.co/functions/v1/mcp'],
    ['mobbin', 'https://api.mobbin.com/mcp'],
    ['refero', 'https://api.refero.design/mcp'],
  ])('accepts the published clean non-root audience for %s', async (serverId, serverUrl) => {
    const result = await beginAuth({ serverId, serverUrl, redirectUri: 'https://app.example.test/callback', dataDir, fetchImpl: discovery(serverUrl) });
    expect(new URL(result.authorizeUrl).searchParams.get('resource')).toBe(serverUrl);
    expect(result.pending.endpointFingerprint).toBe(fingerprint(serverUrl));
  });
  it('uses clean published resource while keeping exact endpoint fingerprint', async () => {
    const result = await auth('https://mcp.example.test/mcp');
    expect(result.pending).toMatchObject({ endpointFingerprint: fingerprint(endpoint) });
    expect(result.authorizeUrl).not.toContain('synthetic-query-canary');
    if (process.platform !== 'win32') expect((await stat(path.join(dataDir, 'mcp-oauth-clients.json'))).mode & 0o777).toBe(0o600);
  });
  it('refuses a non-origin fallback audience whose path may be private', async () => {
    await expect(beginAuth({ serverId: 'test', serverUrl: 'https://mcp.example.test/path-sentinel', redirectUri: 'https://app.example.test/callback', dataDir, fetchImpl: discovery() }))
      .rejects.toMatchObject({ code: 'MCP_OAUTH_RESOURCE_UNSAFE' });
  });
  it('allows a bare-origin fallback audience', async () => {
    const result = await beginAuth({ serverId: 'test', serverUrl: 'https://mcp.example.test/', redirectUri: 'https://app.example.test/callback', dataDir, fetchImpl: discovery() });
    expect(new URL(result.authorizeUrl).searchParams.get('resource')).toBe('https://mcp.example.test/');
  });
  it('refuses any query-bearing fallback without an explicit clean resource', async () => {
    await expect(auth()).rejects.toMatchObject({ code: 'MCP_OAUTH_RESOURCE_UNSAFE' });
  });
  it('refuses secrets in a metadata-provided resource rather than reflecting them', async () => {
    await expect(auth(endpoint)).rejects.toMatchObject({ code: 'MCP_OAUTH_RESOURCE_UNSAFE' });
  });
  it('accepts the exact endpoint despite a clean OAuth resource', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint }] });
    await setToken(dataDir, 'test', { accessToken: 'synthetic-bearer', tokenType: 'Bearer', savedAt: 1, resourceUrl: 'https://mcp.example.test/mcp', endpointFingerprint: fingerprint(endpoint) } as never);
    await expect(resolveDaemonMcpConnection(dataDir, match, discovery())).resolves.toMatchObject({ url: endpoint, accessToken: 'synthetic-bearer' });
  });
  it('refuses a changed query even if the resource matches', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint }] });
    await setToken(dataDir, 'test', { accessToken: 'synthetic-bearer', tokenType: 'Bearer', savedAt: 1, resourceUrl: endpoint, endpointFingerprint: fingerprint(endpoint + 'changed') } as never);
    await expect(resolveDaemonMcpConnection(dataDir, match, discovery())).rejects.toMatchObject({ code: 'connector-needs-sign-in' });
  });
  it('requires reconnect for unbound legacy tokens', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint }] });
    await setToken(dataDir, 'test', { accessToken: 'synthetic-bearer', tokenType: 'Bearer', savedAt: 1 });
    await expect(resolveDaemonMcpConnection(dataDir, match, discovery())).rejects.toMatchObject({ code: 'connector-needs-sign-in' });
  });
  it('token rejection never reflects provider bodies or status text', async () => {
    await expect(exchangeCodeForToken({ tokenEndpoint: 'https://auth.example.test/token', clientId: 'id', redirectUri: 'https://app.example.test/callback', code: 'synthetic-code', codeVerifier: 'verifier' }, async () => new Response('synthetic-provider-secret', { status: 400, statusText: 'synthetic-status-secret' })))
      .rejects.toMatchObject({ code: 'MCP_OAUTH_TOKEN_REJECTED', message: 'OAuth token request failed (HTTP 400). Reconnect this server.' });
  });
});
