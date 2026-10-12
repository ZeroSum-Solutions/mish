// Atlas Digest pilot (G4): two `od media generate` calls with the same
// --output write the same project file, last writer wins. The done result was
// `{"file": {...}}` with no task id, and `od media wait <task>` returned the
// file by NAME — so a wait loop for an earlier task accepted bytes a later task
// had written over it, and could not even tell which task its result belonged
// to.
//
// Invariant pinned here: a done result names its own task, and neither
// `od media wait` nor the wait endpoint ever hands back a file whose bytes were
// written by a different task. Same-name overwrite itself stays allowed —
// regenerating `hero.png` in place is how existing artifacts pick up a new
// image.
//
// The provider is a local fake (OpenAI-compatible custom-image endpoint on
// 127.0.0.1); no real media provider is ever called.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/db.js';
import { startServer } from '../../src/server.js';

const daemonRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

// A valid 1x1 PNG. Each fake generation appends its prompt after IEND so two
// generations produce different bytes, as any real provider would.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=',
  'base64',
);

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

const ENV_KEYS = ['NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'OD_MEDIA_ALLOW_STUBS'];

describe('media output collisions are bound to their own task', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let daemon: StartedServer | null = null;
  let provider: Server | null = null;

  afterEach(async () => {
    await Promise.resolve(daemon?.shutdown?.());
    await closeServer(daemon?.server ?? null);
    await closeServer(provider);
    daemon = null;
    provider = null;
    closeDatabase();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function startFakeProviderAndDaemon(): Promise<{ url: string; projectId: string; projectDir: string }> {
    const started = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: string };
        const bytes = Buffer.concat([PNG, Buffer.from(`prompt:${body.prompt ?? ''}`)]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
      });
    });
    provider = started.server;
    process.env.NO_PROXY = '127.0.0.1,localhost';
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.OD_MEDIA_ALLOW_STUBS;

    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('test setup did not provide OD_DATA_DIR');
    await writeFile(path.join(dataDir, 'media-config.json'), JSON.stringify({
      providers: {
        'custom-image': {
          apiKey: 'fake-key',
          baseUrl: `${started.url}/v1`,
          model: 'fake-image-model',
        },
      },
    }));

    daemon = await startServer({ port: 0, returnServer: true }) as StartedServer;
    const projectId = `media_collision_${randomUUID()}`;
    const created = await fetch(`${daemon.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Output collision probe',
        metadata: { kind: 'prototype' },
        skipDiscoveryBrief: true,
      }),
    });
    expect(created.status).toBe(200);
    return { url: daemon.url, projectId, projectDir: path.join(dataDir, 'projects', projectId) };
  }

  it('names the task in a done result and refuses a file a later task overwrote', async () => {
    const { url, projectId, projectDir } = await startFakeProviderAndDaemon();
    const generate = (prompt: string) => runCli([
      'media', 'generate',
      '--project', projectId,
      '--surface', 'image',
      '--model', 'custom-image',
      '--prompt', prompt,
      '--output', 'hero.png',
      '--daemon-url', url,
    ]);

    const first = await generate('first take');
    expect(first.code, first.stderr).toBe(0);
    const firstTaskId = queuedTaskId(first.stderr);
    const firstResult = lastJson(first.stdout);
    // The done result names the task that wrote it.
    expect(firstResult).toMatchObject({ taskId: firstTaskId, file: { name: 'hero.png' } });

    const second = await generate('second take');
    expect(second.code, second.stderr).toBe(0);
    const secondTaskId = queuedTaskId(second.stderr);
    expect(secondTaskId).not.toBe(firstTaskId);
    expect(lastJson(second.stdout)).toMatchObject({ taskId: secondTaskId, file: { name: 'hero.png' } });
    // Same-name overwrite still happens: the project file now holds the
    // second task's bytes.
    expect((await readFile(path.join(projectDir, 'hero.png'))).toString('latin1'))
      .toContain('prompt:second take');

    // A late wait for the first task must not hand back the second task's file.
    const staleWait = await runCli(['media', 'wait', firstTaskId, '--daemon-url', url]);
    const staleResult = lastJson(staleWait.stdout);
    expect(staleResult.taskId).toBe(firstTaskId);
    expect(staleResult).not.toHaveProperty('file');
    expect(staleResult.error).toMatchObject({ code: 'MEDIA_OUTPUT_SUPERSEDED' });
    // Neither "done" (0) nor "still running" (2): the documented wait loop
    // must stop and report it.
    expect(staleWait.code).not.toBe(0);
    expect(staleWait.code).not.toBe(2);

    // The wait endpoint says the same thing to a direct HTTP caller.
    const snapshot = await fetch(`${url}/api/media/tasks/${encodeURIComponent(firstTaskId)}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since: 0, timeoutMs: 1_000 }),
    }).then((response) => response.json()) as Record<string, any>;
    expect(snapshot).toMatchObject({
      taskId: firstTaskId,
      status: 'done',
      error: { code: 'MEDIA_OUTPUT_SUPERSEDED', nextStep: 'output-superseded' },
    });
    // The snapshot must not leak the stale file record either (W1).
    expect(snapshot).not.toHaveProperty('file');

    // The project task list tells the same story as the wait (W2).
    const listed = await listTasks(url, projectId);
    expect(listed.get(firstTaskId)).not.toHaveProperty('file');
    expect(listed.get(firstTaskId)).toMatchObject({ status: 'done', error: { code: 'MEDIA_OUTPUT_SUPERSEDED' } });
    expect(listed.get(secondTaskId)).toMatchObject({ status: 'done', file: { name: 'hero.png' } });

    // The task that did write the current bytes still gets its file.
    const currentWait = await runCli(['media', 'wait', secondTaskId, '--daemon-url', url]);
    expect(currentWait.code, currentWait.stderr).toBe(0);
    expect(lastJson(currentWait.stdout)).toMatchObject({
      taskId: secondTaskId,
      file: { name: 'hero.png' },
    });
  }, 90_000);

  // W2/W7: a moved, deleted, or moved-then-reused output. The wait endpoint
  // and the project task list must agree whichever is asked first.
  it('agrees between wait and list for a moved or deleted output, in either order', async () => {
    const { url, projectId, projectDir } = await startFakeProviderAndDaemon();

    // Moved, then wait first, then list.
    const movedA = await generateViaHttp(url, projectId, 'move-me.png', 'moved first take');
    await rename(path.join(projectDir, 'move-me.png'), path.join(projectDir, 'moved.png'));
    expect(await waitViaHttp(url, movedA)).toMatchObject({ status: 'done', file: { name: 'moved.png' } });
    expect((await waitViaHttp(url, movedA)).error).toBeUndefined();
    expect((await listTasks(url, projectId)).get(movedA)).toMatchObject({ file: { name: 'moved.png' } });

    // Moved, then list first, then wait.
    const movedB = await generateViaHttp(url, projectId, 'move-me-2.png', 'moved second take');
    await rename(path.join(projectDir, 'move-me-2.png'), path.join(projectDir, 'moved-2.png'));
    expect((await listTasks(url, projectId)).get(movedB)).toMatchObject({ file: { name: 'moved-2.png' } });
    expect(await waitViaHttp(url, movedB)).toMatchObject({ status: 'done', file: { name: 'moved-2.png' } });

    // Moved away, then another generation reuses the old name: the first task
    // follows its bytes, the second owns the name.
    const reusedA = await generateViaHttp(url, projectId, 'hero-2.png', 'reused first take');
    await rename(path.join(projectDir, 'hero-2.png'), path.join(projectDir, 'old-hero.png'));
    const reusedB = await generateViaHttp(url, projectId, 'hero-2.png', 'reused second take, longer');
    expect(await waitViaHttp(url, reusedA)).toMatchObject({ file: { name: 'old-hero.png' } });
    const afterReuse = await listTasks(url, projectId);
    expect(afterReuse.get(reusedA)).toMatchObject({ file: { name: 'old-hero.png' } });
    expect(afterReuse.get(reusedB)).toMatchObject({ file: { name: 'hero-2.png' } });

    // Deleted: list first, then the CLI wait.
    const deleted = await generateViaHttp(url, projectId, 'gone.png', 'deleted take');
    await rm(path.join(projectDir, 'gone.png'));
    const listedDeleted = (await listTasks(url, projectId)).get(deleted);
    expect(listedDeleted).not.toHaveProperty('file');
    expect(listedDeleted).toMatchObject({ error: { code: 'MEDIA_OUTPUT_SUPERSEDED', nextStep: 'output-superseded' } });
    const cliWait = await runCli(['media', 'wait', deleted, '--daemon-url', url]);
    expect(cliWait.code).toBe(5);
    const cliResult = lastJson(cliWait.stdout);
    expect(cliResult).not.toHaveProperty('file');
    expect(cliResult).toMatchObject({
      taskId: deleted,
      status: 'done',
      error: { code: 'MEDIA_OUTPUT_SUPERSEDED', nextStep: 'output-superseded' },
    });
  }, 120_000);
});

