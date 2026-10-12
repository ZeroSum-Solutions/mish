import { describe, expect, it } from 'vitest';
import type { StagedRunRecord, StagedStageRecord } from '@mish/contracts';

import { stagedLineState, stagedModelLabel } from '../../../src/runtime/chat/staged-line';

const stage = (over: Partial<StagedStageRecord>): StagedStageRecord => ({
  stage: 'draft', runId: 'r', agentId: 'claude', model: 'claude-haiku-5-5',
  status: 'pending', startedAt: null, endedAt: null, durationMs: null, ...over,
});
const record = (stages: StagedStageRecord[], extra: Partial<StagedRunRecord> = {}): StagedRunRecord =>
  ({ stages, fallback: null, ...extra });

describe('stagedModelLabel', () => {
  it('shortens known Claude ids and passes others through', () => {
    expect(stagedModelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(stagedModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(stagedModelLabel('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(stagedModelLabel(null)).toBe('');
  });
});

describe('stagedLineState', () => {
  const finish = (over: Partial<StagedStageRecord>) => stage({ stage: 'finish', model: 'claude-opus-5-5', ...over });

  it('says Drafting with X while the draft runs', () => {
    expect(stagedLineState(record([stage({ status: 'running' }), finish({})])))
      .toEqual({ kind: 'drafting', model: 'Haiku 5.5', active: true });
  });
  it('says Finishing with Y once the draft is done', () => {
    expect(stagedLineState(record([stage({ status: 'succeeded' }), finish({ status: 'running' })])))
      .toEqual({ kind: 'finishing', model: 'Opus 5.5', active: true });
    expect(stagedLineState(record([stage({ status: 'succeeded' }), finish({ status: 'pending' })])))
      .toEqual({ kind: 'finishing', model: 'Opus 5.5', active: true });
  });
  it('summarises a finished turn', () => {
    expect(stagedLineState(record([stage({ status: 'succeeded' }), finish({ status: 'succeeded' })])))
      .toEqual({ kind: 'done', draftModel: 'Haiku 5.5', finishModel: 'Opus 5.5', active: false });
  });
  it('reports a fallback with its reason', () => {
    const r = record([stage({ stage: 'single', model: 'claude-opus-5-5', status: 'running' })], {
      fallback: { reason: 'draft_failed', message: 'x' },
    });
    expect(stagedLineState(r)).toEqual({ kind: 'fallback', reason: 'draft_failed', model: 'Opus 5.5', active: true });
  });
  it('reports an interrupted finishing pass', () => {
    const r = record([stage({ status: 'succeeded' }), finish({ status: 'interrupted' })], { interrupted: { message: 'm' } });
    expect(stagedLineState(r)).toEqual({ kind: 'interrupted', model: 'Opus 5.5', active: false });
  });
  it('shows nothing for a canceled or absent record', () => {
    expect(stagedLineState(undefined)).toBeNull();
    expect(stagedLineState(record([stage({ status: 'canceled' }), finish({ status: 'skipped' })]))).toBeNull();
  });

  it('reports a chain that ended at a question or was superseded; a user Stop shows nothing', () => {
    const base = [stage({ status: 'succeeded' }), finish({ status: 'skipped' })];
    expect(stagedLineState(record(base, { stopped: { reason: 'question_form', message: 'm' } })))
      .toEqual({ kind: 'stopped', reason: 'question_form', active: false });
    expect(stagedLineState(record(base, { stopped: { reason: 'superseded', message: 'm' } })))
      .toEqual({ kind: 'stopped', reason: 'superseded', active: false });
    expect(stagedLineState(record(base, { stopped: { reason: 'canceled', message: 'm' } }))).toBeNull();
  });
});
