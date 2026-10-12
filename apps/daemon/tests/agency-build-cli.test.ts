// `od agency build` — the CLI half of the fast-lane build job (dual-track rule; design
// 2026-09-20 §6.5).
//
// Same shape as `design-index-cli.test.ts`: spawn the real CLI against a stub HTTP server that
// answers the daemon's own envelopes, and assert the request it builds, the lines it prints and
// the code it exits with. The stub owns the SSE stream, so the stamped lines under test are the
// ones a real build would print.

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { failureLines, runAgencyBuildCli } from '../src/agency-build-cli.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Resolves once the stream handler has sent everything it was given. */
  close: () => Promise<void>;
}

interface StubOptions {
  /** The answer to `POST /api/agency/build`. */
  start?: { status: number; body: unknown };
  /** The answer to `POST /api/agency/builds/:id/fork` — `--from`'s endpoint. Defaults to the same
   * 202/`QUEUED` shape `start` defaults to, since a fork answers exactly like a build does. */
  fork?: { status: number; body: unknown };
  /** SSE frames, in order, as `[event, data]`. */
  frames?: Array<[string, unknown]>;
  /** Held open until the process cancels, then the frames are sent. */
  waitForCancel?: boolean;
  /** The answer to `GET /api/agency/families` (C16, `od agency families`). */
  families?: unknown;
  /** The answer to `GET /api/agency/families/:family/sections` (`od agency sections`). */
  sections?: unknown;
  /** The answer to `GET /api/sections` (`od sections list`). */
  sectionCatalog?: unknown;
  /** The answer to `GET /api/sections/:id` (`od sections get`); a `[404]` tuple answers 404. */
  sectionEntry?: unknown | [404];
  /** The answer to `GET /api/motionsites/connection` (`od sections`' access label). */
  motionsitesConnection?: unknown;
}

let stub: StubServer | null = null;
let tempRoot = '';

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

const QUEUED = { id: 'build-1', status: 'queued', events: [], startedAt: '2026-09-20T10:00:00.000Z' };

function snapshot(status: string, extra: Record<string, unknown> = {}) {
  return { ...QUEUED, status, finishedAt: '2026-09-20T10:01:00.000Z', ...extra };
}

async function startStub(options: StubOptions = {}): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let cancelled = () => {};
  const cancelSeen = new Promise<void>((resolve) => { cancelled = resolve; });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, body: raw });

      if (url === '/api/agency/families' && options.families !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(options.families));
        return;
      }
      if (/^\/api\/agency\/families\/[^/]+\/sections$/.test(url) && options.sections !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(options.sections));
        return;
      }
      if (url.startsWith('/api/sections?') || url === '/api/sections') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(options.sectionCatalog ?? { catalog: { schema: 'section-catalog/1', entries: [] }, directions: [] }));
        return;
      }
      if (/^\/api\/sections\/[^?]+$/.test(url) && url !== '/api/sections') {
        if (Array.isArray(options.sectionEntry) && options.sectionEntry[0] === 404) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such section' } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ entry: options.sectionEntry }));
        return;
      }
      if (url === '/api/motionsites/connection') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(options.motionsitesConnection ?? { status: 'not_connected' }));
        return;
      }
      if (url === '/api/agency/build') {
        const answer = options.start ?? { status: 202, body: { build: QUEUED } };
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
        return;
      }
      if (url.endsWith('/fork')) {
        const answer = options.fork ?? { status: 202, body: { build: QUEUED } };
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
        return;
      }
      if (url.endsWith('/cancel')) {
        cancelled();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ build: snapshot('cancelled') }));
        return;
      }
      if (url.endsWith('/events') || url.endsWith('/agui')) {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.flushHeaders();
        if (options.waitForCancel) await cancelSeen;
        for (const [event, data] of options.frames ?? []) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args, '--daemon-url', stub!.baseUrl],
      { cwd: REPO_ROOT, env: { ...process.env, OD_DAEMON_URL: stub!.baseUrl } },
    );
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const ROUTED_EVENT = { seq: 1, at: '2026-09-20T10:00:01.000Z', type: 'route', ms: 610, decision: 'routed', family: 'wrenfield' };
const PROJECT_EVENT = { seq: 2, at: '2026-09-20T10:00:02.000Z', type: 'project', projectId: 'project-1', created: true };
const UNIT_EVENT = { seq: 3, at: '2026-09-20T10:00:10.000Z', type: 'unit', label: 'hero', ms: 8_100, repairs: 1 };
const VERIFY_EVENT = { seq: 4, at: '2026-09-20T10:00:40.000Z', type: 'verify', ms: 4_200, counts: { checked: 12, illustrative: 9, flagged: 2, repaired: 2, remaining: 0 } };
const REGISTERED_EVENT = { seq: 5, at: '2026-09-20T10:00:41.000Z', type: 'registered', ms: 41_000 };

