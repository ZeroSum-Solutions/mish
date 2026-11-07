// The link-page login seam with Mish's own OAuth: a native TikTok account id reaches the same
// proxyRequest seam, the engine's tiktok connector works unchanged, and any failure falls back to the public read.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectors } from '@mish/linkpage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorCatalogDefinition } from '../src/connectors/catalog.js';
import { createNativeOAuthService } from '../src/connectors/native-oauth.js';
import { buildKeyring } from '../src/connectors/native/key-source.js';
import { EncryptedTokenStore } from '../src/connectors/native/token-store.js';
import { createLoginFetches, createNativeAwareLoginProvider, type LinkPageLoginProvider } from '../src/linkpage/login.js';

const ENV = {
  OD_TIKTOK_CLIENT_KEY: 'fake-client-key',
  OD_TIKTOK_CLIENT_SECRET: 'fake-client-secret',
  OD_TIKTOK_REDIRECT_URI: 'https://mish.example.test/api/connectors/oauth/callback/tiktok',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dir: string;
let clock: number;
let refreshAnswer: 'ok' | 'invalid_grant';
let sent: Array<{ url: string; auth?: string; body?: string }>;
let composioCalls: Array<{ definitionId: string; accountId: string }>;

function setup() {
  const ring = buildKeyring([randomBytes(32)]);
  const native = createNativeOAuthService({
    store: new EncryptedTokenStore(dir, async () => ring),
    env: ENV,
    readVaultSecret: async () => '',
    now: () => clock,
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      sent.push({ url, ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}), ...(typeof init.body === 'string' ? { body: init.body } : {}) });
      const u = new URL(url);
      if (u.pathname === '/v2/oauth/token/') {
        const grant = new URLSearchParams(String(init.body)).get('grant_type');
        if (grant === 'refresh_token' && refreshAnswer === 'invalid_grant') return json({ error: 'invalid_grant' });
        return json({ access_token: `fake-access-${sent.length}`, refresh_token: `fake-refresh-${sent.length}`, expires_in: 7200, refresh_expires_in: 15552000, open_id: 'open-abc', scope: 'user.info.basic' });
      }
      if (u.pathname === '/v2/user/info/') return json({ data: { user: { display_name: 'Studio', username: 'studio.pots', bio_description: 'Clay.', follower_count: 1200 } }, error: { code: 'ok' } });
      if (u.pathname === '/v2/video/list/') return json({ data: { videos: [{ id: '7001', title: 'Wheel day', cover_image_url: 'https://cdn/c.jpg', create_time: 1790000000 }] }, error: { code: 'ok' } });
      return json({}, 404);
    },
  });
  const composio: LinkPageLoginProvider = {
    getDefinition: async (id) => ({ id, name: id, provider: 'composio', category: 'social', authentication: 'composio', providerConnectorId: id.toUpperCase(), tools: [], allowedToolNames: [] }) as ConnectorCatalogDefinition,
    proxyRequest: async (definition, accountId) => { composioCalls.push({ definitionId: definition.id, accountId }); return { status: 200, data: { data: { user: { display_name: 'Via Composio' } } } }; },
  };
  return { native, provider: createNativeAwareLoginProvider(composio, () => native) };
}

async function connectNative(native: ReturnType<typeof setup>['native']) {
  const begin = await native.begin('tiktok', {});
  const done = await native.complete('tiktok', { state: new URL(begin.redirectUrl).searchParams.get('state')!, code: 'any-code' });
  sent = [];
  return done;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'od-linkpage-native-'));
  clock = 1_800_000_000_000;
  refreshAnswer = 'ok';
  sent = [];
  composioCalls = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('link-page login seam with a native TikTok account', () => {
  it("the engine's tiktok connector reads the creator's own profile and videos through the native executor", async () => {
    const { native, provider } = setup();
    const { accountId } = await connectNative(native);
    const warnings: string[] = [];
    const logins = createLoginFetches(provider, { tiktok: accountId }, warnings);
    const signal = await connectors.tiktok!({ login: logins.tiktok! }).read('@studio');
    expect(signal.name).toBe('Studio');
    expect(signal.stats).toBe('1,200 followers');
    expect(signal.links?.[0]?.handle).toBe('@studio.pots');
    expect(signal.posts?.[0]?.url).toBe('https://www.tiktok.com/@studio.pots/video/7001');
    expect(signal.needs_login).toBeUndefined();
    expect(composioCalls).toHaveLength(0);
    const apiCalls = sent.filter((c) => c.auth);
    expect(apiCalls.every((c) => c.url.startsWith('https://open.tiktokapis.com/v2/'))).toBe(true);
    expect(apiCalls.at(-1)!.body).toBe(JSON.stringify({ max_count: 6 }));
    expect(warnings).toEqual([]);
  });

  it('keeps Composio accounts on the Composio path, with Composio\'s own definition', async () => {
    const { provider } = setup();
    const logins = createLoginFetches(provider, { tiktok: 'ca_abc123' }, []);
    const signal = await connectors.tiktok!({ login: logins.tiktok! }).read('@studio');
    expect(signal.name).toBe('Via Composio');
    expect(composioCalls.length).toBeGreaterThan(0);
    expect(composioCalls.every((c) => c.definitionId === 'tiktok' && c.accountId === 'ca_abc123')).toBe(true);
  });

  it('falls back to the public page with a warning when the native login fails (reconnect needed)', async () => {
    const { native, provider } = setup();
    const { accountId } = await connectNative(native);
    clock += 2 * 60 * 60_000;
    refreshAnswer = 'invalid_grant';
    const logins = createLoginFetches(provider, { tiktok: accountId }, []);
    const page = '<html><head><title>Studio (@studio) | TikTok</title></head></html>';
    const signal = await connectors.tiktok!({ fetch: async () => new Response(page, { status: 200 }), login: logins.tiktok! }).read('@studio');
    expect(signal.needs_login?.platform).toBe('tiktok');
    expect(signal.warnings?.[0]).toMatch(/login.*401/i);
    expect(JSON.stringify(signal)).not.toMatch(/fake-(access|refresh)/);
  });

  it('refuses a request to any host other than the platform API before reaching a provider', async () => {
    const { native, provider } = setup();
    const { accountId } = await connectNative(native);
    const logins = createLoginFetches(provider, { tiktok: accountId }, []);
    await expect(logins.tiktok!('https://evil.example.test/v2/user/info/')).rejects.toThrow(/may not go to/);
    expect(sent.filter((c) => c.auth)).toHaveLength(0);
  });
});
