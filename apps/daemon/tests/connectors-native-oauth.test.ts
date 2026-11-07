// Native OAuth (TikTok): authorize URL, state, PKCE, token exchange, refresh rotation, revoke, executor.
// A fake TikTok stands in for the network; every secret here is a made-up test value.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOAuthService, NativeOAuthError, type NativeOAuthService } from '../src/connectors/native-oauth.js';
import { buildKeyring } from '../src/connectors/native/key-source.js';
import { EncryptedTokenStore } from '../src/connectors/native/token-store.js';
import { TIKTOK_SCOPES } from '../src/connectors/native/tiktok.js';

const ENV = {
  OD_TIKTOK_CLIENT_KEY: 'fake-client-key',
  OD_TIKTOK_CLIENT_SECRET: 'fake-client-secret',
  OD_TIKTOK_REDIRECT_URI: 'https://mish.example.test/api/connectors/oauth/callback/tiktok',
};

interface Call { url: string; method: string; headers: Record<string, string>; form?: URLSearchParams; json?: unknown; followRedirects?: boolean }

function fakeTikTok() {
  const calls: Call[] = [];
  let seq = 0;
  let validRefresh = '';
  let validAccess = '';
  let lastVerifier = '';
  let infoRejectsFields = false;
  let expiresIn = 7200;
  let accessAlwaysInvalid = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const issue = () => {
    seq += 1;
    validAccess = `fake-access-${seq}`;
    validRefresh = `fake-refresh-${seq}`;
    return { access_token: validAccess, expires_in: expiresIn, open_id: 'open-abc', refresh_expires_in: 15552000, refresh_token: validRefresh, scope: TIKTOK_SCOPES.join(','), token_type: 'Bearer' };
  };
  const fetchFn = async (url: string, init: RequestInit = {}, options?: { followRedirects?: boolean }): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = { url, method: String(init.method ?? 'GET'), headers, ...(options?.followRedirects === undefined ? {} : { followRedirects: options.followRedirects }) };
    if (typeof init.body === 'string') {
      if (headers['content-type']?.includes('x-www-form-urlencoded')) call.form = new URLSearchParams(init.body);
      else call.json = JSON.parse(init.body);
    }
    calls.push(call);
    const u = new URL(url);
    if (u.pathname === '/v2/oauth/token/') {
      const f = call.form!;
      if (f.get('grant_type') === 'authorization_code') {
        if (f.get('code') !== 'good-code') return json({ error: 'invalid_grant', error_description: 'bad code' });
        lastVerifier = f.get('code_verifier') ?? '';
        return json(issue());
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (f.get('refresh_token') !== validRefresh) return json({ error: 'invalid_grant', error_description: 'refresh token reused or invalid' });
        await new Promise((r) => setTimeout(r, 5));
        return json(issue());
      }
    }
    if (u.pathname === '/v2/oauth/revoke/') return json({});
    if (u.pathname === '/v2/user/info/') {
      if (accessAlwaysInvalid || headers.authorization !== `Bearer ${validAccess}`) return json({ error: { code: 'access_token_invalid', message: 'x' } }, 401);
      if (infoRejectsFields && u.searchParams.get('fields')!.includes('username')) return json({ error: { code: 'invalid_params', message: 'bad field' } }, 400);
      return json({ data: { user: { open_id: 'open-abc', display_name: 'Studio' } }, error: { code: 'ok' } });
    }
    if (u.pathname === '/v2/video/list/') return json({ data: { videos: [{ id: '1', title: 't' }] }, error: { code: 'ok' } });
    return json({}, 404);
  };
  return {
    fetchFn, calls,
    get lastVerifier() { return lastVerifier; },
    get validRefresh() { return validRefresh; },
    set rejectUsername(v: boolean) { infoRejectsFields = v; },
    set shortLived(v: boolean) { expiresIn = v ? 60 : 7200; },
    set accessAlwaysInvalid(v: boolean) { accessAlwaysInvalid = v; },
  };
}

let dir: string;
let tiktok: ReturnType<typeof fakeTikTok>;
let clock: number;
let service: NativeOAuthService;

function make(env: Record<string, string | undefined> = ENV, store?: EncryptedTokenStore) {
  const ring = buildKeyring([randomBytes(32)]);
  return createNativeOAuthService({
    store: store ?? new EncryptedTokenStore(dir, async () => ring),
    env,
    readVaultSecret: async () => '',
    fetch: tiktok.fetchFn,
    now: () => clock,
  });
}

async function connect(svc: NativeOAuthService = service) {
  const begin = await svc.begin('tiktok', { callbackNonce: 'nonce-1234567890abcdef' });
  const url = new URL(begin.redirectUrl);
  const state = url.searchParams.get('state')!;
  const done = await svc.complete('tiktok', { state, code: 'good-code' });
  return { begin, url, state, done };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'od-native-oauth-'));
  tiktok = fakeTikTok();
  clock = 1_800_000_000_000;
  service = make();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const errCode = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof NativeOAuthError ? e.code : `other:${(e as Error).message}`; } return 'none'; };

