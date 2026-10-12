// P1-2 spec 2: `od pack` driven through runPackCli against the real
// /api/packs routes on a real port (no spawned process), with synthetic packs.

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { sendApiError } from '../../src/http/api-errors.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';
import { PackGithubAccessError, type PackGithubAccess } from '../../src/integrations/github-auth.js';
import { readPackManifestFile } from '../../src/packs/manifest.js';
import { runPackCli, type PackCliOptions } from '../../src/packs/pack-cli.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { createPackService } from '../../src/packs/service.js';
import { createPacksJsonParser, registerPackRoutes, type RegisterPackRoutesDeps } from '../../src/routes/packs.js';
import { FIXTURE_PACK_ID, sha256Hex, tarFixturePack, writeFixturePack, writeSidecar } from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createSseResponse(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders?.();
  return {
    send(event: string, data: unknown) {
      if (res.writableEnded) return false;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

function fakeAccess() {
  let source: 'stored' | 'none' = 'none';
  const stored: string[] = [];
  const access: Pick<PackGithubAccess, 'status' | 'storePastedToken' | 'clearStoredToken'> = {
    async status() {
      return source === 'stored' ? { configured: true, source } : { configured: false, source: 'none' };
    },
    async storePastedToken(token) {
      if (!/^gh[pousr]_[A-Za-z0-9]{36,}$|^github_pat_/.test(token)) throw new PackGithubAccessError('INVALID_TOKEN_FORMAT');
      stored.push(token);
      source = 'stored';
    },
    async clearStoredToken() {
      stored.length = 0;
      source = 'none';
    },
  };
  return { access, stored };
}

interface Harness {
  baseUrl: string;
  requests: { method: string; url: string; body: string | null }[];
  stored: string[];
  run: (args: string[], options?: Partial<PackCliOptions>) => ReturnType<typeof runPackCli>;
}

async function mount(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-cli-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry });
  const { access, stored } = fakeAccess();
  const app = express();
  // server.ts order: the pack JSON parser, then the global one.
  app.use('/api/packs', createPacksJsonParser());
  app.use(express.json({ limit: '4mb' }));
  registerPackRoutes(app, {
    http: { sendApiError, requireLocalDaemonRequest, createSseResponse } as unknown as RegisterPackRoutesDeps['http'],
    packs: service,
    githubAccess: access,
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requests: Harness['requests'] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    requests.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null });
    return fetch(input, init);
  };
  return {
    baseUrl,
    requests,
    stored,
    run: (args, options = {}) => runPackCli(args, { resolveBaseUrl: async () => baseUrl, fetchImpl, ...options }),
  };
}

async function fixtureArchive() {
  const pack = writeFixturePack();
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir);
  cleanup.push(path.dirname(archivePath));
  writeSidecar(archivePath);
  return { ...pack, archivePath };
}

