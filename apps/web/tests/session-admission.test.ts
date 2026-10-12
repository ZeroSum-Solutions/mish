import { expect, it } from 'vitest';
import { readSessionRunAdmission, sessionExecutionLabel } from '../src/runtime/workbench/session-admission';
import { admission } from './fixtures/session-admission';
it('accepts only strict host admission facts in the exact run/project/conversation scope', () => {
  expect(readSessionRunAdmission(admission, { runId: admission.runId, projectId: admission.projectId, sessionId: admission.sessionId })).toEqual(admission);
  expect(readSessionRunAdmission(admission, { runId: 'another-run' })).toBeNull();
  expect(readSessionRunAdmission(admission, { projectId: 'another-project' })).toBeNull();
  expect(readSessionRunAdmission(admission, { sessionId: 'another-seed' })).toBeNull();
  expect(readSessionRunAdmission({ ...admission, nativeHandle: 'fixture-private-handle' }, {})).toBeNull();
  expect(readSessionRunAdmission({ ...admission, replayNotice: { ...admission.replayNotice, actualReplayTokens: 300 } }, {})).toBeNull();
  expect(readSessionRunAdmission(undefined, {})).toBeNull();
});
it('projects only public requested identity for pinned and legacy BYOK choices', () => {
  expect(sessionExecutionLabel({ agentId: 'byok-opencode', modelId: 'raw', byokBinding: { protocol: 'openai', baseUrl: 'https://gateway.example/v1', requiresApiKey: true } })).toBe('byok-opencode · raw · openai · https://gateway.example/v1');
  expect(sessionExecutionLabel({ kind: 'legacy-run-only', agentId: 'byok-opencode', modelId: 'raw', protocol: 'openai', nonce: '11111111-1111-4111-8111-111111111111' })).toBe('byok-opencode · raw');
});
