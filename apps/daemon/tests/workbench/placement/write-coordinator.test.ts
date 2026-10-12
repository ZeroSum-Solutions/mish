import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bindPlacementRuntimeOwner, authorizePlacementRecovery, PlacementWriteCoordinator,
  type MutationPermit, type RunPermit, type RunDrainPermit, type PlacementRecoveryCapability,
} from '../../../src/workbench/placement/write-coordinator.js';

const a = path.resolve('fixture-projects/a'), b = path.resolve('fixture-projects/b');
const dataRoot = path.resolve('fixture-owner');
let ownerSequence = 0;
function freshDataRoot() { return path.join(dataRoot, String(++ownerSequence)); }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(resolveProjectRoot: (root: string) => Promise<string> = async root => root) {
  const state = { held: true, qualified: true, recovery: 'ready' as 'ready' | 'required' };
  const blockedProjectRoots: string[] = [];
  const ownerRoot = freshDataRoot();
  const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: ownerRoot, inspect: () => ({ held: state.held, qualified: state.qualified }), readPreviousIncarnationRecovery: () => { if (state.recovery !== 'ready') throw new Error('unknown prior launch/child exit'); return { blockedProjectRoots }; } });
  const core = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot });
  return { core, state, owner, ownerRoot, resolveProjectRoot, blockedProjectRoots };
}
async function ticks() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe('inactive placement write coordinator', () => {
  it.each([
    { held: false, qualified: true, recovery: 'ready' as const, code: 'OWNER_UNQUALIFIED' },
    { held: true, qualified: false, recovery: 'ready' as const, code: 'OWNER_UNQUALIFIED' },
  ])('refuses owner binding: $code ($held/$qualified/$recovery)', ({ code, ...state }) => {
    expect(() => bindPlacementRuntimeOwner({ canonicalDataRoot: freshDataRoot(), inspect: () => state, readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) })).toThrowError(expect.objectContaining({ code }));
  });
  it('refuses forged owner capsules and noncanonical resolver outputs', async () => {
    expect(() => new PlacementWriteCoordinator({ owner: {} as ReturnType<typeof bindPlacementRuntimeOwner>, resolveProjectRoot: async root => root })).toThrowError(expect.objectContaining({ code: 'OWNER_UNQUALIFIED' }));
    const { core } = fixture(async () => 'relative');
    await expect(core.acquireMutation({ projectRoots: [a] })).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    expect(core.snapshot().registrations).toBe(0);
  });
  it('registers before resolving roots, blocking placement during admission', async () => {
    const ready = deferred<string>(); const { core } = fixture(() => ready.promise);
    const mutation = core.acquireMutation({ projectRoots: [a] });
    expect(core.snapshot()).toMatchObject({ registrations: 1, acquiring: 1 });
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    ready.resolve(a); const permit = await mutation; core.releaseMutation(permit);
  });
  it('placement excludes every new run/mutation until release', async () => {
    const { core } = fixture(); const permit = await core.acquirePlacement({ projectRoots: [a] });
    await expect(core.admitRun({ projectRoots: [] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await expect(core.acquireMutation({ projectRoots: [b] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    core.releaseMutation(permit); const run = await core.admitRun({ projectRoots: [] }); await core.finishRun(run);
  });
  it('queued projectless runs block placement before allocation or start', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [] });
    await expect(core.acquirePlacement({ projectRoots: [a] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    await expect(core.withDataRootWrite(run, async () => 'bad')).rejects.toMatchObject({ code: 'RUN_STATE' });
    core.cancelRun(run); await core.finishRun(run); const p = await core.acquirePlacement({ projectRoots: [a] }); core.releaseMutation(p);
  });
  it('serializes alias roots but lets independent projects proceed while a gate waits', async () => {
    const { core } = fixture(async root => root === 'alias' ? a : root);
    const first = await core.acquireMutation({ projectRoots: [a] });
    let admitted = false; const waiting = core.acquireMutation({ projectRoots: ['alias'] }).then(p => { admitted = true; return p; });
    const independent = await core.acquireMutation({ projectRoots: [b] });
    expect(admitted).toBe(false); core.releaseMutation(independent); core.releaseMutation(first);
    const second = await waiting; expect(admitted).toBe(true); core.releaseMutation(second);
  });
  it('sorts opposing project sets without deadlock and deduplicates aliases', async () => {
    const { core } = fixture(async root => root === 'alias' ? a : root);
    const first = await core.acquireMutation({ projectRoots: [b, a, 'alias'] });
    let admitted = false; const next = core.acquireMutation({ projectRoots: [a, b] }).then(p => { admitted = true; return p; });
    await ticks(); expect(admitted).toBe(false); core.releaseMutation(first); core.releaseMutation(await next);
    expect(core.snapshot().registrations).toBe(0);
  });
  it('aborting a partially acquired set removes its waiter and releases earlier gates', async () => {
    const { core } = fixture(); const blocker = await core.acquireMutation({ projectRoots: [b] }); const abort = new AbortController();
    const wait = core.acquireMutation({ projectRoots: [a, b], signal: abort.signal }); const rejected = expect(wait).rejects.toMatchObject({ code: 'ADMISSION_CANCELLED' });
    await ticks(); abort.abort(); await rejected;
    const available = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(available); core.releaseMutation(blocker);
    expect(core.snapshot().registrations).toBe(0);
  });
  it('freezes input before async resolution and refuses deferred physical retarget', async () => {
    const roots = [a]; const ready = deferred<string>(); let delayed = true;
    const { core } = fixture(root => delayed ? ready.promise : Promise.resolve(root));
    const pending = core.admitRun({ projectRoots: roots }); roots[0] = b; ready.resolve(a); const run = await pending; delayed = false;
    await expect(core.startRun(run, { projectRoots: [b] })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    await core.startRun(run, { projectRoots: [a] }); await core.finishRun(run);
  });
  it('refuses projectless-to-project deferred retarget and duplicate start', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [] });
    await expect(core.startRun(run, { projectRoots: [a] })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    await core.startRun(run, { projectRoots: [] });
    await expect(core.startRun(run, { projectRoots: [] })).rejects.toMatchObject({ code: 'RUN_STATE' }); await core.finishRun(run);
  });
  it('rechecks cancellation across deferred start resolution', async () => {
    const ready = deferred<string>(); let starting = false; const { core } = fixture(root => starting ? ready.promise : Promise.resolve(root));
    const run = await core.admitRun({ projectRoots: [a] }); starting = true; const start = core.startRun(run, { projectRoots: [a] });
    const rejected = expect(start).rejects.toMatchObject({ code: 'RUN_STATE' }); core.cancelRun(run); ready.resolve(a); await rejected; await core.finishRun(run);
  });
  it.each([
    { phase: 'running', scope: 'project' }, { phase: 'running', scope: 'data-root' },
    { phase: 'queued', scope: 'project' }, { phase: 'queued', scope: 'data-root' },
    { phase: 'starting', scope: 'project' }, { phase: 'starting', scope: 'data-root' },
  ] as const)('cancelled $phase run refuses new unticketed $scope publication before finish', async ({ phase, scope }) => {
    const ready = deferred<string>(); let waiting = false, published = false;
    const { core } = fixture(root => waiting ? ready.promise : Promise.resolve(root));
    const run = await core.admitRun({ projectRoots: [a] });
    let starting: Promise<void> | undefined;
    if (phase === 'running') await core.startRun(run, { projectRoots: [a] });
    if (phase === 'starting') { waiting = true; starting = core.startRun(run, { projectRoots: [a] }); }
    core.cancelRun(run);
    try {
      const work = async () => { published = true; return 'late publication'; };
      await expect(scope === 'project' ? core.withProjectWrite(run, a, work) : core.withDataRootWrite(run, work)).rejects.toMatchObject({ code: 'RUN_STATE' });
      expect(published).toBe(false);
    } finally {
      ready.resolve(a);
      if (starting) await expect(starting).rejects.toMatchObject({ code: 'RUN_STATE' });
      await core.finishRun(run);
    }
  });
  it.each(['project', 'data-root'] as const)('accepted unticketed %s publication drains after cancellation and retains queue fences', async scope => {
    const resolved = deferred<string>(), published = deferred(); let waiting = false, entered = false;
    const { core } = fixture(root => waiting && root === a ? resolved.promise : Promise.resolve(root));
    const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    let granted = false; const queued = core.acquireMutation({ projectRoots: [a] }).then(permit => { granted = true; return permit; });
    await ticks(); waiting = true;
    const work = async () => { entered = true; await published.promise; return 'accepted publication'; };
    const write = scope === 'project' ? core.withProjectWrite(run, a, work) : core.withDataRootWrite(run, work);
    core.cancelRun(run); let finished = false; const finish = core.finishRun(run).then(() => { finished = true; });
    const independent = await core.acquireMutation({ projectRoots: [b] }); core.releaseMutation(independent);
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    resolved.resolve(a); await ticks(); expect(entered).toBe(true); expect(finished).toBe(false); expect(granted).toBe(false);
    published.resolve(); expect(await write).toBe('accepted publication'); await finish;
    const next = await queued; expect(granted).toBe(true); core.releaseMutation(next);
    const placement = await core.acquirePlacement({ projectRoots: [b] }); core.releaseMutation(placement);
  });
  it.each(['project', 'data-root'] as const)('accepted drain ticket permits %s publication after cancellation', async scope => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    const ticket = core.registerRunDrain(run, 'publication'), done = deferred(); core.cancelRun(run);
    let finished = false; const finish = core.finishRun(run).then(() => { finished = true; });
    const work = async () => { await done.promise; return 'ticketed publication'; };
    const write = scope === 'project' ? core.withDrainProjectWrite(ticket, a, work) : core.withDrainDataRootWrite(ticket, work);
    core.confirmRunDrain(ticket); await ticks(); expect(finished).toBe(false);
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    done.resolve(); expect(await write).toBe('ticketed publication'); await finish;
    const placement = await core.acquirePlacement({ projectRoots: [b] }); core.releaseMutation(placement);
  });
  it('cancellation retains child/publication/cleanup fences through finish', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    const child = core.registerRunDrain(run, 'child'); core.cancelRun(run);
    expect(() => core.registerRunDrain(run, 'child')).toThrowError(expect.objectContaining({ code: 'RUN_STATE' }));
    const publication = core.registerRunDrain(run, 'publication'), cleanup = core.registerRunDrain(run, 'cleanup');
    let released = false; const finishing = core.finishRun(run).then(() => { released = true; });
    expect(() => core.registerRunDrain(run, 'publication')).toThrowError(expect.objectContaining({ code: 'RUN_STATE' }));
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    core.confirmRunDrain(child); core.confirmRunDrain(publication); await ticks(); expect(released).toBe(false);
    core.confirmRunDrain(cleanup); await finishing; expect(released).toBe(true);
  });
  it('accepted final writes finish before run release, including a resolver wait', async () => {
    const resolve = deferred<string>(), publication = deferred(); let delaying = false;
    const { core } = fixture(root => delaying ? resolve.promise : Promise.resolve(root));
    const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] }); delaying = true;
    let entered = false; const write = core.withProjectWrite(run, a, async () => { entered = true; await publication.promise; });
    let drained = false; const finish = core.finishRun(run).then(() => { drained = true; });
    resolve.resolve(a); await ticks(); expect(entered).toBe(true); expect(drained).toBe(false);
    publication.resolve(); await write; await finish; expect(drained).toBe(true);
  });
  it('holds mutation gate across publication failure and prevents early release', async () => {
    const { core } = fixture(); const p = await core.acquireMutation({ projectRoots: [a] }); const done = deferred();
    const write = core.withProjectWrite(p, a, async () => { await done.promise; throw new Error('publication failed after cleanup'); });
    const rejected = expect(write).rejects.toThrow('publication failed');
    expect(() => core.releaseMutation(p)).toThrowError(expect.objectContaining({ code: 'DRAIN_ACTIVE' }));
    done.resolve(); await rejected; core.releaseMutation(p);
  });
  it('refuses forged, copied, foreign and released permits/drain tickets', async () => {
    const { core } = fixture(); const other = fixture().core; const p = await core.acquireMutation({ projectRoots: [a] });
    for (const bad of [{}, { ...p }] as MutationPermit[]) await expect(core.withProjectWrite(bad, a, async () => 0)).rejects.toMatchObject({ code: 'INVALID_PERMIT' });
    await expect(other.withProjectWrite(p, a, async () => 0)).rejects.toMatchObject({ code: 'INVALID_PERMIT' });
    core.releaseMutation(p); expect(() => core.releaseMutation(p)).toThrowError(expect.objectContaining({ code: 'PERMIT_RELEASED' }));
    await expect(core.withProjectWrite(p, a, async () => 0)).rejects.toMatchObject({ code: 'PERMIT_RELEASED' });
    const run = await core.admitRun({ projectRoots: [] }); await core.startRun(run, { projectRoots: [] }); const ticket = core.registerRunDrain(run, 'child');
    expect(() => core.confirmRunDrain({} as RunDrainPermit)).toThrowError(expect.objectContaining({ code: 'INVALID_PERMIT' }));
    expect(() => other.confirmRunDrain(ticket)).toThrowError(expect.objectContaining({ code: 'INVALID_PERMIT' }));
    core.confirmRunDrain(ticket); expect(() => core.confirmRunDrain(ticket)).toThrowError(expect.objectContaining({ code: 'PERMIT_RELEASED' })); await core.finishRun(run);
    await expect(core.startRun({} as RunPermit, { projectRoots: [] })).rejects.toMatchObject({ code: 'INVALID_PERMIT' });
  });
  it('cannot forge a permit through runtime-visible TypeScript private storage', async () => {
    const { core } = fixture(); const p = await core.acquireMutation({ projectRoots: [a] }); const forged = {} as MutationPermit;
    const exposed = core as unknown as { permits?: WeakMap<object, unknown> };
    // A JS consumer could copy a live record into a forged token if TS private
    // fields leaked the store. Real #private state makes this attack inert.
    if (exposed.permits) exposed.permits.set(forged, exposed.permits.get(p));
    await expect(core.withProjectWrite(forged, a, async () => 'forged write')).rejects.toMatchObject({ code: 'INVALID_PERMIT' });
    core.releaseMutation(p);
  });
  it('rejects a write outside the frozen physical scope', async () => {
    const { core } = fixture(); const p = await core.acquireMutation({ projectRoots: [a] }); let wrote = false;
    await expect(core.withProjectWrite(p, b, async () => { wrote = true; })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    expect(wrote).toBe(false); core.releaseMutation(p);
  });
  it('closeAdmission waits for active publication; release never reopens a closed placement', async () => {
    const { core } = fixture(); const p = await core.acquirePlacement({ projectRoots: [a] }); const done = deferred();
    const write = core.withProjectWrite(p, a, async () => done.promise); let drained = false; const close = core.closeAdmission().then(() => { drained = true; });
    await ticks(); expect(drained).toBe(false); expect(() => core.openAdmission()).toThrowError(expect.objectContaining({ code: 'COORDINATOR_BUSY' }));
    done.resolve(); await write; core.releaseMutation(p); await close; expect(core.snapshot().mode).toBe('closed');
    await expect(core.admitRun({ projectRoots: [] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' }); core.openAdmission();
  });
  it('closeAdmission cancels waiting gates but keeps granted/queued run fences', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] });
    const waiting = core.acquireMutation({ projectRoots: [a] }); const rejected = expect(waiting).rejects.toMatchObject({ code: 'ADMISSION_CANCELLED' }); await ticks();
    let drained = false; const close = core.closeAdmission().then(() => { drained = true; }); await rejected;
    await expect(core.startRun(run, { projectRoots: [a] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' }); expect(drained).toBe(false);
    core.cancelRun(run); await core.finishRun(run); await close;
  });
  it('refuses owner loss before final I/O and never revives a released owner', async () => {
    const ready = deferred<string>(); let waiting = false; const { core, state } = fixture(root => waiting ? ready.promise : Promise.resolve(root));
    const p = await core.acquireMutation({ projectRoots: [a] }); waiting = true; let wrote = false;
    const write = core.withProjectWrite(p, a, async () => { wrote = true; }); const rejected = expect(write).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    state.held = false; ready.resolve(a); await rejected; expect(wrote).toBe(false); core.releaseMutation(p); state.held = true;
    expect(() => core.openAdmission()).toThrowError(expect.objectContaining({ code: 'OWNER_UNQUALIFIED' }));
  });
  it('requires explicit recovery-ready reopening after recovery refusal', async () => {
    const { core, state, owner } = fixture(); state.recovery = 'required';
    await expect(core.acquireMutation({ projectRoots: [a] })).rejects.toMatchObject({ code: 'OWNER_RECOVERING' }); state.recovery = 'ready';
    await expect(core.admitRun({ projectRoots: [] })).rejects.toMatchObject({ code: 'OWNER_RECOVERING' }); core.openAdmission(authorizePlacementRecovery(owner));
    const p = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(p);
  });
  it('prior-incarnation uncertainty stays closed with zero current counters', async () => {
    let resolved = false;
    const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: freshDataRoot(), inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => { if (!resolved) throw new Error('durable intent without recorded child exit'); return { blockedProjectRoots: [] }; } });
    const core = new PlacementWriteCoordinator({ owner, resolveProjectRoot: async root => root });
    expect(core.snapshot()).toMatchObject({ registrations: 0, recoveryRequired: true, mode: 'closed' });
    await expect(core.admitRun({ projectRoots: [] })).rejects.toMatchObject({ code: 'OWNER_RECOVERING' });
    expect(() => authorizePlacementRecovery(owner)).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    for (const forged of [{}, true, { pid: 123, drained: true }] as PlacementRecoveryCapability[]) expect(() => core.openAdmission(forged)).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    resolved = true; expect(() => core.openAdmission()).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    core.openAdmission(authorizePlacementRecovery(owner)); const p = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(p);
  });
  it('rejects recovery from another owner incarnation', () => {
    const one = fixture(), two = fixture();
    expect(() => two.core.openAdmission(authorizePlacementRecovery(one.owner))).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
  });
  it('scopes prior project conflicts after global child uncertainty clears', async () => {
    const { core, blockedProjectRoots } = fixture(); blockedProjectRoots.push(a);
    await expect(core.acquireMutation({ projectRoots: [a] })).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    expect(core.snapshot().mode).toBe('open'); const p = await core.acquireMutation({ projectRoots: [b] }); core.releaseMutation(p);
    blockedProjectRoots.length = 0; const cleared = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(cleared);
  });
  it('rechecks newly blocked projects immediately before final publication', async () => {
    const ready = deferred<string>(); let waiting = false; const { core, blockedProjectRoots } = fixture(root => waiting ? ready.promise : Promise.resolve(root));
    const p = await core.acquireMutation({ projectRoots: [a] }); waiting = true; let wrote = false;
    const write = core.withProjectWrite(p, a, async () => { wrote = true; }); const rejected = expect(write).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    blockedProjectRoots.push(a); ready.resolve(a); await rejected; expect(wrote).toBe(false); core.releaseMutation(p);
  });

  it('refuses same-root rebinding until old children AND publications drain', async () => {
    const first = fixture(); const run = await first.core.admitRun({ projectRoots: [a] }); await first.core.startRun(run, { projectRoots: [a] });
    const child = first.core.registerRunDrain(run, 'child'), done = deferred();
    const write = first.core.withProjectWrite(run, a, async () => done.promise);
    await ticks(); first.state.held = false;
    await expect(first.core.acquireMutation({ projectRoots: [b] })).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    const replacement = () => bindPlacementRuntimeOwner({ canonicalDataRoot: first.ownerRoot, inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) });
    expect(replacement).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    const finish = first.core.finishRun(run); first.core.confirmRunDrain(child);
    expect(replacement).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    done.resolve(); await write; await finish;
    const owner = replacement(); const core = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async root => root });
    const p = await core.acquirePlacement({ projectRoots: [a] }); core.releaseMutation(p);
  });
  it('refuses duplicate binding even when an unreleased owner has zero counters', () => {
    const first = fixture();
    expect(() => bindPlacementRuntimeOwner({ canonicalDataRoot: first.ownerRoot, inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) })).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
  });
  it('cancelled queued runs cannot publish or reserve publication work', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); core.cancelRun(run);
    await expect(core.withProjectWrite(run, a, async () => 'bad')).rejects.toMatchObject({ code: 'RUN_STATE' });
    expect(() => core.registerRunDrain(run, 'publication')).toThrowError(expect.objectContaining({ code: 'RUN_STATE' })); await core.finishRun(run);
  });
  it('newly blocked projects refuse child reservation', async () => {
    const { core, blockedProjectRoots } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] }); blockedProjectRoots.push(a);
    expect(() => core.registerRunDrain(run, 'child')).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' })); core.cancelRun(run); await core.finishRun(run);
  });
  it('reserved publications can write after finish and retain their active callback fence', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    const ticket = core.registerRunDrain(run, 'publication'), done = deferred(); let drained = false;
    const finish = core.finishRun(run).then(() => { drained = true; });
    const write = core.withDrainProjectWrite(ticket, a, async () => done.promise);
    await expect(core.withProjectWrite(run, a, async () => 'unticketed')).rejects.toMatchObject({ code: 'RUN_STATE' });
    core.confirmRunDrain(ticket); await ticks(); expect(drained).toBe(false);
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    done.resolve(); await write; await finish;
    await expect(core.withDrainProjectWrite(ticket, a, async () => 'replay')).rejects.toMatchObject({ code: 'PERMIT_RELEASED' });
  });
  it('unstarted allocation cleanup is root-only and requires its reserved ticket', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); core.cancelRun(run);
    const ticket = core.registerRunDrain(run, 'cleanup'); const finish = core.finishRun(run);
    await expect(core.withDrainProjectWrite(ticket, a, async () => 'bad')).rejects.toMatchObject({ code: 'RUN_STATE' });
    expect(await core.withDrainDataRootWrite(ticket, async () => 'registry cleanup')).toBe('registry cleanup');
    core.confirmRunDrain(ticket); await finish;
  });
  it('child tickets cannot authorize final writes', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] }); const child = core.registerRunDrain(run, 'child');
    await expect(core.withDrainProjectWrite(child, a, async () => 'bad')).rejects.toMatchObject({ code: 'RUN_STATE' }); core.confirmRunDrain(child); await core.finishRun(run);
  });
  it('rejects trailing-separator canonical outputs before granting a second gate', async () => {
    const { core } = fixture(async () => a + path.sep);
    await expect(core.acquireMutation({ projectRoots: [a] })).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    expect(core.snapshot().registrations).toBe(0);
  });
  it('malformed signal never leaves registered placement work', async () => {
    const { core } = fixture(); await expect(core.acquirePlacement({ projectRoots: [a], signal: { aborted: false } as AbortSignal })).rejects.toMatchObject({ code: 'ADMISSION_CANCELLED' });
    expect(core.snapshot()).toMatchObject({ registrations: 0, mode: 'open' });
  });
  it('failed reopening requires fresh recovery authorization, not a retained old capability', async () => {
    const { core, owner, state } = fixture(); const otherRecovery = authorizePlacementRecovery(owner); await core.closeAdmission(); state.recovery = 'required';
    expect(() => core.openAdmission(otherRecovery)).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' })); state.recovery = 'ready';
    expect(() => core.openAdmission()).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' })); core.openAdmission(authorizePlacementRecovery(owner));
  });
  it('binds prototype native-adapter methods with their receiver', async () => {
    class Adapter {
      canonicalDataRoot = freshDataRoot(); held = true;
      inspect() { return { held: this.held, qualified: true }; }
      readPreviousIncarnationRecovery() { if (!this.held) throw new Error('not held'); return { blockedProjectRoots: [] }; }
    }
    const adapter = new Adapter(), owner = bindPlacementRuntimeOwner(adapter);
    const core = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async root => root });
    const p = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(p);
  });

  it('tracks queued registry allocation before placement and before child start', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); const done = deferred();
    const allocation = core.withRunAllocation(run, async () => { await done.promise; return 'allocated'; });
    await expect(core.acquirePlacement({ projectRoots: [b] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    await expect(core.startRun(run, { projectRoots: [a] })).rejects.toMatchObject({ code: 'RUN_STATE' });
    done.resolve(); expect(await allocation).toBe('allocated'); await core.startRun(run, { projectRoots: [a] }); await core.finishRun(run);
  });
  it('refuses new allocation on cancelled/closed queued runs and drains accepted allocation', async () => {
    const { core } = fixture(); const run = await core.admitRun({ projectRoots: [] }); const done = deferred();
    const allocation = core.withRunAllocation(run, async () => done.promise); const close = core.closeAdmission();
    await expect(core.withRunAllocation(run, async () => 'new')).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    core.cancelRun(run); let drained = false; const finish = core.finishRun(run).then(() => { drained = true; }); await ticks(); expect(drained).toBe(false);
    done.resolve(); await allocation; await finish; await close;
  });

  it('project conflicts block project I/O but let root-only run cleanup drain', async () => {
    const { core, blockedProjectRoots } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    const cleanup = core.registerRunDrain(run, 'cleanup'); core.cancelRun(run); blockedProjectRoots.push(a); const finish = core.finishRun(run);
    await expect(core.withDrainProjectWrite(cleanup, a, async () => 'bad')).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    expect(await core.withDrainDataRootWrite(cleanup, async () => 'root registry cleanup')).toBe('root registry cleanup');
    core.confirmRunDrain(cleanup); await finish;
    const independent = await core.acquirePlacement({ projectRoots: [b] }); core.releaseMutation(independent);
  });

});

