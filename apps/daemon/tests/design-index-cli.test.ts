// `od agency route` and `od design-index …` — the CLI half of the dual-track rule
// (docs/plans/2026-09-19-design-index-app-wiring-design.md section 6).
//
// Same shape as project-cli.test.ts: spawn the CLI against a stub HTTP server and assert the
// request path, method and body, plus the exit code. The stub answers the same envelopes the
// daemon's real routes do, so a drift in the request the CLI builds shows up here rather than
// against a running daemon.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

let stub: StubServer | null = null;
let tempRoot = '';

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

const ROUTED = {
  decision: 'routed',
  spine: { code: 'TL', name: 'Trust Ladder', confidence: 0.82, probabilities: { TL: 0.82 } },
  spines: [{ code: 'TL', probability: 0.82 }],
  archetype: { id: 'TL-1', name: 'Local service', confidence: 0.7 },
  skin: { choice: 'Editorial', confidence: 0.6 },
  family: { id: 'wrenfield', probability: 0.71, basis: 'exact', transfer: 3 },
  candidates: [],
  warnings: [],
  ms: 610,
  calls: 1,
  model: 'jev-1.13.0',
};

const UNROUTED = {
  decision: 'unrouted',
  reason: 'no bundled family within transfer >= 2 of spine CS',
  spine: { code: 'CS', name: 'Catalog Scan', confidence: 0.64, probabilities: { CS: 0.64 } },
  spines: [{ code: 'CS', probability: 0.64 }],
  skin: { choice: 'unspecified', confidence: 0.3 },
  candidates: [],
  warnings: [],
  ms: 590,
  calls: 1,
  model: 'jev-1.13.0',
};

const PROFILE = {
  schema: 'design-profile/1',
  taxonomy: '1.0',
  model: 'jev-1.13.0',
  at: '2026-09-01T00:00:00.000Z',
  ms: 620,
  calls: 1,
  source: { kind: 'html', id: 'page-1', title: 'Riverbend', chars: 42, digest: 'd-one' },
  route: {
    spine: { choice: 'TL', confidence: 0.8, probabilities: { TL: 0.8 } },
    archetype: { choice: 'TL-1', confidence: 0.7, probabilities: { 'TL-1': 0.7 } },
    skin: { choice: 'Editorial', confidence: 0.6, probabilities: { Editorial: 0.6 } },
    format: { choice: 'Landing page', confidence: 0.6, probabilities: {} },
    action: { choice: 'book', confidence: 0.6, probabilities: {} },
    family: { choice: 'wrenfield', confidence: 0.7, probabilities: {} },
    resolved: { archetypeId: 'TL-1', familyId: 'wrenfield' },
  },
  sections: { hero: 0.95, footer: 0.9, pricing: 0.8, faq: 0.2 },
  components: {},
  mechanics: {},
  depth: {},
  style: {
    ground: { choice: 'near-black', confidence: 0.9, probabilities: {} },
    accent: { choice: 'unspecified', confidence: 0.5, probabilities: {} },
    typography: { choice: 'unspecified', confidence: 0.5, probabilities: {} },
    imagery: { choice: 'unspecified', confidence: 0.5, probabilities: {} },
    topology: { choice: 'bento-grid', confidence: 0.6, probabilities: {} },
    density: { choice: 'unspecified', confidence: 0.5, probabilities: {} },
  },
  quality: {},
  truthRisk: 0.1,
};

