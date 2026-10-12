import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireRunPlacementPublicationOwner,
  bindRunPlacement,
  createChatRunService,
  reserveRunPlacementPublication,
  runPlacementPublication,
  wasRunPlacementBound,
} from '../../src/runtimes/runs.js';
import { PlacementRunLifetime } from '../../src/workbench/placement/run-lifetime.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementWriteCoordinator } from '../../src/workbench/placement/write-coordinator.js';

/**
 * Selected publication ticket ownership: every starter attempt and every
 * joined background effect owns the reserved ticket; it settles exactly once,
 * only after all owners released AND terminal persistence actually succeeded
 * AND the run event log actually finished. Terminal effects of a ticketed run
 * run inside the ticket's accepted final work with a current guard.
 */
type Options = Parameters<typeof createChatRunService>[0];
// Hook options are untyped (`null` defaults) in the JS registry signature.
type TestOptions = Record<string, unknown>;
function createRuns(options: TestOptions = {}) {
  return createChatRunService({
    createSseResponse: () => ({ send: () => true, end: () => {}, cleanup: () => {} }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
    writeDurableState: () => ({ ok: true }),
    ...options,
  } as unknown as Options);
}
/** Fake reserved final work whose data-root write runs its callback like the coordinator does. */
function fakeTicket(settle: () => void) {
  return {
    kind: 'publication', settle, projectWrite: vi.fn(),
    dataRootWrite: async (work: (guard: { assertCurrent(): void }) => Promise<unknown>) => work({ assertCurrent: () => {} }),
  };
}
function harness(options: TestOptions = {}) {
  const runs = createRuns(options);
  const run = runs.create({ projectId: 'p1', conversationId: 'c1' });
  run.statePath = '/proof/no-write/state.json';
  const settle = vi.fn();
  const admission = {
    reserveFinal: vi.fn(() => fakeTicket(settle)),
    cancel: vi.fn(),
    // Child custody never drains in these cases; finish stays pending.
    finish: vi.fn(() => new Promise<void>(() => {})),
  };
  bindRunPlacement(run, admission);
  reserveRunPlacementPublication(run);
  return { runs, run, settle, admission };
}
/** The registry run object is inferred from JS defaults; tests set its stream fields. */
const loose = (run: unknown) => run as { eventsLogPath: string; eventsLogStream: Writable | null; terminalLifecycle: { terminalPersistence: unknown } };
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

describe('selected run publication owners', () => {
  it('a joined background effect keeps the ticket after the attempt settled and terminal committed', async () => {
    const { runs, run, settle } = harness();
    const attempt = acquireRunPlacementPublicationOwner(run)!;
    const cover = acquireRunPlacementPublicationOwner(run)!;
    attempt();
    runs.finish(run, 'succeeded', 0, null);
    await ticks();
    expect(run.status).toBe('succeeded');
    expect(settle).not.toHaveBeenCalled();
    cover();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(runPlacementPublication(run)).toBeNull();
  });

  it('owners released before terminal commit do not settle; terminal commit then settles once', async () => {
    const { runs, run, settle } = harness();
    // Retry generations reuse one ticket: attempt 1 closes, attempt 2 runs.
    const first = acquireRunPlacementPublicationOwner(run)!;
    first();
    expect(settle).not.toHaveBeenCalled();
    const second = acquireRunPlacementPublicationOwner(run)!;
    second(); second();
    expect(settle).not.toHaveBeenCalled();
    runs.finish(run, 'failed', 1, null);
    await ticks();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('a settled selected run stays recognised as bound, so it never reverts to ordinary publication', async () => {
    const { runs, run } = harness();
    acquireRunPlacementPublicationOwner(run)!();
    runs.finish(run, 'canceled', null, 'SIGTERM');
    await ticks();
    expect(runPlacementPublication(run)).toBeNull();
    expect(acquireRunPlacementPublicationOwner(run)).toBeNull();
    expect(wasRunPlacementBound(run)).toBe(true);
  });

  it('a cancel whose permit already released still completes the remaining cancellation', async () => {
    const { runs, run, admission } = harness();
    admission.cancel.mockImplementation(() => { throw Object.assign(new Error('Permit was released'), { code: 'PERMIT_RELEASED' }); });
    await runs.cancel(run, 'user');
    expect(run.cancelRequested).toBe(true);
    expect(run.status).toBe('canceled');
  });

  it('ordinary runs have no ticket and no owner', () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'p1', conversationId: 'c1' });
    expect(acquireRunPlacementPublicationOwner(run)).toBeNull();
    expect(wasRunPlacementBound(run)).toBe(false);
  });
});

