// Atlas Digest G4, Sol review. GET /api/projects/:id/media/tasks hashed every
// done task's output at once, so a project with many generations opened all
// of them together; once the descriptor limit hit, EMFILE read as a digest
// mismatch and valid outputs were listed as superseded.
//
// Pinned here: the listing hashes at most a bounded number of
// outputs at a time (4), and an output the daemon cannot read is listed by its
// recorded name, never as superseded (the wait endpoint agrees). The provider
// is a local fake; no real media provider is called.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  unreadableNames: new Set<string>(),
}));

vi.mock('../../src/media/output-witness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/media/output-witness.js')>();
  return {
    ...actual,
    mediaOutputMatches: async (target: string, record: Parameters<typeof actual.mediaOutputMatches>[1]) => {
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      try {
        if (probe.delayMs) await new Promise((resolve) => setTimeout(resolve, probe.delayMs));
        if (probe.unreadableNames.has(path.basename(target))) return 'unreadable';
        return await actual.mediaOutputMatches(target, record);
      } finally {
        probe.inFlight -= 1;
      }
    },
  };
});

const { closeDatabase } = await import('../../src/db.js');
const { startServer } = await import('../../src/server.js');
/** The listing's hashing bound (MEDIA_OUTPUT_HASH_CONCURRENCY in output-witness.ts). */
const HASH_BOUND = 4;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=',
  'base64',
);

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

describe('task listing output checks', () => {
  let daemon: StartedServer | null = null;
  let provider: Server | null = null;
  const env = { ...process.env };

  afterEach(async () => {
    await Promise.resolve(daemon?.shutdown?.());
    for (const server of [daemon?.server, provider]) {
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    daemon = null;
    provider = null;
    closeDatabase();
    for (const key of ['NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'OD_MEDIA_ALLOW_STUBS']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    probe.delayMs = 0;
    probe.maxInFlight = 0;
    probe.unreadableNames.clear();
  });

  it('bounds concurrent hashing and never lists an unreadable output as superseded', async () => {
    provider = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: string };
        const bytes = Buffer.concat([PNG, Buffer.from(`prompt:${body.prompt ?? ''}`)]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
      });
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env.NO_PROXY = '127.0.0.1,localhost';
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.OD_MEDIA_ALLOW_STUBS;
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('test setup did not provide OD_DATA_DIR');
    await writeFile(path.join(dataDir, 'media-config.json'), JSON.stringify({
      providers: { 'custom-image': { apiKey: 'fake-key', baseUrl: `${providerUrl}/v1`, model: 'fake' } },
    }));

    daemon = await startServer({ port: 0, returnServer: true }) as StartedServer;
    const url = daemon.url;
    const projectId = `media_bounds_${randomUUID()}`;
    const created = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Bounds probe', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(created.status).toBe(200);

    const taskIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: 'image', model: 'custom-image', prompt: `take ${index}`, output: `shot-${index}.png` }),
      });
      const { taskId } = await response.json() as { taskId: string };
      const done = await waitFor(url, taskId);
      expect(done.status).toBe('done');
      taskIds.push(taskId);
    }

    probe.delayMs = 20;
    probe.maxInFlight = 0;
    const listed = await listTasks(url, projectId);
    expect(probe.maxInFlight).toBeGreaterThan(0);
    expect(probe.maxInFlight).toBeLessThanOrEqual(HASH_BOUND);
    for (const taskId of taskIds) expect(listed.get(taskId)).toHaveProperty('file');

    // An output the daemon cannot read (EMFILE, EACCES) is not superseded.
    probe.delayMs = 0;
    probe.unreadableNames.add('shot-3.png');
    const unreadable = (await listTasks(url, projectId)).get(taskIds[3]!);
    expect(unreadable).toMatchObject({ status: 'done', file: { name: 'shot-3.png' } });
    expect(unreadable).not.toHaveProperty('error');
    const waited = await waitFor(url, taskIds[3]!);
    expect(waited).toMatchObject({ status: 'done', file: { name: 'shot-3.png' } });
    expect(waited).not.toHaveProperty('error');
  }, 120_000);
});

async function waitFor(url: string, taskId: string): Promise<Record<string, any>> {
  const response = await fetch(`${url}/api/media/tasks/${encodeURIComponent(taskId)}/wait`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ since: 0, timeoutMs: 5_000 }),
  });
  return await response.json() as Record<string, any>;
}

async function listTasks(url: string, projectId: string): Promise<Map<string, Record<string, any>>> {
  const response = await fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/tasks?includeDone=1`);
  const { tasks } = await response.json() as { tasks: Array<Record<string, any>> };
  return new Map(tasks.map((task) => [task.taskId as string, task]));
}
