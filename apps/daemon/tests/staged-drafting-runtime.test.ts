import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStagedChainStore } from '../src/staged-chain-store.js';
import { createStagedChain } from '../src/staged-routing.js';
import { createStagedDrafting, type StagedRunLike } from '../src/routes/staged-drafting-runtime.js';
import { prepareModelAdmission } from '../src/workbench/prepare-model.js';
import { __forTestWithoutSensitiveRunInput as sanitize } from '../src/routes/runs.js';
import { createDesignBriefService } from '../src/workbench/brief/service.js';
import { fakeGenerator, modelOutput } from './workbench/design-brief-fixture.js';

vi.mock('../src/workbench/prepare-model.js', () => ({ prepareModelAdmission: vi.fn() }));
const preparation = () => ({ choice: { agentId: 'claude', modelId: 'claude-opus-5-5' }, reasoning: null, serviceTier: null, prepared: null, replayInput: null });
const cleanups: Array<() => void> = [];
afterEach(() => { vi.resetAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'staged-runtime-'));
  const db = new Database(path.join(dir, 'test.sqlite'));
  db.exec("CREATE TABLE session_admission_cursors(conversation_id TEXT, run_id TEXT); INSERT INTO session_admission_cursors VALUES('c', 'draft'); CREATE TABLE session_run_admissions(run_id TEXT, input_json TEXT)");
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = createStagedChainStore(path.join(dir, 'chains'));
  const chain = createStagedChain({ draft: { agentId: 'claude', model: 'claude-haiku-5-5' }, finish: { agentId: 'claude', model: 'claude-opus-5-5' } });
  chain.stages[0] = { ...chain.stages[0]!, status: 'succeeded', runId: 'draft', startedAt: 1 };
  chain.stages[1]!.status = 'interrupted';
  chain.interrupted = { message: 'interrupted' };
  store.save({ draftRunId: 'draft', chain, originalPrompt: 'Make a page', mainBody: { projectId: 'p', conversationId: 'c' }, draftMeta: { projectId: 'p', conversationId: 'c' } });
  const started: Array<{ run: StagedRunLike; meta: Record<string, unknown> }> = [];
  const deps = {
    db, dataDir: dir, projectsRoot: dir, store,
    getAgentDef: () => null,
    readConfig: async () => ({ stagedDrafting: true }),
    detectAgents: async () => [{ id: 'claude', available: true }],
    runs: { get: (_id: string): StagedRunLike | null => null, wait: async (_run: StagedRunLike) => ({ status: 'succeeded' }), fail: vi.fn(), cancel: vi.fn() },
    endedWithQuestion: () => false,
    internalRuns: {
      prepare: vi.fn(({ meta }: { meta: Record<string, unknown> }) => ({ kind: 'ready', run: { id: 'finish', status: 'queued', meta } })),
      start: vi.fn((run: StagedRunLike, _analytics: never, starter: (run: StagedRunLike) => Promise<unknown>) => { void starter(run); return run; }),
    },
    startChatRun: vi.fn(async (meta: Record<string, unknown>, run: StagedRunLike) => { started.push({ run, meta }); }),
    sanitize: (value: Record<string, unknown>) => JSON.parse(JSON.stringify(sanitize(value))) as Record<string, unknown>,
  };
  vi.mocked(prepareModelAdmission).mockResolvedValue(preparation() as never);
  return { dir, db, store, deps, started, runtime: createStagedDrafting(deps) };
}

