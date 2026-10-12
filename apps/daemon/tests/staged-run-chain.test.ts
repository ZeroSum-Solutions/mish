import { describe, expect, it, vi } from 'vitest';

import { createStagedChain } from '../src/staged-routing.js';
import { followStagedDraft } from '../src/routes/staged-run-chain.js';

type FakeRun = { id: string; status: string };

function harness(draftOutcome: 'succeeded' | 'failed' | 'canceled') {
  let t = 1000;
  const now = () => (t += 50);
  const started: Array<{ run: FakeRun; label: string }> = [];
  const finals = new Map<string, string>();
  const waiters = new Map<string, (s: { status: string }) => void>();
  const draftRun: FakeRun = { id: 'run-draft', status: 'running' };
  const chain = createStagedChain({
    draft: { agentId: 'claude', model: 'claude-haiku-5-5' },
    finish: { agentId: 'claude', model: 'claude-opus-5-5' },
  });
  const deps = {
    now,
    wait: (run: FakeRun) =>
      new Promise<{ status: string }>((resolve) => {
        waiters.set(run.id, resolve);
        const done = finals.get(run.id);
        if (done) resolve({ status: done });
      }),
    prepareStage: vi.fn(async (kind: 'finish' | 'single') => ({
      meta: { kind },
      analytics: { body: {}, requestAnalyticsContext: null },
    })),
    internalRuns: {
      prepare: vi.fn(({ meta }: { meta: { kind: string } }) => ({
        kind: 'ready' as const,
        run: { id: `run-${meta.kind}`, status: 'queued' } as FakeRun,
      })),
      start: vi.fn((run: FakeRun, _analytics: unknown, starter: (r: FakeRun) => Promise<unknown>) => {
        started.push({ run, label: run.id });
        void starter(run);
        finals.set(run.id, 'succeeded');
        return run;
      }),
    },
    startChatRun: vi.fn(async () => undefined),
  };
  return { chain, deps, draftRun, started, settleDraft: () => {
    waiters.get('run-draft')?.({ status: draftOutcome });
  }, flush: () => new Promise((r) => setTimeout(r, 5)) };
}

describe('followStagedDraft', () => {
  it('keeps the physical terminal status when persisting that status fails', async () => {
    const h = harness('succeeded');
    const onChange = vi.fn(() => {
      if (h.chain.stages.find(stage => stage.stage === 'finish')?.status === 'succeeded') throw new Error('storage unavailable');
    });
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun, onChange });
    h.settleDraft();
    await h.flush();
    expect(h.chain.stages.find(stage => stage.stage === 'finish')?.status).toBe('succeeded');
  });

  it('starts the finishing run on the main model after a good draft', async () => {
    const h = harness('succeeded');
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.deps.prepareStage).toHaveBeenCalledWith('finish');
    expect(h.started.map((s) => s.run.id)).toEqual(['run-finish']);
    const [draft, finish] = h.chain.stages;
    expect(draft).toMatchObject({ stage: 'draft', runId: 'run-draft', status: 'succeeded' });
    expect(draft?.durationMs).toBeGreaterThan(0);
    expect(finish).toMatchObject({ stage: 'finish', runId: 'run-finish' });
    expect(h.chain.fallback).toBeNull();
  });

  it('falls back to one main-model pass when the draft fails, and says so', async () => {
    const h = harness('failed');
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.deps.prepareStage).toHaveBeenCalledWith('single');
    expect(h.started.map((s) => s.run.id)).toEqual(['run-single']);
    expect(h.chain.fallback).toMatchObject({ reason: 'draft_failed' });
    expect(h.chain.stages.find((s) => s.stage === 'draft')?.status).toBe('failed');
    expect(h.chain.stages.some((s) => s.stage === 'single')).toBe(true);
  });

  it('does not start anything when the user cancels the draft', async () => {
    const h = harness('canceled');
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.chain.stages.find((s) => s.stage === 'finish')?.status).toBe('skipped');
  });

  it('marks the finish stage failed when it cannot be prepared', async () => {
    const h = harness('succeeded');
    h.deps.prepareStage.mockRejectedValueOnce(new Error('admission refused'));
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.chain.stages.find((s) => s.stage === 'finish')?.status).toBe('failed');
  });
});

