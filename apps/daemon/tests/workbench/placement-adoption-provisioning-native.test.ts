import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { WORKBENCH_ADOPTION_ROOT_RECORD } from '@mish/contracts';
import {
  createAdoptionLabsSwitch, PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA, PLACEMENT_ADOPTION_LAYOUT, PLACEMENT_HELPER_SOURCE_SHA256, resolveAdoptionProvisioning,
} from '../../src/workbench/placement/adoption-provisioning.js';
import { buildDarwinPlacementHelper } from '../../src/workbench/placement/build.js';
import { preparePlacementBootstrap } from '../../src/workbench/placement/owner-bootstrap.js';
import { attachPlacementRuntime, type PlacementRuntime } from '../../src/workbench/placement/runtime.js';
import { buildOwnerFixture, nativeSupported, ownerEnv, rootParent, type OwnerFixture } from './placement/runtime-fixture.js';

/**
 * B4-1 native proof (spec 2 and 3 on the measured darwin-arm64 host): the
 * coordinated placement runtime with the actual native owner, provisioned
 * from a helper built from the tracked `native.c` into the data-root-derived
 * tool directory with its build-time record, exactly as `tools-dev
 * --placement-adoption-executor` leaves it. Skips elsewhere and says so.
 */
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ENTRY = 'export default function App() { return <main>original</main>; }\n';
const NEXT = "import { Hero } from './Hero';\nexport default function App() { return <Hero />; }\n";
const HERO = 'export function Hero() { return <section>hero</section>; }\n';
const PROJECT = 'hero';
interface Booted { runtime: PlacementRuntime; db: Database.Database; server: Server; url: string; labs: { on?: boolean } }
const booted: Booted[] = [];
afterEach(async () => {
  for (const entry of booted.splice(0)) {
    await new Promise<void>(done => entry.server.close(() => done()));
    entry.runtime.close(); if (entry.db.open) entry.db.close();
  }
});

