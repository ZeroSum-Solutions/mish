// Mish packs: MCP server connections.
//
// A pack lists servers in the shape the app already stores (`mcp-config.json`). Install merges
// them into that file: a server whose id is already present is left alone (the user's entry
// wins), the rest are added. Remove takes out only the entries the pack added and the user has
// not changed since.
//
// A pack never holds a secret. Values in `env`, `headers` and `args` may contain `${NAME}`; the
// daemon replaces it with the value of NAME from its own environment at the moment it spawns an
// agent (`resolveMcpEnvRefs`), so the saved file keeps the placeholder, not the credential.

import { mishPackEnvRefs, type MishPackMcpServer } from '@mish/contracts';

import { readMcpConfig, sanitizeMcpServer, writeMcpConfig, type McpConfig, type McpServerConfig } from '../mcp-config.js';

export interface SeededMcpServer {
  id: string;
  /** The exact config written, so remove can tell whether the user changed it since. */
  config: McpServerConfig;
}

export function packServerToConfig(server: MishPackMcpServer): McpServerConfig | null {
  return sanitizeMcpServer({ ...server });
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Adds the pack's servers whose ids are free. Returns what was added and what was skipped. */
export async function seedPackMcpServers(
  dataDir: string,
  servers: readonly MishPackMcpServer[],
): Promise<{ seeded: SeededMcpServer[]; skipped: string[] }> {
  const seeded: SeededMcpServer[] = [];
  const skipped: string[] = [];
  if (servers.length === 0) return { seeded, skipped };
  await writeMcpConfig(dataDir, { servers: [] }, (_next, previous) => {
    const taken = new Set(previous.servers.map((server) => server.id));
    const merged = [...previous.servers];
    for (const server of servers) {
      const config = packServerToConfig(server);
      if (!config) {
        skipped.push(server.id);
        continue;
      }
      if (taken.has(config.id)) {
        skipped.push(config.id);
        continue;
      }
      taken.add(config.id);
      merged.push(config);
      seeded.push({ id: config.id, config });
    }
    return { servers: merged };
  });
  return { seeded, skipped };
}

/** Removes the entries a pack seeded, unless the user edited them. Returns the ids removed. */
export async function unseedPackMcpServers(dataDir: string, seeded: readonly SeededMcpServer[]): Promise<string[]> {
  if (seeded.length === 0) return [];
  const removed: string[] = [];
  await writeMcpConfig(dataDir, { servers: [] }, (_next, previous) => {
    const keep = previous.servers.filter((server) => {
      const mine = seeded.find((entry) => entry.id === server.id);
      if (mine && sameConfig(mine.config, server)) {
        removed.push(server.id);
        return false;
      }
      return true;
    });
    return { servers: keep };
  });
  return removed;
}

/** `${NAME}` references in one server, as variable names. */
export function mcpServerEnvRefs(server: Pick<MishPackMcpServer, 'args' | 'env' | 'headers'>): string[] {
  const names = new Set<string>();
  const scan = (value: string | undefined) => { if (value) for (const name of mishPackEnvRefs(value)) names.add(name); };
  for (const value of server.args ?? []) scan(value);
  for (const value of Object.values(server.env ?? {})) scan(value);
  for (const value of Object.values(server.headers ?? {})) scan(value);
  return [...names].sort();
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/gu;

function expandValue(value: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return value.replace(REF, (whole, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      missing.add(name);
      return whole;
    }
    return resolved;
  });
}

/**
 * Replaces `${NAME}` in `env`, `headers` and `args` with the value from `env`. A name that is not
 * set stays as written and is reported; the server is still returned so the failure is visible in
 * the agent's own MCP status instead of silently dropping a connection.
 */
export function resolveMcpEnvRefs(config: McpConfig, env: NodeJS.ProcessEnv = process.env): { config: McpConfig; missing: string[] } {
  const missing = new Set<string>();
  const servers = config.servers.map((server): McpServerConfig => {
    if (!server.args && !server.env && !server.headers) return server;
    const next: McpServerConfig = { ...server };
    if (server.args) next.args = server.args.map((value) => expandValue(value, env, missing));
    if (server.env) next.env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandValue(value, env, missing)]));
    if (server.headers) next.headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandValue(value, env, missing)]));
    return next;
  });
  return { config: { servers }, missing: [...missing].sort() };
}

/** `readMcpConfig` for an agent spawn: placeholders resolved from the daemon environment. */
export async function readMcpConfigForSpawn(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<McpConfig> {
  const { config, missing } = resolveMcpEnvRefs(await readMcpConfig(dataDir), env);
  if (missing.length > 0) console.warn(`[mcp-config] environment variables not set for MCP servers: ${missing.join(', ')}`);
  return config;
}
