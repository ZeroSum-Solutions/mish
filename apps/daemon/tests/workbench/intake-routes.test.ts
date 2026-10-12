import express, { type Request, type Response } from 'express';
import { parseIntakeFilePutResponse, type ApiErrorResponse } from '@open-design/contracts';
import Database from 'better-sqlite3';
import { request as httpRequest, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateLibrary } from '../../src/library-store.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchIntakeRoutes, type RegisterWorkbenchIntakeRoutesDeps } from '../../src/routes/workbench-intake.js';
import { registerLibraryRoutes, type RegisterLibraryRoutesDeps } from '../../src/routes/library.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';
import { registerProjectUploadRoutes, type RegisterProjectUploadRoutesDeps } from '../../src/routes/project/index.js';
import { coordinatedIntake, cleanupIntakeRoots, filesUnder, intakeManifest, ordinaryIntakeAuthority, ticks, waitFor, type IntakeAuthority } from './intake-placement-fixture.js';
import { PlacementCoordinationError } from '../../src/workbench/placement/write-coordinator.js';
let server: Server | undefined, root: string | undefined;
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(r => server!.close(() => r())); if (root) await rm(root,{recursive:true,force:true}); cleanupIntakeRoots(); });
async function boot(authorize?: RegisterWorkbenchIntakeRoutesDeps['authorizeProjectRequest'], placement: { authority?: IntakeAuthority; projectsDir?: string; getProject?: (id: string) => unknown } = {}) {
  root = await mkdtemp(path.join(tmpdir(),'intake-http-')); const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const app = express(); app.use(express.json());
  const service = registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR:path.join(root,'library'), PROJECTS_DIR:placement.projectsDir ?? path.join(root,'projects') }, projectStore: { getProject: (_db: unknown,id: string) => placement.getProject ? placement.getProject(id) : ({ id,metadata:{} }) }, conversations:{getConversation: (_db: unknown,id: string) => ({projectId:id === 'c' ? 'p' : 'other'})}, authorizeProjectRequest:authorize ?? (async (_req: Request,res: Response,id: string) => { if (id === 'forbidden') { sendApiError(res,403,'project-forbidden','Denied'); return false; } return true; }), intakeWriteAuthority: placement.authority ?? ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(r => server!.once('listening',r)); const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const input = { intakeBatchId:randomUUID(),destination:{kind:'pending'},files:[{clientFileId:randomUUID(),order:0,filename:'héllo.bin',size:3}] };
  return { url,db,service,input,app };
}
async function create(url: string, input: unknown, extra = {}) { return fetch(`${url}/api/workbench/intake`,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(input)}); }
it('uses raw bytes, exact hash and a download disposition with UTF-8 basename',async () => {
  const {url,input} = await boot(); expect((await create(url,input)).status).toBe(200);
  const fileUrl=`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const response=await fetch(fileUrl,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'}); expect(response.status).toBe(200);
  const stored=parseIntakeFilePutResponse(await response.json()); expect(stored.file.stored!.contentHash).toBe(createHash('sha256').update('abc').digest('hex')); expect(stored.file.stored!.kind).toBe('text');
  const download=await fetch(`${fileUrl}/download`); expect(download.status).toBe(200); expect(await download.text()).toBe('abc');
  expect(download.headers.get('content-security-policy')).toBe('sandbox'); expect(download.headers.get('x-content-type-options')).toBe('nosniff'); expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''h%C3%A9llo.bin");
});
it('refuses extension origin, incomplete selectors and frozen manifest mutation before storage',async () => {
  const {url,input} = await boot(); expect((await create(url,input,{origin:'chrome-extension://forged'})).status).toBe(403);
  expect((await create(url,input,{'x-od-workspace-id':'w'})).status).toBe(400);
  expect((await create(url,input)).status).toBe(200);
  expect((await create(url,{...input,destination:{kind:'project',projectId:'p'}})).status).toBe(409);
  expect((await readdir(root!))).toEqual([]);
});
it('uses namespace navigation for download and rejects mixed header/query selectors',async () => {
  const {url,input} = await boot(); const scope={'x-od-workspace-id':'w','x-od-workspace-member-id':'m'}; await create(url,input,scope);
  const file=`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  expect((await fetch(file,{method:'PUT',headers:{...scope,'content-type':'application/octet-stream'},body:'abc'})).status).toBe(200);
  expect((await fetch(`${file}/download?workspaceId=w&workspaceMemberId=m`)).status).toBe(200);
  expect((await fetch(`${file}/download?workspaceId=w&workspaceMemberId=m`,{headers:{...scope,'x-od-workspace-member-id':'other'}})).status).toBe(400);
  expect((await fetch(`${file}/download`)).status).toBe(403);
});
it('holds two actual streamed requests and refuses a third before its temp file exists',async () => {
  const {url,input,db} = await boot(); const inputs=[input,{...input,intakeBatchId:randomUUID(),files:[{...input.files[0]!,clientFileId:randomUUID()}]},{...input,intakeBatchId:randomUUID(),files:[{...input.files[0]!,clientFileId:randomUUID()}]}];
  for (const item of inputs) await create(url,item);
  const requests=inputs.slice(0,2).map(item => {const req=httpRequest(`${url}/api/workbench/intake/${item.intakeBatchId}/files/${item.files[0]!.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':'3'}}); req.on('error',()=>{}); req.write('a'); return req;});
  let temps: string[]=[]; for(let n=0;n<50;n++){temps=await readdir(path.join(root!,'library','intake-temp')).catch(()=>[]);if(temps.length===2)break;await new Promise(r=>setTimeout(r,10));}
  expect(temps).toHaveLength(2);
  const third=inputs[2]!; const response=await fetch(`${url}/api/workbench/intake/${third.intakeBatchId}/files/${third.files[0]!.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('1'); expect(((await response.json()) as ApiErrorResponse).error.retryable).toBe(true); expect(await readdir(path.join(root!,'library','intake-temp'))).toHaveLength(2);
  requests.forEach(req=>req.destroy());
  expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({n:0});
});
it('requires an authorized existing conversation in the selected project',async()=>{
  const {url,input}=await boot();await create(url,input);const file=`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;await fetch(file,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});
  const attach=await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/attach`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'p',conversationId:'wrong'})});expect(attach.status).toBe(403);expect((await readdir(root!)).sort()).toEqual(['library']);
});
it('gates the legacy multipart route before its parser writes anything',async()=>{
  const {url,app}=await boot();let parserCalls=0;
  registerProjectUploadRoutes(app,{db:{},http:{sendApiError},uploads:{handleProjectUpload:()=>{parserCalls++;}},paths:{PROJECTS_DIR:root},node:{fs:{}},projectStore:{},projectFiles:{},authorizeProjectRequest:async(_req: Request,res: Response)=>{sendApiError(res,403,'project-forbidden','Denied');return false;}} as unknown as RegisterProjectUploadRoutesDeps);
  const form=new FormData();form.append('files',new Blob(['private']), 'p.txt');const response=await fetch(`${url}/api/projects/forbidden/upload`,{method:'POST',body:form});expect(response.status).toBe(403);expect(parserCalls).toBe(0);expect(await readdir(root!)).toEqual([]);
});

