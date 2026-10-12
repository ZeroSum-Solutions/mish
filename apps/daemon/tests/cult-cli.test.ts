// `od cult list|get` — the CLI half of the dual-track rule for GET /api/cult/catalog.
//
// Same shape as catalog-cli.test.ts: spawn the CLI against a stub HTTP server that answers the
// route's real envelope, and assert the request, the output and the exit code.

import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { CultCatalogItem, CultCatalogListResponse } from '@open-design/contracts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

function item(id: string, overrides: Partial<CultCatalogItem> = {}): CultCatalogItem {
  return {
    id,
    slug: id.replace(/^cult:/, ''),
    displayTitle: 'Pricing (series V)',
    summary: 'Series V pricing section.',
    assetKind: 'section',
    sourceCategory: 'marketing-pricing',
    tags: ['pricing'],
    sectionKind: 'pricing',
    spineAffinities: ['TL'],
    state: 'needs-adaptation',
    dependencies: { motion: true, canvas: false, webgl: false, server: false, packages: 2 },
    bytes: 4096,
    preview: { kind: 'none' },
    provenance: { snapshotId: 'cult-ui-pro@abc' },
    ...overrides,
  };
}

const ITEMS = [
  item('cult:pricing-series-v'),
  item('cult:ai-chat', { displayTitle: 'AI Chat', assetKind: 'app', sectionKind: 'unclassified', state: 'app-only', stateReason: 'application behavior', spineAffinities: [] }),
  item('cult:organic-button', { displayTitle: 'Organic Button', assetKind: 'primitive', sectionKind: 'unclassified', state: 'pending', bytes: null, portQueue: 'genui-port' }),
  item('cult:marketing-hero-simple', {
    displayTitle: 'Hero\tSimple',
    sectionKind: 'hero',
    state: 'not-converted',
    stateReason: 'converter\trefused:\noversized\r\nsecond line',
    dependencies: { motion: false, canvas: true, webgl: true, server: false, packages: 0 },
  }),
];

function listBody(items: CultCatalogItem[]): CultCatalogListResponse {
  return { catalog: { schema: 'cult-catalog/1', snapshot: { id: 'cult-ui-pro@abc', expectedItems: 3, fetchedItems: 2, pendingItems: 1 }, items } };
}

let server: http.Server | null = null;
let requests: string[] = [];

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  requests = [];
});

