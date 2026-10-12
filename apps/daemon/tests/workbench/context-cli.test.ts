import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { runContextCli } from '../../src/workbench/context-cli.js';
import { registerWorkbenchContextRoutes } from '../../src/routes/workbench-context.js';
import { contextDraft, rubricDraft, database, references } from './project-context-fixture.js';
let server: Server; let db: Database.Database; const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); db?.close(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function boot() {
  db = database(); const app = express(); app.use(express.json());
  const requests: { project: unknown; workspace: unknown; member: unknown; method: string }[] = [];
  app.use((req, _res, next) => { requests.push({ project: req.get('x-od-project-id'), workspace: req.get('x-od-workspace-id'), member: req.get('x-od-workspace-member-id'), method: req.method }); next(); });
  registerWorkbenchContextRoutes(app, { db, http: { sendApiError: (res, status, code, message, init) => res.status(status).json({ error: { code, message, ...init } }) }, authorizeProjectRequest: async (_req, res, id) => { if (id === 'q') { res.status(403).json({ error: 'private foreign record' }); return false; } return true; }, authorizeProjectCommit: (_req, _res, id) => id !== 'q', referencesForProject: () => references(db) });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}
async function run(base: string, args: string[], input?: unknown) {
  const values: unknown[] = [];
  const code = await runContextCli(args, { baseUrl: base, env: {}, readStdin: async () => JSON.stringify(input), write: value => values.push(value) });
  return { code, value: values[0], values };
}
const get = (family: string, extra: string[] = []) => [family, 'get', '--project', 'p', '--json', ...extra];
const set = (family: string, revision = '0', extra: string[] = []) => [family, 'set', '--project', 'p', '--json', '--expected-revision', revision, ...(family === 'preferences' ? ['--context', 'off'] : ['--input-file', '-']), ...extra];
it('uses HTTP DTOs for all three families, equal retries, conflict snapshots and historical linkage', async () => {
  const { base } = await boot();
  expect(await run(base, get('preferences'))).toMatchObject({ code: 0, value: { revision: 0, preferences: null, effective: { useProjectContext: true } } });
  const first = await run(base, set('context'), contextDraft()); expect(first).toMatchObject({ code: 0, value: { revision: 1 } });
  expect(await run(base, set('context'), contextDraft())).toEqual(first);
  expect(await run(base, set('context'), contextDraft('Changed'))).toMatchObject({ code: 3, value: { status: 409, error: { code: 'CONFLICT', details: { current: first.value } } } });
  const rubric = await run(base, set('rubric'), rubricDraft()); expect(rubric).toMatchObject({ code: 0, value: { revision: 1, linkage: { state: 'current' } } });
  expect(await run(base, set('context', '1'), contextDraft('Changed'))).toMatchObject({ code: 0, value: { revision: 2 } });
  expect(await run(base, get('context', ['--revision', '1']))).toEqual(first);
  expect(await run(base, get('rubric', ['--revision', '1']))).toMatchObject({ code: 0, value: { linkage: { state: 'stale', referencedContextRevision: 1, currentContextRevision: 2 } } });
  expect(await run(base, set('preferences'))).toMatchObject({ code: 0, value: { revision: 1, effective: { useProjectContext: false } } });
});
it('returns safe HTTP refusal envelopes for unauthorized projects, unknown history and invalid refs', async () => {
  const { base } = await boot();
  expect(await run(base, ['context', 'get', '--project', 'q', '--json'])).toMatchObject({ code: 3, value: { status: 403, error: { code: 'project-forbidden', message: 'Project scope is not authorized' } } });
  expect(await run(base, get('context', ['--revision', '1']))).toMatchObject({ code: 3, value: { status: 404, error: { code: 'NOT_FOUND' } } });
  const invalid = contextDraft(); invalid.factSources[0]!.source = { assetId: 'foreign' };
  expect(await run(base, set('context'), invalid)).toMatchObject({ code: 3, value: { status: 422, error: { code: 'VALIDATION_FAILED', message: 'Project reference is invalid or unavailable' } } });
  expect(await run(base, set('context', '1'), contextDraft())).toMatchObject({ code: 2, value: { status: 400 } });
});
it('rejects invalid CLI flags and complete draft validation before HTTP or workspace resolution', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  for (const args of [get('unknown'), get('context', ['--revision', '0']), get('context', ['--revision', '01']), set('context', '-1'), set('context', '9007199254740992'), get('context', ['--workspace', 'w']), get('context', ['--json']), ['context', 'get', '--project', ' p ', '--json'], ['context', 'get', '--project', 'p\u0085', '--json'], get('preferences', ['--input-file', '-'])]) {
    expect(await run('http://127.0.0.1:1', args, contextDraft())).toMatchObject({ code: 2, value: { error: { code: 'invalid-cli-input' } } });
  }
  expect(await run('http://127.0.0.1:1', set('context'), { ...contextDraft(), projectId: 'p', revision: 1 })).toMatchObject({ code: 2 });
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('passes paired workspace authority and refuses foreign success DTOs and broken transport', async () => {
  const { base, requests } = await boot();
  expect(await run(base, get('context', ['--workspace', 'w', '--workspace-member', 'm']))).toMatchObject({ code: 0 });
  expect(requests[0]).toEqual({ project: 'p', workspace: 'w', member: 'm', method: 'GET' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ projectId: 'q', revision: 0, context: null }), { status: 200 }));
  expect(await run(base, get('context'))).toMatchObject({ code: 1, value: { error: { code: 'transport-or-server-failure' } } });
  vi.mocked(fetch).mockRejectedValue(new Error('private transport detail'));
  const failed = await run(base, get('context')); expect(failed).toMatchObject({ code: 1 }); expect(JSON.stringify(failed)).not.toContain('private transport detail');
});
it('runs actual source CLI subprocesses against HTTP using stdin, files, history and exit codes', async () => {
  const { base } = await boot(); const dir = await mkdtemp(join(tmpdir(), 'workbench-context-cli-')); dirs.push(dir);
  const repo = resolve(import.meta.dirname, '../../../..');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const shim = join(dir, 'contracts.ts');
  await writeFile(shim, `export * from ${JSON.stringify(join(repo, 'packages/contracts/src/index.ts'))};\nexport * from ${JSON.stringify(join(repo, 'packages/contracts/src/api/workbench-context.ts'))};\n`);
  const config = join(dir, 'tsconfig.json'); await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: repo, paths: { '@mish/contracts': [shim] } } }));
  const runner = `import {runContextCli} from ${JSON.stringify(join(repo, 'apps/daemon/src/workbench/context-cli.ts'))}; process.exitCode = await runContextCli(process.argv.slice(1), {env:process.env});`;
  const invoke = (args: string[], input?: unknown) => new Promise<{ code: number | null; value: unknown; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner, ...args, '--daemon-url', base], { cwd: join(repo, 'apps/daemon'), env: { ...process.env, TSX_TSCONFIG_PATH: config } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.once('error', reject);
    child.once('close', code => { try { resolve({ code, value: JSON.parse(stdout), stderr }); } catch { reject(new Error(`CLI process did not return JSON (exit ${code}): ${stderr}`)); } });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const first = await invoke(set('context'), contextDraft()); expect(first).toMatchObject({ code: 0, value: { projectId: 'p', revision: 1 }, stderr: '' });
  const file = join(dir, 'rubric.json'); await writeFile(file, JSON.stringify(rubricDraft()));
  const fileArgs = set('rubric'); fileArgs[fileArgs.indexOf('--input-file') + 1] = file;
  expect(await invoke(fileArgs)).toMatchObject({ code: 0, value: { revision: 1, linkage: { state: 'current' } }, stderr: '' });
  expect(await invoke(get('context', ['--revision', '1']))).toEqual(first);
  expect(await invoke(set('context'), contextDraft('Changed'))).toMatchObject({ code: 3, value: { status: 409, error: { details: { current: first.value } } } });
  expect(await invoke(set('preferences'))).toMatchObject({ code: 0, value: { effective: { useProjectContext: false } }, stderr: '' });
  expect(await invoke(get('preferences'))).toMatchObject({ code: 0, value: { revision: 1, effective: { useProjectContext: false } } });
  expect(await invoke(get('context', ['--revision', '0']))).toMatchObject({ code: 2, value: { error: { code: 'invalid-cli-input' } } });
  expect(await invoke(['context', 'get', '--project', 'q', '--json'])).toMatchObject({ code: 3, value: { status: 403, error: { code: 'project-forbidden' } } });
  const foreign = contextDraft(); foreign.factSources[0]!.source = { assetId: 'foreign' };
  expect(await invoke(set('context', '1'), foreign)).toMatchObject({ code: 3, value: { status: 422, error: { code: 'VALIDATION_FAILED', message: 'Project reference is invalid or unavailable' } } });
  expect(await invoke(get('context'))).toEqual(first);
}, 20000);