it('keeps HTML raw bytes inert and preserves an explicit opaque script preview',async()=>{
  const {url,input,db,app}=await boot();
  registerLibraryRoutes(app,{db,http:{sendApiError,requireLocalDaemonRequest},paths:{LIBRARY_DIR:path.join(root!,'library'),PROJECTS_DIR:path.join(root!,'projects')},projectStore:{},projectFiles:{},conversations:{},auth:{}} as unknown as RegisterLibraryRoutesDeps);
  const html='<html><script>document.body.dataset.preview="running"</script></html>';
  const manifest={...input,files:[{...input.files[0]!,filename:'animation.html',size:Buffer.byteLength(html)}]};await create(url,manifest);
  const stored=await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:html}).then(async r=>parseIntakeFilePutResponse(await r.json()));
  const raw=await fetch(`${url}/api/library/assets/${stored.file.stored!.assetId}/raw`);expect(raw.headers.get('content-security-policy')).toBe('sandbox');expect(raw.headers.get('x-content-type-options')).toBe('nosniff');expect(await raw.text()).toBe(html);
  const preview=await fetch(`${url}/api/library/assets/${stored.file.stored!.assetId}/preview`);expect(preview.status).toBe(200);expect(preview.headers.get('content-security-policy')).toBe('sandbox allow-scripts');expect(await preview.text()).toBe(html);
  expect((await fetch(`${url}/api/library/assets/${stored.file.stored!.assetId}/preview`,{headers:{origin:'chrome-extension://forged'}})).status).toBe(403);
});

