// `od agency build --effects/--effect` and `od agency effects <family>` (Sol ruling 2026-09-25).
//
// The pure helpers are checked directly; the flag plumbing (a repeated `--effect` survives
// parseFlags, the request body carries it, `od agency effects` prints the table) is checked by
// spawning the real CLI against a stub daemon, the same way `agency-build-cli.test.ts` does.

import { execFile } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgencyEffectsResult, AgencyFamilyEffectsResponse } from '@mish/contracts';
import { effectsFromFlags, effectsLines, familyEffectsLines } from '../src/agency-build-cli.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

const OFFER: AgencyFamilyEffectsResponse = {
  family: 'marketing-site',
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: [
    { placement: 'hero-title', host: 'marketing-site-hero-heading', allow: [{ id: 'shiny-text', name: 'Shiny Text', kind: 'css-only', bytes: { js: 2341, css: 900 } }, { id: 'split-text', name: 'Split Text', kind: 'js', bytes: { js: 4714, css: 696 } }] },
    { placement: 'card-surface', host: 'marketing-site-features', allow: [] },
  ],
};

const RESULT: AgencyEffectsResult = {
  mode: 'mixed',
  applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' }],
  skipped: [{ placement: 'hero-background', componentId: 'silk', reason: 'byte-budget' }, { placement: 'cta', reason: 'none' }],
  bytesAdded: 2_000,
};

describe('effectsFromFlags', () => {
  it('reads --effects and repeated --effect into the request value', () => {
    expect(effectsFromFlags({})).toBeUndefined();
    expect(effectsFromFlags({ effects: 'off' })).toBe('off');
    expect(effectsFromFlags({ effects: 'auto' })).toBe('auto');
    expect(effectsFromFlags({}, ['hero-title=shiny-text', 'cta=none'])).toEqual({ 'hero-title': 'shiny-text', cta: 'none' });
    expect(effectsFromFlags({ effects: 'auto', effect: 'hero-title=split-text' })).toEqual({ 'hero-title': 'split-text' });
  });

  it('refuses a bad mode, a malformed assignment, an unknown placement, a clash and off with --effect', () => {
    const cases: Array<[Record<string, unknown>, string[] | undefined]> = [
      [{ effects: 'on' }, undefined],
      [{}, ['hero-title']],
      [{}, ['=shiny-text']],
      [{}, ['footer=shiny-text']],
      [{}, ['hero-title=Shiny Text']],
      [{}, ['hero-title=shiny-text', 'hero-title=split-text']],
      [{ effects: 'off' }, ['hero-title=shiny-text']],
    ];
    for (const [flags, assignments] of cases) {
      const result = effectsFromFlags(flags, assignments);
      expect(typeof result === 'object' && result !== null && 'error' in result, JSON.stringify([flags, assignments])).toBe(true);
    }
  });
});

describe('familyEffectsLines', () => {
  it('prints a header, then placement, host and each allowed id with kind and bytes', () => {
    expect(familyEffectsLines(OFFER)).toEqual([
      'marketing-site: script policy hash, at most 2 effect(s) per page',
      'placement\thost\tallowed',
      'hero-title\tmarketing-site-hero-heading\tshiny-text (css-only, js 2.3 KB, css 900 B), split-text (js, js 4.6 KB, css 696 B)',
      'card-surface\tmarketing-site-features\t-',
    ]);
  });

  it('says so in one line when the family offers nothing', () => {
    expect(familyEffectsLines({ family: 'app-shell', scriptPolicy: 'none', maxEffects: 0, placements: [] }))
      .toEqual(['app-shell offers no effect placements']);
  });
});

