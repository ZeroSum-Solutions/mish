import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { AdoptionBlobStore } from '../../src/workbench/placement/adoption-files.js';
import type { AdoptionMover } from '../../src/workbench/placement/adoption-mover.js';
import {
  AdoptionExposure, AdoptionProvisioningError, createAdoptionLabsSwitch, PLACEMENT_ADOPTION_EXECUTOR_ENV, PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA,
  PLACEMENT_ADOPTION_LAYOUT, PLACEMENT_HELPER_SOURCE_SHA256, adoptionHelperPaths, prepareAdoptionWorkRoot, resolveAdoptionProvisioning,
  takeAdoptionOptIn, type AdoptionProvisioning,
} from '../../src/workbench/placement/adoption-provisioning.js';
import { AdoptionStore, migratePlacementAdoption } from '../../src/workbench/placement/adoption-store.js';
import { migratePlacementJournal, PlacementJournal } from '../../src/workbench/placement/journal.js';
import { preparePlacementBootstrap } from '../../src/workbench/placement/owner-bootstrap.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';
import { attachPlacementRuntime } from '../../src/workbench/placement/runtime.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';
import { parseWorkbenchAdoptionRefusalDetails } from '@open-design/contracts';

/**
 * B4-1 executor provisioning, phase A. Portable cases run on every host: the
 * helper "binary" is plain bytes and the mover is the existing test double, so
 * they prove the opt-in, record, digest, tool-directory and volume gates and
 * their wiring into the HTTP routes and `od`. The native journey (actual owner,
 * actual helper) is placement-adoption-provisioning-native.test.ts.
 */
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const DARWIN_ARM64 = { platform: 'darwin', arch: 'arm64', release: '25.5.0' } as const;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`))); roots.push(root);
  return root;
}
/** A data root with a managed projects directory, as the daemon's eager initialization leaves it. */
function dataRoot(): string {
  const root = join(tempRoot('adoption-prov'), 'data');
  mkdirSync(join(root, 'projects'), { recursive: true, mode: 0o700 });
  return root;
}
interface ToolOptions { binary?: Buffer; recordSha?: string; sourceSHA256?: string; record?: Record<string, unknown> }
/** What the tools-dev build leaves behind: the binary and the record of its digest at build time. */
function installHelper(root: string, options: ToolOptions = {}) {
  const toolDir = join(root, ...PLACEMENT_ADOPTION_LAYOUT.toolDir);
  mkdirSync(toolDir, { recursive: true, mode: 0o700 });
  chmodSync(join(root, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]!), 0o700); chmodSync(toolDir, 0o700);
  const binary = options.binary ?? Buffer.from('#!/bin/sh\nexit 0\n');
  const binaryPath = join(toolDir, PLACEMENT_ADOPTION_LAYOUT.binary);
  writeFileSync(binaryPath, binary, { mode: 0o500 });
  const record = options.record ?? {
    schema: PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA,
    binary: { name: PLACEMENT_ADOPTION_LAYOUT.binary, sha256: options.recordSha ?? sha(binary) },
    sourceSHA256: options.sourceSHA256 ?? PLACEMENT_HELPER_SOURCE_SHA256,
    platform: 'darwin', arch: 'arm64',
    compiler: 'Apple clang (fixture)', command: ['/usr/bin/xcrun', 'clang'], buildReceipt: 'fixture',
  };
  writeFileSync(join(toolDir, PLACEMENT_ADOPTION_LAYOUT.record), `${JSON.stringify(record)}\n`, { mode: 0o400 });
  return { toolDir, binaryPath, binary };
}
const resolveFor = (root: string, overrides: Partial<Parameters<typeof resolveAdoptionProvisioning>[0]> = {}): AdoptionProvisioning =>
  resolveAdoptionProvisioning({ optIn: true, dataRoot: root, projectRoots: [join(root, 'projects')], host: DARWIN_ARM64, ...overrides });

describe('adoption opt-in input', () => {
  it('reads OD_PLACEMENT_ADOPTION_EXECUTOR=1 only, and removes it so agent children never inherit it', () => {
    expect(PLACEMENT_ADOPTION_EXECUTOR_ENV).toBe('OD_PLACEMENT_ADOPTION_EXECUTOR');
    const on: NodeJS.ProcessEnv = { OD_PLACEMENT_ADOPTION_EXECUTOR: '1', OTHER: 'x' };
    expect(takeAdoptionOptIn(on)).toBe(true);
    expect(on).toEqual({ OTHER: 'x' });
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { OD_PLACEMENT_ADOPTION_EXECUTOR: value };
      expect(takeAdoptionOptIn(env), `value ${JSON.stringify(value)}`).toBe(false);
      expect(env.OD_PLACEMENT_ADOPTION_EXECUTOR).toBeUndefined();
    }
  });
  it('pins the tracked helper source digest (a source change must restate it)', () => {
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/workbench/placement/native.c');
    expect(PLACEMENT_HELPER_SOURCE_SHA256).toBe(sha(readFileSync(source)));
  });
});

describe('adoption provisioning gates (spec 1, 3, 4 and the security lens)', () => {
  it('[spec 1] opt-in off refuses with the named gate and touches nothing', () => {
    const root = dataRoot();
    expect(resolveFor(root, { optIn: false })).toEqual({ kind: 'refused', optIn: false, gates: ['adoption-opt-in-env-off'] });
    expect(existsSync(join(root, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]!))).toBe(false);
  });
  it('phase A is darwin-arm64 only: every other host reports the named gate without reading the tool directory', () => {
    const root = dataRoot(); installHelper(root);
    for (const host of [{ platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'win32', arch: 'x64' }]) {
      expect(resolveFor(root, { host })).toEqual({ kind: 'refused', optIn: true, gates: [`adoption-host-unsupported:${host.platform}-${host.arch}`] });
    }
  });
  it('a missing helper refuses; it is never built or searched for by the daemon', () => {
    expect(resolveFor(dataRoot())).toEqual({ kind: 'refused', optIn: true, gates: ['adoption-helper-missing'] });
  });
  it('a recorded build provisions the helper at the data-root-derived path with the recorded digest', () => {
    const root = dataRoot(); const { binaryPath, binary } = installHelper(root);
    const canonical = realpathSync(root);
    const provisioned = resolveFor(root);
    expect(provisioned).toEqual({
      kind: 'provisioned', optIn: true,
      helper: { path: join(canonical, ...PLACEMENT_ADOPTION_LAYOUT.toolDir, PLACEMENT_ADOPTION_LAYOUT.binary), sha256: sha(binary) },
      workRoot: join(canonical, ...PLACEMENT_ADOPTION_LAYOUT.workRoot),
      toolRoot: join(canonical, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]!),
    });
    expect(adoptionHelperPaths(canonical)).toMatchObject({ binary: binaryPath, workRoot: join(canonical, ...PLACEMENT_ADOPTION_LAYOUT.workRoot) });
  });
  it('[spec 3] a binary whose digest differs from the build-time record stays closed', () => {
    const root = dataRoot(); const { binaryPath } = installHelper(root);
    chmodSync(binaryPath, 0o700); writeFileSync(binaryPath, 'tampered'); chmodSync(binaryPath, 0o500);
    expect(resolveFor(root)).toEqual({ kind: 'refused', optIn: true, gates: ['adoption-helper-digest-mismatch'] });
  });
  it('[spec 3] the digest is taken from the record, never from the binary: a record naming another digest refuses', () => {
    const root = dataRoot(); installHelper(root, { recordSha: 'a'.repeat(64) });
    expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-helper-digest-mismatch'] });
  });
  it('a record built from an unpinned helper source refuses', () => {
    const root = dataRoot(); installHelper(root, { sourceSHA256: 'b'.repeat(64) });
    expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-helper-source-unpinned'] });
  });
  it('a record with extra, missing or wrong-host fields refuses', () => {
    const base = { schema: PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA, binary: { name: PLACEMENT_ADOPTION_LAYOUT.binary, sha256: 'c'.repeat(64) }, sourceSHA256: PLACEMENT_HELPER_SOURCE_SHA256, platform: 'darwin', arch: 'arm64', compiler: 'c', command: ['c'], buildReceipt: 'r' };
    for (const record of [{ ...base, extra: 1 }, { ...base, schema: 'other/v1' }, { ...base, arch: 'x86_64' }, { ...base, binary: { name: '../escape', sha256: 'c'.repeat(64) } }, (({ buildReceipt: _, ...rest }) => rest)(base)]) {
      const root = dataRoot(); installHelper(root, { record });
      expect(resolveFor(root), JSON.stringify(record)).toMatchObject({ kind: 'refused', gates: ['adoption-helper-record-invalid'] });
    }
  });
  it('[security] no symlink is followed anywhere in the tool directory', () => {
    // Tool directory itself a symlink.
    let root = dataRoot(); const elsewhere = tempRoot('adoption-elsewhere');
    const real = installHelper(elsewhere);
    mkdirSync(join(root, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]!), { mode: 0o700 });
    symlinkSync(real.toolDir, join(root, ...PLACEMENT_ADOPTION_LAYOUT.toolDir), 'dir');
    expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-unsafe'] });
    // Binary a symlink to a file with the recorded digest.
    root = dataRoot(); const { binaryPath, binary } = installHelper(root);
    const decoy = join(elsewhere, 'decoy'); writeFileSync(decoy, binary, { mode: 0o500 });
    rmSync(binaryPath); symlinkSync(decoy, binaryPath);
    expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-unsafe'] });
    // Record a symlink.
    root = dataRoot(); const installed = installHelper(root);
    const recordPath = join(installed.toolDir, PLACEMENT_ADOPTION_LAYOUT.record);
    renameSync(recordPath, join(elsewhere, 'record.json')); symlinkSync(join(elsewhere, 'record.json'), recordPath);
    expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-unsafe'] });
  });
  it('[security] group- or other-writable tool directory, binary or record refuses', () => {
    for (const target of ['dir', 'binary', 'record'] as const) {
      const root = dataRoot(); const { toolDir, binaryPath } = installHelper(root);
      const path = target === 'dir' ? toolDir : target === 'binary' ? binaryPath : join(toolDir, PLACEMENT_ADOPTION_LAYOUT.record);
      chmodSync(path, (statSync(path).mode & 0o777) | 0o020);
      expect(resolveFor(root), target).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-unsafe'] });
    }
  });
  it('[security] a tool directory reachable as project content refuses (imported root over the data root)', () => {
    const root = dataRoot(); installHelper(root);
    expect(resolveFor(root, { projectRoots: [join(root, 'projects'), root] })).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-overlaps-project'] });
    expect(resolveFor(root, { projectRoots: [join(root, 'projects'), join(root, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]!)] })).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-overlaps-project'] });
  });
});

describe('adoption work root volume (spec 4)', () => {
  it('creates the work root privately and accepts the managed projects volume', () => {
    const root = dataRoot(); const workRoot = join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot);
    expect(prepareAdoptionWorkRoot({ workRoot, projectsDir: join(root, 'projects'), dataRoot: root })).toBe(realpathSync(workRoot));
    expect(lstatSync(workRoot).mode & 0o777).toBe(0o700);
  });
  it('[spec 4] refuses a work root on a different volume from the managed projects with the named gate', () => {
    const root = dataRoot(); const workRoot = join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot);
    const observeDevice = (path: string) => path.startsWith(realpathSync(join(root, 'projects'))) ? '1' : '2';
    expect(() => prepareAdoptionWorkRoot({ workRoot, projectsDir: join(root, 'projects'), dataRoot: root, observeDevice }))
      .toThrow(expect.objectContaining({ name: 'AdoptionProvisioningError', gate: 'adoption-work-root-cross-volume' }));
  });
  // A second writable volume exists on Linux hosts with a tmpfs /dev/shm; macOS hosts skip.
  const shm = (() => { try { return statSync('/dev/shm').isDirectory() && statSync('/dev/shm').dev !== statSync(tmpdir()).dev; } catch { return false; } })();
  it.skipIf(!shm)('[spec 4] refuses an actual cross-volume work root', () => {
    // The data root (and so the work root) on tmpfs, the managed projects elsewhere.
    const root = dataRoot(); const shmData = mkdtempSync('/dev/shm/adoption-data-'); roots.push(shmData);
    expect(() => prepareAdoptionWorkRoot({ workRoot: join(shmData, 'placement', 'adoption-work'), projectsDir: join(root, 'projects'), dataRoot: shmData }))
      .toThrow(expect.objectContaining({ gate: 'adoption-work-root-cross-volume' }));
  });
});

/** Executor over the test-double mover (plain rename after an identity check), as in placement-adoption-units. */
function doubleExecutor(root: string, workRoot: string) {
  const project = join(root, 'projects', 'p1'); mkdirSync(join(project, 'src'), { recursive: true });
  const db = new Database(join(tempRoot('adoption-prov-db'), 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); migratePlacementAdoption(db);
  const identity = { device: '1', inode: '2', volumeUUID: '11111111-2222-3333-4444-555555555555' };
  const mover: AdoptionMover = {
    inspectDirectory: async () => ({ kind: 'qualified', identity }),
    prepare: async ({ source, destination, expected }) => ({ kind: 'ready', move: {
      execute: async intent => {
        await intent();
        if (String(lstatSync(source, { bigint: true }).ino) !== expected.inode) return { kind: 'conflict', invocationId: randomUUID(), reason: 'source', mutation: 'none', observation: null, child: null };
        renameSync(source, destination);
        return { kind: 'observed-move', invocationId: randomUUID(), observation: {} as never, child: { pid: null, exited: true, exitCode: 0, signal: null }, contentVerification: 'required' };
      },
      close: async () => undefined,
    } }),
  };
  const executor = new PlacementAdoptionExecutor({
    journal: new PlacementJournal({ db, incarnationId: `incarnation-${randomUUID()}` }), store: new AdoptionStore(db),
    blobs: new AdoptionBlobStore(join(workRoot, 'blobs')), mover, workRoot, managedRoot: realpathSync(join(root, 'projects')),
    projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible: () => undefined }),
    resolveTarget: projectId => ({ projectId, kind: 'managed', physicalRoot: realpathSync(project), identity: null, gateKey: realpathSync(project) }),
  });
  return { project, executor, close: () => db.close() };
}
const ENTRY = 'export default function App() { return <main>original</main>; }\n';
const draft = (entry: string) => ({
  projectId: 'p1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' as const },
  writes: [
    { path: 'src/extra.ts', role: 'source' as const, contentBase64: Buffer.from('export const x = 1;\n').toString('base64') },
    { path: 'src/App.tsx', role: 'entry' as const, contentBase64: Buffer.from(entry).toString('base64') },
  ],
});
/**
 * Portable wiring: provisioning → exposure (Labs toggle, lazy construction) →
 * the real route module and `od`. The coordinated runtime composes the same
 * exposure; its native proof is the sibling native test.
 */
async function serve(input: {
  provisioning: AdoptionProvisioning; labs: { on?: boolean }; root: string; build?: (workRoot: string) => PlacementAdoptionExecutor;
  projectRoots?: string[]; builds?: { count: number }; blocked?: string[];
}) {
  const closers: Array<() => void> = [];
  // The stored Labs switch as the server reads it from app-config (absent, true or false).
  const labsSwitch = createAdoptionLabsSwitch(() => input.labs.on);
  const exposure = new AdoptionExposure({
    provisioning: input.provisioning,
    enabled: () => labsSwitch.allowsOpen(),
    ...(input.blocked ? { blocked: input.blocked } : {}),
    projectsDir: join(input.root, 'projects'),
    dataRoot: input.root,
    projectRoots: () => input.projectRoots ?? [join(input.root, 'projects')],
    build: provisioned => {
      if (input.builds) input.builds.count += 1;
      const workRoot = prepareAdoptionWorkRoot({ workRoot: provisioned.workRoot, projectsDir: join(input.root, 'projects'), dataRoot: input.root });
      if (input.build) return input.build(workRoot);
      const built = doubleExecutor(input.root, workRoot); closers.push(built.close); return built.executor;
    },
  });
  const status = (): PlacementRuntimeStatus => ({
    schema: 'mishmash.placement-runtime-status/v1', mode: 'coordinated-open', reason: 'owner-qualified',
    host: { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true },
    binding: null, dataRoot: null, incarnationId: null,
    recovery: { global: 'clear', unresolvedLaunches: [], priorLaunches: [], blockedGateKeys: [], blockedProjectIds: [] },
    transition: null, registry: null,
    // Status never constructs the executor (NIT3): readiness is computed without filesystem effects.
    activation: { adoption: exposure.ready() ? 'executor' : 'closed', gates: ['hero-proof-missing', ...exposure.gates()] },
  });
  const app = express(); app.use(express.json({ limit: '64mb' }));
  registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {},
    http: { sendApiError }, authorizeProjectRequest: async () => true,
    placement: { get adoption() { return exposure.current(); }, status },
    optIn: () => ({ env: input.provisioning.optIn, labs: labsSwitch.allowsOpen() }),
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => closers.forEach(c => c()) };
}
async function od(url: string, args: string[]): Promise<{ code: number; body: any }> {
  let body: unknown; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } });
  return { code, body };
}
async function prepareOverHttp(url: string) {
  return fetch(`${url}/api/workbench/adoption/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft('next')) });
}

