import type http from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCaptureList, parseCaptureView, parseReusableUnitManifest, parseUnitSavePlan } from '@open-design/contracts';
import { startServer } from '../../src/server.js';
import { captureHeaders, pngBytes, sha } from './capture-fixture.js';

// AC-R14.1/R14.3 on a real daemon: routes are mounted, capture bytes become a
// Library image asset, records and unit objects live under the resolved daemon
// data root (OD_DATA_DIR → RUNTIME_DATA_DIR), and a unit saves from real project files.

describe('workbench capture and unit save on a real daemon', () => {
  let server: http.Server; let baseUrl: string; let dataDir: string;
  const projectId = 'proj-b8-capture';
  const shot = pngBytes(16, 10, [5, 6, 7]);
  const index = '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head><body><main id="root"><h1>Owned hero</h1></main></body></html>';

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url; server = started.server; dataDir = process.env.OD_DATA_DIR!;
    expect((await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, name: 'B8 capture fixture' }) })).status).toBe(200);
    const dir = path.join(dataDir, 'projects', projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), index);
    await writeFile(path.join(dir, 's.css'), 'main{color:var(--ink, #111)}');
  }, 30_000);
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('saves a capture into the Library under the data root and lists it', async () => {
    const created = await fetch(`${baseUrl}/api/workbench/captures?projectId=${projectId}`, { method: 'POST', body: shot, headers: captureHeaders({ projectId, captureMode: 'native-page', sourceUrl: 'https://example.com/?q=1', viewport: { width: 16, height: 10, deviceScaleFactor: 1 }, frame: { width: 16, height: 10 } }, { 'idempotency-key': 'srv-1' }) });
    expect(created.status).toBe(201);
    const view = parseCaptureView(await created.json());
    expect(view.capture.contentHash).toBe(sha(shot));
    const asset = await fetch(`${baseUrl}/api/library/assets/${view.capture.assetId}`);
    expect(asset.status).toBe(200);
    expect(await asset.json()).toMatchObject({ asset: { kind: 'image', contentHash: sha(shot), tags: expect.arrayContaining(['workbench-capture']) } });
    const files = (await readdir(path.join(dataDir, 'workbench-capture'), { recursive: true })).map(String);
    expect(files.some(file => file.endsWith(`${view.capture.id}.json`))).toBe(true);
    const list = parseCaptureList(await (await fetch(`${baseUrl}/api/workbench/captures?projectId=${projectId}`)).json());
    expect(list.captures.map(item => item.capture.id)).toContain(view.capture.id);
    const image = await fetch(`${baseUrl}${view.imageUrl}`);
    expect(Buffer.from(await image.arrayBuffer()).equals(shot)).toBe(true);
  });

  it('plans and saves a unit from real project files into the data root', async () => {
    const body = { source: { kind: 'project', projectId, entry: 'index.html', paths: ['index.html', 's.css'], rootSelector: '#root' }, kind: 'component', name: 'Owned hero', rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['fixture'], notices: [] } };
    const plan = parseUnitSavePlan(await (await fetch(`${baseUrl}/api/workbench/units/plan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': projectId }, body: JSON.stringify(body) })).json());
    expect(plan.blockers).toEqual([]);
    const expectedHashes = Object.fromEntries(plan.files.map(file => [file.path, file.sha256]));
    const saved = await fetch(`${baseUrl}/api/workbench/units`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': projectId, 'idempotency-key': 'srv-unit' }, body: JSON.stringify({ ...body, source: { ...body.source, expectedHashes } }) });
    expect(saved.status).toBe(201);
    const unit = parseReusableUnitManifest(await saved.json());
    expect(unit.files.map(file => file.path)).toEqual(['index.html', 's.css']);
    expect(['rendered', 'unavailable']).toContain(unit.thumbnail.source);
    const files = (await readdir(path.join(dataDir, 'workbench-units'), { recursive: true })).map(String);
    expect(files.some(file => file.includes(unit.unitId))).toBe(true);
  }, 120_000);
});
