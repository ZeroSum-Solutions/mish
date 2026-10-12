import { isPublicMcpResource, mcpTokenMatchesEndpoint } from '../mcp-endpoint.js';
/**
 * Resolve the signed-in user's MotionSites MCP connection using the daemon's existing external-MCP
 * OAuth/token facilities (mcp-config.ts, mcp-oauth.ts, mcp-tokens.ts) — design doc §1: "The daemon
 * resolves the MotionSites MCP connection using the user's own OAuth state." Nothing here talks to
 * MotionSites directly; it only reads/refreshes the token the generic `/api/mcp/oauth/*` flow
 * already stores under `MOTIONSITES_MCP_SERVER_ID`.
 */

import { refreshAccessToken } from '../mcp-oauth.js';
import { getToken, isTokenExpired, setToken, type StoredMcpToken } from '../mcp-tokens.js';
import { effectiveMcpAuthMode, readMcpConfig, writeMcpConfig, type McpServerConfig } from '../mcp-config.js';
import { MOTIONSITES_MCP_SERVER_ID, MOTIONSITES_MCP_TEMPLATE, MOTIONSITES_MCP_URL } from './config.js';
import { MotionSitesLoginRequiredError } from './errors.js';
import { McpHttpTransportError } from './mcp-client.js';
import type { MotionSitesConnectionStatusDto } from '@mish/contracts/api/motionsites';

/**
 * Idempotently registers the built-in MotionSites server entry in `mcp-config.json` if the user's
 * config does not already have one — so `GET /api/mcp/servers` / `POST /api/mcp/oauth/start` work
 * against `serverId: "motionsites"` without the user having to hand-add it from a generic
 * "add MCP server" picker first. Never overwrites a user-edited entry with the same id (e.g. a
 * custom header the user pinned) — it only adds the entry when none exists yet.
 */
export async function ensureMotionSitesServerRegistered(dataDir: string): Promise<McpServerConfig> {
  const cfg = await readMcpConfig(dataDir);
  const existing = cfg.servers.find((server) => server.id === MOTIONSITES_MCP_SERVER_ID);
  if (existing) return existing;
  const entry: McpServerConfig = {
    id: MOTIONSITES_MCP_SERVER_ID,
    label: MOTIONSITES_MCP_TEMPLATE.label,
    templateId: MOTIONSITES_MCP_TEMPLATE.id,
    transport: 'http',
    enabled: true,
    authMode: 'oauth',
    url: MOTIONSITES_MCP_URL,
  };
  const next = await writeMcpConfig(dataDir, { servers: [...cfg.servers, entry] });
  return next.servers.find((server) => server.id === MOTIONSITES_MCP_SERVER_ID) ?? entry;
}

/**
 * The stored access token, refreshed in place when it is expired and a refresh token is
 * available — persisting the refreshed token back to `mcp-tokens.json` the same way
 * `mcp-routes.ts`'s `/api/mcp/oauth/callback` does. Throws `MotionSitesLoginRequiredError` when
 * there is no usable token: none stored, or expired with no refresh token, or the upstream
 * refused the refresh.
 */
export async function resolveMotionSitesAccessToken(dataDir: string, fetchImpl: typeof fetch = fetch, resourceUrl?: string): Promise<string> {
  const stored = await getToken(dataDir, MOTIONSITES_MCP_SERVER_ID);
  if (!stored) throw new MotionSitesLoginRequiredError();
  const endpoint = resourceUrl ?? (await configuredMotionSitesServer(dataDir)).url;
  if (!mcpTokenMatchesEndpoint(stored, endpoint)) {
    throw new MotionSitesLoginRequiredError('The configured MotionSites URL changed — reconnect this server before using its saved OAuth token.');
  }
  if (!isTokenExpired(stored)) return stored.accessToken;
  return refreshStoredToken(dataDir, stored, fetchImpl);
}

async function configuredMotionSitesServer(dataDir: string): Promise<McpServerConfig> {
  const cfg = await readMcpConfig(dataDir); // The store validates URLs; transport validates header syntax.
  // Preserve token-only installations, without writing or overwriting the user's configuration.
  return cfg.servers.find((server) => server.id === MOTIONSITES_MCP_SERVER_ID) ?? {
    id: MOTIONSITES_MCP_SERVER_ID, enabled: true, transport: 'http', url: MOTIONSITES_MCP_URL,
  };
}

/** Native calls use the same enabled server URL, provider headers, and OAuth audience as the
 * external MCP connection. Resolve the server before refreshing a token so a disabled or changed
 * source cannot trigger network I/O or send its credentials to a different resource. */
