import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVerificationBundle } from '@open-design/contracts';
import { registerWorkbenchReviewRoutes } from '../../src/routes/workbench-review.js';
import { ProjectContextError } from '../../src/workbench/project-context.js';
import { runReviewCli } from '../../src/workbench/review-cli.js';
import { createWorkbenchReviewService, type WorkbenchReviewServiceDeps } from '../../src/workbench/review/service.js';
import type { ReviewBrowserPort } from '../../src/workbench/review/types.js';
import { knownGoodCapture, page, portFrom, unavailablePort } from './review-capture-fixture.js';
import { consoleRecord } from '../../src/workbench/review/page-text.js';

let server: Server | undefined; const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function boot(port: () => ReviewBrowserPort, dataDir?: string, projectFiles?: { name: string; type?: string }[]) {
  const data = dataDir ?? await mkdtemp(path.join(tmpdir(), 'od-review-data-')); if (!dataDir) dirs.push(data);
  const roots: string[] = [];
  const deps: WorkbenchReviewServiceDeps = {
    dataDir: data,
    projectInputs: projectId => { roots.push(projectId); return { root: path.join(data, 'project-root'), context: null, rubric: null }; },
    createPort: () => port(),
  };
  const app = express(); app.use(express.json());
  // J4-01 round 2: `od workbench review run`'s omitted --entry default now
  // asks the daemon's real /api/projects/:id/files endpoint for the
  // project's first HTML file. Stub just that one route here rather than
  // booting the full (heavy: db, uploads, artifacts, workspace authority...)
  // project-routes registrar, which this review-only test file otherwise
  // has no reason to depend on.
  if (projectFiles) app.get('/api/projects/:id/files', (_req, res) => res.json({ files: projectFiles }));
  registerWorkbenchReviewRoutes(app, {
    http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'foreign') { res.status(403).json({ error: 'private' }); return false; } return true; },
    assertProject: id => { if (id === 'missing') throw new ProjectContextError(403, 'project-forbidden', 'Project scope is not authorized'); },
    review: createWorkbenchReviewService(deps),
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output: unknown[] = [];
  const cli = (args: string[]) => runReviewCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value) });
  return { url, data, output, cli, roots };
}

describe('workbench review HTTP + od CLI parity', () => {
  it('runs, persists under the data root, lists and reads the same bundle through HTTP and the CLI', async () => {
    const { url, data, output, cli } = await boot(() => portFrom(width => knownGoodCapture(width)));
    const response = await fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: 'index.html' }) });
    expect(response.status).toBe(200);
    const bundle = parseVerificationBundle(await response.json());
    expect(bundle.outcome).toBe('passed');
    const files = await readdir(path.join(data, 'workbench-review', 'projects'), { recursive: true });
    expect(files.some(file => String(file).endsWith(`${bundle.id}.json`))).toBe(true);

    expect(await cli(['get', '--project', 'p', '--bundle', bundle.id, '--json'])).toBe(0);
    expect(output.pop()).toEqual(bundle);
    expect(await cli(['list', '--project', 'p', '--json'])).toBe(0);
    expect(output.pop()).toEqual({ projectId: 'p', bundles: [{ id: bundle.id, entry: 'index.html', outcome: 'passed', startedAt: bundle.startedAt, endedAt: bundle.endedAt }] });
    expect(await cli(['run', '--project', 'p', '--entry', 'index.html', '--json'])).toBe(0);
    expect(parseVerificationBundle(output.pop()).outcome).toBe('passed');

    // Round 9: the bundle stays structured; `--lang` adds the text a reader sees, rendered from the template table.
    expect(await cli(['get', '--project', 'p', '--bundle', bundle.id, '--lang', "en", '--json'])).toBe(0);
    const localized = output.pop() as { text: { locale: string; results: { checkId: string; reason: string }[] } };
    expect(localized).toMatchObject({ ...bundle, text: { locale: "en" } });
    expect(localized.text.results[0]!.reason).toBe('Passed at 320, 375, 768, 1440 px');
    expect(await cli(['get', '--project', 'p', '--bundle', bundle.id, '--lang', 'fr', '--json'])).toBe(2);
  });

  it('J4-01 round 2: `run` resolves an omitted --entry from the project’s first HTML file, not the contract’s hardcoded index.html default', async () => {
    const { cli, output } = await boot(() => portFrom(width => knownGoodCapture(width)), undefined, [{ name: 'readme.md', type: 'file' }, { name: 'home-drop.html', type: 'file' }]);
    expect(await cli(['run', '--project', 'p', '--json'])).toBe(0);
    const bundle = parseVerificationBundle(output.pop());
    expect(bundle.entry).toBe('home-drop.html');
  });

  it('keeps evidence across a daemon restart (new service over the same data root)', async () => {
    const first = await boot(() => portFrom(width => knownGoodCapture(width)));
    const created = parseVerificationBundle(await (await fetch(`${first.url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json());
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const second = await boot(() => unavailablePort(), first.data);
    const read = await fetch(`${second.url}/api/workbench/projects/p/review/bundles/${created.id}`);
    expect(parseVerificationBundle(await read.json())).toEqual(created);
    expect((await fetch(`${second.url}/api/workbench/projects/other/review/bundles/${created.id}`)).status).toBe(404);
  });

  it('exits 5 with an inconclusive bundle when no browser worker exists, and 4 when the page fails', async () => {
    const unavailable = await boot(() => unavailablePort());
    expect(await unavailable.cli(['run', '--project', 'p', '--json'])).toBe(5);
    expect(parseVerificationBundle(unavailable.output.pop()).results.every(result => result.recovery)).toBe(true);
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const failing = await boot(() => portFrom(width => knownGoodCapture(width, capture => { capture.console.push(consoleRecord({ kind: 'console', text: page('boom'), source: null })); })));
    expect(await failing.cli(['run', '--project', 'p', '--json'])).toBe(4);
  });

  it('refuses unsafe entries, foreign or unknown projects and bad bundle ids', async () => {
    const { url, output, cli } = await boot(() => portFrom(width => knownGoodCapture(width)));
    for (const entry of ['../secret.html', '/etc/passwd', '.env', 'a/.git/config']) {
      const response = await fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry }) });
      expect(response.status, entry).toBe(400);
    }
    expect(await cli(['run', '--project', 'p', '--entry', '../x.html', '--json'])).toBe(2);
    expect((await fetch(`${url}/api/workbench/projects/foreign/review/bundles`)).status).toBe(403);
    expect((await fetch(`${url}/api/workbench/projects/missing/review/bundles`)).status).toBe(403);
    expect((await fetch(`${url}/api/workbench/projects/p/review/bundles/..%2F..%2Fsecret`)).status).toBe(404);
    expect((await fetch(`${url}/api/workbench/projects/p/review/bundles?projectId=q`)).status).toBe(400);
    expect(await cli(['get', '--project', 'p', '--json'])).toBe(2);
    expect(output.pop()).toMatchObject({ error: { code: 'invalid-cli-input' } });
  });

  it('answers 409 while another review is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = portFrom(width => knownGoodCapture(width));
    const { url } = await boot(() => ({ ...slow, async capability() { await gate; return { available: true, browserVersion: 'x' }; } }));
    const first = fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});
