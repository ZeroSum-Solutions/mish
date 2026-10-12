import express from 'express';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { migrateLibrary, deleteLibraryAsset } from '../../src/library-store.js';
import { registerWorkbenchIntakeRoutes, type RegisterWorkbenchIntakeRoutesDeps } from '../../src/routes/workbench-intake.js';
import type { IntakeBatchSnapshot, AttachIntakeResponse } from '@mish/contracts';
import { cleanupIntakeRoots, coordinatedIntake, ordinaryIntakeAuthority } from './intake-placement-fixture.js';
let server: Server | undefined, root: string;
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));if(root)await rm(root,{recursive:true,force:true});cleanupIntakeRoots();});
it('streams repeated CLI files through the same authorized receipts, then shows, attaches and clears',async()=>{
  root=await mkdtemp(path.join(tmpdir(),'intake-cli-'));const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateLibrary(db);const app=express();app.use(express.json());const requests: {method:string;contentType:string|undefined}[]=[];
  app.use((req,res,next)=>{requests.push({method:req.method,contentType:req.get('content-type')});if(req.get('authorization')!=='Bearer fixture-token'||req.get('x-od-workspace-id')!=='w'||req.get('x-od-workspace-member-id')!=='m'){sendApiError(res,403,'FORBIDDEN','Scope missing');return;}next();});
  registerWorkbenchIntakeRoutes(app,{db,http:{sendApiError},paths:{LIBRARY_DIR:path.join(root,'library'),PROJECTS_DIR:path.join(root,'projects')},projectStore:{getProject:()=>({id:'p',metadata:{}})},conversations:{getConversation:()=>({projectId:'p'})},authorizeProjectRequest:async()=>true,intakeWriteAuthority:ordinaryIntakeAuthority()} as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server=app.listen(0);await new Promise<void>(r=>server!.once('listening',r));const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a=path.join(root,'α.txt'),b=path.join(root,'second.bin');await writeFile(a,'abc');await writeFile(b,'abc');const output: unknown[]=[];
  const options={env:{OD_DAEMON_URL:url,OD_TOOL_TOKEN_ISSUER_ORIGIN:url,OD_TOOL_TOKEN:'fixture-token'},write:(v:unknown)=>output.push(v)};const scope=['--workspace','w','--workspace-member','m','--json'];
  expect(await runWorkbenchCli(['intake','--file',a,'--file',b,...scope],options)).toBe(0);const batch=output[0] as IntakeBatchSnapshot;expect(batch.files).toHaveLength(2);expect(batch.files[0]!.stored?.assetId).toBe(batch.files[1]!.stored?.assetId);expect(requests.filter(r=>r.method==='PUT').map(r=>r.contentType)).toEqual(['application/octet-stream','application/octet-stream']);
  expect(await runWorkbenchCli(['intake','show','--batch',batch.intakeBatchId,...scope],options)).toBe(0);
  const nativeCli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'workbench', 'intake', 'show', '--batch', batch.intakeBatchId, ...scope], { env: { ...process.env, ...options.env } });
  expect(JSON.parse(nativeCli.stdout)).toEqual(output[1]);
  expect(await runWorkbenchCli(['intake','attach','--batch',batch.intakeBatchId,'--project','p','--conversation','c',...scope],options)).toBe(0);const attach=output[2] as AttachIntakeResponse;expect(attach.attachments).toHaveLength(2);for(const file of attach.attachments)expect(await readFile(path.join(root,'projects','p',file.relPath),'utf8')).toBe('abc');
  expect(await runWorkbenchCli(['intake','clear','--batch',batch.intakeBatchId,...scope],options)).toBe(0);expect((output[3] as IntakeBatchSnapshot).files.every(f=>f.state==='cleared')).toBe(true);
});
it('rejects incomplete scope and missing attachment targets without making a request',async()=>{
  const output: unknown[]=[];const options={baseUrl:'http://127.0.0.1:1',write:(v:unknown)=>output.push(v)};
  expect(await runWorkbenchCli(['intake','--file','any','--workspace','w','--json'],options)).toBe(2);expect(await runWorkbenchCli(['intake','attach','--batch',randomUUID(),'--json'],options)).toBe(2);expect(await runWorkbenchCli(['intake','--file','/nonexistent-w2-fixture-file','--json'],options)).toBe(2);expect(output).toHaveLength(3);
});

