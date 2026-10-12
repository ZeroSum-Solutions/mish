import { parseSessionRunAdmission, type SessionRunAdmission, type SessionExecutionChoice } from '@mish/contracts';
/** Accept only a host snapshot belonging to this physical run and known scope. */
export function readSessionRunAdmission(input: unknown, expected: { runId?: string; projectId?: string | null; sessionId?: string | null }): SessionRunAdmission | null {
  try {
    const admission = parseSessionRunAdmission(input);
    if ((expected.runId && admission.runId !== expected.runId) || (expected.projectId && admission.projectId !== expected.projectId) || (expected.sessionId && admission.sessionId !== expected.sessionId)) return null;
    return admission;
  } catch { return null; }
}
/** Display public requested identities only; private resume handles never enter this DTO. */
export function sessionExecutionLabel(choice: SessionExecutionChoice): string {
  const binding = 'byokBinding' in choice ? choice.byokBinding : undefined;
  return `${choice.agentId} · ${choice.modelId}${binding ? ` · ${binding.protocol} · ${binding.baseUrl}` : ''}`;
}
