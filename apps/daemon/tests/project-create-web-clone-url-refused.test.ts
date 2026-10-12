import type http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

// No real DNS in this suite: the Website Clone target check (D15) resolves
// through a stub (tests/helpers/web-clone-dns-stub.ts).
vi.mock('../src/web-clone-target-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/web-clone-target-check.js')>();
  const { stubWebCloneLookup } = await import('./helpers/web-clone-dns-stub.js');
  return {
    ...actual,
    webCloneTargetRefusal: (metadata: unknown, pendingPrompt: unknown) =>
      actual.webCloneTargetRefusal(metadata, pendingPrompt, stubWebCloneLookup),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs');

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun) => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolveRun({ stdout, stderr, code }));
  });
}

// D15 (QA sweep 3 P1-2): a Website Clone project is only worth creating when
// its brief names a public web page to clone. POST /api/projects applies the
// same public-URL check build-on-brand uses to the clone target and refuses
// anything else with REFERENCE_URL_REFUSED — before it creates a project, so
// the client never gets a project to auto-send a first run into. The CLI
// (`od project create`) calls this same route, so it shares the refusal.
describe('web-clone project create refuses a target that is not a public URL', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function projectIds(): Promise<string[]> {
    const resp = await fetch(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { projects: Array<{ id: string }> };
    return json.projects.map((p) => p.id);
  }

  async function activeRunCount(): Promise<number> {
    let total = 0;
    for (const status of ['queued', 'running']) {
      const resp = await fetch(`${baseUrl}/api/runs?status=${status}`);
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as { runs: unknown[] };
      total += json.runs.length;
    }
    return total;
  }

  async function postWebClone(pendingPrompt: string) {
    const id = `web-clone-refused-${randomUUID()}`;
    projectsToClean.push(id);
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: 'web-clone url gate',
        metadata: { kind: 'prototype', intent: 'web-clone' },
        pendingPrompt,
      }),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    return { id, status: resp.status, json };
  }

  it.each([
    ['plain text', 'Website URL to clone: not a url'],
    ['the bare scaffold with no URL', 'Website URL to clone: '],
    ['a non-http scheme', 'Website URL to clone: ftp://example.com/'],
    ['a loopback URL', 'Website URL to clone: http://127.0.0.1:8080/'],
    ['localhost', 'Website URL to clone: http://localhost:3000'],
    ['a private-network URL', 'Website URL to clone: http://10.0.0.5/admin'],
    ['cloud metadata', 'Website URL to clone: http://169.254.169.254/latest/meta-data'],
    ['a public URL followed by a loopback one', 'see https://example.com then clone http://localhost:3000'],
    ['a bare domain beside a private URL', 'clone example.com, styled like http://10.0.0.5/admin'],
    ['a file name', 'Website URL to clone: file.txt'],
    ['a host that does not resolve', 'Website URL to clone: https://d15-no-such-host.invalid/'],
  ])('refuses %s with 4xx REFERENCE_URL_REFUSED and creates nothing', async (_label, prompt) => {
    const before = await projectIds();
    const runsBefore = await activeRunCount();

    const { id, status, json } = await postWebClone(prompt);

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(json.error?.code).toBe('REFERENCE_URL_REFUSED');
    expect(json.error?.message).toBeTruthy();

    const after = await projectIds();
    expect(after).not.toContain(id);
    expect(after.length).toBe(before.length);
    const lookup = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
    expect(lookup.status).toBe(404);
    expect(await activeRunCount()).toBe(runsBefore);
  });

  it('still creates a web-clone project whose brief names a public URL', async () => {
    const { status } = await postWebClone('Website URL to clone: https://example.com');
    expect(status).toBe(200);
  });

  it('accepts a bare public domain as the clone target', async () => {
    const { status } = await postWebClone('Website URL to clone: example.com');
    expect(status).toBe(200);
  });

  describe('od project create', () => {
    let scratchDir: string;
    let metadataPath: string;

    beforeAll(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'od-web-clone-cli-'));
      metadataPath = join(scratchDir, 'metadata.json');
      writeFileSync(metadataPath, JSON.stringify({ kind: 'prototype', intent: 'web-clone' }));
    });

    afterAll(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });

    const cliArgs = (extra: string[]) => [
      'project', 'create',
      '--name', 'cli web-clone url gate',
      '--metadata-json', metadataPath,
      '--pending-prompt', 'Website URL to clone: not a url',
      '--daemon-url', baseUrl,
      ...extra,
    ];

    it('prints the refusal, exits non-zero and creates nothing', async () => {
      const before = await projectIds();
      const result = await runCli(cliArgs([]));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('REFERENCE_URL_REFUSED');
      expect(result.stderr).toContain('not a public web address');
      expect((await projectIds()).length).toBe(before.length);
    }, 60_000);

    it('emits the daemon error shape with --json', async () => {
      const before = await projectIds();
      const result = await runCli(cliArgs(['--json']));
      expect(result.code).not.toBe(0);
      const body = JSON.parse(result.stdout) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('REFERENCE_URL_REFUSED');
      expect(body.error?.message).toBeTruthy();
      expect((await projectIds()).length).toBe(before.length);
    }, 60_000);
  });

  it('does not gate projects that are not Website Clone', async () => {
    const id = `web-clone-refused-other-${randomUUID()}`;
    projectsToClean.push(id);
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: 'not a clone',
        metadata: { kind: 'prototype' },
        pendingPrompt: 'not a url',
      }),
    });
    expect(resp.status).toBe(200);
  });
});