describe('od pack (P1-2 spec 2)', () => {
  it('install resolves a relative path against the CLI cwd before POST; --json prints {ok, result, events}', async () => {
    const h = await mount();
    const fixture = await fixtureArchive();
    const result = await h.run(['install', path.basename(fixture.archivePath), '--json'], { cwd: path.dirname(fixture.archivePath) });
    expect(result.code).toBe(0);
    const posted = h.requests.find((request) => request.url.endsWith('/api/packs/install'));
    expect(JSON.parse(posted!.body!)).toEqual({ source: fixture.archivePath });
    const printed = JSON.parse(result.stdout);
    expect(printed.ok).toBe(true);
    expect(printed.result).toMatchObject({ outcome: 'installed', pack: { id: FIXTURE_PACK_ID, version: '1.0.0' } });
    expect(printed.events.at(-1).event).toBe('success');
    expect(printed.events.slice(0, -1).every((event: { event: string }) => event.event === 'progress')).toBe(true);
  });

  it('list --json equals GET /api/packs byte-for-byte', async () => {
    const h = await mount();
    const fixture = await fixtureArchive();
    expect((await h.run(['install', fixture.archivePath])).code).toBe(0);
    const direct = await (await fetch(`${h.baseUrl}/api/packs`)).text();
    const listed = await h.run(['list', '--json']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe(`${direct}\n`);
    const human = await h.run(['list']);
    expect(human.stdout).toContain(FIXTURE_PACK_ID);
    expect(human.stdout).toContain('1.0.0');
  });

  it('remove without an id exits 2; remove <id> --json prints the daemon JSON and the pack is gone', async () => {
    const h = await mount();
    expect((await h.run(['remove'])).code).toBe(2);
    const fixture = await fixtureArchive();
    await h.run(['install', fixture.archivePath]);
    const removed = await h.run(['remove', FIXTURE_PACK_ID, '--json']);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ ok: true, id: FIXTURE_PACK_ID, removedVersion: '1.0.0' });
    const again = await h.run(['remove', FIXTURE_PACK_ID, '--json']);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout).error.code).toBe('PACK_NOT_FOUND');
  });

  it('auth set reads the token from stdin and refuses --token or a positional token with exit 2', async () => {
    const h = await mount();
    const token = `ghp_${'Q'.repeat(36)}`;
    const readStdin = async () => `${token}\n`;

    for (const args of [['auth', 'set', '--token', token], ['auth', 'set', `--token=${token}`], ['auth', 'set', token], ['auth', 'set', '--stdin', token]]) {
      const refused = await h.run(args, { readStdin });
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.stdout + refused.stderr).not.toContain(token);
    }
    expect(h.stored).toEqual([]);
    expect(h.requests.filter((request) => request.method === 'POST')).toEqual([]);

    const saved = await h.run(['auth', 'set', '--stdin', '--json'], { readStdin });
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.stdout)).toEqual({ configured: true, source: 'stored' });
    expect(h.stored).toEqual([token]);
    const posted = h.requests.filter((request) => request.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).not.toContain(token);
    expect(JSON.parse(posted[0]!.body!)).toEqual({ token });

    const status = await h.run(['auth', 'status']);
    expect(status.stdout).toMatch(/stored/);
    expect(status.stdout + status.stderr).not.toContain(token);

    const invalid = await h.run(['auth', 'set', '--stdin'], { readStdin: async () => 'definitely-not-a-token\n' });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('INVALID_TOKEN_FORMAT');
    expect(invalid.stdout + invalid.stderr).not.toContain('definitely-not-a-token');

    const empty = await h.run(['auth', 'set', '--stdin'], { readStdin: async () => '  \n' });
    expect(empty.code).toBe(2);

    const cleared = await h.run(['auth', 'clear', '--json']);
    expect(JSON.parse(cleared.stdout)).toEqual({ configured: false, source: 'none' });
  });

  it('refuses a missing local path and a local path aimed at a non-loopback daemon with exit 2, before any request', async () => {
    const h = await mount();
    const missing = await h.run(['install', 'nowhere/pack.tgz'], { cwd: tmpdir() });
    expect(missing.code).toBe(2);
    const fixture = await fixtureArchive();
    const remote = await h.run(['install', fixture.archivePath], { resolveBaseUrl: async () => 'http://10.0.0.5:7456' });
    expect(remote.code).toBe(2);
    expect(remote.stderr).toMatch(/copy the archive/i);
    expect(h.requests).toEqual([]);
  });

  it('passes github: sources and --sha256 through, and exits 1 with the code on an install error', async () => {
    const h = await mount();
    const github = await h.run(['install', 'github:example-org/team-pack@1.0.0', '--json']);
    expect(github.code).toBe(1);
    expect(JSON.parse(h.requests.at(-1)!.body!)).toEqual({ source: 'github:example-org/team-pack@1.0.0' });
    expect(JSON.parse(github.stdout)).toMatchObject({ ok: false, result: { code: 'SOURCE_UNSUPPORTED' } });

    const fixture = await fixtureArchive();
    const wrong = await h.run(['install', fixture.archivePath, '--sha256', 'e'.repeat(64)]);
    expect(wrong.code).toBe(1);
    expect(JSON.parse(h.requests.at(-1)!.body!)).toEqual({ source: fixture.archivePath, sha256: 'e'.repeat(64) });
    expect(wrong.stderr).toContain('INTEGRITY_MISMATCH');

    const malformed = await h.run(['install', fixture.archivePath, '--sha256', 'xyz']);
    expect(malformed.code).toBe(2);

    const folder = await h.run(['install', fixture.dir]);
    expect(folder.code).toBe(1);
    expect(folder.stderr).toContain('DIGEST_REQUIRED');
  });

  it('prints help and exits 2 with no arguments, 0 with --help; rejects unknown subcommands and flags', async () => {
    const h = await mount();
    const bare = await h.run([]);
    expect(bare.code).toBe(2);
    expect(bare.stdout).toContain('od pack install');
    expect(bare.stdout).toContain('@version');
    expect((await h.run(['--help'])).code).toBe(0);
    expect((await h.run(['frobnicate'])).code).toBe(2);
    expect((await h.run(['list', '--bogus'])).code).toBe(2);
  });

  it('human install output names phases and the result, never a URL', async () => {
    const h = await mount();
    const fixture = await fixtureArchive();
    const result = await h.run(['install', fixture.archivePath, '--force']);
    expect(result.code).toBe(0);
    expect(JSON.parse(h.requests.at(-1)!.body!)).toEqual({ source: fixture.archivePath, force: true });
    expect(result.stdout).toMatch(/verifying/);
    expect(result.stdout).toContain(`${FIXTURE_PACK_ID}@1.0.0`);
    expect(result.stdout + result.stderr).not.toMatch(/https?:\/\//);
    expect(readFileSync(fixture.archivePath).length).toBeGreaterThan(0);
  });
});

