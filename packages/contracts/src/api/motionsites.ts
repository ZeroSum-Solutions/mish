// Wire DTOs for the daemon's MotionSites bridge (apps/daemon/src/motionsites/), per the Sol
// design doc §1 "Catalog boundary" and §4 "MotionSites starting points and rights".
//
// What lives here is deliberately narrow: connection status, the merged catalog response
// envelope, and the separate paid-template starting-point list. The one MotionSites shape that
// is NOT here on purpose is a fetched prompt body (`get_prompt`'s result) — the design doc is
// explicit that a prompt body is fetched transiently at build start and handed to the fast lane
// "in memory," never persisted, logged, or cached (§1). Giving it a wire contract type would
// invite a future caller to serialize it into a request/response log or a generic `ApiError`
// `details` blob; it stays an internal shape in `apps/daemon/src/motionsites/design-reference.ts`
// instead, scoped to the one in-process call site that needs it.
//
// `SectionCatalogEntry` (./section-catalog.ts) is reused as-is for the catalog merge: a
// normalized MotionSites prompt IS a `SectionCatalogEntry` with `sourceKind: 'motionsites-prompt'`
// (see @mish/section-catalog's `normalizeMotionSitesPrompts`), so `MotionSitesCatalogResponse`
// carries `SectionCatalogResponse`'s `catalog` shape as-is rather than a parallel entry shape —
// but it is its own DTO, not a bare type alias: it adds the two fields a catalog fetch needs that
// a generic section catalog does not, `connection` and `upstream` (see each field's own doc). A
// plain `= SectionCatalogResponse` alias would mean the "contracts DTOs validated" story for this
// endpoint reduced to `parseSectionCatalogResponse` alone, carrying no independent shape for the
// two MotionSites-specific fields.

import type { SectionCatalogResponse, SectionCatalogSpineAffinities } from './section-catalog.js';

/**
 * Whether the signed-in user has a usable MotionSites MCP connection right now. Mirrors the
 * daemon's generic external-MCP-server states (mcp-tokens.ts's `getToken`/`isTokenExpired`) for
 * the one server id the bridge owns — see `MOTIONSITES_MCP_SERVER_ID` in
 * `apps/daemon/src/motionsites/config.ts`.
 *
 * - `not_connected`: no token stored for the MotionSites server id. The remedy is
 *   `POST /api/mcp/oauth/start` with `serverId: "motionsites"` (the daemon's existing external-MCP
 *   OAuth flow — see mcp-routes.ts), not a MotionSites-specific auth endpoint.
 * - `connected`: a token is stored and either not expired, or expired but carries a
 *   `refreshToken` — a caller that actually needs the live prompt library (a catalog fetch or
 *   `get_prompt`) transparently refreshes it on that call; this status read never performs
 *   network I/O to check.
 * - `expired`: a token is stored, is past `expiresAt`, and has no `refreshToken` to renew it.
 *   Same remedy as `not_connected`: `POST /api/mcp/oauth/start` with `serverId: "motionsites"`.
 */
export type MotionSitesConnectionStatus = 'not_connected' | 'connected' | 'expired';

export interface MotionSitesConnectionStatusDto {
  status: MotionSitesConnectionStatus;
  /** Absolute epoch ms the current token expires at, when the upstream issued one. */
  expiresAt?: number;
  /** Space-separated OAuth scopes granted, verbatim from the token response. */
  scope?: string;
}

/**
 * `GET /api/motionsites/catalog`'s success body. The catalog is `SectionCatalogEntry[]` merged at
 * request time from `list_prompts`/`search_prompts` — see the design doc §1: "never put prompt
 * bodies in the catalog JSON... Store an ID and deep link in a build request." A response with no
 * connection returns `entries: []`, not an error — a signed-out visitor still sees the local
 * HyperUI/family catalog (built and merged by other phases); only `get_prompt` at build start is
 * connection-gated hard enough to fail the request (`MOTIONSITES_LOGIN_REQUIRED` /
 * `MOTIONSITES_PAID_ACCESS_REQUIRED`, see packages/contracts/src/errors.ts).
 */
export interface MotionSitesCatalogResponse extends SectionCatalogResponse {
  /** The federated half's connection state at fetch time — the same value
   * `GET /api/motionsites/connection` reports, echoed here so a client rendering the catalog does
   * not need a second round trip to know why the federated half is thin or empty. */
  connection: MotionSitesConnectionStatus;
  /**
   * Present ONLY when the federated half degraded because the MotionSites MCP endpoint itself
   * failed (a transport error, a malformed response) while a connection was in use — never for
   * the ordinary "not connected"/"expired" case, which is just `entries: []` with no `upstream`
   * key at all (delta-audit FIX: `McpHttpTransportError` must not be swallowed indistinguishably
   * from "no results"). `code` is always `MOTIONSITES_UPSTREAM_UNAVAILABLE` (see
   * packages/contracts/src/errors.ts); `message` is the daemon's own transport-error summary, safe
   * to show a developer but not guaranteed to be end-user copy.
   */
  upstream?: {
    code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE';
    message: string;
  };
}

/**
 * One of the 40 paid MotionSites live templates (design doc §4: "a second external starting-point
 * list ... since they are links rather than section prompts"). Deliberately thin: title, category
 * (when MotionSites' own public template listing states one; it does not carry a category field
 * today, so most entries have none), a best-effort spine affinity, and the public deep link —
 * never an image, a Lovable/Bolt remix target, or a creator GitHub repo (design doc §4: "do not
 * proxy or bundle its preview images, videos, prompt text, ... or creator GitHub repositories").
 */
export interface MotionSitesStartingPoint {
  id: string;
  title: string;
  /** MotionSites' own category label, when known. `undefined` when none is publicly listed. */
  category?: string;
  /**
   * Every spine (no preference), a specific set, or too unclear to say from the title alone.
   * Mirrors `SectionCatalogEntry.spineAffinities`'s discipline (./section-catalog.ts): never a
   * guessed single spine, never a default `'MI'`.
   */
  spineAffinity: SectionCatalogSpineAffinities;
  /** The public `motionsites.ai/templates#<id>` deep link — never a Lovable/Bolt remix URL. */
  url: string;
}

export interface MotionSitesStartingPointsResponse {
  startingPoints: MotionSitesStartingPoint[];
}

/** `ApiError.details` shape for `MOTIONSITES_PAID_ACCESS_REQUIRED`. */
export interface MotionSitesPaidAccessRequiredDetails {
  kind: 'motionsites-paid-access-required';
  /** The prompt id the caller asked for, so a client can name it without re-deriving it. */
  promptId: string;
  /** motionsites.ai/unlimited, verbatim — the daemon never fabricates a price or plan name. */
  upgradeUrl: string;
}
