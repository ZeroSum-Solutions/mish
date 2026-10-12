/**
 * Resolves the fast lane CLI's Jev verification flags into one effective mode, and decides
 * whether that mode needs a resolvable Jev credential before any model call. Pure and
 * CLI-independent so the policy is testable without spawning the process or reading a real
 * credential; `src/cli-args.ts` is the only caller.
 *
 * The default for a build is now `strict` (Devin, the fast-lane-strict-default play): a build
 * verifies every factual slot with Jev and fails closed on anything left `remaining`, `oversized`
 * or `skipped`, with no flag required. `--route-only` never builds, so the mode it resolves to is
 * moot; it is reported as `off` rather than left undefined so every caller gets a concrete mode.
 *
 * One release of compatibility for the flags this replaces: `--verify jev --verify-strict` still
 * means strict; `--verify jev` alone still means the old default, advisory, so an exploratory
 * script that never asked for strict keeps behaving exactly as it did before this play.
 *
 * `after` (the verify-after-render play): the check still runs, but never blocks publishing and
 * runs AFTER the page is published rather than before — see `run.ts`'s `verifyAfterPublish`
 * option and its `preview` event. It is requested only through `--verify-mode after`; there is no
 * legacy spelling for it, so the `--verify-strict` conflict check below (which already compares
 * against every `verifyMode` but `strict`) covers it for free.
 */

export type VerifyMode = 'strict' | 'advisory' | 'after' | 'off';

export type VerifyPolicyInput = {
  /** `--verify-mode`, already parsed to one of the four values, or omitted (flag not passed). */
  verifyMode?: VerifyMode;
  /** `--verify jev` was passed. `--verify` accepts no other value; the CLI validates that itself. */
  legacyVerifyJev: boolean;
  /** `--verify-strict` was passed. */
  legacyVerifyStrict: boolean;
  /** `--route-only` (implies `--family auto`) never builds, so no verify mode ever applies. */
  routeOnly: boolean;
};

export type VerifyPolicyResult = { mode: VerifyMode } | { error: string };

export function resolveVerifyPolicy(input: VerifyPolicyInput): VerifyPolicyResult {
  if (input.routeOnly) return { mode: 'off' };
  if (input.legacyVerifyStrict && input.verifyMode !== undefined && input.verifyMode !== 'strict') {
    return { error: `--verify-strict conflicts with --verify-mode ${input.verifyMode}: drop --verify-strict or pass --verify-mode strict` };
  }
  if (input.verifyMode !== undefined) return { mode: input.verifyMode };
  if (input.legacyVerifyJev) return { mode: input.legacyVerifyStrict ? 'strict' : 'advisory' };
  return { mode: 'strict' };
}

/** Whether `mode` needs a resolvable Jev credential before any model call. Only `off` does not. */
export function requiresJevCredential(mode: VerifyMode): boolean {
  return mode !== 'off';
}

export type CredentialPreflightResult = { ok: true } | { ok: false; error: string };

/**
 * Confirms a Jev credential can be resolved before any model work runs, for `strict` and
 * `advisory` alike — a run that asked to be checked, even advisorily, is entitled to learn its
 * credential is broken before spending the model call that check would grade, not after. `off`
 * needs no credential and is never checked. `resolveKey` is awaited and its result discarded
 * either way; the key itself is never returned, logged, or otherwise exposed by this function.
 */
export async function preflightJevCredential(mode: VerifyMode, resolveKey: () => Promise<string>): Promise<CredentialPreflightResult> {
  if (!requiresJevCredential(mode)) return { ok: true };
  try {
    await resolveKey();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `--verify-mode ${mode} needs a Jev credential, but it could not be resolved: ${reason}` };
  }
}

/** The environment variable the credential resolver below checks first. */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

/**
 * Resolves the Jev (TypeSafe) API key: `TYPESAFE_API_KEY` in the environment first, then the
 * local vault. This mirrors the resolution order the daemon's own Jev credential now uses
 * (`apps/daemon/src/agency-config.ts`: environment, then a daemon-stored key, then the vault) —
 * an operator can keep the key out of the vault entirely, or override it per invocation. The fast
 * lane CLI has no daemon-stored key of its own (it never runs inside the daemon process), so it
 * stops at two steps rather than three.
 *
 * `env` and `readVaultSecret` are both taken as arguments rather than read directly, so this stays
 * a pure-enough function the policy tests can exercise without a real environment or a real vault
 * read: pass a plain object for `env` and a resolver that succeeds, fails, or counts its calls.
 */
export function createJevCredentialResolver(env: Readonly<Record<string, string | undefined>>, readVaultSecret: () => Promise<string>): () => Promise<string> {
  return async () => {
    const fromEnv = env[TYPESAFE_API_KEY_ENV];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
    return readVaultSecret();
  };
}
