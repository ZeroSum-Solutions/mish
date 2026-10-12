import type http from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase } from '../src/db.js';
import { projectFileRenameTestHooks, projectFileWriteTestHooks } from '../src/projects.js';
import { startServer } from '../src/server.js';
import type { PlacementBootstrap } from '../src/workbench/placement/owner-bootstrap.js';

// This file injects a synthetic Darwin owner on Linux too. Keep its process
// observation synthetic and fail closed if a prior launch ever needs proof.
vi.mock('../src/workbench/placement/supervisor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workbench/placement/supervisor.js')>()),
  createDarwinProcessInspector: () => ({
    bootId: () => '00000000-0000-4000-8000-000000000001',
    table: () => ({ kind: 'unknown' as const, reason: 'synthetic-fixture-no-process-proof' }),
  }),
}));

/**
 * Manual project-file writers at the daemon HTTP boundary with real bytes.
 * "Coordinated" boots use an INJECTED synthetic owner and process inspector
 * over this file's isolated data root (no native binary, no Darwin custody);
 * registry, coordinator, journal, routes, Multer, and helpers are the real daemon.
 */
type Started = { server: http.Server; url: string; shutdown?: () => Promise<void> };
const dataRoot = realpathSync.native(process.env.OD_DATA_DIR!);
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-file-placement-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { projectFileRenameTestHooks.beforeCommit = null; projectFileWriteTestHooks.afterCommit = null; });

function syntheticOwner() {
  const owner = { held: true };
  const identity = lstatSync(dataRoot, { bigint: true });
  const bootstrap = {
    mode: 'coordinated', host: { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true },
    owner: { canonicalDataRoot: dataRoot, inspect: () => ({ held: owner.held, qualified: owner.held }), close: () => { owner.held = false; } },
    canonicalDataRoot: dataRoot, rootIdentity: { device: String(identity.dev), inode: String(identity.ino) }, createdRoot: false,
    binding: { path: '/synthetic/owner.node', sha256: '0'.repeat(64) }, provenanceSHA256: '0'.repeat(64), sequence: 0,
  } as unknown as PlacementBootstrap;
  return { owner, bootstrap };
}
/** Every held gate/stream is released before shutdown, so a failed assertion cannot strand a request. */
const releases: Array<() => void> = [];
async function withServer(bootstrap: PlacementBootstrap | null, run: (base: string) => Promise<void>) {
  const prefix = '[od] placement-runtime ';
  let statusLine: string | null = null;
  const originalLog = console.log.bind(console);
  const startupLog = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    if (typeof values[0] === 'string' && values[0].startsWith(prefix)) statusLine = values[0].slice(prefix.length);
    originalLog(...values);
  });
  let started: Started;
  try { started = await startServer({ port: 0, returnServer: true, placementBootstrap: bootstrap }) as Started; }
  finally { startupLog.mockRestore(); }
  try {
    if (bootstrap?.mode === 'coordinated') {
      const status = statusLine ? JSON.parse(statusLine) as { mode?: string; reason?: string } : null;
      expect(status, `Synthetic coordinated setup did not open: ${statusLine ?? 'placement status was not logged'}`)
        .toMatchObject({ mode: 'coordinated-open', reason: 'owner-qualified' });
    }
    await run(started.url);
  } finally {
    for (const release of releases.splice(0)) release();
    projectFileRenameTestHooks.beforeCommit = null; projectFileWriteTestHooks.afterCommit = null;
    await new Promise(resolve => setTimeout(resolve, 50));
    await started.shutdown?.(); started.server.closeAllConnections?.();
    await new Promise(resolve => started.server.close(() => resolve(undefined))); closeDatabase();
  }
}
const json = async (url: string, init?: RequestInit) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const post = (url: string, body: unknown) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function project(base: string, metadata?: Record<string, unknown>) {
  const id = `pf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (metadata?.baseDir) {
    const imported = await post(`${base}/api/import/folder`, { baseDir: metadata.baseDir, name: id }); expect(imported.status).toBe(200);
    return imported.body.project.id as string;
  }
  expect((await post(`${base}/api/projects`, { id, name: id })).status).toBe(200); return id;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
const outcome = (promise: Promise<unknown>, ms = 400) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), ms))]);
/** Multipart whose single file part sends `head`, waits for `gate`, then sends `tail` (a held, partially streamed upload). */
function pausedUpload(fields: Record<string, string>, name: string, head: string, tail: string, gate: Promise<void>) {
  const boundary = `b${Math.random().toString(16).slice(2)}`; const encode = (text: string) => new TextEncoder().encode(text);
  const preamble = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${head}`;
  const body = new ReadableStream({ async start(controller) {
    controller.enqueue(encode(preamble)); await gate; controller.enqueue(encode(`${tail}\r\n--${boundary}--\r\n`)); controller.close();
  } });
  return { method: 'POST', body, duplex: 'half', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } } as RequestInit;
}
const managedRoot = (id: string) => path.join(dataRoot, 'projects', id);
const versionStore = (id: string) => path.join(dataRoot, 'projects', id, '.file-versions');

