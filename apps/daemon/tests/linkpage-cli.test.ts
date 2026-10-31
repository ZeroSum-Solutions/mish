// `od linkpage …` against a fake fetch: the request each subcommand builds, what it prints, and the
// code it exits with. Files and stdin are injected, so nothing touches the disk or the network.

import { execFile } from 'node:child_process';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { runLinkpageCli } from '../src/linkpage-cli.js';

interface Call { method: string; url: string; body: unknown; contentType?: string }

function harness(answers: Array<{ status: number; body: unknown }>, config = '') {
  const calls: Call[] = [];
  const written: Array<{ dir: string; rel: string; text: string }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const contentType = (init.headers as Record<string, string> | undefined)?.['content-type'];
    calls.push({ method: String(init.method), url: url.href, body: init.body instanceof Uint8Array ? init.body : init.body ? JSON.parse(String(init.body)) : undefined, ...(contentType ? { contentType } : {}) });
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  const options = {
    resolveBaseUrl: async (daemonUrl: string | undefined) => daemonUrl ?? 'http://127.0.0.1:7456',
    fetchImpl,
    readConfig: async (source: string) => {
      if (source === 'missing.json') throw new Error('ENOENT');
      return config;
    },
    readBinary: async (file: string) => {
      if (file === 'missing.png') throw new Error('ENOENT');
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    writeFile: async (dir: string, rel: string, bytes: Buffer) => { written.push({ dir, rel, text: bytes.toString('utf8') }); },
  };
  return { calls, written, run: (args: string[]) => runLinkpageCli(args, options) };
}

const REQUEST = JSON.stringify({ slug: 'sam', sources: [{ connector: 'website', ref: 'https://example.com' }] });
const SPEC = { slug: 'sam', profile: { name: 'Sam', headline: 'Potter' }, blocks: [{}] };

describe('od linkpage', () => {
  it('prints help and usage', async () => {
    const h = harness([]);
    expect((await h.run([])).stdout).toMatch(/od linkpage build --config/);
    expect((await h.run(['--help'])).code).toBe(0);
    const bad = await h.run(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown command/);
    expect(h.calls).toEqual([]);
  });

  it('build posts the checked config and prints a summary with warnings and login needs', async () => {
    const h = harness([{ status: 200, body: { spec: SPEC, saved: true, warnings: ['no model'], needs: [{ platform: 'instagram', why: 'Sign in' }] } }], REQUEST);
    const res = await h.run(['build', '--config', 'req.json']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('Built sam: Sam (saved)\n  warning: no model\n  login: instagram: Sign in\n');
    expect(h.calls[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:7456/api/linkpages/build', body: { slug: 'sam' } });
  });

  it('build reads the config from stdin with - and prints JSON with --json', async () => {
    const h = harness([{ status: 200, body: { spec: SPEC, saved: true, warnings: [], needs: [] } }], REQUEST);
    const res = await h.run(['build', '--config', '-', '--json']);
    expect(JSON.parse(res.stdout).spec.slug).toBe('sam');
  });

  it('build refuses an unreadable, non-JSON or invalid config without calling the daemon', async () => {
    expect((await harness([], '').run(['build', '--config', 'missing.json'])).code).toBe(1);
    expect((await harness([], 'not json').run(['build', '--config', 'x'])).stderr).toMatch(/not valid JSON/);
    const invalid = await harness([], JSON.stringify({ slug: '../x', sources: [] })).run(['build', '--config', 'x']);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toMatch(/slug/);
    expect((await harness([]).run(['build'])).code).toBe(2);
  });

  it('shows the daemon error message and fails with 1', async () => {
    const h = harness([{ status: 502, body: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'nothing could be read' } } }], REQUEST);
    const res = await h.run(['build', '--config', 'x']);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/nothing could be read/);
  });

  it('list, get and delete use the matching endpoints', async () => {
    const h = harness([
      { status: 200, body: { pages: [{ slug: 'sam', name: 'Sam', headline: '', updatedAt: '2026-10-30T00:00:00.000Z' }] } },
      { status: 200, body: { pages: [] } },
      { status: 200, body: { page: { slug: 'sam', spec: SPEC, updatedAt: 'now' } } },
      { status: 200, body: { slug: 'sam', deleted: true } },
    ]);
    expect((await h.run(['list'])).stdout).toBe('sam\tSam\t2026-10-30T00:00:00.000Z\n');
    expect((await h.run(['list'])).stdout).toBe('No link pages yet.\n');
    expect((await h.run(['get', 'sam'])).stdout).toMatch(/sam: Sam\nPotter\n1 blocks/);
    expect((await h.run(['delete', 'sam'])).stdout).toBe('Deleted sam\n');
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/linkpages', 'GET /api/linkpages', 'GET /api/linkpages/sam', 'DELETE /api/linkpages/sam',
    ]);
    expect((await h.run(['get', '../x'])).code).toBe(2);
    expect((await h.run(['get'])).code).toBe(2);
  });

  it('render writes the exported files into --out and passes --origin', async () => {
    const h = harness([{ status: 200, body: { slug: 'sam', files: [
      { path: 'index.html', contentType: 'text/html', encoding: 'utf8', content: '<html>' },
      { path: 'assets/avatar.png', contentType: 'image/png', encoding: 'base64', content: 'AQID' },
    ] } }]);
    const res = await h.run(['render', 'sam', '--out', 'site', '--origin', 'https://links.example.com']);
    expect(res.code).toBe(0);
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:7456/api/linkpages/sam/export?origin=https%3A%2F%2Flinks.example.com');
    expect(h.written.map((w) => [w.dir, w.rel])).toEqual([['site', 'index.html'], ['site', 'assets/avatar.png']]);
    expect(res.stdout).toMatch(/Wrote 2 files to site/);
    expect((await h.run(['render', 'sam'])).code).toBe(2);
  });

  it('render refuses a file path that would leave the output folder', async () => {
    const h = harness([{ status: 200, body: { slug: 'sam', files: [{ path: '../evil.html', contentType: 'text/html', encoding: 'utf8', content: 'x' }] } }]);
    const res = await h.run(['render', 'sam', '--out', 'site']);
    expect(res.code).toBe(1);
    expect(h.written).toEqual([]);
  });

  it('asset sends the picture as a raw body with its type and prints the path to use', async () => {
    const h = harness([{ status: 200, body: { slug: 'sam', name: 'me.png', path: 'assets/me.png', contentType: 'image/png', bytes: 4 } }]);
    const res = await h.run(['asset', 'sam', '/tmp/photos/me.png']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/assets\/me\.png/);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', url: 'http://127.0.0.1:7456/api/linkpages/sam/assets/me.png', contentType: 'image/png' });
    expect(Buffer.from(h.calls[0]!.body as Uint8Array)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('asset refuses a missing file, a non-picture and a name that is not safe', async () => {
    const h = harness([]);
    expect((await h.run(['asset', 'sam', 'missing.png'])).code).toBe(1);
    expect((await h.run(['asset', 'sam', 'notes.txt'])).code).toBe(2);
    expect((await h.run(['asset', 'sam', 'a.png', '--name', '../x.png'])).code).toBe(2);
    expect((await h.run(['asset', 'sam'])).code).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('publish posts origin and track base and lists the files', async () => {
    const h = harness([{ status: 200, body: { slug: 'sam', published: false, url: 'https://links.example.com/sam', files: ['index.html', 'llms.txt'], publishedAt: 'now' } }]);
    const res = await h.run(['publish', 'sam', '--origin', 'https://links.example.com/x', '--track-base', 'https://t.example.com/go']);
    expect(res.stdout).toMatch(/2 files ready to deploy at https:\/\/links\.example\.com\/sam \(not published/);
    expect(h.calls[0]).toMatchObject({ method: 'POST', body: { origin: 'https://links.example.com', trackBase: 'https://t.example.com/go' } });
    expect((await h.run(['publish', 'sam', '--origin', 'javascript:x'])).code).toBe(2);
  });

  it('only talks to a local daemon', async () => {
    const h = harness([]);
    const res = await h.run(['list', '--daemon-url', 'https://evil.example.com']);
    expect(res.code).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('od linkpage registration', () => {
  it('is reachable through the real CLI entry point (SUBCOMMAND_MAP)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tsx = pathResolve(here, '../../../node_modules/tsx/dist/cli.mjs');
    const { stdout } = await promisify(execFile)(process.execPath, [tsx, pathResolve(here, '../src/cli.ts'), 'linkpage', '--help'], { timeout: 60_000 });
    expect(stdout).toMatch(/od linkpage build --config <file\|->/);
  }, 90_000);
});
