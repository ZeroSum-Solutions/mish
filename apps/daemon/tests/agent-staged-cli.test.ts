import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface Captured { method: string; url: string; body: string }

async function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od agent staged', () => {
  let server: http.Server;
  let baseUrl = '';
  const requests: Captured[] = [];
  let enabled = false;
  let stageReads = 0;
  const staged = (runId: string | null, status: string) => ({ stages: [{ stage: 'draft', runId: 'draft', status: 'succeeded' }, { stage: 'finish', runId, status }], fallback: null });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/runs/draft/events' || req.url === '/api/runs/finish/events') {
          const draft = req.url.includes('draft');
          res.setHeader('content-type', 'text/event-stream');
          res.end(`event: stdout\ndata: ${JSON.stringify({ chunk: draft ? 'Draft' : 'Finishing answer' })}\n\nevent: end\ndata: ${JSON.stringify({ status: 'succeeded', staged: draft ? staged(null, 'pending') : staged('finish', 'succeeded') })}\n\n`);
        } else if (req.url === '/api/runs/draft') {
          res.end(JSON.stringify({ id: 'draft', projectId: 'p', conversationId: 'c', status: 'succeeded', staged: ++stageReads === 1 ? staged(null, 'pending') : staged('finish', 'running') }));
        } else if (req.method === 'PUT' && req.url === '/api/app-config') {
          enabled = JSON.parse(body).stagedDrafting === true;
          res.end('{"config":{}}');
        } else if (req.method === 'POST' && req.url === '/api/runs/run-1/staged/finish') {
          res.statusCode = 202;
          res.end('{"runId":"run-2"}');
        } else if (req.method === 'POST' && req.url === '/api/runs/run-9/staged/finish') {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: { code: 'CONFLICT', message: 'This run has no interrupted finishing pass.' } }));
        } else if (req.method === 'GET' && req.url === '/api/agents/staged') {
          res.end(JSON.stringify({
            status: {
              enabled,
              draft: { agentId: 'claude', model: 'claude-haiku-5-5', source: 'claude' },
              unavailableReason: null,
            },
          }));
        } else {
          res.statusCode = 404;
          res.end('{"error":"unexpected"}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => { requests.length = 0; enabled = false; stageReads = 0; });

  it('turns the switch on through app-config and reports status as JSON', async () => {
    const result = await runCli(['agent', 'staged', 'on', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'PUT /api/app-config',
      'GET /api/agents/staged',
    ]);
    expect(JSON.parse(requests[0]!.body)).toEqual({ stagedDrafting: true });
    expect(JSON.parse(result.stdout).status).toMatchObject({ enabled: true });
  });

  it('turns it off', async () => {
    const result = await runCli(['agent', 'staged', 'off', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(JSON.parse(requests[0]!.body)).toEqual({ stagedDrafting: false });
  });

  it('od run watch follows the staged successor and prints its answer (V07 BLOCK 4)', async () => {
    const result = await runCli(['run', 'watch', 'draft', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Finishing answer');
    expect(requests.map(req => req.url)).toContain('/api/runs/finish/events');
  });

  it('status only reads', async () => {
    const result = await runCli(['agent', 'staged', 'status', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(requests.map((r) => r.method)).toEqual(['GET']);
    expect(result.stdout).toContain('Staged drafting: off');
    expect(result.stdout).toContain('claude-haiku-5-5');
  });

  it('rejects an unknown action', async () => {
    const result = await runCli(['agent', 'staged', 'maybe', '--daemon-url', baseUrl]);
    expect(result.code).toBe(2);
  });

  it('finish starts the finishing pass of an interrupted run', async () => {
    const result = await runCli(['agent', 'staged', 'finish', 'run-1', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/runs/run-1/staged/finish']);
    expect(JSON.parse(result.stdout)).toEqual({ runId: 'run-2' });
  });

  it('finish needs a run id and reports a refusal', async () => {
    const missing = await runCli(['agent', 'staged', 'finish', '--daemon-url', baseUrl]);
    expect(missing.code).toBe(2);
    const refused = await runCli(['agent', 'staged', 'finish', 'run-9', '--daemon-url', baseUrl]);
    expect(refused.code).not.toBe(0);
  });
});
