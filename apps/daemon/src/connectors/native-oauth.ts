// Mish's own OAuth provider (slice 1: TikTok). Tokens live only in the encrypted token store; the
// browser sees a redirect URL on the way out and an account id on the way back, never a token.
import { createHash, randomBytes } from 'node:crypto';

import { fetchExternalBrandAsset } from '../brands/safe-fetch.js';
import { TokenDecryptError } from './native/token-crypto.js';
import type { NativeTokens } from './native/token-crypto.js';
import { TokenKeyUnavailableError } from './native/key-source.js';
import {
  parseTikTokTokenResponse, tiktokSetupMessage, TIKTOK_API_HOST, TIKTOK_API_PATH_PREFIX, TIKTOK_AUTHORIZE_URL, TIKTOK_BLOCKED_PATH_PREFIXES,
  TIKTOK_ENV, TIKTOK_LABEL_FIELD_LADDER as LABEL_FIELD_LADDER, TIKTOK_REVOKE_URL, TIKTOK_SCOPES, TIKTOK_TOKEN_URL, TIKTOK_VAULT_IDS,
} from './native/tiktok.js';

export type NativeOAuthErrorCode =
  | 'unknown_connector' | 'not_configured' | 'key_unavailable' | 'state_invalid' | 'state_expired' | 'state_replayed'
  | 'denied' | 'exchange_failed' | 'reconnect_required' | 'refresh_failed' | 'host_not_allowed' | 'not_connected' | 'store_failed';

const STATUS: Record<NativeOAuthErrorCode, number> = {
  unknown_connector: 404, not_configured: 503, key_unavailable: 503, state_invalid: 400, state_expired: 400, state_replayed: 400,
  denied: 400, exchange_failed: 502, reconnect_required: 401, refresh_failed: 502, host_not_allowed: 400, not_connected: 403, store_failed: 500,
};

/** Messages never carry tokens, codes, client secrets or provider descriptions. */
export class NativeOAuthError extends Error {
  readonly status: number;
  constructor(readonly code: NativeOAuthErrorCode, message: string) {
    super(message);
    this.name = 'NativeOAuthError';
    this.status = STATUS[code];
  }
}

export const NATIVE_STATE_TTL_MS = 10 * 60_000;
/** Refresh when the access token has less than this left. */
export const NATIVE_REFRESH_SKEW_MS = 5 * 60_000;
const CONSUMED_STATE_MEMORY_MS = 60 * 60_000;
const MAX_PENDING = 20;
const MAX_CONSUMED = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type NativeFetch = (url: string, init?: RequestInit, options?: { followRedirects?: boolean }) => Promise<Response>;

export interface NativeTokenStore {
  get(connectorId: string, accountId: string): Promise<NativeTokens | undefined>;
  put(connectorId: string, accountId: string, tokens: NativeTokens): Promise<void>;
  delete(accountId: string): Promise<void>;
  /** Rejects with TokenKeyUnavailableError when no key is configured (fail closed). */
  ready(): Promise<void>;
}

export interface NativeOAuthStatus { configured: boolean; missing: string[]; message?: string }
export interface NativeProxyRequest { endpoint: string; method: string; headers?: Record<string, string>; body?: unknown }
export interface NativeProxyResult { status: number; data: unknown }

export interface NativeOAuthService {
  handles(connectorId: string): boolean;
  isNativeAccountId(accountId: string): boolean;
  status(connectorId: string): Promise<NativeOAuthStatus>;
  /** The last status answer, for sync callers (connector lists). Starts as env-only. */
  isConfiguredCached(connectorId: string): boolean;
  begin(connectorId: string, options: { callbackNonce?: string }): Promise<{ redirectUrl: string; expiresAt: string }>;
  complete(connectorId: string, input: { state: string; code?: string; denied?: boolean }): Promise<{ accountId: string; accountLabel: string; callbackNonce?: string }>;
  request(connectorId: string, accountId: string, request: NativeProxyRequest): Promise<NativeProxyResult>;
  needsRefresh(connectorId: string, accountId: string): Promise<boolean>;
  /** For a scheduled refresh job: refreshes if due. Returns whether it did. */
  refreshIfNeeded(connectorId: string, accountId: string): Promise<boolean>;
  disconnect(connectorId: string, accountId: string): Promise<void>;
}

export interface NativeOAuthOptions {
  store: NativeTokenStore;
  env: Readonly<Record<string, string | undefined>>;
  readVaultSecret: (id: string) => Promise<string>;
  fetch?: NativeFetch;
  now?: () => number;
}