describe('adoption provisioning through HTTP and od (portable wiring)', () => {
  it('[spec 1] opt-in off: routes answer 422 with the named gates, and status reports closed through HTTP and od', async () => {
    const root = dataRoot(); installHelper(root);
    const daemon = await serve({ provisioning: resolveFor(root, { optIn: false }), labs: { on: true }, root });
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    const error = ((await refused.json()) as any).error;
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', details: { kind: 'placement', reason: 'unsupported-capability' } });
    // C3: the refusal details are a contract shape.
    expect(parseWorkbenchAdoptionRefusalDetails(error.details).gates).toContain('adoption-opt-in-env-off');
    expect(error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-opt-in-env-off']));
    const status = await od(daemon.url, ['status', '--json']);
    expect(status.code).toBe(0);
    expect(status.body.status).toMatchObject({ executor: 'closed', placementMode: 'coordinated-open', optIn: { env: false, labs: true }, host: { platform: 'darwin', arch: 'arm64', supported: true } });
    expect(status.body.status.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-opt-in-env-off']));
    expect(existsSync(join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot))).toBe(false);
  });
  it('[spec 1] env on but the Labs toggle off stays closed with its own gate; nothing is constructed', async () => {
    const root = dataRoot(); installHelper(root);
    let built = 0;
    const daemon = await serve({ provisioning: resolveFor(root), labs: { on: false }, root, build: () => { built += 1; throw new Error('must not build'); } });
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-opt-in-labs-off']));
    expect(built).toBe(0);
    expect(existsSync(join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot))).toBe(false);
  });
  it('[spec 2] opt-in on + recorded helper + coordinated: prepare → apply → undo through HTTP and od', async () => {
    const root = dataRoot(); installHelper(root);
    // BLOCK 2: the owner's process opt-in opens the executor; an untouched Labs switch does not block it.
    const labs: { on?: boolean } = {};
    const daemon = await serve({ provisioning: resolveFor(root), labs, root });
    const status = await od(daemon.url, ['status', '--json']);
    expect(status.body.status, JSON.stringify(status.body)).toMatchObject({ executor: 'provisioned', optIn: { env: true, labs: true } });
    expect(status.body.status.gates).not.toContain('adoption-executor-unprovisioned');
    mkdirSync(join(root, 'projects', 'p1', 'src'), { recursive: true }); // Status no longer constructs the executor (NIT3).
    const entry = join(root, 'projects', 'p1', 'src', 'App.tsx'); writeFileSync(entry, ENTRY);
    const requestFile = join(tempRoot('adoption-prov-draft'), 'draft.json'); writeFileSync(requestFile, JSON.stringify(draft('next')));
    const prepared = await od(daemon.url, ['prepare', '--request-file', requestFile, '--json']);
    expect(prepared.code).toBe(0);
    const applied = await od(daemon.url, ['apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(applied.body.operation).toMatchObject({ kind: 'apply', state: 'done' });
    expect(readFileSync(entry, 'utf8')).toBe('next');
    const undone = await fetch(`${daemon.url}/api/workbench/adoption/operations/${applied.body.operation.operationId}/undo`, { method: 'POST' });
    expect(undone.status).toBe(200);
    expect(readFileSync(entry, 'utf8')).toBe(ENTRY);
    // The work root derives from the data root and holds the retained bytes.
    expect(lstatSync(join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot, 'blobs')).isDirectory()).toBe(true);
    // Turning Labs off closes the routes on the next request.
    labs.on = false;
    expect((await prepareOverHttp(daemon.url)).status).toBe(422);
    // BLOCK 2: a member request without workspace headers turning it back on cannot reopen it in this daemon.
    labs.on = true;
    const reopened = await prepareOverHttp(daemon.url);
    expect(reopened.status).toBe(422);
    expect(((await reopened.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-opt-in-labs-off']));
    expect((await od(daemon.url, ['status', '--json'])).body.status).toMatchObject({ executor: 'closed', optIn: { labs: false } });
    daemon.close();
  });
  it('[spec 3] a digest mismatch keeps every route closed with the named gate', async () => {
    const root = dataRoot(); const { binaryPath } = installHelper(root);
    chmodSync(binaryPath, 0o700); writeFileSync(binaryPath, 'tampered');
    const daemon = await serve({ provisioning: resolveFor(root), labs: { on: true }, root });
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-helper-digest-mismatch']));
    expect((await od(daemon.url, ['status', '--json'])).body.status.executor).toBe('closed');
  });
  it('[spec 4] a cross-volume work root keeps every route closed with the named gate', async () => {
    const root = dataRoot(); installHelper(root);
    const daemon = await serve({
      provisioning: resolveFor(root), labs: { on: true }, root,
      build: () => { throw new AdoptionProvisioningError('adoption-work-root-cross-volume'); },
    });
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-work-root-cross-volume']));
  });
});

describe('ordinary placement runtime (characterization)', () => {
  it('[spec 1] stays closed with its existing gate even when the opt-in and a recorded helper are present', async () => {
    const root = dataRoot(); installHelper(root);
    const bootstrap = preparePlacementBootstrap({ env: { OD_DATA_DIR: root }, projectRoot: '/x' });
    expect(bootstrap.mode).toBe('ordinary-uncoordinated');
    const db = new Database(join(root, 'app.sqlite'));
    try {
      const runtime = attachPlacementRuntime(bootstrap, { db, projectsDir: join(root, 'projects'), readProject: () => null, listProjects: () => [], adoptionRefusal: [], adoptionEnabled: () => false });
      // NIT1: ordinary mode states every reason it is closed, the Labs switch included.
      expect(runtime.status().activation.gates).toEqual(expect.arrayContaining(['ordinary-mode', 'adoption-executor-unprovisioned', 'adoption-opt-in-labs-off']));
      expect(runtime.adoption).toBeNull();
      expect(runtime.status().activation).toMatchObject({ adoption: 'closed' });
      expect(runtime.status().activation.gates).toContain('ordinary-mode');
      const app = express(); app.use(express.json());
      registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: runtime, optIn: () => ({ env: true, labs: true }) });
      const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const refused = await prepareOverHttp(url);
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as any).error.details).toMatchObject({ reason: 'unsupported-capability', gates: expect.arrayContaining(['ordinary-mode']) });
      expect((await od(url, ['status', '--json'])).body.status).toMatchObject({ executor: 'closed', placementMode: 'ordinary-uncoordinated' });
    } finally { db.close(); }
  });
});