describe('coordinated manual project-file writers (synthetic owner, real daemon)', () => {
  it('multipart admission precedes Multer directory/bytes, and a streaming upload holds the project gate until it settles', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'held.txt', content: 'held' })).status).toBe(200);
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'victim.txt', content: 'victim' })).status).toBe(200);
      // 1) A rename holds the project inside its accepted write; the upload must not create its folder or bytes meanwhile.
      const hold = deferred(); let entered!: () => void; const inHook = new Promise<void>(done => { entered = done; });
      projectFileRenameTestHooks.beforeCommit = async () => { entered(); await hold.promise; };
      const renaming = post(`${base}/api/projects/${id}/files/rename`, { from: 'held.txt', to: 'renamed.txt' });
      await inHook;
      const form = new FormData(); form.append('dir', 'drops'); form.append('files', new Blob(['dropped']), 'drop.txt');
      const uploading = fetch(`${base}/api/projects/${id}/upload`, { method: 'POST', body: form });
      expect(await outcome(uploading)).toBe('pending');
      expect(existsSync(path.join(root, 'drops'))).toBe(false);
      hold.resolve(); projectFileRenameTestHooks.beforeCommit = null;
      expect((await renaming).status).toBe(200); expect((await uploading).status).toBe(200);
      expect(readFileSync(path.join(root, 'drops', 'drop.txt'), 'utf8')).toBe('dropped');
      // 2) While a file part is mid-stream, another writer on the same project waits for the upload to settle.
      const resume = deferred();
      const streaming = fetch(`${base}/api/projects/${id}/upload`, pausedUpload({}, 'stream.txt', 'h'.repeat(256 * 1024), 'tail', resume.promise));
      for (let i = 0; i < 100 && !existsSync(path.join(root, 'stream.txt')); i++) await new Promise(r => setTimeout(r, 10));
      expect(existsSync(path.join(root, 'stream.txt'))).toBe(true); // bytes are flowing inside the accepted lifetime
      const deleting = fetch(`${base}/api/projects/${id}/files/victim.txt`, { method: 'DELETE' });
      expect(await outcome(deleting)).toBe('pending');
      expect(existsSync(path.join(root, 'victim.txt'))).toBe(true);
      resume.resolve();
      expect((await streaming).status).toBe(200); expect((await deleting).status).toBe(200);
      expect(readFileSync(path.join(root, 'stream.txt'), 'utf8')).toBe(`${'h'.repeat(256 * 1024)}tail`);
      expect(existsSync(path.join(root, 'victim.txt'))).toBe(false);
    });
  }, 60_000);
  it('history GET creates a missing baseline only inside admission; an existing-history read stays available', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'kept.html', content: '<p>kept</p>' })).status).toBe(200); // has history
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'held.txt', content: 'held' })).status).toBe(200);
      writeFileSync(path.join(root, 'seeded.html'), '<p>seeded</p>'); // EXTERNAL fixture setup: an HTML file with no history
      const hold = deferred(); let entered!: () => void; const inHook = new Promise<void>(done => { entered = done; });
      projectFileRenameTestHooks.beforeCommit = async () => { entered(); await hold.promise; };
      const renaming = post(`${base}/api/projects/${id}/files/rename`, { from: 'held.txt', to: 'renamed.txt' });
      await inHook;
      const existing = await json(`${base}/api/projects/${id}/files/kept.html/versions`);
      expect(existing.status).toBe(200); expect(existing.body.versions).toHaveLength(1);
      const baseline = json(`${base}/api/projects/${id}/files/seeded.html/versions`);
      expect(await outcome(baseline)).toBe('pending');
      expect(readdirSync(versionStore(id)).length).toBe(1); // only kept.html's store
      hold.resolve(); projectFileRenameTestHooks.beforeCommit = null;
      expect((await renaming).status).toBe(200);
      const created = await baseline; expect(created.status).toBe(200); expect(created.body.versions).toHaveLength(1);
      expect(readdirSync(versionStore(id)).length).toBe(2);
    });
  }, 60_000);
  it('history GET queued behind a save does not restore its stale pre-admission baseline', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'held.txt', content: 'held' })).status).toBe(200);
      writeFileSync(path.join(root, 'page.html'), '<p>before</p>'); // external file: no version history
      const hold = deferred(); let entered!: () => void; const inHook = new Promise<void>(done => { entered = done; });
      projectFileRenameTestHooks.beforeCommit = async () => { entered(); await hold.promise; };
      const renaming = post(`${base}/api/projects/${id}/files/rename`, { from: 'held.txt', to: 'renamed.txt' });
      await inHook;
      const saving = post(`${base}/api/projects/${id}/files`, { name: 'page.html', content: '<p>after</p>' });
      expect(await outcome(saving)).toBe('pending');
      const history = json(`${base}/api/projects/${id}/files/page.html/versions`);
      expect(await outcome(history)).toBe('pending');
      expect(readFileSync(path.join(root, 'page.html'), 'utf8')).toBe('<p>before</p>');
      hold.resolve(); projectFileRenameTestHooks.beforeCommit = null;
      expect((await renaming).status).toBe(200);
      expect((await saving).status).toBe(200);
      const observed = await history;
      expect(observed.status).toBe(200);
      expect(observed.body.versions).toHaveLength(1);
      const current = observed.body.versions.find((version: { current: boolean }) => version.current);
      expect(current).toBeDefined();
      const captured = await json(`${base}/api/projects/${id}/files/page.html/versions/${current.id}`);
      expect(captured.status).toBe(200);
      expect(captured.body.content).toBe('<p>after</p>');
      expect(readFileSync(path.join(root, 'page.html'), 'utf8')).toBe('<p>after</p>');
    });
  }, 60_000);
  it('history GET queued behind a removal does not create a ghost baseline', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'held.txt', content: 'held' })).status).toBe(200);
      writeFileSync(path.join(root, 'page.html'), '<p>before</p>'); // external file: no version history
      const hold = deferred(); let entered!: () => void; const inHook = new Promise<void>(done => { entered = done; });
      projectFileRenameTestHooks.beforeCommit = async () => { entered(); await hold.promise; };
      const renaming = post(`${base}/api/projects/${id}/files/rename`, { from: 'held.txt', to: 'renamed.txt' });
      await inHook;
      const removing = fetch(`${base}/api/projects/${id}/files/page.html`, { method: 'DELETE' });
      expect(await outcome(removing)).toBe('pending');
      const history = json(`${base}/api/projects/${id}/files/page.html/versions`);
      expect(await outcome(history)).toBe('pending');
      hold.resolve(); projectFileRenameTestHooks.beforeCommit = null;
      expect((await renaming).status).toBe(200);
      expect((await removing).status).toBe(200);
      expect((await history).status).toBe(404);
      expect(existsSync(path.join(root, 'page.html'))).toBe(false);
    });
  }, 60_000);
  it('restore queued behind a rename cannot recreate the old file and history path', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      const saved = await post(`${base}/api/projects/${id}/files`, { name: 'a.html', content: '<p>saved</p>' });
      expect(saved.status).toBe(200);
      const versionId = saved.body.version.id as string;
      const hold = deferred(); let entered!: () => void; const inHook = new Promise<void>(done => { entered = done; });
      projectFileRenameTestHooks.beforeCommit = async () => { entered(); await hold.promise; };
      const renaming = post(`${base}/api/projects/${id}/files/rename`, { from: 'a.html', to: 'b.html' });
      await inHook;
      const restoring = post(`${base}/api/projects/${id}/files/a.html/versions/${versionId}/restore`, {});
      expect(await outcome(restoring)).toBe('pending');
      hold.resolve(); projectFileRenameTestHooks.beforeCommit = null;
      expect((await renaming).status).toBe(200);
      const refused = await restoring;
      expect(refused.status).toBe(404);
      expect(refused.body?.error?.code).toBe('VERSION_NOT_FOUND');
      expect(existsSync(path.join(root, 'a.html'))).toBe(false);
      expect(readdirSync(versionStore(id))).toHaveLength(1); // only b.html's moved store
      expect(readFileSync(path.join(root, 'b.html'), 'utf8')).toBe('<p>saved</p>');
    });
  }, 60_000);
  it('an imported root replaced across awaited rename work refuses with 409 and moves no bytes', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const dir = path.join(scratch, `imported-${Date.now()}`); mkdirSync(dir);
      const id = await project(base, { baseDir: dir });
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'a.txt', content: 'a' })).status).toBe(200);
      projectFileRenameTestHooks.beforeCommit = async () => { renameSync(dir, `${dir}-moved`); mkdirSync(dir); };
      const renamed = await post(`${base}/api/projects/${id}/files/rename`, { from: 'a.txt', to: 'b.txt' });
      expect(renamed.status).toBe(409); expect(renamed.body?.error?.details).toMatchObject({ kind: 'placement', reason: 'RUN_SCOPE_CHANGED' });
      expect(readFileSync(path.join(`${dir}-moved`, 'a.txt'), 'utf8')).toBe('a'); expect(readdirSync(dir)).toEqual([]);
    });
  }, 60_000);
  it('a project with no authorized row is an explicit 404 in coordinated mode', async () => {
    const { bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = `rowless-${Date.now()}`;
      const saved = await post(`${base}/api/projects/${id}/files`, { name: 'x.txt', content: 'x' });
      expect(saved.status).toBe(404); expect(saved.body?.error?.code).toBe('PROJECT_NOT_FOUND');
      expect(existsSync(managedRoot(id))).toBe(false);
    });
  }, 60_000);
  it.each([
    { route: 'rename', hook: 'rename' as const },
    { route: 'save version capture', hook: 'write' as const },
  ])('owner loss across awaited $route work is a typed 503, never a 200 or version warning', async ({ hook }) => {
    const { owner, bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id);
      if (hook === 'rename') {
        expect((await post(`${base}/api/projects/${id}/files`, { name: 'a.txt', content: 'a' })).status).toBe(200);
        projectFileRenameTestHooks.beforeCommit = async () => { owner.held = false; };
        const renamed = await post(`${base}/api/projects/${id}/files/rename`, { from: 'a.txt', to: 'b.txt' });
        expect(renamed.status).toBe(503); expect(renamed.body?.error?.details).toMatchObject({ kind: 'placement', reason: 'OWNER_UNQUALIFIED' });
        expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a'); expect(existsSync(path.join(root, 'b.txt'))).toBe(false);
      } else {
        projectFileWriteTestHooks.afterCommit = async () => { owner.held = false; };
        const saved = await post(`${base}/api/projects/${id}/files`, { name: 'page.html', content: '<p>v1</p>' });
        expect(saved.status).toBe(503); expect(saved.body?.error?.details).toMatchObject({ kind: 'placement', reason: 'OWNER_UNQUALIFIED' });
        expect(existsSync(versionStore(id))).toBe(false); // no history committed after the loss
      }
    });
  }, 60_000);
  it('owner loss while a file part streams refuses the upload with 503 instead of a 200 file list', async () => {
    const { owner, bootstrap } = syntheticOwner();
    await withServer(bootstrap, async base => {
      const id = await project(base); const root = managedRoot(id); const resume = deferred();
      const streaming = fetch(`${base}/api/projects/${id}/upload`, pausedUpload({}, 'lost.txt', 'h'.repeat(256 * 1024), 'tail', resume.promise));
      for (let i = 0; i < 100 && !existsSync(path.join(root, 'lost.txt')); i++) await new Promise(r => setTimeout(r, 10));
      owner.held = false; resume.resolve();
      const response = await streaming; const body = await response.json().catch(() => null) as any;
      expect(response.status).toBe(503); expect(body?.error?.details).toMatchObject({ kind: 'placement', reason: 'OWNER_UNQUALIFIED' });
      const kept = existsSync(path.join(root, 'lost.txt')) ? readFileSync(path.join(root, 'lost.txt'), 'utf8') : '';
      expect(kept.endsWith('tail')).toBe(false); // no completed file after the loss
    });
  }, 60_000);
});

