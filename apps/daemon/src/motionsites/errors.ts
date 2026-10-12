/**
 * Typed failures for the MotionSites bridge. Route handlers (routes/motionsites.ts) catch these
 * and translate them to the structured `ApiError` codes in packages/contracts/src/errors.ts
 * (`MOTIONSITES_LOGIN_REQUIRED`, `MOTIONSITES_PAID_ACCESS_REQUIRED`,
 * `MOTIONSITES_UPSTREAM_UNAVAILABLE`) — kept as plain Error subclasses here (not the wire codes
 * themselves) so this module stays usable from a non-HTTP caller (a future CLI/build-route
 * in-process call) without importing Express or `packages/contracts`.
 */

import { MOTIONSITES_UPGRADE_URL } from './config.js';

export class MotionSitesLoginRequiredError extends Error {
  constructor(message = 'No MotionSites connection — sign in via POST /api/mcp/oauth/start with serverId "motionsites".') {
    super(message);
    this.name = 'MotionSitesLoginRequiredError';
  }
}

export class MotionSitesPaidAccessRequiredError extends Error {
  readonly promptId: string;
  readonly upgradeUrl: string;
  constructor(promptId: string, message = `MotionSites prompt "${promptId}" requires a paid plan or the free-tier allowance is exhausted. ${MOTIONSITES_UPGRADE_URL}`) {
    super(message);
    this.name = 'MotionSitesPaidAccessRequiredError';
    this.promptId = promptId;
    this.upgradeUrl = MOTIONSITES_UPGRADE_URL;
  }
}

/** A transport failure, malformed response, or upstream 5xx — never a bare 401/403, which the two
 * errors above cover instead. */
export class MotionSitesUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MotionSitesUpstreamError';
  }
}

/**
 * Best-effort classification of an MCP tool-level error (`result.isError: true`, its text) into
 * `MotionSitesPaidAccessRequiredError` or `MotionSitesUpstreamError`. MotionSites publishes no
 * machine-readable error code for "needs a plan" (design doc §4: the site has no
 * `/terms`/`/license`/`/pricing` API contract beyond its MCP tool descriptions), so this reads the
 * upstream's own words case-insensitively — the same words its `get_prompt` tool description uses
 * ("plan", "premium", "unlimited"). A message this can't classify becomes `MotionSitesUpstreamError`,
 * never silently treated as success.
 */
export function classifyMotionSitesFailure(promptId: string, message: string): MotionSitesPaidAccessRequiredError | MotionSitesUpstreamError {
  const text = message.toLowerCase();
  const paidSignals = ['premium', 'paid plan', 'upgrade', 'unlimited', 'plan required', 'subscribe', 'allowance', 'free account'];
  if (paidSignals.some((signal) => text.includes(signal))) {
    return new MotionSitesPaidAccessRequiredError(promptId, message);
  }
  return new MotionSitesUpstreamError(message);
}
