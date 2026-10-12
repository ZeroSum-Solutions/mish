// RED SPEC (C1-B, "Build on brand", docs/plans/2026-10-09-build-on-brand/spec.md).
//
// `od build-on-brand` is the CLI half of the dual-track rule: it posts to the same
// `POST /api/build-on-brand` the Home entry uses and prints the daemon's answer. Until C2 adds
// the subcommand (registered through SUBCOMMAND_MAP), every case fails: the CLI prints
// "unknown command: od build-on-brand" and exits 2 without sending a request.
//
// The daemon side is a stub HTTP server that records each request and answers with a fixed
// body, so this file pins only the CLI: flag parsing, the request it sends, its output and its
// exit codes. The route itself is pinned by build-on-brand-route.test.ts.
//
// Every request-sending case passes `--no-wait`: the spec (docs/plans/2026-10-09-build-on-brand/
// spec.md) has the command follow the run by default, and following it is C2's to pin; with
// `--no-wait --json` the command prints the daemon's 202 answer and exits 0. `--brief-file` and
// the repository-wide `--prompt-file <path|->` (root AGENTS.md, dual-track rule) are the same
// input.
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as contracts from '@mish/contracts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const CLI_SRC = path.join(HERE, '../src/cli.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const KIT = 'neutral-product';
const BRIEF = 'A two-person physiotherapy clinic that treats running injuries.';
// A contract-valid answer, so a CLI that parses the daemon's reply with the shared schema accepts
// it. The target comes from the contract once it exists.
const STARTED = {
  projectId: 'proj-bob-1',
  conversationId: 'conv-bob-1',
  runId: 'run-bob-1',
  plan: {
    pageCount: 3,
    useLibrary: true,
    target: (contracts as Record<string, any>).BUILD_ON_BRAND_TARGETS?.[0] ?? 'static-site',
    designSystem: { id: KIT, binding: { tokensStylesheet: 'tokens.css' } },
    pages: [
      { role: 'home', file: 'index.html', sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] },
      { role: 'about', file: 'about.html', sections: [{ role: 'content', source: 'kit' }, { role: 'footer', source: 'kit' }] },
      { role: 'contact', file: 'contact.html', sections: [{ role: 'contact', source: 'kit' }, { role: 'footer', source: 'kit' }] },
    ],
    libraryInserts: [],
  },
};

type Recorded = { method: string; url: string; body: any };
type CliResult = { code: number | null; stdout: string; stderr: string };

