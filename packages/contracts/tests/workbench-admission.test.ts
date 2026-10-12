import { expect, it } from 'vitest';
import { parseSessionExecutionChoice, parseSessionRunAdmission, parseSessionReplayNotice } from '../src/api/workbench-admission.js';
const facts = { version: 1, runId: 'run', sessionId: 'session', projectId: 'project', cursorSequence: 1, previousRunId: null, admittedAt: 1, selectionSource: 'session', selectionRevision: 1, requested: { agentId: 'codex', modelId: 'default' }, effectiveModel: 'GPT 6', reasoning: null, serviceTier: null, forceFresh: false, sourceRunId: null, replayNotice: null, routeBudget: null };
it('accepts bounded public execution facts and rejects private/forged extensions', () => {
  expect(parseSessionRunAdmission(facts)).toEqual(facts);
  for (const extra of [{ nativeSessionId: 'private' }, { apiKey: 'key' }, { requestBody: {} }]) expect(() => parseSessionRunAdmission({ ...facts, ...extra })).toThrow();
  for (const runId of ['../path', 'x\nsecret', 'x'.repeat(201)]) expect(() => parseSessionRunAdmission({ ...facts, runId })).toThrow();
  expect(() => parseSessionExecutionChoice({ kind: 'legacy-run-only', agentId: 'byok-opencode', modelId: 'raw', protocol: 'openai', nonce: '00000000-0000-4000-8000-000000000000', baseUrl: 'https://user:secret@example.com' })).toThrow();
});
it('bounds host notice ranges and refuses token-proof claims or raw handles', () => {
  const notice = { version: 1, reason: 'model-switch', from: null, to: { choice: facts.requested, effectiveModel: 'GPT 6' }, selectionSource: 'session', selectionRevision: 1, sourceRunId: null, includedMessages: 2, omittedMessages: 1, omittedRanges: [{ first: 1, last: 1 }], mandatoryTruncation: { brief: false, anchor: false, context: false }, attachmentCount: 0, digest: 'a'.repeat(64), bytes: 100, byteLimit: 16000, omittedBytes: 0, actualReplayTokens: null, estimatedReplayTokens: 34, estimatedTokenAllowance: null, tokenEstimateMethod: 'utf8_bytes_div_3_ceil_v1', remainingBudgetConfidence: 'unverified', budgetConfidence: 'byte-bound-only', status: 'unchanged' };
  expect(parseSessionReplayNotice(notice)).toEqual(notice);
  for (const extra of [{ bytes: 16001 }, { actualReplayTokens: 34 }, { remainingBudgetConfidence: 'verified' }, { nativeSessionId: 'private' }, { omittedRanges: Array.from({ length: 3 }, () => ({ first: 1, last: 1 })) }]) expect(() => parseSessionReplayNotice({ ...notice, ...extra })).toThrow();
});
