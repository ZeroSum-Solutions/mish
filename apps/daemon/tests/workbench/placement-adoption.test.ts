import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { buildDarwinPlacementHelper } from '../../src/workbench/placement/build.js';
import { preparePlacementBootstrap } from '../../src/workbench/placement/owner-bootstrap.js';
import { attachPlacementRuntime, type PlacementRuntime } from '../../src/workbench/placement/runtime.js';
import type { Helper } from '../../src/workbench/placement/driver.js';
import { buildOwnerFixture, nativeSupported, ownerEnv, rootParent, type OwnerFixture } from './placement/runtime-fixture.js';

/**
 * F5 hero journey at the daemon HTTP boundary: the real adoption route module
 * over the real coordinated placement runtime (actual native owner, owned
 * migrations, journal, registry, coordinator) and the actual native exclusive
 * movement helper, on real files under a real data root. "Restart" closes the
 * runtime, owner and database and boots a fresh incarnation on the same root.
 * The compiled `od` + tools-dev daemon process journey is a separate gate.
 */
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL_ENTRY = "export default function App() { return <main>original</main>; }\n";
const USER_EDIT = "export default function App() { return <main>user edit — keep me</main>; }\n";
const HERO_V1 = 'export function Hero16() { return <section>v1</section>; }\n';
const HERO_V2 = 'export function Hero16() { return <section className="hero">v2 edited</section>; }\n';
const ENTRY_V2 = "import { Hero16 } from './Hero16';\nexport default function App() { return <Hero16 />; }\n";
const PROJECT = 'hero';

interface Booted { runtime: PlacementRuntime; db: Database.Database; server: Server; url: string }
const booted: Booted[] = [];
async function shutdown(entry: Booted): Promise<void> {
  await new Promise<void>(done => entry.server.close(() => done()));
  entry.runtime.close(); if (entry.db.open) entry.db.close();
  booted.splice(booted.indexOf(entry), 1);
}
afterEach(async () => { for (const entry of [...booted]) await shutdown(entry); });