async function startStub(listOverride?: unknown): Promise<string> {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/api/cult/catalog') {
      if (listOverride !== undefined) return res.end(JSON.stringify(listOverride));
      const kind = url.searchParams.get('kind');
      const state = url.searchParams.get('state');
      return res.end(JSON.stringify(listBody(ITEMS.filter((entry) =>
        (!kind || entry.assetKind === kind) && (!state || entry.state === state)))));
    }
    const match = url.pathname.match(/^\/api\/cult\/catalog\/(.+)$/);
    const found = match ? ITEMS.find((entry) => entry.id === decodeURIComponent(match[1]!)) : undefined;
    if (found) return res.end(JSON.stringify({ item: found }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no Cult catalog item' } }));
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

describe('od cult list', () => {
  it('GETs /api/cult/catalog and prints one line per item with the honest state', async () => {
    const base = await startStub();
    const result = await runCli(['cult', 'list', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/cult/catalog']);
    expect(result.stdout).toContain('pricing-series-v\tNeeds adaptation\tsection\tpricing\tPricing (series V)');
    expect(result.stdout).toContain('ai-chat\tApp only\tapp');
    expect(result.stdout).toContain('organic-button\tPending\tprimitive');
    expect(result.stdout).toContain('marketing-hero-simple\tNot converted yet\tsection\thero\tHero Simple\n');
    expect(result.stdout).not.toContain('cult:');
    expect(result.stdout).toContain('[cult] 4 items (1 needs adaptation, 1 app only, 1 pending, 1 not converted yet)');
    // One line per item plus the summary: no daemon text can add a line or a column.
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines.slice(0, 4)) expect(line.split('\t')).toHaveLength(5);
  });

  it('passes --kind and --state and prints JSON with --json', async () => {
    const base = await startStub();
    const result = await runCli(['cult', 'list', '--kind', 'app', '--state', 'app-only', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/cult/catalog?kind=app&state=app-only']);
    const body = JSON.parse(result.stdout) as CultCatalogListResponse;
    expect(body.catalog.items.map((entry) => entry.id)).toEqual(['cult:ai-chat']);
  });

  it('rejects an unknown --kind or --state locally with exit 2', async () => {
    const base = await startStub();
    const kind = await runCli(['cult', 'list', '--kind', 'widget', '--daemon-url', base]);
    expect(kind.code).toBe(2);
    expect(kind.stderr).toContain('--kind must be one of section, page, primitive, app, blocks, components');
    const state = await runCli(['cult', 'list', '--state', 'adapter-needed', '--daemon-url', base]);
    expect(state.code).toBe(2);
    expect(state.stderr).toContain('--state must be one of insertable, needs-adaptation, not-converted, app-only, pending');
    expect(requests).toEqual([]);
  });

  it('exits 1 on a malformed response', async () => {
    const base = await startStub({ catalog: { schema: 'cult-catalog/1', items: [] } });
    const result = await runCli(['cult', 'list', '--daemon-url', base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[cult] malformed response from /api/cult/catalog:');
  });
});

describe('od cult get', () => {
  it('prints one item', async () => {
    const base = await startStub();
    const result = await runCli(['cult', 'get', 'cult:organic-button', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual([`GET /api/cult/catalog/${encodeURIComponent('cult:organic-button')}`]);
    expect(result.stdout).toContain('Slug\torganic-button');
    expect(result.stdout).toContain('Title\tOrganic Button');
    expect(result.stdout).toContain('State\tPending');
    expect(result.stdout).toContain('Port queue\tgenui-port');
    expect(result.stdout).toContain('Needs\tmotion (2 packages)');
  });

  it('keeps a multi-line, tabbed reason on its one State line and lists every dependency flag', async () => {
    const base = await startStub();
    const result = await runCli(['cult', 'get', 'cult:marketing-hero-simple', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Title\tHero Simple\n');
    expect(result.stdout).toContain('State\tNot converted yet (converter refused: oversized second line)\n');
    expect(result.stdout).toContain('Needs\tcanvas, webgl (0 packages)');
    for (const line of result.stdout.trim().split('\n')) expect(line.split('\t')).toHaveLength(2);
  });

  it('prints JSON with --json', async () => {
    const base = await startStub();
    const result = await runCli(['cult', 'get', 'cult:ai-chat', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { item: CultCatalogItem }).item.state).toBe('app-only');
  });

  it('fails for an unknown id and exits 2 without one', async () => {
    const base = await startStub();
    const missing = await runCli(['cult', 'get', 'cult:nope', '--daemon-url', base]);
    expect(missing.code).not.toBe(0);
    const usage = await runCli(['cult', 'get', '--daemon-url', base]);
    expect(usage.code).toBe(2);
  });
});

describe('od cult help', () => {
  it('prints usage for "od cult help" and exits 2 with no arguments', async () => {
    const help = await runCli(['cult', 'help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('od cult list');
    expect(help.stdout).toContain('od cult get <slug>');
    const bare = await runCli(['cult']);
    expect(bare.code).toBe(2);
  });
});

describe('od cult add (dispatch)', () => {
  it('routes to the copy command: usage without --into, help lists it, and a daemon 404 fails', async () => {
    const usage = await runCli(['cult', 'add', 'pricing-series-v']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Usage: od cult add <slug...> --into <projectDir>');
    const help = await runCli(['cult', 'help']);
    expect(help.stdout).toContain('od cult add <slug...> --into <projectDir>');
    const base = await startStub();
    const missing = await runCli(['cult', 'add', 'cult:nope', '--into', DAEMON_ROOT, '--daemon-url', base]);
    expect(missing.code).not.toBe(0);
    expect(requests).toEqual(['GET /api/cult/r/nope.json']);
  });
});

describe('od cult show (dispatch)', () => {
  it('reads GET /api/cult/copy/:id and exits 2 without an id', async () => {
    const base = await startStub();
    const missing = await runCli(['cult', 'show', 'cult:nope', '--file', 'a.tsx', '--daemon-url', base]);
    expect(missing.code).not.toBe(0);
    expect(requests).toEqual(['GET /api/cult/copy/cult%3Anope?file=a.tsx']);
    const usage = await runCli(['cult', 'show']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Usage: od cult show <slug>');
  });
});