it('keeps an explicit frozen folder with spaces and refuses a later project switch',async()=>{
  const {url,input}=await boot(); const manifest={...input,destination:{kind:'project',projectId:'p',dir:'Asset Photos'}};expect((await create(url,manifest)).status).toBe(200);
  const file=`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const put=await fetch(file,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});expect(put.status).toBe(200);expect(parseIntakeFilePutResponse(await put.json()).file.stored!.projectFile!.relPath).toBe('Asset Photos/héllo.bin');
  expect((await fetch(file,{method:'PUT',headers:{'content-type':'application/octet-stream','x-od-project-id':'other'},body:'abc'})).status).toBe(400);expect(await readdir(path.join(root!,'projects'))).toEqual(['p']);
});
it('refuses an imported Intake subfolder when custody is lost after the route check', async () => {
  let imported = '';
  let revokeAfterCheck = false;
  let revoked = false;
  const authority = ordinaryIntakeAuthority(() => {
    if (revoked) throw new PlacementCoordinationError('OWNER_RECOVERING', 'Project write custody was lost');
    if (revokeAfterCheck) { revokeAfterCheck = false; revoked = true; }
  });
  const { url, input, db } = await boot(undefined, {
    authority,
    getProject: id => {
      revokeAfterCheck = true;
      return { id, metadata: { baseDir: imported } };
    },
  });
  imported = path.join(root!, 'imported');
  await mkdir(imported);
  const manifest = { ...input, destination: { kind: 'project', projectId: 'p', dir: 'Photo References' } };
  expect((await create(url, manifest)).status).toBe(200);
  const file = `${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const response = await fetch(file, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'OWNER_RECOVERING' } } });
  expect(await readdir(imported)).toEqual([]);
  expect(JSON.parse((db.prepare('SELECT materializations_json FROM workbench_intake_items').get() as { materializations_json: string }).materializations_json)).toEqual([]);
});
it('rechecks project write authority after the streamed body, before Library commit',async()=>{
  let putChecks=0;const {url,input,db}=await boot(async(req,res)=>{if(req.method==='PUT'&&++putChecks===2){sendApiError(res,403,'project-forbidden','Revoked during transfer');return false;}return true;});
  await create(url,{...input,destination:{kind:'project',projectId:'p'}});
  const response=await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});expect(response.status).toBe(403);expect(putChecks).toBe(2);expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({n:0});
});

it('returns a typed mismatch refusal without destroying the HTTP response socket',async()=>{
  const {url,input}=await boot();await create(url,{...input,files:[{...input.files[0]!,size:1}]});const response=await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});expect(response.status).toBe(422);expect(((await response.json()) as ApiErrorResponse).error.code).toBe('intake-size-mismatch');
});


it('keeps opaque PNG-named HTTP bytes as file while recognizing a real PNG signature', async () => {
  const { url, input } = await boot();
  const bodies = [Buffer.from([255, 0, 31, 17]), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=', 'base64')];
  for (let index = 0; index < bodies.length; index++) {
    const bytes = bodies[index]!;
    const manifest = { ...input, intakeBatchId: randomUUID(), files: [{ ...input.files[0]!, clientFileId: randomUUID(), filename: index === 0 ? 'opaque.png' : 'real.bin', size: bytes.length, declaredMime: 'image/png' }] };
    expect((await create(url, manifest)).status).toBe(200);
    const fileUrl = `${url}/api/workbench/intake/${manifest.intakeBatchId}/files/${manifest.files[0]!.clientFileId}`;
    const response = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes }); expect(response.status).toBe(200);
    const stored = parseIntakeFilePutResponse(await response.json()).file.stored!;
    expect(stored).toMatchObject({ detectedMime: index === 0 ? 'application/octet-stream' : 'image/png', kind: index === 0 ? 'file' : 'image', size: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex'), declaredMime: 'image/png' });
    const download = await fetch(`${fileUrl}/download`); expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes); expect(download.headers.get('content-type')).toBe('application/octet-stream');
  }
});


