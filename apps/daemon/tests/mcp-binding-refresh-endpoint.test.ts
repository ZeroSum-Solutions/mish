import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeMcpConfig } from '../src/mcp-config.js';
import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
import { getToken, setToken, type StoredMcpToken } from '../src/mcp-tokens.js';
import { MOTIONSITES_MCP_SERVER_ID } from '../src/motionsites/config.js';
import { resolveMotionSitesMcpConnection } from '../src/motionsites/connection.js';
import { resolveDaemonMcpConnection } from '../src/workbench/connectors/mcp-binding.js';

// Red spec for the review BLOCK "OAuth tokens can cross endpoint boundaries": endpoint B is
// reconnected under the same server id while endpoint A's refresh is on the wire. The caller
// must never pair A's previously checked URL with B's token.
let dataDir: string;
beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-binding-refresh-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

const endpointA = 'https://a.example.test/mcp';
const endpointB = 'https://b.example.test/mcp';
const expiredA = (): StoredMcpToken => ({
  accessToken: 'a-expired', refreshToken: 'a-refresh', tokenType: 'Bearer', savedAt: 1, expiresAt: 1,
  tokenEndpoint: 'https://auth.a.example.test/token', clientId: 'a-client',
  resourceUrl: endpointA, endpointFingerprint: mcpEndpointFingerprint(endpointA),
});
const freshB = (): StoredMcpToken => ({
  accessToken: 'b-secret', refreshToken: 'b-refresh', tokenType: 'Bearer', savedAt: 2, expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.b.example.test/token', clientId: 'b-client',
  resourceUrl: endpointB, endpointFingerprint: mcpEndpointFingerprint(endpointB),
});

/** A token endpoint that runs `reconnect` (endpoint B signs in) before answering A's refresh. */
function reconnectDuringRefresh(reconnect: () => Promise<void>): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) !== 'https://auth.a.example.test/token') return new Response('', { status: 404 });
    calls += 1;
    await reconnect();
    return Response.json({ access_token: 'a-refreshed', token_type: 'Bearer', expires_in: 3600 });
  };
  return { fetchImpl, calls: () => calls };
}

describe('OAuth refresh stays bound to the endpoint the caller validated', () => {
  it('daemon connector binding refuses B\'s token for A\'s URL', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpointA }] });
    await setToken(dataDir, 'test', expiredA());
    const { fetchImpl, calls } = reconnectDuringRefresh(async () => {
      await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpointB }] });
      await setToken(dataDir, 'test', freshB());
    });

    const outcome = await resolveDaemonMcpConnection(dataDir, { serverId: 'test', hosts: [] }, fetchImpl)
      .then((connection) => ({ connection }), (error: unknown) => ({ error }));

    expect(calls()).toBe(1);
    expect(outcome).not.toHaveProperty('connection');
    expect((outcome as { error: unknown }).error).toMatchObject({ code: 'connector-needs-sign-in' });
    expect((await getToken(dataDir, 'test'))?.accessToken).toBe('b-secret');
  });

  it('MotionSites native connection refuses B\'s token for A\'s URL', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: MOTIONSITES_MCP_SERVER_ID, enabled: true, transport: 'http', authMode: 'oauth', url: endpointA }] });
    await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, expiredA());
    const { fetchImpl, calls } = reconnectDuringRefresh(async () => {
      await writeMcpConfig(dataDir, { servers: [{ id: MOTIONSITES_MCP_SERVER_ID, enabled: true, transport: 'http', authMode: 'oauth', url: endpointB }] });
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, freshB());
    });

    const outcome = await resolveMotionSitesMcpConnection(dataDir, fetchImpl)
      .then((connection) => ({ connection }), (error: unknown) => ({ error }));

    expect(calls()).toBe(1);
    expect(outcome).not.toHaveProperty('connection');
    expect((outcome as { error: unknown }).error).toMatchObject({ name: 'MotionSitesLoginRequiredError' });
    expect((await getToken(dataDir, MOTIONSITES_MCP_SERVER_ID))?.accessToken).toBe('b-secret');
  });

  it('still refreshes and returns A\'s own token when nothing changes', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: endpointA }] });
    await setToken(dataDir, 'test', expiredA());
    const { fetchImpl, calls } = reconnectDuringRefresh(async () => {});

    await expect(resolveDaemonMcpConnection(dataDir, { serverId: 'test', hosts: [] }, fetchImpl))
      .resolves.toMatchObject({ url: endpointA, accessToken: 'a-refreshed' });
    expect(calls()).toBe(1);
  });
});