/**
 * Final-I/O guard: every accepted write callback receives `assertCurrent()`,
 * called synchronously immediately before each actual filesystem mutation.
 * Bytes are real files in a private temp directory; the owner binding and
 * root observations are injected (synthetic), not Darwin product custody.
 */
describe('final-I/O guard inside accepted write callbacks', () => {
  type Guard = { assertCurrent(): void } | undefined;
  const scratch = mkdtempSync(path.join(tmpdir(), 'placement-final-io-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let fileSequence = 0;
  const target = () => path.join(scratch, `bytes-${++fileSequence}.txt`);
  /** Accepted work that awaits, lets `drift` happen, then performs its final write through the guard. */
  const lateWrite = (file: string, drift: () => void, bytes = 'late') => async (guard: Guard) => {
    await ticks(); drift(); guard?.assertCurrent(); await writeFile(file, bytes); return bytes;
  };
  const settle = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'admitted', (error: { code?: string }) => error.code ?? 'error'),
    new Promise(resolve => setTimeout(() => resolve('deadlocked'), 200))]);

  it('owner loss across awaited work refuses the final bytes', async () => {
    const { core, state } = fixture(); const permit = await core.acquireMutation({ projectRoots: [a] }); const file = target();
    await expect(core.withProjectWrite(permit, a, lateWrite(file, () => { state.held = false; }))).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(existsSync(file)).toBe(false); core.releaseMutation(permit);
  });
  it.each([
    { case: 'a newly fenced project root', drift: (f: ReturnType<typeof fixture>) => { f.blockedProjectRoots.push(a); }, code: 'PROJECT_RECOVERING' },
    { case: 'unresolved prior-incarnation recovery', drift: (f: ReturnType<typeof fixture>) => { f.state.recovery = 'required'; }, code: 'OWNER_RECOVERING' },
  ])('$case across awaited work refuses the final bytes', async ({ drift, code }) => {
    const f = fixture(); const permit = await f.core.acquireMutation({ projectRoots: [a] }); const file = target();
    await expect(f.core.withProjectWrite(permit, a, lateWrite(file, () => drift(f)))).rejects.toMatchObject({ code });
    expect(existsSync(file)).toBe(false); f.core.releaseMutation(permit);
  });
  it('data-root final I/O rechecks owner and recovery', async () => {
    const { core, state } = fixture(); const permit = await core.acquireMutation({ projectRoots: [] }); const file = target();
    await expect(core.withDataRootWrite(permit, lateWrite(file, () => { state.recovery = 'required'; }))).rejects.toMatchObject({ code: 'OWNER_RECOVERING' });
    expect(existsSync(file)).toBe(false); core.releaseMutation(permit);
  });
  it('accepted work survives caller cancellation and admission close, holds its gate, and its final bytes still land', async () => {
    const { core } = fixture(); const caller = new AbortController(); const file = target();
    const permit = await core.acquireMutation({ projectRoots: [a], signal: caller.signal });
    const hold = deferred(); const order: string[] = [];
    const accepted = core.withProjectWrite(permit, a, async (guard: Guard) => { await hold.promise; guard?.assertCurrent(); await writeFile(file, 'accepted'); order.push('accepted-bytes'); });
    caller.abort(); // response cancellation reaches only pending admission
    let competitor: MutationPermit | null = null;
    const waiting = core.acquireMutation({ projectRoots: [a] }).then(p => { competitor = p; order.push('competitor-admitted'); });
    await ticks(); expect(competitor).toBeNull();
    hold.resolve(); await accepted; await ticks(); expect(competitor).toBeNull(); // still held until release
    core.releaseMutation(permit); await waiting;
    await core.withProjectWrite(competitor!, a, async (guard: Guard) => { guard?.assertCurrent(); await writeFile(file, 'competitor'); });
    expect(order).toEqual(['accepted-bytes', 'competitor-admitted']); expect(readFileSync(file, 'utf8')).toBe('competitor');
    core.releaseMutation(competitor!);

    const second = await core.acquireMutation({ projectRoots: [a] }); const late = deferred(); let closed = false;
    const write = core.withProjectWrite(second, a, async (guard: Guard) => { await late.promise; guard?.assertCurrent(); await writeFile(file, 'after-close'); });
    const drained = core.closeAdmission().then(() => { closed = true; });
    late.resolve(); await write; expect(readFileSync(file, 'utf8')).toBe('after-close');
    await ticks(); expect(closed).toBe(false); core.releaseMutation(second); await drained;
  });
  it('a borrowed run final ticket receives the guard: it survives cancellation but owner loss refuses its bytes', async () => {
    const { core, state } = fixture(); const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
    const kept = core.registerRunDrain(run, 'publication'), lost = core.registerRunDrain(run, 'publication'); core.cancelRun(run);
    const landed = target(), refused = target();
    await expect(core.withDrainProjectWrite(kept, a, lateWrite(landed, () => undefined, 'final'))).resolves.toBe('final');
    expect(readFileSync(landed, 'utf8')).toBe('final');
    await expect(core.withDrainProjectWrite(lost, a, lateWrite(refused, () => { state.held = false; }))).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(existsSync(refused)).toBe(false);
  });
  it('a guard is valid only while its accepted callback runs', async () => {
    const { core } = fixture(); const permit = await core.acquireMutation({ projectRoots: [a] }); let leaked: Guard;
    await core.withProjectWrite(permit, a, async (guard: Guard) => { leaked = guard; });
    expect(() => leaked!.assertCurrent()).toThrowError(expect.objectContaining({ code: 'PERMIT_RELEASED' }));
    core.releaseMutation(permit);
  });
  it('nested admission inside an accepted callback refuses instead of deadlocking (reuse the permit)', async () => {
    const { core } = fixture(); const permit = await core.acquireMutation({ projectRoots: [a] });
    expect(await settle(core.withProjectWrite(permit, a, () => core.acquireMutation({ projectRoots: [a] })))).toBe('COORDINATOR_BUSY');
    // Unsorted nested gates break lock order even for another project.
    expect(await settle(core.withProjectWrite(permit, a, () => core.acquireMutation({ projectRoots: [b] })))).toBe('COORDINATOR_BUSY');
    expect(await settle(core.withProjectWrite(permit, a, () => core.admitRun({ projectRoots: [b] })))).toBe('COORDINATOR_BUSY');
    core.releaseMutation(permit);
    const after = await core.acquireMutation({ projectRoots: [a] }); core.releaseMutation(after); // nothing leaked
  });
  describe('CURRENT root observation (injected, synthetic)', () => {
    type Observation = { gateKey: string; physicalRoot: string; identity: { device: string; inode: string } | null; epoch: number };
    function observed(initial: Observation) {
      const current: { value: Observation | Error } = { value: initial };
      const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: freshDataRoot(), inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) });
      const options = { owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async (root: string) => root,
        observeProjectRoot: () => { if (current.value instanceof Error) throw current.value; return current.value; } };
      return { core: new PlacementWriteCoordinator(options as ConstructorParameters<typeof PlacementWriteCoordinator>[0]), current };
    }
    const base: Observation = { gateKey: a, physicalRoot: a, identity: { device: '1', inode: '10' }, epoch: 1 };
    it.each([
      { case: 'replaced root identity', next: { ...base, identity: { device: '1', inode: '11' } } },
      { case: 'retargeted physical root', next: { ...base, physicalRoot: path.join(a, 'moved') } },
      { case: 'replaced registry epoch', next: { ...base, epoch: 2 } },
      { case: 'another gate key', next: { ...base, gateKey: b, physicalRoot: b } },
      { case: 'stale or unauthorized registration', next: new Error('Project registration is stale') },
    ])('$case across awaited work refuses the final bytes', async ({ next }) => {
      const { core, current } = observed(base); const permit = await core.acquireMutation({ projectRoots: [a] }); const file = target();
      await expect(core.withProjectWrite(permit, a, lateWrite(file, () => { current.value = next; }))).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
      expect(existsSync(file)).toBe(false); core.releaseMutation(permit);
    });
    it('a run keeps one pin across its own writes and reserved final tickets; a replacement between callbacks refuses', async () => {
      const { core, current } = observed({ ...base, identity: null });
      const run = await core.admitRun({ projectRoots: [a] }); await core.startRun(run, { projectRoots: [a] });
      const publication = core.registerRunDrain(run, 'publication'), cleanup = core.registerRunDrain(run, 'cleanup');
      const created = target(), again = target(), finalBytes = target(), cleanupBytes = target();
      await core.withProjectWrite(run, a, async (guard: Guard) => { current.value = base; guard?.assertCurrent(); await writeFile(created, 'created'); });
      await core.withProjectWrite(run, a, async (guard: Guard) => { guard?.assertCurrent(); await writeFile(again, 'same root'); }); // control
      current.value = { ...base, identity: { device: '1', inode: '99' } }; // replaced between callbacks
      await expect(core.withDrainProjectWrite(publication, a, async (guard: Guard) => { guard?.assertCurrent(); await writeFile(finalBytes, 'final'); })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
      await expect(core.withDrainProjectWrite(cleanup, a, async (guard: Guard) => { guard?.assertCurrent(); await writeFile(cleanupBytes, 'cleanup'); })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
      expect(readFileSync(created, 'utf8')).toBe('created'); expect(readFileSync(again, 'utf8')).toBe('same root');
      expect(existsSync(finalBytes)).toBe(false); expect(existsSync(cleanupBytes)).toBe(false);
    });
    it('a not-yet-created root pins the first identity it observes; a later replacement refuses', async () => {
      const { core, current } = observed({ ...base, identity: null }); const permit = await core.acquireMutation({ projectRoots: [a] });
      const first = target(), second = target();
      await expect(core.withProjectWrite(permit, a, async (guard: Guard) => {
        guard?.assertCurrent(); await ticks(); current.value = base; // created inside the accepted write
        guard?.assertCurrent(); await writeFile(first, 'created');
        current.value = { ...base, identity: { device: '1', inode: '99' } };
        guard?.assertCurrent(); await writeFile(second, 'replaced');
      })).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
      expect(readFileSync(first, 'utf8')).toBe('created'); expect(existsSync(second)).toBe(false);
      core.releaseMutation(permit);
    });
  });
});
