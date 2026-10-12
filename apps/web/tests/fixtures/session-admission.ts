import type { SessionRunAdmission } from '@open-design/contracts';
export const admission: SessionRunAdmission = {
  version: 1, runId: 'accepted-run', sessionId: 'actual-seed', projectId: 'actual-project', cursorSequence: 2, previousRunId: 'source-run', admittedAt: 1,
  selectionSource: 'session', selectionRevision: 3, requested: { agentId: 'codex', modelId: 'default' }, effectiveModel: 'codex-effective', reasoning: 'high', serviceTier: null,
  forceFresh: true, sourceRunId: 'source-run', routeBudget: null,
  replayNotice: { version: 1, reason: 'model-switch', from: { choice: { agentId: 'claude', modelId: 'opus' }, effectiveModel: 'opus' }, to: { choice: { agentId: 'codex', modelId: 'default' }, effectiveModel: 'codex-effective' }, selectionSource: 'session', selectionRevision: 3, sourceRunId: 'source-run', includedMessages: 4, omittedMessages: 2, omittedRanges: [{ first: 1, last: 2 }], mandatoryTruncation: { brief: false, anchor: false, context: true }, attachmentCount: 1, digest: 'a'.repeat(64), bytes: 900, byteLimit: 16000, omittedBytes: 300, actualReplayTokens: null, estimatedReplayTokens: 300, estimatedTokenAllowance: 5000, tokenEstimateMethod: 'utf8_bytes_div_3_ceil_v1', remainingBudgetConfidence: 'unverified', budgetConfidence: 'byte-and-estimate-bound', status: 'truncated' },
};
