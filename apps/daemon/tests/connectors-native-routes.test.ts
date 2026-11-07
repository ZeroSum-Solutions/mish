// Native TikTok behind the connector layer: catalog override, connect/callback routes, execute, disconnect.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerConnectorRoutes } from '../src/connectors/routes.js';
import { createNativeOAuthService } from '../src/connectors/native-oauth.js';
import { buildKeyring } from '../src/connectors/native/key-source.js';
import { EncryptedTokenStore } from '../src/connectors/native/token-store.js';
import { ConnectorService, ConnectorStatusService, InMemoryConnectorCredentialStore } from '../src/connectors/service.js';

const ENV = {
  OD_TIKTOK_CLIENT_KEY: 'fake-client-key',
  OD_TIKTOK_CLIENT_SECRET: 'fake-client-secret',
  OD_TIKTOK_REDIRECT_URI: 'https://mish.example.test/api/connectors/oauth/callback/tiktok',
};

let dir: string;
let server: Server;
let base = '';
let service: ConnectorService;
let credentials: InMemoryConnectorCredentialStore;
let seen: Array<{ url: string; method: string; auth?: string; form?: URLSearchParams }>;
let rejectRichFields = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function start(env: Record<string, string | undefined>) {
  seen = [];
  rejectRichFields = false;
  const ring = buildKeyring([randomBytes(32)]);
  const native = createNativeOAuthService({
    store: new EncryptedTokenStore(dir, async () => ring),
    env,
    readVaultSecret: async () => '',
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      const form = typeof init.body === 'string' && headers.get('content-type')?.includes('urlencoded') ? new URLSearchParams(init.body) : undefined;
      seen.push({ url, method: String(init.method ?? 'GET'), ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}), ...(form ? { form } : {}) });
      const u = new URL(url);
      if (u.pathname === '/v2/oauth/token/') return json({ access_token: 'fake-access-1', refresh_token: 'fake-refresh-1', expires_in: 7200, refresh_expires_in: 15552000, open_id: 'open-abc', scope: 'user.info.basic' });
      if (u.pathname === '/v2/oauth/revoke/') return json({});
      if (u.pathname === '/v2/user/info/') {
        if (rejectRichFields && u.searchParams.get('fields')!.includes('likes_count')) return json({ error: { code: 'invalid_params' } }, 400);
        return json({ data: { user: { display_name: 'Studio' } } });
      }
      if (u.pathname === '/v2/video/list/') return json({ data: { videos: [{ id: '1' }] } });
      return json({}, 404);
    },
  });
  credentials = new InMemoryConnectorCredentialStore();
  service = new ConnectorService(new ConnectorStatusService({ credentialStore: credentials }));
  service.setNativeOAuth(native);
  const app = express();
  app.use(express.json());
  registerConnectorRoutes(app, {
    service,
    sendApiError: (res, status, code, message, init) => res.status(status).json({ error: { code, message, ...(init?.details === undefined ? {} : { details: init.details }) } }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const post = (p: string, body: unknown = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function authorize(callbackNonce?: string) {
  const res = await post('/api/connectors/tiktok/connect', callbackNonce ? { callbackNonce } : {});
  const body = await res.json() as any;
  return { res, body, state: body.auth?.redirectUrl ? new URL(body.auth.redirectUrl).searchParams.get('state')! : '' };
}

beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'od-native-routes-')); });
afterEach(async () => { await new Promise<void>((r) => { server ? server.close(() => r()) : r(); }); await rm(dir, { recursive: true, force: true }); });

describe('catalog', () => {
  it('lists TikTok as a native connector, leaves Composio connectors alone, and reports configuration', async () => {
    await start({});
    const list = await (await fetch(`${base}/api/connectors`)).json() as any;
    const tiktok = list.connectors.find((c: any) => c.id === 'tiktok');
    expect(list.connectors.filter((c: any) => c.id === 'tiktok')).toHaveLength(1);
    expect(tiktok).toMatchObject({ provider: 'native', status: 'available', auth: { provider: 'native', configured: false } });
    expect(tiktok.description).toContain('user.info.basic');
    expect(tiktok.tools.map((t: any) => t.name)).toEqual(['tiktok_user_info', 'tiktok_video_list']);
    const instagram = (await service.getDefinition('instagram'))!;
    expect(instagram.authentication).toBe('composio');
    await service.disconnect('tiktok').catch(() => undefined);
    await server.close();
    await start(ENV);
    const configured = await (await fetch(`${base}/api/connectors/tiktok`)).json() as any;
    expect(configured.connector.auth.configured).toBe(true);
  });
});