describe('durable staged chain ownership (V07 BLOCK 1 and 2)', () => {
  it.each(['cancel', 'supersede'] as const)('%s during resumed async preparation fences the same chain before allocation', async (action) => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(prepareModelAdmission).mockImplementationOnce(async () => { await gate; return preparation() as never; });
    const finishing = h.runtime.finishNow('draft');
    expect(prepareModelAdmission).toHaveBeenCalledTimes(1);
    if (action === 'cancel') await h.runtime.cancelChain('draft', null);
    else await h.runtime.supersede('c');
    release();
    expect((await finishing).ok).toBe(false);
    expect(h.deps.internalRuns.prepare).not.toHaveBeenCalled();
    expect(h.store.load('draft')!.chain.stopped?.reason).toBe(action === 'cancel' ? 'canceled' : 'superseded');
    expect(h.store.load('draft')!.chain.interrupted ?? null).toBeNull();
  });

  it('a newer request marks an interrupted chain superseded even with an empty process-local registry', async () => {
    const h = harness();
    await h.runtime.supersede('c');
    const restarted = createStagedDrafting(h.deps);
    expect(await restarted.finishNow('draft')).toMatchObject({ ok: false, code: 'SUPERSEDED' });
    expect(h.started).toEqual([]);
    expect(h.store.load('draft')!.chain.stopped?.reason).toBe('superseded');
  });

  it('restart detects a newer admitted turn from the durable conversation cursor, never the run registry', async () => {
    const h = harness();
    h.db.prepare('UPDATE session_admission_cursors SET run_id = ?').run('newer-ordinary-run');
    const restarted = createStagedDrafting(h.deps);
    expect(await restarted.finishNow('draft')).toMatchObject({ ok: false, code: 'SUPERSEDED' });
    expect(h.store.load('draft')!.chain.stopped?.reason).toBe('superseded');
    expect(h.started).toEqual([]);
  });

  it('GET projections refresh after a resumed stage changes the durable record', async () => {
    const h = harness();
    expect(h.runtime.lookup('draft')?.stages[1]?.status).toBe('interrupted');
    expect((await h.runtime.finishNow('draft')).ok).toBe(true);
    await vi.waitFor(() => expect(h.runtime.lookup('draft')?.stages[1]?.status).toBe('succeeded'));
  });

  it('an interrupted child keeps the same projection after its replacement finishes', async () => {
    const h = harness();
    const entry = h.store.load('draft')!;
    entry.chain.stages[1]!.runId = 'old-finish';
    h.store.save(entry);
    expect((await h.runtime.finishNow('old-finish')).ok).toBe(true);
    await vi.waitFor(() => expect(h.runtime.lookup('old-finish')?.stages[1]).toMatchObject({ runId: 'finish', status: 'succeeded' }));
  });

  it('cancels the physical finish and retains its fence when the durable save fails', async () => {
    const h = harness();
    const entry = h.store.load('draft')!;
    entry.chain.interrupted = null;
    entry.chain.stages[1] = { ...entry.chain.stages[1]!, status: 'running', runId: 'finish' };
    h.store.save(entry);
    const run: StagedRunLike = { id: 'finish', status: 'running' };
    h.deps.runs.get = () => run;
    vi.spyOn(h.store, 'save').mockImplementation(() => { throw new Error('storage unavailable'); });
    await expect(h.runtime.cancelChain('draft', 'finish')).rejects.toThrow('storage unavailable');
    expect(h.deps.runs.cancel).toHaveBeenCalledWith(run, 'user_stop');
    expect(h.runtime.lookup('draft')?.stopped?.reason).toBe('canceled');
  });
});

describe('accepted R15 brief across stages (V07 WARN)', () => {
  it('refuses an older brief-bound interrupted chain without its accepted snapshot', async () => {
    const h = harness();
    const entry = h.store.load('draft')!;
    entry.mainBody.brief = { id: 'old-brief', revision: 1, hash: 'old-hash' };
    h.store.save(entry);
    expect(await h.runtime.finishNow('draft')).toMatchObject({ ok: false, code: 'NOT_INTERRUPTED' });
    expect(h.started).toEqual([]);
    expect(h.store.load('draft')!.chain.interrupted).not.toBeNull();
  });

  it.each(['succeeded', 'failed'] as const)('carries the accepted snapshot into the next stage after a %s draft and after restart', async (outcome) => {
    const h = harness();
    const briefs = createDesignBriefService({ dataDir: h.dir, generator: fakeGenerator([JSON.stringify(modelOutput())]) });
    const { id } = await briefs.create({ projectId: 'p', originalText: 'Make a page' }, { principalId: 'local-daemon', projectId: 'p' });
    await briefs.settled(id);
    const brief = (await briefs.patch('p', id, { expectedRevision: 1, accept: true })).brief!;
    const meta = { projectId: 'p', conversationId: 'c', designBrief: brief };
    vi.mocked(prepareModelAdmission).mockResolvedValueOnce({ ...preparation(), choice: { agentId: 'claude', modelId: 'claude-haiku-5-5' } } as never);
    h.deps.runs.wait = async (run?: StagedRunLike) => ({ status: run?.id === 'draft' ? outcome : 'succeeded' });
    const applied = await h.runtime.apply({ meta, requestBody: { projectId: 'p', conversationId: 'c', message: 'Make a page', brief: { id, revision: brief.revision, hash: brief.hash } }, modelPreparation: preparation() as never, draftSupports: () => true, unsupported: false });
    applied.follow!({ id: 'draft', status: outcome });
    await vi.waitFor(() => expect(h.started).toHaveLength(1));
    expect(h.started[0]!.meta.designBrief).toEqual(brief);
    const entry = h.store.load('draft')!;
    entry.chain.stages[1]!.status = 'interrupted';
    entry.chain.interrupted = { message: 'interrupted' };
    h.store.save(entry);
    h.started.length = 0;
    const restarted = createStagedDrafting(h.deps);
    expect((await restarted.finishNow('draft')).ok).toBe(true);
    expect(h.started[0]!.meta.designBrief).toEqual(brief);
  });
});