// Team drop-in QA (2026-10-08): a teammate who builds their own pack folder
// has no way to get the folder digest. It is the sha256 of the canonical
// pack.json, not of the file bytes, so `shasum pack.json` fails closed.
describe('od pack digest: the sha256 a local install needs', () => {
  const offline: Partial<PackCliOptions> = {
    resolveBaseUrl: async () => {
      throw new Error('od pack digest must not need the daemon');
    },
    fetchImpl: async () => {
      throw new Error('od pack digest must not send a request');
    },
  };

  it('prints the folder digest the daemon checks, which a folder install then accepts', async () => {
    const h = await mount();
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const expected = readPackManifestFile(path.join(pack.dir, 'pack.json')).digest;
    expect(expected).not.toBe(pack.manifestSha256);

    const digest = await h.run(['digest', path.basename(pack.dir)], { ...offline, cwd: path.dirname(pack.dir) });
    expect(digest.code).toBe(0);
    expect(digest.stdout).toBe(`${expected}\n`);
    expect(digest.stderr).toContain(`od pack install ${path.basename(pack.dir)} --sha256 ${expected}`);

    const installed = await h.run(['install', pack.dir, '--sha256', digest.stdout.trim()]);
    expect(installed.code).toBe(0);
  });

  it('prints the archive file sha256 (the .sha256 sidecar value) for a .tgz; --json names the kind', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const archivePath = await tarFixturePack(pack.dir);
    cleanup.push(path.dirname(archivePath));
    const fileSha = sha256Hex(readFileSync(archivePath));

    const human = await runPackCli(['digest', archivePath], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline });
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(`${fileSha}\n`);
    expect(human.stderr).toContain('.sha256');

    const asJson = await runPackCli(['digest', archivePath, '--json'], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline });
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.stdout)).toEqual({ ok: true, kind: 'archive', sha256: fileSha });
  });

  it('names every listed file that no longer matches pack.json, prints no digest and exits 1', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const edited = pack.manifest.files[0]!;
    appendFileSync(path.join(pack.dir, ...edited.path.split('/')), '// edited after pack.json was written\n');

    const result = await runPackCli(['digest', pack.dir], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`files[0] ${edited.path}`);
    expect(result.stderr).toMatch(/update files\[\] in pack\.json/);

    const asJson = await runPackCli(['digest', pack.dir, '--json'], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline });
    expect(asJson.code).toBe(1);
    const printed = JSON.parse(asJson.stdout);
    expect(printed).toMatchObject({ ok: false, kind: 'folder', id: FIXTURE_PACK_ID, version: '1.0.0' });
    expect(printed.mismatches).toEqual([
      expect.objectContaining({ index: 0, path: edited.path, expectedBytes: edited.bytes, expectedSha256: edited.sha256 }),
    ]);
  });

  it('reports an invalid pack.json with its field paths, and a missing path or no argument with exit 2', async () => {
    const pack = writeFixturePack({ mutate: (manifest) => ({ ...manifest, version: '1.0' }) });
    cleanup.push(pack.dir);
    const invalid = await runPackCli(['digest', pack.dir], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('INVALID_MANIFEST');
    expect(invalid.stderr).toContain('version');

    expect((await runPackCli(['digest'], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline })).code).toBe(2);
    expect((await runPackCli(['digest', 'nowhere'], { resolveBaseUrl: async () => 'http://127.0.0.1:1', ...offline, cwd: tmpdir() })).code).toBe(2);
  });

  it('install points at od pack digest when a local sha256 is missing or does not match', async () => {
    const h = await mount();
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const name = path.basename(pack.dir);

    const missing = await h.run(['install', name], { cwd: path.dirname(pack.dir) });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('DIGEST_REQUIRED');
    expect(missing.stderr).toContain(`od pack digest ${name}`);
    // The daemon's own line names the command too: there is no "pack build" for a teammate's folder.
    const daemonLine = missing.stderr.split('\n')[0]!;
    expect(daemonLine).toContain('od pack digest');
    expect(daemonLine).not.toContain('pack build');

    const wrong = await h.run(['install', name, '--sha256', pack.manifestSha256], { cwd: path.dirname(pack.dir) });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('INTEGRITY_MISMATCH');
    expect(wrong.stderr).toContain(`od pack digest ${name}`);
    expect(wrong.stderr.split('\n')[0]).toContain('od pack digest');
    const jsonWrong = await h.run(['install', name, '--sha256', pack.manifestSha256, '--json'], { cwd: path.dirname(pack.dir) });
    expect(JSON.parse(jsonWrong.stdout).result.message).toContain('od pack digest');
  });

  it('an empty od pack list tells a teammate how to install their own folder or .tgz', async () => {
    const h = await mount();
    const empty = await h.run(['list']);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('od pack install <folder | path.tgz> --sha256 <hex>');
    expect(empty.stdout).toContain('od pack digest');
  });

  it('names no default pack repository: help and the empty list show a github:<owner>/<repo>@<version> form', async () => {
    const h = await mount();
    const help = await h.run(['--help']);
    const empty = await h.run(['list']);
    for (const text of [help.stdout, empty.stdout]) {
      expect(text).not.toContain('mishh-licensed');
      expect(text).toContain('github:<owner>/<repo>@<version>');
    }
    expect((await h.run(['install'])).code).toBe(2);
  });

  it('lists od pack digest in the usage text', async () => {
    const help = await runPackCli(['--help'], { resolveBaseUrl: async () => 'http://127.0.0.1:1' });
    expect(help.stdout).toContain('od pack digest <folder | path.tgz>');
  });
});

