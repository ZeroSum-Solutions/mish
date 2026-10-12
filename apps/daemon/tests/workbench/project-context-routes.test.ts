import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import type { RegisterWorkbenchContextRoutesDeps } from '../../src/routes/workbench-context.js';
import { afterEach, expect, it, vi } from 'vitest';
import { parseProjectRubricSnapshot } from '@open-design/contracts';
import { registerWorkbenchContextRoutes } from '../../src/routes/workbench-context.js';
import { putProjectContext, readProjectContext, readProjectRubric } from '../../src/workbench/project-context.js';
import { contextDraft, rubricDraft, database, references } from './project-context-fixture.js';
let server: Server; let db: Database.Database;
afterEach(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); db?.close(); });
async function boot() {
  db = database(); const app = express(); app.use(express.json());
  const resolveReferences = vi.fn<NonNullable<RegisterWorkbenchContextRoutesDeps['referencesForProject']>>((_req, _projectId) => references(db));
  const authorize = vi.fn(async (_req, res, id, options) => {
    if (id === 'q' || (id === 'readonly' && options.mode === 'write')) { res.status(403).json({ error: { code: 'private', message: 'private foreign row' } }); return false; }
    return true;
  });
  const commitAuthority = vi.fn(() => true);
  registerWorkbenchContextRoutes(app, { db, http: { sendApiError: (res, status, code, message, init) => res.status(status).json({ error: { code, message, ...init } }) }, authorizeProjectRequest: authorize, authorizeProjectCommit: commitAuthority, referencesForProject: resolveReferences });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, resolveReferences, authorize, commitAuthority };
}
const headers = { 'content-type': 'application/json', 'x-od-project-id': 'p' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('awaits authorized lookup outside SQLite and rechecks asset association at commit', async () => {
  const { base, resolveReferences } = await boot();
  const started = deferred<void>(); const release = deferred<ReturnType<typeof references>>();
  resolveReferences.mockImplementationOnce(() => { started.resolve(); expect(db.inTransaction).toBe(false); return release.promise; });
  const draft = contextDraft(); draft.factSources[0]!.source = { assetId: 'asset' };
  const saving = fetch(`${base}/api/workbench/projects/p/context`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft }) });
  await started.promise;
  db.prepare("UPDATE reference_inventory SET project_id='q' WHERE kind='asset' AND id='asset'").run();
  release.resolve(references(db));
  expect((await saving).status).toBe(422); expect(readProjectContext(db, 'p').revision).toBe(0);
});
it('checks current scope authority after asynchronous lookup before returning or saving a record', async () => {
  const { base, resolveReferences, commitAuthority } = await boot();
  const started = deferred<void>(); const release = deferred<ReturnType<typeof references>>();
  resolveReferences.mockImplementationOnce(() => { started.resolve(); return release.promise; });
  const draft = contextDraft(); draft.factSources[0]!.source = { assetId: 'asset' };
  const saving = fetch(`${base}/api/workbench/projects/p/context`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft }) });
  await started.promise; commitAuthority.mockImplementation(() => { expect(db.inTransaction).toBe(true); return false; });
  release.resolve(references(db));
  const response = await saving; expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  expect(readProjectContext(db, 'p').revision).toBe(0);
});
it('gives a competing save conflict precedence over failed async reference lookup', async () => {
  const { base, resolveReferences } = await boot(); const started = deferred<void>(); const release = deferred<ReturnType<typeof references>>();
  resolveReferences.mockImplementationOnce(() => { started.resolve(); return release.promise.then(() => { throw new Error('private source path'); }); });
  const draft = contextDraft(); draft.factSources[0]!.source = { assetId: 'asset' };
  const saving = fetch(`${base}/api/workbench/projects/p/context`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft }) });
  await started.promise; const competing = putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft('Competing') });
  release.resolve(references(db)); const response = await saving; expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { current: competing } } });
  expect(readProjectContext(db, 'p')).toEqual(competing);
});
it('returns an equal competing accepted record after lookup fails without adding history', async () => {
  const { base, resolveReferences } = await boot(); const started = deferred<void>(); const release = deferred<ReturnType<typeof references>>();
  resolveReferences.mockImplementationOnce(() => { started.resolve(); return release.promise.then(() => { throw new Error('private source path'); }); });
  const draft = contextDraft(); draft.factSources[0]!.source = { assetId: 'asset' };
  const saving = fetch(`${base}/api/workbench/projects/p/context`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft }) });
  await started.promise; const competing = putProjectContext(db, 'p', { expectedRevision: 0, draft }, references(db));
  release.resolve(references(db)); const response = await saving; expect(response.status).toBe(200); expect(await response.json()).toEqual(competing);
  expect(db.prepare('SELECT count(*) AS n FROM workbench_project_context_history').get()).toEqual({ n: 1 });
});
it.each(['context', 'rubric'] as const)('saves %s references from an asynchronous authorized resolver', async family => {
  const { base, resolveReferences } = await boot();
  putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  const draft = family === 'context' ? contextDraft('Updated') : rubricDraft();
  if ('factSources' in draft) draft.factSources[0]!.source = { assetId: 'asset' };
  else draft.checks[0]!.provenance.source = { assetId: 'asset' };
  resolveReferences.mockImplementationOnce(async () => { expect(db.inTransaction).toBe(false); return references(db); });
  const response = await fetch(`${base}/api/workbench/projects/p/${family}`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: family === 'context' ? 1 : 0, draft }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ projectId: 'p', revision: family === 'context' ? 2 : 1 });
  expect(resolveReferences).toHaveBeenCalledTimes(1);
});
it('shares HTTP current/history snapshots and rejects malformed revisions without leaking foreign records', async () => {
  const { base } = await boot();
  const url = `${base}/api/workbench/projects/p/context`;
  const absent = await fetch(url); expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ projectId: 'p', revision: 0, context: null });
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft: contextDraft() }) }); expect(saved.status).toBe(200);
  const first = await saved.json(); expect(first).toMatchObject({ revision: 1 });
  const again = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft: contextDraft() }) }); expect(await again.json()).toEqual(first);
  const conflict = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft: contextDraft('New') }) }); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: 'CONFLICT', details: { current: first } } });
  expect(await (await fetch(`${url}?revision=1`)).json()).toEqual(first);
  for (const revision of ['0', '-1', '01', '1.1', '9007199254740992', '1&revision=2']) expect((await fetch(`${url}?revision=${revision}`)).status).toBe(400);
  expect((await fetch(`${url}?revision=2`)).status).toBe(404);
  for (const id of ['missing', 'q']) {
    const denied = await fetch(`${base}/api/workbench/projects/${id}/context?revision=1`); expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  }
  expect((await fetch(`${url}?projectId=q`, { headers })).status).toBe(400);
  expect((await fetch(url, { headers: { 'x-od-project-id': 'q' } })).status).toBe(400);
});
it('enforces project writeFiles authority before equal retry and reference resolution', async () => {
  const { base, resolveReferences, authorize } = await boot();
  const saved = putProjectContext(db, 'readonly', { expectedRevision: 0, draft: contextDraft() });
  const url = `${base}/api/workbench/projects/readonly/context`;
  expect((await fetch(url)).status).toBe(200);
  const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, draft: contextDraft() }) });
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  expect(authorize.mock.calls.at(-1)?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
  expect(resolveReferences).not.toHaveBeenCalled(); expect(readProjectContext(db, 'readonly')).toEqual(saved);
});
it.each(['asset', 'resource', 'design-system'])('returns the same safe422 for unknown/foreign/stale %s refs and persists nothing', async kind => {
  const { base } = await boot();
  for (const id of ['missing', 'foreign', 'stale']) {
    const draft = contextDraft();
    if (kind === 'asset') draft.factSources[0]!.source = { assetId: id };
    if (kind === 'resource') draft.factSources[0]!.source = { resourceRef: { sourceType: 'section', sourceId: 'sections', itemId: id, revisionOrDigest: 'v1' } };
    if (kind === 'design-system') {
      draft.designSystemRef = { id, revisionOrDigest: 'v1' };
      for (const [fieldPath, value] of [['/designSystemRef/id', id], ['/designSystemRef/revisionOrDigest', 'v1']]) draft.factSources.push({ ...draft.factSources[0]!, source: null, fieldPath: fieldPath!, value: value! });
    }
    const response = await fetch(`${base}/api/workbench/projects/p/context`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, draft }) });
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'Project reference is invalid or unavailable' } });
    expect(readProjectContext(db, 'p').revision).toBe(0);
  }
});
it('rejects missing context/conversion linkage and source provenance; older same-project links remain stale', async () => {
  const { base } = await boot(); putProjectContext(db, 'q', { expectedRevision: 0, draft: contextDraft() });
  const url = `${base}/api/workbench/projects/p/rubric`;
  const put = (draft: unknown, expectedRevision = 0) => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision, draft }) });
  expect((await put(rubricDraft())).status).toBe(422);
  putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  expect((await put(rubricDraft(1, 'missing'))).status).toBe(422); expect(readProjectRubric(db, 'p').revision).toBe(0);
  const invalid = rubricDraft(); invalid.checks[0]!.provenance.source = { resourceRef: { sourceType: 'section', sourceId: 'sections', itemId: 'foreign', revisionOrDigest: 'v1' } };
  expect((await put(invalid)).status).toBe(422);
  const first = parseProjectRubricSnapshot(await (await put(rubricDraft())).json()); expect(first).toMatchObject({ revision: 1, linkage: { state: 'current' } });
  putProjectContext(db, 'p', { expectedRevision: 1, draft: contextDraft('Changed') });
  const stale = await (await fetch(`${url}?revision=1`)).json(); expect(stale).toMatchObject({ rubric: first.rubric, linkage: { state: 'stale', currentContextRevision: 2 } });
  expect((await put({ ...rubricDraft(), checks: [] }, 1)).status).toBe(200);
});

