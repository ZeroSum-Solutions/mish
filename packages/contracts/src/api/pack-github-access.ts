// GitHub access for licensed-pack downloads (Licensed Pack plan, Phase 1
// items 2 and 3): the DTOs of `GET/POST/DELETE /api/packs/github-access`.
//
// The daemon resolves the token a `github:` pack install sends (a token the
// user pasted once, then `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`).
// The paste reaches the daemon in exactly one place: the POST body. Nothing
// sends it back. The status names only which source is in effect: no token,
// no prefix and no tail (stricter than the media-key "tail" pattern, because a
// GitHub token is account-scoped).

import { z } from 'zod';

export const PACK_GITHUB_ACCESS_SOURCES = ['stored', 'env', 'gh-cli', 'none'] as const;
/** `stored`: the pasted token. `env`: `GH_TOKEN`/`GITHUB_TOKEN`. `gh-cli`: `gh auth token`. */
export type PackGithubAccessSource = (typeof PACK_GITHUB_ACCESS_SOURCES)[number];

export interface PackGithubAccessStatus {
  configured: boolean;
  source: PackGithubAccessSource;
}

/** `POST /api/packs/github-access` body. The CLI reads the token from stdin, never argv. */
export interface PackGithubAccessSetRequest {
  token: string;
}

export const PACK_GITHUB_ACCESS_ERROR_CODES = [
  'BAD_REQUEST',
  /** Not a GitHub token shape. The response never repeats the input. */
  'INVALID_TOKEN_FORMAT',
  /** The daemon's pack credential folder is not a private directory it owns. */
  'CREDENTIAL_STORE_UNSAFE',
  /** Any other store failure (permissions, disk). Names neither the path nor the token. */
  'CREDENTIAL_STORE_FAILED',
] as const;
export type PackGithubAccessErrorCode = (typeof PACK_GITHUB_ACCESS_ERROR_CODES)[number];

/**
 * Strict: a status object with any other key (a `token`, a `tail`) is refused,
 * so a daemon that started echoing the token would fail its clients loudly.
 * `configured` must agree with `source`.
 */
export const PackGithubAccessStatusSchema = z
  .object({
    configured: z.boolean(),
    source: z.enum(PACK_GITHUB_ACCESS_SOURCES),
  })
  .strict()
  .refine((status) => status.configured === (status.source !== 'none'), 'configured must agree with source');

/** Parse a `PackGithubAccessStatus` response body; `null` when it is not one. */
export function parsePackGithubAccessStatus(value: unknown): PackGithubAccessStatus | null {
  const result = PackGithubAccessStatusSchema.safeParse(value);
  return result.success ? result.data : null;
}
