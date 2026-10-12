/**
 * B-121: saved MCP secrets never leave the daemon through `GET`/`PUT /api/mcp/servers`.
 *
 * `maskMcpServers` replaces every saved secret with `MCP_SECRET_MASK`: each non-empty header and
 * env value, command, argument and complete URL. The daemon keeps the real values for
 * spawning agents (`readMcpConfig` is unchanged).
 *
 * `restoreMcpSecrets` is the other half: a client edits the masked list and sends it back. A field
 * that still carries the mask must equal the masked form of the stored value in the SAME slot
 * (same server id, and the same header/env key or arg index, or the same masked URL); then the
 * stored secret is kept. A mask that cannot be placed is refused, so a mask is never saved.
 * Errors name the server and the field, never a value.
 */

import { MCP_SECRET_MASK } from '@mish/contracts';
import { effectiveMcpAuthMode, type McpServerConfig } from './mcp-config.js';

/** Connection fields are opaque: credentials may appear anywhere, regardless of shape. */
export function maskUrl(url: string): string {
  return url === '' ? '' : MCP_SECRET_MASK;
}

/** Keep arg slots so an unchanged save restores the exact original array, including spaces. */
export function maskArgs(args: readonly string[]): string[] {
  return args.map((arg) => arg === '' ? '' : MCP_SECRET_MASK);
}

function maskValues(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value === '' ? '' : MCP_SECRET_MASK]));
}

/** One server as a client may see it. */
export function maskMcpServer(server: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...server };
  if (server.headers) out.headers = maskValues(server.headers)!;
  if (server.env) out.env = maskValues(server.env)!;
  if (server.command) out.command = MCP_SECRET_MASK;
  if (server.args) out.args = maskArgs(server.args);
  if (server.url) out.url = maskUrl(server.url);
  return out;
}

export function maskMcpServers(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.map(maskMcpServer);
}

/** A sent value equals the saved one, or stands for it with the mask in the same place. */
function sameValue(saved: string | undefined, sent: string | undefined, masked: string | undefined): boolean {
  if (saved === undefined || sent === undefined) return saved === sent;
  return sent.includes(MCP_SECRET_MASK) ? sent === masked : sent === saved;
}

function sameMap(saved: Record<string, string> | undefined, sent: Record<string, string> | undefined): boolean {
  const before = saved ?? {};
  const after = sent ?? {};
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every((key) => Object.hasOwn(after, key) && (after[key] === MCP_SECRET_MASK || after[key] === before[key]));
}

function unchangedApartFromMasks(saved: McpServerConfig, sent: McpServerConfig): boolean {
  if (saved.transport !== sent.transport || !sameValue(saved.command, sent.command, saved.command ? MCP_SECRET_MASK : saved.command)) return false;
  if (effectiveMcpAuthMode(saved) !== effectiveMcpAuthMode(sent)) return false;
  if (!sameValue(saved.url, sent.url, saved.url === undefined ? undefined : maskUrl(saved.url))) return false;
  const before = saved.args ?? [];
  const after = sent.args ?? [];
  if (before.length !== after.length) return false;
  const maskedBefore = maskArgs(before);
  if (!after.every((arg, index) => sameValue(before[index], arg, maskedBefore[index]))) return false;
  return sameMap(saved.headers, sent.headers) && sameMap(saved.env, sent.env);
}

/** Why a PUT carried a mask the daemon could not place. Names the server and field only. */
export class McpSecretMaskError extends Error {
  readonly serverId: string;
  readonly field: string;
  constructor(serverId: string, field: string) {
    super(`The saved secret for ${field} on MCP server "${serverId}" could not be kept. Enter the value again.`);
    this.name = 'McpSecretMaskError';
    this.serverId = serverId;
    this.field = field;
  }
}

function restoreMap(
  serverId: string,
  kind: 'header' | 'env',
  incoming: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!value.includes(MCP_SECRET_MASK)) {
      out[key] = value;
      continue;
    }
    const kept = stored && Object.hasOwn(stored, key) ? stored[key] : undefined;
    if (value !== MCP_SECRET_MASK || !kept) throw new McpSecretMaskError(serverId, `${kind} ${key}`);
    out[key] = kept;
  }
  return out;
}

/**
 * `incoming` (already sanitized) with every mask replaced by the stored secret of the same slot
 * in `stored`. Throws `McpSecretMaskError` when a mask cannot be placed; the result never
 * contains `MCP_SECRET_MASK`.
 */
export function restoreMcpSecrets(incoming: readonly McpServerConfig[], stored: readonly McpServerConfig[]): McpServerConfig[] {
  const storedById = new Map(stored.map((server) => [server.id, server]));
  const restored = incoming.map((server) => {
    const saved = storedById.get(server.id);
    // A save keeps saved secrets only when the server is otherwise unchanged: the same transport,
    // auth mode, URL, command and args, and the same header and env key sets, every value either
    // the mask or unchanged. Only `label`, `enabled` and `templateId` may differ (switching to
    // managed OAuth sends the URL into an authorization flow, so it needs the secrets again). Every edit
    // that can change where a credential goes or what runs with it (a new path, a routing
    // header, an added or deleted env key such as `NODE_OPTIONS`, `PATH` or an endpoint
    // variable, rewritten `-e` code) means every saved secret on that server is entered again.
    const sameDestination = saved !== undefined && unchangedApartFromMasks(saved, server);
    const previous = sameDestination ? saved : undefined;
    const out: McpServerConfig = { ...server };
    if (server.command?.includes(MCP_SECRET_MASK)) {
      if (!previous?.command || server.command !== MCP_SECRET_MASK) throw new McpSecretMaskError(server.id, 'command');
      out.command = previous.command;
    }
    const headers = restoreMap(server.id, 'header', server.headers, previous?.headers);
    if (headers) out.headers = headers;
    const env = restoreMap(server.id, 'env', server.env, previous?.env);
    if (env) out.env = env;
    if (server.url?.includes(MCP_SECRET_MASK)) {
      if (!previous?.url || maskUrl(previous.url) !== server.url) throw new McpSecretMaskError(server.id, 'url');
      out.url = previous.url;
    }
    if (server.args?.some((arg) => arg.includes(MCP_SECRET_MASK))) {
      const before = previous?.args ?? [];
      const maskedBefore = maskArgs(before);
      const args = server.args.map((arg, index) => {
        if (!arg.includes(MCP_SECRET_MASK)) return arg;
        // The full server projection has already matched, so this is the same saved slot.
        if (before[index] === undefined || maskedBefore[index] !== arg) throw new McpSecretMaskError(server.id, `arg ${index + 1}`);
        return before[index]!;
      });
      // A restored value must still be masked where it now sits.
      const remasked = maskArgs(args);
      server.args.forEach((arg, index) => {
        if (arg.includes(MCP_SECRET_MASK) && remasked[index] !== arg) throw new McpSecretMaskError(server.id, `arg ${index + 1}`);
      });
      out.args = args;
    }
    return out;
  });
  // Defence in depth: whatever field it was in (id, label, command…), a mask is never saved.
  for (const server of restored) {
    if (JSON.stringify(server).includes(MCP_SECRET_MASK)) throw new McpSecretMaskError(server.id, 'a field');
  }
  return restored;
}
