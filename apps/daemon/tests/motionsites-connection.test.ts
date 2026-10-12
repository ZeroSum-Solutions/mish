import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
// src/motionsites/connection.ts — the MotionSites bridge's use of the daemon's EXISTING external-
// MCP OAuth/token facilities (mcp-config.ts / mcp-tokens.ts / mcp-oauth.ts), not a MotionSites-
// specific reimplementation of them. No real network call: the one HTTP call this file's code
// path can make (a refresh-token POST) is driven by a fake `fetch`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getToken, setToken, type StoredMcpToken } from '../src/mcp-tokens.js';
import { readMcpConfig } from '../src/mcp-config.js';
import {
  callWithMotionSitesToken,
  ensureMotionSitesServerRegistered,
  getMotionSitesConnectionStatus,
  resolveMotionSitesAccessToken,
} from '../src/motionsites/connection.js';
import { MotionSitesLoginRequiredError } from '../src/motionsites/errors.js';
import { MOTIONSITES_MCP_SERVER_ID, MOTIONSITES_MCP_URL } from '../src/motionsites/config.js';

describe('motionsites connection', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-motionsites-conn-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('ensureMotionSitesServerRegistered', () => {
    it('registers a "motionsites" http/oauth server entry when none exists', async () => {
      const entry = await ensureMotionSitesServerRegistered(dataDir);
      expect(entry).toMatchObject({ id: MOTIONSITES_MCP_SERVER_ID, transport: 'http', authMode: 'oauth', url: MOTIONSITES_MCP_URL, enabled: true });
      const cfg = await readMcpConfig(dataDir);
      expect(cfg.servers.filter((s) => s.id === MOTIONSITES_MCP_SERVER_ID)).toHaveLength(1);
    });

    it('is idempotent and never overwrites a user-edited entry with the same id', async () => {
      await ensureMotionSitesServerRegistered(dataDir);
      const cfg1 = await readMcpConfig(dataDir);
      const edited = cfg1.servers.find((s) => s.id === MOTIONSITES_MCP_SERVER_ID)!;
      // Simulate the user pinning a manual header, as the generic Settings picker allows.
      const withHeader = { ...edited, headers: { Authorization: 'Bearer pinned-manually' } };
      const otherServers = cfg1.servers.filter((s) => s.id !== MOTIONSITES_MCP_SERVER_ID);
      await import('../src/mcp-config.js').then(({ writeMcpConfig }) => writeMcpConfig(dataDir, { servers: [...otherServers, withHeader] }));

      const second = await ensureMotionSitesServerRegistered(dataDir);
      expect(second.headers).toEqual({ Authorization: 'Bearer pinned-manually' });
      const cfg2 = await readMcpConfig(dataDir);
      expect(cfg2.servers.filter((s) => s.id === MOTIONSITES_MCP_SERVER_ID)).toHaveLength(1);
    });
  });

  describe('resolveMotionSitesAccessToken', () => {
    it('throws MotionSitesLoginRequiredError when no token is stored', async () => {
      await expect(resolveMotionSitesAccessToken(dataDir)).rejects.toThrow(MotionSitesLoginRequiredError);
    });

    it('returns the stored access token unchanged when it is not expired', async () => {
      const tok: StoredMcpToken = { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'still-good', tokenType: 'Bearer', expiresAt: Date.now() + 60_000, savedAt: Date.now() };
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, tok);
      await expect(resolveMotionSitesAccessToken(dataDir)).resolves.toBe('still-good');
    });

    it('throws MotionSitesLoginRequiredError when expired with no refresh token', async () => {
      const tok: StoredMcpToken = { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'stale', tokenType: 'Bearer', expiresAt: Date.now() - 1000, savedAt: Date.now() - 2000 };
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, tok);
      await expect(resolveMotionSitesAccessToken(dataDir)).rejects.toThrow(MotionSitesLoginRequiredError);
    });

    it('refreshes an expired token and persists the refreshed value', async () => {
      const tok: StoredMcpToken = {
        endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'stale',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        expiresAt: Date.now() - 1000,
        savedAt: Date.now() - 2000,
        tokenEndpoint: 'https://motionsites.example/token',
        clientId: 'client-1',
      };
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, tok);

      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ access_token: 'fresh-1', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

      const accessToken = await resolveMotionSitesAccessToken(dataDir, fetchImpl);
      expect(accessToken).toBe('fresh-1');
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const persisted = await getToken(dataDir, MOTIONSITES_MCP_SERVER_ID);
      expect(persisted?.accessToken).toBe('fresh-1');
      expect(persisted?.refreshToken).toBe('refresh-2');
      expect(persisted?.expiresAt).toBeGreaterThan(Date.now());
    });

    it('does not carry the stale expiresAt forward when the refresh response omits expires_in', async () => {
      const tok: StoredMcpToken = {
        endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'stale',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        expiresAt: Date.now() - 1000,
        savedAt: Date.now() - 2000,
        tokenEndpoint: 'https://motionsites.example/token',
        clientId: 'client-1',
      };
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, tok);

      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ access_token: 'fresh-no-expiry', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

      await resolveMotionSitesAccessToken(dataDir, fetchImpl);
      const persisted = await getToken(dataDir, MOTIONSITES_MCP_SERVER_ID);
      expect(persisted?.expiresAt).toBeUndefined();
    });

    it('throws MotionSitesLoginRequiredError when the refresh call itself fails', async () => {
      const tok: StoredMcpToken = {
        endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'stale',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        expiresAt: Date.now() - 1000,
        savedAt: Date.now() - 2000,
        tokenEndpoint: 'https://motionsites.example/token',
        clientId: 'client-1',
      };
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, tok);
      const fetchImpl = vi.fn(async () => new Response('invalid_grant', { status: 400 })) as unknown as typeof fetch;
      await expect(resolveMotionSitesAccessToken(dataDir, fetchImpl)).rejects.toThrow(MotionSitesLoginRequiredError);
    });
  });

  describe('callWithMotionSitesToken', () => {
    it('resolves the token and calls fn with it', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok-x', tokenType: 'Bearer', savedAt: Date.now() });
      const fn = vi.fn(async (token: string) => `used:${token}`);
      await expect(callWithMotionSitesToken(dataDir, fetch, fn)).resolves.toBe('used:tok-x');
      expect(fn).toHaveBeenCalledWith('tok-x');
    });

    it('propagates MotionSitesLoginRequiredError without calling fn', async () => {
      const fn = vi.fn();
      await expect(callWithMotionSitesToken(dataDir, fetch, fn)).rejects.toThrow(MotionSitesLoginRequiredError);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('getMotionSitesConnectionStatus', () => {
    it('reports not_connected when no token is stored', async () => {
      await expect(getMotionSitesConnectionStatus(dataDir)).resolves.toEqual({ status: 'not_connected' });
    });

    it('reports connected for a non-expired token, with expiresAt/scope', async () => {
      const expiresAt = Date.now() + 60_000;
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'a', tokenType: 'Bearer', expiresAt, scope: 'read', savedAt: Date.now() });
      await expect(getMotionSitesConnectionStatus(dataDir)).resolves.toEqual({ status: 'connected', expiresAt, scope: 'read' });
    });

    it('reports connected (not expired) for an expired token that still carries a refresh token', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAt: Date.now() - 1000, savedAt: Date.now() });
      const status = await getMotionSitesConnectionStatus(dataDir);
      expect(status.status).toBe('connected');
    });

    it('reports expired for an expired token with no refresh token', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'a', tokenType: 'Bearer', expiresAt: Date.now() - 1000, savedAt: Date.now() });
      const status = await getMotionSitesConnectionStatus(dataDir);
      expect(status.status).toBe('expired');
    });
  });
});