describe('connect', () => {
  it('says exactly how to set up when not configured, without secrets', async () => {
    await start({ OD_TIKTOK_CLIENT_KEY: 'a-fake-key-that-must-not-echo' });
    const { res, body } = await authorize();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe('CONNECTOR_AUTH_CONFIG_REQUIRED');
    expect(body.error.message).toContain('OD_TIKTOK_CLIENT_SECRET');
    expect(body.error.message).toContain('OD_TIKTOK_REDIRECT_URI');
    expect(JSON.stringify(body)).not.toContain('a-fake-key-that-must-not-echo');
  });

  it('returns a redirect to TikTok and refuses browser-supplied credentials', async () => {
    await start(ENV);
    const { res, body } = await authorize();
    expect(res.status).toBe(200);
    expect(body.auth.kind).toBe('redirect_required');
    expect(body.auth.redirectUrl).toMatch(/^https:\/\/www\.tiktok\.com\/v2\/auth\/authorize\/\?/);
    expect(JSON.stringify(body)).not.toContain('fake-client-secret');
    const forged = await post('/api/connectors/tiktok/connect', { credentials: { provider: 'native', accountId: 'native-tiktok-000000000000000000000000' } });
    expect(forged.status).toBe(400);
    expect(service.getCredential('tiktok')).toBeUndefined();
  });

  it('fails closed with no token key, before sending the browser to TikTok', async () => {
    await start(ENV);
    const { TokenKeyUnavailableError } = await import('../src/connectors/native/key-source.js');
    const native = createNativeOAuthService({ store: new EncryptedTokenStore(dir, async () => { throw new TokenKeyUnavailableError(); }), env: ENV, readVaultSecret: async () => '' });
    service.setNativeOAuth(native);
    const { res, body } = await authorize();
    expect(res.status).toBe(503);
    expect(body.error.message).toContain('OD_CONNECTOR_TOKEN_KEY');
  });
});

describe('callback', () => {
  it('connects, stores no token in the plaintext credential record, and echoes the opener nonce', async () => {
    await start(ENV);
    const { state } = await authorize('nonce-1234567890abcdef');
    const cb = await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${state}&scopes=x`);
    const html = await cb.text();
    expect(cb.status).toBe(200);
    expect(html).toContain('nonce-1234567890abcdef');
    expect(html).not.toContain('fake-access');
    const record = service.getCredential('tiktok')!;
    expect(record.accountLabel).toBe('Studio');
    expect(record.credentials).toEqual({ provider: 'native', accountId: expect.stringMatching(/^native-tiktok-[0-9a-f]{24}$/) });
    expect(JSON.stringify(record)).not.toContain('fake-access');
    expect(await readFile(path.join(dir, 'connectors', 'native-tokens.json'), 'utf8')).not.toContain('fake-access-1');
    const detail = await (await fetch(`${base}/api/connectors/tiktok`)).json() as any;
    expect(detail.connector).toMatchObject({ status: 'connected', accountLabel: 'Studio' });
  });

  it('rejects a state mismatch, a replayed callback, an expired state and a denial', async () => {
    await start(ENV);
    const bad = await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${'z'.repeat(43)}`);
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code`);
    expect(missing.status).toBe(400);
    const { state } = await authorize();
    expect((await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${state}`)).status).toBe(200);
    const replay = await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${state}`);
    expect(replay.status).toBe(400);
    expect(JSON.stringify(await replay.json())).toContain('already used');
    const second = await authorize();
    const denied = await fetch(`${base}/api/connectors/oauth/callback/tiktok?error=access_denied&state=${second.state}`);
    expect(denied.status).toBe(400);
    expect(seen.filter((c) => c.url.endsWith('/v2/oauth/token/'))).toHaveLength(1);
  });
});

describe('execute and disconnect', () => {
  const ctx = { projectsRoot: '/tmp/none', projectId: 'p1', runId: 'r1' } as const;

  it('runs the profile tool through the native executor and degrades a rejected field set', async () => {
    await start(ENV);
    const { state } = await authorize();
    await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${state}`);
    rejectRichFields = true;
    const out = await service.execute({ connectorId: 'tiktok', toolName: 'tiktok_user_info', input: {} }, ctx);
    expect(out.output).toMatchObject({ toolName: 'tiktok_user_info', status: 200, data: { data: { user: { display_name: 'Studio' } } } });
    const infoCalls = seen.filter((c) => c.url.includes('/v2/user/info/') && c.auth);
    expect(infoCalls.length).toBeGreaterThanOrEqual(2);
    expect(infoCalls.at(-1)!.url).not.toContain('likes_count');
    const videos = await service.execute({ connectorId: 'tiktok', toolName: 'tiktok_video_list', input: { max_count: 50 } }, ctx);
    expect(videos.output).toMatchObject({ status: 200 });
  });

  it('refuses to run when not connected', async () => {
    await start(ENV);
    await expect(service.execute({ connectorId: 'tiktok', toolName: 'tiktok_user_info', input: {} }, ctx)).rejects.toMatchObject({ code: 'CONNECTOR_NOT_CONNECTED' });
  });

  it('disconnect revokes at TikTok and forgets the account', async () => {
    await start(ENV);
    const { state } = await authorize();
    await fetch(`${base}/api/connectors/oauth/callback/tiktok?code=good-code&state=${state}`);
    const res = await fetch(`${base}/api/connectors/tiktok/connection`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(seen.find((c) => c.url.endsWith('/v2/oauth/revoke/'))?.form?.get('token')).toBe('fake-access-1');
    expect(service.getCredential('tiktok')).toBeUndefined();
    expect(((await res.json()) as any).connector.status).toBe('available');
  });
});
