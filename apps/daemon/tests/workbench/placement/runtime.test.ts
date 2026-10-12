import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInternalRunCreationService } from '../../../src/services/internal-run-service.js';
import { migratePlacementJournal, PlacementJournal } from '../../../src/workbench/placement/journal.js';
import { assertPlacementOwnedBeforeEagerInitialization, placementOwnerAcquisitions, preparePlacementBootstrap, type PlacementBootstrap } from '../../../src/workbench/placement/owner-bootstrap.js';
import type { AdmittedPlacementRun } from '../../../src/workbench/placement/run-lifetime.js';
import { attachPlacementRuntime, observeNamedRegularFile, type PlacementRuntime } from '../../../src/workbench/placement/runtime.js';
import {
  createDarwinProcessInspector, DARWIN_SAMPLED_TREE_LIMIT, readOwnedMembers,
  type PlacementProcessInspector, type PlacementTreeCompleteness, type ProcessTable,
} from '../../../src/workbench/placement/supervisor.js';
import { buildOwnerFixture, nativeSupported, ownerEnv, rootParent, TSX_ESM, type OwnerFixture } from './runtime-fixture.js';
import { pathToFileURL } from 'node:url';

/** Actual prior incarnation in an owned child process, SIGKILLed after it reports its scenario. */
async function priorIncarnation(config: Record<string, unknown>): Promise<Record<string, any>> {
  // One process (no tsx CLI wrapper): the SIGKILL must hit the incarnation that holds the owner.
  const child = spawn(process.execPath, ['--import', pathToFileURL(TSX_ESM).href, new URL('./runtime-incarnation-fixture.ts', import.meta.url).pathname, JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  created.push(child.pid!);
  const report = await new Promise<string>((resolve, reject) => { let buf = ''; child.stdout!.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); }); child.once('exit', code => reject(new Error(`fixture exited ${code}`))); });
  const exited = exitOf(child); process.kill(child.pid!, 'SIGKILL'); expect((await exited).signal).toBe('SIGKILL');
  const parsed = JSON.parse(report); expect(parsed.fixturePid).toBe(child.pid);
  for (const pid of [parsed.descendant, parsed.helperPid]) if (pid) created.push(pid);
  return parsed;
}