describe.skipIf(!nativeSupported)('B4-1 adoption executor provisioning (native)', () => {
  let fixture: OwnerFixture;
  beforeAll(async () => { fixture = await buildOwnerFixture('adoption-provisioning'); }, 120_000);

  /** The tools-dev build output: helper binary plus its build-time record, inside the data root. */
  async function buildIntoDataRoot(dataDir: string): Promise<string> {
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
    return built.path;
  }
  /** What tools-dev leaves when it creates the data root itself: the creation record bound to the root's identity. */
  function recordFreshRoot(dataDir: string): void {
    const stat = lstatSync(dataDir, { bigint: true });
    writeFileSync(join(dataDir, WORKBENCH_ADOPTION_ROOT_RECORD.name), JSON.stringify({
      schema: WORKBENCH_ADOPTION_ROOT_RECORD.schema, creator: 'tools-dev', device: String(stat.dev), inode: String(stat.ino),
    }), { mode: 0o600 });
  }
  async function boot(dataDir: string, labs: { on?: boolean } = {}): Promise<Booted> {
    const bootstrap = preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot: '/x' });
    if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
    const root = bootstrap.canonicalDataRoot;
    const projectsDir = join(root, 'projects'); mkdirSync(join(projectsDir, PROJECT, 'src'), { recursive: true });
    const sources = [{ id: PROJECT }];
    const labsSwitch = createAdoptionLabsSwitch(() => labs.on);
    const provisioning = resolveAdoptionProvisioning({ optIn: true, dataRoot: root, projectRoots: [projectsDir] });
    const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
    const runtime = attachPlacementRuntime(bootstrap, {
      db, projectsDir, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources,
      ...(provisioning.kind === 'provisioned'
        ? { adoption: { helper: provisioning.helper, workRoot: provisioning.workRoot, ...(provisioning.toolRoot ? { toolRoot: provisioning.toolRoot } : {}) } }
        : { adoptionRefusal: provisioning.gates }),
      adoptionEnabled: () => labsSwitch.allowsOpen(),
    });
    const app = express(); app.use(express.json({ limit: '64mb' }));
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: runtime, optIn: () => ({ env: true, labs: labsSwitch.allowsOpen() }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', () => done()));
    const entry = { runtime, db, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, labs };
    booted.push(entry); return entry;
  }
  async function od(url: string, args: string[]): Promise<{ code: number; body: any }> {
    let body: unknown; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } });
    return { code, body };
  }

  it('[spec 2] env + Labs + recorded helper + coordinated: prepare → apply → undo through HTTP and od with the actual helper', async () => {
    // The tools-dev path: it creates the data root, records that, and builds the helper before the daemon boots.
    const dataDir = join(await rootParent(fixture), 'data');
    mkdirSync(dataDir, { mode: 0o700 }); recordFreshRoot(dataDir); await buildIntoDataRoot(dataDir);
    const labs: { on?: boolean } = {};
    const daemon = await boot(dataDir, labs);
    expect(daemon.runtime.mode).toBe('coordinated-open');
    // BLOCK 1: the recorded, still-pristine root counts as created by this boot; the record is consumed.
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: true });
    expect(daemon.runtime.status().activation.gates).not.toContain('legacy-predecessor-unproven');
    const root = daemon.runtime.status().dataRoot!.canonical;
    expect(existsSync(join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name))).toBe(false);
    expect(existsSync(join(root, ...PLACEMENT_ADOPTION_LAYOUT.workRoot))).toBe(false); // Status never constructs.
    const status = await od(daemon.url, ['status', '--json']);
    expect(status.code).toBe(0);
    expect(status.body.status).toMatchObject({ executor: 'provisioned', placementMode: 'coordinated-open', optIn: { env: true, labs: true } });

    const entryPath = join(root, 'projects', PROJECT, 'src', 'App.tsx'); writeFileSync(entryPath, ENTRY);
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
    const undone = await fetch(`${daemon.url}/api/workbench/adoption/operations/${applied.body.operation.operationId}/undo`, { method: 'POST' });
    expect(undone.status).toBe(200);
    expect(sha(readFileSync(entryPath))).toBe(sha(ENTRY));
    const restored = lstatSync(entryPath, { bigint: true });
    expect([restored.dev, restored.ino]).toEqual([preimage.dev, preimage.ino]);
    // BLOCK 2: turning the switch off closes; turning it back on does not reopen until the owner restarts.
    labs.on = false;
    expect(daemon.runtime.adoption).toBeNull();
    labs.on = true;
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().activation.gates).toContain('adoption-opt-in-labs-off');
  }, 120_000);

  it('[BLOCK 1] an existing data root without a creation record keeps the executor closed', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    mkdirSync(dataDir, { mode: 0o700 }); await buildIntoDataRoot(dataDir);
    const daemon = await boot(dataDir);
    expect(daemon.runtime.mode).toBe('coordinated-open');
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: false });
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().activation).toMatchObject({ adoption: 'closed', gates: expect.arrayContaining(['adoption-executor-unprovisioned', 'legacy-predecessor-unproven']) });
    const refused = await fetch(`${daemon.url}/api/workbench/adoption/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: PROJECT, entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' }, writes: [{ path: 'src/App.tsx', role: 'entry', contentBase64: 'eA==' }] }) });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toContain('legacy-predecessor-unproven');
  }, 120_000);

  it('[BLOCK 1] a recorded root that already holds anything else is not fresh, and a restart is never fresh', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    mkdirSync(dataDir, { mode: 0o700 }); recordFreshRoot(dataDir); await buildIntoDataRoot(dataDir);
    writeFileSync(join(dataDir, 'app.sqlite'), ''); // An earlier daemon's database.
    let daemon = await boot(dataDir);
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().activation.gates).toContain('legacy-predecessor-unproven');

    const freshDir = join(await rootParent(fixture), 'data');
    mkdirSync(freshDir, { mode: 0o700 }); recordFreshRoot(freshDir); await buildIntoDataRoot(freshDir);
    daemon = await boot(freshDir);
    expect(daemon.runtime.adoption).not.toBeNull();
    const entry = booted.pop()!;
    await new Promise<void>(done => entry.server.close(() => done())); entry.runtime.close(); entry.db.close();
    daemon = await boot(freshDir);
    expect(daemon.runtime.status().dataRoot).toMatchObject({ createdThisBoot: false });
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().activation.gates).toContain('legacy-predecessor-unproven');
  }, 120_000);

  it('[spec 3] a helper binary changed after its build record keeps the coordinated executor closed', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const binary = await buildIntoDataRoot(dataDir);
    chmodSync(binary, 0o700); writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from([0])])); chmodSync(binary, 0o500);
    const daemon = await boot(dataDir);
    expect(daemon.runtime.mode).toBe('coordinated-open');
    expect(daemon.runtime.adoption).toBeNull();
    expect(daemon.runtime.status().activation.gates).toEqual(expect.arrayContaining(['adoption-executor-unprovisioned', 'adoption-helper-digest-mismatch']));
    const refused = await fetch(`${daemon.url}/api/workbench/adoption/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: PROJECT, entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' }, writes: [{ path: 'src/App.tsx', role: 'entry', contentBase64: 'eA==' }] }) });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details.gates).toContain('adoption-helper-digest-mismatch');
  }, 120_000);
});
