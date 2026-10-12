import { isPublicMcpResource, mcpTokenMatchesEndpoint } from '../../mcp-endpoint.js';
import { effectiveMcpAuthMode, readMcpConfig, type McpServerConfig } from '../../mcp-config.js';
import { refreshAccessToken } from '../../mcp-oauth.js';
import { getToken, isTokenExpired, setToken, type StoredMcpToken } from '../../mcp-tokens.js';

/**
 * The daemon's own binding for a connector: a server entry in the daemon's MCP
 * configuration plus its pinned Authorization header or saved OAuth token. Nothing
 * here reads another agent's MCP configuration or credential store. Configured
 * endpoints are trusted inputs; saved OAuth tokens stay bound to their exact endpoint.
 */
export interface DaemonMcpMatch {
  /** The server id that `/api/mcp/oauth/start` saves the token under. */
  serverId: string;
  /** A server entry with another id still matches when its URL is on one of these hosts. */
  hosts: readonly string[];
}
export interface DaemonMcpConnection { url: string; accessToken: string; headers?: Record<string, string> }

export class DaemonBindingError extends Error {
  constructor(readonly code: 'connector-binding-missing' | 'connector-needs-sign-in', message: string) {
    super(message); this.name = 'DaemonBindingError';
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
const matches = (server: McpServerConfig, match: DaemonMcpMatch): boolean => {
  const host = hostOf(server.url);
  return server.id === match.serverId || (host !== null && match.hosts.some(item => host === item || host.endsWith(`.${item}`)));
};
const hasPinnedAuthorization = (server: McpServerConfig): boolean => Object.entries(server.headers ?? {})
  .some(([name, value]) => name.toLowerCase() === 'authorization' && value.trim() !== '');

/** Config read only: no token is read and no network I/O happens. Throws `connector-binding-missing`. */
export async function requireDaemonMcpServer(dataDir: string, match: DaemonMcpMatch): Promise<McpServerConfig> {
  const servers = (await readMcpConfig(dataDir)).servers.filter(server => matches(server, match));
  const server = servers.find(item => item.enabled) ?? servers[0];
  if (!server) throw new DaemonBindingError('connector-binding-missing', 'not-configured');
  if (!server.enabled) throw new DaemonBindingError('connector-binding-missing', 'disabled');
  if (server.transport !== 'http' || !server.url) throw new DaemonBindingError('connector-binding-missing', 'not-streamable-http');
  if (effectiveMcpAuthMode(server) === 'none' && !hasPinnedAuthorization(server)) throw new DaemonBindingError('connector-binding-missing', 'oauth-disabled');
  return server;
}

/**
 * The configured server's pinned Authorization, or its saved OAuth token refreshed
 * in place when expired. A pinned header also works with authMode: none.
 * Missing, mismatched or unrefreshable tokens are `connector-needs-sign-in`.
 */
export async function resolveDaemonMcpConnection(dataDir: string, match: DaemonMcpMatch, fetchImpl: typeof fetch): Promise<DaemonMcpConnection> {
  const server = await requireDaemonMcpServer(dataDir, match);
  const url = server.url!;
  // The trusted daemon configuration pins this principal, just as the MCP transport
  // and integration probe do. Do not read, refresh or fall back to another OAuth account.
  if (hasPinnedAuthorization(server)) return { url, accessToken: '', ...(server.headers ? { headers: server.headers } : {}) };
  const stored = await getToken(dataDir, server.id);
  if (!stored || !mcpTokenMatchesEndpoint(stored, url)) throw new DaemonBindingError('connector-needs-sign-in', 'no-token');
  const accessToken = isTokenExpired(stored) ? await refreshStored(dataDir, server.id, stored, fetchImpl) : stored.accessToken;
  return { url, accessToken, ...(server.headers ? { headers: server.headers } : {}) };
}

async function refreshStored(dataDir: string, serverId: string, stored: StoredMcpToken, fetchImpl: typeof fetch): Promise<string> {
  if ((stored.resourceUrl && !isPublicMcpResource(stored.resourceUrl)) || !stored.refreshToken || !stored.tokenEndpoint || !stored.clientId) throw new DaemonBindingError('connector-needs-sign-in', 'expired');
  let refreshed;
  try {
    // Refresh credentials belong to the saved endpoint, including image-access calls.
    refreshed = await refreshAccessToken({
      tokenEndpoint: stored.tokenEndpoint, clientId: stored.clientId, refreshToken: stored.refreshToken,
      ...(stored.clientSecret !== undefined ? { clientSecret: stored.clientSecret } : {}),
      ...(stored.scope !== undefined ? { scope: stored.scope } : {}),
      ...(stored.resourceUrl !== undefined ? { resource: stored.resourceUrl } : {}),
    }, (input, init) => fetchImpl(input, { ...init, redirect: 'error' }));
  } catch {
    throw new DaemonBindingError('connector-needs-sign-in', 'refresh-failed');
  }
  // RFC 6749 §5.1: an absent expires_in means no defined lifetime; an absent scope means unchanged.
  const { expiresAt: _stale, scope: staleScope, ...rest } = stored;
  const nextScope = refreshed.scope ?? staleScope;
  const next: StoredMcpToken = {
    ...rest, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    tokenType: refreshed.token_type ?? stored.tokenType,
    ...(nextScope !== undefined ? { scope: nextScope } : {}),
    ...(typeof refreshed.expires_in === 'number' ? { expiresAt: Date.now() + refreshed.expires_in * 1000 } : {}),
    savedAt: Date.now(),
  };
  await setToken(dataDir, serverId, next);
  return next.accessToken;
}
