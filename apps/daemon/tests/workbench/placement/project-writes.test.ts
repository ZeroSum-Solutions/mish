import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCoordinatedProjectWrites, type PlacementFinalIO } from '../../../src/workbench/placement/project-writes.js';
import { PlacementProjectRegistry, type PlacementProjectSource } from '../../../src/workbench/placement/project-registry.js';
import { PlacementRunLifetime } from '../../../src/workbench/placement/run-lifetime.js';
import { attachPlacementRuntime } from '../../../src/workbench/placement/runtime.js';
import { mapPlacementFailure } from '../../../src/workbench/placement/runtime-status.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementWriteCoordinator } from '../../../src/workbench/placement/write-coordinator.js';

/**
 * Common admission/final-I/O adapter for standalone manual project-file
 * writers. Real managed/imported directories and bytes; the coordinated owner
 * binding is injected (synthetic), never Darwin product custody — the actual
 * native owner path is covered in runtime.test.ts.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const outcome = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'admitted', (error: { code?: string }) => error.code ?? String(error)),
  new Promise(resolve => setTimeout(() => resolve('pending'), 200))]);

function coordinated(initial: Record<string, PlacementProjectSource['metadata'] | undefined> = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-project-writes-'))); roots.push(root);
  const projects = path.join(root, 'data', 'projects'), external = path.join(root, 'external');
  mkdirSync(projects, { recursive: true }); mkdirSync(path.join(external, 'outer', 'inner'), { recursive: true });
  const sources = new Map<string, PlacementProjectSource>();
  for (const [id, metadata] of Object.entries(initial)) sources.set(id, { id, ...(metadata ? { metadata } : {}) });
  const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
  registry.load();
  const state = { held: true, blocked: [] as string[], recovery: 'ready' as 'ready' | 'required' };
  const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: path.join(root, 'owner'), inspect: () => ({ held: state.held, qualified: true }),
    readPreviousIncarnationRecovery: () => { if (state.recovery !== 'ready') throw new Error('unresolved prior launch'); return { blockedProjectRoots: registry.mapBlockedRoots(state.blocked) }; } });
  const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: registry.resolveProjectRoot, observeProjectRoot: registry.observeProjectRoot });
  registry.attach(coordinator);
  const writes = createCoordinatedProjectWrites({ coordinator, registry });
  const imported = (id: string, dir: string) => { sources.set(id, { id, metadata: { baseDir: dir } }); return dir; };
  const managed = (id: string) => { sources.set(id, { id }); return path.join(projects, id); };
  return { root, projects, external, sources, registry, coordinator, state, writes, imported, managed };
}
/** The helper-side contract: check immediately before each actual mutation. */
async function save(io: PlacementFinalIO, dir: string, name: string, bytes: string) {
  io.assertCurrent(); await mkdir(dir, { recursive: true });
  io.assertCurrent(); await writeFile(path.join(dir, name), bytes);
}

