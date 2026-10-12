import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlacementCapabilityError, PlacementProjectRegistry, type PlacementProjectSource } from '../../../src/workbench/placement/project-registry.js';
import { mapPlacementFailure } from '../../../src/workbench/placement/runtime-status.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementWriteCoordinator } from '../../../src/workbench/placement/write-coordinator.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-registry-'))); roots.push(root);
  const projects = path.join(root, 'data', 'projects'), external = path.join(root, 'external');
  mkdirSync(projects, { recursive: true }); mkdirSync(path.join(external, 'outer', 'inner'), { recursive: true });
  const sources = new Map<string, PlacementProjectSource>();
  const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
  return { root, projects, external, sources, registry };
}
/** Injected owner binding (the native owner is exercised in runtime.test.ts). */
function coordinatorFor(registry: PlacementProjectRegistry, root: string) {
  const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: path.join(root, 'owner'), inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) });
  const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: registry.resolveProjectRoot });
  registry.attach(coordinator); return coordinator;
}
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

describe('same-data-root placement project registry', () => {
  it('keeps kind/physical identity separate from the coalesced outermost gate key', async () => {
    const f = fixture(); mkdirSync(path.join(f.projects, 'managed'));
    f.sources.set('managed', { id: 'managed' });
    f.sources.set('outer', { id: 'outer', metadata: { baseDir: path.join(f.external, 'outer') } });
    f.sources.set('inner', { id: 'inner', metadata: { baseDir: path.join(f.external, 'outer', 'inner') } });
    f.registry.load();
    expect(f.registry.describe('managed')).toMatchObject({ kind: 'managed', physicalRoot: path.join(f.projects, 'managed'), gateKey: path.join(f.projects, 'managed') });
    expect(f.registry.describe('inner')).toMatchObject({ kind: 'imported', physicalRoot: path.join(f.external, 'outer', 'inner'), gateKey: path.join(f.external, 'outer') });
    expect(await f.registry.resolveProjectRoot('inner')).toBe(await f.registry.resolveProjectRoot('outer'));
    expect(f.registry.describe('inner').identity).toMatchObject({ device: expect.any(String), inode: expect.any(String) });
  });
  it('coalesces symlink aliases and case variants onto one conservative gate', async () => {
    const f = fixture(); symlinkSync(path.join(f.external, 'outer'), path.join(f.root, 'alias'));
    mkdirSync(path.join(f.external, 'OUTER'), { recursive: true });
    f.sources.set('a', { id: 'a', metadata: { baseDir: path.join(f.external, 'outer') } });
    f.sources.set('b', { id: 'b', metadata: { baseDir: path.join(f.root, 'alias') } });
    f.sources.set('c', { id: 'c', metadata: { baseDir: path.join(f.external, 'OUTER') } });
    f.registry.load();
    const keys = new Set(await Promise.all(['a', 'b', 'c'].map(id => f.registry.resolveProjectRoot(id))));
    expect(keys.size).toBe(1);
    expect(f.registry.describe('b').physicalRoot).toBe(path.join(f.external, 'outer'));
  });
  it('serializes an imported alias bridged to an ancestor through a nested project while keeping disjoint work independent', async () => {
    const f = fixture(); const outer = path.join(f.external, 'outer'), inner = path.join(outer, 'inner');
    const aliasRoot = path.join(f.root, 'physical-alias-through-other-mount'), aliasInner = path.join(aliasRoot, 'inner');
    const disjoint = path.join(f.external, 'disjoint');
    symlinkSync(outer, aliasRoot, 'dir'); mkdirSync(disjoint);
    // Model an OS physical alias (bind mount/firmlink): different reported realpaths,
    // while real lstatSync still observes the same directory through the symlink parent.
    const native = realpathSync.native;
    vi.spyOn(realpathSync, 'native').mockImplementation(((candidate: Parameters<typeof native>[0]) =>
      String(candidate) === aliasInner ? aliasInner : native(candidate)) as typeof native);
    f.sources.set('outer', { id: 'outer', metadata: { baseDir: outer } });
    f.sources.set('inner', { id: 'inner', metadata: { baseDir: inner } });
    f.sources.set('alias-inner', { id: 'alias-inner', metadata: { baseDir: aliasInner } });
    f.sources.set('disjoint', { id: 'disjoint', metadata: { baseDir: disjoint } });
    f.registry.load();
    expect(f.registry.describe('alias-inner').physicalRoot).toBe(aliasInner);
    expect(f.registry.describe('inner').identity).toEqual(f.registry.describe('alias-inner').identity);
    expect(f.registry.describe('outer').gateKey).toBe(outer);
    expect(f.registry.describe('inner').gateKey).toBe(outer);
    expect(f.registry.describe('alias-inner').gateKey).toBe(outer);
    expect(f.registry.describe('disjoint').gateKey).toBe(disjoint);
    expect(f.registry.mapBlockedRoots([aliasInner])).toEqual([outer]);

    const coordinator = coordinatorFor(f.registry, f.root);
    const innerPermit = await coordinator.acquireMutation({ projectRoots: ['inner'] });
    let aliasAdmitted = false;
    const aliasPending = coordinator.acquireMutation({ projectRoots: ['alias-inner'] }).then(permit => { aliasAdmitted = true; return permit; });
    await ticks();
    expect(aliasAdmitted).toBe(false);
    const disjointPermit = await coordinator.acquireMutation({ projectRoots: ['disjoint'] });
    await expect(coordinator.withProjectWrite(innerPermit, 'inner', async guard => { guard.assertCurrent(); return 'inner'; })).resolves.toBe('inner');
    await expect(coordinator.withProjectWrite(disjointPermit, 'disjoint', async guard => { guard.assertCurrent(); return 'disjoint'; })).resolves.toBe('disjoint');
    coordinator.releaseMutation(disjointPermit);
    coordinator.releaseMutation(innerPermit);
    const aliasPermit = await aliasPending;
    await expect(coordinator.withProjectWrite(aliasPermit, 'alias-inner', async guard => { guard.assertCurrent(); return 'alias'; })).resolves.toBe('alias');
    coordinator.releaseMutation(aliasPermit);
  });
  it('re-coalesces an identity alias only after the overlapping epoch drains', async () => {
    const f = fixture(); const outer = path.join(f.external, 'outer'), inner = path.join(outer, 'inner');
    const aliasRoot = path.join(f.root, 'physical-alias-through-other-mount'), aliasInner = path.join(aliasRoot, 'inner');
    const disjoint = path.join(f.external, 'disjoint');
    symlinkSync(outer, aliasRoot, 'dir'); mkdirSync(disjoint);
    const native = realpathSync.native;
    vi.spyOn(realpathSync, 'native').mockImplementation(((candidate: Parameters<typeof native>[0]) =>
      String(candidate) === aliasInner ? aliasInner : native(candidate)) as typeof native);
    f.sources.set('outer', { id: 'outer', metadata: { baseDir: outer } });
    f.sources.set('inner', { id: 'inner', metadata: { baseDir: inner } });
    f.sources.set('disjoint', { id: 'disjoint', metadata: { baseDir: disjoint } });
    f.registry.load();
    const coordinator = coordinatorFor(f.registry, f.root);
    const live = await coordinator.acquireMutation({ projectRoots: ['inner'] });
    const epoch = f.registry.epoch;
    f.sources.set('alias-inner', { id: 'alias-inner', metadata: { baseDir: aliasInner } });
    let settled = false;
    const pending = f.registry.registerProject('alias-inner').then(registration => { settled = true; return registration; });
    await ticks();
    expect(settled).toBe(false);
    expect(coordinator.snapshot().mode).toBe('closed');
    await expect(coordinator.acquireMutation({ projectRoots: ['disjoint'] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await expect(coordinator.withProjectWrite(live, 'inner', async guard => { guard.assertCurrent(); return 'old epoch'; })).resolves.toBe('old epoch');
    coordinator.releaseMutation(live);
    const added = await pending;
    expect(f.registry.epoch).toBe(epoch + 1);
    expect(coordinator.snapshot().mode).toBe('open');
    expect(added.gateKey).toBe(outer);
    expect(f.registry.describe('inner').gateKey).toBe(outer);
    expect(f.registry.describe('disjoint').gateKey).toBe(disjoint);
    expect(f.registry.mapBlockedRoots([aliasInner])).toEqual([outer]);
  });
  it('imported adoption is a 422 unsupported capability; unknown imported authority is never registered', async () => {
    const f = fixture(); mkdirSync(path.join(f.projects, 'managed'));
    f.sources.set('managed', { id: 'managed' });
    f.sources.set('imported', { id: 'imported', metadata: { baseDir: path.join(f.external, 'outer') } });
    f.sources.set('missing', { id: 'missing', metadata: { baseDir: path.join(f.external, 'missing') } });
    f.registry.load();
    expect(f.registry.resolveAdoptionTarget('managed').kind).toBe('managed');
    let refusal: unknown; try { f.registry.resolveAdoptionTarget('imported'); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(PlacementCapabilityError);
    expect(mapPlacementFailure(refusal)).toMatchObject({ status: 422, details: { reason: 'unsupported-capability' } });
    expect(f.registry.unavailableProjects).toEqual(['missing']);
    await expect(f.registry.resolveProjectRoot('missing')).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
  });
  it('maps journal fences through overlapping registrations and keeps unregistered fences', () => {
    const f = fixture(); f.sources.set('outer', { id: 'outer', metadata: { baseDir: path.join(f.external, 'outer') } }); f.registry.load();
    expect(f.registry.mapBlockedRoots([path.join(f.external, 'outer', 'inner')])).toEqual([path.join(f.external, 'outer')]);
    expect(f.registry.mapBlockedRoots(['/elsewhere/root'])).toEqual(['/elsewhere/root']);
    expect(f.registry.projectIdsForGateKeys([path.join(f.external, 'outer')])).toEqual(['outer']);
  });
  it('a changed authorized location or physical root is stale until a drained epoch replacement', async () => {
    const f = fixture(); f.sources.set('moving', { id: 'moving', metadata: { baseDir: path.join(f.external, 'outer') } }); f.registry.load();
    f.sources.set('moving', { id: 'moving', metadata: { baseDir: path.join(f.external, 'outer', 'inner') } });
    await expect(f.registry.resolveProjectRoot('moving')).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    f.sources.set('moving', { id: 'moving', metadata: { baseDir: path.join(f.external, 'outer') } });
    renameSync(path.join(f.external, 'outer'), path.join(f.external, 'moved')); mkdirSync(path.join(f.external, 'outer'));
    await expect(f.registry.resolveProjectRoot('moving')).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
  });
  it('an overlapping registration waits for global close and actual drain; a live old permit is not stranded', async () => {
    const f = fixture(); f.sources.set('inner', { id: 'inner', metadata: { baseDir: path.join(f.external, 'outer', 'inner') } }); f.registry.load();
    const coordinator = coordinatorFor(f.registry, f.root);
    const live = await coordinator.acquireMutation({ projectRoots: ['inner'] });
    const epoch = f.registry.epoch;
    f.sources.set('outer', { id: 'outer', metadata: { baseDir: path.join(f.external, 'outer') } });
    let replaced = false; const pending = f.registry.registerProject('outer').then(r => { replaced = true; return r; });
    await ticks();
    expect(replaced).toBe(false);
    expect(coordinator.snapshot().mode).toBe('closed');
    await expect(coordinator.acquireMutation({ projectRoots: ['inner'] })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    // The old permit still writes under its original epoch while it drains.
    await expect(coordinator.withProjectWrite(live, 'inner', async () => 'old-epoch-write')).resolves.toBe('old-epoch-write');
    coordinator.releaseMutation(live);
    expect((await pending).gateKey).toBe(path.join(f.external, 'outer'));
    expect(f.registry.epoch).toBe(epoch + 1);
    expect(coordinator.snapshot().mode).toBe('open');
    expect(await f.registry.resolveProjectRoot('inner')).toBe(path.join(f.external, 'outer'));
  });
  it('a disjoint registration does not replace the epoch; new projects are admitted at the root before registration and I/O', async () => {
    const f = fixture(); f.sources.set('existing', { id: 'existing', metadata: { baseDir: path.join(f.external, 'outer') } }); f.registry.load();
    const coordinator = coordinatorFor(f.registry, f.root); const epoch = f.registry.epoch; const order: string[] = [];
    const result = await f.registry.createProjectUnderAdmission({
      projectId: 'fresh',
      persist: async () => { order.push(`persist:${coordinator.snapshot().registrations}`); f.sources.set('fresh', { id: 'fresh' }); },
      initialize: async write => write(async () => { order.push('project-io'); mkdirSync(path.join(f.projects, 'fresh')); return 'initialized'; }),
    });
    expect(result.result).toBe('initialized'); expect(order).toEqual(['persist:1', 'project-io']);
    expect(f.registry.epoch).toBe(epoch);
    expect(f.registry.describe('fresh')).toMatchObject({ kind: 'managed', gateKey: path.join(f.projects, 'fresh') });
    expect(coordinator.snapshot().registrations).toBe(0);
  });
  it('a root replaced at the same name re-registers only after drain and installs the fresh identity', async () => {
    const f = fixture(); const outer = path.join(f.external, 'outer');
    writeFileSync(path.join(outer, 'user-bytes.txt'), 'keep');
    f.sources.set('outer', { id: 'outer', metadata: { baseDir: outer } }); f.registry.load();
    const coordinator = coordinatorFor(f.registry, f.root); const before = f.registry.describe('outer'); const epoch = f.registry.epoch;
    const live = await coordinator.acquireMutation({ projectRoots: ['outer'] });
    renameSync(outer, path.join(f.external, 'outer-retained')); mkdirSync(outer); // retain the original bytes
    const fresh = lstatSync(outer, { bigint: true });
    let settled = false; const pending = f.registry.registerProject('outer').then(r => { settled = true; return r; });
    await ticks();
    expect(settled).toBe(false);
    expect(coordinator.snapshot().mode).toBe('closed');
    coordinator.releaseMutation(live);
    const after = await pending;
    expect(after.identity).toEqual({ device: String(fresh.dev), inode: String(fresh.ino) });
    expect(after.identity).not.toEqual(before.identity);
    expect(f.registry.epoch).toBe(epoch + 1);
    expect(await f.registry.resolveProjectRoot('outer')).toBe(outer);
    expect(readFileSync(path.join(f.external, 'outer-retained', 'user-bytes.txt'), 'utf8')).toBe('keep');
  });
  it('load() is initial-only: a later bypass is refused and the registration/epoch survive', async () => {
    const f = fixture(); f.sources.set('a', { id: 'a', metadata: { baseDir: path.join(f.external, 'outer') } }); f.registry.load();
    coordinatorFor(f.registry, f.root); const epoch = f.registry.epoch; const before = f.registry.describe('a');
    f.sources.set('a', { id: 'a', metadata: { baseDir: path.join(f.external, 'outer', 'inner') } });
    expect(() => f.registry.load()).toThrowError(expect.objectContaining({ code: 'COORDINATOR_BUSY' }));
    expect(f.registry.epoch).toBe(epoch);
    expect(f.registry.registrations()).toEqual([before]);
  });
  it('a not-yet-created managed root upgrades to its actual identity after creation without an epoch change', async () => {
    const f = fixture(); f.sources.set('existing', { id: 'existing', metadata: { baseDir: path.join(f.external, 'outer') } }); f.registry.load();
    const coordinator = coordinatorFor(f.registry, f.root); const epoch = f.registry.epoch;
    const { registration: registered } = await f.registry.createProjectUnderAdmission({
      projectId: 'fresh', persist: async () => { f.sources.set('fresh', { id: 'fresh' }); },
      initialize: async write => write(async () => { mkdirSync(path.join(f.projects, 'fresh')); }),
    });
    const actual = lstatSync(path.join(f.projects, 'fresh'), { bigint: true });
    expect(registered).toMatchObject({ projectId: 'fresh', kind: 'managed', identity: { device: String(actual.dev), inode: String(actual.ino) } });
    expect(f.registry.describe('fresh').identity).toEqual(registered.identity);
    expect(f.registry.epoch).toBe(epoch);
    // A later replacement of that now-known root is detected rather than silently accepted.
    renameSync(path.join(f.projects, 'fresh'), path.join(f.projects, 'fresh-retained')); mkdirSync(path.join(f.projects, 'fresh'));
    await expect(f.registry.resolveProjectRoot('fresh')).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    expect(coordinator.snapshot().registrations).toBe(0);
  });
});
