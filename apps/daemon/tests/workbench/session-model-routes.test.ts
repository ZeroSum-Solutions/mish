import express from 'express';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { registerWorkbenchModelRoutes } from '../../src/routes/workbench-model.js';
import { migrateSessionModels } from '../../src/workbench/session-model.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { getAgentDef } from '../../src/agents.js';
import { rememberLiveModels } from '../../src/runtimes/models.js';
let server: Server; let db: Database.Database;
afterEach(async () => { if (server) await new Promise<void>(r => server.close(() => r())); db?.close(); });
async function boot() {
  db = new Database(':memory:');
  db.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT); INSERT INTO conversations VALUES('a','p'),('foreign','q'),('comment-anchor-p','p')"); migrateSessionModels(db);
  const app = express(); app.use(express.json());
  registerWorkbenchModelRoutes(app, { db, http: { sendApiError }, agents: { getAgentDef, modelScopeForAgent: async id => id === 'amr' ? 'w3-model-test-profile' : null }, authorizeProjectRequest: async (_req, res, id, mode) => {
    if (id === 'denied' || (id === 'readonly' && mode.mode === 'write')) { res.status(403).json({ error: { code: 'private', message: 'secret project' } }); return false; } return true;
  } });
  server = app.listen(0); await new Promise<void>(r => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it('shares API/CLI snapshots, enforces write authority before equal retry, and returns authorized CAS recovery', async () => {
  const baseUrl = await boot(); const { runWorkbenchCli } = await import('../../src/workbench-cli.js');
  const output: unknown[] = [];
  const options = { baseUrl, write: (v: unknown) => output.push(v) };
  expect(await runWorkbenchCli(['model','get','--session','a','--project','p','--json'], options)).toBe(0);
  expect(output.pop()).toMatchObject({ revision: 0, choice: null });
  expect(await runWorkbenchCli(['model','set','--session','a','--project','p','--agent','claude','--model','default','--expected-revision','0','--json'], options)).toBe(0);
  const snapshot = output.pop();
  expect(snapshot).toMatchObject({ revision: 1, choice: { agentId: 'claude', modelId: 'default' } });
  expect(await runWorkbenchCli(['model','get','--session','a','--project','p','--json'], options)).toBe(0);
  expect(output.pop()).toEqual(snapshot);
  const headers = { 'content-type': 'application/json', 'x-od-project-id': 'p' };
  const put = (body: unknown, project = 'p') => fetch(`${baseUrl}/api/workbench/sessions/a/model?projectId=${project}`, { method: 'PUT', headers: { ...headers, 'x-od-project-id': project }, body: JSON.stringify(body) });
  const choice = { agentId: 'claude', modelId: 'default', expectedRevision: 0 };
  expect((await put(choice)).status).toBe(200);
  const stale = await put({ ...choice, agentId: 'codex' });
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'SESSION_MODEL_REVISION_CONFLICT', details: { current: snapshot } } });
  const denied = await put(choice, 'denied');
  expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  expect((await put({ ...choice, apiKey: 'private-key' })).status).toBe(400);
});

it('accepts scoped AMR catalog/default and known Antigravity display IDs, refusing unrelated catalog entries', async () => {
  const base = await boot();
  rememberLiveModels('amr', [{ id: 'amr-test-model', label: 'Scoped test' }], 'w3-model-test-profile');
  const set = (agentId: string, modelId: string, expectedRevision: number) => fetch(`${base}/api/workbench/sessions/a/model?projectId=p`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, modelId, expectedRevision }) });
  expect((await set('amr','amr-test-model',0)).status).toBe(200);
  expect((await set('amr','not-in-profile',1)).status).toBe(400);
  expect((await set('amr','default',1)).status).toBe(200);
  expect((await set('antigravity','Gemini 3.1 Pro (High)',2)).status).toBe(200);
  expect((await set('antigravity','unknown model with spaces',3)).status).toBe(400);
});

