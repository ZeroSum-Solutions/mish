// Persistent OAuth-token storage for external HTTP / SSE MCP servers.
//
// The daemon owns the OAuth flow end-to-end so the user never needs a
// transient `localhost:<port>` listener (the killer of cloud deployments)
// and so a token survives across agent turns. Tokens are written to
// `<dataDir>/mcp-tokens.json` keyed by McpServerConfig.id, with the same
// atomic write + per-dataDir mutex pattern the rest of the daemon uses.
//
// File mode: chmod 0600 on POSIX so other local users can't read raw
// bearer tokens. Legacy POSIX files are tightened through a safe descriptor
// before reading; unsafe files or permission failures refuse the read.

import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readPrivateMcpFile, withPrivateMcpFileLock } from './mcp-private-file.js';

/**
 * Stored OAuth token for a single MCP server. Mirrors the relevant subset
 * of an OAuth 2.0 token-endpoint response (RFC 6749 §5.1), plus the OAuth
 * client context the original authorization-code exchange used. Refresh
 * tokens are bound (RFC 6749 §6) to the client that received them, so we
 * have to refresh against the same `client_id` / `redirect_uri` pair —
 * persisting the context here is what lets us do that without re-running
 * authorization.
 */
export interface StoredMcpToken {
  /** The bearer token to send as `Authorization: Bearer …`. */
  accessToken: string;
  /** Refresh token (RFC 6749 §6) if the auth server issued one. */
  refreshToken?: string;
  /** Absolute epoch ms at which `accessToken` expires. Optional — some
   * providers never expire. */
  expiresAt?: number;
  /** RFC 6749 §5.1 token_type. Almost always `Bearer`. */
  tokenType: string;
  /** Space-separated scopes granted (verbatim from the token response). */
  scope?: string;
  /** Wall-clock epoch ms when this record was first persisted. */
  savedAt: number;
  /** Token endpoint that issued this token; reused verbatim for refresh. */
  tokenEndpoint?: string;
  /** Client id that obtained the refresh token. */
  clientId?: string;
  /** Confidential-client secret, if the upstream issued one. */
  clientSecret?: string;
  /** Authorization-server issuer, used to look the cached client back up. */
  authServerIssuer?: string;
  /** Redirect URI registered with the client at authorization time. */
  redirectUri?: string;
  /** RFC 8707 resource indicator the original token was scoped to. */
  resourceUrl?: string;
  /** SHA256 of the exact configured endpoint at authorization time. */
  endpointFingerprint?: string;
}

export interface McpTokensFile {
  /** keyed by McpServerConfig.id */
  servers: Record<string, StoredMcpToken>;
}

/** Token maps are null-prototype so ids such as `constructor` or `toString` are ordinary keys. */
function emptyServers(): Record<string, StoredMcpToken> {
  return Object.create(null) as Record<string, StoredMcpToken>;
}

function emptyFile(): McpTokensFile {
  return { servers: emptyServers() };
}