it('awaits Clear and returns the same snapshot JSON shape over HTTP', async () => {
  const { url, input, service } = await boot(); await create(url, input);
  const original = service.clear.bind(service);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void;
  const release = new Promise<void>(resolve => { proceed = resolve; });
  vi.spyOn(service, 'clear').mockImplementation(async (batchId, request) => { entered(); await release; return original(batchId, request); });
  const clearing = fetch(`${url}/api/workbench/intake/${input.intakeBatchId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
  await started; expect(service.snapshot(input.intakeBatchId).files[0]!.state).toBe('queued'); proceed();
  const response = await clearing; expect(response.status).toBe(200);
  expect(await response.json()).toEqual(service.snapshot(input.intakeBatchId));
  expect(service.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: false });
});

it('refuses create and raw PUT with a typed 503 before any intake effect while coordinated admission is closed', async () => {
  const f = coordinatedIntake(); const { url, input, db } = await boot(undefined, { authority: f.authority });
  expect((await create(url, input)).status).toBe(200);
  f.loseRecovery();
  const refused = await create(url, { ...input, intakeBatchId: randomUUID() });
  expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', retryable: true, details: { kind: 'placement', reason: 'OWNER_RECOVERING' } } });
  expect(db.prepare('SELECT count(*) AS n FROM workbench_intake_batches').get()).toEqual({ n: 1 });
  const put = await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
  expect(put.status).toBe(503); expect(await put.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'OWNER_RECOVERING' } } });
  expect(put.headers.get('connection')).toBe('close');
  expect(await readdir(root!)).toEqual([]);
  expect(db.prepare('SELECT state, error_json FROM workbench_intake_items').get()).toEqual({ state: 'queued', error_json: null });
});

it('closes an unread project PUT when authorization sends its own denial', async () => {
  const { url, input, db } = await boot(async (req, res) => {
    if (req.method === 'PUT') { sendApiError(res, 403, 'project-forbidden', 'Denied'); return false; }
    return true;
  });
  const projectInput = { ...input, destination: { kind: 'project', projectId: 'p' } };
  expect((await create(url, projectInput)).status).toBe(200);
  const put = await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc',
  });
  expect(put.status).toBe(403);
  expect(put.headers.get('connection')).toBe('close');
  expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({ n: 0 });
  expect((await create(url, { ...input, intakeBatchId: randomUUID() })).status).toBe(200);
});

it('does not attach after the client closes during asynchronous project authorization', async () => {
  const f = coordinatedIntake(); const dest = f.imported('p');
  let hold = false, entered!: () => void, release!: () => void, closed!: () => void;
  const authorized = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const { url, input } = await boot(async (_req, res) => { if (hold) { res.once('close', closed); entered(); await authorized; } return true; }, { authority: f.authority, projectsDir: f.projects, getProject: id => f.sources.get(id) ?? null });
  expect((await create(url, input)).status).toBe(200);
  expect((await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' })).status).toBe(200);
  hold = true;
  const caller = new AbortController();
  const attaching = fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p', conversationId: 'c' }), signal: caller.signal }).catch(() => undefined);
  await waiting; caller.abort(); await attaching; await disconnected; release(); await ticks();
  expect(filesUnder(dest)).toEqual([]);
  expect(f.coordinator.snapshot().registrations).toBe(0);
});

it('does not retry project placement after the client closes during asynchronous PUT authorization', async () => {
  const f = coordinatedIntake(); const dest = f.imported('dest');
  let hold = false, entered!: () => void, release!: () => void, closed!: () => void;
  const authorized = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const { url, db, service } = await boot(async (_req, res) => { if (hold) { res.once('close', closed); entered(); await authorized; } return true; }, { authority: f.authority, projectsDir: f.projects, getProject: id => f.sources.get(id) ?? null });
  const input = intakeManifest({ kind: 'project', projectId: 'dest' });
  expect((await create(url, input)).status).toBe(200);
  const lease = await f.projectWrites.admit('dest');
  const caller = new AbortController();
  const putting = service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']), undefined, undefined, { signal: caller.signal }).catch(() => undefined);
  await waitFor(() => (db.prepare('SELECT state FROM workbench_intake_items').get() as { state: string }).state === 'stored', 'root receipt');
  caller.abort(); await putting; await lease.settle();
  hold = true;
  const retryCaller = new AbortController();
  const retry = fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'placement' }, body: new Uint8Array(0), signal: retryCaller.signal }).catch(() => undefined);
  await waiting; retryCaller.abort(); await retry; await disconnected; release(); await ticks();
  expect(filesUnder(dest)).toEqual([]);
  expect(service.snapshot(input.intakeBatchId).files[0]!.hasSuccessfulAttachment).toBe(false);
});

it('reports project drift during raw PUT auto-materialization as a typed 409, never a success-shaped attachment', async () => {
  const f = coordinatedIntake(); f.imported('dest');
  const { url, db } = await boot(undefined, { authority: f.authority, projectsDir: f.projects, getProject: id => f.sources.get(id) ?? null });
  const lease = await f.projectWrites.admit('dest');
  const input = intakeManifest({ kind: 'project', projectId: 'dest' });
  expect((await create(url, input)).status).toBe(200);
  const putting = fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
  await waitFor(() => (db.prepare('SELECT state FROM workbench_intake_items').get() as { state: string }).state === 'stored', 'root receipt');
  await waitFor(() => f.coordinator.snapshot().acquiring === 1, 'queued project admission');
  f.imported('dest', 'rebound'); await lease.settle();
  const response = await putting;
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { kind: 'placement', reason: 'RUN_SCOPE_CHANGED' } } });
  expect(filesUnder(f.external)).toEqual([]);
  expect(JSON.parse((db.prepare('SELECT materializations_json FROM workbench_intake_items').get() as { materializations_json: string }).materializations_json)).toEqual([]);
});

it('retries a refused project-only placement from stored bytes without another upload or conversation', async () => {
  const f = coordinatedIntake(); const dest = f.imported('dest');
  const { url, db } = await boot(undefined, { authority: f.authority, projectsDir: f.projects, getProject: id => f.sources.get(id) ?? null });
  const lease = await f.projectWrites.admit('dest');
  const input = intakeManifest({ kind: 'project', projectId: 'dest' });
  expect((await create(url, input)).status).toBe(200);
  const fileUrl = `${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const putting = fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
  await waitFor(() => (db.prepare('SELECT state FROM workbench_intake_items').get() as { state: string }).state === 'stored', 'root receipt');
  f.loseRecovery(); await lease.settle();
  const refused = await putting;
  expect(refused.status).toBe(503);
  expect((db.prepare('SELECT count(*) AS n FROM library_assets').get() as { n: number }).n).toBe(1);
  const saved = db.prepare('SELECT state, error_json, materializations_json FROM workbench_intake_items').get() as { state: string; error_json: string; materializations_json: string };
  expect(saved.state).toBe('stored'); expect(JSON.parse(saved.error_json)).toMatchObject({ code: 'intake-copy-failed', retryable: true });
  expect(JSON.parse(saved.materializations_json)).toEqual([]);
  expect((await fetch(fileUrl + '/download')).status).toBe(200);
  f.recover();
  const retried = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'placement' }, body: new Uint8Array(0) });
  expect(retried.status).toBe(200);
  expect(parseIntakeFilePutResponse(await retried.json()).file).toMatchObject({ state: 'stored', hasSuccessfulAttachment: true, stored: { projectFile: { projectId: 'dest', relPath: 'héllo.bin' } } });
  expect(filesUnder(dest)).toEqual(['héllo.bin']);
  expect((db.prepare('SELECT count(*) AS n FROM library_assets').get() as { n: number }).n).toBe(1);
});

