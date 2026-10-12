/**
 * Merges the MotionSites bridge's two catalog sources into one `SectionCatalogEntry[]` (design doc
 * §1 plus the 2026-09-24 phase-C coordination note): the bundled `local-corpus` (owner-authored,
 * always available, no connection needed) and the federated `motionsites-mcp` source (live
 * `list_prompts`/`search_prompts` via `callMotionSitesTool`, needs the user's own MotionSites
 * connection). Local entries come first, per the coordination note ("The catalog response merges
 * both, local first").
 *
 * A missing/expired MotionSites connection does NOT fail this call — it just means the
 * `motionsites-mcp` half contributes nothing (see `MotionSitesCatalogResponse`'s own doc in
 * packages/contracts/src/api/motionsites.ts: "A response with no connection returns entries: [],
 * not an error"). `MOTIONSITES_LOGIN_REQUIRED`/`MOTIONSITES_PAID_ACCESS_REQUIRED` are reserved for
 * starting a build with a chosen `designReferenceId` (see design-reference.ts), where a specific
 * prompt actually has to be fetched.
 *
 * A *transport* failure (`McpHttpTransportError` — the endpoint is unreachable, answered non-2xx,
 * or returned malformed JSON-RPC) is a different case from "no connection": the daemon does have a
 * token and did try. That case still degrades to a local-only catalog rather than failing the
 * whole request (delta-audit FIX: local entries and any HyperUI/family entries another phase
 * merges in are still perfectly servable), but it is not swallowed silently — the caller gets a
 * structured `upstream` signal (`MotionSitesCatalogResult.upstream`, code
 * `MOTIONSITES_UPSTREAM_UNAVAILABLE`, with the transport error's message) it can surface in the
 * HTTP response, and this module also logs a warning so a broken MotionSites endpoint is
 * distinguishable from "you have no prompts matching this query" in the daemon's own logs. The log
 * line deliberately carries no payload — not the transport error's message (which can embed a raw
 * response body via `McpHttpTransportError`'s own `detail` interpolation), only its constructor
 * name — while the full message still reaches the API response, which is scoped to the one caller
 * who asked.
 */

import type { SectionCatalogEntry } from '@open-design/contracts/api/section-catalog';
import { normalizeMotionSitesPrompts, type MotionSitesListPromptsResponse } from '@open-design/section-catalog/motionsites';
import { getLocalCorpusEntries } from './local-corpus-source.js';
import { resolveMotionSitesMcpConnection } from './connection.js';
import { callMotionSitesTool, McpHttpTransportError } from './mcp-client.js';
import { MotionSitesLoginRequiredError } from './errors.js';

export interface FetchMotionSitesCatalogOptions {
  /** Free-text search — when present, uses `search_prompts` instead of `list_prompts`. */
  query?: string;
  category?: string;
  kind?: 'website' | 'app' | 'any';
  access?: 'free' | 'premium' | 'any';
  limit?: number;
  fetchImpl?: typeof fetch;
}

/** One catalog fetch's outcome. `upstream` is present only when the federated half degraded
 * because the MotionSites MCP endpoint itself failed while a token was in use — see the module
 * doc. It is absent (not merely `undefined`-valued) for the ordinary "no connection" case, so a
 * caller can tell "nothing federated because you're signed out" from "nothing federated because
 * the endpoint is broken" by whether this key exists at all. */
export interface MotionSitesCatalogResult {
  entries: SectionCatalogEntry[];
  upstream?: {
    code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE';
    message: string;
  };
}

/**
 * The merged catalog. Never throws for "not connected" — see the module doc. A transport failure
 * degrades the federated half to empty the same way, but is reported back via `upstream` rather
 * than swallowed — see `MotionSitesCatalogResult`.
 */
export async function fetchMotionSitesCatalogEntries(
  dataDir: string,
  options: FetchMotionSitesCatalogOptions = {},
): Promise<MotionSitesCatalogResult> {
  const local = await getLocalCorpusEntries();
  const federated = await fetchFederatedEntries(dataDir, options);
  return {
    entries: [...local, ...federated.entries],
    ...(federated.upstream ? { upstream: federated.upstream } : {}),
  };
}

async function fetchFederatedEntries(
  dataDir: string,
  options: FetchMotionSitesCatalogOptions,
): Promise<MotionSitesCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const toolName = options.query ? 'search_prompts' : 'list_prompts';
  const args: Record<string, unknown> = options.query
    ? { query: options.query, limit: options.limit }
    : { category: options.category, kind: options.kind, access: options.access, limit: options.limit };

  try {
    const connection = await resolveMotionSitesMcpConnection(dataDir, fetchImpl);
    const result = await callMotionSitesTool({ ...connection, fetchImpl }, toolName, args);
    if (result.isError) return { entries: [] }; // a tool-level denial — degrade to empty, see the module doc
    const parsed = parseListResult(result.data, result.text);
    if (!parsed) return { entries: [] };
    return { entries: normalizeMotionSitesPrompts(parsed) as unknown as SectionCatalogEntry[] };
  } catch (err) {
    if (err instanceof MotionSitesLoginRequiredError) return { entries: [] }; // no connection — not an upstream failure
    if (err instanceof McpHttpTransportError) {
      // Warning-level, and deliberately carries no payload — not `err.message` (which can embed a
      // raw upstream response body, see the module doc) and not the error object itself, only its
      // name. The message itself is still returned to the caller via `upstream.message` below.
      console.warn(`[motionsites] catalog: federated upstream unavailable (${err.name}), degrading to local-only catalog`);
      return { entries: [], upstream: { code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: err.message } };
    }
    throw err;
  }
}

function parseListResult(data: unknown, text: string): MotionSitesListPromptsResponse | null {
  if (isListResponse(data)) return data;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isListResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isListResponse(value: unknown): value is MotionSitesListPromptsResponse {
  return typeof value === 'object' && value !== null && Array.isArray((value as { results?: unknown }).results);
}