function tokensFile(dataDir: string): string {
  return path.join(dataDir, 'mcp-tokens.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Coerce a freeform JSON blob into the typed shape, dropping anything that
 * doesn't deserialize cleanly. Used both at read time and as a defensive
 * pass when third-party tooling has hand-edited the file. */
export function sanitizeTokensFile(raw: unknown): McpTokensFile {
  if (!isPlainObject(raw)) return emptyFile();
  const servers = raw.servers;
  if (!isPlainObject(servers)) return emptyFile();
  const out = emptyServers();
  for (const [id, value] of Object.entries(servers)) {
    if (id === '__proto__') continue;
    const tok = sanitizeToken(value);
    if (!tok) continue;
    out[id] = tok;
  }
  return { servers: out };
}

function sanitizeToken(raw: unknown): StoredMcpToken | null {
  if (!isPlainObject(raw)) return null;
  const accessToken =
    typeof raw.accessToken === 'string' ? raw.accessToken.trim() : '';
  if (!accessToken) return null;
  const tokenType =
    typeof raw.tokenType === 'string' && raw.tokenType.trim()
      ? raw.tokenType.trim()
      : 'Bearer';
  const refreshToken =
    typeof raw.refreshToken === 'string' && raw.refreshToken.trim()
      ? raw.refreshToken.trim()
      : undefined;
  const scope =
    typeof raw.scope === 'string' && raw.scope.trim()
      ? raw.scope.trim()
      : undefined;
  const expiresAt =
    typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
      ? raw.expiresAt
      : undefined;
  const savedAt =
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt)
      ? raw.savedAt
      : Date.now();
  const tokenEndpoint =
    typeof raw.tokenEndpoint === 'string' && raw.tokenEndpoint.trim()
      ? raw.tokenEndpoint.trim()
      : undefined;
  const clientId =
    typeof raw.clientId === 'string' && raw.clientId.trim()
      ? raw.clientId.trim()
      : undefined;
  const clientSecret =
    typeof raw.clientSecret === 'string' && raw.clientSecret.trim()
      ? raw.clientSecret.trim()
      : undefined;
  const authServerIssuer =
    typeof raw.authServerIssuer === 'string' && raw.authServerIssuer.trim()
      ? raw.authServerIssuer.trim()
      : undefined;
  const redirectUri =
    typeof raw.redirectUri === 'string' && raw.redirectUri.trim()
      ? raw.redirectUri.trim()
      : undefined;
  const resourceUrl =
    typeof raw.resourceUrl === 'string' && raw.resourceUrl.trim()
      ? raw.resourceUrl.trim()
      : undefined;
  const out: StoredMcpToken = { accessToken, tokenType, savedAt };
  if (refreshToken) out.refreshToken = refreshToken;
  if (scope) out.scope = scope;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  if (tokenEndpoint) out.tokenEndpoint = tokenEndpoint;
  if (clientId) out.clientId = clientId;
  if (clientSecret) out.clientSecret = clientSecret;
  if (authServerIssuer) out.authServerIssuer = authServerIssuer;
  if (redirectUri) out.redirectUri = redirectUri;
  if (resourceUrl) out.resourceUrl = resourceUrl;
  if (typeof raw.endpointFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(raw.endpointFingerprint)) out.endpointFingerprint = raw.endpointFingerprint;
  return out;
}

export async function readTokensFile(dataDir: string): Promise<McpTokensFile> {
  try {
    const raw = await readPrivateMcpFile(tokensFile(dataDir));
    return sanitizeTokensFile(JSON.parse(raw));
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return emptyFile();
    if (e.name === 'SyntaxError') {
      console.error('[mcp-tokens] Corrupted JSON, returning empty.');
      return emptyFile();
    }
    throw err;
  }
}

function withLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  return withPrivateMcpFileLock(tokensFile(dataDir), fn);
}

async function writeTokensFile(
  dataDir: string,
  next: McpTokensFile,
): Promise<McpTokensFile> {
  const file = tokensFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  // Created owner-only and exclusively (B-121): a bearer token is never world-readable, not even
  // between this write and the rename.
  let created = false;
  try {
    // Open exclusively first, so ownership is known before a byte is written: a partial write
    // is cleaned up, and an exclusive-create collision leaves the other writer's file alone.
    const handle = await open(tmp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    if (created) await rm(tmp, { force: true });
    throw err;
  }
  // Best-effort lockdown of file mode. Bearer tokens can hand someone
  // posting-as-you against the upstream MCP, so we restrict to owner-only
  // read/write where the OS supports it.
  try {
    await chmod(file, 0o600);
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code !== 'ENOTSUP' && e.code !== 'EPERM') {
      console.warn(
        '[mcp-tokens] could not chmod 0600',
        file,
        e.message ?? err,
      );
    }
  }
  return next;
}

/** Get the current token for a given server, or null when none is stored
 * (or the persisted entry is malformed). */
export async function getToken(
  dataDir: string,
  serverId: string,
): Promise<StoredMcpToken | null> {
  const file = await readTokensFile(dataDir);
  return Object.hasOwn(file.servers, serverId) ? (file.servers[serverId] ?? null) : null;
}

/** Atomically merge a new token for `serverId` into the tokens file. */
export async function setToken(
  dataDir: string,
  serverId: string,
  token: StoredMcpToken,
): Promise<void> {
  await withLock(dataDir, async () => {
    const file = await readTokensFile(dataDir);
    file.servers[serverId] = token;
    await writeTokensFile(dataDir, file);
  });
}

/** Atomically delete the stored token for `serverId`. No-op when absent. */
export async function clearToken(
  dataDir: string,
  serverId: string,
): Promise<void> {
  await withLock(dataDir, async () => {
    const file = await readTokensFile(dataDir);
    if (!Object.hasOwn(file.servers, serverId)) return;
    delete file.servers[serverId];
    await writeTokensFile(dataDir, file);
  });
}

/** Bulk read used by the spawn pipeline so we make one disk hit per spawn,
 * not one per server. */
export async function readAllTokens(
  dataDir: string,
): Promise<Record<string, StoredMcpToken>> {
  const file = await readTokensFile(dataDir);
  return file.servers;
}

/** True when the stored token is past its `expiresAt` (or within `skew`
 * milliseconds of expiring). Returns false when no `expiresAt` is recorded
 * — many providers issue non-expiring tokens. */
export function isTokenExpired(
  token: StoredMcpToken,
  now: number = Date.now(),
  skew: number = 30_000,
): boolean {
  if (typeof token.expiresAt !== 'number') return false;
  return token.expiresAt - skew <= now;
}