it('returns the accepted AMR snapshot for a stale equal retry after its catalog disappears', async () => {
  const base = await boot();
  rememberLiveModels('amr', [{ id: 'amr-lost-success', label: 'Accepted' }], 'w3-model-test-profile');
  const set = (modelId: string, expectedRevision: number) => fetch(`${base}/api/workbench/sessions/a/model?projectId=p`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'amr', modelId, expectedRevision }) });
  const first = await set('amr-lost-success',0); expect(first.status).toBe(200); const snapshot = await first.json();
  rememberLiveModels('amr', [], 'w3-model-test-profile');
  const retry = await set('amr-lost-success',0); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(snapshot);
  expect((await set('amr-lost-success',2)).status).toBe(400);
  expect((await set('unknown-new-choice',1)).status).toBe(400);
  expect((await set('different-stale-choice',0)).status).toBe(409);
});
it('normalizes all missing/foreign/internal sessions to the same safe denial and rejects unknown choice', async () => {
  const url = await boot();
  for (const session of ['foreign','missing','comment-anchor-p']) {
    const response = await fetch(`${url}/api/workbench/sessions/${session}/model?projectId=p`);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  }
  const response = await fetch(`${url}/api/workbench/sessions/a/model?projectId=p`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'unknown-agent', modelId: 'default', expectedRevision: 0 }) });
  expect(response.status).toBe(400);
  expect((await fetch(`${url}/api/workbench/sessions/a/model?projectId=p`, { headers: { 'x-od-project-id': 'q' } })).status).toBe(400);
});

// AC-R02.3: pre-submit capability/attachment preflight. Advisory and
// non-mutating — a mismatch is reported in the 200 response body, never a
// write, so the caller keeps whatever prompt/selection it already had.
it('reports a model-and-image mismatch over HTTP and CLI without touching stored session state, and denies it the same as read scope', async () => {
  const baseUrl = await boot();
  const preflight = (body: unknown, project = 'p') => fetch(`${baseUrl}/api/workbench/sessions/a/model/preflight?projectId=${project}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const ok = await preflight({ agentId: 'claude', modelId: 'default', attachments: [{ name: 'brief.png', kind: 'image', size: 10 }] });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ agentId: 'claude', modelId: 'default', ok: true, mismatches: [] });

  // 'hermes' is an acp-json-rpc adapter that never declares supportsImagePaths.
  const mismatch = await preflight({ agentId: 'hermes', modelId: 'unknown model with spaces', attachments: [{ name: 'brief.png', kind: 'image', size: 10 }] });
  expect(mismatch.status).toBe(200);
  const result = await mismatch.json() as { ok: boolean; mismatches: unknown[] };
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'model-unavailable' }),
    expect.objectContaining({ code: 'image-attachments-unsupported', attachmentNames: ['brief.png'] }),
  ]));

  expect((await preflight({ agentId: 'claude', modelId: 'default' }, 'denied')).status).toBe(403);
  expect((await preflight({ agentId: 'claude' })).status).toBe(400);

  // A failed preflight never mutates the stored choice/revision.
  const unchanged = await fetch(`${baseUrl}/api/workbench/sessions/a/model?projectId=p`);
  expect(await unchanged.json()).toMatchObject({ revision: 0, choice: null });

  const { runWorkbenchCli } = await import('../../src/workbench-cli.js');
  const output: unknown[] = []; const options = { baseUrl, write: (v: unknown) => output.push(v) };
  expect(await runWorkbenchCli(['model','preflight','--session','a','--project','p','--agent','hermes','--model','default','--attachments-json','[{"name":"brief.png","kind":"image","size":10}]','--json'], options)).toBe(0);
  expect(output.pop()).toMatchObject({ ok: false, mismatches: [{ code: 'image-attachments-unsupported', message: 'Hermes does not forward image attachments to its model', attachmentNames: ['brief.png'] }] });
  expect(await runWorkbenchCli(['model','preflight','--session','a','--project','p','--agent','claude','--model','default','--json'], options)).toBe(0);
  expect(output.pop()).toEqual({ agentId: 'claude', modelId: 'default', ok: true, mismatches: [] });
  expect(await runWorkbenchCli(['model','preflight','--session','a','--project','p','--agent','claude','--json'], options)).toBe(2);
  expect(await runWorkbenchCli(['model','preflight','--session','a','--project','denied','--agent','claude','--model','default','--json'], options)).toBe(3);
});
