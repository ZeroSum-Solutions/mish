import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { sendApiError } from './api-errors.js';
import { isLoopbackPeerAddress } from './local-daemon-request.js';

// Per-peer request budget for every route, the SPA document included (its
// Basic-auth challenge compares credentials too). The daemon is loopback-bound
// by default and the desktop UI polls it heavily, so loopback peers are not
// counted (the same exemption the API-token middleware grants them). Peers that
// reach a daemon bound beyond loopback (Docker, a reverse proxy) get a ceiling
// well above any normal browser session but low enough to blunt a token-guessing
// or request-flood loop. js/missing-rate-limiting expects the limiter to run
// before any route handler that performs authorization.
export const API_RATE_LIMIT_WINDOW_MS = 60_000;
export const API_RATE_LIMIT_DEFAULT_MAX = 1200;

export function apiRateLimitMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.OD_API_RATE_LIMIT_PER_MINUTE ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return API_RATE_LIMIT_DEFAULT_MAX;
  const parsed = Number(raw);
  return parsed > 0 ? parsed : API_RATE_LIMIT_DEFAULT_MAX;
}

// Unauthenticated liveness probes stay open so monitors never see 429 from a
// busy peer. Only a bodyless GET or HEAD without credentials qualifies: a probe
// path must not become a free lane for body parsing or token guessing. The
// match follows Express's own routing (case-insensitive, optional trailing
// slash) so the aliases a probe can reach are exempt together.
const OPEN_PROBE_PATHS = new Set(['/api/health', '/api/ready', '/api/version']);

function isOpenProbeRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.authorization !== undefined) return false;
  const length = req.headers['content-length'];
  if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined) {
    return false;
  }
  return OPEN_PROBE_PATHS.has(req.path.toLowerCase().replace(/\/+$/, ''));
}

// The peer is the socket address. The web sidecar and a same-host reverse proxy
// reach the daemon from 127.0.0.1 and put the real client in X-Forwarded-For
// (the sidecar appends the socket address of its own peer last), so a loopback
// peer that names a different client is counted as that client. A non-loopback
// peer is never trusted to name anyone else: its forwarding headers are ignored,
// so it cannot pick its own bucket.
function clientAddress(req: Request): string {
  const peer = req.socket?.remoteAddress ?? '';
  if (!isLoopbackPeerAddress(peer)) return peer || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return chain.length > 0 ? chain[chain.length - 1]! : peer;
}

export function createApiRateLimiter(
  options: { max?: number; windowMs?: number } = {},
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? API_RATE_LIMIT_WINDOW_MS,
    limit: options.max ?? apiRateLimitMaxFromEnv(),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keyed on the socket peer on purpose (see clientAddress), so the library's
    // trust-proxy and forwarded-header sanity checks do not apply.
    validate: { trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
    keyGenerator: (req) => ipKeyGenerator(clientAddress(req)),
    skip: (req) => isOpenProbeRequest(req) || isLoopbackPeerAddress(clientAddress(req)),
    handler: (_req, res) =>
      sendApiError(res, 429, 'RATE_LIMITED', 'too many requests; retry after the Retry-After interval', {
        retryable: true,
      }),
  });
}