describe('configuration', () => {
  it('reports not configured with the exact setup steps and no secrets', async () => {
    const svc = make({ OD_TIKTOK_CLIENT_KEY: 'only-this-fake-key' });
    const status = await svc.status('tiktok');
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(['OD_TIKTOK_CLIENT_SECRET', 'OD_TIKTOK_REDIRECT_URI']);
    expect(status.message).toContain('OD_TIKTOK_CLIENT_SECRET');
    expect(status.message).toContain('OD_TIKTOK_REDIRECT_URI');
    expect(status.message).toContain('developers.tiktok.com');
    expect(status.message).not.toContain('only-this-fake-key');
    await expect(svc.begin('tiktok', {})).rejects.toMatchObject({ code: 'not_configured', status: 503 });
  });

  it('fails closed with a clear error when no token key exists, before sending the user anywhere', async () => {
    const svc = createNativeOAuthService({
      store: new EncryptedTokenStore(dir, async () => { const { TokenKeyUnavailableError } = await import('../src/connectors/native/key-source.js'); throw new TokenKeyUnavailableError(); }),
      env: ENV, readVaultSecret: async () => '', fetch: tiktok.fetchFn, now: () => clock,
    });
    expect(await errCode(svc.begin('tiktok', {}))).toBe('key_unavailable');
    expect(tiktok.calls).toHaveLength(0);
  });

  it('reads client credentials from the vault when the environment lacks them', async () => {
    const asked: string[] = [];
    const ring = buildKeyring([randomBytes(32)]);
    const svc = createNativeOAuthService({
      store: new EncryptedTokenStore(dir, async () => ring),
      env: { OD_TIKTOK_REDIRECT_URI: ENV.OD_TIKTOK_REDIRECT_URI },
      readVaultSecret: async (id) => { asked.push(id); return id === 'tiktok_client_key' ? 'vault-key' : id === 'tiktok_client_secret' ? 'vault-secret' : ''; },
      fetch: tiktok.fetchFn, now: () => clock,
    });
    expect((await svc.status('tiktok')).configured).toBe(true);
    expect(asked.sort()).toEqual(['tiktok_client_key', 'tiktok_client_secret']);
  });
});