import { buildStagedStageMeta } from '../src/routes/staged-run-chain.js';

describe('buildStagedStageMeta', () => {
  const base = {
    draftMeta: {
      projectId: 'p1',
      conversationId: 'c1',
      agentId: 'claude',
      model: 'claude-haiku-5-5',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      clientRequestId: 'r1',
      analyticsHints: { keep: 1 },
    },
    draftRunId: 'run-draft',
    originalPrompt: 'Make a pricing page',
    main: { agentId: 'claude', model: 'claude-opus-5-5', prepared: { token: 'p' } },
    stagePrompt: 'FINISH: Make a pricing page',
    lineage: { sourceRunId: 'run-draft' },
  };

  it('takes the main model and a prompt and ids of its own', () => {
    const meta = buildStagedStageMeta({ ...base, kind: 'finish' });
    expect(meta).toMatchObject({
      projectId: 'p1',
      conversationId: 'c1',
      agentId: 'claude',
      model: 'claude-opus-5-5',
      message: 'FINISH: Make a pricing page',
      currentPrompt: 'FINISH: Make a pricing page',
      userMessageId: undefined,
      _preparedSessionAdmission: { token: 'p' },
      analyticsHints: { keep: 1, sourceRunId: 'run-draft', stagedStage: 'finish' },
    });
    expect(meta.assistantMessageId).not.toBe('a1');
    expect(meta.clientRequestId).not.toBe('r1');
  });

  it('gives a retried stage (Finish now) fresh ids', () => {
    const first = buildStagedStageMeta({ ...base, kind: 'finish' });
    const retry = buildStagedStageMeta({ ...base, kind: 'finish', previousRunId: 'run-finish' });
    expect(retry.clientRequestId).not.toBe(first.clientRequestId);
    expect(retry.assistantMessageId).not.toBe(first.assistantMessageId);
  });

  it('derives different ids for the finish and fallback stages', () => {
    const a = buildStagedStageMeta({ ...base, kind: 'finish' });
    const b = buildStagedStageMeta({ ...base, kind: 'single' });
    expect(a.assistantMessageId).not.toBe(b.assistantMessageId);
  });
});

import { finishInterruptedChain } from '../src/routes/staged-run-chain.js';