describe('ordinary not-activated controls (no coordinator)', () => {
  it('row-less creation, imported save/upload/history and rename keep ordinary behavior', async () => {
    await withServer(null, async base => {
      const rowless = `rowless-ordinary-${Date.now()}`;
      expect((await post(`${base}/api/projects/${rowless}/files`, { name: 'x.txt', content: 'x' })).status).toBe(200);
      expect(readFileSync(path.join(managedRoot(rowless), 'x.txt'), 'utf8')).toBe('x');
      const dir = path.join(scratch, `ordinary-${Date.now()}`); mkdirSync(dir); const id = await project(base, { baseDir: dir });
      expect((await post(`${base}/api/projects/${id}/files`, { name: 'page.html', content: '<p>v1</p>' })).status).toBe(200);
      const form = new FormData(); form.append('files', new Blob(['<p>up</p>']), 'up.html');
      expect((await fetch(`${base}/api/projects/${id}/upload`, { method: 'POST', body: form })).status).toBe(200);
      expect((await json(`${base}/api/projects/${id}/files/up.html/versions`)).body.versions).toHaveLength(1);
      expect((await post(`${base}/api/projects/${id}/files/rename`, { from: 'page.html', to: 'moved.html' })).status).toBe(200);
      expect(readFileSync(path.join(dir, 'moved.html'), 'utf8')).toBe('<p>v1</p>'); expect(readFileSync(path.join(dir, 'up.html'), 'utf8')).toBe('<p>up</p>');
    });
  }, 60_000);
});