describe('coordinated project writes (standalone manual operations)', () => {
  it('ordinary managed and imported saves land; a project created after boot registers before admission', async () => {
    const f = coordinated(); expect(f.registry.registrations()).toHaveLength(0);
    const managedRoot = f.managed('managed'); const importedRoot = f.imported('imported', path.join(f.external, 'outer'));
    await f.writes.run('managed', io => save(io, managedRoot, 'page.html', 'managed bytes'));
    await f.writes.run('imported', io => save(io, importedRoot, 'page.html', 'imported bytes'));
    expect(readFileSync(path.join(managedRoot, 'page.html'), 'utf8')).toBe('managed bytes');
    expect(readFileSync(path.join(importedRoot, 'page.html'), 'utf8')).toBe('imported bytes');
    expect(f.registry.describe('imported')).toMatchObject({ kind: 'imported', physicalRoot: importedRoot });
    expect(f.registry.describe('managed')).toMatchObject({ kind: 'managed', physicalRoot: managedRoot });
    expect(f.coordinator.snapshot()).toMatchObject({ registrations: 0, mode: 'open' });
  });
  it('a held lease excludes placement and serializes nested/aliased roots until it settles', async () => {
    const f = coordinated(); const outer = f.imported('outer', path.join(f.external, 'outer'));
    f.imported('inner', path.join(f.external, 'outer', 'inner'));
    symlinkSync(outer, path.join(f.root, 'alias')); f.imported('alias', path.join(f.root, 'alias'));
    for (const id of ['outer', 'inner', 'alias']) await f.writes.run(id, async () => undefined); // register all first
    const lease = await f.writes.admit('outer'); const shared = path.join(f.external, 'outer', 'inner', 'shared.txt'); const order: string[] = [];
    await expect(f.coordinator.acquirePlacement({ projectRoots: ['inner'] })).rejects.toMatchObject({ code: 'COORDINATOR_BUSY' });
    const inner = f.writes.run('inner', async io => { order.push('inner-admitted'); io.assertCurrent(); await writeFile(shared, 'inner'); });
    const alias = f.writes.run('alias', async () => { order.push('alias-admitted'); });
    expect(await outcome(inner)).toBe('pending');
    await lease.write(async io => { io.assertCurrent(); await writeFile(shared, 'outer'); order.push('outer-bytes'); });
    await ticks(); expect(order).toEqual(['outer-bytes']); // accepted write settled, lease still held
    await lease.settle(); await inner; await alias;
    expect(order[0]).toBe('outer-bytes'); expect(order.slice(1).sort()).toEqual(['alias-admitted', 'inner-admitted']);
    expect(readFileSync(shared, 'utf8')).toBe('inner');
  });
  it('response cancellation and a drained registry replacement do not kill accepted work; the lease holds until settled', async () => {
    const f = coordinated(); const dir = f.imported('kept', path.join(f.external, 'outer', 'inner'));
    const caller = new AbortController(); const lease = await f.writes.admit('kept', { signal: caller.signal });
    const hold = deferred(); const order: string[] = [];
    const accepted = lease.write(async io => { await hold.promise; io.assertCurrent(); await writeFile(path.join(dir, 'kept.txt'), 'accepted'); order.push('accepted-bytes'); });
    caller.abort();
    // An overlapping new registration needs a globally drained epoch replacement.
    f.imported('outer', path.join(f.external, 'outer')); const epoch = f.registry.epoch;
    const replacement = f.registry.registerProject('outer').then(() => { order.push('replaced'); });
    await ticks(); expect(order).toEqual([]);
    hold.resolve(); await accepted; await ticks(); expect(order).toEqual(['accepted-bytes']);
    await lease.settle(); await replacement;
    expect(order).toEqual(['accepted-bytes', 'replaced']); expect(f.registry.epoch).toBe(epoch + 1);
    expect(readFileSync(path.join(dir, 'kept.txt'), 'utf8')).toBe('accepted');
    await expect(lease.write(async () => 'late')).rejects.toMatchObject({ code: 'PERMIT_RELEASED' });
    await expect(lease.settle()).resolves.toBeUndefined();
  });
  it.each([
    { case: 'owner loss', drift: (f: ReturnType<typeof coordinated>) => { f.state.held = false; }, code: 'OWNER_UNQUALIFIED' },
    { case: 'unresolved recovery', drift: (f: ReturnType<typeof coordinated>) => { f.state.recovery = 'required'; }, code: 'OWNER_RECOVERING' },
    { case: 'a recovery fence over the physical root', drift: (f: ReturnType<typeof coordinated>) => { f.state.blocked.push(path.join(f.external, 'outer', 'inner')); }, code: 'PROJECT_RECOVERING' },
  ])('$case across awaited work refuses the final bytes (503)', async ({ drift, code }) => {
    const f = coordinated(); const dir = f.imported('imported', path.join(f.external, 'outer', 'inner')); let refusal: unknown;
    await f.writes.run('imported', async io => { await ticks(); drift(f); await save(io, dir, 'late.txt', 'late'); }).catch(error => { refusal = error; });
    expect(refusal).toMatchObject({ code }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 503, details: { reason: code } });
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false);
  });
  it.each([
    { case: 'authorized metadata retargeted to another root', drift: (f: ReturnType<typeof coordinated>) => { f.imported('imported', path.join(f.external, 'elsewhere')); mkdirSync(path.join(f.external, 'elsewhere')); } },
    { case: 'physical root replaced at the same path', drift: (f: ReturnType<typeof coordinated>) => { renameSync(path.join(f.external, 'outer'), path.join(f.external, 'moved')); mkdirSync(path.join(f.external, 'outer')); } },
    { case: 'project no longer authorized', drift: (f: ReturnType<typeof coordinated>) => { f.sources.delete('imported'); } },
  ])('CURRENT authority drift ($case) refuses the final bytes (409)', async ({ drift }) => {
    const f = coordinated(); const dir = f.imported('imported', path.join(f.external, 'outer')); let refusal: unknown;
    await f.writes.run('imported', async io => { await ticks(); drift(f); await save(io, dir, 'late.txt', 'late'); }).catch(error => { refusal = error; });
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 409 });
    for (const candidate of ['outer', 'moved', 'elsewhere']) expect(existsSync(path.join(f.external, candidate, 'late.txt'))).toBe(false);
  });
  it('a managed root created inside the accepted write pins its identity; replacing it before the final write refuses', async () => {
    const f = coordinated(); const dir = f.managed('fresh'); let refusal: unknown;
    await f.writes.run('fresh', async io => {
      await save(io, dir, 'first.txt', 'created');
      renameSync(dir, `${dir}-moved`); mkdirSync(dir);
      io.assertCurrent(); await writeFile(path.join(dir, 'second.txt'), 'replaced');
    }).catch(error => { refusal = error; });
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    expect(readFileSync(path.join(`${dir}-moved`, 'first.txt'), 'utf8')).toBe('created');
    expect(existsSync(path.join(dir, 'second.txt'))).toBe(false);
  });
  it('a held lease keeps the first identity of a root created inside it; a replacement between writes refuses later writes (409)', async () => {
    const f = coordinated(); const dir = f.managed('absent'); expect(existsSync(dir)).toBe(false);
    const lease = await f.writes.admit('absent');
    await lease.write(io => save(io, dir, 'first.txt', 'created')); // final guard runs after mkdir: identity observed
    const identity = (target: string) => { const s = statSync(target, { bigint: true }); return { device: String(s.dev), inode: String(s.ino) }; };
    const original = identity(dir);
    renameSync(dir, `${dir}-moved`); mkdirSync(dir); // distinct physical root at the same canonical path, lease still held
    const replacement = identity(dir); expect(replacement).not.toEqual(original); expect(identity(`${dir}-moved`)).toEqual(original);
    let refusal: unknown;
    await lease.write(async io => { io.assertCurrent(); await writeFile(path.join(dir, 'second.txt'), 'replaced'); }).catch(error => { refusal = error; });
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 409 });
    expect(readdirSync(dir)).toEqual([]); expect(readFileSync(path.join(`${dir}-moved`, 'first.txt'), 'utf8')).toBe('created');
    console.log(`[identity-evidence] ${JSON.stringify({ original, replacement, replacementEntries: readdirSync(dir), retained: 'first.txt' })}`);
    await lease.settle();
  });
  it('a pending admission is cancellable by its caller; a drain-induced close is retryable 503', async () => {
    const f = coordinated(); f.imported('busy', path.join(f.external, 'outer', 'inner'));
    const lease = await f.writes.admit('busy');
    const caller = new AbortController(); const cancelled = f.writes.admit('busy', { signal: caller.signal }).catch(error => error);
    const closedByDrain = f.writes.admit('busy').catch(error => error);
    await ticks(); caller.abort();
    expect(await cancelled).toMatchObject({ code: 'ADMISSION_CANCELLED' });
    f.imported('outer', path.join(f.external, 'outer')); const replacement = f.registry.registerProject('outer');
    const refused = await closedByDrain; expect(refused).toMatchObject({ code: 'ADMISSION_CLOSED' }); expect(mapPlacementFailure(refused)).toMatchObject({ status: 503 });
    await lease.settle(); await replacement;
  });
  it('nested standalone admission inside an accepted write refuses before registration instead of deadlocking', async () => {
    const f = coordinated(); f.imported('outer', path.join(f.external, 'outer')); f.imported('inner', path.join(f.external, 'outer', 'inner'));
    const epoch = f.registry.epoch;
    expect(await outcome(f.writes.run('outer', () => f.writes.admit('outer')))).toBe('COORDINATOR_BUSY');
    expect(await outcome(f.writes.run('outer', () => f.writes.admit('inner')))).toBe('COORDINATOR_BUSY');
    expect(f.registry.describe('outer').projectId).toBe('outer'); expect(() => f.registry.describe('inner')).toThrow();
    expect(f.registry.epoch).toBe(epoch); expect(f.coordinator.snapshot().registrations).toBe(0);
  });
});