async function generateViaHttp(url: string, projectId: string, output: string, prompt: string): Promise<string> {
  const response = await fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface: 'image', model: 'custom-image', prompt, output }),
  });
  expect(response.status).toBe(202);
  const { taskId } = await response.json() as { taskId: string };
  const done = await waitViaHttp(url, taskId);
  expect(done).toMatchObject({ status: 'done', file: { name: output } });
  return taskId;
}

async function waitViaHttp(url: string, taskId: string): Promise<Record<string, any>> {
  const response = await fetch(`${url}/api/media/tasks/${encodeURIComponent(taskId)}/wait`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ since: 0, timeoutMs: 5_000 }),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

async function listTasks(url: string, projectId: string): Promise<Map<string, Record<string, any>>> {
  const response = await fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/tasks?includeDone=1`);
  expect(response.status).toBe(200);
  const { tasks } = await response.json() as { tasks: Array<Record<string, any>> };
  return new Map(tasks.map((task) => [task.taskId as string, task]));
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OD_TOOL_TOKEN;
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: daemonRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function queuedTaskId(stderr: string): string {
  const match = /^task (\S+) queued/m.exec(stderr);
  if (!match?.[1]) throw new Error(`no queued task id on stderr: ${JSON.stringify(stderr)}`);
  return match[1];
}

/** The last JSON object a media command prints is its machine-readable result. */
function lastJson(stdout: string): Record<string, any> {
  const line = stdout
    .trim()
    .split('\n')
    .filter((entry) => entry.trim().startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`no JSON result on stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
