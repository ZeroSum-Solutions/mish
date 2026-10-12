import { sessionModelChoicesEqual, type SessionModelChoice } from '@mish/contracts';

/**
 * AC-R02.3 invariant for a send-time model/attachment preflight: a
 * preflight result only ever speaks for the exact choice
 * (`agentId`/`modelId`/`byokBinding`) it was computed against. If the
 * session's selected model has changed again by the time the result comes
 * back — the user switched models while the request was in flight — the
 * result is stale: it must never gate (accept OR reject) a send that is
 * about to go out with a *different* model. The caller should discard it
 * and either re-run the check against the live choice or ask the user to
 * resend.
 *
 * There is deliberately no "restore the last usable choice" recovery here
 * any more. The select-time gate in `use-session-model.ts` now means a
 * saved session choice has always already passed a capability preflight,
 * so a send-time rejection never needs to undo a persisted selection — it
 * leaves the model choice untouched and only reports the mismatch (see
 * `ProjectView.tsx`/`DesignSystemFlow.tsx`'s `handleSend`/
 * `sendProjectChatMessage`).
 */

/** The subset of `SessionModelChoice` that identifies which model/binding a
 *  preflight call actually checked. */
export type ModelPreflightChoiceIdentity = Pick<SessionModelChoice, 'agentId' | 'modelId' | 'byokBinding'>;

/** Exact-binding equality for two choices, used to tell whether a preflight
 *  result still describes the model that is currently selected. A thin
 *  re-export of the contracts-level `sessionModelChoicesEqual` (which
 *  already compares `byokBinding` structurally via
 *  `sessionByokBindingsEqual`) so callers have one place to import from for
 *  this comparison. */
export function modelPreflightChoicesEqual(
  a: ModelPreflightChoiceIdentity | null | undefined,
  b: ModelPreflightChoiceIdentity | null | undefined,
): boolean {
  return sessionModelChoicesEqual((a ?? null) as SessionModelChoice | null, (b ?? null) as SessionModelChoice | null);
}
