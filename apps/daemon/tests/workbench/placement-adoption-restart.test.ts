import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKBENCH_ADOPTION_ROOT_RECORD } from '@open-design/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { canonicalJson } from '../../src/workbench/placement/adoption-plan.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import {
  PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA, PLACEMENT_ADOPTION_LAYOUT, PLACEMENT_HELPER_SOURCE_SHA256, resolveAdoptionProvisioning,
} from '../../src/workbench/placement/adoption-provisioning.js';
import { buildDarwinPlacementHelper } from '../../src/workbench/placement/build.js';
import { preparePlacementBootstrap } from '../../src/workbench/placement/owner-bootstrap.js';
import { observeRootState, PLACEMENT_ROOT_SEAL } from '../../src/workbench/placement/root-seal.js';
import { attachPlacementRuntime, type PlacementRuntime } from '../../src/workbench/placement/runtime.js';
import { buildOwnerFixture, nativeSupported, ownerEnv, rootParent, TSX_CLI, type OwnerFixture } from './placement/runtime-fixture.js';
import { spawnSync } from 'node:child_process';

/**
 * B4-1b (AC-R04.3, AC-R04.4): undo across a daemon restart. A restarted
 * coordinated daemon trusts its predecessor only when that predecessor sealed
 * the data root at a clean stop and the root is exactly what it left: the
 * seal binds the root directory and every root-level entry after the database
 * closed, and the database binds the seal's generation and nonce. Then the
 * executor reopens and undo of a pre-restart apply is exact-byte and
 * same-inode. A crash (no seal), an ordinary daemon or a hand edit in
 * between, and a forged or replayed seal each keep the executor closed with
 * `legacy-predecessor-unproven` plus a typed `predecessor-seal-*` reason, and
 * the user's files stay as they are. Actual native owner and helper on the
 * measured darwin-arm64 host, with the real data-root layout tools-dev leaves.
 */
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ENTRY = 'export default function App() { return <main>original</main>; }\n';
const NEXT = "import { Hero } from './Hero';\nexport default function App() { return <Hero />; }\n";
const HERO = 'export function Hero() { return <section>hero</section>; }\n';
const USER_EDIT = 'export default function App() { return <main>user edit — keep me</main>; }\n';
const PROJECT = 'hero';
interface Booted { runtime: PlacementRuntime; db: Database.Database; server: Server; url: string; root: string }
const booted: Booted[] = [];
const crashed: Database.Database[] = [];
afterEach(async () => {
  for (const entry of booted.splice(0)) {
    await new Promise<void>(done => entry.server.close(() => done()));
    entry.runtime.close(); if (entry.db.open) entry.db.close();
  }
  for (const db of crashed.splice(0)) if (db.open) db.close();
});

