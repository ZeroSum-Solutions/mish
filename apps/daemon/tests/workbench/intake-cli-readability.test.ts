// AC-R01.3: `od workbench intake --json` labels opaque stored files with the
// same readability notice the web chip and tray show.
import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { migrateLibrary } from '../../src/library-store.js';
import { registerWorkbenchIntakeRoutes, type RegisterWorkbenchIntakeRoutesDeps } from '../../src/routes/workbench-intake.js';
import { cleanupIntakeRoots, ordinaryIntakeAuthority } from './intake-placement-fixture.js';

const NOTICE = 'Stored; contents cannot be read by this model.';
let server: Server | undefined, root: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  cleanupIntakeRoots();
});

type LabeledFile = { clientFileId: string; state: string; stored?: { kind: string; filename: string }; readabilityNotice?: string };
const byName = (files: LabeledFile[]) => Object.fromEntries(files.map(file => [file.stored?.filename ?? file.clientFileId, file.readabilityNotice]));

it('carries the readability notice on opaque stored files only, across add, show, list, attach and clear', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-label-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const app = express(); app.use(express.json());
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: {} }) }, conversations: { getConversation: () => ({ projectId: 'p' }) }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opaque = path.join(root, 'Archive ü.zip'), readable = path.join(root, 'notes.txt');
  await writeFile(opaque, Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4, 20, 0, 0, 0]), Buffer.alloc(16, 0x9c)]));
  await writeFile(readable, 'plain text');
  const output: unknown[] = []; const options = { baseUrl: url, write: (value: unknown) => output.push(value) };

  expect(await runWorkbenchCli(['intake', '--file', opaque, '--file', readable, '--json'], options)).toBe(0);
  const added = output.at(-1) as { intakeBatchId: string; files: LabeledFile[] };
  expect(byName(added.files)).toEqual({ 'Archive ü.zip': NOTICE, 'notes.txt': undefined });

  expect(await runWorkbenchCli(['intake', 'show', '--batch', added.intakeBatchId, '--json'], options)).toBe(0);
  expect(byName((output.at(-1) as { files: LabeledFile[] }).files)).toEqual({ 'Archive ü.zip': NOTICE, 'notes.txt': undefined });

  expect(await runWorkbenchCli(['intake', 'show', '--json'], options)).toBe(0);
  const listed = (output.at(-1) as { batches: { files: LabeledFile[] }[] }).batches;
  expect(byName(listed.flatMap(batch => batch.files))).toEqual({ 'Archive ü.zip': NOTICE, 'notes.txt': undefined });

  expect(await runWorkbenchCli(['intake', 'attach', '--batch', added.intakeBatchId, '--project', 'p', '--conversation', randomUUID(), '--json'], options)).toBe(0);
  expect(byName((output.at(-1) as { files: LabeledFile[] }).files)).toEqual({ 'Archive ü.zip': NOTICE, 'notes.txt': undefined });

  // Clear only the readable sibling: the opaque file stays stored and must keep its notice.
  const readableId = added.files.find(file => file.stored?.filename === 'notes.txt')!.clientFileId;
  expect(await runWorkbenchCli(['intake', 'clear', '--batch', added.intakeBatchId, '--file-id', readableId, '--json'], options)).toBe(0);
  const cleared = (output.at(-1) as { files: LabeledFile[] }).files;
  expect(cleared.map(file => [file.state, file.readabilityNotice])).toEqual(added.files.map(file => file.clientFileId === readableId ? ['cleared', undefined] : ['stored', NOTICE]));
});

it('carries the readability notice on a retried opaque placement and omits it on a readable one', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'intake-cli-label-retry-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const invalidRoot = path.join(root, 'ordinary-file'); await writeFile(invalidRoot, 'blocked');
  let unavailable = true;
  const app = express(); app.use(express.json());
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') }, projectStore: { getProject: () => ({ id: 'p', metadata: unavailable ? { baseDir: invalidRoot } : {} }) }, conversations: { getConversation: () => null }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const zip = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4, 20, 0, 0, 0]), Buffer.alloc(16, 0x9c)]), text = Buffer.from('plain text');
  const files = [{ clientFileId: randomUUID(), order: 0, filename: 'Archive ü.zip', size: zip.length }, { clientFileId: randomUUID(), order: 1, filename: 'notes.txt', size: text.length }];
  const intakeBatchId = randomUUID();
  expect((await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intakeBatchId, destination: { kind: 'project', projectId: 'p' }, files }) })).status).toBe(200);
  for (const [file, body] of [[files[0]!, zip], [files[1]!, text]] as const) {
    const put = await fetch(`${url}/api/workbench/intake/${intakeBatchId}/files/${file.clientFileId}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body });
    expect((await put.json() as { file: { error?: { code: string } } }).file.error?.code).toBe('intake-copy-failed');
  }
  unavailable = false;
  const output: unknown[] = []; const options = { baseUrl: url, write: (value: unknown) => output.push(value) };
  const notices: Record<string, string | undefined> = {};
  for (const file of files) {
    expect(await runWorkbenchCli(['intake', 'retry', '--batch', intakeBatchId, '--file-id', file.clientFileId, '--json'], options)).toBe(0);
    const retried = (output.at(-1) as { file: LabeledFile }).file;
    expect(retried.state).toBe('stored');
    notices[file.filename] = retried.readabilityNotice;
  }
  expect(notices).toEqual({ 'Archive ü.zip': NOTICE, 'notes.txt': undefined });
});
