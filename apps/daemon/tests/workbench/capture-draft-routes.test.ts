import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWorkbenchCaptureRoutes } from '../../src/routes/workbench-capture.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { createCaptureDraftService } from '../../src/workbench/capture/draft-service.js';
import { createUnitService } from '../../src/workbench/units/unit-service.js';
import { fileCaptureBytes, pngBytes } from './capture-fixture.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

let server: Server | undefined; const dirs: string[] = [];
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'od-draft-http-')); dirs.push(dataDir);
  const captures = createCaptureService({ dataDir, bytes: fileCaptureBytes(path.join(dataDir, 'bytes')) });
  const capture = (await captures.import({ metadata: { projectId: 'p1', captureMode: 'upload', frame: { width: 20, height: 10 } }, body: pngBytes(20, 10), mediaType: 'image/png', idempotencyKey: 'shot', surface: 'web' })).view.capture;
  const drafts = createCaptureDraftService({ dataDir, captures, generator: { modelId: 'fixture', available: async () => true, generate: async () => ({ html: '<!doctype html><html><head><title>Fixture</title></head><body><section id="hero"><button>Book</button></section></body></html>', assumptions: ['The original font is unknown.'] }) } });
  const units = createUnitService({ dataDir, projectRoot: () => null, isCapturedBytes: async () => false, readCapture: captures.read, readDraft: drafts.unitSource, renderThumbnail: async () => ({ png: pngBytes(64, 40) }) });
  const authorized: Array<{ project: string; mode?: string }> = [];
  const app = express(); app.use(express.json());
  registerWorkbenchCaptureRoutes(app, {
    http: { sendApiError: (res, status, code, message, extra) => res.status(status).json({ error: { code, message, ...(extra?.details ? { details: extra.details } : {}) } }) },
    authorizeProjectRequest: async (req, res, project, opts) => { authorized.push({ project, mode: opts?.mode }); if (project !== 'p1' || req.get('x-test-deny') === 'yes') { res.status(403).json({ error: { code: 'FORBIDDEN' } }); return false; } return true; },
    assertProject: () => undefined, captures, units, drafts,
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output: unknown[] = [];
  const cli = (args: string[], stdin = '') => runWorkbenchCli(args, { env: { OD_DAEMON_URL: url }, readStdin: async () => stdin, write: value => output.push(value) });
  const request = { projectId: 'p1', captureId: capture.id, prompt: 'Recreate this section.' };
  return { drafts, url, request, output, cli, authorized };
}
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': 'p1', 'idempotency-key': 'draft1', ...extra }, body: JSON.stringify(body) });

describe('capture draft API and compiled command contract', () => {
  it('creates, resumes and saves a draft through the same API and od with current project authority', async () => {
    const { drafts, url, request, cli, output, authorized } = await boot();
    expect(await cli(['draft-from-capture', 'create', '--input-file', '-', '--json'], JSON.stringify(request))).toBe(0);
    const pending = output.pop() as { draftId: string };
    const ready = await drafts.settled('local-daemon', 'p1', pending.draftId, 1);
    expect(await cli(['draft-from-capture', 'show', '--project', 'p1', '--id', ready.draftId, '--revision', '1', '--json'])).toBe(0);
    expect(output.pop()).toEqual(ready);
    expect(await cli(['draft-from-capture', 'list', '--project', 'p1', '--json'])).toBe(0);
    expect(output.pop()).toEqual({ drafts: [ready] });
    const unit = { source: { kind: 'draft', draftId: ready.draftId, revision: 1, rootSelector: '#hero' }, name: 'Hero', kind: 'section', rightsDeclaration: { basis: 'model-authored', evidenceRefs: [], notices: [], privateUseAttestation: 'I may use my capture privately.' } };
    expect(await cli(['unit', 'save', '--input-file', '-', '--json'], JSON.stringify(unit))).toBe(0);
    expect(output.pop()).toMatchObject({ provenance: { draftRevisionId: `${ready.draftId}:1` } });
    expect(authorized).toContainEqual({ project: 'p1', mode: 'write' });
    expect(authorized).toContainEqual({ project: 'p1', mode: 'read' });
    const denied = await fetch(`${url}/api/workbench/units/plan`, json(unit, { 'x-test-deny': 'yes' }));
    expect(denied.status).toBe(403);
  });

  it('refuses mismatching project scope, denied writes, malformed revisions, foreign origins and forged output', async () => {
    const { drafts, url, request } = await boot();
    for (const [body, headers, status] of [
      [{ ...request, html: '<h1>forged</h1>' }, {}, 400],
      [request, { 'x-od-project-id': 'p2' }, 400],
      [request, { 'x-test-deny': 'yes' }, 403],
      [request, { origin: 'https://hostile.example' }, 403],
    ] as const) expect((await fetch(`${url}/api/workbench/capture-drafts`, json(body, headers))).status).toBe(status);
    const created = await drafts.create('local-daemon', request, 'ready');
    const ready = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    const pathName = `/api/workbench/capture-drafts/${ready.draftId}/revisions/1?projectId=p1`;
    expect((await fetch(`${url}${pathName}`)).status).toBe(200);
    expect((await fetch(`${url}${pathName.replace('/1?', '/1.5?')}`)).status).toBe(400);
    expect((await fetch(`${url}${pathName.replace('projectId=p1', 'projectId=p2')}`)).status).toBe(403);
  });
});
