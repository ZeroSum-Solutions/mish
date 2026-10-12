// Owner-identity env scrub shared by every daemon spawn of an agent CLI.
// Kept import-free so runtime defs and CLI helpers can use it without cycles.

/**
 * Env var names that can carry the machine owner's real-world identity
 * (name/email) into an agent child process. Agent children act on
 * natural-language instructions and can embed any ambient env value into an
 * outbound network request — e.g. a "contact" field in a download
 * User-Agent — without the user ever seeing or approving it.
 *
 * This caused a real privacy incident (audit finding J1-01): a Claude Code
 * child spawned by the daemon downloaded Wikimedia Commons photos and put
 * the owner's account email in the request, because the daemon's own
 * process env (inherited from the owner's login shell, where `EMAIL` /
 * `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` are commonly exported for git's
 * own benefit) was spread wholesale into the child via `baseEnv`.
 *
 * This denylist complements the inherited-name allowlist in inherited-env.ts.
 * It also applies after explicit profile/Settings overrides, so those cannot
 * reintroduce owner identity. Other integration-specific names are supported
 * through deliberate configuration rather than arbitrary ambient inheritance.
 * Do not match /email/i: explicit integrations can need email-named variables.
 *
 * `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_ACCOUNT_UUID` and
 * `CLAUDE_CODE_ORGANIZATION_UUID` are the owner's Claude account identity,
 * which Claude Code exports into the daemon's env when the daemon is started
 * from a Claude Code session (J1-01 reopen, 2026-10-10).
 */
export const IDENTITY_ENV_DENYLIST: readonly string[] = [
  'EMAIL',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_COMMITTER_NAME',
  'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
];

/**
 * Returns a copy of `env` without any `IDENTITY_ENV_DENYLIST` name (matched
 * case-insensitively). Use it for every agent CLI spawn that does not go
 * through `spawnEnvForAgent`, such as version probes and `codex mcp` calls.
 */
export function withoutIdentityEnv<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env };
  stripIdentityEnvInPlace(copy);
  return copy;
}

/** Deletes every `IDENTITY_ENV_DENYLIST` name from `env`, case-insensitively. */
export function stripIdentityEnvInPlace(env: Record<string, string | undefined>): void {
  const denied = new Set(IDENTITY_ENV_DENYLIST.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (denied.has(key.toUpperCase())) delete env[key];
  }
}