it('lists unfinished project receipts only after exact project and scope authorization', async () => {
  const { url, input } = await boot(async (_req, res, projectId) => {
    if (projectId !== 'dest') { sendApiError(res, 403, 'project-forbidden', 'Denied'); return false; }
    return true;
  });
  const project = { ...input, destination: { kind: 'project', projectId: 'dest' } };
  expect((await create(url, project)).status).toBe(200);
  const global = await fetch(`${url}/api/workbench/intake?state=pending`);
  expect(((await global.json()) as { batches: unknown[] }).batches).toEqual([]);
  const selected = await fetch(`${url}/api/workbench/intake?state=pending&projectId=dest`);
  expect(((await selected.json()) as { batches: { intakeBatchId: string }[] }).batches.map(batch => batch.intakeBatchId)).toEqual([input.intakeBatchId]);
  expect((await fetch(`${url}/api/workbench/intake?state=pending&projectId=other`)).status).toBe(403);
  expect((await fetch(`${url}/api/workbench/intake?state=pending&projectId=dest`, { headers: { 'x-od-project-id': 'other' } })).status).toBe(400);
});

it('rejects a nonempty or unknown retry mode while ordinary short PUTs still fail size validation', async () => {
  const { url, input, db } = await boot();
  expect((await create(url, input)).status).toBe(200);
  const fileUrl = `${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const nonempty = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'placement' }, body: 'abc' });
  expect(nonempty.status).toBe(400);
  const unknown = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'other' }, body: new Uint8Array(0) });
  expect(unknown.status).toBe(400);
  const duplicate = await fetch(fileUrl, { method: 'PUT', headers: [['content-type', 'application/octet-stream'], ['x-od-intake-retry', 'placement'], ['x-od-intake-retry', 'placement']], body: new Uint8Array(0) });
  expect(duplicate.status).toBe(400);
  const chunkedStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'placement', 'transfer-encoding': 'chunked' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject); request.end();
  });
  expect(chunkedStatus).toBe(400);
  const ordinary = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(0) });
  expect(ordinary.status).toBe(422);
  expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({ n: 0 });
});
