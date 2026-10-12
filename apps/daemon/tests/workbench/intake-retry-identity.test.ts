// AC-R01.4 (U3 gap addenda): a failed upload retries on its own without
// duplicating bytes already accepted, and `od workbench intake` stores the same
// file under the same durable Library identity as the web upload path.
import express from 'express';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { parseIntakeBatchSnapshot, parseIntakeFilePutResponse, type IntakeFileOutcome } from '@open-design/contracts';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { libraryObjectPath } from '../../src/library.js';
import { migrateLibrary } from '../../src/library-store.js';
import { registerWorkbenchIntakeRoutes, type RegisterWorkbenchIntakeRoutesDeps } from '../../src/routes/workbench-intake.js';
import { cleanupIntakeRoots, filesUnder, ordinaryIntakeAuthority } from './intake-placement-fixture.js';

const servers: Server[] = [];
let root: string | undefined;
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  cleanupIntakeRoots();
});

type Db = InstanceType<typeof Database>;
/** One daemon process's intake routes over a shared database and data root. */
async function daemon(db: Db, dataRoot: string): Promise<string> {
  const app = express(); app.use(express.json());
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths: { LIBRARY_DIR: path.join(dataRoot, 'library'), PROJECTS_DIR: path.join(dataRoot, 'projects') }, projectStore: { getProject: (_db: unknown, id: string) => ({ id, metadata: {} }) }, conversations: { getConversation: () => null }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  const server = app.listen(0); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function setup() {
  root = await mkdtemp(path.join(tmpdir(), 'intake-retry-identity-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  return { db, dataRoot: root, url: await daemon(db, root) };
}
/** The web provider's request sequence (apps/web/src/providers/intake.ts): POST the manifest, then PUT raw bytes per file. */
async function createBatch(url: string, files: { name: string; size: number }[]) {
  const intakeBatchId = randomUUID();
  const descriptors = files.map((file, order) => ({ clientFileId: randomUUID(), order, filename: file.name, size: file.size }));
  const response = await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeBatchId, destination: { kind: 'pending' }, files: descriptors }) });
  expect(response.status).toBe(200);
  return { intakeBatchId, ids: descriptors.map(descriptor => descriptor.clientFileId) };
}
async function put(url: string, batchId: string, fileId: string, body: Buffer) {
  return fetch(`${url}/api/workbench/intake/${batchId}/files/${fileId}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const countAssets = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM library_assets').get() as { n: number }).n;
/** Every file under the Library root (objects, temp, sidecars): accepted bytes must appear exactly once. */
const libraryObjects = (dataRoot: string) => filesUnder(path.join(dataRoot, 'library'));

it('retries a failed upload independently and stores every accepted byte sequence once', async () => {
  const { db, dataRoot, url } = await setup();
  const alpha = Buffer.from('alpha bytes accepted first'), bravo = Buffer.from([0, 1, 2, 3, 0xfe, 0xff, 7, 9]);
  // The third file carries the same bytes as an accepted sibling; its first transfer is cut short.
  const { intakeBatchId, ids } = await createBatch(url, [{ name: 'alpha.txt', size: alpha.length }, { name: 'bravo.bin', size: bravo.length }, { name: 'alpha copy.txt', size: alpha.length }]);
  const [alphaId, bravoId, copyId] = ids as [string, string, string];

  const first = parseIntakeFilePutResponse(await (await put(url, intakeBatchId, alphaId, alpha)).json()).file;
  const second = parseIntakeFilePutResponse(await (await put(url, intakeBatchId, bravoId, bravo)).json()).file;
  expect([first.state, second.state]).toEqual(['stored', 'stored']);

  const failed = await put(url, intakeBatchId, copyId, alpha.subarray(0, 5));
  expect(failed.status).toBe(422);
  const afterFailure = parseIntakeBatchSnapshot(await (await fetch(`${url}/api/workbench/intake/${intakeBatchId}`)).json());
  const failedOutcome = afterFailure.files.find(file => file.clientFileId === copyId)!;
  expect(failedOutcome).toMatchObject({ state: 'needs-reselection', retryable: true, error: { code: 'intake-size-mismatch' } });
  // The failure touched only its own file: siblings keep their receipts, nothing new was stored.
  expect(afterFailure.files.filter(file => file.clientFileId !== copyId).map(file => file.stored)).toEqual([first.stored, second.stored]);
  expect(countAssets(db)).toBe(2);
  expect(libraryObjects(dataRoot)).toHaveLength(2);

  const retried = parseIntakeFilePutResponse(await (await put(url, intakeBatchId, copyId, alpha)).json()).file;
  expect(retried.state).toBe('stored');
  expect(retried.error).toBeUndefined();
  // Same bytes as the accepted sibling resolve to the sibling's one Library asset and object.
  expect(retried.stored).toMatchObject({ assetId: first.stored!.assetId, contentHash: sha(alpha), filename: 'alpha copy.txt' });

  const final = parseIntakeBatchSnapshot(await (await fetch(`${url}/api/workbench/intake/${intakeBatchId}`)).json());
  const byId = new Map<string, IntakeFileOutcome>(final.files.map(file => [file.clientFileId, file]));
  expect(byId.get(alphaId)!.stored).toEqual(first.stored);
  expect(byId.get(bravoId)!.stored).toEqual(second.stored);
  expect(countAssets(db)).toBe(2);
  const objects = libraryObjects(dataRoot);
  expect(objects).toHaveLength(2);
  expect(objects).toEqual([sha(alpha), sha(bravo)].map(hash => path.relative(path.join(dataRoot, 'library'), libraryObjectPath(path.join(dataRoot, 'library'), hash, '.bin'))).sort());
  expect(await readdir(path.join(dataRoot, 'library', 'intake-temp'))).toEqual([]);
});

it('gives `od workbench intake` the same durable asset identity as the web upload path for the same file', async () => {
  const { db, dataRoot, url } = await setup();
  const bytes = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4, 20, 0, 0, 0]), Buffer.alloc(32, 0x5a)]);
  const file = path.join(dataRoot, 'Brand kit ñ.zip'); await writeFile(file, bytes);

  const web = await createBatch(url, [{ name: 'Brand kit ñ.zip', size: bytes.length }]);
  const viaWeb = parseIntakeFilePutResponse(await (await put(url, web.intakeBatchId, web.ids[0]!, bytes)).json()).file.stored!;

  const output: unknown[] = [];
  expect(await runWorkbenchCli(['intake', '--file', file, '--json'], { baseUrl: url, write: (value: unknown) => output.push(value) })).toBe(0);
  const cliBatch = output.at(-1) as { intakeBatchId: string; files: IntakeFileOutcome[] };
  const viaCli = cliBatch.files[0]!.stored!;

  expect(viaCli).toMatchObject({ assetId: viaWeb.assetId, contentHash: viaWeb.contentHash, size: viaWeb.size, kind: viaWeb.kind, detectedMime: viaWeb.detectedMime, filename: viaWeb.filename });
  expect(viaCli.contentHash).toBe(sha(bytes));
  expect(countAssets(db)).toBe(1);
  expect(libraryObjects(dataRoot)).toHaveLength(1);

  // Durable: a second daemon over the same data root reads both receipts back to that one asset.
  const restarted = await daemon(db, dataRoot);
  const reread = await Promise.all([web.intakeBatchId, cliBatch.intakeBatchId].map(async id => parseIntakeBatchSnapshot(await (await fetch(`${restarted}/api/workbench/intake/${id}`)).json()).files[0]!.stored!.assetId));
  expect(reread).toEqual([viaWeb.assetId, viaWeb.assetId]);
});
