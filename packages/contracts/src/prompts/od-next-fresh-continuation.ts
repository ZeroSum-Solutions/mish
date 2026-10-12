import { parseOdNextRequestTurnV1, serializeOdNextRequestTurnV1 } from './od-next-prompt-bundle.js';

/** Daemon-owned exception for a NEW locked turn whose source epoch retired. */
export function composeOdNextFreshContinuationV1(input: {
  stageInstruction: string;
  lockedScope: string;
  lockedTaskSnapshot: string;
  lockedPlan: string;
  authorizedSourceInput: string;
  boundedPublicReplay: string;
}): string {
  const turn = parseOdNextRequestTurnV1(input.stageInstruction);
  if (!input.lockedScope.trim() || !input.lockedTaskSnapshot.trim() || typeof input.authorizedSourceInput !== 'string') {
    throw new TypeError('Fresh locked continuation requires its scope, frozen snapshot and authorized source input.');
  }
  // Retain the Turn serializer and stage identity. Text leaves remain CDATA,
  // so caller prose cannot create a second task/stage or escape the XML root.
  return serializeOdNextRequestTurnV1({ ...turn, payload: [
    '# OD Next authorized fresh continuation',
    'The source task crossed a model identity boundary. This is a new private session. Use only the frozen task and public context below. Every in-session reference in the stage instruction refers to this supplied snapshot. Preserve the locked route, stage, agent, task and Plan Contract; do not choose another plan or ask another clarification round.',
    '## Locked scope', input.lockedScope,
    '## Original frozen task snapshot', input.lockedTaskSnapshot,
    '## Frozen Plan Contract', input.lockedPlan || '(not yet accepted)',
    '## Authorized source request or answer', input.authorizedSourceInput,
    '## Bounded public replay', input.boundedPublicReplay,
    '## Authoritative stage instruction', turn.payload,
  ].join('\n\n') });
}