describe('review corrections: pending cancellation, allocation nesting, pre-callback drift', () => {
  it('an already-aborted admission refuses before registration or any global close', async () => {
    const f = coordinated(); f.imported('inner', path.join(f.external, 'outer', 'inner'));
    const held = await f.writes.admit('inner');
    f.imported('outer', path.join(f.external, 'outer')); const epoch = f.registry.epoch; // would need a drained replacement
    const caller = new AbortController(); caller.abort();
    const attempt = f.writes.admit('outer', { signal: caller.signal });
    try {
      expect(await outcome(attempt)).toBe('ADMISSION_CANCELLED');
      expect(f.coordinator.snapshot().mode).toBe('open'); expect(f.registry.epoch).toBe(epoch);
      expect(() => f.registry.describe('outer')).toThrow();
      const free = f.managed('free'); await f.writes.run('free', io => save(io, free, 'free.txt', 'free')); // admission stayed open
      expect(readFileSync(path.join(free, 'free.txt'), 'utf8')).toBe('free');
    } finally { await held.settle(); await attempt.catch(() => undefined); }
  });
  it('abort while registration drains or waits in the serial queue refuses promptly; accepted work and the begun drain still settle', async () => {
    const f = coordinated(); const innerDir = f.imported('inner', path.join(f.external, 'outer', 'inner'));
    const held = await f.writes.admit('inner'); const hold = deferred();
    const accepted = held.write(async io => { await hold.promise; io.assertCurrent(); await writeFile(path.join(innerDir, 'accepted.txt'), 'accepted'); });
    f.imported('outer', path.join(f.external, 'outer')); f.managed('queued');
    const draining = new AbortController(), queued = new AbortController();
    const replacing = f.writes.admit('outer', { signal: draining.signal }); await ticks();
    const waiting = f.writes.admit('queued', { signal: queued.signal }); await ticks();
    expect(f.coordinator.snapshot().mode).toBe('closed'); // the overlapping replacement began its drain
    try {
      draining.abort(); queued.abort();
      expect(await outcome(replacing)).toBe('ADMISSION_CANCELLED');
      expect(await outcome(waiting)).toBe('ADMISSION_CANCELLED');
      expect(f.coordinator.snapshot().mode).toBe('closed'); // no premature reopen while the accepted lease lives
    } finally {
      hold.resolve(); await accepted; await held.settle();
      await replacing.catch(() => undefined); await waiting.catch(() => undefined);
    }
    expect(readFileSync(path.join(innerDir, 'accepted.txt'), 'utf8')).toBe('accepted');
    for (let i = 0; i < 50 && f.coordinator.snapshot().mode !== 'open'; i++) await ticks();
    // The begun drain completed with current registry authority; the cancelled queued registration had no effect.
    expect(f.coordinator.snapshot()).toMatchObject({ mode: 'open', registrations: 0 });
    expect(f.registry.describe('inner').gateKey).toBe(path.join(f.external, 'outer'));
    expect(() => f.registry.describe('queued')).toThrow();
  });
  it('fresh admission from an admitted run allocation refuses; the run reuses its own permit and reserved cleanup', async () => {
    const f = coordinated(); const dir = f.imported('alloc', path.join(f.external, 'outer'));
    await f.writes.run('alloc', async () => undefined);
    // Actual run wrapper; allocation and project writes never touch the supervisor.
    const lifetime = new PlacementRunLifetime({ coordinator: f.coordinator, supervisor: {} as never, physicalRoots: () => [] });
    const run = await lifetime.admit({ projectIds: ['alloc'] }); const nested = new AbortController();
    const cleanupBytes = path.join(f.root, 'cleanup.txt'), runBytes = path.join(dir, 'run.txt');
    const probe = run.allocate(() => f.writes.admit('alloc', { signal: nested.signal }));
    try {
      expect(await outcome(probe)).toBe('COORDINATOR_BUSY');
      await run.allocate(async () => {
        const cleanup = run.reserveFinal('cleanup');
        await cleanup.dataRootWrite(async guard => { guard.assertCurrent(); await writeFile(cleanupBytes, 'cleanup'); });
        cleanup.settle();
      });
      await run.start();
      await run.projectWrite('alloc', async guard => { guard.assertCurrent(); await writeFile(runBytes, 'run'); });
    } finally { nested.abort(); await probe.catch(() => undefined); await run.finish(); }
    expect(readFileSync(cleanupBytes, 'utf8')).toBe('cleanup'); expect(readFileSync(runBytes, 'utf8')).toBe('run');
    await f.writes.run('alloc', io => save(io, dir, 'after.txt', 'after'));
    expect(readFileSync(path.join(dir, 'after.txt'), 'utf8')).toBe('after');
  });
  it('authority drift after admission but before the first write is a 409 scope change before any callback or bytes', async () => {
    const f = coordinated(); const dir = f.imported('drift', path.join(f.external, 'outer')); const elsewhere = path.join(f.external, 'elsewhere');
    const lease = await f.writes.admit('drift'); let entered = false; let refusal: unknown;
    try {
      mkdirSync(elsewhere); f.imported('drift', elsewhere);
      await lease.write(async io => { entered = true; await save(io, dir, 'late.txt', 'late'); await save(io, elsewhere, 'late.txt', 'late'); }).catch(error => { refusal = error; });
    } finally { await lease.settle(); }
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 409 });
    expect(entered).toBe(false);
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false); expect(existsSync(path.join(elsewhere, 'late.txt'))).toBe(false);
  });
  it('controls: recovery loss before the first write stays 503; initial invalid input and writes outside admitted inputs stay INVALID_PROJECT_ROOT', async () => {
    const f = coordinated(); const dir = f.imported('owned', path.join(f.external, 'outer'));
    const lease = await f.writes.admit('owned'); f.state.recovery = 'required'; let refusal: unknown;
    try { await lease.write(io => save(io, dir, 'late.txt', 'late')).catch(error => { refusal = error; }); } finally { await lease.settle(); }
    expect(refusal).toMatchObject({ code: 'OWNER_RECOVERING' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 503 });
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false);

    const g = coordinated(); g.imported('missing', path.join(g.external, 'missing')); let initial: unknown;
    await g.writes.admit('missing').catch(error => { initial = error; });
    expect(initial).toMatchObject({ code: 'INVALID_PROJECT_ROOT' }); expect(mapPlacementFailure(initial)).toBeNull();
    g.imported('admitted', path.join(g.external, 'outer')); await g.registry.registerProject('admitted');
    const permit = await g.coordinator.acquireMutation({ projectRoots: ['admitted'] }); let outside: unknown;
    try { await g.coordinator.withProjectWrite(permit, 'unregistered', async () => undefined).catch(error => { outside = error; }); }
    finally { g.coordinator.releaseMutation(permit); }
    expect(outside).toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
  });
});

