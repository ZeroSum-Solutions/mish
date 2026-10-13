import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { sendApiError } from './api-errors.js';
import { isLoopbackPeerAddress } from './local-daemon-request.js';

// Per-peer request budget for /api and /artifacts. The daemon is loopback-bound
// by default and the desktop UI polls it heavily, so loopback peers are not
// counted (the same exemption the API-token middleware grants them). Peers that
// reach a daemon bound beyond loopback (Docker, a reverse proxy) get a ceiling
// well above any normal browser session but low enough to blunt a token-guessing
// or request-flood loop. js/missing-rate-limiting expects the limiter to run
// before any route handler that performs authorization.
export const API_RATE_LIMIT_WINDOW_MS = 60_000;
export const API_RATE_LIMIT_DEFAULT_MAX = 1200;

export function apiRateLimitMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.OD_API_RATE_LIMIT_PER_MINUTE ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : API_RATE_LIMIT_DEFAULT_MAX;
}

export function createApiRateLimiter(
  options: { max?: number; windowMs?: number } = {},
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? API_RATE_LIMIT_WINDOW_MS,
    limit: options.max ?? apiRateLimitMaxFromEnv(),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => isLoopbackPeerAddress(req.socket?.remoteAddress),
    handler: (_req, res) =>
      sendApiError(res, 429, 'RATE_LIMITED', 'too many requests; retry after the Retry-After interval', {
        retryable: true,
      }),
  });
}
