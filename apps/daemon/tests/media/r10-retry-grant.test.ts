// B2 (AC-R10.1): a retry resolves its grant exactly like /media/generate.
//
// Red on 8512b3074c: the retry route always passed `grant: null`, so it
// skipped the sandbox tool-token requirement and the run's media policy.
//
// Route-level: real SQLite (lineage + task store), fake everything else.
// `generateMedia` is a vi.fn that must never be reached; no provider exists.

import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, getProject, insertProject, openDatabase } from '../../src/db.js';
import { recordMediaTaskLineage } from '../../src/media/lineage.js';
import { createMediaTaskStore } from '../../src/media/task-store.js';
import { insertMediaTask, listMediaTasksByProject } from '../../src/media/tasks.js';
import { registerMediaRoutes } from '../../src/routes/media.js';

const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  closeDatabase();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function noop() {}
function functionProxy(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      return property in target ? target[property as string] : noop;
    },
  });
}

type Grant = { token: string; runId: string; projectId: string } | null;

async function startRetryServer(options: { grant: Grant; runMediaMode?: 'enabled' | 'disabled' }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'r10-retry-grant-'));
  dirs.push(dataDir);
  const db = openDatabase(process.cwd(), { dataDir });
  const projectId = 'grant-project';
  const now = Date.now();
  insertProject(db, { id: projectId, name: 'Grant project', createdAt: now, updatedAt: now });
  const sourceId = 'source-task';
  insertMediaTask(db, {
    id: sourceId,
    projectId,
    status: 'failed',
    surface: 'image',
    model: 'custom-image',
    error: { message: 'fixture failure', status: 400 },
    startedAt: now - 10,
    endedAt: now,
  });
  // The insert above is backfilled into history at migration time only; record it now.
  recordMediaTaskLineage(db, {
    taskId: sourceId,
    projectId,
    status: 'failed',
    createdAt: now - 10,
    surface: 'image',
    model: 'custom-image',
    request: { surface: 'image', model: 'custom-image', prompt: 'fixture' },
  });

  const store = createMediaTaskStore(db);
  const generateMedia = vi.fn(async () => ({ name: 'never.png' }));
  const deps = {
    db,
    design: functionProxy({
      readAnalyticsContext: () => null,
      runs: { get: () => ({ mediaExecution: { mode: options.runMediaMode ?? 'enabled' } }) },
    }),
    http: {
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      isLocalSameOrigin: () => true,
      resolvedPortRef: { current: 0 },
    },
    paths: { PROJECT_ROOT: dataDir, PROJECTS_DIR: path.join(dataDir, 'projects'), RUNTIME_DATA_DIR: dataDir },
    ids: { randomUUID: () => `task-${Math.random().toString(16).slice(2)}` },
    auth: functionProxy({
      authorizeToolRequest: () => options.grant,
      optionalToolGrantFromRequest: (req: express.Request) =>
        req.get('authorization') ? options.grant : null,
      requestProjectOverride: (left: string, right: string) => left !== right,
    }),
    media: functionProxy({
      generateMedia,
      createMediaTask: store.createMediaTask,
      persistMediaTask: store.persistMediaTask,
      appendTaskProgress: store.appendTaskProgress,
      notifyTaskWaiters: store.notifyTaskWaiters,
      getLiveMediaTask: store.getLiveMediaTask,
      mediaTaskSnapshot: store.mediaTaskSnapshot,
      listMediaTasksByProject,
    }),
    appConfig: functionProxy({ readAppConfig: async () => ({}) }),
    orbit: functionProxy({ orbitService: functionProxy() }),
    nativeDialogs: functionProxy(),
    projectStore: functionProxy({ getProject, getWorkspaceProjectByProjectId: () => null }),
    projectFiles: functionProxy({ resolveProjectDir: (root: string, id: string) => path.join(root, id) }),
    conversations: functionProxy(),
    research: functionProxy({ ResearchError: class ResearchError extends Error {} }),
    authorizeProjectRequest: async () => true,
    authorizeProjectToolRequest: async () => true,
  } as unknown as Parameters<typeof registerMediaRoutes>[1];

  const app = express();
  app.use(express.json());
  registerMediaRoutes(app, deps);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const retry = (headers: Record<string, string> = {}) => fetch(
    `http://127.0.0.1:${address.port}/api/media/tasks/${sourceId}/retry`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'grant-key', ...headers }, body: '{}' },
  );
  const taskCount = () => listMediaTasksByProject(db, projectId, { includeTerminal: true }).length;
  return { retry, generateMedia, taskCount };
}

describe('B2 (AC-R10.1) retry grant resolution', () => {
  it('in sandbox mode, a retry without a tool token is 401 TOOL_TOKEN_MISSING and starts nothing', async () => {
    vi.stubEnv('OD_SANDBOX_MODE', '1');
    const { retry, generateMedia, taskCount } = await startRetryServer({ grant: null });
    const response = await retry();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'TOOL_TOKEN_MISSING' } });
    expect(generateMedia).not.toHaveBeenCalled();
    expect(taskCount()).toBe(1);
  });

  it('in sandbox mode, a token for another project is refused', async () => {
    vi.stubEnv('OD_SANDBOX_MODE', '1');
    const { retry, generateMedia } = await startRetryServer({
      grant: { token: 't', runId: 'run-x', projectId: 'some-other-project' },
    });
    const response = await retry({ authorization: 'Bearer t' });
    expect(response.status).toBe(403);
    expect(generateMedia).not.toHaveBeenCalled();
  });

  it('a retry under a run whose media execution is disabled is refused by that run\'s policy', async () => {
    const { retry, generateMedia, taskCount } = await startRetryServer({
      grant: { token: 't', runId: 'run-disabled', projectId: 'grant-project' },
      runMediaMode: 'disabled',
    });
    const response = await retry({ authorization: 'Bearer t' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'MEDIA_EXECUTION_DISABLED' } });
    expect(generateMedia).not.toHaveBeenCalled();
    expect(taskCount()).toBe(1);
  });
});