describe('od agency build', () => {
  it('follows the stream, prints the stamped lines and exits 0 on done', async () => {
    stub = await startStub({
      frames: [
        ['build-event', ROUTED_EVENT],
        ['build-event', PROJECT_EVENT],
        ['build-event', UNIT_EVENT],
        ['build-event', VERIFY_EVENT],
        ['build-event', { seq: 5, at: '2026-09-30T00:00:00Z', type: 'render-quality', renderQuality: { passed: true, scope: 'site', checks: ['unique-ids', 'page-heading'], issueCounts: [] } }],
        ['build-event', REGISTERED_EVENT],
        ['status', snapshot('done', { family: 'wrenfield', projectId: 'project-1' })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('route: wrenfield');
    expect(result.stdout).toContain('project project-1');
    expect(result.stdout).toContain('unit hero done after 1 repair(s)');
    expect(result.stdout).toContain('verify: checked 12, flagged 2, repaired 2, remaining 0, illustrative 9 (sample data, not fact-checked)');
    expect(result.stdout).toContain('registered');
    expect(result.stdout).toContain('structure: passed 2 checks');
    expect(result.stdout).toContain('done');

    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(started?.method).toBe('POST');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'auto', verify: 'strict' });
  });

  it('prints "illustrative not reported" for a verify event without the count', async () => {
    const { illustrative: _dropped, ...legacyCounts } = VERIFY_EVENT.counts;
    stub = await startStub({
      frames: [
        ['build-event', { ...VERIFY_EVENT, counts: legacyCounts }],
        ['status', snapshot('done', { family: 'wrenfield', projectId: 'project-1' })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('verify: checked 12, flagged 2, repaired 2, remaining 0, illustrative not reported');
  });

  it('sends the flags it was given', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-build-cli-'));
    const briefFile = join(tempRoot, 'brief.txt');
    writeFileSync(briefFile, BRIEF);
    stub = await startStub({ frames: [['status', snapshot('done')]] });

    await runCli([
      'agency', 'build',
      '--prompt-file', briefFile,
      '--family', 'wrenfield',
      '--verify', 'advisory',
      '--mode', 'single',
      '--name', 'Riverbend Dental',
      '--project', 'project-7',
    ]);

    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({
      brief: BRIEF,
      family: 'wrenfield',
      verify: 'advisory',
      mode: 'single',
      projectName: 'Riverbend Dental',
      projectId: 'project-7',
    });
  });

  it('sends --keep/--drop as section hints and prints the sections decision', async () => {
    stub = await startStub({
      frames: [
        ['build-event', { seq: 1, at: '2026-09-20T10:00:01.000Z', type: 'sections', ms: 400, keptSections: ['final-cta'], droppedSections: ['reviews'], sectionSource: 'jev' }],
        ['status', snapshot('done')],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--family', 'wrenfield', '--keep', 'final-cta', '--drop', 'reviews,support']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sections (jev): dropped reviews');
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'wrenfield', verify: 'strict', sections: { 'final-cta': 'keep', reviews: 'drop', support: 'drop' } });
  });

  it('refuses a section named by both --keep and --drop, without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--keep', 'reviews', '--drop', 'reviews']);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  // ---- --section/--after/--replace/--direction/--reference/--reference-file (sol-design.md §2) --

  it('sends --section --after --direction as an append sectionSelection', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli([
      'agency', 'build', '--brief', BRIEF, '--family', 'wrenfield',
      '--section', 'hyperui:marketing/ctas/1', '--after', 'hero', '--direction', 'modern-minimal',
    ]);
    expect(result.code).toBe(0);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({
      brief: BRIEF,
      family: 'wrenfield',
      verify: 'strict',
      sectionSelection: {
        entryId: 'hyperui:marketing/ctas/1',
        placement: { mode: 'append', afterSectionId: 'hero' },
        directionId: 'modern-minimal',
      },
    });
  });

  it('sends --section --replace --direction as a replace-optional sectionSelection', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    await runCli([
      'agency', 'build', '--brief', BRIEF, '--family', 'wrenfield',
      '--section', 'hyperui:marketing/feature-grids/1', '--replace', 'reviews', '--direction', 'editorial-monocle',
    ]);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toMatchObject({
      sectionSelection: {
        entryId: 'hyperui:marketing/feature-grids/1',
        placement: { mode: 'replace-optional', targetSectionId: 'reviews' },
        directionId: 'editorial-monocle',
      },
    });
  });

  it('refuses --section without exactly one of --after/--replace, without reaching the daemon', async () => {
    stub = await startStub();
    const neither = await runCli(['agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1', '--direction', 'modern-minimal']);
    expect(neither.code).toBe(2);
    const both = await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--replace', 'reviews', '--direction', 'modern-minimal',
    ]);
    expect(both.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses --section without --direction, without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1', '--after', 'hero']);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('sends --reference as designReferenceId, only alongside --section', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--direction', 'modern-minimal', '--reference', 'motionsites-prompt:9f2c',
    ]);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toMatchObject({ designReferenceId: 'motionsites-prompt:9f2c' });
  });

  it('refuses --reference without --section, without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--reference', 'motionsites-prompt:9f2c']);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('sends --reference-file\'s contents as designReferenceText, never the raw --prompt-file brief flag', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-build-cli-'));
    const referenceFile = join(tempRoot, 'reference.txt');
    writeFileSync(referenceFile, 'Editorial layout, tight grid, restrained motion.');
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--direction', 'modern-minimal', '--reference-file', referenceFile,
    ]);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toMatchObject({ designReferenceText: 'Editorial layout, tight grid, restrained motion.' });
  });

  it('refuses --reference and --reference-file together, without reaching the daemon', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-build-cli-'));
    const referenceFile = join(tempRoot, 'reference.txt');
    writeFileSync(referenceFile, 'text');
    stub = await startStub();
    const result = await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1', '--after', 'hero',
      '--direction', 'modern-minimal', '--reference', 'motionsites-prompt:9f2c', '--reference-file', referenceFile,
    ]);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('exits 2 with the daemon\'s message when a MotionSites reference needs sign-in', async () => {
    stub = await startStub({
      start: { status: 401, body: { error: { code: 'MOTIONSITES_LOGIN_REQUIRED', message: 'No MotionSites connection.' } } },
    });
    const result = await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--direction', 'modern-minimal', '--reference', 'motionsites-prompt:9f2c',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No MotionSites connection.');
  });

  it('exits 2 with the daemon\'s message when a MotionSites reference needs a paid plan', async () => {
    stub = await startStub({
      start: { status: 403, body: { error: { code: 'MOTIONSITES_PAID_ACCESS_REQUIRED', message: 'needs a paid plan' } } },
    });
    const result = await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--direction', 'modern-minimal', '--reference', 'motionsites-prompt:9f2c',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('needs a paid plan');
  });

  it('exits 2 with the daemon\'s message when the MotionSites endpoint itself is unavailable (502)', async () => {
    stub = await startStub({
      start: { status: 502, body: { error: { code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: 'motionsites.ai did not answer' } } },
    });
    const result = await runCli([
      'agency', 'build', '--brief', BRIEF, '--section', 'hyperui:marketing/ctas/1',
      '--after', 'hero', '--direction', 'modern-minimal', '--reference', 'motionsites-prompt:9f2c',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('motionsites.ai did not answer');
  });

  it('sends --verify after, the mode the daemon route already accepts', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--verify', 'after']);
    expect(result.code).toBe(0);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'auto', verify: 'after' });
  });

  it('rejects an unknown verify mode without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--verify', 'later']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--verify must be one of strict, advisory, after, off');
    expect(stub.requests).toHaveLength(0);
  });

  it('exits 3 on an unrouted brief, which is a decision and not a failure', async () => {
    stub = await startStub({
      frames: [
        ['build-event', { ...ROUTED_EVENT, decision: 'unrouted', family: undefined }],
        ['status', snapshot('unrouted', { route: { decision: 'unrouted', spine: 'CS' } })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('unrouted');
  });

  it('exits 1 on a failed build and prints the daemon\'s fixed sentence', async () => {
    stub = await startStub({
      frames: [['status', snapshot('failed', { error: { code: 'BUILD_FAILED', message: 'the build failed' } })]],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the build failed');
  });

  it('exits 4 on a cancelled build, which is nobody\'s bug', async () => {
    stub = await startStub({ frames: [['status', snapshot('cancelled')]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(4);
  });

  it('exits 2 with the fixed sentence when Jev is unavailable', async () => {
    stub = await startStub({
      start: { status: 503, body: { error: { code: 'JEV_UNAVAILABLE', message: 'Jev is not available on this daemon' } } },
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Jev is not available on this daemon');
  });

  it('exits 2 and names the running build when the daemon is busy', async () => {
    stub = await startStub({
      start: {
        status: 409,
        body: { error: { code: 'BUILD_BUSY', message: 'a build is already running on this daemon', details: { kind: 'agency-build-busy', activeId: 'build-9' } } },
      },
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('a build is already running on this daemon');
    expect(result.stderr).toContain('build-9');
  });

  it('exits 2 on usage, without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build']);
    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('--no-wait prints the id and returns without following the stream', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--no-wait']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('build-1');
    expect(stub.requests.map((request) => request.url)).toEqual(['/api/agency/build']);
  });

  it('--json prints the final snapshot instead of the stamped lines', async () => {
    const final = snapshot('done', { family: 'wrenfield', projectId: 'project-1' });
    stub = await startStub({ frames: [['build-event', ROUTED_EVENT], ['status', final]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(final);
    expect(result.stdout).not.toContain('route: wrenfield');
  });

  it('--json carries every provider that filled the build, and the last one as provider/model', async () => {
    const providers = [
      { provider: 'deepseek', model: 'deepseek-v4-flash', sections: ['hero'] },
      { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['about', 'footer'] },
    ];
    const final = snapshot('done', { family: 'wrenfield', projectId: 'project-1', provider: 'cerebras', model: 'gpt-oss-120b', providers });
    stub = await startStub({ frames: [['status', final]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--json']);
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.stdout) as { provider?: string; providers?: unknown };
    expect(printed.providers).toEqual(providers);
    expect(printed.provider).toBe('cerebras');
  });

  it('cancels the build on SIGINT before it exits', async () => {
    stub = await startStub({ waitForCancel: true, frames: [['status', snapshot('cancelled')]] });
    const child = spawn(
      process.execPath,
      [TSX_CLI, CLI_SRC, 'agency', 'build', '--brief', BRIEF, '--daemon-url', stub.baseUrl],
      { cwd: REPO_ROOT, env: { ...process.env, OD_DAEMON_URL: stub.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Wait until the stream request has arrived, so the handler is installed before the signal.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (stub.requests.some((request) => request.url.endsWith('/events'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    const code = await new Promise<number>((resolve) => child.on('exit', (value) => resolve(value ?? 1)));

    expect(stub.requests.some((request) => request.method === 'POST' && request.url.endsWith('/cancel'))).toBe(true);
    expect(code).toBe(4);
  });

  it('starts from a saved build with --from, no --brief required', async () => {
    stub = await startStub({ frames: [['status', snapshot('done', { projectId: 'project-2' })]] });
    const result = await runCli(['agency', 'build', '--from', 'build-1']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('done — project project-2');
    const fork = stub.requests.find((request) => request.method === 'POST' && request.url.endsWith('/fork'));
    expect(fork?.url).toBe('/api/agency/builds/build-1/fork');
    expect(JSON.parse(fork!.body)).toEqual({});
    expect(stub.requests.some((request) => request.url === '/api/agency/build')).toBe(false);
  });

  it('--from with --brief overrides only the saved build\'s brief text', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--from', 'build-1', '--brief', 'A different brief.']);

    expect(result.code).toBe(0);
    const fork = stub.requests.find((request) => request.url.endsWith('/fork'));
    expect(JSON.parse(fork!.body)).toEqual({ brief: 'A different brief.' });
  });

  it('--from with --keep/--drop sends the hints as the fork\'s section override', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--from', 'build-1', '--keep', 'reviews', '--drop', 'support']);

    expect(result.code).toBe(0);
    const fork = stub.requests.find((request) => request.url.endsWith('/fork'));
    expect(JSON.parse(fork!.body)).toEqual({ sections: { reviews: 'keep', support: 'drop' } });
  });

  it('--from with --auto clears a saved hint in the fork\'s section override', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--from', 'build-1', '--auto', 'reviews', '--drop', 'support']);

    expect(result.code).toBe(0);
    const fork = stub.requests.find((request) => request.url.endsWith('/fork'));
    expect(JSON.parse(fork!.body)).toEqual({ sections: { reviews: 'auto', support: 'drop' } });
  });

  it('refuses --auto without --from, without reaching the daemon', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--auto', 'reviews']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--auto');
    expect(stub.requests).toHaveLength(0);
  });

  it('exits 2 with the daemon\'s message when a build cannot be forked', async () => {
    stub = await startStub({
      fork: { status: 409, body: { error: { code: 'BUILD_NOT_FORKABLE', message: 'this build has no publishable project to start from' } } },
    });
    const result = await runCli(['agency', 'build', '--from', 'build-1']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('this build has no publishable project to start from');
  });
});

// ---------------------------------------------------------------------------
// `od sections list|get` (sol-design.md §5 phase D row): mirrors GET /api/sections against the
// same daemon this file's other tests already stub, distinct from `od agency sections <family>`.
// ---------------------------------------------------------------------------

const INSERTABLE_ENTRY = {
  id: 'hyperui:marketing/ctas/1',
  title: 'Centered CTA',
  sourceKind: 'hyperui',
  sectionKind: 'cta-band',
  spineAffinities: 'any',
  rights: { license: 'MIT', decision: 'bundle', evidence: 'plugins/_official/shared/ui-kits/hyperui/LICENSE' },
  access: 'local',
  availability: 'insertable',
  preview: { kind: 'none' },
  content: { kind: 'vendored-block', blockId: 'marketing/ctas/1', adapterId: 'hyperui:marketing/ctas/1', sha256: 'a'.repeat(64) },
};

describe('od sections', () => {
  it('lists entries as tab-separated lines with access and availability labels', async () => {
    stub = await startStub({ sectionCatalog: { catalog: { schema: 'section-catalog/1', entries: [INSERTABLE_ENTRY] }, directions: [] } });
    const result = await runCli(['sections', 'list']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(INSERTABLE_ENTRY.id);
    expect(result.stdout).toContain('insertable');
  });

  it('--json prints the daemon response as-is', async () => {
    const body = { catalog: { schema: 'section-catalog/1', entries: [INSERTABLE_ENTRY] }, directions: [{ id: 'modern-minimal', label: 'Modern minimal' }] };
    stub = await startStub({ sectionCatalog: body });
    const result = await runCli(['sections', 'list', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(body);
  });

  it('filters with --spine and --kind as query params', async () => {
    stub = await startStub({ sectionCatalog: { catalog: { schema: 'section-catalog/1', entries: [] }, directions: [] } });
    await runCli(['sections', 'list', '--spine', 'TL', '--kind', 'cta-band']);
    const listed = stub.requests.find((request) => request.url.startsWith('/api/sections?'));
    expect(listed?.url).toContain('spine=TL');
    expect(listed?.url).toContain('kind=cta-band');
  });

  it('shows one entry\'s fields, including the "Sign in" access label for a gated entry', async () => {
    stub = await startStub({
      sectionEntry: { ...INSERTABLE_ENTRY, id: 'motionsites-prompt:9f2c', access: 'free-account' },
      motionsitesConnection: { status: 'not_connected' },
    });
    const result = await runCli(['sections', 'get', 'motionsites-prompt:9f2c']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Sign in');
    // The id (which contains ':' and '/') must reach the daemon as one encoded path segment.
    const got = stub.requests.find((request) => request.url.startsWith('/api/sections/'));
    expect(got?.url).toBe(`/api/sections/${encodeURIComponent('motionsites-prompt:9f2c')}`);
  });

  it('exits 1 with the daemon\'s message on an unknown id', async () => {
    stub = await startStub({ sectionEntry: [404] });
    const result = await runCli(['sections', 'get', 'hyperui:not-a-real-block']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no such section');
  });

  it('labels a local (bundled) entry "Bundled", matching the web picker\'s own wording (delta audit finding 6/13)', async () => {
    stub = await startStub({ sectionEntry: INSERTABLE_ENTRY }); // INSERTABLE_ENTRY.access === 'local'
    const result = await runCli(['sections', 'get', INSERTABLE_ENTRY.id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Bundled');
    expect(result.stdout).not.toContain('\t-\t');
  });

  it('never calls GET /api/motionsites/connection for a local-only entry (delta audit finding 5)', async () => {
    stub = await startStub({ sectionEntry: INSERTABLE_ENTRY });
    await runCli(['sections', 'get', INSERTABLE_ENTRY.id]);
    expect(stub.requests.some((request) => request.url === '/api/motionsites/connection')).toBe(false);
  });

  it('never calls GET /api/motionsites/connection when every listed entry is local-only (delta audit finding 5)', async () => {
    stub = await startStub({ sectionCatalog: { catalog: { schema: 'section-catalog/1', entries: [INSERTABLE_ENTRY] }, directions: [] } });
    await runCli(['sections', 'list']);
    expect(stub.requests.some((request) => request.url === '/api/motionsites/connection')).toBe(false);
  });

  it('does call GET /api/motionsites/connection when a listed entry is gated (delta audit finding 5)', async () => {
    stub = await startStub({
      sectionCatalog: { catalog: { schema: 'section-catalog/1', entries: [{ ...INSERTABLE_ENTRY, id: 'motionsites-prompt:gated-1', access: 'free-account' }] }, directions: [] },
    });
    await runCli(['sections', 'list']);
    expect(stub.requests.some((request) => request.url === '/api/motionsites/connection')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The follow itself, driven directly
// ---------------------------------------------------------------------------
//
// These two cases are about what the CLI does when the stream misbehaves, which a spawned process
// cannot be made to produce reliably. `runAgencyBuildCli` returns its exit code rather than
// calling `process.exit`, so they run in-process against a fake `fetch`.

describe('C16: od labels static prototypes', () => {
  const DASHBOARD_ROUTE = { ...ROUTED_EVENT, family: 'crm-dashboard', outputScope: 'static-prototype' };

  it('od agency build prints the static-prototype label on the route line and last', async () => {
    stub = await startStub({
      frames: [
        ['build-event', DASHBOARD_ROUTE],
        ['status', snapshot('done', { family: 'crm-dashboard', outputScope: 'static-prototype', projectId: 'project-1' })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('route: crm-dashboard (static prototype: navigation and controls are not wired)');
    const lines = result.stdout.trim().split('\n');
    expect(lines.at(-2)).toBe('done — project project-1');
    expect(lines.at(-1)).toBe('static prototype: navigation and controls are not wired');
  });

  it('od agency build prints no label for a site family', async () => {
    stub = await startStub({ frames: [['build-event', ROUTED_EVENT], ['status', snapshot('done', { family: 'wrenfield', outputScope: 'site', projectId: 'project-1' })]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('static prototype');
  });

  it('od agency build --json carries outputScope', async () => {
    const final = snapshot('done', { family: 'crm-dashboard', outputScope: 'static-prototype', projectId: 'project-1' });
    stub = await startStub({ frames: [['build-event', DASHBOARD_ROUTE], ['status', final]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).outputScope).toBe('static-prototype');
  });

  const FAMILIES = {
    families: [
      { family: 'marketing-site', pageKind: 'site', outputScope: 'site' },
      { family: 'crm-dashboard', pageKind: 'dashboard', outputScope: 'static-prototype' },
      { family: 'app-shell', pageKind: 'app', outputScope: 'static-prototype' },
    ],
  };

  it('od agency families prints each family\'s page kind and output scope', async () => {
    stub = await startStub({ families: FAMILIES });
    const result = await runCli(['agency', 'families']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'marketing-site\tsite\tsite',
      'crm-dashboard\tdashboard\tstatic prototype: navigation and controls are not wired',
      'app-shell\tapp\tstatic prototype: navigation and controls are not wired',
    ]);
  });

  it('od agency families --json prints the daemon response', async () => {
    stub = await startStub({ families: FAMILIES });
    const result = await runCli(['agency', 'families', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(FAMILIES);
  });

  it.each([
    ['no families array', { builds: [] }, 'expected a families array'],
    ['a bad outputScope', { families: [{ family: 'app-shell', pageKind: 'app', outputScope: 'working-app' }] }, 'invalid outputScope'],
    ['a bad pageKind', { families: [{ family: 'app-shell', pageKind: 'widget', outputScope: 'static-prototype' }] }, 'invalid pageKind'],
  ])('od agency families exits nonzero on a malformed response: %s', async (_name, body, reason) => {
    stub = await startStub({ families: body });
    for (const args of [['agency', 'families'], ['agency', 'families', '--json']]) {
      const result = await runCli(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('od agency families: malformed response from the daemon');
      expect(result.stderr).toContain(reason);
    }
  });

  it('od agency sections prints the static-prototype label for an app family', async () => {
    stub = await startStub({ sections: { family: 'app-shell', outputScope: 'static-prototype', sections: [{ id: 'empty', type: 'empty-state', label: 'Empty state' }] } });
    const result = await runCli(['agency', 'sections', 'app-shell']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'app-shell: static prototype: navigation and controls are not wired',
      'empty\tempty-state\tEmpty state',
    ]);
  });

  it('od agency sections prints no label for a site family', async () => {
    stub = await startStub({ sections: { family: 'wrenfield', outputScope: 'site', sections: [] } });
    const result = await runCli(['agency', 'sections', 'wrenfield']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('static prototype');
    expect(result.stdout.trim()).toBe('wrenfield has no optional sections');
  });
});

describe('runAgencyBuildCli', () => {
  const lines = () => ({ out: [] as string[], err: [] as string[] });

  /** A `fetch` that answers the start and then streams `body` as the event source. */
  function fakeFetch(
    body: string,
    options: { hold?: boolean; hangCancel?: boolean; rejectCancelAfterMs?: number } = {},
  ): { impl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const impl = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/agency/build')) {
        return new Response(JSON.stringify({ build: QUEUED }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/cancel')) {
        // A daemon that took the cancel and then died: the socket drops after the caller has
        // already given up waiting, so the rejection lands on an abandoned promise.
        if (options.rejectCancelAfterMs !== undefined) {
          return await new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error('socket hang up')), options.rejectCancelAfterMs);
          });
        }
        // A daemon that took the cancel and then stopped answering.
        if (options.hangCancel) return await new Promise<Response>(() => {});
        return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } });
      }
      // The stream. `hold` never ends it, which is what an unanswering daemon looks like.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (body) controller.enqueue(new TextEncoder().encode(body));
          if (!options.hold) controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    return { impl, calls };
  }

  it('ends the follow with one fixed line when a frame cannot be read', async () => {
    const { impl } = fakeFetch('event: status\ndata: {"id": broken\n\n');
    const streams = lines();
    const code = await runAgencyBuildCli({ brief: BRIEF }, {
      baseUrl: 'http://127.0.0.1:1',
      brief: BRIEF,
      stdout: (line) => streams.out.push(line),
      stderr: (line) => streams.err.push(line),
      onInterrupt: () => {},
      fetchImpl: impl,
    });

    expect(code).toBe(1);
    expect(streams.err).toEqual(['the build stream sent a frame this command could not read']);
  });

  it('stops waiting for a cancelled build the daemon never confirms', async () => {
    const { impl, calls } = fakeFetch('', { hold: true });
    const streams = lines();
    let interrupt = () => {};
    const run = runAgencyBuildCli({ brief: BRIEF }, {
      baseUrl: 'http://127.0.0.1:1',
      brief: BRIEF,
      stdout: (line) => streams.out.push(line),
      stderr: (line) => streams.err.push(line),
      onInterrupt: (handler) => { interrupt = handler; },
      fetchImpl: impl,
      cancelTimeoutMs: 40,
    });
    // Let the start and the stream request land, then press Ctrl-C.
    await new Promise((resolve) => setTimeout(resolve, 20));
    interrupt();

    const code = await run;
    expect(code).toBe(4);
    expect(streams.err).toEqual(['the build was cancelled, but the daemon did not confirm it stopped']);
    expect(calls.some((call) => call.startsWith('POST') && call.endsWith('/cancel'))).toBe(true);
  });

  it('does not hold the shell on a cancel the daemon never answers', async () => {
    // The stream ends properly, so the confirm wait never fires — but the cancel POST hangs. The
    // command still has to come back, and within the same bound.
    const { impl } = fakeFetch(`event: status\ndata: ${JSON.stringify(snapshot('cancelled'))}\n\n`, { hangCancel: true });
    const streams = lines();
    let interrupt = () => {};
    const started = Date.now();
    const code = await runAgencyBuildCli({ brief: BRIEF }, {
      baseUrl: 'http://127.0.0.1:1',
      brief: BRIEF,
      stdout: (line) => streams.out.push(line),
      stderr: (line) => streams.err.push(line),
      onInterrupt: (handler) => { interrupt = handler; setTimeout(handler, 0); },
      fetchImpl: impl,
      cancelTimeoutMs: 40,
    });
    void interrupt;

    expect(code).toBe(4);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(streams.out).toEqual(['cancelled']);
  });

  it('still exits 4 when the abandoned cancel request rejects after the timeout', async () => {
    // The confirm wait gives up first, so the cancel promise is left unawaited. Its rejection
    // must be swallowed at the call site: an unhandled rejection would replace the cancellation
    // the person asked for with a crash and a code of Node's choosing.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { impl } = fakeFetch('', { hold: true, rejectCancelAfterMs: 60 });
      const streams = lines();
      const code = await runAgencyBuildCli({ brief: BRIEF }, {
        baseUrl: 'http://127.0.0.1:1',
        brief: BRIEF,
        stdout: (line) => streams.out.push(line),
        stderr: (line) => streams.err.push(line),
        onInterrupt: (handler) => { setTimeout(handler, 0); },
        fetchImpl: impl,
        cancelTimeoutMs: 20,
      });

      expect(code).toBe(4);
      expect(streams.err).toEqual(['the build was cancelled, but the daemon did not confirm it stopped']);
      // Let the abandoned rejection land, then check nothing escaped.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('od agency build --agui', () => {
  const AGUI_FRAMES: Array<[string, unknown]> = [
    ['message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' }],
    ['message', { type: 'STATE_SNAPSHOT', snapshot: { input: { briefChars: BRIEF.length } } }],
    ['message', { type: 'STEP_STARTED', stepName: 'route' }],
    ['message', { type: 'STEP_FINISHED', stepName: 'route' }],
    ['message', { type: 'CUSTOM', name: 'od.agency-build.event', value: ROUTED_EVENT }],
    ['message', { type: 'RUN_FINISHED', threadId: 'agency-build:build-1', runId: 'build-1', result: { status: 'done', projectId: 'project-1' } }],
  ];

  it('follows the AG-UI stream and prints one event per line', async () => {
    stub = await startStub({ frames: AGUI_FRAMES });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--agui']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      'RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED', 'STEP_FINISHED', 'CUSTOM', 'RUN_FINISHED',
    ]);
    expect(stub.requests.map((request) => request.url)).toEqual(['/api/agency/build', '/api/agency/builds/build-1/agui']);
  });

  it('exits 1 on RUN_ERROR and 3 on an unrouted RUN_FINISHED', async () => {
    stub = await startStub({ frames: [AGUI_FRAMES[0]!, ['message', { type: 'RUN_ERROR', message: 'the build failed', code: 'BUILD_FAILED' }]] });
    const lines: string[] = [];
    const failed = await runAgencyBuildCli({ agui: true }, {
      baseUrl: stub.baseUrl,
      brief: BRIEF,
      stdout: (line) => lines.push(line),
      stderr: () => {},
      onInterrupt: () => {},
    });
    expect(failed).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'RUN_ERROR', code: 'BUILD_FAILED' });
    await stub.close();

    stub = await startStub({ frames: [AGUI_FRAMES[0]!, ['message', { type: 'RUN_FINISHED', threadId: 't', runId: 'build-1', result: { status: 'unrouted' } }]] });
    const unrouted = await runAgencyBuildCli({ agui: true }, {
      baseUrl: stub.baseUrl,
      brief: BRIEF,
      stdout: () => {},
      stderr: () => {},
      onInterrupt: () => {},
    });
    expect(unrouted).toBe(3);
  });

  it('fails when the stream ends without a terminal event', async () => {
    stub = await startStub({ frames: [AGUI_FRAMES[0]!] });
    const errors: string[] = [];
    const code = await runAgencyBuildCli({ agui: true }, {
      baseUrl: stub.baseUrl,
      brief: BRIEF,
      stdout: () => {},
      stderr: (line) => errors.push(line),
      onInterrupt: () => {},
    });
    expect(code).toBe(1);
    expect(errors).toEqual(['the build stream ended before the build did']);
  });

  it.each([['--json'], ['--no-wait']])('refuses --agui with %s before starting anything', async (flag) => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--agui', flag]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--agui cannot be combined with --json or --no-wait');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('od agency build failure lines', () => {
  it('prints the route, the failing step and the failure detail a failed build record carries', () => {
    const base = { id: 'b1', events: [], startedAt: '2026-09-24T00:00:00.000Z', route: { decision: 'routed' as const, spine: 'SM', family: 'listings', probability: 0.97 } };
    expect(failureLines({
      ...base,
      status: 'failed',
      error: { code: 'BUILD_FAILED', message: 'the build failed' },
      failure: { step: 'building', unit: 'listings-inquiry', reason: 'invalid', slot: 'sections[8].text.phone', lastError: 'listings-inquiry: the family compiler refused the filled unit at sections[8].text.phone (expected a phone number)' },
    })).toEqual([
      'route: spine SM, family listings p=0.97',
      'failed at: building',
      'last error: listings-inquiry: the family compiler refused the filled unit at sections[8].text.phone (expected a phone number)',
    ]);
    expect(failureLines({
      ...base,
      status: 'failed',
      error: { code: 'VERIFY_FAILED', message: 'x' },
      failure: { step: 'verifying', flaggedSlots: ['sections[4].items[0].date', 'sections[2].text.price'] },
    })).toEqual([
      'route: spine SM, family listings p=0.97',
      'failed at: verifying',
      'flagged slots: sections[4].items[0].date, sections[2].text.price',
    ]);
    expect(failureLines({ ...base, status: 'done' })).toEqual([]);
  });

  it('names the spine the family was admitted from beside the top spine', () => {
    expect(failureLines({
      id: 'b2', events: [], startedAt: '2026-09-24T00:00:00.000Z', status: 'failed',
      route: { decision: 'routed', spine: 'TL', viaSpine: 'SM', family: 'listings', probability: 0.97 },
      error: { code: 'VERIFY_FAILED', message: 'x' },
      failure: { step: 'verifying' },
    })[0]).toBe('route: spine TL, family listings via SM p=0.97');
  });
});

describe('od agency build --composition', () => {
  // As the daemon serves it: Cult blocks by public id (tests/agency-build-composition.test.ts).
  const COMPOSED = { requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:marketing/sections/1', 'cult:bento-gradient', 'cult:cta-cosmic'], source: 'jev' };

  it('sends --composition and --provider, and prints the chosen blocks in order', async () => {
    stub = await startStub({
      frames: [
        ['build-event', { seq: 1, at: '2026-09-20T10:00:01.000Z', type: 'composition', ms: 700, composition: COMPOSED }],
        ['status', snapshot('done', { family: 'composed', projectId: 'project-1', composition: COMPOSED })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'blocks', '--provider', 'cerebras']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('composition: blocks (PA, tech-utility): hyperui:marketing/sections/1, cult:bento-gradient, cult:cta-cosmic');
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'auto', verify: 'strict', composition: 'blocks', provider: 'cerebras' });
  });

  it('prints the served public Cult ids with --json', async () => {
    const overlay = { entryId: 'cult:pricing-series-v', directionId: 'modern-minimal', placement: { mode: 'append', afterSectionId: 'hero' }, flagged: [], remaining: [] };
    stub = await startStub({
      frames: [['status', snapshot('done', { family: 'composed', projectId: 'project-1', composition: COMPOSED, sectionOverlay: overlay })]],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'blocks', '--json']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cult:pricing-series-v');
    expect(result.stdout).toContain('cult:bento-gradient');
    expect(result.stdout).not.toMatch(/cult:marketing-/);
  });

  it('prints a family fallback with its fixed code', async () => {
    stub = await startStub({
      frames: [
        ['build-event', { seq: 1, at: '2026-09-20T10:00:01.000Z', type: 'composition', ms: 5, composition: { requested: 'auto', used: 'family', fallback: 'no-coverage' } }],
        ['status', snapshot('done', { family: 'wrenfield' })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'auto']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('composition: family route (fallback: no-coverage)');
  });

  it('sends --design-system as designSystemId and says whether the kit was applied', async () => {
    const kit = { id: 'user:atlas-beyond-tl03', title: 'Atlas TL.03', applied: true };
    stub = await startStub({
      frames: [
        ['build-event', { seq: 1, at: '2026-09-20T10:00:01.000Z', type: 'composition', ms: 700, composition: { ...COMPOSED, requested: 'auto', designKit: kit } }],
        ['status', snapshot('done', { family: 'composed', projectId: 'project-1', composition: { ...COMPOSED, requested: 'auto', designKit: kit } })],
      ],
    });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--design-system', 'user:atlas-beyond-tl03']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('design kit Atlas TL.03 applied');
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'auto', verify: 'strict', designSystemId: 'user:atlas-beyond-tl03' });
  });

  it('refuses --design-system with --composition family, --section or --from, without reaching the daemon', async () => {
    stub = await startStub({ frames: [] });
    for (const extra of [['--composition', 'family'], ['--section', 'cult:cta-cosmic', '--after', 'hero', '--direction', 'modern-minimal'], ['--from', 'build-1']]) {
      const result = await runCli(['agency', 'build', '--brief', BRIEF, '--design-system', 'user:atlas-beyond-tl03', ...extra]);
      expect(result.code, extra.join(' ')).toBe(2);
      expect(result.stderr, extra.join(' ')).toContain('--design-system');
    }
    expect(stub.requests.some((request) => request.url === '/api/agency/build')).toBe(false);
  });

  it('--json carries the composition decision on the final snapshot', async () => {
    const final = snapshot('done', { family: 'composed', projectId: 'project-1', composition: COMPOSED });
    stub = await startStub({ frames: [['status', final]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'blocks', '--json']);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { composition?: unknown }).composition).toEqual(COMPOSED);
  });

  it('refuses a bad composition, blocks with --section, and --provider with --from, without reaching the daemon', async () => {
    stub = await startStub();
    const bad = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'pages']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--composition must be one of family, blocks, auto');
    const mixed = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', 'blocks', '--section', 'hyperui:marketing/ctas/1', '--after', 'hero', '--direction', 'modern-minimal']);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('--composition blocks|auto cannot be combined with --section');
    const provider = await runCli(['agency', 'build', '--brief', BRIEF, '--provider', 'openai']);
    expect(provider.code).toBe(2);
    expect(provider.stderr).toContain('--provider must be one of deepseek, cerebras');
    const fork = await runCli(['agency', 'build', '--from', 'build-1', '--provider', 'deepseek']);
    expect(fork.code).toBe(2);
    for (const composition of ['blocks', 'auto']) {
      for (const verify of ['advisory', 'after', 'off']) {
        const unchecked = await runCli(['agency', 'build', '--brief', BRIEF, '--composition', composition, '--verify', verify]);
        expect(unchecked.code).toBe(2);
        expect(unchecked.stderr).toContain('--verify must be strict');
      }
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('--from with --composition sends it as the fork\'s override', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--from', 'build-1', '--composition', 'family']);
    expect(result.code).toBe(0);
    const fork = stub.requests.find((request) => request.method === 'POST' && request.url.endsWith('/fork'));
    expect(JSON.parse(fork!.body)).toEqual({ composition: 'family' });
  });
});

describe('od agency build --no-failover', () => {
  it('sends failover: false on the request', async () => {
    stub = await startStub({ frames: [['status', snapshot('done', { failover: false })]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--no-failover']);
    expect(result.code).toBe(0);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).toEqual({ brief: BRIEF, family: 'auto', verify: 'strict', failover: false });
  });

  it('omits failover entirely when not given, so the daemon\'s own default (true) applies', async () => {
    stub = await startStub({ frames: [['status', snapshot('done')]] });
    const result = await runCli(['agency', 'build', '--brief', BRIEF]);
    expect(result.code).toBe(0);
    const started = stub.requests.find((request) => request.url === '/api/agency/build');
    expect(JSON.parse(started!.body)).not.toHaveProperty('failover');
  });

  it('refuses --no-failover combined with --from: a fork keeps the saved build\'s setting', async () => {
    stub = await startStub();
    const result = await runCli(['agency', 'build', '--from', 'build-1', '--no-failover']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--no-failover cannot be combined with --from');
    expect(stub.requests).toHaveLength(0);
  });
});
