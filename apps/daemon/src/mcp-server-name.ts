// Spawn-time MCP server names.
//
// Claude Code keeps `~/.claude/mcp-needs-auth-cache.json` keyed by server NAME
// only. A daemon-spawned session that connects to a user server id such as
// `refero` without a token would write `refero` into that machine-wide cache
// and make every other Claude session skip its own user-level `refero`.
// Every server name the daemon injects into a spawned agent therefore carries
// this prefix. Daemon ids, saved settings and connector matching keep the
// bare id; only the name written into the agent's config changes.

export const SPAWNED_MCP_NAME_PREFIX = 'mishmash-';

/** `refero` -> `mishmash-refero`; already-prefixed names pass through. */
export function spawnedMcpServerName(id: string): string {
  return id.startsWith(SPAWNED_MCP_NAME_PREFIX) ? id : `${SPAWNED_MCP_NAME_PREFIX}${id}`;
}