// FU-15 (Sol WARNs on PR #213): od pack digest must refuse what a folder or
// archive install refuses, and fail with valid output instead of a raw fs error.
describe('FU-15: od pack digest fails the way install fails, with sanitized output', () => {
  const offline: PackCliOptions = {
    resolveBaseUrl: async () => {
      throw new Error('od pack digest must not need the daemon');
    },
    fetchImpl: async () => {
      throw new Error('od pack digest must not send a request');
    },
  };
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('W1: a subfolder that links outside the pack fails INVALID_ARCHIVE, exactly like install', async () => {
    const h = await mount();
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const outside = mkdtempSync(path.join(tmpdir(), 'od-pack-outside-'));
    cleanup.push(outside);
    renameSync(path.join(pack.dir, 'kits/demo/registry'), path.join(outside, 'registry'));
    symlinkSync(path.join(outside, 'registry'), path.join(pack.dir, 'kits/demo/registry'), 'dir');
    const folderDigest = readPackManifestFile(path.join(pack.dir, 'pack.json')).digest;

    const installed = await h.run(['install', pack.dir, '--sha256', folderDigest, '--json']);
    expect(installed.code).toBe(1);
    const installFailure = JSON.parse(installed.stdout).result;
    expect(installFailure.code).toBe('INVALID_ARCHIVE');

    const digest = await runPackCli(['digest', pack.dir, '--json'], offline);
    expect(digest.code).toBe(1);
    expect(JSON.parse(digest.stdout)).toEqual({ ok: false, kind: 'folder', code: installFailure.code, message: installFailure.message });

    const human = await runPackCli(['digest', pack.dir], offline);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('INVALID_ARCHIVE');
  });

  it.skipIf(asRoot)('W2: an unreadable (chmod 000) .tgz fails with valid JSON, exit 1 and no absolute path', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const archivePath = await tarFixturePack(pack.dir);
    cleanup.push(path.dirname(archivePath));
    chmodSync(archivePath, 0o000);

    const asJson = await runPackCli(['digest', archivePath, '--json'], offline);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: false, kind: 'archive', code: expect.any(String), message: expect.any(String) });
    expect(asJson.stdout + asJson.stderr).not.toContain(path.dirname(archivePath));

    const human = await runPackCli(['digest', archivePath], offline);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/could not be read/);
    expect(human.stderr).not.toContain(path.dirname(archivePath));
  });

  it.skipIf(asRoot)('W2: an unreadable (chmod 000) listed file fails with valid JSON, exit 1 and no absolute path', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    chmodSync(path.join(pack.dir, ...pack.manifest.files[0]!.path.split('/')), 0o000);

    const asJson = await runPackCli(['digest', pack.dir, '--json'], offline);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: false, kind: 'folder', code: expect.any(String), message: expect.any(String) });
    expect(asJson.stdout + asJson.stderr).not.toContain(pack.dir);

    const human = await runPackCli(['digest', pack.dir], offline);
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(/could not be read/);
    expect(human.stderr).not.toContain(pack.dir);
  });

  it('W3: a FIFO fails fast as not a pack folder or archive', { timeout: 5000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-pack-fifo-'));
    cleanup.push(dir);
    const fifo = path.join(dir, 'pack.tgz');
    execFileSync('mkfifo', [fifo]);

    const asJson = await runPackCli(['digest', fifo, '--json'], offline);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: false, message: expect.stringMatching(/not a pack folder or archive/) });
  });

  it('W3: /dev/null is not a pack folder or archive and gets no digest', async () => {
    const human = await runPackCli(['digest', '/dev/null'], offline);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/not a pack folder or archive/);

    const asJson = await runPackCli(['digest', '/dev/null', '--json'], offline);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: false, message: expect.stringMatching(/not a pack folder or archive/) });
  });
});