describe('od build-on-brand', () => {
  let server: Server;
  let daemonUrl: string;
  let scratch: string;
  const requests: Recorded[] = [];
  let answer: { status: number; body: unknown } = { status: 202, body: STARTED };

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'od-bob-cli-'));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    daemonUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests.length = 0;
    answer = { status: 202, body: STARTED };
  });

  function runCli(args: string[], stdin = ''): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, OD_DAEMON_URL: daemonUrl };
    delete env.NODE_OPTIONS;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], { cwd: path.join(HERE, '..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`CLI timed out: od ${args.join(' ')}`)); }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(stdin);
    });
  }

  function buildRequests(): Recorded[] {
    return requests.filter((request) => request.url.split('?')[0] === '/api/build-on-brand');
  }

  /** A usage error from the build-on-brand command itself, not from the top-level dispatcher. */
  function expectOwnUsageError(result: CliResult, flag: string) {
    expect(result.stderr).not.toContain('unknown command');
    expect(result.stderr).toContain(flag);
    expect(result.code).toBe(2);
    expect(buildRequests()).toEqual([]);
  }

  it('posts a brief and a design system to POST /api/build-on-brand and prints the answer with --json', async () => {
    const result = await runCli(['build-on-brand', '--no-wait', '--brief', BRIEF, '--design-system', KIT, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const sent = buildRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toMatchObject({ brief: BRIEF, designSystemId: KIT });
    expect(sent[0]!.body.referenceUrl).toBeUndefined();
    // Unset flags leave the daemon's defaults in charge: library on, default page count.
    expect(sent[0]!.body.useLibrary ?? true).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(STARTED);
  });

  it('reads the brief from a file with --brief-file <path>', async () => {
    const briefFile = path.join(scratch, 'brief.md');
    await writeFile(briefFile, `${BRIEF}\nThree pages: home, services, contact.\n`, 'utf8');
    const result = await runCli(['build-on-brand', '--no-wait', '--brief-file', briefFile, '--design-system', KIT, '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(buildRequests()[0]!.body.brief).toContain('Three pages: home, services, contact.');
  });

  it('reads the brief from stdin with --brief-file -', async () => {
    const result = await runCli(['build-on-brand', '--no-wait', '--brief-file', '-', '--design-system', KIT, '--json'], `${BRIEF} From stdin.`);
    expect(result.code, result.stderr).toBe(0);
    expect(buildRequests()[0]!.body.brief).toContain('From stdin.');
  });

  it('accepts the repository-wide --prompt-file <path|-> form as the same brief input', async () => {
    const result = await runCli(['build-on-brand', '--no-wait', '--prompt-file', '-', '--design-system', KIT, '--json'], `${BRIEF} Via prompt-file.`);
    expect(result.code, result.stderr).toBe(0);
    expect(buildRequests()[0]!.body.brief).toContain('Via prompt-file.');
  });

  it('sends --url as referenceUrl, --pages as pageCount and --no-library as useLibrary: false', async () => {
    const result = await runCli([
      'build-on-brand', '--no-wait', '--url', 'https://harbor-and-pine.example/', '--design-system', KIT, '--pages', '5', '--no-library', '--json',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const body = buildRequests()[0]!.body;
    expect(body).toMatchObject({ referenceUrl: 'https://harbor-and-pine.example/', designSystemId: KIT, pageCount: 5, useLibrary: false });
    expect(body.brief).toBeUndefined();
  });

  it('refuses a missing --design-system before sending anything', async () => {
    expectOwnUsageError(await runCli(['build-on-brand', '--no-wait', '--brief', BRIEF, '--json']), '--design-system');
  });

  it('refuses a call with neither a brief nor a URL before sending anything', async () => {
    expectOwnUsageError(await runCli(['build-on-brand', '--no-wait', '--design-system', KIT, '--json']), '--brief');
  });

  it('refuses a page count outside 3..5 before sending anything', async () => {
    expectOwnUsageError(await runCli(['build-on-brand', '--no-wait', '--brief', BRIEF, '--design-system', KIT, '--pages', '7', '--json']), '--pages');
  });

  it('refuses a non-http(s) URL before sending anything', async () => {
    expectOwnUsageError(await runCli(['build-on-brand', '--no-wait', '--url', 'file:///etc/passwd', '--design-system', KIT, '--json']), '--url');
  });

  it('reports the daemon refusing an uninstalled design system with its error code and a non-zero exit', async () => {
    answer = { status: 422, body: { error: { code: 'DESIGN_SYSTEM_NOT_INSTALLED', message: 'design system not installed: nope' } } };
    const result = await runCli(['build-on-brand', '--no-wait', '--brief', BRIEF, '--design-system', 'nope', '--json']);
    expect(buildRequests()).toHaveLength(1);
    expect(result.code).not.toBe(0);
    const lastLine = result.stderr.trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(lastLine)).toMatchObject({ error: { code: 'DESIGN_SYSTEM_NOT_INSTALLED' } });
  });

  it('prints a readable summary without --json', async () => {
    const result = await runCli(['build-on-brand', '--no-wait', '--brief', BRIEF, '--design-system', KIT]);
    expect(result.code, result.stderr).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain(STARTED.projectId);
    expect(result.stdout).toContain(STARTED.runId);
  });

  it('documents its flags in --help and in the top-level usage', async () => {
    const help = await runCli(['build-on-brand', '--help']);
    expect(help.stderr).not.toContain('unknown command');
    const text = help.stdout + help.stderr;
    for (const flag of ['--brief', '--brief-file', '--prompt-file', '--url', '--design-system', '--pages', '--no-library', '--no-wait', '--json']) {
      expect(text, flag).toContain(flag);
    }
    const usage = await runCli(['--help']);
    expect(usage.stdout + usage.stderr).toContain('od build-on-brand');
    expect(buildRequests()).toEqual([]);
  });
});
