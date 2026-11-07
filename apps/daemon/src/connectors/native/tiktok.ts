// TikTok Login Kit + Display API, as data. Everything TikTok-specific lives here so a scope
// migration or a renamed field is a one-line change. Names marked "unverified" have not been
// checked against a live TikTok app yet.

/**
 * Scopes requested at authorize time, in one place. TikTok has announced a scope migration:
 * when it lands, edit this list (and the app's approved scopes in the developer portal).
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'] as const;

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

/** The only host the executor talks to with a Bearer token, and the only API versions and paths it may reach. */
export const TIKTOK_API_HOST = 'open.tiktokapis.com';
export const TIKTOK_API_PATH_PREFIX = '/v2/';
/** Token endpoints are not reachable through the executor: they take client secrets, not Bearer tokens. */
export const TIKTOK_BLOCKED_PATH_PREFIXES = ['/v2/oauth/'] as const;

export const TIKTOK_ENV = {
  clientKey: 'OD_TIKTOK_CLIENT_KEY',
  clientSecret: 'OD_TIKTOK_CLIENT_SECRET',
  redirectUri: 'OD_TIKTOK_REDIRECT_URI',
  pkce: 'OD_TIKTOK_PKCE',
} as const;
export const TIKTOK_VAULT_IDS = { clientKey: 'tiktok_client_key', clientSecret: 'tiktok_client_secret' } as const;

/** Display API field ladders, richest first. A rung TikTok rejects falls back to the next one. */
export const TIKTOK_USER_FIELD_LADDER = [
  'open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,username,follower_count,likes_count,video_count',
  'open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,follower_count',
  'open_id,union_id,avatar_url,display_name',
] as const;
export const TIKTOK_VIDEO_FIELD_LADDER = [
  'id,title,cover_image_url,create_time',
  'id,title',
] as const;

/** Fields for naming the connected account; the second rung needs only the basic scope. */
export const TIKTOK_LABEL_FIELD_LADDER = ['open_id,display_name,username', 'open_id,display_name'] as const;

export interface TikTokTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  refreshExpiresInSec: number;
  scope: string;
  openId: string;
}

/**
 * Reads a token or refresh reply. TikTok answers some failures with HTTP 200 and an `error`
 * string, so both are checked. Returns the error code only, never the description.
 */
export function parseTikTokTokenResponse(status: number, body: unknown): { ok: true; grant: TikTokTokenGrant } | { ok: false; error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.error === 'string' && b.error) return { ok: false, error: b.error.slice(0, 64) };
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const expiresInSec = num(b.expires_in);
  const refreshExpiresInSec = num(b.refresh_expires_in);
  if (status < 200 || status >= 300 || typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string' || !b.access_token || !b.refresh_token || !expiresInSec || !refreshExpiresInSec) {
    return { ok: false, error: `unexpected_response_${status}` };
  }
  return {
    ok: true,
    grant: {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      expiresInSec,
      refreshExpiresInSec,
      scope: typeof b.scope === 'string' ? b.scope : '',
      openId: typeof b.open_id === 'string' ? b.open_id : '',
    },
  };
}

export function tiktokSetupMessage(missing: readonly string[]): string {
  return [
    `TikTok is not configured on this machine (missing: ${missing.join(', ')}).`,
    'Setup: 1) Create an app at developers.tiktok.com and add the Login Kit and Display API products (use a sandbox target first).',
    `2) Under Login Kit add the redirect URI that ${TIKTOK_ENV.redirectUri} will hold (it must end in /api/connectors/oauth/callback/tiktok).`,
    `3) Set ${TIKTOK_ENV.clientKey}, ${TIKTOK_ENV.clientSecret} and ${TIKTOK_ENV.redirectUri} in the daemon's environment, or store the client key and secret in the vault as ${TIKTOK_VAULT_IDS.clientKey} and ${TIKTOK_VAULT_IDS.clientSecret}.`,
    '4) Set OD_CONNECTOR_TOKEN_KEY (32 random bytes, base64 or hex) so tokens can be stored encrypted, then restart the daemon and connect again.',
  ].join(' ');
}