export async function resolveMotionSitesMcpConnection(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<{
  url: string; accessToken: string; headers?: Record<string, string>;
}> {
  const server = await configuredMotionSitesServer(dataDir);
  if (!server.enabled) throw new MotionSitesLoginRequiredError('The MotionSites MCP connection is disabled — enable the configured server to use it.');
  if (server.transport !== 'http' || !server.url) {
    throw new McpHttpTransportError('Native MotionSites retrieval requires a configured Streamable HTTP MCP server.');
  }
  if (effectiveMcpAuthMode(server) === 'none') throw new MotionSitesLoginRequiredError('Managed OAuth is disabled for this MotionSites server — its saved OAuth token will not be used.');
  const accessToken = await resolveMotionSitesAccessToken(dataDir, fetchImpl, server.url);
  return { url: server.url, accessToken, ...(server.headers ? { headers: server.headers } : {}) };
}

async function refreshStoredToken(dataDir: string, stored: StoredMcpToken, fetchImpl: typeof fetch): Promise<string> {
  if ((stored.resourceUrl && !isPublicMcpResource(stored.resourceUrl)) || !stored.refreshToken || !stored.tokenEndpoint || !stored.clientId) {
    throw new MotionSitesLoginRequiredError(
      'Stored MotionSites token expired and cannot be refreshed — sign in again via POST /api/mcp/oauth/start.',
    );
  }
  let refreshed;
  try {
    refreshed = await refreshAccessToken(
      {
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        refreshToken: stored.refreshToken,
        // exactOptionalPropertyTypes: only present a key here when it actually has a value —
        // `{ clientSecret: undefined }` is not the same as omitting `clientSecret` under that
        // compiler flag, and RefreshTokenInput's optional fields are not typed to accept the
        // former.
        ...(stored.clientSecret !== undefined ? { clientSecret: stored.clientSecret } : {}),
        ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
        ...(stored.resourceUrl !== undefined ? { resource: stored.resourceUrl } : {}),
      },
      fetchImpl,
    );
  } catch (err) {
    throw new MotionSitesLoginRequiredError(
      'Stored MotionSites token expired and refresh failed — sign in again.',
    );
  }
  // Per RFC 6749 §5.1, an absent `expires_in` on the refresh response means "no defined
  // lifetime" — carrying the OLD (just-expired) `expiresAt` forward here would make this freshly
  // refreshed token look expired again on the very next `isTokenExpired` check. `nextScope`/
  // `nextExpiresAt` are therefore computed from the refresh response alone, not from `stored`
  // (except when the refresh response omits `scope`, which the OAuth spec allows to mean
  // "unchanged" — RFC 6749 §5.1's "unless identical to the scope requested").
  const { expiresAt: _staleExpiresAt, scope: staleScope, ...storedRest } = stored;
  const nextExpiresAt = typeof refreshed.expires_in === 'number' ? Date.now() + refreshed.expires_in * 1000 : undefined;
  const nextScope = refreshed.scope ?? staleScope;
  const next: StoredMcpToken = {
    ...storedRest,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    tokenType: refreshed.token_type ?? stored.tokenType,
    ...(nextScope !== undefined ? { scope: nextScope } : {}),
    ...(nextExpiresAt !== undefined ? { expiresAt: nextExpiresAt } : {}),
    savedAt: Date.now(),
  };
  await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, next);
  return next.accessToken;
}

/**
 * Resolves a usable access token (refreshing if needed, per `resolveMotionSitesAccessToken`) and
 * calls `fn` with it. Native catalog/build calls use `resolveMotionSitesMcpConnection` so they also
 * respect the configured URL and source enablement.
 */
export async function callWithMotionSitesToken<T>(
  dataDir: string,
  fetchImpl: typeof fetch,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const accessToken = await resolveMotionSitesAccessToken(dataDir, fetchImpl);
  return fn(accessToken);
}

/**
 * `GET /api/motionsites/connection`'s body. Never throws — the "not connected"/"expired" states
 * are themselves valid answers, unlike `resolveMotionSitesAccessToken`, which a catalog/build-start
 * call uses when it actually needs a usable token. A token past `expiresAt` that still carries a
 * `refreshToken` is reported `connected`: a caller that actually needs the live prompt library
 * transparently refreshes it on that call, so this cheap read never performs network I/O.
 */
export async function getMotionSitesConnectionStatus(dataDir: string): Promise<MotionSitesConnectionStatusDto> {
  const server = await configuredMotionSitesServer(dataDir);
  if (!server.enabled || effectiveMcpAuthMode(server) === 'none' || server.transport !== 'http' || !server.url) return { status: 'not_connected' };
  const stored = await getToken(dataDir, MOTIONSITES_MCP_SERVER_ID);
  if (!stored || !mcpTokenMatchesEndpoint(stored, server.url)) return { status: 'not_connected' };
  const expiredWithNoRefresh = isTokenExpired(stored) && !stored.refreshToken;
  return {
    status: expiredWithNoRefresh ? 'expired' : 'connected',
    ...(stored.expiresAt !== undefined ? { expiresAt: stored.expiresAt } : {}),
    ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
  };
}