describe('authorize URL', () => {
  it('carries client_key, scope, code response, redirect_uri, state and an S256 PKCE challenge', async () => {
    const begin = await service.begin('tiktok', {});
    const u = new URL(begin.redirectUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(u.searchParams.get('client_key')).toBe('fake-client-key');
    expect(u.searchParams.get('scope')).toBe(TIKTOK_SCOPES.join(','));
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe(ENV.OD_TIKTOK_REDIRECT_URI);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.toString()).not.toContain('fake-client-secret');
    expect(Date.parse(begin.expiresAt)).toBe(clock + 10 * 60_000);
  });

  it('exchanges the code with the verifier whose S256 hash was the challenge', async () => {
    const { url } = await connect();
    const sent = tiktok.calls.find((c) => c.url.endsWith('/v2/oauth/token/'))!;
    const verifier = sent.form!.get('code_verifier')!;
    expect(verifier).toBe(tiktok.lastVerifier);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  it('can switch the challenge to hex or off for TikTok variants', async () => {
    const hex = await make({ ...ENV, OD_TIKTOK_PKCE: 'hex' }).begin('tiktok', {});
    const u = new URL(hex.redirectUrl);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[0-9a-f]{64}$/);
    const off = new URL((await make({ ...ENV, OD_TIKTOK_PKCE: 'off' }).begin('tiktok', {})).redirectUrl);
    expect(off.searchParams.has('code_challenge')).toBe(false);
  });

  it('refuses an unknown connector', async () => {
    expect(await errCode(service.begin('nope', {}))).toBe('unknown_connector');
  });
});

describe('callback', () => {
  it('exchanges the code, stores encrypted tokens, and returns an account id, label and nonce but no tokens', async () => {
    const { done } = await connect();
    const sent = tiktok.calls.find((c) => c.url.endsWith('/v2/oauth/token/'))!;
    expect(sent.method).toBe('POST');
    expect(sent.followRedirects).toBe(false);
    expect(Object.fromEntries(sent.form!.entries())).toMatchObject({ client_key: 'fake-client-key', client_secret: 'fake-client-secret', code: 'good-code', grant_type: 'authorization_code', redirect_uri: ENV.OD_TIKTOK_REDIRECT_URI });
    expect(done.accountId).toMatch(/^native-tiktok-[0-9a-f]{24}$/);
    expect(done.accountLabel).toBe('Studio');
    expect(done.callbackNonce).toBe('nonce-1234567890abcdef');
    expect(JSON.stringify(done)).not.toContain('fake-access');
    expect(JSON.stringify(done)).not.toContain('fake-refresh');
  });

  it('rejects a state it never issued', async () => {
    expect(await errCode(service.complete('tiktok', { state: 'x'.repeat(43), code: 'good-code' }))).toBe('state_invalid');
    expect(tiktok.calls).toHaveLength(0);
  });

  it('rejects a state issued for another connector', async () => {
    const state = new URL((await service.begin('tiktok', {})).redirectUrl).searchParams.get('state')!;
    expect(await errCode(service.complete('instagram', { state, code: 'good-code' }))).toBe('unknown_connector');
  });

  it('rejects an expired state', async () => {
    const state = new URL((await service.begin('tiktok', {})).redirectUrl).searchParams.get('state')!;
    clock += 10 * 60_000 + 1;
    expect(await errCode(service.complete('tiktok', { state, code: 'good-code' }))).toBe('state_expired');
    expect(tiktok.calls).toHaveLength(0);
  });

  it('rejects a replayed state, and a replayed code cannot start a second exchange', async () => {
    const { state } = await connect();
    const before = tiktok.calls.length;
    expect(await errCode(service.complete('tiktok', { state, code: 'good-code' }))).toBe('state_replayed');
    expect(tiktok.calls.length).toBe(before);
  });

  it('burns the state even when the exchange fails', async () => {
    const state = new URL((await service.begin('tiktok', {})).redirectUrl).searchParams.get('state')!;
    expect(await errCode(service.complete('tiktok', { state, code: 'bad-code' }))).toBe('exchange_failed');
    expect(await errCode(service.complete('tiktok', { state, code: 'good-code' }))).toBe('state_replayed');
  });

  it('turns a provider denial into a clear error and burns the state', async () => {
    const state = new URL((await service.begin('tiktok', {})).redirectUrl).searchParams.get('state')!;
    expect(await errCode(service.complete('tiktok', { state, denied: true }))).toBe('denied');
    expect(await errCode(service.complete('tiktok', { state, code: 'good-code' }))).toBe('state_replayed');
  });

  it('degrades the profile label when TikTok rejects a field, and still connects', async () => {
    tiktok.rejectUsername = true;
    const { done } = await connect();
    expect(done.accountLabel).toBe('Studio');
    const labelCalls = tiktok.calls.filter((c) => c.url.includes('/v2/user/info/'));
    expect(labelCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('refresh', () => {
  it('does not refresh a token that is still fresh', async () => {
    const { done } = await connect();
    const before = tiktok.calls.length;
    await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    expect(tiktok.calls.slice(before).map((c) => new URL(c.url).pathname)).toEqual(['/v2/user/info/']);
  });

  it('refreshes lazily when the access token is near expiry and persists the rotated refresh token before use', async () => {
    const { done } = await connect();
    clock += 2 * 60 * 60_000 - 60_000; // inside the 5 minute skew
    const result = await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    expect(result.status).toBe(200);
    const refresh = tiktok.calls.find((c) => c.form?.get('grant_type') === 'refresh_token')!;
    expect(refresh.form!.get('refresh_token')).toBe('fake-refresh-1');
    expect(tiktok.calls.at(-1)!.headers.authorization).toBe('Bearer fake-access-2');
    // The next refresh must send the NEW refresh token; the old one is dead at TikTok.
    clock += 2 * 60 * 60_000 - 60_000;
    await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    const second = tiktok.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token').at(-1)!;
    expect(second.form!.get('refresh_token')).toBe('fake-refresh-2');
  });

  it('serializes concurrent refreshes: one call to TikTok, every caller gets the new token', async () => {
    const { done } = await connect();
    clock += 2 * 60 * 60_000;
    const results = await Promise.all(Array.from({ length: 6 }, () => service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(tiktok.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });

  it('survives a restart: a new service reads the rotated token from the encrypted store', async () => {
    const ring = buildKeyring([randomBytes(32)]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    const a = make(ENV, store);
    const { done } = await connect(a);
    clock += 2 * 60 * 60_000;
    await a.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    const b = make(ENV, store);
    const r = await b.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    expect(r.status).toBe(200);
    expect(tiktok.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });

  it('asks the owner to reconnect when TikTok refuses the refresh token (reuse of an old one)', async () => {
    const ring = buildKeyring([randomBytes(32)]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    const { done } = await connect(make(ENV, store));
    // Another process rotates the token behind our back, so the stored refresh token is now an old one.
    const other = await store.get('tiktok', done.accountId);
    await store.put('tiktok', done.accountId, { ...other!, refreshToken: 'fake-refresh-OLD' });
    clock += 2 * 60 * 60_000;
    expect(await errCode(make(ENV, store).request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' }))).toBe('reconnect_required');
  });

  it('asks to reconnect once the refresh token itself has expired, without calling TikTok', async () => {
    const { done } = await connect();
    const before = tiktok.calls.length;
    clock += 15_552_000_000 + 1;
    expect(await errCode(service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' }))).toBe('reconnect_required');
    expect(tiktok.calls.length).toBe(before);
  });

  it('exposes an expiry helper for a scheduled refresh job', async () => {
    const { done } = await connect();
    expect(await service.needsRefresh('tiktok', done.accountId)).toBe(false);
    clock += 2 * 60 * 60_000 - 60_000;
    expect(await service.needsRefresh('tiktok', done.accountId)).toBe(true);
    expect(await service.refreshIfNeeded('tiktok', done.accountId)).toBe(true);
    expect(await service.needsRefresh('tiktok', done.accountId)).toBe(false);
  });

  it('retries once with a forced refresh when TikTok says the access token is invalid', async () => {
    const { done } = await connect();
    // Revoked server side: 401 with a stored token that still looks fresh.
    tiktok.accessAlwaysInvalid = true;
    const r = await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET' });
    expect(r.status).toBe(401);
    expect(tiktok.calls.filter((c) => c.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });
});

describe('executor', () => {
  it('sends the bearer token to open.tiktokapis.com only, without redirects, and returns parsed data', async () => {
    const { done } = await connect();
    const r = await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/video/list/?fields=id,title', method: 'POST', body: { max_count: 6 } });
    expect(r).toEqual({ status: 200, data: { data: { videos: [{ id: '1', title: 't' }] }, error: { code: 'ok' } } });
    const sent = tiktok.calls.at(-1)!;
    expect(sent.headers.authorization).toBe('Bearer fake-access-1');
    expect(sent.followRedirects).toBe(false);
    expect(sent.json).toEqual({ max_count: 6 });
  });

  it.each([
    'https://evil.example.test/v2/user/info/',
    'http://open.tiktokapis.com/v2/user/info/',
    'https://open.tiktokapis.com.evil.test/v2/user/info/',
    'https://open.tiktokapis.com/v2/oauth/token/',
    'https://open.tiktokapis.com/v2/oauth/revoke/',
    'https://open.tiktokapis.com:8443/v2/user/info/',
    'https://user:pw@open.tiktokapis.com/v2/user/info/',
    'https://open.tiktokapis.com/v1/user/info/',
  ])('refuses %s and never sends the token', async (endpoint) => {
    const { done } = await connect();
    const before = tiktok.calls.length;
    expect(await errCode(service.request('tiktok', done.accountId, { endpoint, method: 'GET' }))).toBe('host_not_allowed');
    expect(tiktok.calls.length).toBe(before);
  });

  it('refuses a caller-supplied Authorization header and an account that is not connected', async () => {
    const { done } = await connect();
    await service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id', method: 'GET', headers: { authorization: 'Bearer attacker', 'content-type': 'application/json' } });
    expect(tiktok.calls.at(-1)!.headers.authorization).toBe('Bearer fake-access-1');
    expect(await errCode(service.request('tiktok', 'native-tiktok-000000000000000000000000', { endpoint: 'https://open.tiktokapis.com/v2/user/info/', method: 'GET' }))).toBe('not_connected');
  });

  it('recognizes native account ids', () => {
    expect(service.isNativeAccountId('native-tiktok-0123456789abcdef01234567')).toBe(true);
    expect(service.isNativeAccountId('ca_abc123')).toBe(false);
  });
});

describe('disconnect', () => {
  it('revokes at TikTok, deletes the stored tokens, and still deletes them if revoke fails', async () => {
    const { done } = await connect();
    await service.disconnect('tiktok', done.accountId);
    const revoke = tiktok.calls.find((c) => c.url.endsWith('/v2/oauth/revoke/'))!;
    expect(revoke.form!.get('token')).toBe('fake-access-1');
    expect(revoke.form!.get('client_key')).toBe('fake-client-key');
    expect(await errCode(service.request('tiktok', done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/', method: 'GET' }))).toBe('not_connected');

    const failing = fakeTikTok();
    const ring2 = buildKeyring([randomBytes(32)]);
    const svc = createNativeOAuthService({ store: new EncryptedTokenStore(dir, async () => ring2), env: ENV, readVaultSecret: async () => '', now: () => clock,
      fetch: async (url, init, o) => (url.endsWith('/revoke/') ? Promise.reject(new Error('offline')) : failing.fetchFn(url, init, o)) });
    const c = await connect(svc);
    await expect(svc.disconnect('tiktok', c.done.accountId)).resolves.toBeUndefined();
    expect(await errCode(svc.request('tiktok', c.done.accountId, { endpoint: 'https://open.tiktokapis.com/v2/user/info/', method: 'GET' }))).toBe('not_connected');
  });
});
