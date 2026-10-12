import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, utimesSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Ordinary C2a project fences at the actual route-authorized write boundary,
 * on an isolated data root: query-scoped PATCH, verified tool-grant writes and
 * effectful preview regeneration. The fence is a seeded unfinished operation
 * (synthetic journal record) over a real managed project root.
 */
const priorDataDir = process.env.OD_DATA_DIR;
// Private fixture parent: isolated daemon data lives in its daemon-data child, so the parent is an
// authorized import location OUTSIDE the resolved data directory whose subtree reaches daemon-data/projects/<fenced>.
const fixtureParent = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-fence-routes-')));
const dataDir = path.join(fixtureParent, 'daemon-data');
mkdirSync(dataDir, { mode: 0o700 });
mkdirSync(path.join(fixtureParent, 'unrelated-import'));
process.env.OD_DATA_DIR = dataDir;
const { startServer } = await import('../../../src/server.js');
const { closeDatabase } = await import('../../../src/db.js');
const { toolTokenRegistry, CHAT_TOOL_ENDPOINTS, CHAT_TOOL_OPERATIONS } = await import('../../../src/tool-tokens.js');
const { liveArtifactStorePaths } = await import('../../../src/live-artifacts/store.js');
const { migratePlacementJournal, PlacementJournal } = await import('../../../src/workbench/placement/journal.js');

type Started = { server: http.Server; url: string; shutdown?: () => Promise<void> };
let started: Started;
const fenced = `fenced-${Date.now()}`, free = `free-${Date.now()}`;
const artifacts: Record<string, { stale: string; fresh: string }> = {};
const digest = (file: string) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const json = async (url: string, init?: RequestInit) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const token = (projectId: string) => toolTokenRegistry.mint({ projectId, runId: `run-${projectId}`, allowedEndpoints: CHAT_TOOL_ENDPOINTS, allowedOperations: CHAT_TOOL_OPERATIONS }).token;
const createInput = (title: string) => ({
  input: { title, preview: { type: 'html', entry: 'index.html' }, document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { title } } },
  templateHtml: '<!doctype html><h1>{{data.title}}</h1>',
  provenanceJson: { generatedAt: '2026-10-04T00:00:00.000Z', generatedBy: 'agent', sources: [{ label: 'fence', type: 'user_input' }] },
});
async function toolCreate(projectId: string, grantProjectId = projectId, body: Record<string, unknown> = {}) {
  return json(`${started.url}/api/tools/live-artifacts/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(grantProjectId)}` }, body: JSON.stringify({ ...createInput(`artifact ${projectId}`), ...body }) });
}
const paths = (projectId: string, artifactId: string) => liveArtifactStorePaths(path.join(dataDir, 'projects'), projectId, artifactId);
async function stop() { await started.shutdown?.(); await new Promise(resolve => started.server.close(() => resolve(undefined))); closeDatabase(); }

