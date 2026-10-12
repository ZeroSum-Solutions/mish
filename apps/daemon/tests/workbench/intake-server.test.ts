import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AttachIntakeResponse, IntakeBatchSnapshot, IntakeFilePutResponse } from '@open-design/contracts';
import type { PlacementBootstrap } from '../../src/workbench/placement/owner-bootstrap.js';

// The shutdown case boots a synthetic coordinated owner on any host; keep process observation synthetic.
vi.mock('../../src/workbench/placement/supervisor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/workbench/placement/supervisor.js')>()),
  createDarwinProcessInspector: () => ({
    bootId: () => '00000000-0000-4000-8000-000000000001',
    table: () => ({ kind: 'unknown' as const, reason: 'synthetic-fixture-no-process-proof' }),
  }),
}));

/**
 * The actual server composition on an isolated data root (ordinary
 * `not-activated` mode): placement-derived Intake authority, awaited startup
 * recovery, managed/imported auto-materialization, attach, clear, restart and
 * the compiled `od` client against the same routes.
 */
const priorDataDir = process.env.OD_DATA_DIR;
const fixtureParent = realpathSync(mkdtempSync(path.join(tmpdir(), 'intake-server-')));
const dataDir = path.join(fixtureParent, 'daemon-data'); mkdirSync(dataDir, { mode: 0o700 });
const importDir = path.join(fixtureParent, 'imported-folder'); mkdirSync(importDir);
process.env.OD_DATA_DIR = dataDir;
const { startServer } = await import('../../src/server.js');
const { closeDatabase } = await import('../../src/db.js');
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

