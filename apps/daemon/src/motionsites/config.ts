/**
 * Shared constants for the MotionSites bridge (design doc §1, §4). One file so the server id used
 * by the daemon's generic external-MCP-server config/OAuth/token stores (mcp-config.ts,
 * mcp-oauth.ts, mcp-tokens.ts) and the id used by this module's own code never drift apart.
 */

/** The `McpServerConfig.id` / `mcp-tokens.json` key this bridge owns. Reused verbatim by
 * `POST /api/mcp/oauth/start` (`{ serverId: "motionsites" }`) — the daemon's existing external-MCP
 * OAuth flow, not a MotionSites-specific one (design doc §1: "The daemon resolves the MotionSites
 * MCP connection using the user's own OAuth state"). */
export const MOTIONSITES_MCP_SERVER_ID = 'motionsites';

/** The provider's published protected-resource URL (verified 2026-10-03). Registration default
 * only: native calls resolve the user's configured URL through connection.ts. */
export const MOTIONSITES_MCP_URL = 'https://xgdzyqfalbibzelpdpvr.supabase.co/functions/v1/mcp';

/** The upgrade link MotionSites' own `list_prompts`/`get_prompt` responses name verbatim. Never
 * fabricate a price or plan name — always this literal URL. */
export const MOTIONSITES_UPGRADE_URL = 'https://motionsites.ai/unlimited';

/** The MCP_TEMPLATES entry `ensureMotionSitesServerRegistered` (connection.ts) seeds into
 * `mcp-config.json`, and the same shape `mcp-config.ts`'s own `MCP_TEMPLATES` array carries for
 * the generic "Add MCP server" picker — see that file for why a built-in bridge feature still gets
 * a template entry (so Settings → External MCP servers shows an honest "MotionSites" row instead
 * of an unlabeled `serverId: "motionsites"` the picker has no template for). */
export const MOTIONSITES_MCP_TEMPLATE = {
  id: MOTIONSITES_MCP_SERVER_ID,
  label: 'MotionSites',
} as const;