it('shows and retries an unfinished project placement from saved bytes without local files or a conversation', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-placement-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const invalidRoot = path.join(root, 'ordinary-file'); await writeFile(invalidRoot, 'blocked');
  let unavailable = true;
  const app = express(); app.use(express.json());
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: unavailable ? { baseDir: invalidRoot } : {} }) }, conversations: { getConversation: () => null }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const input = { intakeBatchId: randomUUID(), destination: { kind: 'project', projectId: 'p' }, files: [{ clientFileId: randomUUID(), order: 0, filename: 'saved.bin', size: 3 }] };
  expect((await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(200);
  const fileUrl = `${url}/api/workbench/intake/${input.intakeBatchId}/files/${input.files[0]!.clientFileId}`;
  const first = await fetch(fileUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
  expect((await first.json() as { file: { error?: { code: string } } }).file.error?.code).toBe('intake-copy-failed');
  const output: unknown[] = []; const options = { baseUrl: url, write: (value: unknown) => output.push(value) };
  expect(await runWorkbenchCli(['intake', 'show', '--project', 'p', '--json'], options)).toBe(0);
  expect((output.at(-1) as { batches: IntakeBatchSnapshot[] }).batches.map(batch => batch.intakeBatchId)).toEqual([input.intakeBatchId]);
  unavailable = false;
  expect(await runWorkbenchCli(['intake', 'retry', '--batch', input.intakeBatchId, '--file-id', input.files[0]!.clientFileId, '--json'], options)).toBe(0);
  expect(output.at(-1)).toMatchObject({ file: { state: 'stored', hasSuccessfulAttachment: true, stored: { projectFile: { projectId: 'p', relPath: 'saved.bin' } } } });
  expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({ n: 1 });
  expect(await runWorkbenchCli(['intake', 'show', '--project', 'p', '--json'], options)).toBe(0);
  expect((output.at(-1) as { batches: IntakeBatchSnapshot[] }).batches).toEqual([]);
});

it('recovers a lost-response mixed batch without PUTing stored siblings and rejects reselection before any PUT', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-recovery-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const app = express(); app.use(express.json()); const puts: string[] = [];
  app.use((req, _res, next) => { if (req.method === 'PUT') puts.push(req.path); next(); });
  let failedCopy = true;
  const invalidRoot = path.join(root, 'not-a-directory'); await writeFile(invalidRoot, 'ordinary file');
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: failedCopy ? { baseDir: invalidRoot } : {} }) }, conversations: { getConversation: () => ({ projectId: 'p' }) }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const names = ['accepted.bin', 'missing.bin', 'copy-failed.bin'];
  const files = names.map(name => path.join(root, name)); for (const file of files) await writeFile(file, 'abc');
  const manifest = { intakeBatchId: randomUUID(), destination: { kind: 'pending' }, files: names.map((filename, order) => ({ clientFileId: randomUUID(), filename, order, size: 3 })) };
  await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  for (const index of [0, 2]) {
    const accepted = await fetch(`${url}/api/workbench/intake/${manifest.intakeBatchId}/files/${manifest.files[index]!.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'abc' });
    // The server accepted the file, but the CLI never received that response/receipt.
    expect(accepted.status).toBe(200); await accepted.body?.cancel();
  }
  const copyFailure = await fetch(`${url}/api/workbench/intake/${manifest.intakeBatchId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p', conversationId: 'c', clientFileIds: [manifest.files[2]!.clientFileId] }) });
  const failed = await copyFailure.json() as AttachIntakeResponse; expect(failed.files[2]).toMatchObject({ state: 'stored', error: { code: 'intake-copy-failed' } });
  puts.length = 0; const output: unknown[] = []; const options = { baseUrl: url, write: (value: unknown) => output.push(value) };
  const args = ['intake', '--batch', manifest.intakeBatchId, ...files.flatMap(file => ['--file', file]), '--json'];
  // A mismatch in the last sibling must be detected before uploading the middle one.
  await writeFile(files[2]!, 'different size'); expect(await runWorkbenchCli(args, options)).toBe(2); expect(puts).toEqual([]);
  await writeFile(files[2]!, 'abc'); const wrongName = path.join(root, 'wrong-name.bin'); await writeFile(wrongName, 'abc');
  expect(await runWorkbenchCli(['intake', '--batch', manifest.intakeBatchId, '--file', files[0]!, '--file', files[1]!, '--file', wrongName, '--json'], options)).toBe(2); expect(puts).toEqual([]);
  expect(await runWorkbenchCli(args, options)).toBe(3); expect(puts).toEqual([`/api/workbench/intake/${manifest.intakeBatchId}/files/${manifest.files[1]!.clientFileId}`]);
  puts.length = 0; expect(await runWorkbenchCli(args, options)).toBe(3); expect(puts).toEqual([]);
  failedCopy = false;
  expect(await runWorkbenchCli(['intake', 'attach', '--batch', manifest.intakeBatchId, '--project', 'p', '--conversation', 'c', '--json'], options)).toBe(0); expect(puts).toEqual([]);
  const recovered = output.at(-1) as AttachIntakeResponse; expect(recovered.attachments).toHaveLength(3);
});


async function downloadFixture() {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-download-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const app = express(); app.use(express.json()); const requests: { path: string; body: unknown }[] = [];
  let corrupt: 'hash' | 'short' | 'oversize' | 'disconnect' | 'replacement' | 'replacement-valid' | undefined, replacementTarget: string | undefined;
  app.use(async (req, res, next) => {
    requests.push({ path: req.path, body: req.body });
    if (req.get('authorization') !== 'Bearer fixture-token' || req.get('x-od-workspace-id') !== 'w' || req.get('x-od-workspace-member-id') !== 'm') { sendApiError(res, 403, 'FORBIDDEN', 'Scope missing'); return; }
    if (corrupt && req.path.endsWith('/download')) {
      res.write('a');
      if (corrupt === 'disconnect') { setTimeout(() => res.destroy(), 20); return; }
      if (corrupt === 'replacement' || corrupt === 'replacement-valid') {
        for (let attempt = 0; attempt < 100; attempt++) { if (await stat(replacementTarget!).catch(() => undefined)) break; await new Promise(resolve => setTimeout(resolve, 2)); }
        await unlink(replacementTarget!); await writeFile(replacementTarget!, 'external replacement');
      }
      res.end(corrupt === 'short' ? '' : corrupt === 'oversize' ? 'bcd' : corrupt === 'replacement-valid' ? 'bc' : 'xy'); return;
    }
    next();
  });
  const service = registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: {} }) }, conversations: { getConversation: () => ({ projectId: 'p' }) }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  const input = { intakeBatchId: randomUUID(), destination: { kind: 'pending' as const }, files: [0,1,2].map(order => ({ clientFileId: randomUUID(), order, filename: `${order}.bin`, size: 3 })) };
  const scope = ['--workspace', 'w', '--workspace-member', 'm', '--json'];
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer fixture-token', 'x-od-workspace-id': 'w', 'x-od-workspace-member-id': 'm' };
  await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  for (const file of input.files) { const response = await fetch(`${url}/api/workbench/intake/${input.intakeBatchId}/files/${file.clientFileId}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: 'abc' }); expect(response.status).toBe(200); await response.body?.cancel(); }
  const output: unknown[] = []; const options = { baseUrl: url, env: { OD_TOOL_TOKEN: 'fixture-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: url }, write: (value: unknown) => output.push(value) };
  requests.length = 0;
  return { input, scope, output, options, requests, service, db, corrupt: (mode: typeof corrupt, target?: string) => { corrupt = mode; replacementTarget = target; } };
}

it('downloads the same authorized intake receipt to an exclusive verified client output', async () => {
  const { input, scope, output, options, requests } = await downloadFixture();
  const file = input.files[0]!, target = path.join(root, 'download.bin');
  const args = ['intake', 'download', '--batch', input.intakeBatchId, '--file-id', file.clientFileId, '--output', target, ...scope];
  expect(await runWorkbenchCli(args, options)).toBe(0);
  expect(output).toHaveLength(1); expect(output[0]).toMatchObject({ intakeBatchId: input.intakeBatchId, clientFileId: file.clientFileId, filename: file.filename, size: 3, contentHash: createHash('sha256').update('abc').digest('hex'), output: target });
  expect(await readFile(target, 'utf8')).toBe('abc'); expect(requests.map(request => request.path)).toContain(`/api/workbench/intake/${input.intakeBatchId}/files/${file.clientFileId}/download`);
  expect(await runWorkbenchCli(args, options)).toBe(2); expect(await readFile(target, 'utf8')).toBe('abc');
  expect(output.at(-1)).toMatchObject({ error: { code: 'invalid-cli-input' } });
});

it('keeps typed download refusals and removes only a newly created corrupt output', async () => {
  const { input, scope, output, options, corrupt, db, service } = await downloadFixture();
  const file = input.files[0]!, target = path.join(root, 'download.bin');
  const args = ['intake', 'download', '--batch', input.intakeBatchId, '--file-id', file.clientFileId, '--output', target];
  expect(await runWorkbenchCli([...args, '--json'], options)).toBe(3); expect(output.at(-1)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } }); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runWorkbenchCli(['intake', 'download', '--batch', input.intakeBatchId, '--file-id', randomUUID(), '--output', target, ...scope], options)).toBe(3); expect(output.at(-1)).toMatchObject({ status: 404, error: { code: 'intake-ref-unknown' } });
  for (const mode of ['hash', 'short', 'oversize'] as const) {
    corrupt(mode); expect(await runWorkbenchCli([...args, ...scope], options)).toBe(1); expect(output.at(-1)).toMatchObject({ error: { code: 'intake-download-mismatch' } }); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  corrupt('disconnect'); expect(await runWorkbenchCli([...args, ...scope], options)).toBe(1); expect(output.at(-1)).toMatchObject({ error: { code: 'transport-or-server-failure' } }); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  const assetId = service.snapshot(input.intakeBatchId).files[0]!.stored!.assetId; deleteLibraryAsset(db, assetId);
  // Disable fault transport before exercising the real byte-removal refusal.
  corrupt(undefined);
  expect(await runWorkbenchCli([...args, ...scope], options)).toBe(3); expect(output.at(-1)).toMatchObject({ status: 404, error: { code: 'bytes-removed' } }); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('selects repeated file identities for attach and clear while omitted selectors keep the default', async () => {
  const { input, scope, output, options, requests } = await downloadFixture();
  const [first, second, third] = input.files;
  const ids = ['--file-id', first!.clientFileId, '--file-id', third!.clientFileId];
  expect(await runWorkbenchCli(['intake', 'attach', '--batch', input.intakeBatchId, '--project', 'p', '--conversation', 'c', ...ids, ...scope], options)).toBe(0);
  expect((output.at(-1) as AttachIntakeResponse).attachments.map(file => file.clientFileId)).toEqual([first!.clientFileId, third!.clientFileId]);
  expect(requests.at(-1)!.body).toEqual({ projectId: 'p', conversationId: 'c', clientFileIds: [first!.clientFileId, third!.clientFileId] });
  expect(await runWorkbenchCli(['intake', 'clear', '--batch', input.intakeBatchId, ...ids, ...scope], options)).toBe(0);
  expect((output.at(-1) as IntakeBatchSnapshot).files.map(file => file.state)).toEqual(['cleared', 'stored', 'cleared']);
  expect(requests.at(-1)!.body).toEqual({ clientFileIds: [first!.clientFileId, third!.clientFileId] });
  const target = path.join(root, 'cleared.bin');
  expect(await runWorkbenchCli(['intake', 'download', '--batch', input.intakeBatchId, '--file-id', first!.clientFileId, '--output', target, ...scope], options)).toBe(3);
  expect(output.at(-1)).toMatchObject({ status: 409, error: { code: 'intake-cleared' } }); await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runWorkbenchCli(['intake', 'attach', '--batch', input.intakeBatchId, '--project', 'p', '--conversation', 'c', ...scope], options)).toBe(0);
  expect((output.at(-1) as AttachIntakeResponse).attachments.map(file => file.clientFileId)).toContain(second!.clientFileId); expect(requests.at(-1)!.body).toEqual({ projectId: 'p', conversationId: 'c' });
  expect(await runWorkbenchCli(['intake', 'clear', '--batch', input.intakeBatchId, ...scope], options)).toBe(0); expect((output.at(-1) as IntakeBatchSnapshot).files.every(file => file.state === 'cleared')).toBe(true); expect(requests.at(-1)!.body).toEqual({});
});

it('rejects binary stdout, invalid selectors and incomplete download inputs before any request', async () => {
  const output: unknown[] = []; const options = { baseUrl: 'http://127.0.0.1:1', write: (value: unknown) => output.push(value) };
  const id = randomUUID(), valid = ['intake', 'download', '--batch', id, '--file-id', id];
  for (const args of [[...valid, '--output', '-', '--json'], [...valid, '--json'], ['intake', 'download', '--file-id', id, '--output', 'out', '--json'], [...valid, '--file-id', randomUUID(), '--output', 'out', '--json'], ['intake', 'clear', '--batch', id, '--file-id', id, '--file-id', id, '--json'], ['intake', 'attach', '--batch', id, '--project', 'p', '--conversation', 'c', '--file-id', 'invalid', '--json']]) {
    expect(await runWorkbenchCli(args, options)).toBe(2); expect(output.at(-1)).toMatchObject({ error: { code: 'invalid-cli-input' } });
  }
});

it('preserves a replacement at the client output path when streamed integrity fails', async () => {
  const { input, scope, output, options, corrupt } = await downloadFixture();
  const target = path.join(root, 'replacement.bin'); corrupt('replacement', target);
  expect(await runWorkbenchCli(['intake', 'download', '--batch', input.intakeBatchId, '--file-id', input.files[0]!.clientFileId, '--output', target, ...scope], options)).toBe(1);
  expect(output).toEqual([{ error: { code: 'intake-download-mismatch', message: 'Downloaded bytes do not match the saved intake receipt' } }]);
  expect(await readFile(target, 'utf8')).toBe('external replacement');
});

it('refuses success when a replacement output is present after otherwise valid streaming', async () => {
  const { input, scope, output, options, corrupt } = await downloadFixture();
  const target = path.join(root, 'replacement.bin'); corrupt('replacement-valid', target);
  expect(await runWorkbenchCli(['intake', 'download', '--batch', input.intakeBatchId, '--file-id', input.files[0]!.clientFileId, '--output', target, ...scope], options)).toBe(1);
  expect(output).toEqual([{ error: { code: 'intake-download-output-changed', message: 'The output path changed during download' } }]);
  expect(await readFile(target, 'utf8')).toBe('external replacement');
});

it('surfaces closed coordinated admission to `od workbench intake` as a typed refusal with no intake rows', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-closed-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db); const app = express(); app.use(express.json());
  const f = coordinatedIntake(); f.loseRecovery();
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: {} }) }, conversations: { getConversation: () => ({ projectId: 'p' }) }, authorizeProjectRequest: async () => true, intakeWriteAuthority: f.authority } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const file = path.join(root, 'a.txt'); await writeFile(file, 'abc'); const output: unknown[] = [];
  expect(await runWorkbenchCli(['intake', '--file', file, '--json'], { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, write: (value: unknown) => output.push(value) })).toBe(1);
  expect(output.at(-1)).toMatchObject({ status: 503, error: { code: 'UPSTREAM_UNAVAILABLE', retryable: true } });
  expect(db.prepare('SELECT count(*) AS n FROM workbench_intake_batches').get()).toEqual({ n: 0 });
});