describe('selected terminal commitment boundary (R2/R3)', () => {
  it('R2: the ticket settles only after the run event log actually finished writing', async () => {
    const { runs, run, settle } = harness();
    const pending: Array<() => void> = [];
    let finished = false;
    const stream = new Writable({ write(_chunk, _encoding, done) { pending.push(done); } });
    stream.on('finish', () => { finished = true; });
    loose(run).eventsLogPath = '/proof/no-write/events.jsonl';
    loose(run).eventsLogStream = stream;
    acquireRunPlacementPublicationOwner(run)!();
    runs.finish(run, 'succeeded', 0, null);
    await ticks();
    expect(run.status).toBe('succeeded');
    expect(finished).toBe(false);
    expect(settle).not.toHaveBeenCalled();
    for (const done of pending.splice(0)) done();
    await ticks();
    expect(finished).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('R2: an event log that errors before finishing retains the ticket', async () => {
    const { runs, run, settle } = harness();
    loose(run).eventsLogPath = '/proof/no-write/events.jsonl';
    loose(run).eventsLogStream = new Writable({ write(_chunk, _encoding, done) { done(new Error('EIO: event log write failed')); } });
    acquireRunPlacementPublicationOwner(run)!();
    runs.finish(run, 'succeeded', 0, null);
    await ticks();
    expect(run.status).toBe('succeeded');
    expect(settle).not.toHaveBeenCalled();
  });

  it('R3: failed terminal persistence is not a durable commitment and retains the ticket', async () => {
    let writes = 0;
    const { runs, run, settle } = harness({ writeDurableState: () => { writes += 1; return { ok: false, errorType: 'io_error' }; } });
    acquireRunPlacementPublicationOwner(run)!();
    runs.finish(run, 'succeeded', 0, null);
    await ticks();
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(loose(run).terminalLifecycle.terminalPersistence).toMatchObject({ status: 'failed', errorType: 'io_error' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('ordinary runs keep their terminal behavior on persistence and log failures', async () => {
    const runs = createRuns({ writeDurableState: () => ({ ok: false, errorType: 'io_error' }) });
    const run = runs.create({ projectId: 'p1', conversationId: 'c1' });
    run.statePath = '/proof/no-write/state.json';
    runs.finish(run, 'succeeded', 0, null);
    expect(run.status).toBe('succeeded');
    expect(run.eventsLogStream).toBeNull();
  });
});

describe('selected terminal effects require current authority (R1)', () => {
  async function coordinated(options: TestOptions) {
    const state = { qualified: true };
    const owner = bindPlacementRuntimeOwner({
      canonicalDataRoot: `/proof/r1-${Math.random().toString(36).slice(2)}`,
      inspect: () => ({ held: true, qualified: state.qualified }),
      readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }),
    });
    const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async id => `/proof/projects/${id}` });
    const lifetime = new PlacementRunLifetime({ coordinator, supervisor: {} as never, physicalRoots: ids => ids.map(id => `/proof/projects/${id}`) });
    const admission = await lifetime.admit({ projectIds: ['p1'] });
    const runs = createRuns(options);
    const run = await admission.allocate(async () => runs.create({ projectId: 'p1', conversationId: 'c1' }));
    run.statePath = '/proof/no-write/state.json';
    await admission.start();
    bindRunPlacement(run, admission);
    reserveRunPlacementPublication(run);
    return { state, coordinator, runs, run };
  }

  it('owner loss refuses the terminal commit: no hook, durable write, error event or settlement', async () => {
    const effects: string[] = [];
    const sent: string[] = [];
    const { state, runs, run } = await coordinated({
      beforeFinish: () => { effects.push('beforeFinish'); },
      onTerminal: () => { effects.push('onTerminal'); },
      writeDurableState: () => { effects.push('writeDurableState'); return { ok: true }; },
    });
    run.clients.add({ send: (event: string) => { sent.push(event); return true; }, end: () => {}, cleanup: () => {} });
    const release = acquireRunPlacementPublicationOwner(run)!;
    const eventsBefore = run.events.length;
    state.qualified = false;
    runs.fail(run, 'AGENT_EXECUTION_FAILED', 'child failed after owner loss');
    release();
    await ticks();
    expect(effects).toEqual([]);
    expect(run.status).not.toBe('failed');
    expect(TERMINAL.has(run.status)).toBe(false);
    expect(run.events.length).toBe(eventsBefore);
    // Only a live, non-persisted refusal reaches connected clients.
    expect(sent).toEqual(['error']);
    expect(runPlacementPublication(run)).not.toBeNull();
  });

  it('with current authority the terminal commit runs inside the accepted final work and settles', async () => {
    const effects: string[] = [];
    let coordinatorRef: PlacementWriteCoordinator | null = null;
    const insideAcceptedWrite = () => {
      try { coordinatorRef!.assertOutsideAcceptedWrite(); return false; } catch { return true; }
    };
    const { coordinator, runs, run } = await coordinated({
      beforeFinish: () => { effects.push(`beforeFinish:${insideAcceptedWrite()}`); },
      onTerminal: () => { effects.push(`onTerminal:${insideAcceptedWrite()}`); },
    });
    coordinatorRef = coordinator;
    const release = acquireRunPlacementPublicationOwner(run)!;
    runs.finish(run, 'succeeded', 0, null);
    expect(run.status).toBe('succeeded');
    expect(effects).toEqual(['beforeFinish:true', 'onTerminal:true']);
    release();
    await ticks();
    expect(runPlacementPublication(run)).toBeNull();
    // No child ticket here: the sealed run permit drains once publication settled.
    expect(coordinator.snapshot().registrations).toBe(0);
  });

  it('refuses duplicate and late terminal persistence after selected custody settles', async () => {
    const writes: string[] = [];
    const { state, runs, run } = await coordinated({
      writeDurableState: () => { writes.push('state'); return { ok: true }; },
    });
    const release = acquireRunPlacementPublicationOwner(run)!;
    runs.finish(run, 'succeeded', 0, null);
    release();
    await ticks();
    expect(runPlacementPublication(run)).toBeNull();
    const afterFinish = writes.length;
    state.qualified = false;
    runs.finish(run, 'succeeded', 0, null);
    runs.fail(run, 'LATE_ERROR', 'late child callback');
    await ticks();
    expect(writes).toHaveLength(afterFinish);
    expect(run.events.some((event: { event: string; data?: { error?: { code?: string } } }) =>
      event.event === 'error' && event.data?.error?.code === 'LATE_ERROR')).toBe(false);
  });

  it('refuses duplicate state after selected stream failure retains its ticket', async () => {
    const writes: string[] = [];
    const { state, runs, run } = await coordinated({
      writeDurableState: () => { writes.push('state'); return { ok: true }; },
    });
    loose(run).eventsLogPath = '/proof/no-write/events.jsonl';
    loose(run).eventsLogStream = new Writable({ write(_chunk, _encoding, done) { done(new Error('EIO')); } });
    const release = acquireRunPlacementPublicationOwner(run)!;
    runs.finish(run, 'succeeded', 0, null);
    release();
    await ticks();
    expect(runPlacementPublication(run)).not.toBeNull();
    const afterFinish = writes.length;
    state.qualified = false;
    runs.finish(run, 'succeeded', 0, null);
    await ticks();
    expect(writes).toHaveLength(afterFinish);
  });
});
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
