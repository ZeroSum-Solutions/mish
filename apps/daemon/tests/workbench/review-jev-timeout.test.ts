import { describe, expect, it, vi } from 'vitest';
import { createJevReviewer, JEV_MAX_QUESTIONS } from '../../src/workbench/review/reviewers/jev.js';
import type { ReviewerInput } from '../../src/workbench/review/reviewers/types.js';

const inputFor = (count: number): ReviewerInput => ({
  projectId: 'p', runId: 'rr_1', entry: 'index.html', styleDirection: null,
  checks: Array.from({ length: count }, (_, index) => ({
    checkId: `check-${index}`, kind: 'judgment', criterion: 'The footer has a contact link',
    mechanicalOutcome: null, mechanicalReason: null, evidenceIds: [],
  })),
  evidence: [], screenshots: [],
});
const fetchImpl = (async () => new Response(JSON.stringify({ answers: { check_0: { noul: 0.9 } } }))) as typeof fetch;

describe('Jev review batch timeout', () => {
  it.each([[1, 15_000], [2, 30_000], [JEV_MAX_QUESTIONS, 60_000], [JEV_MAX_QUESTIONS + 5, 60_000]])(
    'budgets %i checks with a %i ms default capped at 60 seconds', async (count, timeoutMs) => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      try {
        await createJevReviewer({ apiKey: async () => 'test-key', fetchImpl }).review(inputFor(count), new AbortController().signal);
        expect(timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs);
      } finally { timeout.mockRestore(); }
    },
  );

  it('budgets only asked checks and preserves an explicit timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const input = inputFor(2);
      input.checks[1]!.copy = true;
      await createJevReviewer({ apiKey: async () => 'test-key', fetchImpl }).review(input, new AbortController().signal);
      expect(timeout).toHaveBeenLastCalledWith(15_000);
      await createJevReviewer({ apiKey: async () => 'test-key', fetchImpl, timeoutMs: 1234 }).review(input, new AbortController().signal);
      expect(timeout).toHaveBeenLastCalledWith(1234);
    } finally { timeout.mockRestore(); }
  });
});
