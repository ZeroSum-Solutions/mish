import type http from 'node:http';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryProbe } from '../../src/directory-probe.js';
import { registerMediaRoutes } from '../../src/routes/media.js';
import { HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT } from '../../src/tool-tokens.js';
const servers: http.Server[] = [];
const roots: string[] = [];
let recentDirs: string[] = [];
const writeConfig = vi.fn();
afterEach(async () => {
  vi.restoreAllMocks();
  writeConfig.mockClear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function noop() {}

function functionProxy(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      return property in target ? target[property as string] : noop;
    },
  });
}

async function startRouteServer() {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'od-hyperframes-route-'));
  roots.push(projectDir);
  const authorizeToolRequest = vi.fn(() => ({
    token: 'tool-token',
    runId: 'run-1',
    projectId: 'project-1',
    allowedEndpoints: [HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT],
    allowedOperations: ['media:scaffold'],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const deps = {
    db: {},
    design: functionProxy(),
    http: {
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      isLocalSameOrigin: () => true,
      resolvedPortRef: { current: 0 },
    },
    paths: {
      PROJECT_ROOT: projectDir,
      PROJECTS_DIR: path.dirname(projectDir),
      RUNTIME_DATA_DIR: projectDir,
    },
    ids: { randomUUID: () => 'unused' },
    auth: functionProxy({ authorizeToolRequest }),
    media: functionProxy(),
    appConfig: functionProxy({ readAppConfig: () => ({ recentLinkedDirs: recentDirs }), writeAppConfig: writeConfig }),
    orbit: functionProxy({ orbitService: functionProxy() }),
    nativeDialogs: functionProxy(),
    projectStore: functionProxy({
      getProject: (_db: unknown, projectId: string) => ({ id: projectId, metadata: {} }),
    }),
    projectFiles: functionProxy({ resolveProjectDir: () => projectDir }),
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
  return {
    authorizeToolRequest,
    projectDir,
    url: `http://127.0.0.1:${address.port}`,
  };
}


describe('D14 async directory probes', () => {
  it('uses async stat and reuses a short-lived result', async () => {
    const { url } = await startRouteServer();
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => true } as fs.Stats);
    const sync = vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('sync user-path stat forbidden'); });
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${url}/api/dir-exists`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/user/dir' }),
      });
      expect(await res.json()).toEqual({ exists: true });
    }
    expect(stat).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns unknown on a stat deadline instead of claiming the directory is missing', async () => {
    const { url } = await startRouteServer();
    vi.spyOn(fs.promises, 'stat').mockImplementation(() => new Promise<fs.Stats>(() => {}));
    const response = await fetch(`${url}/api/dir-exists`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/healthy/slow-mount' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exists: null, status: 'unknown', reason: 'timeout' });
  });

  it('probes recents concurrently and bounds a stalled mount without pruning it permanently', async () => {
    recentDirs = ['/good', '/stalled', '/missing'];
    const { url } = await startRouteServer();
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation((dir) => {
      if (dir === '/stalled') return new Promise<fs.Stats>(() => {});
      if (dir === '/missing') return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      return Promise.resolve({ isDirectory: () => true } as fs.Stats);
    });
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('no sync probe'); });
    const start = Date.now();
    const res = await fetch(`${url}/api/recent-dirs`);
    expect(await res.json()).toEqual({ dirs: ['/good'] });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(stat).toHaveBeenCalledTimes(3);
    expect(writeConfig).toHaveBeenCalledWith(expect.any(String), { recentLinkedDirs: ['/good', '/stalled'] });
  });

  it('D14 retains every healthy recent directory when the list exceeds the OS probe limit', async () => {
    recentDirs = ['/healthy/one', '/healthy/two', '/healthy/three', '/healthy/four', '/healthy/five'];
    const { url } = await startRouteServer();
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(() =>
      new Promise<fs.Stats>((resolve) => {
        setImmediate(() => resolve({ isDirectory: () => true } as fs.Stats));
      }),
    );
    const response = await fetch(`${url}/api/recent-dirs`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dirs: recentDirs });
    expect(stat).toHaveBeenCalledTimes(5);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

it('D14 timeouts do not spawn unbounded OS stats on repeated requests', async () => {
  vi.useFakeTimers();
  const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(() => new Promise<fs.Stats>(() => {}));
  const probe = createDirectoryProbe({ maxPending: 2 });
  try {
    const first = Promise.all(['/one', '/two', '/three'].map(probe));
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toEqual(['timeout', 'timeout', 'timeout']);
    await vi.advanceTimersByTimeAsync(2500);
    const second = Promise.all(['/one', '/two', '/three', '/four'].map(probe));
    await vi.advanceTimersByTimeAsync(500);
    expect(await second).toEqual(['timeout', 'timeout', 'timeout', 'timeout']);
    expect(stat).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