it('resolves valid exact refs only on changed writes and preserves accepted equal retries after inventory changes', async () => {
  const { base, resolveReferences } = await boot(); const url = `${base}/api/workbench/projects/p/context`;
  const draft = contextDraft(); draft.factSources[0]!.source = { assetId: 'asset' };
  draft.factSources[1]!.source = { resourceRef: { sourceType: 'section', sourceId: 'sections', itemId: 'hero', revisionOrDigest: 'v1' } };
  draft.designSystemRef = { id: 'neutral', revisionOrDigest: 'v1' };
  for (const [fieldPath, value] of [['/designSystemRef/id', 'neutral'], ['/designSystemRef/revisionOrDigest', 'v1']]) draft.factSources.push({ ...draft.factSources[2]!, source: null, fieldPath: fieldPath!, value: value! });
  const put = (expectedRevision: number, body: unknown = draft) => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision, draft: body }) });
  const accepted = await put(0); expect(accepted.status).toBe(200); const first = await accepted.json();
  expect(resolveReferences).toHaveBeenCalledTimes(1); resolveReferences.mockClear();
  db.prepare("UPDATE reference_inventory SET state='stale' WHERE project_id='p'").run();
  expect(await (await put(0)).json()).toEqual(first); expect(resolveReferences).not.toHaveBeenCalled();
  expect((await put(2)).status).toBe(400); expect(resolveReferences).not.toHaveBeenCalled();
  expect((await put(0, contextDraft('Different'))).status).toBe(409); expect(resolveReferences).not.toHaveBeenCalled();
  const changed = { ...draft, assumptions: ['Changed explicit unknowns'] }; expect((await put(1, changed)).status).toBe(422);
  expect(readProjectContext(db, 'p')).toEqual(first);
});
it('keeps HTTP preference history independent and rejects malformed bodies after authority', async () => {
  const { base, resolveReferences } = await boot(); const url = `${base}/api/workbench/projects/p/preferences`;
  const put = (body: unknown) => fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  expect(await (await fetch(url)).json()).toMatchObject({ revision: 0, effective: { useProjectContext: true } });
  const on = await (await put({ expectedRevision: 0, useProjectContext: true })).json(); expect(on).toMatchObject({ revision: 1 });
  expect((await put({ expectedRevision: 1, useProjectContext: false })).status).toBe(200);
  expect(await (await fetch(`${url}?revision=1`)).json()).toEqual(on);
  for (const body of [null, { expectedRevision: 2, useProjectContext: false, revision: 2 }, { expectedRevision: -1, useProjectContext: true }]) expect((await put(body)).status).toBe(400);
  expect(readProjectContext(db, 'p').revision).toBe(0); expect(readProjectRubric(db, 'p').revision).toBe(0); expect(resolveReferences).not.toHaveBeenCalled();
  expect((await fetch(`${base}/api/workbench/projects/q/context?revision=0`)).status).toBe(403);
});