/** Answers the design-index and agency routes; `routeBody` swaps the routed/unrouted decision. */
async function startDesignIndexStubServer(routeBody: unknown = ROUTED): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let added = 0;
  let jevConfig = { configured: false, source: 'unset' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = { method: req.method ?? '', url: req.url ?? '', body: raw };
      requests.push(captured);
      res.setHeader('content-type', 'application/json');
      const path = captured.url.split('?')[0];

      if (path === '/api/agency/config' && (captured.method === 'GET' || captured.method === 'PUT')) {
        res.statusCode = 200;
        if (captured.method === 'GET') {
          res.end(JSON.stringify(jevConfig));
          return;
        }
        const body = raw ? JSON.parse(raw) : {};
        jevConfig = body.clear === true
          ? { configured: false, source: 'unset' }
          : { configured: true, source: 'stored' };
        res.end(JSON.stringify(jevConfig));
        return;
      }
      if (captured.method === 'POST' && path === '/api/agency/route') {
        res.statusCode = 200;
        res.end(JSON.stringify({ decision: routeBody }));
        return;
      }
      if (captured.method === 'GET' && path === '/api/design-index/taxonomy') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          taxonomy: {
            version: '1.0',
            sections: [{ id: 'hero', definition: 'the first screen' }],
            components: [], mechanics: [], depth: [], action: [],
            style: { ground: [{ id: 'near-black', definition: 'a near-black ground' }] },
            quality: [],
            truthRisk: { id: 'truth-risk', instructions: 'i', criteriaTrue: 't', criteriaFalse: 'f' },
          },
        }));
        return;
      }
      if (captured.method === 'POST' && path === '/api/design-index/profile') {
        const body = raw ? JSON.parse(raw) : {};
        res.statusCode = 200;
        res.end(JSON.stringify({ profile: PROFILE, added: body.add === true }));
        return;
      }
      if (captured.method === 'POST' && path === '/api/design-index') {
        const body = raw ? JSON.parse(raw) : {};
        // Mirrors the daemon: the first store of a digest is added, a repeat is skipped unless
        // the request asked for a replace, and `added` and `replaced` never both hold.
        const isNew = body.profile?.source?.digest !== 'd-duplicate';
        if (isNew) added += 1;
        const replaced = !isNew && body.replace === true;
        res.statusCode = 200;
        res.end(JSON.stringify({ profile: body.profile, added: isNew, replaced, total: added }));
        return;
      }
      if (captured.method === 'GET' && path === '/api/design-index') {
        res.statusCode = 200;
        if (captured.url.includes('text=large')) {
          // Well past the 64 KiB pipe buffer: 40 profiles with a 2 KiB note each.
          const note = 'n'.repeat(2048);
          const profiles = Array.from({ length: 40 }, (_, i) => ({
            ...PROFILE,
            source: { ...PROFILE.source, id: `page-${i}`, digest: `d-${i}` },
            meta: { note },
          }));
          res.end(JSON.stringify({ profiles, matched: profiles.length, total: profiles.length }));
          return;
        }
        res.end(JSON.stringify({ profiles: [PROFILE], matched: 1, total: 3 }));
        return;
      }
      if (captured.method === 'GET' && path === '/api/design-index/d-one') {
        res.statusCode = 200;
        res.end(JSON.stringify({ profile: PROFILE }));
        return;
      }
      if (captured.method === 'DELETE' && path === '/api/design-index/d-one') {
        res.statusCode = 200;
        res.end(JSON.stringify({ removed: true, total: 0 }));
        return;
      }
      if (captured.method === 'GET' && path === '/api/design-index/missing') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'profile not found' } }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'unexpected-request', message: captured.url } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
    cwd: DAEMON_ROOT,
    env,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stdin !== undefined) {
    child.child.stdin?.end(stdin);
  }
  try {
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od agency route', () => {
  it('POSTs the brief and exits 0 when a family covers it', async () => {
    stub = await startDesignIndexStubServer(ROUTED);

    const result = await runCli([
      'agency', 'route', '--brief', 'A family dental practice in Riverbend.',
      '--threshold', '0.6', '--min-transfer', '1', '--spine-share', '0.4',
      '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Spine\tTL Trust Ladder');
    expect(result.stdout).toContain('Family\twrenfield');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: '/api/agency/route' });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      brief: 'A family dental practice in Riverbend.',
      threshold: 0.6,
      minTransfer: 1,
      spineShare: 0.4,
    });
  });

  it('exits 3 on an unrouted brief while still printing the spine, archetype and reason', async () => {
    stub = await startDesignIndexStubServer(UNROUTED);

    const result = await runCli(['agency', 'route', '--brief', 'A tool catalogue.', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(3);
    expect(result.stdout).toContain('Spine\tCS Catalog Scan');
    expect(result.stdout).toContain('Archetype\tnone');
    expect(result.stdout).toContain('Family\tno family yet');
    expect(result.stdout).toContain('Reason\tno bundled family');
  });

  it('exits 3 on an unrouted brief with --json too, so a script need not parse stdout', async () => {
    stub = await startDesignIndexStubServer(UNROUTED);

    const result = await runCli(['agency', 'route', '--brief', 'A tool catalogue.', '--json', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ decision: UNROUTED });
  });

  it('reads the brief from a file through --prompt-file', async () => {
    stub = await startDesignIndexStubServer(ROUTED);
    tempRoot = mkdtempSync(join(tmpdir(), 'od-design-index-cli-'));
    const briefPath = join(tempRoot, 'brief.md');
    writeFileSync(briefPath, '# Riverbend Dental\n\nA family practice.\n', 'utf8');

    const result = await runCli(['agency', 'route', '--prompt-file', briefPath, '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ brief: '# Riverbend Dental\n\nA family practice.\n' });
  });

  it('reads the brief from stdin through --prompt-file -', async () => {
    stub = await startDesignIndexStubServer(ROUTED);

    const result = await runCli(
      ['agency', 'route', '--prompt-file', '-', '--daemon-url', stub.baseUrl],
      'A brief piped in from a heredoc.\n',
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ brief: 'A brief piped in from a heredoc.\n' });
  });

  it('exits 2 without a brief and never calls the daemon', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['agency', 'route', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('od agency route');
    expect(stub.requests).toHaveLength(0);
  });

  it('exits 2 on an out-of-range --threshold', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['agency', 'route', '--brief', 'x', '--threshold', '3', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--threshold');
    expect(stub.requests).toHaveLength(0);
  });

  it('documents the command under --help and in the top-level help', async () => {
    const agencyHelp = await runCli(['agency', 'help']);
    expect(agencyHelp.code).toBe(0);
    expect(agencyHelp.stdout).toContain('od agency route');
    expect(agencyHelp.stdout).toContain('--prompt-file <path|->');

    const rootHelp = await runCli(['--help']);
    expect(rootHelp.stdout).toContain('od agency route');
    expect(rootHelp.stdout).toContain('od design-index <taxonomy|profile|add|import|find|list|get|remove>');
  });
});

describe('od agency config', () => {
  // The whole point of the subcommand is that a key can be set from a terminal without the key
  // ever appearing anywhere it could be read back: not in argv, not in stdout, not in a shell
  // history. Every assertion here is about that, not about the HTTP plumbing.
  const KEY = 'sk-typesafe-NEVER-IN-OUTPUT';

  it('prints the status without the key, in text and in --json', async () => {
    stub = await startDesignIndexStubServer();

    const text = await runCli(['agency', 'config', 'status', '--daemon-url', stub.baseUrl]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Jev\tnot configured');

    const json = await runCli(['agency', 'config', 'status', '--json', '--daemon-url', stub.baseUrl]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ configured: false, source: 'unset' });
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/agency/config',
      'GET /api/agency/config',
    ]);
  });

  it('reads the key from stdin, sends it once, and prints nothing of it', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(
      ['agency', 'config', 'set', '--key-stdin', '--daemon-url', stub.baseUrl],
      `${KEY}\n`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(KEY);
    expect(result.stderr).not.toContain(KEY);
    expect(result.stdout).toContain('Jev\tconfigured');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'PUT', url: '/api/agency/config' });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ apiKey: KEY });

    const status = await runCli(['agency', 'config', 'status', '--json', '--daemon-url', stub.baseUrl]);
    expect(JSON.parse(status.stdout)).toEqual({ configured: true, source: 'stored' });
  });

  it('refuses a key passed on argv, where a shell history would keep it', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['agency', 'config', 'set', '--key', KEY, '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--key-stdin');
    expect(result.stderr).not.toContain(KEY);
    expect(result.stdout).not.toContain(KEY);
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses an empty stdin rather than storing a blank key', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['agency', 'config', 'set', '--key-stdin', '--daemon-url', stub.baseUrl], '\n');

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });

  it('clears the stored key', async () => {
    stub = await startDesignIndexStubServer();
    await runCli(['agency', 'config', 'set', '--key-stdin', '--daemon-url', stub.baseUrl], `${KEY}\n`);

    const result = await runCli(['agency', 'config', 'clear', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Jev\tnot configured');
    expect(JSON.parse(stub.requests[1]!.body)).toEqual({ clear: true });
  });

  it('rejects an unknown config subcommand with a usage error', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['agency', 'config', 'rotate', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('od design-index', () => {
  it('prints the taxonomy', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'taxonomy', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Version\t1.0');
    expect(result.stdout).toContain('sections\thero');
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: '/api/design-index/taxonomy' });
  });

  it('profiles a page read from stdin and stores it with --add', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(
      ['design-index', 'profile', '--kind', 'html', '--prompt-file', '-', '--title', 'Riverbend',
       '--ref', 'https://example.test/', '--id', 'page-1', '--add', '--daemon-url', stub.baseUrl],
      '<html><body><h1>Book a visit</h1></body></html>',
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Stored\tyes');
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: '/api/design-index/profile' });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      kind: 'html',
      input: '<html><body><h1>Book a visit</h1></body></html>',
      add: true,
      title: 'Riverbend',
      ref: 'https://example.test/',
      id: 'page-1',
    });
  });

  it('profiles without --add and reports that nothing was stored', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'profile', '--input', 'A near-black hero.', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Stored\tno');
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ kind: 'prompt', input: 'A near-black hero.' });
  });

  it('exits 2 on an unknown --kind', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'profile', '--kind', 'pdf', '--input', 'x', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--kind must be one of');
    expect(stub.requests).toHaveLength(0);
  });

  it('adds one stored profile from a file', async () => {
    stub = await startDesignIndexStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-design-index-cli-'));
    const profilePath = join(tempRoot, 'profile.json');
    writeFileSync(profilePath, JSON.stringify(PROFILE), 'utf8');

    const result = await runCli(['design-index', 'add', profilePath, '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('added d-one');
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: '/api/design-index' });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ profile: PROFILE });
  });

  it('sends replace only when --replace is given, and reports the replacement', async () => {
    stub = await startDesignIndexStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-design-index-cli-'));
    const profilePath = join(tempRoot, 'profile.json');
    const alreadyStored = { ...PROFILE, source: { ...PROFILE.source, digest: 'd-duplicate' } };
    writeFileSync(profilePath, JSON.stringify(alreadyStored), 'utf8');

    const skipped = await runCli(['design-index', 'add', profilePath, '--daemon-url', stub.baseUrl]);
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toContain('already stored d-duplicate');
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ profile: alreadyStored });

    const result = await runCli(['design-index', 'add', profilePath, '--replace', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('replaced d-duplicate');
    expect(JSON.parse(stub.requests[1]!.body)).toEqual({ profile: alreadyStored, replace: true });
  });

  it('imports an exported index and prints the added and skipped counts', async () => {
    stub = await startDesignIndexStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-design-index-cli-'));
    const indexPath = join(tempRoot, 'design-index.json');
    writeFileSync(indexPath, JSON.stringify({
      schema: 'design-index/1',
      profiles: [
        PROFILE,
        { ...PROFILE, source: { ...PROFILE.source, digest: 'd-two' } },
        { ...PROFILE, source: { ...PROFILE.source, digest: 'd-duplicate' } },
      ],
    }), 'utf8');

    const result = await runCli(['design-index', 'import', indexPath, '--json', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ added: 2, replaced: 0, skipped: 1 });
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests.every((request) => request.method === 'POST' && request.url === '/api/design-index')).toBe(true);
    expect(stub.requests.every((request) => JSON.parse(request.body).replace === undefined)).toBe(true);
  });

  it('imports with --replace, counting the overwritten profile as replaced rather than skipped', async () => {
    stub = await startDesignIndexStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-design-index-cli-'));
    const indexPath = join(tempRoot, 'design-index.json');
    writeFileSync(indexPath, JSON.stringify({
      schema: 'design-index/1',
      profiles: [
        PROFILE,
        { ...PROFILE, source: { ...PROFILE.source, digest: 'd-two' } },
        { ...PROFILE, source: { ...PROFILE.source, digest: 'd-duplicate' } },
      ],
    }), 'utf8');

    const result = await runCli(['design-index', 'import', indexPath, '--replace', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[design-index] added 2, replaced 1, skipped 0;');
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests.every((request) => JSON.parse(request.body).replace === true)).toBe(true);
  });

  it('builds a find query with repeated facets and scalar filters', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli([
      'design-index', 'find',
      '--section', 'hero', '--section', 'footer',
      '--component', 'card-grid',
      '--ground', 'near-black', '--topology', 'bento-grid',
      '--min', '0.6', '--limit', '10',
      '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1 of 3');
    expect(result.stdout).toContain('Riverbend\thtml\tTL\tTL-1\twrenfield\thero, footer, pricing');
    expect(stub.requests[0]!.method).toBe('GET');
    expect(stub.requests[0]!.url).toBe(
      '/api/design-index?section=hero&section=footer&component=card-grid&ground=near-black&topology=bento-grid&min=0.6&limit=10',
    );
  });

  it('lists with no filters at all', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'list', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(stub.requests[0]!.url).toBe('/api/design-index');
  });

  it('writes a --json payload larger than the 64 KiB pipe buffer in full before exiting', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'find', '--text', 'large', '--json', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    const parsed = JSON.parse(result.stdout) as { profiles: unknown[]; total: number };
    expect(parsed.profiles).toHaveLength(40);
    expect(parsed.total).toBe(40);
  });

  it('exits 2 on an out-of-range --limit', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'list', '--limit', '900', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--limit');
    expect(stub.requests).toHaveLength(0);
  });

  it('gets one profile by digest', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'get', 'd-one', '--json', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ profile: PROFILE });
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: '/api/design-index/d-one' });
  });

  it('exits 1 with the daemon error envelope for an unknown digest', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'get', 'missing', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('removes one profile by digest', async () => {
    stub = await startDesignIndexStubServer();

    const result = await runCli(['design-index', 'remove', 'd-one', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('removed d-one');
    expect(stub.requests[0]).toMatchObject({ method: 'DELETE', url: '/api/design-index/d-one' });
  });

  it('exits 2 on an unknown subcommand and prints the help', async () => {
    const result = await runCli(['design-index', 'nonsense']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown subcommand: od design-index nonsense');
    expect(result.stdout).toContain('od design-index taxonomy');
  });

  it('documents --replace on add and import', async () => {
    const help = await runCli(['design-index', 'help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('od design-index add <profile.json> [--replace] [--json]');
    expect(help.stdout).toContain('od design-index import <design-index.json> [--replace] [--json]');
    expect(help.stdout).toContain('--replace');
  });
});