beforeAll(async () => {
  started = await startServer({ port: 0, returnServer: true }) as Started;
  for (const id of [fenced, free]) {
    expect((await json(`${started.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: id }) })).status).toBe(200);
    const stale = (await toolCreate(id)).body.artifact.id as string, fresh = (await toolCreate(id)).body.artifact.id as string;
    artifacts[id] = { stale, fresh };
    expect(existsSync(paths(id, fresh).generatedPreviewHtmlPath)).toBe(true);
  }
  await stop();
  for (const id of [fenced, free]) {
    unlinkSync(paths(id, artifacts[id]!.stale).generatedPreviewHtmlPath); // missing cache
    const later = new Date(Date.now() + 60_000); // a fresh cache is strictly newer than its dependencies (store rule)
    utimesSync(paths(id, artifacts[id]!.fresh).generatedPreviewHtmlPath, later, later);
  }
  const db = new Database(path.join(dataDir, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db);
  const projectRoot = path.join(dataDir, 'projects', fenced), sha = 'a'.repeat(64);
  new PlacementJournal({ db, incarnationId: 'coordinated-before-loss' }).createOperation({ operationId: 'unfinished', principalId: 'p', projectId: fenced, projectRoot, kind: 'apply', idempotencyKey: 'k', inputDigest: sha, planDigest: sha,
    movements: [{ movementId: 'm', kind: 'publish', source: path.join(dataDir, 'staged'), destination: path.join(projectRoot, 'entry.html'), expectedSource: { device: '1', inode: '2', sha256: sha, byteLength: 1 }, snapshot: { snapshotId: 's', sha256: sha, byteLength: 1 } }] });
  db.close();
  started = await startServer({ port: 0, returnServer: true }) as Started;
}, 60_000);
afterAll(async () => { await stop(); toolTokenRegistry.clear(); if (priorDataDir === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = priorDataDir; });

describe('ordinary C2a fence at route-authorized write boundaries', () => {
  it('query-scoped PATCH refuses before the update for a fenced project; an unaffected project still updates', async () => {
    const file = paths(fenced, artifacts[fenced]!.fresh).artifactJsonPath; const before = digest(file);
    const refused = await json(`${started.url}/api/live-artifacts/${artifacts[fenced]!.fresh}?projectId=${fenced}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'changed' }) });
    expect(refused).toMatchObject({ status: 503, body: { error: { details: { kind: 'placement', reason: 'PROJECT_RECOVERING' } } } });
    expect(digest(file)).toBe(before);
    const allowed = await json(`${started.url}/api/live-artifacts/${artifacts[free]!.fresh}?projectId=${free}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'changed' }) });
    expect(allowed.status).toBe(200);
  });
  it('verified tool-grant create/update refuse before writes; a client projectId never overrides the grant', async () => {
    const dir = path.join(dataDir, 'projects', fenced); const before = (await import('node:fs')).readdirSync(dir, { recursive: true }).length;
    expect(await toolCreate(fenced)).toMatchObject({ status: 503, body: { error: { details: { reason: 'PROJECT_RECOVERING' } } } });
    const file = paths(fenced, artifacts[fenced]!.fresh).artifactJsonPath; const unchanged = digest(file);
    const update = await json(`${started.url}/api/tools/live-artifacts/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(fenced)}` }, body: JSON.stringify({ artifactId: artifacts[fenced]!.fresh, input: { title: 'x' } }) });
    expect(update).toMatchObject({ status: 503 });
    expect(digest(file)).toBe(unchanged);
    expect((await import('node:fs')).readdirSync(dir, { recursive: true }).length).toBe(before);
    expect((await toolCreate(free)).status).toBe(200);
    expect((await toolCreate(free, fenced, { projectId: free })).status).toBe(403);
  });
  it('effectful preview regeneration refuses for a fenced project; fresh caches and template reads stay available', async () => {
    const missing = paths(fenced, artifacts[fenced]!.stale).generatedPreviewHtmlPath;
    const preview = (id: string, artifactId: string, variant?: string) => fetch(`${started.url}/api/live-artifacts/${artifactId}/preview?projectId=${id}${variant ? `&variant=${variant}` : ''}`);
    expect((await preview(fenced, artifacts[fenced]!.stale)).status).toBe(503);
    expect((await preview(fenced, artifacts[fenced]!.stale, 'rendered-source')).status).toBe(503);
    expect(existsSync(missing)).toBe(false);
    expect((await preview(fenced, artifacts[fenced]!.stale, 'template')).status).toBe(200);
    expect((await preview(fenced, artifacts[fenced]!.fresh)).status).toBe(200);
    expect((await preview(free, artifacts[free]!.stale)).status).toBe(200);
    expect(existsSync(paths(free, artifacts[free]!.stale).generatedPreviewHtmlPath)).toBe(true);
  });
  it('an import of an authorized ancestor outside the data directory refuses at the physical fence; an unrelated import still succeeds', async () => {
    const count = async () => ((await json(`${started.url}/api/projects`)).body.projects as unknown[]).length;
    const before = await count();
    const ancestor = await json(`${started.url}/api/import/folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: fixtureParent, name: 'ancestor alias' }) });
    expect(ancestor).toMatchObject({ status: 503, body: { error: { details: { kind: 'placement', reason: 'PROJECT_RECOVERING' } } } });
    expect(await count()).toBe(before);
    const unrelated = await json(`${started.url}/api/import/folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: path.join(fixtureParent, 'unrelated-import'), name: 'unrelated' }) });
    expect(unrelated.status).toBe(200);
    expect(await count()).toBe(before + 1);
  });
});