describe('B4-1 review round (C2, S2, S4, NIT3)', () => {
  it('[C2] uses the driver runtime qualification: darwin-arm64 on another OS release reports the gate, not provisioned', () => {
    const root = dataRoot(); installHelper(root);
    expect(resolveFor(root, { host: { platform: 'darwin', arch: 'arm64', release: '24.6.0' } }))
      .toEqual({ kind: 'refused', optIn: true, gates: ['adoption-host-unsupported:darwin-arm64-24.6.0'] });
  });
  it('[S2] refuses when any ancestor of the tool directory is group- or other-writable without the sticky bit', () => {
    const root = dataRoot(); installHelper(root);
    const parent = dirname(root);
    chmodSync(parent, 0o770);
    try { expect(resolveFor(root)).toMatchObject({ kind: 'refused', gates: ['adoption-tool-dir-ancestor-unsafe'] }); }
    finally { chmodSync(parent, 0o700); }
    // A shared directory with the sticky bit (as the system temp directory is) is accepted.
    chmodSync(parent, 0o1777);
    try { expect(resolveFor(root)).toMatchObject({ kind: 'provisioned' }); }
    finally { chmodSync(parent, 0o700); }
  });
  it('[S4] a project root registered later over the tool directory closes the executor, latched', async () => {
    const root = dataRoot(); installHelper(root);
    const projectRoots = [join(root, 'projects')];
    const daemon = await serve({ provisioning: resolveFor(root), labs: { on: true }, root, projectRoots });
    expect((await od(daemon.url, ['status', '--json'])).body.status.executor).toBe('provisioned');
    projectRoots.push(root); // An imported project whose root contains the data root.
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-tool-dir-inside-project']));
    projectRoots.pop(); // Removing the project does not reopen it until restart.
    expect((await od(daemon.url, ['status', '--json'])).body.status).toMatchObject({ executor: 'closed', gates: expect.arrayContaining(['adoption-tool-dir-inside-project']) });
    daemon.close();
  });
  it('[NIT3] status and the status route report readiness without constructing the executor', async () => {
    const root = dataRoot(); installHelper(root);
    const builds = { count: 0 };
    const daemon = await serve({ provisioning: resolveFor(root), labs: { on: true }, root, builds });
    expect((await od(daemon.url, ['status', '--json'])).body.status.executor).toBe('provisioned');
    expect(builds.count).toBe(0);
    expect(existsSync(join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot))).toBe(false);
    daemon.close();
  });
});