describe.skipIf(!nativeSupported)('F5 adoption: prepare/apply/undo over HTTP and od', () => {
  let fixture: OwnerFixture; let helper: Helper;
  beforeAll(async () => {
    fixture = await buildOwnerFixture('adoption');
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/workbench/placement/native.c');
    const built = await buildDarwinPlacementHelper({ sourcePath: source, outputPath: join(fixture.evidence, 'placement-helper'), arch: 'arm64' });
    helper = { path: built.path, sha256: built.sha256 };
  }, 120_000);

  async function boot(dataDir: string): Promise<Booted> {
    const bootstrap = preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot: '/x' });
    if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
    const root = bootstrap.canonicalDataRoot;
    const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
    const projectsDir = join(root, 'projects'); mkdirSync(join(projectsDir, PROJECT, 'src'), { recursive: true });
    const sources = [{ id: PROJECT }];
    const runtime = attachPlacementRuntime(bootstrap, {
      db, projectsDir, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources,
      adoption: { helper, workRoot: join(root, 'placement-adoption') },
    });
    const app = express(); app.use(express.json({ limit: '64mb' }));
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: runtime });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', () => done()));
    const entry = { runtime, db, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    booted.push(entry); return entry;
  }
  async function od(url: string, args: string[]): Promise<{ code: number; body: any }> {
    let body: unknown; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } });
    return { code, body };
  }
  function draft(dir: string, name: string, hero: string, entry: string): string {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({
      projectId: PROJECT, entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' },
      writes: [
        { path: 'src/Hero16.tsx', role: 'source', contentBase64: Buffer.from(hero).toString('base64') },
        { path: 'src/App.tsx', role: 'entry', contentBase64: Buffer.from(entry).toString('base64') },
      ],
    }));
    return file;
  }

  it('[P0] edit → reprepare → apply → exact-byte undo, zero retries; a restarted root stays closed', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    let daemon = await boot(dataDir);
    expect(daemon.runtime.mode).toBe('coordinated-open');
    const projectDir = join(daemon.runtime.status().dataRoot!.canonical, 'projects', PROJECT);
    const entryPath = join(projectDir, 'src/App.tsx'), heroPath = join(projectDir, 'src/Hero16.tsx');
    writeFileSync(entryPath, ORIGINAL_ENTRY);
    const work = await rootParent(fixture);

    // Prepare v1, then the user edits the draft and reprepares: a new immutable plan.
    const first = await od(daemon.url, ['prepare', '--request-file', draft(work, 'v1', HERO_V1, ENTRY_V2), '--json']);
    expect(first.code).toBe(0);
    const second = await od(daemon.url, ['prepare', '--request-file', draft(work, 'v2', HERO_V2, ENTRY_V2), '--json']);
    expect(second.code).toBe(0);
    expect(second.body.plan.id).not.toBe(first.body.plan.id);
    expect(second.body.plan.digest).not.toBe(first.body.plan.digest);
    expect(second.body.plan.writes.map((w: any) => [w.path, w.kind])).toEqual([['src/Hero16.tsx', 'create'], ['src/App.tsx', 'replace']]);
    expect(readFileSync(entryPath, 'utf8')).toBe(ORIGINAL_ENTRY); // Preparation never touches the project.
    const preimage = lstatSync(entryPath, { bigint: true });

    const applied = await od(daemon.url, ['apply', '--plan', second.body.plan.id, '--digest', second.body.plan.digest, '--json']);
    expect(applied.code).toBe(0);
    expect(applied.body.operation).toMatchObject({ kind: 'apply', state: 'done', planId: second.body.plan.id });
    expect(readFileSync(entryPath, 'utf8')).toBe(ENTRY_V2);
    expect(readFileSync(heroPath, 'utf8')).toBe(HERO_V2);
    // The superseded plan no longer matches the project and is refused without mutation.
    const stale = await fetch(`${daemon.url}/api/workbench/adoption/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: first.body.plan.id, planDigest: first.body.plan.digest }) });
    expect(stale.status).toBe(409);
    expect(readFileSync(entryPath, 'utf8')).toBe(ENTRY_V2);

    // Exact-byte, same-inode undo in the incarnation that applied.
    const undone = await od(daemon.url, ['undo', '--operation', applied.body.operation.operationId, '--json']);
    expect(undone.code).toBe(0);
    expect(undone.body.operation).toMatchObject({ kind: 'undo', state: 'done', undoOf: applied.body.operation.operationId });
    expect(sha(readFileSync(entryPath))).toBe(sha(ORIGINAL_ENTRY));
    const restored = lstatSync(entryPath, { bigint: true });
    expect([restored.dev, restored.ino]).toEqual([preimage.dev, preimage.ino]); // The retained original object returns.
    expect(existsSync(heroPath)).toBe(false);

    // Undo is idempotent: a repeat replays the recorded operation instead of moving again.
    const again = await od(daemon.url, ['undo', '--operation', applied.body.operation.operationId, '--json']);
    expect(again.body.operation.operationId).toBe(undone.body.operation.operationId);
    expect(sha(readFileSync(entryPath))).toBe(sha(ORIGINAL_ENTRY));

    // Restart: an existing root cannot prove the absence of an unrecorded ordinary predecessor
    // (RUNTIME.md "Legacy and mixed-mode roots"), so the new incarnation keeps adoption closed
    // and readback refuses with the named gate; the project bytes are untouched.
    await shutdown(daemon);
    daemon = await boot(dataDir);
    expect(daemon.runtime.mode).toBe('coordinated-open');
    expect(daemon.runtime.adoption).toBeNull();
    const shown = await od(daemon.url, ['show', '--operation', applied.body.operation.operationId, '--json']);
    expect(shown).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'unsupported-capability', gates: expect.arrayContaining(['legacy-predecessor-unproven']) } } } });
    expect(sha(readFileSync(entryPath))).toBe(sha(ORIGINAL_ENTRY));
  }, 120_000);

  it('[P0] an external edit after prepare is refused with 409 and the user file is preserved', async () => {
    const daemon = await boot(join(await rootParent(fixture), 'data'));
    const projectDir = join(daemon.runtime.status().dataRoot!.canonical, 'projects', PROJECT);
    const entryPath = join(projectDir, 'src/App.tsx'), heroPath = join(projectDir, 'src/Hero16.tsx');
    writeFileSync(entryPath, ORIGINAL_ENTRY);
    const prepared = await od(daemon.url, ['prepare', '--request-file', draft(await rootParent(fixture), 'v1', HERO_V1, ENTRY_V2), '--json']);
    expect(prepared.code).toBe(0);

    writeFileSync(entryPath, USER_EDIT); // External editor saves between prepare and apply.
    const refused = await fetch(`${daemon.url}/api/workbench/adoption/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: prepared.body.plan.id, planDigest: prepared.body.plan.digest }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toMatchObject({ code: 'CONFLICT', details: { kind: 'adoption', reason: 'read-set-changed' } });
    expect(readFileSync(entryPath, 'utf8')).toBe(USER_EDIT);
    expect(existsSync(heroPath)).toBe(false);

    const viaOd = await od(daemon.url, ['apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(viaOd.code).toBe(3);
    expect(viaOd.body).toMatchObject({ status: 409, error: { code: 'CONFLICT' } });
    expect(readFileSync(entryPath, 'utf8')).toBe(USER_EDIT);

    // An edit after apply likewise refuses undo instead of overwriting the user's newer bytes.
    const reprepared = await od(daemon.url, ['prepare', '--request-file', draft(await rootParent(fixture), 'v2', HERO_V1, ENTRY_V2), '--json']);
    const applied = await od(daemon.url, ['apply', '--plan', reprepared.body.plan.id, '--digest', reprepared.body.plan.digest, '--json']);
    expect(applied.body.operation.state).toBe('done');
    writeFileSync(entryPath, USER_EDIT);
    const undo = await fetch(`${daemon.url}/api/workbench/adoption/operations/${applied.body.operation.operationId}/undo`, { method: 'POST' });
    expect(undo.status).toBe(409);
    expect(readFileSync(entryPath, 'utf8')).toBe(USER_EDIT);
    expect(readFileSync(heroPath, 'utf8')).toBe(HERO_V1);
  }, 120_000);
});
