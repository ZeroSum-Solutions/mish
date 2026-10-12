import type { AgencyBuildCompositionResult } from '@mish/contracts';

type Receipt = NonNullable<AgencyBuildCompositionResult['supportGate']>;
const probability = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const SKIPS: readonly string[] = ['jev-unreachable', 'jev-timeout', 'jev-unauthorized', 'jev-rate-limited', 'jev-http-error', 'jev-bad-answer', 'invalid-plan'];
const DECISIONS: readonly string[] = ['below-threshold', 'supported', 'capacity', 'faq-brief-signal', 'faq-no-brief-signal'];

/** Explicit public projection: provider prose and extra fields never enter API history or SSE. */
export function publicBlockSupport(receipt: Receipt, publicId: (id: string) => string): Receipt | undefined {
  if (!probability(receipt.threshold)) return undefined;
  return {
    threshold: receipt.threshold,
    added: receipt.added.filter((row) => ['jev-brief-support', 'faq-brief-signal'].includes(row.reason)).map((row) => ({
      kind: row.kind, id: publicId(row.id), reason: row.reason, ...(probability(row.probability) ? { probability: row.probability } : {}),
    })),
    removed: receipt.removed.filter((row) => row.kind === 'faq' && row.reason === 'faq-no-brief-signal').map((row) => ({ kind: row.kind, id: publicId(row.id), reason: row.reason })),
    decisions: receipt.decisions.filter((row) => DECISIONS.includes(row.reason)).map((row) => ({ kind: row.kind, reason: row.reason, ...(probability(row.probability) ? { probability: row.probability } : {}) })),
    ...(receipt.skipped && SKIPS.includes(receipt.skipped) ? { skipped: receipt.skipped } : {}),
  };
}

/** Only finite attempt counts and timings cross the API boundary. */
export function publicBlockPlanner(receipt: AgencyBuildCompositionResult['planner']): AgencyBuildCompositionResult['planner'] {
  if (!receipt || !Number.isSafeInteger(receipt.calls) || receipt.calls < 0 || !Number.isFinite(receipt.ms) || receipt.ms < 0) return undefined;
  return { calls: receipt.calls, ms: receipt.ms };
}