describe('B4-1 Sol review (BLOCK 1, BLOCK 2, WARN)', () => {
  it('[BLOCK 1] an unproven predecessor keeps the executor closed at the executor boundary', async () => {
    const root = dataRoot(); installHelper(root);
    const builds = { count: 0 };
    const daemon = await serve({ provisioning: resolveFor(root), labs: {}, root, builds, blocked: ['legacy-predecessor-unproven'] });
    const refused = await prepareOverHttp(daemon.url);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'legacy-predecessor-unproven']));
    expect((await od(daemon.url, ['status', '--json'])).body.status.executor).toBe('closed');
    expect(builds.count).toBe(0);
  });
  it('[BLOCK 2] the Labs switch only closes: off latches until restart, on never opens by itself', () => {
    const stored: { value?: boolean } = {};
    const labs = createAdoptionLabsSwitch(() => stored.value);
    expect(labs.allowsOpen()).toBe(true); // Absent: the process opt-in decides.
    stored.value = true; expect(labs.allowsOpen()).toBe(true);
    stored.value = false; expect(labs.allowsOpen()).toBe(false);
    stored.value = true; expect(labs.allowsOpen()).toBe(false); // Reopening needs a restart by the owner.
    // Stored off at boot: closed for the whole process.
    expect(createAdoptionLabsSwitch(() => false).allowsOpen()).toBe(false);
    // An unreadable switch reads as off.
    expect(createAdoptionLabsSwitch(() => { throw new Error('unreadable'); }).allowsOpen()).toBe(false);
  });
  it('[WARN] refuses a symlinked adoption work directory, even to a private directory on the same volume', () => {
    const root = dataRoot(); installHelper(root);
    const elsewhere = tempRoot('adoption-work-elsewhere');
    symlinkSync(elsewhere, join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot), 'dir');
    expect(() => prepareAdoptionWorkRoot({ workRoot: join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot), projectsDir: join(root, 'projects'), dataRoot: root }))
      .toThrow(expect.objectContaining({ gate: 'adoption-work-root-outside-data-root' }));
  });
  it('[WARN] refuses a work root whose real path is not strictly inside the canonical data root', () => {
    const root = dataRoot(); const outside = join(tempRoot('adoption-work-outside'), 'work');
    expect(() => prepareAdoptionWorkRoot({ workRoot: outside, projectsDir: join(root, 'projects'), dataRoot: root }))
      .toThrow(expect.objectContaining({ gate: 'adoption-work-root-outside-data-root' }));
    expect(() => prepareAdoptionWorkRoot({ workRoot: root, projectsDir: join(root, 'projects'), dataRoot: root }))
      .toThrow(expect.objectContaining({ gate: 'adoption-work-root-outside-data-root' }));
  });
  it('[WARN] readiness reports a symlinked work directory without following it', async () => {
    const root = dataRoot(); installHelper(root);
    symlinkSync(tempRoot('adoption-work-elsewhere'), join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot), 'dir');
    const daemon = await serve({ provisioning: resolveFor(root), labs: {}, root });
    expect((await od(daemon.url, ['status', '--json'])).body.status).toMatchObject({ executor: 'closed', gates: expect.arrayContaining(['adoption-work-root-outside-data-root']) });
  });
});