type Started = { server: http.Server; url: string; shutdown?: () => Promise<void> };
let started: Started;
async function start(placementBootstrap?: PlacementBootstrap) { started = await startServer({ port: 0, returnServer: true, ...(placementBootstrap ? { placementBootstrap } : {}) }) as Started; }
async function stop() { await started.shutdown?.(); await new Promise(resolve => started.server.close(() => resolve(undefined))); closeDatabase(); }
const json = async <T>(url: string, init?: RequestInit) => { const response = await fetch(`${started.url}${url}`, init); return { status: response.status, body: await response.json().catch(() => null) as T }; };
const post = <T>(url: string, body: unknown) => json<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (batchId: string, fileId: string, bytes: string | Buffer) => json<IntakeFilePutResponse>(`/api/workbench/intake/${batchId}/files/${fileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
const manifest = (destination: unknown, files: { filename: string; size: number }[]) => ({ intakeBatchId: randomUUID(), destination, files: files.map((file, order) => ({ clientFileId: randomUUID(), order, ...file })) });
const od = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, OD_DAEMON_URL: started.url } }).then(result => ({ code: 0, stdout: result.stdout }), (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }));

let managedId: string, importedId: string, conversationId: string;
beforeAll(async () => {
  await start();
  managedId = `intake-managed-${Date.now()}`;
  expect((await post('/api/projects', { id: managedId, name: managedId })).status).toBe(200);
  const imported = await post<{ project: { id: string } }>('/api/import/folder', { baseDir: importDir }); expect(imported.status).toBe(200);
  importedId = imported.body.project.id;
  const conversation = await post<{ conversation: { id: string } }>(`/api/projects/${importedId}/conversations`, {}); expect(conversation.status).toBe(200);
  conversationId = conversation.body.conversation.id;
});
afterAll(async () => {
  await stop().catch(() => undefined);
  if (priorDataDir === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = priorDataDir;
  rmSync(fixtureParent, { recursive: true, force: true });
});

it('auto-materializes a raw PUT into managed and imported project roots through the real server', async () => {
  for (const [projectId, root] of [[managedId, path.join(dataDir, 'projects', managedId)], [importedId, importDir]] as const) {
    const batch = manifest({ kind: 'project', projectId, dir: 'refs' }, [{ filename: 'héllo.bin', size: 3 }]);
    expect((await post('/api/workbench/intake', batch)).status).toBe(200);
    const stored = await put(batch.intakeBatchId, batch.files[0]!.clientFileId, 'abc');
    expect(stored.status).toBe(200); expect(stored.body.file.stored?.projectFile).toEqual({ projectId, relPath: 'refs/héllo.bin' });
    expect(readFileSync(path.join(root, 'refs', 'héllo.bin'), 'utf8')).toBe('abc');
  }
});

it('runs pending manifest, opaque raw stream, compiled-client show/attach/clear and restart recovery', async () => {
  const opaque = Buffer.from([255, 0, 31, 17]);
  const batch = manifest({ kind: 'pending' }, [{ filename: 'notes.txt', size: 3 }, { filename: 'opaque.png', size: opaque.length }]);
  expect((await post('/api/workbench/intake', batch)).status).toBe(200);
  expect((await put(batch.intakeBatchId, batch.files[0]!.clientFileId, 'abc')).status).toBe(200);
  const opaqueStored = await put(batch.intakeBatchId, batch.files[1]!.clientFileId, opaque);
  expect(opaqueStored.body.file.stored).toMatchObject({ detectedMime: 'application/octet-stream', kind: 'file' });
  const shown = await od(['workbench', 'intake', 'show', '--batch', batch.intakeBatchId, '--json']);
  expect(shown.code).toBe(0); expect((JSON.parse(shown.stdout) as IntakeBatchSnapshot).files.map(file => file.state)).toEqual(['stored', 'stored']);
  const attached = await od(['workbench', 'intake', 'attach', '--batch', batch.intakeBatchId, '--project', importedId, '--conversation', conversationId, '--json']);
  expect(attached.code).toBe(0); const attachment = JSON.parse(attached.stdout) as AttachIntakeResponse;
  expect(attachment.attachments.map(file => file.relPath).sort()).toEqual(['notes.txt', 'opaque.png']);
  expect(readFileSync(path.join(importDir, 'opaque.png'))).toEqual(opaque);
  const cleared = await od(['workbench', 'intake', 'clear', '--batch', batch.intakeBatchId, '--json']);
  expect(cleared.code).toBe(0); expect((JSON.parse(cleared.stdout) as IntakeBatchSnapshot).files.every(file => file.state === 'cleared' && file.hasSuccessfulAttachment)).toBe(true);

  const file = path.join(fixtureParent, 'cli.txt'); writeFileSync(file, 'xyz');
  const streamed = await od(['workbench', 'intake', '--file', file, '--json']);
  expect(streamed.code).toBe(0); expect((JSON.parse(streamed.stdout) as IntakeBatchSnapshot).files[0]).toMatchObject({ state: 'stored', stored: { size: 3 } });

  const interrupted = manifest({ kind: 'pending' }, [{ filename: 'later.bin', size: 3 }]);
  expect((await post('/api/workbench/intake', interrupted)).status).toBe(200);
  await stop(); await start();
  const recovered = await json<IntakeBatchSnapshot>(`/api/workbench/intake/${interrupted.intakeBatchId}`);
  expect(recovered.body.files[0]).toMatchObject({ state: 'needs-reselection', error: { code: 'intake-interrupted' }, retryable: true });
  const retried = await put(interrupted.intakeBatchId, interrupted.files[0]!.clientFileId, 'def');
  expect(retried.status).toBe(200); expect(retried.body.file.state).toBe('stored');
  expect((await json<IntakeBatchSnapshot>(`/api/workbench/intake/${batch.intakeBatchId}`)).body.files.map(file => file.state)).toEqual(['cleared', 'cleared']);
  expect(readdirSync(path.join(dataDir, 'library', 'intake-temp'))).toEqual([]);
});

it('keeps the coordinated owner until an accepted held PUT drains through shutdown', async () => {
  await stop();
  // Synthetic coordinated owner over this data root (as in project-file-placement-routes.test.ts).
  const owner = { held: true }, identity = lstatSync(dataDir, { bigint: true });
  await start({
    mode: 'coordinated', host: { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true },
    owner: { canonicalDataRoot: dataDir, inspect: () => ({ held: owner.held, qualified: owner.held }), close: () => { owner.held = false; } },
    canonicalDataRoot: dataDir, rootIdentity: { device: String(identity.dev), inode: String(identity.ino) }, createdRoot: false,
    binding: { path: '/synthetic/owner.node', sha256: '0'.repeat(64) }, provenanceSHA256: '0'.repeat(64), sequence: 0,
  } as unknown as PlacementBootstrap);
  const batch = manifest({ kind: 'pending' }, [{ filename: 'held.bin', size: 8 }]);
  expect((await post('/api/workbench/intake', batch)).status).toBe(200);
  const tempDir = path.join(dataDir, 'library', 'intake-temp');
  let held!: http.ClientRequest;
  const response = new Promise<{ status: number; body: IntakeFilePutResponse }>((resolve, reject) => {
    const request = http.request(`${started.url}/api/workbench/intake/${batch.intakeBatchId}/files/${batch.files[0]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': '8' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    request.on('error', reject); request.write('held'); held = request;
  });
  void response.catch(() => undefined); // The cleanup destroy rejects only an already-failed case.
  const receiving = () => { try { return readdirSync(tempDir).some(name => readFileSync(path.join(tempDir, name), 'utf8') === 'held'); } catch { return false; } };
  // A failed assertion must not strand the held socket and the server close behind it.
  try { await heldPutThroughShutdown(); } finally { held.destroy(); }
  async function heldPutThroughShutdown() {
    for (let attempt = 0; attempt < 400 && !receiving(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(receiving()).toBe(true);

    let stopped = false;
    const shutdown = started.shutdown!().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    // The accepted write still holds custody: the owner stays held and shutdown waits for it.
    expect({ held: owner.held, stopped }).toEqual({ held: true, stopped: false });
    // Admission closed at shutdown start: new Intake root work is refused.
    expect((await post('/api/workbench/intake', manifest({ kind: 'pending' }, [{ filename: 'late.bin', size: 1 }]))).status).toBe(503);

    held.end('-put');
    const stored = await response;
    expect(stored.status).toBe(200); expect(stored.body.file.state).toBe('stored');
    await shutdown;
    expect(owner.held).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  }
});
