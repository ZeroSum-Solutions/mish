// Mish packs: allow-listed environment. A pack can set a handful of service endpoints and nothing
// else. A value already in the daemon environment always wins, so a person's own setting is never
// replaced. Values a pack applied earlier are replaced when the pack changes or is removed.

import { MISH_PACK_ENV_ALLOWLIST, mishPackEnvProblem, type MishPackEnvKey } from '@mish/contracts';

import type { ActiveMishPack } from './overlay.js';

let lastApplied = new Map<string, string>();

function isAllowed(key: string): key is MishPackEnvKey {
  return Object.hasOwn(MISH_PACK_ENV_ALLOWLIST, key);
}

/**
 * The environment a set of packs contributes: pack-id order, the first pack to set a key wins.
 * Entries that fail the allow-list or their value check are dropped.
 */
export function collectPackEnv(packs: readonly ActiveMishPack[]): Map<string, { target: string; value: string; packId: string }> {
  const out = new Map<string, { target: string; value: string; packId: string }>();
  for (const pack of packs) {
    for (const [key, value] of Object.entries(pack.manifest.provides.env ?? {})) {
      if (!isAllowed(key) || mishPackEnvProblem(key, value) !== null) continue;
      const { target } = MISH_PACK_ENV_ALLOWLIST[key];
      if (!out.has(target)) out.set(target, { target, value, packId: pack.id });
    }
  }
  return out;
}

/** Applies the packs' environment to `env` and reverts what an earlier call applied and no pack sets now. */
export function applyPackEnv(packs: readonly ActiveMishPack[], env: NodeJS.ProcessEnv = process.env): string[] {
  const wanted = collectPackEnv(packs);
  const previous = lastApplied;
  for (const [target, value] of previous) {
    if (!wanted.has(target) && env[target] === value) delete env[target];
  }
  const applied = new Map<string, string>();
  for (const { target, value } of wanted.values()) {
    const current = env[target];
    const mine = previous.get(target);
    if (current === undefined || current === '' || (mine !== undefined && current === mine)) {
      env[target] = value;
      applied.set(target, value);
    }
  }
  lastApplied = applied;
  return [...applied.keys()].sort();
}

/** Names (not values) of the environment variables a pack's MCP servers read. */
export function packRequiredEnvNames(pack: ActiveMishPack, servers = pack.manifest.provides.mcpServers ?? []): string[] {
  const names = new Set<string>();
  for (const server of servers) {
    for (const value of [...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]) {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/gu)) names.add(match[1]!);
    }
  }
  return [...names].sort();
}