const created: number[] = [];
const booted: Array<{ runtime: PlacementRuntime; db: Database.Database }> = [];
afterEach(() => {
  for (const pid of created.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const { runtime, db } of booted.splice(0)) { runtime.close(); if (db.open) db.close(); }
});
/** Synthetic completeness proof: no production provider exists on this platform. */
const syntheticComplete: PlacementTreeCompleteness = { prove: () => ({ kind: 'complete', evidence: { synthetic: true } }) };
const sources = [{ id: 'p1' }, { id: 'p2' }];
function boot(bootstrap: PlacementBootstrap, extra: Partial<Parameters<typeof attachPlacementRuntime>[1]> = {}) {
  if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
  const db = new Database(join(bootstrap.canonicalDataRoot, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
  const projectsDir = join(bootstrap.canonicalDataRoot, 'projects');
  for (const s of sources) mkdirSync(join(projectsDir, s.id), { recursive: true });
  const runtime = attachPlacementRuntime(bootstrap, { db, projectsDir, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources, ...extra });
  booted.push({ runtime, db }); return { runtime, db };
}
async function shutdown(entry: { runtime: PlacementRuntime; db: Database.Database }) {
  entry.runtime.close(); entry.db.close(); booted.splice(booted.indexOf(entry), 1);
}
const exitOf = (child: ChildProcess) => new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
async function gone(pid: number) { for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { return; } await new Promise(r => setTimeout(r, 10)); } throw new Error(`pid ${pid} did not exit`); }
const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Root that starts an escaping (setsid) descendant, reports its PID, and exits when stdin ends. */
const ESCAPING_ROOT = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); g.unref();
process.stdout.write(String(g.pid) + '\\n'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`;
async function launchRoot(run: AdmittedPlacementRun, script: string, kind: 'child' | 'helper' = 'child') {
  const handle = run.launch({ kind, command: process.execPath, args: ['-e', '<script>'] });
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...handle.env, PATH: process.env.PATH } });
  created.push(child.pid!);
  const identity = handle.observeSpawn(child.pid!);
  const line = await new Promise<string>(resolve => { let buf = ''; child.stdout!.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); }); });
  return { handle, child, identity, reported: line };
}

describe('placement observation primitives', () => {
  it('observes identity and bytes from one descriptor and refuses a substituted name', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'placement-observe-')));
    const location = join(dir, 'entry.tsx'); writeFileSync(location, 'abc');
    const observed = observeNamedRegularFile(location);
    expect(observed).toMatchObject({ kind: 'file', file: { sha256: createHash('sha256').update('abc').digest('hex'), byteLength: 3 } });
    writeFileSync(join(dir, 'other'), 'xyz');
    const substituted = observeNamedRegularFile(location, { beforeRevalidate: () => renameSync(join(dir, 'other'), location) });
    expect(substituted).toEqual({ kind: 'unknown' });
    symlinkSync(location, join(dir, 'link'));
    expect(observeNamedRegularFile(join(dir, 'link'))).toEqual({ kind: 'unknown' });
    expect(observeNamedRegularFile(join(dir, 'missing'))).toEqual({ kind: 'absent' });
    expect(readFileSync(location, 'utf8')).toBe('xyz');
  });
});

describe.skipIf(!nativeSupported)('actual coordinated placement runtime', () => {
  let fixture: OwnerFixture;
  beforeAll(async () => { fixture = await buildOwnerFixture('runtime'); }, 60_000);
  const bootstrapFor = (dataDir: string) => preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot: '/x' });

  it('registers versioned migrations and one incarnation after ownership; restart keeps the legacy gate', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const first = boot(bootstrapFor(dataDir));
    expect(first.runtime.status()).toMatchObject({ mode: 'coordinated-open', reason: 'owner-qualified', dataRoot: { createdThisBoot: true }, activation: { adoption: 'closed' } });
    expect(first.runtime.status().activation.gates).not.toContain('legacy-predecessor-unproven');
    expect(first.db.prepare('SELECT name, version FROM workbench_owned_migrations ORDER BY name').all()).toEqual([
      { name: 'placement-adoption', version: 1 }, { name: 'placement-journal', version: 1 }, { name: 'placement-root-seal', version: 1 },
      { name: 'placement-runtime', version: 1 }, { name: 'source-records', version: 1 }]);
    expect(Number(first.db.pragma('synchronous', { simple: true }))).toBe(2);
    await shutdown(first);
    const second = boot(bootstrapFor(dataDir));
    expect(second.runtime.status()).toMatchObject({ mode: 'coordinated-open', dataRoot: { createdThisBoot: false } });
    expect(second.runtime.status().activation.gates).toContain('legacy-predecessor-unproven');
    expect((second.db.prepare('SELECT COUNT(*) AS n FROM placement_journal_incarnations').get() as { n: number }).n).toBe(2);
  });
  it('an unversioned draft schema closes coordinated mutations without migrating', async () => {
    const bootstrap = bootstrapFor(join(await rootParent(fixture), 'data'));
    if (bootstrap.mode !== 'coordinated') throw new Error('expected owner');
    const draft = new Database(join(bootstrap.canonicalDataRoot, 'app.sqlite')); draft.pragma('journal_mode=WAL');
    draft.exec('CREATE TABLE workbench_source_meta (singleton INTEGER)'); draft.close();
    const { runtime, db } = boot(bootstrap);
    expect(runtime.status()).toMatchObject({ mode: 'coordinated-closed', reason: 'migration-unversioned-schema-present:source-records' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='workbench_owned_migrations'").all()).toEqual([]);
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/projects' })).toMatchObject({ status: 503 });
    expect(runtime.checkMutationRequest({ method: 'GET', path: '/api/projects' })).toBeNull();
  });
  it('refuses an owner acquired after the server module evaluated', async () => {
    const before = placementOwnerAcquisitions();
    const bootstrap = bootstrapFor(join(await rootParent(fixture), 'data'));
    expect(() => assertPlacementOwnedBeforeEagerInitialization(bootstrap, before)).toThrowError(expect.objectContaining({ reason: 'owner-after-eager-initialization' }));
    if (bootstrap.mode === 'coordinated') expect(bootstrap.owner.inspect().held).toBe(false);
  });

  it('a known owned descendant that escapes its group outlives the root and keeps the run fenced', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const entry = boot(bootstrapFor(dataDir));
    const run = await entry.runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
    const { handle, child, identity, reported } = await launchRoot(run, ESCAPING_ROOT);
    const descendant = Number(reported); created.push(descendant);
    expect(handle.sample().map(m => m.pid)).toContain(descendant);
    let finished = false; void run.finish().then(() => { finished = true; });
    const exited = exitOf(child); child.stdin!.end(); handle.recordExit(await exited);
    const afterRoot = handle.observeDrain();
    expect(afterRoot).toMatchObject({ state: 'pending', rootPresent: false, liveMembers: [expect.objectContaining({ pid: descendant })] });
    process.kill(descendant, 'SIGKILL'); await gone(descendant);
    expect(handle.observeDrain()).toEqual({ state: 'unproven', limit: DARWIN_SAMPLED_TREE_LIMIT, members: [expect.objectContaining({ pid: descendant, via: 'ppid' })] });
    await ticks(); expect(finished).toBe(false);
    const launch = entry.runtime.supervisor && entry.db.prepare('SELECT record_json FROM placement_journal_launches').get() as { record_json: string };
    expect(JSON.parse(launch!.record_json)).toMatchObject({ identity, exitDigest: expect.any(String), drainDigest: null });
  });
  it('process loss with an escaped descendant: the next boot keeps it fenced, and drainage stays unproven after it settles', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const prior = await priorIncarnation({ env: ownerEnv(fixture, dataDir), scenario: 'escaping' });
    const next = boot(bootstrapFor(dataDir));
    expect(next.runtime.status()).toMatchObject({ mode: 'coordinated-closed', reason: 'recovery-unresolved', recovery: { global: 'blocked', priorLaunches: [{ launchId: prior.launchId, state: 'pending-drain' }] } });
    expect(readOwnedMembers(next.db, prior.launchId).members.map(m => m.pid)).toEqual([prior.descendant]);
    expect(() => next.runtime.assertMutationAdmissible('p1')).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    expect(next.runtime.checkMutationRequest({ method: 'POST', path: '/api/projects/p1/upload' })).toMatchObject({ status: 503 });
    process.kill(prior.descendant, 'SIGKILL'); await gone(prior.descendant);
    expect(await next.runtime.refreshRecovery()).toMatchObject({ mode: 'coordinated-closed', recovery: { priorLaunches: [{ launchId: prior.launchId, state: 'drain-unproven', limit: DARWIN_SAMPLED_TREE_LIMIT }] } });
  });
  it('an owned helper that survives the root keeps its own ticket and the run unfinished', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const entry = boot(bootstrapFor(dataDir), { completeness: syntheticComplete });
    const run = await entry.runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
    const root = await launchRoot(run, `process.stdout.write('ready\\n'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`);
    const helper = await launchRoot(run, `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`, 'helper');
    let finished = false; void run.finish().then(() => { finished = true; });
    const exited = exitOf(root.child); root.child.stdin!.end(); root.handle.recordExit(await exited);
    expect(root.handle.observeDrain()).toEqual({ state: 'drained' }); // synthetic completeness only
    expect(() => helper.handle.recordExit({ code: null, signal: null })).toThrowError(expect.objectContaining({ code: 'EXIT_UNPROVEN' }));
    expect(helper.handle.observeDrain()).toMatchObject({ state: 'pending', rootPresent: true });
    await ticks(); expect(finished).toBe(false);
  });
  it('process loss with a live owned helper: the next boot is blocked while its exact identity lives', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const prior = await priorIncarnation({ env: ownerEnv(fixture, dataDir), scenario: 'helper' });
    const next = boot(bootstrapFor(dataDir));
    expect(next.runtime.status()).toMatchObject({ mode: 'coordinated-closed', recovery: { priorLaunches: [{ launchId: prior.launchId, state: 'live' }] } });
    process.kill(prior.helperPid, 'SIGKILL'); await gone(prior.helperPid);
    // Exact root absence records exit; same-boot tree completeness remains the named Darwin limit.
    expect(await next.runtime.refreshRecovery()).toMatchObject({ mode: 'coordinated-closed', recovery: { priorLaunches: [{ state: 'drain-unproven', limit: DARWIN_SAMPLED_TREE_LIMIT }] } });
    const record = JSON.parse((next.db.prepare('SELECT record_json FROM placement_journal_launches WHERE id=?').get(prior.launchId) as { record_json: string }).record_json);
    expect(record).toMatchObject({ exitDigest: expect.any(String), drainDigest: null });
  });
  it('cancellation keeps accepted final work and the child ticket until genuine settlement', async () => {
    const entry = boot(bootstrapFor(join(await rootParent(fixture), 'data')), { completeness: syntheticComplete });
    const run = await entry.runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
    const { handle, child } = await launchRoot(run, `process.stdout.write('ready\\n'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`);
    const final = run.reserveFinal('publication');
    run.cancel();
    await expect(run.projectWrite('p1', async () => 'late')).rejects.toMatchObject({ code: 'RUN_STATE' });
    await expect(final.projectWrite('p1', async () => 'accepted-final')).resolves.toBe('accepted-final');
    let finished = false; const done = run.finish().then(() => { finished = true; });
    final.settle(); await ticks(); expect(finished).toBe(false);
    expect(entry.runtime.coordinator!.snapshot().registrations).toBe(1);
    const exited = exitOf(child); child.stdin!.end(); handle.recordExit(await exited);
    expect(handle.observeDrain()).toEqual({ state: 'drained' });
    await done; expect(entry.runtime.coordinator!.snapshot().registrations).toBe(0);
  });
  it('the internal-run choke point admits before allocation and starts the frozen scope before the starter', async () => {
    const entry = boot(bootstrapFor(join(await rootParent(fixture), 'data')));
    const order: string[] = []; const physical = { id: 'run-1', status: 'queued', projectId: 'p1' };
    const service = createInternalRunCreationService({
      runs: { createOrReuse: () => { order.push(`allocate:${entry.runtime.coordinator!.snapshot().runs}`); return { kind: 'created' as const, run: physical }; },
        prepareRestart: r => r, get: () => null, drop: () => undefined, start: (r, starter) => { order.push('registry-start'); void starter(); return r; }, isTerminal: () => false },
      claimAssistantMessage: () => ({ ok: true }), analyticsLifecycle: { install: () => { order.push('analytics'); } },
      runLifetime: entry.runtime.runLifetime, assertMutationAdmissible: id => entry.runtime.assertMutationAdmissible(id),
    });
    const { prepared, admission } = await service.admitAndPrepare({ meta: { projectId: 'p1' } }, { projectIds: ['p1'] });
    expect(prepared.kind).toBe('ready'); expect(order).toEqual(['allocate:1']);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    await service.startAdmitted(physical, { requestAnalyticsContext: null } as never, async () => { order.push('starter'); await gate; }, admission);
    expect(order).toEqual(['allocate:1', 'analytics', 'registry-start', 'starter']);
    expect(entry.runtime.coordinator!.snapshot()).toMatchObject({ runs: 1 });
    release(); await ticks();
    expect(entry.runtime.coordinator!.snapshot()).toMatchObject({ runs: 1 });
    const final = admission!.reserveFinal('publication');
    const finished = admission!.finish();
    await ticks();
    expect(entry.runtime.coordinator!.snapshot()).toMatchObject({ runs: 1 });
    final.settle();
    await finished;
    expect(entry.runtime.coordinator!.snapshot().runs).toBe(0);
  });
  it('standalone project writes register a post-boot imported project; actual owned-root loss refuses the final bytes', async () => {
    const parent = await rootParent(fixture); const importedDir = join(parent, 'imported'); mkdirSync(importedDir);
    const projects = [...sources, { id: 'late', metadata: { baseDir: importedDir } }];
    const bootstrap = bootstrapFor(join(parent, 'data'));
    // Authorized only after boot: the initial registry epoch does not know it.
    let visible = false;
    const entry = boot(bootstrap, { readProject: id => projects.find(s => s.id === id && (visible || s.id !== 'late')) ?? null, listProjects: () => projects.filter(s => visible || s.id !== 'late') });
    visible = true;
    await entry.runtime.projectWrites.run('late', async io => { io.assertCurrent(); writeFileSync(join(importedDir, 'saved.txt'), 'saved'); });
    expect(readFileSync(join(importedDir, 'saved.txt'), 'utf8')).toBe('saved');
    expect(entry.runtime.registry!.describe('late')).toMatchObject({ kind: 'imported', physicalRoot: importedDir });
    if (bootstrap.mode !== 'coordinated') throw new Error('expected owner');
    const moved = `${bootstrap.canonicalDataRoot}-moved`;
    await expect(entry.runtime.projectWrites.run('late', async io => {
      await ticks(); renameSync(bootstrap.canonicalDataRoot, moved); // owned root identity lost across awaited work
      io.assertCurrent(); writeFileSync(join(importedDir, 'late.txt'), 'late');
    })).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(readFileSync(join(importedDir, 'saved.txt'), 'utf8')).toBe('saved');
    expect(() => readFileSync(join(importedDir, 'late.txt'))).toThrow();
    expect(entry.runtime.status()).toMatchObject({ mode: 'coordinated-closed', reason: 'owner-lost' });
    renameSync(moved, bootstrap.canonicalDataRoot);
  });
});

/** Injected inspector over a scripted process table (synthetic facts, not host observations). */
function scripted(boot: string, tables: ProcessTable[]): PlacementProcessInspector {
  let i = 0; return { bootId: () => boot, table: () => tables[Math.min(i++, tables.length - 1)]! };
}
describe.skipIf(!nativeSupported)('exact identity rules with injected process tables', () => {
  let fixture: OwnerFixture;
  beforeAll(async () => { fixture = await buildOwnerFixture('identity'); }, 60_000);
  const BOOT = '11111111-2222-3333-4444-555555555555';
  it('a reused PID with another birth is the exact identity absent; the full tuple must match', async () => {
    const bootstrap = preparePlacementBootstrap({ env: ownerEnv(fixture, join(await rootParent(fixture), 'data')), projectRoot: '/x' });
    const live = { pid: 4242, ppid: 1, pgid: 4242, startToken: 'ps-lstart-100', zombie: false };
    const reused = { ...live, startToken: 'ps-lstart-200' };
    const tables: ProcessTable[] = [{ kind: 'table', entries: [live] }];
    const entry = boot(bootstrap, { inspector: { bootId: () => BOOT, table: () => tables[0]! } });
    const run = await entry.runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
    const handle = run.launch({ kind: 'child', command: 'scripted' });
    const identity = handle.observeSpawn(4242);
    expect(() => handle.recordExit({ code: 0, signal: null })).toThrowError(expect.objectContaining({ code: 'EXIT_UNPROVEN' }));
    tables[0] = { kind: 'table', entries: [reused] };
    handle.recordExit({ code: 0, signal: null });
    const record = JSON.parse((entry.db.prepare('SELECT record_json FROM placement_journal_launches').get() as { record_json: string }).record_json);
    expect(record.identity).toEqual(identity); expect(record.exitDigest).toMatch(/^[a-f0-9]{64}$/);
    // A reused PID leading its own group is over-attributed to the tree: drainage stays pending.
    expect(handle.observeDrain()).toMatchObject({ state: 'pending', liveMembers: [expect.objectContaining({ pid: 4242, startToken: 'ps-lstart-200', via: 'pgid' })] });
  });
  it('journal facts bind the full pid/boot/start/handshake tuple', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'placement-tuple-')), 'tuple.sqlite'));
    db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON'); migratePlacementJournal(db);
    const journal = new PlacementJournal({ db, incarnationId: 'tuple' }); const digest = 'a'.repeat(64);
    const identity = { pid: 5, bootId: BOOT, startToken: 'ps-lstart-5', handshakeId: 'handshake-a' };
    journal.recordLaunchIntent({ launchId: 'standalone-preparation', kind: 'helper', projectRoots: [], intentDigest: digest });
    journal.observeLaunch('standalone-preparation', identity, digest);
    for (const field of ['handshakeId', 'startToken', 'bootId'] as const) {
      expect(() => journal.recordLaunchExit('standalone-preparation', { ...identity, [field]: `${identity[field]}-other` }, digest)).toThrowError(expect.objectContaining({ code: 'IDENTITY_CONFLICT' }));
    }
    expect(() => journal.recordLaunchDrain('standalone-preparation', identity, digest)).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    db.close();
  });
  it('unobservable or uncertain inventory fails closed for spawn, exit, drain and recovery', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const unknown: ProcessTable = { kind: 'unknown', reason: 'ps-failed' };
    const entry = boot(preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot: '/x' }),
      { inspector: scripted(BOOT, [{ kind: 'table', entries: [{ pid: 77, ppid: 1, pgid: 77, startToken: 'ps-lstart-1', zombie: false }] }, unknown]) });
    const run = await entry.runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
    const handle = run.launch({ kind: 'child', command: 'scripted' }); handle.observeSpawn(77);
    expect(() => handle.sample()).toThrowError(expect.objectContaining({ code: 'INVENTORY_UNKNOWN' }));
    expect(() => handle.recordExit({ code: 0, signal: null })).toThrowError(expect.objectContaining({ code: 'EXIT_UNPROVEN' }));
    expect(handle.observeDrain()).toEqual({ state: 'unknown', reason: 'ps-failed' });
    const unobserved = run.launch({ kind: 'helper', command: 'never-spawned' });
    expect(() => unobserved.observeSpawn(78)).toThrowError(expect.objectContaining({ code: 'SPAWN_UNOBSERVED' }));
  });
  it('after process loss, unobservable inventory and unknown spawns stay closed', async () => {
    const unknown: ProcessTable = { kind: 'unknown', reason: 'ps-failed' };
    const scriptedRoot = join(await rootParent(fixture), 'data');
    const spawned = await priorIncarnation({ env: ownerEnv(fixture, scriptedRoot), scenario: 'scripted-spawn', boot: BOOT, table: { kind: 'table', entries: [{ pid: 77, ppid: 1, pgid: 77, startToken: 'ps-lstart-1', zombie: false }] } });
    const next = boot(preparePlacementBootstrap({ env: ownerEnv(fixture, scriptedRoot), projectRoot: '/x' }), { inspector: scripted(BOOT, [unknown]) });
    expect(next.runtime.status()).toMatchObject({ mode: 'coordinated-closed', recovery: { priorLaunches: [{ launchId: spawned.launchId, state: 'unobservable' }] } });
    const unspawnedRoot = join(await rootParent(fixture), 'data');
    const unspawned = await priorIncarnation({ env: ownerEnv(fixture, unspawnedRoot), scenario: 'unknown-spawn' });
    const after = boot(preparePlacementBootstrap({ env: ownerEnv(fixture, unspawnedRoot), projectRoot: '/x' }));
    expect(after.runtime.status()).toMatchObject({ mode: 'coordinated-closed', recovery: { priorLaunches: [{ launchId: unspawned.launchId, state: 'unknown-spawn' }] } });
    expect((await after.runtime.refreshRecovery()).mode).toBe('coordinated-closed');
  });
  it('a changed boot session proves the whole prior tree gone (synthetic boot ids)', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const prior = await priorIncarnation({ env: ownerEnv(fixture, dataDir), scenario: 'scripted-spawn', boot: BOOT, table: { kind: 'table', entries: [{ pid: 90, ppid: 1, pgid: 90, startToken: 'ps-lstart-9', zombie: false }] } });
    const rebooted = boot(preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot: '/x' }), { inspector: scripted('99999999-2222-3333-4444-555555555555', [{ kind: 'table', entries: [] }]) });
    expect(rebooted.runtime.status()).toMatchObject({ mode: 'coordinated-open', recovery: { global: 'clear', priorLaunches: [{ launchId: prior.launchId, state: 'drained' }] } });
  });
});

describe.skipIf(!nativeSupported)('actual Darwin process inspector', () => {
  it('reports this process exactly and stable boot identity', () => {
    const inspector = createDarwinProcessInspector();
    const table = inspector.table();
    expect(table.kind).toBe('table');
    if (table.kind === 'table') expect(table.entries.find(e => e.pid === process.pid)).toMatchObject({ startToken: expect.stringMatching(/^ps-lstart-\d+$/) });
    expect(inspector.bootId()).toMatch(/^[A-F0-9-]{36}$/i);
  });
});
