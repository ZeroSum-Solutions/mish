import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error -- jsdom has no bundled declarations in the Node-only daemon test program.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReusableUnitManifest } from '@mish/contracts';
import { registerWorkbenchCaptureRoutes } from '../../src/routes/workbench-capture.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { createUnitService } from '../../src/workbench/units/unit-service.js';
import { PlacementCoordinationError } from '../../src/workbench/placement/write-coordinator.js';
import type { PlacementProjectWrites } from '../../src/workbench/placement/project-writes.js';
import { createUnitStore } from '../../src/workbench/units/unit-store.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { fileCaptureBytes, sha } from './capture-fixture.js';

// AC-R14.4 / B-029: real editable copies in B, with A and the saved unit unchanged.
const HTML = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><button id="go">Run</button><output id="result"></output><script src="app.js"></script></body></html>';
const JS = "document.querySelector('#go').onclick = () => document.querySelector('#result').textContent = 'Ran';";
const FILES = { 'index.html': HTML, 'style.css': 'button { color: red }', 'app.js': JS, 'assets/owned.txt': 'owned asset' };
let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function tree(root: string) {
  const result: Record<string, string> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    result[path.relative(root, path.join(item.parentPath, item.name))] = item.isFile() ? sha(await readFile(path.join(item.parentPath, item.name))) : 'directory';
  }
  return result;
}
interface Receipt { insertId: string; projectId: string; status: string; directory: string; entryPath: string; recoveryPath?: string; files: Array<{ path: string }>; unit: ReusableUnitManifest; }
const json = (body: unknown, projectId?: string, key = 'insert') => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(projectId ? { 'x-od-project-id': projectId } : {}), 'idempotency-key': key }, body: JSON.stringify(body) });
async function boot(options: { files?: Record<string, string | Buffer>; projectWrites?: PlacementProjectWrites; registeredProjectIds?: string[] } = {}) {
  const sourceFiles = options.files ?? FILES;
  const data = await mkdtemp(path.join(tmpdir(), 'od-insert-')); dirs.push(data);
  const a = path.join(data, 'a'), b = path.join(data, 'b');
  await mkdir(path.join(a, 'assets'), { recursive: true }); await mkdir(b);
  for (const [file, bytes] of Object.entries(sourceFiles)) await writeFile(path.join(a, file), bytes);
  await writeFile(path.join(b, 'index.html'), 'Existing primary artifact');
  // A registered project id whose directory is never created here, mirroring
  // a project made via POST /api/projects before any file or run exists.
  const registered = new Map((options.registeredProjectIds ?? []).map(id => [id, path.join(data, id)]));
  const deps = { dataDir: data, ...(options.projectWrites ? { projectWrites: options.projectWrites } : {}), projectRoot: (id: string) => id === 'a' ? a : id === 'b' ? b : registered.get(id) ?? null, isCapturedBytes: async () => false, readCapture: async () => null, renderThumbnail: async () => ({ unavailable: 'fixture' }) };
  const units = createUnitService(deps);
  const app = express(); app.use(express.json());
  registerWorkbenchCaptureRoutes(app, {
    http: { sendApiError: (res, status, code, message, extra) => res.status(status).json({ error: { code, message, ...extra } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'denied') { res.status(403).json({ error: { code: 'FORBIDDEN' } }); return false; } return true; },
    assertProject: () => undefined,
    captures: createCaptureService({ dataDir: data, bytes: fileCaptureBytes(path.join(data, 'library')) }), units,
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const save = await fetch(`${url}/api/workbench/units`, json({ source: { kind: 'project', projectId: 'a', paths: Object.keys(sourceFiles), rootSelector: 'body', expectedHashes: Object.fromEntries(Object.entries(sourceFiles).map(([file, bytes]) => [file, sha(bytes)])) }, kind: 'page', name: 'Owned demo', rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['owner:release-fixture'], notices: ['Owned demo notice'] }, actions: [{ id: 'run', purpose: 'Run demo', selector: '#go' }] }, 'a', 'save'));
  expect(save.status).toBe(201);
  const unit = await save.json() as ReusableUnitManifest;
  const output: unknown[] = [];
  const cli = (args: string[]) => runWorkbenchCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value) });
  return { data, a, b, url, units, deps, unit, cli, output };
}
describe('AC-R14.4 saved unit standalone insertion', () => {
  it('refuses edited files without removing anything, then backs up confirmed edits before undo', async () => {
    const { a, b, url, unit } = await boot();
    const beforeA = await tree(a), beforeB = await tree(b);
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b', mode: 'standalone-artifact' }, 'b'));
    expect(response.status).toBe(201);
    const receipt = await response.json() as Receipt;
    expect(receipt.status).toBe('inserted'); expect(receipt.unit).toEqual(unit);
    expect(await readFile(path.join(b, receipt.entryPath), 'utf8')).toBe(HTML);
    expect(await readFile(path.join(b, receipt.directory, 'assets/owned.txt'), 'utf8')).toBe('owned asset');
    const dom = new JSDOM(await readFile(path.join(b, receipt.entryPath), 'utf8'), { runScripts: 'outside-only' });
    dom.window.eval(await readFile(path.join(b, receipt.directory, 'app.js'), 'utf8'));
    (dom.window.document.querySelector('#go') as { click(): void }).click();
    expect(dom.window.document.querySelector('#result')!.textContent).toBe('Ran'); dom.window.close();
    await writeFile(path.join(b, receipt.entryPath), HTML.replace('Run</button>', 'Edited in B</button>'));
    expect(await readFile(path.join(b, receipt.entryPath), 'utf8')).toContain('Edited in B');
    const stylePath = `${receipt.directory}/style.css`;
    await writeFile(path.join(b, stylePath), 'button { color: blue }');
    const editedTree = await tree(b);
    const undo = await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`, json({}));
    expect(undo.status).toBe(409);
    expect(await undo.json()).toMatchObject({ error: { details: { reason: 'insert-conflict', discardEditsAllowed: true, paths: expect.arrayContaining([receipt.entryPath, stylePath]) } } });
    expect(await tree(b)).toEqual(editedTree);
    const confirmed = await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`, json({ discardEdits: true }));
    expect(confirmed.status).toBe(200);
    const undone = await confirmed.json() as Receipt;
    expect(undone.status).toBe('undone');
    expect(undone.recoveryPath).toBe(`.od-undo/${receipt.insertId}`);
    const backups = await readdir(path.join(b, undone.recoveryPath!), { recursive: true });
    const htmlBackup = backups.find(file => file.endsWith(receipt.entryPath));
    const styleBackup = backups.find(file => file.endsWith(stylePath));
    expect(htmlBackup).toBeTruthy(); expect(styleBackup).toBeTruthy();
    expect(await readFile(path.join(b, undone.recoveryPath!, htmlBackup!), 'utf8')).toContain('Edited in B');
    expect(await readFile(path.join(b, undone.recoveryPath!, styleBackup!), 'utf8')).toBe('button { color: blue }');
    const afterB = await tree(b);
    expect(Object.fromEntries(Object.entries(afterB).filter(([file]) => !file.startsWith('.od-undo')))).toEqual(beforeB);
    expect(await tree(a)).toEqual(beforeA);
    expect(await (await fetch(`${url}/api/workbench/units/${unit.unitId}`)).json()).toEqual(unit);
    expect((await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`, json({}))).status).toBe(200);
  });
  it('copies a permitted binary PNG asset byte-for-byte and removes it on undo', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b0sAAAAASUVORK5CYII=', 'base64');
    const { a, b, url, unit } = await boot({ files: { ...FILES, 'assets/owned.png': png } });
    const beforeA = await tree(a), beforeB = await tree(b);
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'));
    expect(response.status).toBe(201);
    const receipt = await response.json() as Receipt;
    expect(await readFile(path.join(b, receipt.directory, 'assets/owned.png'))).toEqual(png);
    expect((await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`, json({}))).status).toBe(200);
    expect(await tree(b)).toEqual(beforeB); expect(await tree(a)).toEqual(beforeA);
  });
  it('relocates project-root references to copied assets without touching source or the saved unit', async () => {
    const html = HTML.replace('href="style.css"', 'href="/style.css"').replace('src="app.js"', 'src="/app.js"');
    const { a, b, url, unit } = await boot({ files: { ...FILES, 'index.html': html, 'style.css': 'body { background: url(/assets/owned.txt) }' } });
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'));
    expect(response.status).toBe(201);
    const receipt = await response.json() as Receipt;
    const copied = await readFile(path.join(b, receipt.entryPath), 'utf8');
    expect(copied).toContain('href="./style.css"'); expect(copied).toContain('src="./app.js"');
    expect(await readFile(path.join(b, receipt.directory, 'style.css'), 'utf8')).toContain('url(./assets/owned.txt)');
    expect(await readFile(path.join(a, 'index.html'), 'utf8')).toBe(html);
    expect(await (await fetch(`${url}/api/workbench/units/${unit.unitId}`)).json()).toEqual(unit);
  });
  it('refuses rights without copying captured proprietary bytes', async () => {
    const { b, data, url, unit } = await boot();
    const refused = { ...unit, unitId: 'unit_BBBBBBBBBBBBBBBBBBBB', rights: { ...unit.rights, status: 'reference-only' as const, files: unit.rights.files.map(file => ({ ...file, status: 'reference-only' as const, basis: 'captured-third-party' as const })) } };
    await createUnitStore(data).saveManifest(refused);
    const before = await tree(b);
    const response = await fetch(`${url}/api/workbench/units/${refused.unitId}/insert`, json({ projectId: 'b' }, 'b'));
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { details: { reason: 'rights-blocked' } } });
    expect(await tree(b)).toEqual(before);
  });
  it('refuses inline formats, same-project insertion, denied writes and mismatched scope with no target mutation', async () => {
    const { b, url, unit } = await boot(); const before = await tree(b);
    const inline = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b', mode: 'inline-primary-content' }, 'b'));
    expect(inline.status).toBe(422); expect(await inline.json()).toMatchObject({ error: { details: { reason: 'unsupported-target-format' } } });
    const same = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'a' }, 'a'));
    expect(same.status).toBe(422);
    expect((await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'denied' }, 'denied'))).status).toBe(403);
    expect((await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'a'))).status).toBe(400);
    expect(await tree(b)).toEqual(before);
  });
  // QA #273: a project registered but never materialized on disk (created
  // via POST /api/projects, no file or run yet) used to surface the lstat
  // ENOENT as an opaque 500; it must be a typed 4xx instead.
  it('maps an insert into a project with no directory yet to a typed 404, not a 500', async () => {
    const { url, unit } = await boot({ registeredProjectIds: ['c'] });
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'c' }, 'c'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'project-directory-missing' } } });
  });
  it('CLI insert and undo-insert match HTTP receipts, accept optional --json and preserve unrelated added files', async () => {
    const { b, url, unit, cli, output } = await boot();
    expect(await cli(['unit', 'insert', unit.unitId, '--project', 'b', '--json'])).toBe(0);
    const receipt = output.pop() as Receipt;
    expect(await (await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}`)).json()).toEqual(receipt);
    await writeFile(path.join(b, receipt.directory, 'my-notes.txt'), 'Keep me');
    expect(await cli(['unit', 'undo-insert', receipt.insertId])).toBe(0);
    expect(output.pop()).toMatchObject({ status: 'undone' });
    expect(await readFile(path.join(b, receipt.directory, 'my-notes.txt'), 'utf8')).toBe('Keep me');
    expect(await tree(b)).not.toHaveProperty(receipt.entryPath);
    expect(await cli(['unit', 'insert', unit.unitId, '--project', 'denied', '--json'])).toBe(3);
    expect(await cli(['unit', 'insert', unit.unitId])).toBe(2);
  });
  it('CLI requires --discard-edits and returns the backup location', async () => {
    const { b, unit, cli, output } = await boot();
    expect(await cli(['unit', 'insert', unit.unitId, '--project', 'b'])).toBe(0);
    const receipt = output.pop() as Receipt;
    await writeFile(path.join(b, receipt.entryPath), 'My CLI edits');
    const before = await tree(b);
    expect(await cli(['unit', 'undo-insert', receipt.insertId])).toBe(3);
    expect(output.pop()).toMatchObject({ error: { details: { reason: 'insert-conflict', paths: [receipt.entryPath] } } });
    expect(await tree(b)).toEqual(before);
    expect(await cli(['unit', 'undo-insert', receipt.insertId, '--discard-edits', '--json'])).toBe(0);
    expect(output.pop()).toMatchObject({ status: 'undone', recoveryPath: `.od-undo/${receipt.insertId}` });
    expect(await tree(b)).not.toHaveProperty(receipt.entryPath);
  });
  it('rejects non-boolean discard consent and preserves files if the backup path is unsafe', async () => {
    const { b, a, url, unit } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    await writeFile(path.join(b, receipt.entryPath), 'My edits');
    const before = await tree(b);
    const endpoint = `${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`;
    expect((await fetch(endpoint, json({ discardEdits: 'true' }))).status).toBe(400);
    expect(await tree(b)).toEqual(before);
    await symlink(a, path.join(b, '.od-undo'));
    const beforeA = await tree(a);
    const confirmed = await fetch(endpoint, json({ discardEdits: true }));
    expect(confirmed.status).toBe(409);
    expect(await readFile(path.join(b, receipt.entryPath), 'utf8')).toBe('My edits');
    expect(await tree(a)).toEqual(beforeA);
    expect((await (await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}`)).json() as Receipt).status).toBe('inserted');
  });
  it('backup failure removes nothing and a retried undo keeps earlier recovery copies', async () => {
    let refuse = false;
    const projectWrites: PlacementProjectWrites = {
      admit: async () => { throw new Error('not used'); },
      run: async (_project, work) => work({ assertCurrent: () => { if (refuse) throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Fixture backup fence'); } }),
    };
    const { b, url, unit, deps } = await boot({ projectWrites });
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    await writeFile(path.join(b, receipt.entryPath), 'My edits');
    const before = await tree(b);
    refuse = true;
    await expect(createUnitService(deps).undoInsert('local-daemon', receipt.insertId, { discardEdits: true })).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    expect(await tree(b)).toEqual(before);
    refuse = false;
    const recovery = path.join(b, '.od-undo', receipt.insertId);
    await mkdir(recovery, { recursive: true });
    await writeFile(path.join(recovery, 'earlier-copy.txt'), 'Older edits');
    const undone = await createUnitService(deps).undoInsert('local-daemon', receipt.insertId, { discardEdits: true });
    expect(undone.recoveryPath).toBe(`.od-undo/${receipt.insertId}`);
    expect(await readFile(path.join(recovery, 'earlier-copy.txt'), 'utf8')).toBe('Older edits');
    expect(await tree(b)).not.toHaveProperty(receipt.entryPath);
  });
  it('removes nothing when a later edited-file backup fails', async () => {
    let undoing = false, writes = 0;
    const projectWrites: PlacementProjectWrites = {
      admit: async () => { throw new Error('not used'); },
      run: async (_project, work) => work({ assertCurrent: () => { if (undoing && ++writes === 6) throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Fixture second backup fence'); } }),
    };
    const { b, url, unit, deps } = await boot({ projectWrites });
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    await writeFile(path.join(b, receipt.entryPath), 'Edited HTML');
    await writeFile(path.join(b, receipt.directory, 'style.css'), 'Edited CSS');
    const before = await tree(b);
    undoing = true;
    await expect(createUnitService(deps).undoInsert('local-daemon', receipt.insertId, { discardEdits: true })).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    const after = await tree(b);
    expect(Object.fromEntries(Object.entries(after).filter(([file]) => !file.startsWith('.od-undo')))).toEqual(before);
    const backups = await readdir(path.join(b, '.od-undo', receipt.insertId), { recursive: true, withFileTypes: true });
    expect(backups.filter(file => file.isFile())).toHaveLength(1);
    expect((await createUnitService(deps).insertion('local-daemon', receipt.insertId)).status).toBe('inserted');
  });
  it('retains a partial write after an interrupted insert until explicit backed-up undo', async () => {
    let writes = 0, blocked = true;
    const projectWrites: PlacementProjectWrites = {
      admit: async () => { throw new Error('not used'); },
      run: async (_project, work) => work({ assertCurrent: () => { writes++; if (blocked && writes === 3) throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Fixture fence after open'); } }),
    };
    const { b, url, unit, deps } = await boot({ projectWrites });
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'));
    const body = await response.json() as { error: { details: { insertion: Receipt } } };
    expect(response.status).toBe(503);
    const receipt = body.error.details.insertion;
    const first = receipt.files[0]!.path;
    expect((await readFile(path.join(b, first))).length).toBe(0);
    blocked = false;
    const before = await tree(b);
    await expect(createUnitService(deps).undoInsert('local-daemon', receipt.insertId)).rejects.toMatchObject({ code: 'insert-conflict', paths: [first] });
    expect(await tree(b)).toEqual(before);
    const undone = await createUnitService(deps).undoInsert('local-daemon', receipt.insertId, { discardEdits: true });
    expect(undone.status).toBe('undone');
    const backups = await readdir(path.join(b, undone.recoveryPath!), { recursive: true });
    expect((await readFile(path.join(b, undone.recoveryPath!, backups.find(file => file.endsWith(first))!))).length).toBe(0);
  });
  it('a final-write refusal reports an incomplete receipt; undo removes only files actually created', async () => {
    let writes = 0, blocked = true;
    const projectWrites: PlacementProjectWrites = {
      admit: async () => { throw new Error('not used'); },
      run: async (_project, work) => work({ assertCurrent: () => { writes++; if (blocked && writes === 4) throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Fixture recovery fence'); } }),
    };
    const { b, url, unit, deps } = await boot({ projectWrites });
    const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'));
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { details: { reason: string; insertion: Receipt } } };
    expect(body.error.details.reason).toBe('PROJECT_RECOVERING');
    const receipt = body.error.details.insertion; expect(receipt.status).toBe('inserting');
    // This planned path was not created by the interrupted insertion; undo must keep it.
    await writeFile(path.join(b, receipt.directory, 'app.js'), 'Added later: keep me');
    blocked = false;
    expect(await createUnitService(deps).undoInsert('local-daemon', receipt.insertId)).toMatchObject({ status: 'undone' });
    expect(await readFile(path.join(b, receipt.directory, 'app.js'), 'utf8')).toBe('Added later: keep me');
    expect(await tree(b)).not.toHaveProperty(receipt.entryPath);
  });
  it('persists recovery receipts for HTTP and CLI, without exposing another principal', async () => {
    const { url, unit, cli, output, units } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    expect(await (await fetch(`${url}/api/workbench/units/${unit.unitId}/inserts`)).json()).toEqual({ insertions: [receipt] });
    expect(await cli(['unit', 'insertions', unit.unitId, '--json'])).toBe(0);
    expect(output.pop()).toEqual({ insertions: [receipt] });
    await expect(units.insertion('other-principal', receipt.insertId)).rejects.toMatchObject({ status: 404 });
  });
  it('lists valid insertions while logging and skipping a corrupt record', async () => {
    const { data, url, unit } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    const journalDir = path.join(data, 'workbench-unit-inserts', sha('local-daemon'));
    await writeFile(path.join(journalDir, 'insert_ZZZZZZZZZZZZZZZZZZZZ.json'), '{corrupt');
    await writeFile(path.join(journalDir, 'insert_YYYYYYYYYYYYYYYYYYYY.json'), 'null');
    await writeFile(path.join(journalDir, 'insert_XXXXXXXXXXXXXXXXXXXX.json'), JSON.stringify({ receipt: { schema: 'broken' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await fetch(`${url}/api/workbench/units/${unit.unitId}/inserts`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ insertions: [receipt] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('insert_ZZZZZZZZZZZZZZZZZZZZ'));
    } finally { warn.mockRestore(); }
  });
  it('keeps private provenance evidence out of copied lineage and refuses unsupported attribution obligations', async () => {
    const { b, data, url, unit } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    const lineage = await readFile(path.join(b, receipt.directory, 'unit-lineage.json'), 'utf8');
    expect(lineage).toContain(unit.unitId); expect(lineage).not.toContain('local-daemon');
    expect(lineage).not.toContain('owner:release-fixture'); expect(lineage).not.toContain('"projectId"');
    const refused = { ...unit, unitId: 'unit_CCCCCCCCCCCCCCCCCCCC', operationRights: unit.operationRights.map(grant => grant.operation === 'reuse-private-project' ? { ...grant, obligations: [{ id: 'owner-attribution', kind: 'attribution' as const, description: 'Show owner attribution' }] } : grant) };
    await createUnitStore(data).saveManifest(refused);
    const before = await tree(b);
    const response = await fetch(`${url}/api/workbench/units/${refused.unitId}/insert`, json({ projectId: 'b' }, 'b', 'attribution'));
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { details: { reason: 'rights-blocked' } } });
    expect(await tree(b)).toEqual(before);
  });
  it('refuses an ambiguous persisted creation instead of falsely reporting undone', async () => {
    const { b, data, url, unit, deps } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    const journal = path.join(data, 'workbench-unit-inserts', createHash('sha256').update('local-daemon').digest('hex'), `${receipt.insertId}.json`);
    const record = JSON.parse(await readFile(journal, 'utf8'));
    record.receipt.status = 'inserting'; record.addedPaths = record.addedPaths.filter((file: string) => file !== receipt.entryPath);
    record.pendingEffect = { path: receipt.entryPath, kind: 'file' }; await writeFile(journal, JSON.stringify(record));
    const before = await tree(b);
    await expect(createUnitService(deps).undoInsert('local-daemon', receipt.insertId)).rejects.toMatchObject({ code: 'insert-conflict' });
    expect(await tree(b)).toEqual(before);
    expect((await createUnitService(deps).insertion('local-daemon', receipt.insertId)).status).toBe('inserting');
  });
  it('replays one insertion without duplicate copies', async () => {
    const { b, url, unit } = await boot();
    const endpoint = `${url}/api/workbench/units/${unit.unitId}/insert`;
    const first = await fetch(endpoint, json({ projectId: 'b' }, 'b', 'repeat'));
    expect(first.status).toBe(201); const receipt = await first.json(); const after = await tree(b);
    const second = await fetch(endpoint, json({ projectId: 'b' }, 'b', 'repeat'));
    expect(second.status).toBe(200); expect(await second.json()).toEqual(receipt); expect(await tree(b)).toEqual(after);
  });
  it('undo survives service recreation and refuses symlinked target paths', async () => {
    const { b, url, unit, deps } = await boot();
    const receipt = await (await fetch(`${url}/api/workbench/units/${unit.unitId}/insert`, json({ projectId: 'b' }, 'b'))).json() as Receipt;
    const target = path.join(b, receipt.entryPath);
    await rm(target); await symlink(path.join(b, 'index.html'), target);
    const response = await fetch(`${url}/api/workbench/unit-inserts/${receipt.insertId}/undo`, json({}));
    expect(response.status).toBe(409);
    expect(await readFile(path.join(b, 'index.html'), 'utf8')).toBe('Existing primary artifact');
    await rm(target); await writeFile(target, HTML);
    const restarted = createUnitService(deps);
    // Use the public service seam after a restart, without HTTP fixture-only lifecycle hooks.
    expect(await (restarted as unknown as { undoInsert(principal: string, id: string): Promise<Receipt> }).undoInsert('local-daemon', receipt.insertId)).toMatchObject({ status: 'undone' });
  });
});
