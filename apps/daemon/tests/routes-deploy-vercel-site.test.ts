import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as deploy from '../src/deploy.js';
import * as dbApi from '../src/db.js';
import { publicDeployment, publicDeployments } from '../src/deploy/cloudflare-pages-helpers.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';
import { registerDeployRoutes, registerDeploymentCheckRoutes } from '../src/routes/deploy.js';
import type { RegisterDeployRoutesDeps } from '../src/routes/deploy.js';

const page = '<!doctype html><h1>NEW PAGE MARKER</h1>';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Vercel names through HTTP and durable deployment storage', () => {
  let root: string, server: http.Server, base: string;
  let priorStateDir: string | undefined;
  let db: ReturnType<typeof dbApi.openDatabase>;
  let config: { token: string; teamId: string };
  let realFetch: typeof fetch;
  let owned: boolean, taken: boolean, aliasDeployment: string, count: number;
  let hold: Promise<void> | undefined;
  let onUpload: (() => void) | undefined;
  let uploads: number;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vercel-site-route-'));
    priorStateDir = process.env.OD_USER_STATE_DIR; process.env.OD_USER_STATE_DIR = root;
    await writeFile(path.join(root, 'vercel.json'), JSON.stringify({ token: 'mock-only', teamId: 'team_ours' }));
    db = dbApi.openDatabase(root, { dataDir: root });
    dbApi.insertProject(db, { id: 'bakery', name: 'Bob’s Bakery', createdAt: 1, updatedAt: 1 });
    config = { token: 'mock-only', teamId: 'team_ours' };
    owned = false; taken = false; aliasDeployment = ''; count = 0; uploads = 0; hold = undefined; onUpload = undefined; calls.length = 0;
    const app = express(); app.use(express.json());
    const ctx = {
      db, paths: { PROJECTS_DIR: root }, ids: { randomUUID }, projectStore: { getProject: dbApi.getProject },
      http: { requireLocalDaemonRequest, sendApiError: (res: express.Response, status: number, code: string, message: string, init?: object) => res.status(status).json({ error: { code, message, ...init } }) },
      authorizeProjectRequest: async () => true,
      deploy: { ...deploy, ...dbApi, publicDeployment, publicDeployments,
        readDeployConfig: async () => config,
        // The deploy route now calls prepareDeployPublication directly (B-001,
        // #261) to get the publication warnings alongside the file set;
        // buildDeployFileSet is no longer on that path, so the fixture must
        // stub the function the route actually calls.
        prepareDeployPublication: async () => ({ files: [{ file: 'index.html', data: page }], warnings: [] }),
      },
    } as unknown as RegisterDeployRoutesDeps;
    registerDeployRoutes(app, ctx); registerDeploymentCheckRoutes(app, ctx);
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); if (url.startsWith(base)) return realFetch(input, init);
      const parsed = new URL(url); const method = init?.method || 'GET'; const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: parsed.pathname, method, body });
      if (parsed.hostname !== 'api.vercel.com') return new Response(method === 'HEAD' ? '' : page, { headers: { 'content-type': 'text/html' } });
      if (parsed.pathname.endsWith('/domains')) return json({ domains: [{ name: 'bobs-bakery-suffix.vercel.app' }] });
      if (parsed.pathname.startsWith('/v9/projects/')) {
        if (parsed.pathname.endsWith('/bobs-bakery') && !owned && !taken) return json({}, 404);
        return json({ id: taken ? 'prj_other' : 'prj_ours', name: 'bobs-bakery', accountId: config.teamId, ssoProtection: null, passwordProtection: null });
      }
      if (parsed.pathname === '/v11/projects') { owned = true; return json({ id: 'prj_ours', name: body?.name, accountId: config.teamId }); }
      if (parsed.pathname === '/v2/files') { uploads++; onUpload?.(); if (hold) await hold; return json({}); }
      if (parsed.pathname === '/v13/deployments') { count++; return json({ id: `dpl_${count}`, projectId: 'prj_ours', url: `bakery-hash-${count}.vercel.app`, readyState: 'READY' }); }
      if (parsed.pathname.startsWith('/v13/deployments/')) return json({ id: `dpl_${count}`, projectId: 'prj_ours', url: `bakery-hash-${count}.vercel.app`, readyState: 'READY' });
      if (parsed.pathname.startsWith('/v4/aliases/')) return aliasDeployment ? json({ alias: 'bobs-bakery-suffix.vercel.app', projectId: 'prj_ours', deploymentId: aliasDeployment }) : json({}, 404);
      if (parsed.pathname.endsWith('/aliases') && method === 'POST') { aliasDeployment = parsed.pathname.split('/')[3]!; return json({ alias: 'bobs-bakery-suffix.vercel.app' }); }
      throw new Error(`Unexpected mocked provider request ${method} ${parsed.pathname}`);
    }));
  });
  afterEach(async () => { vi.unstubAllGlobals(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); if (priorStateDir === undefined) delete process.env.OD_USER_STATE_DIR; else process.env.OD_USER_STATE_DIR = priorStateDir; await rm(root, { recursive: true, force: true }); });
  const post = (base: string, selection?: object) => fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'index.html', target: 'preview', ...(selection ? { vercel: selection } : {}) }) });

  it('reports a 404 as advisory and a team conflict with a suggestion', async () => {
    const hint = await fetch(`${base}/api/deploy/vercel/name-check?name=bobs-bakery`);
    expect(await hint.json()).toMatchObject({ valid: true, available: true, advisory: true });
    taken = true;
    expect(await (await fetch(`${base}/api/deploy/vercel/name-check?name=bobs-bakery`)).json()).toMatchObject({ reason: 'taken', suggestion: 'bobs-bakery-2' });
    const conflict = await post(base, { projectName: 'bobs-bakery' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'VERCEL_NAME_TAKEN', details: { suggestion: 'bobs-bakery-2' } } });
    expect(uploads).toBe(0);
  });
  it('stores a verified provider-returned alias across redeploys and other entry files', async () => {
    expect((await post(base, { projectName: 'bobs-bakery' })).status).toBe(200);
    const second = await post(base); expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ url: 'https://bobs-bakery-suffix.vercel.app', vercel: { projectName: 'bobs-bakery', requestedAddress: 'bobs-bakery.vercel.app', assignedAlias: 'bobs-bakery-suffix.vercel.app', stableUrl: 'https://bobs-bakery-suffix.vercel.app', deploymentUrl: 'https://bakery-hash-2.vercel.app' } });
    const stored = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self');
    expect(stored?.providerMetadata).toMatchObject({ vercelAccountId: 'team_ours', vercelTeamId: 'team_ours', vercelProjectId: 'prj_ours' });
    const third = await fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'about.html' }) });
    expect(third.status).toBe(200); expect(calls.filter(c => c.path === '/v11/projects')).toHaveLength(1);
    expect(dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')).toMatchObject({ status: 'unknown', access: 'unknown', statusMessage: expect.stringContaining('another entry file') });
  });
  it('refuses a changed team and malformed selection before uploading again', async () => {
    await post(base, { projectName: 'bobs-bakery' }); config.teamId = 'team_other';
    expect((await post(base)).status).toBe(409); expect(uploads).toBe(1);
    expect((await post(base, { projectName: 'a.b' })).status).toBe(400);
    expect((await post(base, { target: 'production' })).status).toBe(400);
  });
  it('retains the last successful link and status when a redeploy upload fails', async () => {
    await post(base, { projectName: 'bobs-bakery' });
    const before = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self');
    onUpload = () => { throw new TypeError('upload disconnected'); };
    expect((await post(base)).status).toBe(502);
    const after = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self');
    expect(after).toMatchObject({ url: before!.url, status: before!.status, access: before!.access, deploymentId: before!.deploymentId, deploymentCount: before!.deploymentCount });
  });
  it('hides a failed first publish while retaining its binding for a successful retry', async () => {
    onUpload = () => { throw new TypeError('upload disconnected'); };
    expect((await post(base, { projectName: 'bobs-bakery' })).status).toBe(502);
    expect(dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')).toMatchObject({
      status: 'binding', url: '', deploymentCount: 0,
      providerMetadata: { vercelProjectId: 'prj_ours' },
    });
    const failedList = await fetch(`${base}/api/projects/bakery/deployments`);
    expect(failedList.status).toBe(200);
    expect(await failedList.json()).toEqual({ deployments: [] });

    onUpload = undefined;
    expect((await post(base)).status).toBe(200);
    const retriedList = await fetch(`${base}/api/projects/bakery/deployments`);
    expect(await retriedList.json()).toMatchObject({ deployments: [{
      status: 'ready', url: 'https://bobs-bakery-suffix.vercel.app', deploymentCount: 1,
    }] });
    expect(calls.filter(c => c.path === '/v11/projects')).toHaveLength(1);
  });
  it('hides legacy empty-URL rows from the public deployments list', async () => {
    dbApi.upsertDeployment(db, { id: 'legacy-empty', projectId: 'bakery', fileName: 'index.html',
      providerId: 'vercel-self', url: '', status: 'unknown', deploymentCount: 0 });
    const result = await fetch(`${base}/api/projects/bakery/deployments`);
    expect(await result.json()).toEqual({ deployments: [] });
  });
  it('preserves per-file alias metadata when a sibling supplied the project binding', async () => {
    await post(base, { projectName: 'bobs-bakery' });
    await fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'about.html' }) });
    const before = dbApi.getDeployment(db, 'bakery', 'about.html', 'vercel-self')!;
    const sibling = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')!;
    dbApi.upsertDeployment(db, { ...sibling, updatedAt: before.updatedAt + 1 });
    onUpload = () => { throw new TypeError('upload disconnected'); };
    const failed = await fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'about.html' }) });
    expect(failed.status).toBe(502);
    expect(dbApi.getDeployment(db, 'bakery', 'about.html', 'vercel-self')!.vercel).toEqual(before.vercel);
  });
  it('keeps a failed file binding private when another entry file publishes successfully', async () => {
    onUpload = () => { throw new TypeError('upload disconnected'); };
    expect((await post(base, { projectName: 'bobs-bakery' })).status).toBe(502);
    onUpload = undefined;
    const result = await fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'about.html' }) });
    expect(result.status).toBe(200);
    expect(dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')).toMatchObject({ status: 'binding', url: '' });
    const list = await fetch(`${base}/api/projects/bakery/deployments`);
    expect(((await list.json()) as { deployments: unknown[] }).deployments).toMatchObject([{ fileName: 'about.html', status: 'ready' }]);
  });
  it('rechecks an older deployment without moving the sibling file alias back', async () => {
    await post(base, { projectName: 'bobs-bakery' });
    const old = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')!;
    await fetch(`${base}/api/projects/bakery/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'about.html' }) });
    calls.length = 0;
    const result = await fetch(`${base}/api/projects/bakery/deployments/${old.id}/check-link`, { method: 'POST' });
    expect(await result.json()).toMatchObject({ status: 'unknown', access: 'unknown' });
    expect(calls.every(c => c.method === 'GET')).toBe(true); expect(aliasDeployment).toBe('dpl_2');
    dbApi.upsertDeployment(db, { ...old, publicAccess: true });
    const publicResult = await fetch(`${base}/api/projects/bakery/deployments/${old.id}/check-link`, { method: 'POST' });
    expect(await publicResult.json()).toMatchObject({ access: 'unknown', publicAccessOutcome: 'verify-failed' });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('does not confirm public access when the provider project identity changes on recheck', async () => {
    await post(base, { projectName: 'bobs-bakery' });
    const saved = dbApi.getDeployment(db, 'bakery', 'index.html', 'vercel-self')!;
    config.teamId = 'team_other'; calls.length = 0;
    const result = await fetch(`${base}/api/projects/bakery/deployments/${saved.id}/check-link`, { method: 'POST' });
    expect(await result.json()).toMatchObject({ status: 'ready', access: 'unknown' });
    expect(calls.every(c => c.method === 'GET' || c.method === 'HEAD')).toBe(true);
  });
  it('serializes concurrent publishes before a second provider mutation', async () => {
    let release!: () => void; hold = new Promise<void>(resolve => { release = resolve; });
    const uploadStarted = new Promise<void>(resolve => { onUpload = resolve; });
    const first = post(base, { projectName: 'bobs-bakery' }); await uploadStarted;
    const second = await post(base, { projectName: 'bobs-bakery' });
    expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ error: { code: 'VERCEL_DEPLOY_IN_PROGRESS' } });
    release(); expect((await first).status).toBe(200); expect(count).toBe(1);
  });
});
