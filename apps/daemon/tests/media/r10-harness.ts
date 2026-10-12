// Shared harness for the AC-R10 media workbench specs (cancel, retry, gallery).
//
// FAKE PROVIDER ONLY. Every byte these specs produce comes from a local
// OpenAI-compatible `custom-image` endpoint on 127.0.0.1 that this file
// starts. No real media provider (Higgsfield, Kie.ai, FAL, OpenAI, Codex, …)
// is ever called: the owner's image hold forbids it, and the fixture bytes
// carry a `FAKE-PROVIDER-FIXTURE` marker so they can never pass for a real
// generation.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDatabase } from '../../src/db.js';
import { startServer } from '../../src/server.js';

const daemonRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/** A valid 1x1 PNG; each fake generation appends a labelled marker after IEND. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=',
  'base64',
);

export const FAKE_PROVIDER_MARKER = 'FAKE-PROVIDER-FIXTURE';

/** Fake secrets only. Each must vanish from every stored or returned error. */
export const LEAKED_SECRETS = [
  'FAKESIGNATURE0123456789abcdef',
  'AKIAFAKEFAKEFAKE1234',
  'sk-fakeSecretKey0123456789',
  'fakeBearerToken.abc.def',
  'fakeApiKeyValue42',
  'fakeuser:fakepass',
] as const;

export const LEAKY_PROVIDER_MESSAGE =
  `${FAKE_PROVIDER_MARKER}: download https://fakeuser:fakepass@cdn.fake-provider.test/out/image.png` +
  `?X-Amz-Signature=FAKESIGNATURE0123456789abcdef&X-Amz-Credential=AKIAFAKEFAKEFAKE1234#frag failed; ` +
  `sent Authorization: Bearer fakeBearerToken.abc.def with key sk-fakeSecretKey0123456789 and api_key=fakeApiKeyValue42`;

export function fakeImageBytes(prompt: string): Buffer {
  return Buffer.concat([PNG, Buffer.from(`${FAKE_PROVIDER_MARKER} prompt:${prompt}`)]);
}

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

/**
 * Prompt keywords steer the fake:
 * - `hold`  — keep the request open until `releaseHeld()` or the client aborts.
 * - `fail`  — refuse every time with HTTP 400.
 * - `flaky` — refuse the first request for that prompt, succeed afterwards.
 * - `leak`  — refuse with an error body that carries fake credentials (a
 *   signed URL, a bearer token, an api key), to prove they are redacted.
 * - anything else succeeds at once.
 */
export interface FakeProvider {
  url: string;
  /** Prompts whose held request the daemon aborted (the socket closed unanswered). */
  aborted: Set<string>;
  /** Prompts currently held open. */
  held: Map<string, ServerResponse>;
  calls: string[];
  releaseHeld(): void;
  close(): Promise<void>;
}

export async function startFakeImageProvider(): Promise<FakeProvider> {
  const aborted = new Set<string>();
  const held = new Map<string, ServerResponse>();
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const succeed = (res: ServerResponse, prompt: string) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: fakeImageBytes(prompt).toString('base64') }] }));
  };
  const refuse = (res: ServerResponse) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${FAKE_PROVIDER_MARKER}: refused on purpose` } }));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let prompt = '';
      try {
        prompt = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: unknown }).prompt ?? '');
      } catch {
        prompt = '';
      }
      calls.push(prompt);
      const count = (seen.get(prompt) ?? 0) + 1;
      seen.set(prompt, count);
      if (prompt.includes('hold')) {
        held.set(prompt, res);
        res.on('close', () => {
          if (!res.writableEnded) aborted.add(prompt);
          held.delete(prompt);
        });
        return;
      }
      if (prompt.includes('leak')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: LEAKY_PROVIDER_MESSAGE } }));
        return;
      }
      if (prompt.includes('fail')) return refuse(res);
      if (prompt.includes('flaky') && count === 1) return refuse(res);
      succeed(res, prompt);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake provider has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    aborted,
    held,
    calls,
    releaseHeld() {
      for (const [prompt, res] of held) {
        if (!res.writableEnded && !res.destroyed) succeed(res, prompt);
      }
    },
    async close() {
      for (const res of held.values()) res.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const ENV_KEYS = ['NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'OD_MEDIA_ALLOW_STUBS'];

export interface R10Daemon {
  url: string;
  dataDir: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
  createProject(name?: string): Promise<{ projectId: string; projectDir: string }>;
}

/** Point the daemon's `custom-image` provider at the fake and start it. */
export async function startR10Daemon(provider: FakeProvider): Promise<R10Daemon> {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
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
        apiKey: 'fake-key-for-local-fixture',
        baseUrl: `${provider.url}/v1`,
        model: 'fake-image-model',
      },
    },
  }));

  let started = await startServer({ port: 0, returnServer: true }) as StartedServer;
  const shutdown = async () => {
    await Promise.resolve(started.shutdown?.());
    if (started.server.listening) {
      started.server.closeAllConnections?.();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
    closeDatabase();
  };
  const daemon: R10Daemon = {
    url: started.url,
    dataDir,
    async restart() {
      await shutdown();
      started = await startServer({ port: 0, returnServer: true }) as StartedServer;
      daemon.url = started.url;
    },
    async stop() {
      await shutdown();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    async createProject(name = 'R10 media project') {
      const projectId = `r10_${randomUUID()}`;
      const created = await fetch(`${daemon.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, name, metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
      });
      if (created.status !== 200) throw new Error(`project create failed: ${created.status}`);
      return { projectId, projectDir: path.join(dataDir, 'projects', projectId) };
    },
  };
  return daemon;
}

export async function generate(
  url: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface: 'image', model: 'custom-image', ...body }),
  });
  if (response.status !== 202) {
    throw new Error(`generate returned ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as { taskId: string }).taskId;
}

/** Long-poll a task until it is terminal. */
export async function waitTerminal(url: string, taskId: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${url}/api/media/tasks/${encodeURIComponent(taskId)}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since: 0, timeoutMs: 2_000 }),
    });
    const snapshot = await response.json() as Record<string, any>;
    if (['done', 'failed', 'interrupted'].includes(snapshot.status)) return snapshot;
  }
  throw new Error(`task ${taskId} never became terminal`);
}

export async function until(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

export function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

/** The last JSON object a command prints on stdout. */
export function lastJson(stdout: string): Record<string, any> {
  const line = stdout.trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON on stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}
