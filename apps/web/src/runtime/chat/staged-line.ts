/**
 * The one-line stage indicator of a staged-drafting turn, as a pure function of
 * the run's `staged` record (from `GET /api/runs/:id`). The component only draws.
 */
import type { StagedFallbackReason, StagedRunRecord, StagedStopReason } from '@mish/contracts';

const MODEL_LABELS: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
};

export function stagedModelLabel(model: string | null | undefined): string {
  if (!model) return '';
  return MODEL_LABELS[model] ?? model;
}

export type StagedLineState =
  | { kind: 'drafting'; model: string; active: true }
  | { kind: 'finishing'; model: string; active: true }
  | { kind: 'done'; draftModel: string; finishModel: string; active: false }
  | { kind: 'fallback'; reason: StagedFallbackReason; model: string; active: boolean }
  | { kind: 'interrupted'; model: string; active: false }
  | { kind: 'stopped'; reason: Exclude<StagedStopReason, 'canceled'>; active: false };

export function stagedLineState(record: StagedRunRecord | null | undefined): StagedLineState | null {
  if (!record) return null;
  const draft = record.stages.find((s) => s.stage === 'draft');
  const finish = record.stages.find((s) => s.stage === 'finish');
  const single = record.stages.find((s) => s.stage === 'single');
  if (record.interrupted && finish) {
    return { kind: 'interrupted', model: stagedModelLabel(finish.model), active: false };
  }
  if (record.stopped) {
    // A user Stop needs no explanation; the other two end a chain on purpose.
    if (record.stopped.reason === 'canceled') return null;
    return { kind: 'stopped', reason: record.stopped.reason, active: false };
  }
  if (record.fallback && (single || draft)) {
    const stage = single ?? draft!;
    const running = single ? single.status === 'pending' || single.status === 'running' : false;
    return { kind: 'fallback', reason: record.fallback.reason, model: stagedModelLabel(stage.model), active: running };
  }
  if (!draft || !finish) return null;
  if (draft.status === 'pending' || draft.status === 'running') {
    return { kind: 'drafting', model: stagedModelLabel(draft.model), active: true };
  }
  if (draft.status !== 'succeeded') return null;
  if (finish.status === 'pending' || finish.status === 'running') {
    return { kind: 'finishing', model: stagedModelLabel(finish.model), active: true };
  }
  if (finish.status === 'succeeded') {
    return { kind: 'done', draftModel: stagedModelLabel(draft.model), finishModel: stagedModelLabel(finish.model), active: false };
  }
  return null;
}