describe('ordinary runtime project writes (fence-only, no coordinator)', () => {
  /** Synthetic C2a transition record: one unfinished placement fence over a real root. */
  function ordinary() {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-ordinary-writes-'))); roots.push(root);
    const projectsDir = path.join(root, 'data', 'projects'), fenced = path.join(root, 'fenced'), free = path.join(root, 'free');
    for (const dir of [projectsDir, fenced, free]) mkdirSync(dir, { recursive: true });
    const sources = new Map<string, PlacementProjectSource>([['managed', { id: 'managed' }], ['imported', { id: 'imported', metadata: { baseDir: free } }]]);
    const runtime = attachPlacementRuntime({
      mode: 'ordinary-uncoordinated', reason: 'not-activated', hostFact: null,
      host: { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true },
      transition: { kind: 'inspected', global: null, unresolvedLaunches: [], fencedProjectRoots: [fenced], sidecars: { before: null, after: null } },
    }, { db: null as never, projectsDir, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
    return { runtime, sources, projectsDir, fenced, free };
  }
  it('managed and imported saves keep ordinary behavior', async () => {
    const o = ordinary(); expect(o.runtime.coordinator).toBeNull();
    await o.runtime.projectWrites.run('managed', io => save(io, path.join(o.projectsDir, 'managed'), 'page.html', 'managed bytes'));
    await o.runtime.projectWrites.run('imported', io => save(io, o.free, 'page.html', 'imported bytes'));
    expect(readFileSync(path.join(o.projectsDir, 'managed', 'page.html'), 'utf8')).toBe('managed bytes');
    expect(readFileSync(path.join(o.free, 'page.html'), 'utf8')).toBe('imported bytes');
  });
  it('a fenced project refuses admission; CURRENT metadata moving into a fence refuses the final bytes', async () => {
    const o = ordinary(); o.sources.set('inside', { id: 'inside', metadata: { baseDir: o.fenced } });
    await expect(o.runtime.projectWrites.admit('inside')).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    let refusal: unknown;
    await o.runtime.projectWrites.run('imported', async io => {
      await ticks(); o.sources.set('imported', { id: 'imported', metadata: { baseDir: o.fenced } });
      await save(io, o.fenced, 'late.txt', 'late');
    }).catch(error => { refusal = error; });
    expect(mapPlacementFailure(refusal)).toMatchObject({ status: 503, details: { reason: 'PROJECT_RECOVERING' } });
    expect(existsSync(path.join(o.fenced, 'late.txt'))).toBe(false);
  });
});
