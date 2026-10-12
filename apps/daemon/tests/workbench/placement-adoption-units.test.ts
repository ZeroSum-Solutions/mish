import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { AdoptionError, PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { AdoptionBlobError, AdoptionBlobStore, sha256 } from '../../src/workbench/placement/adoption-files.js';
import type { AdoptionMover } from '../../src/workbench/placement/adoption-mover.js';
import { AdoptionStore, migratePlacementAdoption } from '../../src/workbench/placement/adoption-store.js';
import { migratePlacementJournal, PlacementJournal } from '../../src/workbench/placement/journal.js';
import { PlacementCapabilityError, PlacementProjectRegistry, type PlacementProjectSource } from '../../src/workbench/placement/project-registry.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';

/**
 * Portable executor/route/CLI contract cases. The mover here is a test double
 * (plain rename after an identity check) so these run on every host; the
 * actual native exclusive movement is proved by placement-adoption.test.ts.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(options: { failAt?: number; symlinkedProject?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-units-'))); roots.push(root);
  const managed = join(root, 'projects'); mkdirSync(managed, { recursive: true });
  let project = join(managed, 'p1');
  if (options.symlinkedProject) {
    // A managed project directory that is a symlink to elsewhere on the same volume.
    const elsewhere = join(root, 'elsewhere', 'p1'); mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, project, 'dir'); project = realpathSync(project);
  }
  mkdirSync(join(project, 'src'), { recursive: true });
  const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); migratePlacementAdoption(db);
  const journal = new PlacementJournal({ db, incarnationId: `incarnation-${randomUUID()}` });
  let moves = 0;
  const identity = { device: '1', inode: '2', volumeUUID: '11111111-2222-3333-4444-555555555555' };
  const mover: AdoptionMover = {
    inspectDirectory: async () => ({ kind: 'qualified', identity }),
    prepare: async ({ source, destination, expected }) => ({ kind: 'ready', move: {
      execute: async intent => {
        await intent(); moves += 1;
        if (moves === options.failAt) return { kind: 'unknown-result', invocationId: randomUUID(), reason: 'helper-transport', mutation: 'possible', observation: null, child: null };
        const st = lstatSync(source, { bigint: true });
        if (String(st.ino) !== expected.inode) return { kind: 'conflict', invocationId: randomUUID(), reason: 'source', mutation: 'none', observation: null, child: null };
        renameSync(source, destination);
        return { kind: 'observed-move', invocationId: randomUUID(), observation: {} as never, child: { pid: null, exited: true, exitCode: 0, signal: null }, contentVerification: 'required' };
      },
      close: async () => undefined,
    } }),
  };
  const executor = new PlacementAdoptionExecutor({
    journal, store: new AdoptionStore(db), blobs: new AdoptionBlobStore(join(root, 'work', 'blobs')), mover,
    workRoot: join(root, 'work'), managedRoot: managed, projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible: () => undefined }),
    resolveTarget: projectId => ({ projectId, kind: 'managed', physicalRoot: project, identity: null, gateKey: project }),
  });
  return { root, project, db, journal, executor, moves: () => moves };
}
const draft = (entry: string, extra = 'export const x = 1;\n') => ({
  projectId: 'p1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' as const },
  writes: [
    { path: 'src/extra.ts', role: 'source' as const, contentBase64: Buffer.from(extra).toString('base64') },
    { path: 'src/App.tsx', role: 'entry' as const, contentBase64: Buffer.from(entry).toString('base64') },
  ],
});

describe('adoption blob store', () => {
  it('retains exact bytes by digest and refuses a corrupted blob', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-blobs-'))); roots.push(root);
    const blobs = new AdoptionBlobStore(join(root, 'blobs'));
    const stored = blobs.put(Buffer.from('preimage bytes'));
    expect(stored).toEqual({ blobId: `sha256-${sha256('preimage bytes')}`, sha256: sha256('preimage bytes'), byteLength: 14 });
    expect(blobs.put(Buffer.from('preimage bytes'))).toEqual(stored);
    expect(blobs.read(stored).toString()).toBe('preimage bytes');
    writeFileSync(join(root, 'blobs', stored.blobId), 'tampered bytes');
    expect(() => blobs.read(stored)).toThrowError(AdoptionBlobError);
    expect(() => blobs.read({ ...stored, blobId: '../escape' })).toThrowError(expect.objectContaining({ reason: 'blob-invalid' }));
  });
});

describe('adoption executor contract', () => {
  it('refuses non-owned sources with the typed source-authority gate and no stored plan', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    await expect(f.executor.prepare('local-owner', { ...draft('next'), source: { implementationOrigin: 'official' } }))
      .rejects.toMatchObject({ status: 422, reason: 'source-authority-executor-preparer' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get()).toEqual({ n: 0 });
  });

  it('a lost movement result stops in recovery-required; a repeat replays it and never moves again', async () => {
    const f = fixture({ failAt: 2 });
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    const plan = await f.executor.prepare('local-owner', draft('next'));
    expect(plan.writes.map(w => [w.path, w.kind])).toEqual([['src/extra.ts', 'create'], ['src/App.tsx', 'replace']]);
    const failure = await f.executor.apply('local-owner', { planId: plan.id, planDigest: plan.digest }).catch(error => error);
    expect(failure).toBeInstanceOf(AdoptionError);
    expect(failure).toMatchObject({ status: 500, reason: 'movement-unknown' });
    const view = f.executor.view('local-owner', failure.operationId);
    expect(view).toMatchObject({ kind: 'apply', state: 'failed', stage: 'recovery-required', reason: 'movement-unknown' });
    const moves = f.moves();
    expect(await f.executor.apply('local-owner', { planId: plan.id, planDigest: plan.digest })).toEqual(view);
    expect(f.moves()).toBe(moves);
    await expect(f.executor.undo('local-owner', view.operationId)).rejects.toMatchObject({ status: 409, reason: 'operation-not-complete' });
  });

  it('binds plans to their principal and digest', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    const plan = await f.executor.prepare('local-owner', draft('next'));
    await expect(f.executor.apply('member:other', { planId: plan.id, planDigest: plan.digest })).rejects.toMatchObject({ status: 404 });
    await expect(f.executor.apply('local-owner', { planId: plan.id, planDigest: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409, reason: 'plan-digest-mismatch' });
    expect(readFileSync(join(f.project, 'src/App.tsx'), 'utf8')).toBe('original');
  });
});

describe('adoption prepare/apply gates (review findings)', () => {
  const storedBlobs = (root: string) => existsSync(join(root, 'work', 'blobs')) ? readdirSync(join(root, 'work', 'blobs')) : [];
  const storedPlans = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get();

  it('refuses an external package.json or lockfile edit between prepare and apply with 409 and moves nothing', async () => {
    for (const edit of [
      (project: string) => writeFileSync(join(project, 'package.json'), '{"dependencies":{"left-pad":"1.0.0"}}'),
      (project: string) => writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.1\n'),
    ]) {
      const f = fixture();
      writeFileSync(join(f.project, 'src/App.tsx'), 'original');
      writeFileSync(join(f.project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      const plan = await f.executor.prepare('local-owner', draft('next'));
      edit(f.project);
      await expect(f.executor.apply('local-owner', { planId: plan.id, planDigest: plan.digest }))
        .rejects.toMatchObject({ status: 409, reason: 'dependency-set-changed' });
      expect(f.moves()).toBe(0);
      expect(readFileSync(join(f.project, 'src/App.tsx'), 'utf8')).toBe('original');
      expect(existsSync(join(f.project, 'src/extra.ts'))).toBe(false);
    }
  });

  it('refuses a draft whose entry does not exist yet with a typed 422 and stores nothing', async () => {
    const f = fixture();
    await expect(f.executor.prepare('local-owner', draft('next')))
      .rejects.toMatchObject({ status: 422, reason: 'entry-must-exist' });
    expect(storedPlans(f)).toEqual({ n: 0 });
    expect(storedBlobs(f.root)).toEqual([]);
  });

  it.each(['.git/config', 'node_modules/pkg/secrets.js', 'src/NODE_MODULES/x.js'])('refuses restricted write path %j before any read or stored blob', async restricted => {
    const f = fixture();
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    mkdirSync(join(f.project, '.git'), { recursive: true }); writeFileSync(join(f.project, '.git/config'), '[secret]');
    const d = draft('next');
    d.writes.unshift({ path: restricted, role: 'source', contentBase64: Buffer.from('x').toString('base64') });
    await expect(f.executor.prepare('local-owner', d)).rejects.toMatchObject({ status: 422, reason: 'restricted-path' });
    expect(storedPlans(f)).toEqual({ n: 0 });
    expect(storedBlobs(f.root)).toEqual([]);
  });

  it('observe refuses a path whose parent is a directory symlink leaving the project, and never returns the external bytes', async () => {
    const f = fixture();
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'EXTERNAL-SECRET');
    symlinkSync(outside, join(f.project, 'src', 'linked'), 'dir');
    const result = await f.executor.observe('p1', ['src/linked/secret.txt']).then(value => value, error => error);
    expect(result).toBeInstanceOf(AdoptionError);
    expect(result).toMatchObject({ status: 422, reason: 'parent-unqualified' });
    expect(String(result.message)).not.toContain('EXTERNAL-SECRET');
  });
});

describe('adoption target containment and budgets (review findings, round 2)', () => {
  const storedBlobs = (root: string) => existsSync(join(root, 'work', 'blobs')) ? readdirSync(join(root, 'work', 'blobs')) : [];
  const storedPlans = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get();

  it('refuses a symlinked managed project whose physical root leaves the managed root with a typed 422 and stores nothing', async () => {
    const f = fixture({ symlinkedProject: true });
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    await expect(f.executor.prepare('local-owner', draft('next'))).rejects.toMatchObject({ status: 422, reason: 'root-outside-managed' });
    expect(storedPlans(f)).toEqual({ n: 0 });
    expect(storedBlobs(f.root)).toEqual([]);
    expect(readFileSync(join(f.project, 'src/App.tsx'), 'utf8')).toBe('original');
  });

  it('the registry refuses a symlinked managed root as an adoption target and keeps imported and contained managed roots', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-registry-'))); roots.push(root);
    const projects = join(root, 'data', 'projects'), elsewhere = join(root, 'elsewhere'), imported = join(root, 'imported');
    mkdirSync(join(projects, 'inside'), { recursive: true }); mkdirSync(elsewhere, { recursive: true }); mkdirSync(imported, { recursive: true });
    symlinkSync(elsewhere, join(projects, 'linked'), 'dir');
    const sources = new Map<string, PlacementProjectSource>([
      ['inside', { id: 'inside' }], ['linked', { id: 'linked' }], ['imp', { id: 'imp', metadata: { baseDir: imported } }],
    ]);
    const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
    registry.load();
    expect(registry.resolveAdoptionTarget('inside')).toMatchObject({ kind: 'managed', physicalRoot: join(projects, 'inside') });
    expect(() => registry.resolveAdoptionTarget('linked')).toThrowError(PlacementCapabilityError);
    expect(() => registry.resolveAdoptionTarget('linked')).toThrowError(/outside the managed projects root/);
    // Imported roots stay registered (the sanctioned exception) and keep their own 422.
    expect(registry.describe('imp')).toMatchObject({ kind: 'imported', physicalRoot: imported });
    expect(() => registry.resolveAdoptionTarget('imp')).toThrowError(/imported project roots is unsupported/);
  });

  it('refuses three existing targets that together exceed the 32 MiB preimage budget with 422 before any blob exists', async () => {
    const f = fixture();
    const big = Buffer.alloc(11 * 1024 * 1024 + 1, 0x61);
    for (const name of ['src/a.bin', 'src/b.bin', 'src/App.tsx']) writeFileSync(join(f.project, name), big);
    const d = draft('next');
    d.writes = [
      { path: 'src/a.bin', role: 'source', contentBase64: Buffer.from('a').toString('base64') },
      { path: 'src/b.bin', role: 'source', contentBase64: Buffer.from('b').toString('base64') },
      { path: 'src/App.tsx', role: 'entry', contentBase64: Buffer.from('next').toString('base64') },
    ];
    await expect(f.executor.prepare('local-owner', d)).rejects.toMatchObject({ status: 422, reason: 'preimage-budget' });
    expect(storedPlans(f)).toEqual({ n: 0 });
    expect(storedBlobs(f.root)).toEqual([]);
  });

  it('refuses outputs that together exceed the 32 MiB output budget with 422 before any blob exists', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'src/App.tsx'), 'original');
    const big = Buffer.alloc(11 * 1024 * 1024 + 1, 0x62).toString('base64');
    const d = draft('next');
    d.writes = [
      { path: 'src/a.bin', role: 'source', contentBase64: big },
      { path: 'src/b.bin', role: 'source', contentBase64: big },
      { path: 'src/App.tsx', role: 'entry', contentBase64: big },
    ];
    await expect(f.executor.prepare('local-owner', d)).rejects.toMatchObject({ status: 422, reason: 'output-budget' });
    expect(storedPlans(f)).toEqual({ n: 0 });
    expect(storedBlobs(f.root)).toEqual([]);
  });
});

describe('adoption route and od without an executor', () => {
  it('answers the typed 422 placement refusal through HTTP and od, preserving the request', async () => {
    const status = { mode: 'ordinary-uncoordinated', activation: { adoption: 'closed', gates: ['hero-proof-missing', 'ordinary-mode'] } } as unknown as PlacementRuntimeStatus;
    const app = express(); app.use(express.json());
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: null, status: () => status } });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${url}/api/workbench/adoption/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft('next')) });
    expect(response.status).toBe(422);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'VALIDATION_FAILED', details: { kind: 'placement', reason: 'unsupported-capability' } });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-cli-'))); roots.push(root);
    writeFileSync(join(root, 'draft.json'), JSON.stringify(draft('next')));
    let body: any; const code = await runAdoptionCli(['prepare', '--request-file', join(root, 'draft.json'), '--json'], { baseUrl: url, write: value => { body = value; } });
    expect(code).toBe(3); expect(body).toMatchObject({ status: 422, error: { details: { reason: 'unsupported-capability' } } });
    expect(await runAdoptionCli(['apply', '--plan', 'p', '--json'], { baseUrl: url, write: value => { body = value; } })).toBe(2);
    expect(body.error.code).toBe('invalid-cli-input');
    const malformed = await fetch(`${url}/api/workbench/adoption/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: 'p', planDigest: 'x', extra: 1 }) });
    expect(malformed.status).toBe(400);
  });
});