describe('Sol hold (PR #191, BLOCK 1): the token never leaves for a host the CLI did not vet', () => {
  async function stub(handler: http.RequestListener): Promise<{ url: string; bodies: string[] }> {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        bodies.push(`${req.method} ${req.url} ${body}`);
        handler(req, res);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
  }

  it('auth set and auth clear refuse a 307 redirect: the redirect target never receives the token and the CLI exits non-zero', async () => {
    const token = `ghp_${'R'.repeat(36)}`;
    const target = await stub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ configured: true, source: 'stored' }));
    });
    const daemon = await stub((_req, res) => {
      res.writeHead(307, { location: `${target.url}/api/packs/github-access` });
      res.end();
    });
    const set = await runPackCli(['auth', 'set', '--stdin'], {
      resolveBaseUrl: async () => daemon.url,
      readStdin: async () => `${token}\n`,
    });
    expect(set.code).not.toBe(0);
    expect(set.stdout + set.stderr).not.toContain(token);
    expect(daemon.bodies).toHaveLength(1);
    expect(target.bodies).toEqual([]);

    const clear = await runPackCli(['auth', 'clear'], { resolveBaseUrl: async () => daemon.url });
    expect(clear.code).not.toBe(0);
    expect(target.bodies).toEqual([]);
  });

  it('refuses a plain http:// non-loopback daemon URL with exit 2 before reading stdin or sending any request', async () => {
    const token = `ghp_${'S'.repeat(36)}`;
    for (const action of [['auth', 'set', '--stdin'], ['auth', 'clear']]) {
      let stdinRead = false;
      const requests: string[] = [];
      const result = await runPackCli(action, {
        resolveBaseUrl: async () => 'http://10.0.0.5:7456',
        readStdin: async () => {
          stdinRead = true;
          return `${token}\n`;
        },
        fetchImpl: async (input) => {
          requests.push(String(input));
          throw new Error('no request may be sent');
        },
      });
      expect(result.code, action.join(' ')).toBe(2);
      expect(result.stderr).toMatch(/loopback|https/i);
      expect(result.stdout + result.stderr).not.toContain(token);
      expect(stdinRead).toBe(false);
      expect(requests).toEqual([]);
    }
  });

  it('accepts loopback http (127.0.0.1, ::1, localhost) and any https:// daemon URL for the token, with redirect: error', async () => {
    const token = `ghp_${'T'.repeat(36)}`;
    for (const base of ['http://127.0.0.1:7456', 'http://[::1]:7456', 'http://localhost:7456', 'https://daemon.example.test']) {
      const seen: RequestInit[] = [];
      const result = await runPackCli(['auth', 'set', '--stdin'], {
        resolveBaseUrl: async () => base,
        readStdin: async () => `${token}\n`,
        fetchImpl: async (_input, init) => {
          seen.push(init ?? {});
          return new Response(JSON.stringify({ configured: true, source: 'stored' }), { status: 200 });
        },
      });
      expect(result.code, base).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.redirect).toBe('error');
    }
  });
});
