// `od catalog list|get` — the CLI half of the dual-track rule for GET /api/genui/catalog.
//
// Same shape as design-index-cli.test.ts: spawn the CLI against a stub HTTP server that answers
// the route's real envelope, and assert the request, the output and the exit code.

import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { GenuiCatalogEntry, GenuiCatalogResponse } from '@open-design/contracts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

function entry(id: string, status: 'planned' | 'ported', category: GenuiCatalogEntry['category']): GenuiCatalogEntry {
  return {
    id,
    name: id.replace(/-/g, ' '),
    category,
    source: { name: 'react-bits', component: id, license: 'MIT + Commons Clause', category: 'Animations', description: '', dependencies: '' },
    sourceUrl: `https://example.test/${id}`,
    licenceDecision: 'clean-room',
    verdict: 'keep',
    rationale: 'keep',
    tier: 1,
    tierNote: 'Tier 1',
    portDifficulty: 'Easy',
    status,
    ...(status === 'ported' ? { demo: `components/${id}/demo.html`, bytes: { js: 1200, css: 300 }, reducedMotion: 'static' as const } : {}),
  };
}

const CATALOG: GenuiCatalogResponse = {
  catalog: {
    schema: 'genui-catalog/1',
    components: [entry('glare-hover', 'ported', 'hover'), entry('shiny-text', 'ported', 'text'), entry('fluid-glass', 'planned', 'surface')],
  },
};

let server: http.Server | null = null;
let requests: string[] = [];

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  requests = [];
});

async function startStub(body: unknown = CATALOG): Promise<string> {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/genui/catalog/glare-hover/preview?reducedMotion=true') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><html><body>demo</body></html>');
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/genui/catalog') return res.end(JSON.stringify(body));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT, env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od catalog list', () => {
  it('GETs /api/genui/catalog and prints one line per entry', async () => {
    const base = await startStub();
    const result = await runCli(['catalog', 'list', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/genui/catalog']);
    expect(result.stdout).toContain('glare-hover\tported\thover\t1\tclean-room');
    expect(result.stdout).toContain('fluid-glass\tplanned\tsurface');
    expect(result.stdout).toContain('[catalog] 3 entries, 2 ported');
  });

  it('filters by status and prints JSON with --json', async () => {
    const base = await startStub();
    const result = await runCli(['catalog', 'list', '--status', 'ported', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as GenuiCatalogResponse;
    expect(body.catalog.schema).toBe('genui-catalog/1');
    expect(body.catalog.components.map((item) => item.id)).toEqual(['glare-hover', 'shiny-text']);
  });
});

describe('od catalog get', () => {
  it('prints one entry', async () => {
    const base = await startStub();
    const result = await runCli(['catalog', 'get', 'shiny-text', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Id\tshiny-text');
    expect(result.stdout).toContain('Status\tported');
    expect(result.stdout).toContain('Bytes\tjs 1200, css 300');
  });

  it('prints the entry as JSON with --json', async () => {
    const base = await startStub();
    const result = await runCli(['catalog', 'get', 'glare-hover', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { entry: GenuiCatalogEntry }).entry.id).toBe('glare-hover');
  });

  it('exits 1 for an unknown id and 2 without one', async () => {
    const base = await startStub();
    const missing = await runCli(['catalog', 'get', 'nope', '--daemon-url', base]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no entry with id "nope"');
    const usage = await runCli(['catalog', 'get', '--daemon-url', base]);
    expect(usage.code).toBe(2);
  });
});

describe('od catalog with a malformed daemon response', () => {
  it('exits 1 and names the malformed response on the stderr, for list', async () => {
    const base = await startStub({ catalog: { schema: 'genui-catalog/1', components: 'not-an-array' } });
    const result = await runCli(['catalog', 'list', '--daemon-url', base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[catalog] malformed response from /api/genui/catalog:');
    expect(result.stderr).toContain('catalog.components must be an array');
  });

  it('exits 1 and names the malformed response on the stderr, for get', async () => {
    const base = await startStub({});
    const result = await runCli(['catalog', 'get', 'glare-hover', '--daemon-url', base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[catalog] malformed response from /api/genui/catalog:');
  });
});

describe('od catalog help', () => {
  it('exits 0 and prints usage for "od catalog help"', async () => {
    const result = await runCli(['catalog', 'help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('od catalog list');
    expect(result.stdout).toContain('od catalog get <id>');
  });

  it('exits 0 and prints usage for "od catalog --help"', async () => {
    const result = await runCli(['catalog', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('od catalog list');
  });

  it('exits 2 and prints usage with no arguments', async () => {
    const result = await runCli(['catalog']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Usage:');
  });
});


describe('od catalog preview', () => {
  it('validates the live document and returns its embeddable URL as JSON', async () => {
    const base = await startStub();
    const result = await runCli(['catalog', 'preview', 'glare-hover', '--reduced-motion', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/genui/catalog/glare-hover/preview?reducedMotion=true']);
    expect(JSON.parse(result.stdout)).toEqual({ preview: {
      id: 'glare-hover', reducedMotion: true,
      url: `${base}/api/genui/catalog/glare-hover/preview?reducedMotion=true`,
    } });
  });
});