describe.skipIf(!nativeSupported)('B4-1b adoption undo across a daemon restart (native)', () => {
  let fixture: OwnerFixture;
  beforeAll(async () => { fixture = await buildOwnerFixture('adoption-restart'); }, 120_000);

  /** The tools-dev path: it creates and records the data root, then builds the helper into it. */
  async function freshDataRoot(): Promise<string> {
    const dataDir = join(await rootParent(fixture), 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const stat = lstatSync(dataDir, { bigint: true });
    writeFileSync(join(dataDir, WORKBENCH_ADOPTION_ROOT_RECORD.name), JSON.stringify({
      schema: WORKBENCH_ADOPTION_ROOT_RECORD.schema, creator: 'tools-dev', device: String(stat.dev), inode: String(stat.ino),
    }), { mode: 0o600 });
    const toolDir = join(dataDir, ...PLACEMENT_ADOPTION_LAYOUT.toolDir);
    mkdirSync(toolDir, { recursive: true, mode: 0o700 });
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/workbench/placement/native.c');
    const built = await buildDarwinPlacementHelper({ sourcePath: source, outputPath: join(toolDir, PLACEMENT_ADOPTION_LAYOUT.binary), arch: 'arm64' });
    chmodSync(built.path, 0o500);
    writeFileSync(join(toolDir, PLACEMENT_ADOPTION_LAYOUT.record), `${JSON.stringify({
      schema: PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA, binary: { name: PLACEMENT_ADOPTION_LAYOUT.binary, sha256: built.sha256 },
      sourceSHA256: built.sourceSHA256, platform: 'darwin', arch: 'arm64', compiler: built.compiler, command: built.command, buildReceipt: 'native-test',
    })}\n`, { mode: 0o400 });
    expect(built.sourceSHA256).toBe(PLACEMENT_HELPER_SOURCE_SHA256);
    return dataDir;
  }
  async function boot(dataDir: string, hooks?: { beforeSealConfirmation?: () => void }, sealConfirmMaxBytes?: number): Promise<Booted> {
    const bootstrap = preparePlacementBootstrap({
      env: ownerEnv(fixture, dataDir), projectRoot: '/x', ...(hooks ? { hooks } : {}), ...(sealConfirmMaxBytes !== undefined ? { sealConfirmMaxBytes } : {}),
    });
    if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
    const root = bootstrap.canonicalDataRoot;
    const projectsDir = join(root, 'projects'); mkdirSync(join(projectsDir, PROJECT, 'src'), { recursive: true });
    const sources = [{ id: PROJECT }];
    const provisioning = resolveAdoptionProvisioning({ optIn: true, dataRoot: root, projectRoots: [projectsDir] });
    if (provisioning.kind !== 'provisioned') throw new Error(`helper not provisioned: ${provisioning.gates.join(',')}`);
    const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
    const runtime = attachPlacementRuntime(bootstrap, {
      db, projectsDir, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources,
      adoption: { helper: provisioning.helper, workRoot: provisioning.workRoot, ...(provisioning.toolRoot ? { toolRoot: provisioning.toolRoot } : {}) },
    });
    const app = express(); app.use(express.json({ limit: '64mb' }));
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: runtime });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', () => done()));
    const entry = { runtime, db, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root };
    booted.push(entry); return entry;
  }
  /** A clean stop: the HTTP server closes, then the runtime seals the root (closing the database) and releases the owner. */
  async function stopCleanly(entry: Booted) {
    booted.splice(booted.indexOf(entry), 1);
    await new Promise<void>(done => entry.server.close(() => done()));
    return entry.runtime.sealAndClose({ closeDatabase: () => entry.db.close() });
  }
  /** A crash: the owner is gone with the process; nothing is sealed and the database is never closed. */
  async function crash(entry: Booted): Promise<void> {
    booted.splice(booted.indexOf(entry), 1);
    await new Promise<void>(done => entry.server.close(() => done()));
    entry.runtime.close(); crashed.push(entry.db);
  }
  async function od(url: string, args: string[]): Promise<{ code: number; body: any }> {
    let body: unknown; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } });
    return { code, body };
  }
  /** Prepare and apply one owner-declared plan; returns the apply operation id. */
  async function applyHero(daemon: Booted): Promise<{ operationId: string; entryPath: string; heroPath: string; preimage: { dev: bigint; ino: bigint } }> {
    const entryPath = join(daemon.root, 'projects', PROJECT, 'src', 'App.tsx'), heroPath = join(daemon.root, 'projects', PROJECT, 'src', 'Hero.tsx');
    writeFileSync(entryPath, ENTRY);
    const preimage = lstatSync(entryPath, { bigint: true });
    const requestFile = join(await rootParent(fixture), 'draft.json');
    writeFileSync(requestFile, JSON.stringify({
      projectId: PROJECT, entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' },
      writes: [
        { path: 'src/Hero.tsx', role: 'source', contentBase64: Buffer.from(HERO).toString('base64') },
        { path: 'src/App.tsx', role: 'entry', contentBase64: Buffer.from(NEXT).toString('base64') },
      ],
    }));
    const prepared = await od(daemon.url, ['prepare', '--request-file', requestFile, '--json']);
    expect(prepared.code).toBe(0);
    const applied = await od(daemon.url, ['apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(applied.code).toBe(0);
    expect(applied.body.operation).toMatchObject({ kind: 'apply', state: 'done' });
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);
    return { operationId: applied.body.operation.operationId, entryPath, heroPath, preimage: { dev: preimage.dev, ino: preimage.ino } };
  }
  /** The executor stays closed with the predecessor gate and the typed reason; undo changes nothing. */
  async function expectUndoRefused(daemon: Booted, operationId: string, reason: string): Promise<void> {
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: false, predecessor: { proof: 'unproven', reason } });
    expect(daemon.runtime.status().activation.gates).toEqual(expect.arrayContaining(['legacy-predecessor-unproven', reason]));
    const undo = await fetch(`${daemon.url}/api/workbench/adoption/operations/${operationId}/undo`, { method: 'POST' });
    expect(undo.status).toBe(422);
    expect(((await undo.json()) as any).error.details).toMatchObject({ reason: 'unsupported-capability', gates: expect.arrayContaining(['legacy-predecessor-unproven', reason]) });
    const viaOd = await od(daemon.url, ['undo', '--operation', operationId, '--json']);
    expect(viaOd).toMatchObject({ code: 3, body: { status: 422, error: { details: { gates: expect.arrayContaining([reason]) } } } });
  }
  const sealFile = (root: string) => join(root, PLACEMENT_ROOT_SEAL.directory, PLACEMENT_ROOT_SEAL.name);

  it('[P0] a clean restart proves the predecessor: readback and exact-byte, same-inode undo after the restart; the chain continues', async () => {
    let daemon = await boot(await freshDataRoot());
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: true, predecessor: { proof: 'created' } });
    const root = daemon.root;
    const { operationId, entryPath, heroPath, preimage } = await applyHero(daemon);

    expect(await stopCleanly(daemon)).toEqual({ sealed: true, generation: 1 });
    expect(existsSync(sealFile(root))).toBe(true);
    daemon = await boot(root);
    expect(existsSync(sealFile(root))).toBe(false); // One-shot: the boot that accepts the seal consumes it.
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: false, predecessor: { proof: 'sealed', generation: 1, reason: null } });
    expect(daemon.runtime.status().activation.gates).not.toContain('legacy-predecessor-unproven');
    expect(daemon.runtime.adoption).not.toBeNull();
    const shown = await od(daemon.url, ['show', '--operation', operationId, '--json']);
    expect(shown).toMatchObject({ code: 0, body: { operation: { operationId, kind: 'apply', state: 'done', undoneBy: null } } });

    const undone = await od(daemon.url, ['undo', '--operation', operationId, '--json']);
    expect(undone.code).toBe(0);
    expect(undone.body.operation).toMatchObject({ kind: 'undo', state: 'done', undoOf: operationId });
    expect(sha(readFileSync(entryPath))).toBe(sha(ENTRY));
    const restored = lstatSync(entryPath, { bigint: true });
    expect([restored.dev, restored.ino]).toEqual([preimage.dev, preimage.ino]);
    expect(existsSync(heroPath)).toBe(false);

    // The successor seals the next generation; the next boot is proven again and replays the undo.
    expect(await stopCleanly(daemon)).toEqual({ sealed: true, generation: 2 });
    daemon = await boot(root);
    expect(daemon.runtime.status().dataRoot).toMatchObject({ predecessor: { proof: 'sealed', generation: 2 } });
    const replay = await od(daemon.url, ['undo', '--operation', operationId, '--json']);
    expect(replay.body.operation.operationId).toBe(undone.body.operation.operationId);
    expect(sha(readFileSync(entryPath))).toBe(sha(ENTRY));
  }, 180_000);

  it('[P0] a crash leaves no seal: the journal stays intact and clear, undo refuses with predecessor-seal-absent, files kept', async () => {
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const { operationId, entryPath, heroPath } = await applyHero(daemon);
    await crash(daemon);
    daemon = await boot(root);
    expect(daemon.runtime.status()).toMatchObject({ mode: 'coordinated-open', recovery: { global: 'clear', blockedGateKeys: [] } });
    await expectUndoRefused(daemon, operationId, 'predecessor-seal-absent');
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);
    expect(readFileSync(heroPath, 'utf8')).toBe(HERO);

    // A boot that accepted a seal and then crashed breaks the chain for good.
    const chain = await boot(await freshDataRoot());
    const chainRoot = chain.root;
    await applyHero(chain);
    expect((await stopCleanly(chain)).sealed).toBe(true);
    const accepted = await boot(chainRoot);
    expect(accepted.runtime.status().dataRoot).toMatchObject({ predecessor: { proof: 'sealed' } });
    await crash(accepted);
    const after = await boot(chainRoot);
    expect(after.runtime.adoption).toBeNull();
    expect(after.runtime.status().activation.gates).toEqual(expect.arrayContaining(['legacy-predecessor-unproven', 'predecessor-seal-absent']));
    // An unproven boot never seals, so it cannot launder the root for the next one.
    expect(await stopCleanly(after)).toEqual({ sealed: false, reason: 'root-unproven' });
    expect(existsSync(sealFile(chainRoot))).toBe(false);
  }, 240_000);

  it('[P0] an ordinary daemon between the runs breaks the seal: undo refuses with predecessor-seal-root-changed, files kept', async () => {
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const { operationId, entryPath } = await applyHero(daemon);
    expect((await stopCleanly(daemon)).sealed).toBe(true);
    // An ordinary daemon starts on the root: the C2a read-only journal pre-check, then its own database open.
    const ordinary = preparePlacementBootstrap({ env: { OD_DATA_DIR: root }, projectRoot: '/x' });
    expect(ordinary).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { kind: 'inspected', global: null } });
    const other = new Database(join(root, 'app.sqlite')); other.pragma('journal_mode=WAL'); other.prepare('SELECT 1').get(); other.close();
    if (ordinary.mode === 'ordinary-uncoordinated') ordinary.rootLock?.release(); // The ordinary daemon stops.
    expect(existsSync(sealFile(root))).toBe(true); // Ordinary mode never reads or removes the seal.

    daemon = await boot(root);
    expect(existsSync(sealFile(root))).toBe(false); // Consumed even when refused.
    await expectUndoRefused(daemon, operationId, 'predecessor-seal-root-changed');
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);
  }, 180_000);

  it('[P0] hand edits: at the root the seal refuses; on a recorded file the proven undo refuses changed-since-apply and keeps the edit', async () => {
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const first = await applyHero(daemon);
    expect((await stopCleanly(daemon)).sealed).toBe(true);
    writeFileSync(join(root, 'notes.txt'), 'hand edit at the data root');
    daemon = await boot(root);
    await expectUndoRefused(daemon, first.operationId, 'predecessor-seal-root-changed');

    let other = await boot(await freshDataRoot());
    const otherRoot = other.root;
    const second = await applyHero(other);
    expect((await stopCleanly(other)).sealed).toBe(true);
    writeFileSync(second.entryPath, USER_EDIT); // The user edits an applied file while no daemon runs.
    other = await boot(otherRoot);
    expect(other.runtime.status().dataRoot).toMatchObject({ predecessor: { proof: 'sealed' } });
    const undo = await fetch(`${other.url}/api/workbench/adoption/operations/${second.operationId}/undo`, { method: 'POST' });
    expect(undo.status).toBe(409);
    expect(((await undo.json()) as any).error.details).toMatchObject({ kind: 'adoption', reason: 'changed-since-apply' });
    expect(readFileSync(second.entryPath, 'utf8')).toBe(USER_EDIT);
    expect(readFileSync(second.heroPath, 'utf8')).toBe(HERO);
  }, 240_000);

  it('[P0] a forged seal (own nonce over the real root state) and a replayed earlier seal are refused', async () => {
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const { operationId, entryPath } = await applyHero(daemon);
    const incarnationId = daemon.runtime.status().incarnationId!;
    await crash(daemon);
    crashed.splice(0).forEach(db => db.close()); // The process is gone: its database handle is too.
    // The forger writes a well-formed seal for the crashed incarnation, signed with a nonce of their own.
    const nonce = randomBytes(32).toString('hex');
    const body = { schema: PLACEMENT_ROOT_SEAL.schema, generation: 1, incarnationId, nonce, sealedAt: new Date().toISOString(), root: observeRootState(root) };
    writeFileSync(sealFile(root), JSON.stringify({ ...body, mac: createHmac('sha256', Buffer.from(nonce, 'hex')).update(canonicalJson(body)).digest('hex') }), { mode: 0o600 });
    daemon = await boot(root);
    await expectUndoRefused(daemon, operationId, 'predecessor-seal-unrecognized');
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);

    // Replay: a copy of a genuine, already consumed seal put back later.
    let chain = await boot(await freshDataRoot());
    const chainRoot = chain.root;
    const applied = await applyHero(chain);
    expect((await stopCleanly(chain)).sealed).toBe(true);
    const kept = join(await rootParent(fixture), 'kept-seal.json'); copyFileSync(sealFile(chainRoot), kept);
    chain = await boot(chainRoot);
    expect(chain.runtime.status().dataRoot).toMatchObject({ predecessor: { proof: 'sealed' } });
    await crash(chain);
    copyFileSync(kept, sealFile(chainRoot)); chmodSync(sealFile(chainRoot), 0o600);
    chain = await boot(chainRoot);
    expect(chain.runtime.adoption).toBeNull();
    expect(chain.runtime.status().activation.gates).toContain('legacy-predecessor-unproven');
    expect(chain.runtime.status().dataRoot?.predecessor.proof).toBe('unproven');
    expect(['predecessor-seal-root-changed', 'predecessor-seal-unrecognized']).toContain(chain.runtime.status().dataRoot?.predecessor.reason);
    expect(readFileSync(applied.entryPath, 'utf8')).toBe(NEXT);
  }, 240_000);

  it('[P0][Sol BLOCK 2] the window between seal verification and confirmation: a raw opener is caught, a lock-honouring ordinary daemon cannot enter', async () => {
    // A raw SQLite opener inside the window (it honours no lock): the final comparison under the root lock refuses.
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const { operationId, entryPath } = await applyHero(daemon);
    expect((await stopCleanly(daemon)).sealed).toBe(true);
    daemon = await boot(root, { beforeSealConfirmation: () => {
      const raw = new Database(join(root, 'app.sqlite'), { readonly: true }); raw.prepare('SELECT 1').get(); raw.close();
    } });
    await expectUndoRefused(daemon, operationId, 'predecessor-seal-root-changed');
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);

    // An ordinary daemon starting inside the window waits for the root lock and, here, gives up before touching anything.
    let other = await boot(await freshDataRoot());
    const otherRoot = other.root;
    const second = await applyHero(other);
    expect((await stopCleanly(other)).sealed).toBe(true);
    const script = join(await rootParent(fixture), 'ordinary-in-window.mts');
    writeFileSync(script, [
      `import { preparePlacementBootstrap } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/workbench/placement/owner-bootstrap.ts'))};`,
      'try { preparePlacementBootstrap({ env: { OD_DATA_DIR: process.argv[2] }, projectRoot: "/x", rootLockWaitMs: 300 }); console.log("started"); }',
      'catch (error) { console.log(`refused:${(error as { reason?: string }).reason}`); }',
    ].join('\n'));
    let child: ReturnType<typeof spawnSync> | null = null;
    other = await boot(otherRoot, { beforeSealConfirmation: () => {
      child = spawnSync(process.execPath, [TSX_CLI, script, otherRoot], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, OD_DATA_DIR: otherRoot } });
    } });
    expect(String(child!.stdout).trim()).toBe('refused:transition-closed:root-seal-locked');
    expect(other.runtime.status().dataRoot).toMatchObject({ predecessor: { proof: 'sealed' } });
    const undone = await od(other.url, ['undo', '--operation', second.operationId, '--json']);
    expect(undone.code).toBe(0);
    expect(sha(readFileSync(second.entryPath))).toBe(sha(ENTRY));
  }, 240_000);

  it('[P0][Sol r2 WARN 2] a database the boot cannot verify within its bound refuses as unverifiable and keeps the seal', async () => {
    let daemon = await boot(await freshDataRoot());
    const root = daemon.root;
    const { operationId, entryPath } = await applyHero(daemon);
    expect((await stopCleanly(daemon)).sealed).toBe(true);
    daemon = await boot(root, undefined, 1024);
    await expectUndoRefused(daemon, operationId, 'predecessor-seal-unverifiable');
    expect(existsSync(sealFile(root))).toBe(true); // A resource failure never consumes the seal.
    expect(readFileSync(entryPath, 'utf8')).toBe(NEXT);
  }, 180_000);
});