interface Pending { connectorId: string; verifier: string; expiresAt: number; callbackNonce?: string }
interface Credentials { clientKey: string; clientSecret: string; redirectUri: string }
type PkceMode = 'base64url' | 'hex' | 'off';

const b64url = (buf: Buffer): string => buf.toString('base64url');
const ACCOUNT_PREFIX = 'native-tiktok-';

function validRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

export function createNativeOAuthService(options: NativeOAuthOptions): NativeOAuthService {
  const now = options.now ?? Date.now;
  const net: NativeFetch = options.fetch ?? ((url, init, o) => fetchExternalBrandAsset(url, init, o));
  const pending = new Map<string, Pending>();
  const consumed = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();
  const configuredCache = new Map<string, boolean>();

  const connectorOnly = (connectorId: string): void => {
    if (connectorId !== 'tiktok') throw new NativeOAuthError('unknown_connector', 'connector is not a native OAuth connector');
  };

  const secret = async (envName: string, vaultId: string): Promise<string> => {
    const fromEnv = (options.env[envName] ?? '').trim();
    if (fromEnv) return fromEnv;
    try { return (await options.readVaultSecret(vaultId)).trim(); } catch { return ''; }
  };

  const loadCredentials = async (): Promise<{ creds?: Credentials; missing: string[] }> => {
    const [clientKey, clientSecret] = await Promise.all([
      secret(TIKTOK_ENV.clientKey, TIKTOK_VAULT_IDS.clientKey),
      secret(TIKTOK_ENV.clientSecret, TIKTOK_VAULT_IDS.clientSecret),
    ]);
    const redirectUri = (options.env[TIKTOK_ENV.redirectUri] ?? '').trim();
    const missing: string[] = [];
    if (!clientKey) missing.push(TIKTOK_ENV.clientKey);
    if (!clientSecret) missing.push(TIKTOK_ENV.clientSecret);
    if (!redirectUri || !validRedirect(redirectUri)) missing.push(TIKTOK_ENV.redirectUri);
    return missing.length > 0 ? { missing } : { creds: { clientKey, clientSecret, redirectUri }, missing };
  };

  const requireConfigured = async (): Promise<Credentials> => {
    const { creds, missing } = await loadCredentials();
    configuredCache.set('tiktok', creds !== undefined);
    if (!creds) throw new NativeOAuthError('not_configured', tiktokSetupMessage(missing));
    return creds;
  };

  const requireKey = async (): Promise<void> => {
    try { await options.store.ready(); } catch (error) {
      if (error instanceof TokenKeyUnavailableError) throw new NativeOAuthError('key_unavailable', error.message);
      throw error;
    }
  };

  const guardStore = async <T>(task: () => Promise<T>): Promise<T> => {
    try { return await task(); } catch (error) {
      if (error instanceof NativeOAuthError) throw error;
      if (error instanceof TokenKeyUnavailableError) throw new NativeOAuthError('key_unavailable', error.message);
      if (error instanceof TokenDecryptError) throw new NativeOAuthError('reconnect_required', error.message);
      throw new NativeOAuthError('store_failed', 'the connector token store could not be used');
    }
  };

  const pkceMode = (): PkceMode => {
    const raw = (options.env[TIKTOK_ENV.pkce] ?? '').trim().toLowerCase();
    return raw === 'hex' || raw === 'off' ? raw : 'base64url';
  };

  const post = async (url: string, form: URLSearchParams): Promise<{ status: number; body: unknown }> => {
    const res = await net(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { followRedirects: false });
    return { status: res.status, body: await readJson(res) };
  };

  async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  const prune = (): void => {
    const t = now();
    for (const [k, v] of pending) if (v.expiresAt + CONSUMED_STATE_MEMORY_MS < t) pending.delete(k);
    for (const [k, v] of consumed) if (v < t) consumed.delete(k);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
    while (consumed.size >= MAX_CONSUMED) consumed.delete(consumed.keys().next().value as string);
  };

  const toStored = (grant: { accessToken: string; refreshToken: string; expiresInSec: number; refreshExpiresInSec: number; scope: string; openId: string }): NativeTokens => ({
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    accessExpiresAt: now() + grant.expiresInSec * 1000,
    refreshExpiresAt: now() + grant.refreshExpiresInSec * 1000,
    scope: grant.scope,
    openId: grant.openId,
  });

  /** Runs `task` after every earlier task for the same account has finished. */
  const withLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (locks.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  };

  /**
   * The stored tokens, refreshed when due. One refresh at a time per account; the rotated refresh
   * token is written to the store before anyone uses the new access token, because TikTok kills the
   * old one. `staleAccessToken` makes a forced refresh a no-op if another caller already did it.
   */
  const ensureFresh = (connectorId: string, accountId: string, force?: { staleAccessToken: string }): Promise<NativeTokens> =>
    withLock(`${connectorId}:${accountId}`, () => guardStore(async () => {
      const stored = await options.store.get(connectorId, accountId);
      if (!stored) throw new NativeOAuthError('not_connected', 'TikTok is not connected');
      if (now() >= stored.refreshExpiresAt) throw new NativeOAuthError('reconnect_required', 'The TikTok authorization expired. Reconnect TikTok.');
      const due = stored.accessExpiresAt - now() <= NATIVE_REFRESH_SKEW_MS;
      if (!due && !(force && force.staleAccessToken === stored.accessToken)) return stored;
      const creds = await requireConfigured();
      const reply = await post(TIKTOK_TOKEN_URL, new URLSearchParams({
        client_key: creds.clientKey, client_secret: creds.clientSecret, grant_type: 'refresh_token', refresh_token: stored.refreshToken,
      })).catch(() => { throw new NativeOAuthError('refresh_failed', 'TikTok could not be reached to refresh the authorization'); });
      const parsed = parseTikTokTokenResponse(reply.status, reply.body);
      if (!parsed.ok) {
        if (parsed.error === 'invalid_grant' || parsed.error === 'invalid_request') throw new NativeOAuthError('reconnect_required', 'TikTok refused the stored authorization. Reconnect TikTok.');
        throw new NativeOAuthError('refresh_failed', 'TikTok did not refresh the authorization');
      }
      const next = toStored({ ...parsed.grant, openId: parsed.grant.openId || stored.openId, scope: parsed.grant.scope || stored.scope });
      await options.store.put(connectorId, accountId, next);
      return next;
    }));

  const checkEndpoint = (endpoint: string): URL => {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new NativeOAuthError('host_not_allowed', 'requests may only go to the TikTok API'); }
    const blocked = TIKTOK_BLOCKED_PATH_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (url.protocol !== 'https:' || url.hostname !== TIKTOK_API_HOST || url.port !== '' || url.username || url.password || !url.pathname.startsWith(TIKTOK_API_PATH_PREFIX) || blocked) {
      throw new NativeOAuthError('host_not_allowed', 'requests may only go to the TikTok API');
    }
    return url;
  };

  const send = async (url: URL, request: NativeProxyRequest, accessToken: string): Promise<NativeProxyResult> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      if (k.toLowerCase() === 'content-type') headers['content-type'] = v;
    }
    headers.authorization = `Bearer ${accessToken}`;
    const method = request.method.toUpperCase();
    let body: string | undefined;
    if (request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await net(url.href, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, { followRedirects: false });
    return { status: res.status, data: await readJson(res) };
  };

  const request = async (connectorId: string, accountId: string, req: NativeProxyRequest): Promise<NativeProxyResult> => {
    connectorOnly(connectorId);
    const url = checkEndpoint(req.endpoint);
    const tokens = await ensureFresh(connectorId, accountId);
    const first = await send(url, req, tokens.accessToken);
    if (first.status !== 401) return first;
    // The token looked fresh but TikTok says no (revoked, or the clock is off): refresh once and retry once.
    const renewed = await ensureFresh(connectorId, accountId, { staleAccessToken: tokens.accessToken });
    return send(url, req, renewed.accessToken);
  };

  const fetchLabel = async (accessToken: string): Promise<string> => {
    for (const fields of LABEL_FIELD_LADDER) {
      try {
        const r = await send(new URL(`https://${TIKTOK_API_HOST}/v2/user/info/?fields=${fields}`), { endpoint: '', method: 'GET' }, accessToken);
        const user = ((r.data as { data?: { user?: { display_name?: unknown; username?: unknown } } } | null)?.data?.user) ?? {};
        const label = typeof user.display_name === 'string' && user.display_name ? user.display_name : typeof user.username === 'string' ? user.username : '';
        if (r.status >= 200 && r.status < 300 && label) return label.slice(0, 80);
      } catch { /* try the next rung, then fall back to a plain label */ }
    }
    return 'TikTok';
  };

  return {
    handles: (id) => id === 'tiktok',
    isNativeAccountId: (id) => /^native-tiktok-[0-9a-f]{24}$/u.test(id),

    async status(connectorId) {
      connectorOnly(connectorId);
      const { creds, missing } = await loadCredentials();
      configuredCache.set(connectorId, creds !== undefined);
      return creds ? { configured: true, missing: [] } : { configured: false, missing, message: tiktokSetupMessage(missing) };
    },

    isConfiguredCached(connectorId) {
      const cached = configuredCache.get(connectorId);
      if (cached !== undefined) return cached;
      return Boolean(options.env[TIKTOK_ENV.clientKey]?.trim() && options.env[TIKTOK_ENV.clientSecret]?.trim() && options.env[TIKTOK_ENV.redirectUri]?.trim());
    },

    async begin(connectorId, opts) {
      connectorOnly(connectorId);
      const creds = await requireConfigured();
      await requireKey();
      prune();
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(32));
      const expiresAt = now() + NATIVE_STATE_TTL_MS;
      pending.set(state, { connectorId, verifier, expiresAt, ...(opts.callbackNonce === undefined ? {} : { callbackNonce: opts.callbackNonce }) });
      const url = new URL(TIKTOK_AUTHORIZE_URL);
      url.searchParams.set('client_key', creds.clientKey);
      url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', creds.redirectUri);
      url.searchParams.set('state', state);
      const mode = pkceMode();
      if (mode !== 'off') {
        const digest = createHash('sha256').update(verifier).digest();
        url.searchParams.set('code_challenge', mode === 'hex' ? digest.toString('hex') : b64url(digest));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return { redirectUrl: url.href, expiresAt: new Date(expiresAt).toISOString() };
    },

    async complete(connectorId, input) {
      connectorOnly(connectorId);
      const entry = pending.get(input.state);
      if (!entry) {
        throw new NativeOAuthError(consumed.has(input.state) ? 'state_replayed' : 'state_invalid', consumed.has(input.state) ? 'This authorization link was already used. Start the connection again.' : 'The authorization response did not match a connection started here. Start again.');
      }
      // Single use, whatever happens next.
      pending.delete(input.state);
      consumed.set(input.state, now() + CONSUMED_STATE_MEMORY_MS);
      if (entry.connectorId !== connectorId) throw new NativeOAuthError('state_invalid', 'The authorization response did not match a connection started here. Start again.');
      if (now() > entry.expiresAt) throw new NativeOAuthError('state_expired', 'The authorization took too long. Start the connection again.');
      if (input.denied || !input.code) throw new NativeOAuthError('denied', 'TikTok authorization was not granted.');
      const creds = await requireConfigured();
      await requireKey();
      const form = new URLSearchParams({
        client_key: creds.clientKey, client_secret: creds.clientSecret, code: input.code, grant_type: 'authorization_code', redirect_uri: creds.redirectUri,
      });
      if (pkceMode() !== 'off') form.set('code_verifier', entry.verifier);
      const reply = await post(TIKTOK_TOKEN_URL, form).catch(() => { throw new NativeOAuthError('exchange_failed', 'TikTok could not be reached to finish the connection'); });
      const parsed = parseTikTokTokenResponse(reply.status, reply.body);
      if (!parsed.ok) throw new NativeOAuthError('exchange_failed', `TikTok did not accept the authorization (${parsed.error}). Start the connection again.`);
      if (!parsed.grant.openId) throw new NativeOAuthError('exchange_failed', 'TikTok did not say which account connected');
      const accountId = `${ACCOUNT_PREFIX}${createHash('sha256').update(parsed.grant.openId).digest('hex').slice(0, 24)}`;
      await guardStore(() => options.store.put(connectorId, accountId, toStored(parsed.grant)));
      const accountLabel = await fetchLabel(parsed.grant.accessToken);
      return { accountId, accountLabel, ...(entry.callbackNonce === undefined ? {} : { callbackNonce: entry.callbackNonce }) };
    },

    request,

    async needsRefresh(connectorId, accountId) {
      const tokens = await guardStore(() => options.store.get(connectorId, accountId));
      return tokens !== undefined && tokens.accessExpiresAt - now() <= NATIVE_REFRESH_SKEW_MS;
    },

    async refreshIfNeeded(connectorId, accountId) {
      const tokens = await guardStore(() => options.store.get(connectorId, accountId));
      if (!tokens || tokens.accessExpiresAt - now() > NATIVE_REFRESH_SKEW_MS) return false;
      const next = await ensureFresh(connectorId, accountId);
      return next.accessToken !== tokens.accessToken;
    },

    async disconnect(connectorId, accountId) {
      connectorOnly(connectorId);
      const tokens = await withLock(`${connectorId}:${accountId}`, () => guardStore(() => options.store.get(connectorId, accountId))).catch(() => undefined);
      if (tokens) {
        try {
          const creds = (await loadCredentials()).creds;
          if (creds) await post(TIKTOK_REVOKE_URL, new URLSearchParams({ client_key: creds.clientKey, client_secret: creds.clientSecret, token: tokens.accessToken }));
        } catch { /* revoke is best effort; the local tokens go either way */ }
      }
      await guardStore(() => options.store.delete(accountId));
    },
  };
}