describe('effectsLines', () => {
  it('prints the counts, then applied and skipped placements with ids and fixed codes', () => {
    expect(effectsLines(RESULT)).toEqual([
      'effects (mixed): 1 applied, 2 skipped',
      '  applied hero-title -> shiny-text (css-only, hint)',
      '  skipped hero-background (silk): byte-budget',
      '  skipped cta: none',
    ]);
    expect(effectsLines({ ...RESULT, applied: [], skipped: [], mode: 'auto', jevSkipped: 'jev-timeout' }))
      .toEqual(['effects (auto): 0 applied, 0 skipped (auto skipped: jev-timeout)']);
    expect(effectsLines(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real CLI against a stub daemon
// ---------------------------------------------------------------------------

interface Captured { method: string; url: string; body: string }
let stub: { baseUrl: string; requests: Captured[]; close: () => Promise<void> } | null = null;

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
});

const QUEUED = { id: 'build-1', status: 'queued', events: [], startedAt: '2026-09-25T10:00:00.000Z' };
const EFFECTS_EVENT = { seq: 1, at: '2026-09-25T10:00:01.000Z', type: 'effects', ms: 420, label: '1 applied, 2 skipped' };

async function startStub(effectsBody: unknown = OFFER): Promise<void> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', url, body: raw });
      res.setHeader('content-type', 'application/json');
      if (/^\/api\/agency\/families\/[^/]+\/effects$/.test(url)) {
        res.end(JSON.stringify(effectsBody));
        return;
      }
      if (url === '/api/agency/build' || url.endsWith('/fork')) {
        res.statusCode = 202;
        res.end(JSON.stringify({ build: QUEUED }));
        return;
      }
      if (url.endsWith('/events')) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(`event: build-event\ndata: ${JSON.stringify(EFFECTS_EVENT)}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify({ ...QUEUED, status: 'done', projectId: 'project-1', effects: RESULT })}\n\n`);
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
  stub = { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

describe('od agency build --effect / --effects', () => {
  it('sends every repeated --effect, and prints the effects event and result', async () => {
    await startStub();
    const result = await runCli(['agency', 'build', '--brief', BRIEF, '--family', 'marketing-site', '--effect', 'hero-title=shiny-text', '--effect', 'cta=none']);
    expect(result.code, result.stderr).toBe(0);
    const start = stub!.requests.find((request) => request.url === '/api/agency/build')!;
    expect(JSON.parse(start.body).effects).toEqual({ 'hero-title': 'shiny-text', cta: 'none' });
    expect(result.stdout).toContain('effects: 1 applied, 2 skipped');
    expect(result.stdout).toContain('applied hero-title -> shiny-text (css-only, hint)');
    expect(result.stdout).toContain('skipped hero-background (silk): byte-budget');
  }, 60_000);

  it('sends --effects off on a fork, and refuses --effects off with --effect before any request', async () => {
    await startStub();
    const fork = await runCli(['agency', 'build', '--from', 'build-0', '--effects', 'off']);
    expect(fork.code, fork.stderr).toBe(0);
    const forkRequest = stub!.requests.find((request) => request.url.endsWith('/fork'))!;
    expect(JSON.parse(forkRequest.body).effects).toBe('off');

    const before = stub!.requests.length;
    const refused = await runCli(['agency', 'build', '--brief', BRIEF, '--effects', 'off', '--effect', 'hero-title=shiny-text']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--effects off cannot be combined with --effect');
    expect(stub!.requests.length).toBe(before);
  }, 60_000);
});

describe('od agency effects <family>', () => {
  it('prints the placement table, or the offer as JSON', async () => {
    await startStub();
    const table = await runCli(['agency', 'effects', 'marketing-site']);
    expect(table.code, table.stderr).toBe(0);
    expect(table.stdout).toContain('placement\thost\tallowed');
    expect(table.stdout).toContain('hero-title\tmarketing-site-hero-heading\tshiny-text (css-only');
    expect(stub!.requests.at(-1)!.url).toBe('/api/agency/families/marketing-site/effects');

    const json = await runCli(['agency', 'effects', 'marketing-site', '--json']);
    expect(JSON.parse(json.stdout)).toEqual(OFFER);

    // The flag before the positional: `--json` is boolean, so it takes no value and the family
    // is still the positional.
    const flagFirst = await runCli(['agency', 'effects', '--json', 'marketing-site']);
    expect(flagFirst.code, flagFirst.stderr).toBe(0);
    expect(JSON.parse(flagFirst.stdout)).toEqual(OFFER);
    expect(stub!.requests.at(-1)!.url).toBe('/api/agency/families/marketing-site/effects');
  }, 60_000);

  it('exits 1 on a malformed answer and 2 on a bad family id', async () => {
    await startStub({ family: 'marketing-site', scriptPolicy: 'sometimes', maxEffects: 2, placements: [] });
    const malformed = await runCli(['agency', 'effects', 'marketing-site']);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain('malformed response');
    const usage = await runCli(['agency', 'effects', 'Bad!']);
    expect(usage.code).toBe(2);
  }, 60_000);
});
