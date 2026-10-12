import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunProjectWriteBorrower, type BorrowableRunAdmission } from '../../src/routes/project/index.js';
import { ToolTokenRegistry } from '../../src/tool-tokens.js';
import { createCoordinatedProjectWrites, type PlacementFinalIO } from '../../src/workbench/placement/project-writes.js';
import { PlacementProjectRegistry, type PlacementProjectSource } from '../../src/workbench/placement/project-registry.js';
import { PlacementRunLifetime } from '../../src/workbench/placement/run-lifetime.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementWriteCoordinator } from '../../src/workbench/placement/write-coordinator.js';

/**
 * B1: an admitted run holds its project gate until it drains. Its own child's
 * `od files` HTTP request must borrow that run's permit (registry-validated
 * bearer grant, same run and project) instead of re-admitting against the
 * held gate. Real coordinator, registry and tool-token registry; the owner
 * binding is injected (synthetic), never Darwin product custody.
 */
const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const outcome = (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'admitted', (error: { code?: string }) => error.code ?? String(error)),
  new Promise(resolve => setTimeout(() => resolve('pending'), 200)),
]);
async function save(io: PlacementFinalIO, dir: string, name: string, bytes: string) {
  io.assertCurrent(); await mkdir(dir, { recursive: true });
  io.assertCurrent(); await writeFile(path.join(dir, name), bytes);
}
function request(authorization?: string, body: unknown = {}): Request {
  return { get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined), body } as unknown as Request;
}
interface TestRun { id: string; projectId: string; status: string }

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-run-borrow-'))); roots.push(root);
  const projects = path.join(root, 'data', 'projects'); mkdirSync(projects, { recursive: true });
  const sources = new Map<string, PlacementProjectSource>([['p1', { id: 'p1' }], ['p2', { id: 'p2' }]]);
  const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
  registry.load();
  const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: path.join(root, 'owner'), inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: [] }) });
  const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: registry.resolveProjectRoot, observeProjectRoot: registry.observeProjectRoot });
  registry.attach(coordinator);
  const standalone = createCoordinatedProjectWrites({ coordinator, registry });
  // Register both projects outside any permit before runs hold their gates.
  await standalone.run('p1', async () => undefined); await standalone.run('p2', async () => undefined);
  const lifetime = new PlacementRunLifetime({ coordinator, supervisor: {} as never, physicalRoots: ids => ids.map(id => registry.describe(id).physicalRoot) });
  const tokens = new ToolTokenRegistry();
  const runs = new Map<string, TestRun>();
  const admissions = new Map<TestRun, BorrowableRunAdmission & { cancel(): void; finish(): Promise<void> }>();
  const admitRun = async (id: string, projectId: string) => {
    const run: TestRun = { id, projectId, status: 'running' };
    const admission = await lifetime.admit({ projectIds: [projectId] }); await admission.start();
    runs.set(id, run); admissions.set(run, admission);
    cleanups.push(async () => { try { admission.cancel(); } catch { /* released */ } await admission.finish(); });
    return { run, admission, token: tokens.mint({ runId: id, projectId }).token };
  };
  const borrower = createRunProjectWriteBorrower<TestRun>({
    registry: tokens, getRun: id => runs.get(id) ?? null, isTerminal: status => TERMINAL.has(status), admissionOf: run => admissions.get(run) ?? null,
  });
  cleanups.push(() => tokens.clear());
  return { projects, coordinator, standalone, tokens, runs, admissions, admitRun, borrower, dir: (id: string) => path.join(projects, id) };
}