describe('finishInterruptedChain (Finish now)', () => {
  it('starts the finish stage of an interrupted chain and clears the flag', async () => {
    const h = harness('succeeded');
    h.chain.stages[0]!.status = 'succeeded';
    h.chain.stages[1]!.status = 'interrupted';
    h.chain.interrupted = { message: 'Draft only — finishing pass interrupted' };
    const result = await finishInterruptedChain({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    expect(result).toEqual({ ok: true, runId: 'run-finish' });
    expect(h.chain.interrupted).toBeNull();
    expect(h.chain.stages[1]?.runId).toBe('run-finish');
    expect(['running', 'succeeded']).toContain(h.chain.stages[1]?.status);
  });

  it('refuses a chain that is not interrupted', async () => {
    const h = harness('succeeded');
    const result = await finishInterruptedChain({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    expect(result).toMatchObject({ ok: false, code: 'NOT_INTERRUPTED' });
    expect(h.started).toEqual([]);
  });
});


describe('daemon shutdown during the finishing pass', () => {
  it('marks the finish stage interrupted (not canceled) so it can be finished later', async () => {
    const h = harness('succeeded');
    h.deps.wait = (run: { id: string }) =>
      new Promise((resolve) => {
        if (run.id === 'run-draft') setTimeout(() => resolve({ status: 'succeeded' }), 1);
        else setTimeout(() => resolve({ status: 'canceled', cancelOrigin: 'daemon_shutdown' } as never), 5);
      }) as never;
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    await new Promise((r) => setTimeout(r, 40));
    expect(h.chain.stages[1]?.status).toBe('interrupted');
    expect(h.chain.interrupted).toEqual({ message: 'Draft only — finishing pass interrupted' });
  });

  it('keeps a user Stop as canceled', async () => {
    const h = harness('succeeded');
    h.deps.wait = (run: { id: string }) =>
      new Promise((resolve) => {
        if (run.id === 'run-draft') setTimeout(() => resolve({ status: 'succeeded' }), 1);
        else setTimeout(() => resolve({ status: 'canceled', cancelOrigin: 'user_stop' } as never), 5);
      }) as never;
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    await new Promise((r) => setTimeout(r, 40));
    expect(h.chain.stages[1]?.status).toBe('canceled');
    expect(h.chain.interrupted ?? null).toBeNull();
  });
});

import { stopChain } from '../src/routes/staged-run-chain.js';

describe('a draft that ends by asking the user a question', () => {
  it('gets no finishing pass and the chain ends at the question', async () => {
    const h = harness('succeeded');
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun, draftEndedWithQuestion: () => true });
    h.settleDraft();
    await h.flush();
    expect(h.deps.prepareStage).not.toHaveBeenCalled();
    expect(h.started).toEqual([]);
    expect(h.chain.stopped).toMatchObject({ reason: 'question_form' });
    expect(h.chain.stages[1]?.status).toBe('skipped');
  });
});

describe('a newer user turn in the conversation', () => {
  it('drops a pending finish and records it as superseded', async () => {
    const h = harness('succeeded');
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun, newerTurnExists: () => true });
    h.settleDraft();
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.chain.stopped).toMatchObject({ reason: 'superseded' });
    expect(h.chain.stages[1]?.status).toBe('skipped');
  });

  it('drops the finish when the turn arrives while the pass is being prepared', async () => {
    const h = harness('succeeded');
    h.deps.prepareStage.mockImplementationOnce(async () => {
      stopChain(h.chain, 'superseded');
      return { meta: { kind: 'finish' }, analytics: {} } as never;
    });
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.chain.stages[1]?.status).toBe('skipped');
  });

  it('refuses Finish now when a newer turn exists', async () => {
    const h = harness('succeeded');
    h.chain.stages[0]!.status = 'succeeded';
    h.chain.stages[1]!.status = 'interrupted';
    h.chain.interrupted = { message: 'm' };
    const result = await finishInterruptedChain({ ...h.deps, chain: h.chain, draftRun: h.draftRun, newerTurnExists: () => true });
    expect(result).toMatchObject({ ok: false, code: 'SUPERSEDED' });
    expect(h.started).toEqual([]);
  });
});

describe('cancel reaches the whole chain', () => {
  it('stopChain marks the chain canceled, skips the pending finish and returns the running runs', () => {
    const chain = createStagedChain({
      draft: { agentId: 'claude', model: 'claude-haiku-5-5' },
      finish: { agentId: 'claude', model: 'claude-opus-5-5' },
    });
    chain.stages[0]!.status = 'succeeded';
    chain.stages[1]!.status = 'running';
    chain.stages[1]!.runId = 'run-finish';
    expect(stopChain(chain, 'canceled')).toEqual(['run-finish']);
    expect(chain.stopped).toMatchObject({ reason: 'canceled' });
    const pending = createStagedChain({
      draft: { agentId: 'claude', model: 'claude-haiku-5-5' },
      finish: { agentId: 'claude', model: 'claude-opus-5-5' },
    });
    pending.stages[0]!.status = 'running';
    pending.stages[0]!.runId = 'run-draft';
    expect(stopChain(pending, 'canceled')).toEqual(['run-draft']);
    expect(pending.stages[1]?.status).toBe('skipped');
  });

  it('stopChain keeps the first reason', () => {
    const chain = createStagedChain({
      draft: { agentId: 'claude', model: 'a' },
      finish: { agentId: 'claude', model: 'b' },
    });
    stopChain(chain, 'superseded');
    stopChain(chain, 'canceled');
    expect(chain.stopped?.reason).toBe('superseded');
  });

  it('no finish starts when the chain is canceled in the gap between draft and finish', async () => {
    const h = harness('succeeded');
    h.deps.prepareStage.mockImplementationOnce(async () => {
      stopChain(h.chain, 'canceled');
      return { meta: { kind: 'finish' }, analytics: {} } as never;
    });
    followStagedDraft({ ...h.deps, chain: h.chain, draftRun: h.draftRun });
    h.settleDraft();
    await h.flush();
    expect(h.started).toEqual([]);
  });
});
