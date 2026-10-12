// Onboarding's step-0 landing (EntryShell's `OnboardingView`) decides which
// action is the primary, first, visually emphasized call to action: sign in
// to the hosted AMR ("Vela") cloud agent, or continue with a local agent CLI
// the daemon already detected (Claude, Codex, ...).
//
// This fork is local-first, so a usable local agent must win that slot. AMR
// stays reachable as a secondary option in every case — this module only
// decides ordering and emphasis, never removal.

/**
 * The minimal agent shape this decision needs. Callers pass the daemon's
 * full `AgentInfo[]`; this only reads `id`, `available`, and `authStatus`.
 */
export interface OnboardingAgentCandidate {
  id: string;
  available: boolean;
  /** Mirrors `AgentInfo.authStatus` (packages/contracts/src/api/registry.ts). */
  authStatus?: 'ok' | 'missing' | 'unknown';
}

/** The hosted AMR ("Vela") cloud agent's fixed id, excluded from "local". */
const AMR_AGENT_ID = 'amr';

/**
 * Invariant: onboarding's step-0 primary CTA is the detected local agent
 * whenever the daemon reports at least one non-AMR agent as `available` AND
 * not known to be missing auth (detected AND usable now, not merely a
 * setup-required candidate or one whose CLI is installed but not signed in).
 * `authStatus` of `'unknown'` or `undefined` still counts as usable — only a
 * confirmed `'missing'` excludes an agent. Otherwise the primary CTA stays
 * AMR sign-in — this fork's existing fallback identity path, unchanged.
 */
export function shouldPromoteLocalAgentOnboarding(
  agents: readonly OnboardingAgentCandidate[],
): boolean {
  return agents.some(
    (agent) =>
      agent.id !== AMR_AGENT_ID && agent.available && agent.authStatus !== 'missing',
  );
}

/**
 * Invariant: local-agent promotion applies only to onboarding's genuine
 * first run. A saved `agentId` of `'amr'` means a previous session already
 * chose the hosted cloud agent, and landing back on this screen means that
 * identity needs re-authentication (a signed-out session, a rejected
 * credential — see `requiresAmrReauthentication` in
 * `entry-rail-account-state.ts`), not a fresh install. AMR sign-in must stay
 * the primary action there, or a re-auth flow would swap the very button the
 * user is being sent back to use. Any other saved `agentId`, including none,
 * still runs local-agent detection normally.
 */
export function isFirstRunOnboarding(savedAgentId: string | null | undefined): boolean {
  return savedAgentId !== AMR_AGENT_ID;
}
