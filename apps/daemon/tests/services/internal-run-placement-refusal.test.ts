import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInternalRunCreationService, type InternalPhysicalRun, type InternalRunCreateInput, type InternalRunRegistry,
} from '../../src/services/internal-run-service.js';
import { PlacementProjectRegistry, type PlacementProjectSource } from '../../src/workbench/placement/project-registry.js';
import { PlacementRunLifetime } from '../../src/workbench/placement/run-lifetime.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementWriteCoordinator } from '../../src/workbench/placement/write-coordinator.js';

/**
 * B2: an admitted run allocated (created, claimed, persisted) and then refused
 * before its registry start must not stay queued. The real coordinator with an
 * injected (synthetic) owner binding; never Darwin product custody.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

interface TestRun extends InternalPhysicalRun { projectId?: string }
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-run-refusal-'))); roots.push(root);
  const projects = path.join(root, 'projects'); mkdirSync(path.join(projects, 'p1'), { recursive: true });
  const state = { qualified: true, blocked: [] as string[] };
  const owner = bindPlacementRuntimeOwner({
    canonicalDataRoot: path.join(root, 'owner'),
    inspect: () => ({ held: true, qualified: state.qualified }),
    readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: state.blocked }),
  });
  const coordinator = new PlacementWriteCoordinator({
    owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async id => path.join(projects, id),
  });
  const lifetime = new PlacementRunLifetime({ coordinator, supervisor: {} as never, physicalRoots: ids => ids.map(id => path.join(projects, id)) });
  const run: TestRun = { id: 'run-1', status: 'queued', projectId: 'p1' };
  const runs: InternalRunRegistry<InternalRunCreateInput, TestRun> = {
    createOrReuse: () => ({ kind: 'created' as const, run }), prepareRestart: () => run, get: () => run,
    drop: vi.fn(), start: vi.fn((started: TestRun) => started), isTerminal: status => TERMINAL.has(status),
  };
  const discardRefusedRun = vi.fn((refused: TestRun) => { refused.status = 'failed'; });
  const service = createInternalRunCreationService({
    runs, claimAssistantMessage: () => ({ ok: true }), analyticsLifecycle: { install: () => undefined },
    runLifetime: lifetime, discardRefusedRun,
  });
  return { projects, state, coordinator, run, runs, service, discardRefusedRun };
}

describe('admitted run refused after allocation (B2)', () => {
  it('a project fence after allocation terminates the run through a guarded cleanup ticket', async () => {
    const f = fixture();
    const { prepared, admission } = await f.service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    expect(prepared.kind).toBe('ready');
    f.state.blocked = [path.join(f.projects, 'p1')];
    const starter = vi.fn(async () => undefined);
    await expect(f.service.startAdmitted(f.run, { requestAnalyticsContext: null } as never, starter, admission))
      .rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    expect(starter).not.toHaveBeenCalled();
    expect(f.runs.start).not.toHaveBeenCalled();
    expect(f.discardRefusedRun).toHaveBeenCalledTimes(1);
    expect(f.run.status).toBe('failed');
    await ticks();
    // The cleanup ticket settled and the permit released: nothing stays registered.
    expect(f.coordinator.snapshot()).toMatchObject({ registrations: 0, runs: 0 });
  });

  it('owner loss refuses the cleanup ticket: no unsafe terminal write, the run is retained', async () => {
    const f = fixture();
    const { admission } = await f.service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    f.state.qualified = false;
    await expect(f.service.startAdmitted(f.run, { requestAnalyticsContext: null } as never, async () => undefined, admission))
      .rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(f.discardRefusedRun).not.toHaveBeenCalled();
    expect(f.run.status).toBe('queued');
  });

  it('a refusal at the route binding step uses the same guarded cleanup', async () => {
    const f = fixture();
    const { admission } = await f.service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    await f.service.refuseAdmitted!(f.run, admission!, new Error('Run already has a placement admission'));
    expect(f.discardRefusedRun).toHaveBeenCalledTimes(1);
    expect(f.run.status).toBe('failed');
    await ticks();
    expect(f.coordinator.snapshot()).toMatchObject({ registrations: 0 });
  });

  it('ordinary mode (no lifetime) is unchanged: no admission, no cleanup', async () => {
    const run: TestRun = { id: 'run-o', status: 'queued', projectId: 'p1' };
    const discardRefusedRun = vi.fn();
    const service = createInternalRunCreationService({
      runs: { createOrReuse: () => ({ kind: 'created' as const, run }), prepareRestart: () => run, get: () => run, drop: vi.fn(), start: (r: TestRun) => r, isTerminal: s => TERMINAL.has(s) },
      claimAssistantMessage: () => ({ ok: true }), analyticsLifecycle: { install: () => undefined }, discardRefusedRun,
    });
    expect(service.coordinated).toBe(false);
    const { prepared, admission } = await service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    expect(prepared.kind).toBe('ready'); expect(admission).toBeNull();
    expect(await service.startAdmitted(run, { requestAnalyticsContext: null } as never, async () => undefined, null)).toBe(run);
    expect(discardRefusedRun).not.toHaveBeenCalled();
  });
});

describe('canonical run admission of a project created after boot', () => {
  it('registers the project before run admission instead of refusing it as an unknown root', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-run-register-'))); roots.push(root);
    const projects = path.join(root, 'projects'); mkdirSync(projects, { recursive: true });
    const sources = new Map<string, PlacementProjectSource>();
    const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
    registry.load();
    const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: path.join(root, 'owner'), inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) });
    const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: registry.resolveProjectRoot, observeProjectRoot: registry.observeProjectRoot });
    registry.attach(coordinator);
    const lifetime = new PlacementRunLifetime({ coordinator, supervisor: {} as never, physicalRoots: ids => ids.map(id => registry.describe(id).physicalRoot) });
    // Created after boot (POST /api/projects), never written by a standalone admission.
    sources.set('late', { id: 'late' }); mkdirSync(path.join(projects, 'late'));
    const make = (register: boolean) => {
      const run: TestRun = { id: `run-${register}`, status: 'queued', projectId: 'late' };
      return createInternalRunCreationService({
        runs: { createOrReuse: () => ({ kind: 'created' as const, run }), prepareRestart: () => run, get: () => run, drop: vi.fn(), start: (r: TestRun) => r, isTerminal: st => TERMINAL.has(st) },
        claimAssistantMessage: () => ({ ok: true }), analyticsLifecycle: { install: () => undefined }, runLifetime: lifetime,
        ...(register ? { registerAdmissionProjects: async (scope: { projectIds: readonly string[]; signal?: AbortSignal }) => {
          for (const id of scope.projectIds) await registry.registerProject(id, scope.signal ? { signal: scope.signal } : {});
        } } : {}),
      });
    };
    await expect(make(false).admitAndPrepare({ meta: { projectId: 'late' } }, { projectIds: ['late'] }))
      .rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    const { prepared, admission } = await make(true).admitAndPrepare({ meta: { projectId: 'late' } }, { projectIds: ['late'] });
    expect(prepared.kind).toBe('ready');
    expect(admission).not.toBeNull();
    expect(registry.describe('late')).toMatchObject({ kind: 'managed', physicalRoot: path.join(projects, 'late') });
    admission!.cancel(); await admission!.finish();
    expect(coordinator.snapshot()).toMatchObject({ registrations: 0 });
  });
});