describe('a run’s own project write borrows its admitted permit (B1)', () => {
  it('without borrowing the run’s own write waits on the gate the run holds; the same-run grant lands while the run keeps it', async () => {
    const f = await fixture();
    const { token } = await f.admitRun('run-1', 'p1');
    const abort = new AbortController();
    const standalone = f.standalone.run('p1', io => save(io, f.dir('p1'), 'blocked.txt', 'never'), { signal: abort.signal });
    expect(await outcome(standalone)).toBe('pending'); // the deadlock shape: the run's child waits on its own run
    const borrowed = f.borrower(request(`Bearer ${token}`), 'p1');
    expect(borrowed).not.toBeNull();
    await borrowed!.run('p1', io => save(io, f.dir('p1'), 'page.html', 'run bytes'));
    expect(readFileSync(path.join(f.dir('p1'), 'page.html'), 'utf8')).toBe('run bytes');
    const lease = await borrowed!.admit('p1');
    await lease.write(io => save(io, f.dir('p1'), 'upload.bin', 'chunk'));
    await lease.settle();
    expect(existsSync(path.join(f.dir('p1'), 'upload.bin'))).toBe(true);
    abort.abort();
    expect(await outcome(standalone)).toBe('ADMISSION_CANCELLED');
    expect(existsSync(path.join(f.dir('p1'), 'blocked.txt'))).toBe(false);
  });

  it('forged, missing, body-named and wrong-run/wrong-project grants never borrow', async () => {
    const f = await fixture();
    const { token } = await f.admitRun('run-1', 'p1');
    const other = await f.admitRun('run-2', 'p2');
    expect(f.borrower(request(), 'p1')).toBeNull();
    expect(f.borrower(request('Bearer odtt_forged-token'), 'p1')).toBeNull();
    expect(f.borrower(request(undefined, { runId: 'run-1', projectId: 'p1' }), 'p1')).toBeNull();
    expect(f.borrower(request(`Bearer ${other.token}`), 'p1')).toBeNull(); // another run's grant
    expect(f.borrower(request(`Bearer ${token}`), 'p2')).toBeNull(); // this run, another project
    const borrowed = f.borrower(request(`Bearer ${token}`), 'p1')!;
    await expect(borrowed.run('p2', async () => undefined)).rejects.toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
  });

  it('revocation or expiry refuses before effects; a draining or terminal run cannot lend', async () => {
    const f = await fixture();
    const { run, admission, token } = await f.admitRun('run-1', 'p1');
    const borrowed = f.borrower(request(`Bearer ${token}`), 'p1')!;
    await expect(borrowed.run('p1', async io => { f.tokens.revokeToken(token, 'child_exit'); await save(io, f.dir('p1'), 'late.txt', 'late'); }))
      .rejects.toMatchObject({ code: 'PERMIT_RELEASED' });
    expect(existsSync(path.join(f.dir('p1'), 'late.txt'))).toBe(false);
    expect(f.borrower(request(`Bearer ${token}`), 'p1')).toBeNull();

    const expiring = f.tokens.mint({ runId: 'run-1', projectId: 'p1', ttlMs: 1 }).token;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.borrower(request(`Bearer ${expiring}`), 'p1')).toBeNull();

    const fresh = f.tokens.mint({ runId: 'run-1', projectId: 'p1' }).token;
    const lender = f.borrower(request(`Bearer ${fresh}`), 'p1')!;
    admission.cancel();
    await expect(lender.run('p1', io => save(io, f.dir('p1'), 'after-cancel.txt', 'x'))).rejects.toMatchObject({ code: 'RUN_STATE' });
    expect(existsSync(path.join(f.dir('p1'), 'after-cancel.txt'))).toBe(false);
    run.status = 'canceled';
    expect(f.borrower(request(`Bearer ${fresh}`), 'p1')).toBeNull();
  });

  it('an ordinary run (no admission) never borrows; ordinary admission stays the path', async () => {
    const f = await fixture();
    const run: TestRun = { id: 'run-o', projectId: 'p1', status: 'running' };
    f.runs.set(run.id, run);
    const token = f.tokens.mint({ runId: run.id, projectId: 'p1' }).token;
    expect(f.borrower(request(`Bearer ${token}`), 'p1')).toBeNull();
    await f.standalone.run('p1', io => save(io, f.dir('p1'), 'ordinary.txt', 'ok'));
    expect(readFileSync(path.join(f.dir('p1'), 'ordinary.txt'), 'utf8')).toBe('ok');
  });
});
