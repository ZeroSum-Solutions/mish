import { describe, expect, it, vi } from 'vitest';
import {
  createInternalRunCreationService, type InternalPhysicalRun, type InternalRunAdmission, type InternalRunCreateInput, type InternalRunRegistry,
} from '../../src/services/internal-run-service.js';
import { PlacementCoordinationError } from '../../src/workbench/placement/write-coordinator.js';

interface TestRun extends InternalPhysicalRun { projectId?: string }
function harness(options: { guard?: (projectId: string | undefined) => void; lifetime?: { admit: () => Promise<InternalRunAdmission> } } = {}) {
  const order: string[] = [];
  const run: TestRun = { id: 'run-1', status: 'queued', projectId: 'p1' };
  const runs: InternalRunRegistry<InternalRunCreateInput, TestRun> = {
    createOrReuse: vi.fn(() => { order.push('allocate'); return { kind: 'created' as const, run }; }),
    prepareRestart: vi.fn(() => run), get: vi.fn(() => null), drop: vi.fn(() => { order.push('drop'); }),
    start: vi.fn((started: TestRun, starter: () => Promise<unknown>) => { order.push('registry-start'); void starter(); return started; }),
    isTerminal: vi.fn(() => false),
  };
  const service = createInternalRunCreationService({
    runs, claimAssistantMessage: vi.fn(() => ({ ok: true })), analyticsLifecycle: { install: vi.fn() },
    ...(options.guard ? { assertMutationAdmissible: (projectId: string | undefined) => { order.push(`guard:${projectId}`); options.guard!(projectId); } } : {}),
    ...(options.lifetime ? { runLifetime: options.lifetime } : {}),
  });
  return { service, run, order };
}

describe('internal run choke point placement injection', () => {
  it('ordinary mode (no lifetime) prepares and starts exactly as before with a null admission', async () => {
    const { service, run, order } = harness();
    const { prepared, admission } = await service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    expect(prepared).toMatchObject({ kind: 'ready', run }); expect(admission).toBeNull();
    expect(await service.admitDeferred({ projectIds: ['p1'] })).toBeNull();
    const starter = vi.fn(async () => undefined);
    expect(await service.startAdmitted(run, { requestAnalyticsContext: null } as never, starter, null)).toBe(run);
    expect(starter).toHaveBeenCalledTimes(1); expect(order).toEqual(['allocate', 'registry-start']);
  });
  it('a placement fence refuses before allocation and before start, without a physical run', () => {
    const fence = (projectId: string | undefined) => { if (projectId === 'p1') throw new PlacementCoordinationError('PROJECT_RECOVERING', 'fenced'); };
    const { service, run, order } = harness({ guard: fence });
    expect(() => service.prepare({ meta: { projectId: 'p1' } })).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    expect(() => service.start(run, { requestAnalyticsContext: null } as never, async () => undefined)).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    expect(order).toEqual(['guard:p1', 'guard:p1']);
    expect(() => service.prepare({ meta: { projectId: 'p2' } })).not.toThrow();
  });
  it('a refused frozen-scope start cancels and finishes the admission before any starter runs', async () => {
    const admission: InternalRunAdmission = { allocate: async work => work(), start: vi.fn(async () => { throw new PlacementCoordinationError('RUN_SCOPE_CHANGED', 'changed'); }), cancel: vi.fn(), finish: vi.fn(async () => undefined) };
    const { service, run } = harness({ lifetime: { admit: async () => admission } });
    const starter = vi.fn(async () => undefined);
    await expect(service.startAdmitted(run, { requestAnalyticsContext: null } as never, starter, admission)).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    expect(starter).not.toHaveBeenCalled(); expect(admission.cancel).toHaveBeenCalled(); expect(admission.finish).toHaveBeenCalled();
  });
  it('a non-ready preparation releases its admission', async () => {
    const admission: InternalRunAdmission = { allocate: async work => work(), start: vi.fn(), cancel: vi.fn(), finish: vi.fn(async () => undefined) };
    const order: string[] = [];
    const run: TestRun = { id: 'run-1', status: 'queued' };
    const service = createInternalRunCreationService({
      runs: { createOrReuse: () => ({ kind: 'conflict' as const, run }), prepareRestart: () => run, get: () => null, drop: () => { order.push('drop'); }, start: r => r, isTerminal: () => false },
      claimAssistantMessage: () => ({ ok: true }), analyticsLifecycle: { install: () => undefined }, runLifetime: { admit: async () => admission },
    });
    const result = await service.admitAndPrepare({ meta: {} }, { projectIds: [] });
    expect(result).toEqual({ prepared: { kind: 'idempotency_conflict', run }, admission: null });
    expect(admission.finish).toHaveBeenCalledTimes(1);
  });
  it('keeps an admitted run open after starter setup until its physical lifecycle settles', async () => {
    const admission: InternalRunAdmission = {
      allocate: async work => work(), start: vi.fn(async () => undefined),
      cancel: vi.fn(), finish: vi.fn(async () => undefined),
    };
    const { service, run } = harness({ lifetime: { admit: async () => admission } });
    const { prepared } = await service.admitAndPrepare(
      { meta: { projectId: 'p1' } }, { projectIds: ['p1'] },
    );
    expect(prepared.kind).toBe('ready');
    await service.startAdmitted(
      run, { requestAnalyticsContext: null } as never,
      async () => undefined, admission,
    );
    await Promise.resolve();
    expect(admission.finish).not.toHaveBeenCalled();
  });
  it('holds allocation behind admission and reserves final work before the starter', async () => {
    const order: string[] = [];
    const admission: InternalRunAdmission = {
      allocate: async work => { order.push('admitted-allocation'); return work(); },
      start: async () => { order.push('frozen-start'); },
      cancel: vi.fn(), finish: vi.fn(async () => undefined),
    };
    const { service, run } = harness({ lifetime: { admit: async () => { order.push('admit'); return admission; } } });
    const outcome = await service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    expect(outcome.prepared.kind).toBe('ready');
    await service.startAdmitted(
      run, { requestAnalyticsContext: null } as never,
      async () => { order.push('starter'); }, admission, undefined,
      () => { order.push('final-reserved'); },
    );
    expect(order).toEqual(['admit', 'admitted-allocation', 'frozen-start', 'final-reserved', 'starter']);
  });
});
