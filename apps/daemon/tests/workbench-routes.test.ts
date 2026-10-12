import express from 'express';
import type Database from 'better-sqlite3';
import { sendApiError } from '../src/http/api-errors.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseResourceDetailResponse, parseResourceSearchResponse } from '@mish/contracts';
import { registerWorkbenchRoutes, type RegisterWorkbenchRoutesDeps } from '../src/routes/workbench.js';
import { createLocalResourceSources } from '../src/workbench/resources.js';
import { startServer } from '../src/server.js';
import { readProjectContext, readWorkbenchPreferences } from '../src/workbench/project-context.js';
import { database } from './workbench/project-context-fixture.js';
import { runWorkbenchCli } from '../src/workbench-cli.js';
let server: Server | undefined;
let projectDb: Database.Database | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; projectDb?.close(); projectDb = undefined; });
async function boot(projectStateForRequest?: RegisterWorkbenchRoutesDeps['projectStateForRequest']) {
  const app = express(); app.use(express.json());
  registerWorkbenchRoutes(app, { http: { sendApiError }, ...(projectStateForRequest ? { projectStateForRequest } : {}), authorizeProjectRequest: async (_req,res,id) => { if (id === 'forbidden') { res.status(403).json({ error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED', message: 'private' } }); return false; } return true; }, sourcesForRequest: () => createLocalResourceSources({ listPlugins: async () => [] }) });
  server = app.listen(0); await new Promise<void>(r => server!.once('listening',r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('workbench HTTP boundaries', () => {
  it('returns the same canonical resource on search and inspect', async () => {
    const url = await boot();
    const response = await fetch(`${url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facets: { sourceIds: ['genui'] } }) });
    expect(response.status).toBe(200);
    const body = parseResourceSearchResponse(await response.json());
    const detail = await fetch(`${url}/api/workbench/resources/${body.results[0]!.refKey}`);
    expect(detail.status).toBe(200); expect(parseResourceDetailResponse(await detail.json()).resource).toEqual(body.results[0]);
  });
  it('rejects untrusted assertions and conflicting project scopes', async () => {
    const url = await boot();
    const bad = await fetch(`${url}/api/workbench/resources/search`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({principalId:'forged'}) });
    expect(bad.status).toBe(400);
    const conflict = await fetch(`${url}/api/workbench/resources/unknown?projectId=p2`, { headers: { 'x-od-project-id': 'p1' } });
    expect(conflict.status).toBe(400);
  });
  it('returns distinct stale ref and cursor recovery envelopes', async () => {
    const url = await boot();
    const search = await fetch(`${url}/api/workbench/resources/search`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limit:1})});
    const page = parseResourceSearchResponse(await search.json());
    const values = JSON.parse(Buffer.from(page.results[0]!.refKey,'base64url').toString('utf8')); values[4] = 'changed-digest';
    const staleKey = Buffer.from(JSON.stringify(values)).toString('base64url');
    const stale = await fetch(`${url}/api/workbench/resources/${staleKey}`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({error:{code:'resource-ref-stale',details:{nextSteps:[`Inspect current reference: ${page.results[0]!.refKey}`]}}});
    const cursor = await fetch(`${url}/api/workbench/resources/search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'changed',limit:1,cursor:page.nextCursor})});
    expect(cursor.status).toBe(409);
    expect(await cursor.json()).toMatchObject({error:{code:'resource-cursor-stale',details:{nextSteps:['Search again without a cursor']}}});
  });
  it('returns denied project before resolving an unknown key, with no recovery or private metadata', async () => {
    const url = await boot();
    const denied = await fetch(`${url}/api/workbench/resources/unknown?projectId=forbidden`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'project-forbidden', message: 'Project scope is not authorized' } });
  });
});

describe('real daemon registration and local inventory', () => {
  it('pages actual local projections through od workbench on an isolated daemon', async () => {
    const { runWorkbenchCli } = await import('../src/workbench-cli.js');
    const { writeFile } = await import('node:fs/promises');
    const started = await startServer({ port: 0, returnServer: true }) as { url:string; server:Server; shutdown?: () => Promise<void> | void };
    try {
      const pages: ReturnType<typeof parseResourceSearchResponse>[] = [];
      let cursor: string | null = null;
      do {
        const output: unknown[] = [];
        const args = ['search','--context','off','--limit','100','--json', ...(cursor ? ['--cursor',cursor] : [])];
        const exit = await runWorkbenchCli(args,{ baseUrl:started.url, write:value => output.push(value) });
        expect(exit).toBe(0);
        const page = parseResourceSearchResponse(output[0]); pages.push(page); cursor = page.nextCursor;
      } while (cursor);
      const items = pages.flatMap(p => p.results);
      expect(new Set(items.map(i => i.refKey)).size).toBe(items.length);
      expect(items.every(i => i.readiness !== 'usable' && !i.adoptionCapability.available)).toBe(true);
      const genui = items.find(i => i.ref.sourceId === 'genui' && i.previewCapability.available)!;
      const preview = await fetch(`${started.url}${genui.previewCapability.url}`);
      expect(preview.status).toBe(200); expect(preview.headers.get('content-type')).toContain('text/html');
      const out: unknown[] = [];
      expect(await runWorkbenchCli(['inspect','--ref',genui.refKey,'--json'],{baseUrl:started.url,write:v => out.push(v)})).toBe(0);
      const inspected = (out[0] as { resource: typeof genui }).resource;
      expect(inspected).toMatchObject(genui);
      expect(inspected.componentFit).toMatchObject({ status: 'unknown', apply: { allowed: false } });
      // Deliberate opt-in receipt capture; the receipt is versioned evidence, not a CI equality gate.
      if (process.env.OD_WORKBENCH_INVENTORY_RECEIPT) await writeFile(process.env.OD_WORKBENCH_INVENTORY_RECEIPT, JSON.stringify({
        schema:'workbench-local-inventory/1', baseSHA:'7ffe195ad06ca3270626c907cfd415c250c87689', authority:'isolated-daemon local projections; built-in plugin registry, GenUI, static public sections',
        command:'od workbench search --context off --limit 100 --json (page with --cursor nextCursor)',
        scope:'W1 local discovery inventory; full R13/source provenance and per-item acceptance remain pending',
        sourceStatuses:pages[0]!.sourceStatuses, indexDigest:pages[0]!.indexDigest,
        items:items.map(i => ({ref:i.ref,refKey:i.refKey,readiness:i.readiness,adoptionCapability:i.adoptionCapability})),
      },null,2)+'\n');
    } finally {
      await Promise.resolve(started.shutdown?.());
      if (started.server.listening) await new Promise<void>(r => started.server.close(() => r()));
    }
  });
});

it('normalizes source authority denial without exposing private adapter details', async () => {
  const app = express(); app.use(express.json());
  registerWorkbenchRoutes(app, {http:{sendApiError},authorizeProjectRequest:async () => true,sourcesForRequest:() => [{sourceId:'plugins',async list(){throw Object.assign(new Error('private-source-name'),{status:403,code:'private-code',nextSteps:['private-key']});}}]});
  server = app.listen(0); await new Promise<void>(r => server!.once('listening',r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const denied = await fetch(`${url}/api/workbench/resources/search`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({error:{code:'project-forbidden',message:'Project scope is not authorized'}});
});


describe('project-state HTTP refusals', () => {
  async function bootProjectState() {
    const db = database(); projectDb = db;
    const readState = vi.fn<NonNullable<RegisterWorkbenchRoutesDeps['projectStateForRequest']>>((_req, context) => context.projectId ? db.transaction(() => ({ context: readProjectContext(db, context.projectId!), preferences: readWorkbenchPreferences(db, context.projectId!) }))() : undefined);
    return { db, readState, url: await boot(readState) };
  }
  const search = (url: string, projectId: string) => fetch(`${url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': projectId }, body: JSON.stringify({ projectId, facets: { sourceIds: ['genui'] } }) });
  const refused = { error: { code: 'project-forbidden', message: 'Project scope is not authorized' } };
  it('returns safe403 and CLIexit3 for a nonexistent unbound project using the actual state reader', async () => {
    const { url, readState } = await bootProjectState();
    const response = await search(url, 'typo-id');
    expect(readState).toHaveBeenCalledOnce(); expect(response.status).toBe(403); expect(await response.json()).toEqual(refused);
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--project', 'typo-id', '--json'], { baseUrl: url, write: value => output.push(value) })).toBe(3);
    expect(output).toEqual([{ status: 403, ...refused }]);
  });
  it('refuses the same explicit scope after its project is deleted', async () => {
    const { url, db } = await bootProjectState();
    expect((await search(url, 'p')).status).toBe(200);
    db.prepare('DELETE FROM projects WHERE id=?').run('p');
    const deleted = await search(url, 'p'); expect(deleted.status).toBe(403); expect(await deleted.json()).toEqual(refused);
  });
  it('retains the existing scope denial before the state reader runs', async () => {
    const { url, readState } = await bootProjectState();
    const response = await search(url, 'forbidden'); expect(response.status).toBe(403); expect(await response.json()).toEqual(refused);
    expect(readState).not.toHaveBeenCalled();
  });
  it('keeps genuine SQLite storage failures as safe500 responses', async () => {
    const { url, db } = await bootProjectState(); db.close(); projectDb = undefined;
    const response = await search(url, 'p'); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Resource inspection failed' } });
  });
});
