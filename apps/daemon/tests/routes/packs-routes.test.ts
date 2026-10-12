// P1-2 spec 1: the /api/packs routes on a bare Express app over a real
// PackService (temp data root), with synthetic fixture packs only.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parsePackGithubAccessStatus,
  parsePackListResponse,
  type PackInstallEvent,
} from '@open-design/contracts';

import { sendApiError } from '../../src/http/api-errors.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';
import { PackGithubAccessError, type PackGithubAccess } from '../../src/integrations/github-auth.js';
import { PackFetchError, type GithubPackFetcher } from '../../src/packs/github-fetcher.js';
import { packManifestDigest } from '../../src/packs/manifest.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { createPackService, type PackService } from '../../src/packs/service.js';
import { createPacksJsonParser, PACK_UPLOAD_HEADER, registerPackRoutes, type RegisterPackRoutesDeps } from '../../src/routes/packs.js';
import {
  FIXTURE_PACK_ID,
  sha256Hex,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';
import { parsePackManifest } from '@open-design/contracts';

const cleanup: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The same contract as server.ts `createSseResponse`, minus the keepalive timer. */
function createSseResponse(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders?.();
  const canWrite = () => !res.destroyed && !res.writableEnded;
  return {
    send(event: string, data: unknown) {
      if (!canWrite()) return false;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    cleanup() {},
    end() {
      if (canWrite()) res.end();
    },
  };
}

interface Harness {
  baseUrl: string;
  port: number;
  dataDir: string;
  packsDir: string;
  service: PackService;
  /** Every response body this harness saw (for the leak check). */
  bodies: string[];
}

interface MountOptions {
  githubFetcher?: GithubPackFetcher;
  githubAccess?: RegisterPackRoutesDeps['githubAccess'];
  archiveMaxBytes?: number;
}

async function mount(options: MountOptions = {}): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-routes-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry, ...(options.githubFetcher ? { githubFetcher: options.githubFetcher } : {}) });
  const app = express();
  // The daemon's real body-parser order (server.ts): the pack parser first,
  // then the global 4 MB JSON parser, then the routes, then the global
  // malformed-JSON handler.
  app.use('/api/packs', createPacksJsonParser());
  app.use(express.json({ limit: '4mb' }));
  registerPackRoutes(app, {
    http: { sendApiError, requireLocalDaemonRequest, createSseResponse } as unknown as RegisterPackRoutesDeps['http'],
    packs: service,
    ...(options.githubAccess !== undefined ? { githubAccess: options.githubAccess } : {}),
    ...(options.archiveMaxBytes !== undefined ? { archiveMaxBytes: options.archiveMaxBytes } : {}),
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((err as { type?: unknown })?.type !== 'entity.parse.failed') return next(err);
    return sendApiError(res, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, port, dataDir, packsDir, service, bodies: [] };
}

async function request(
  h: Harness,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; type: string; text: string; json: () => any }> {
  const response = await fetch(`${h.baseUrl}${pathname}`, init);
  const text = await response.text();
  h.bodies.push(text);
  return { status: response.status, type: response.headers.get('content-type') ?? '', text, json: () => JSON.parse(text) };
}

function postJson(h: Harness, pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return request(h, pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function sseEvents(text: string): PackInstallEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
      return { event, data } as PackInstallEvent;
    });
}

/** A raw request so the test controls the Origin header exactly. */
function rawRequest(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function fixtureArchive(options: FixturePackOptions = {}, sidecar = true) {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir);
  cleanup.push(path.dirname(archivePath));
  const digest = sidecar ? writeSidecar(archivePath) : sha256Hex(readFileSync(archivePath));
  return { ...pack, archivePath, digest };
}

function folderDigest(manifestBytes: Buffer): string {
  const parsed = parsePackManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (!parsed.ok) throw new Error('fixture manifest is invalid');
  return packManifestDigest(parsed.manifest);
}

function stagingFiles(h: Harness): string[] {
  const staging = path.join(h.packsDir, '.staging');
  return existsSync(staging) ? readdirSync(staging) : [];
}

function fakeAccess(initial: { configured: boolean; source: 'stored' | 'env' | 'gh-cli' | 'none' }) {
  let status = initial;
  const stored: string[] = [];
  let failWith: unknown = null;
  const access: Pick<PackGithubAccess, 'status' | 'storePastedToken' | 'clearStoredToken'> = {
    async status() {
      return status;
    },
    async storePastedToken(token) {
      if (failWith) throw failWith;
      if (!/^(ghp_|github_pat_)/.test(token)) throw new PackGithubAccessError('INVALID_TOKEN_FORMAT');
      stored.push(token);
      status = { configured: true, source: 'stored' };
    },
    async clearStoredToken() {
      if (failWith) throw failWith;
      stored.length = 0;
      status = { configured: false, source: 'none' };
    },
  };
  return { access, stored, fail: (error: unknown) => { failWith = error; } };
}

describe('pack routes (P1-2 spec 1)', () => {
  it('(a) GET /api/packs returns {packs: []} that parses with PackListResponseSchema', async () => {
    const h = await mount();
    const response = await request(h, '/api/packs');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ packs: [] });
    expect(parsePackListResponse(response.json())).toEqual({ packs: [] });
  });

  it('(b) POST /api/packs/install with an absolute .tgz path streams progress then success, and GET lists the same id, version and digest', async () => {
    const h = await mount();
    const fixture = await fixtureArchive();
    const response = await postJson(h, '/api/packs/install', { source: fixture.archivePath });
    expect(response.status).toBe(200);
    expect(response.type).toContain('text/event-stream');
    const events = sseEvents(response.text);
    expect(events.length).toBeGreaterThan(1);
    expect(events.slice(0, -1).every((event) => event.event === 'progress')).toBe(true);
    const last = events.at(-1)!;
    expect(last.event).toBe('success');
    if (last.event !== 'success') throw new Error('expected success');
    expect(last.data.outcome).toBe('installed');
    expect(last.data.pack.id).toBe(FIXTURE_PACK_ID);

    const list = parsePackListResponse((await request(h, '/api/packs')).json());
    expect(list?.packs).toHaveLength(1);
    expect(list?.packs[0]).toMatchObject({
      id: last.data.pack.id,
      version: '1.0.0',
      digest: last.data.pack.digest,
      status: 'ready',
    });
  });

  it('installs a folder with the sha256 of its pack.json, and refuses one without it (DIGEST_REQUIRED)', async () => {
    const h = await mount();
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const missing = await postJson(h, '/api/packs/install', { source: pack.dir });
    expect(missing.status).toBe(400);
    expect(missing.json().error.code).toBe('DIGEST_REQUIRED');

    const response = await postJson(h, '/api/packs/install', { source: pack.dir, sha256: folderDigest(pack.manifestBytes) });
    expect(sseEvents(response.text).at(-1)?.event).toBe('success');
  });

  it('(c) a multipart archive upload installs identically and leaves no file in the staging dir', async () => {
    const h = await mount();
    const fixture = await fixtureArchive({}, false);
    const form = new FormData();
    form.append('archive', new Blob([readFileSync(fixture.archivePath)]), 'licensed-pack.tgz');
    form.append('sha256', fixture.digest);
    const response = await request(h, '/api/packs/install', { method: 'POST', body: form, headers: { [PACK_UPLOAD_HEADER]: '1' } });
    expect(response.status).toBe(200);
    const last = sseEvents(response.text).at(-1)!;
    expect(last.event).toBe('success');
    if (last.event !== 'success') throw new Error('expected success');
    expect(last.data.pack).toMatchObject({ id: FIXTURE_PACK_ID, version: '1.0.0', source: 'local:licensed-pack.tgz' });
    expect(stagingFiles(h)).toEqual([]);
  });

  it('an upload without its sha256 fails closed with DIGEST_REQUIRED and leaves nothing staged', async () => {
    const h = await mount();
    const fixture = await fixtureArchive({}, false);
    const form = new FormData();
    form.append('archive', new Blob([readFileSync(fixture.archivePath)]), 'licensed-pack.tgz');
    const response = await request(h, '/api/packs/install', { method: 'POST', body: form, headers: { [PACK_UPLOAD_HEADER]: '1' } });
    expect(response.status).toBe(400);
    expect(response.json().error.code).toBe('DIGEST_REQUIRED');

    const wrong = new FormData();
    wrong.append('archive', new Blob([readFileSync(fixture.archivePath)]), 'licensed-pack.tgz');
    wrong.append('sha256', 'f'.repeat(64));
    const mismatch = await request(h, '/api/packs/install', { method: 'POST', body: wrong, headers: { [PACK_UPLOAD_HEADER]: '1' } });
    const last = mismatch.status === 200 ? sseEvents(mismatch.text).at(-1) : null;
    expect(last?.event === 'error' ? last.data.code : mismatch.json().error.code).toBe('INTEGRITY_MISMATCH');
    expect(stagingFiles(h)).toEqual([]);
    expect((await request(h, '/api/packs')).json()).toEqual({ packs: [] });
  });

  it('(d) relative and ~ paths are refused with 400 BAD_REQUEST before any file is read', async () => {
    const h = await mount();
    for (const source of ['pack.tgz', './pack.tgz', '../pack.tgz', '~/pack.tgz', '~', 'file:///tmp/pack.tgz', '']) {
      const response = await postJson(h, '/api/packs/install', { source });
      expect(response.status, source).toBe(400);
      expect(response.json().error.code, source).toBe('BAD_REQUEST');
    }
    // An absolute path that is neither a .tgz/.tar.gz file nor a folder.
    const other = path.join(h.dataDir, 'notes.txt');
    writeFileSync(other, 'x');
    const response = await postJson(h, '/api/packs/install', { source: other, sha256: 'a'.repeat(64) });
    expect(response.status).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    expect(existsSync(path.join(h.packsDir, '.staging'))).toBe(false);
  });

  it('(e) install, remove and github-access writes refuse a non-loopback Origin with 403', async () => {
    const access = fakeAccess({ configured: false, source: 'none' });
    const h = await mount({ githubAccess: access.access });
    const evil = { origin: 'https://evil.example', 'content-type': 'application/json' };
    const install = await rawRequest(h.port, 'POST', '/api/packs/install', evil, JSON.stringify({ source: '/tmp/x.tgz' }));
    const remove = await rawRequest(h.port, 'DELETE', `/api/packs/${FIXTURE_PACK_ID}`, evil);
    const setToken = await rawRequest(h.port, 'POST', '/api/packs/github-access', evil, JSON.stringify({ token: `ghp_${'a'.repeat(36)}` }));
    const clearToken = await rawRequest(h.port, 'DELETE', '/api/packs/github-access', evil);
    for (const response of [install, remove, setToken, clearToken]) {
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
    }
    expect(access.stored).toEqual([]);
  });

  it('(f) DELETE /api/packs/..%2F..%2Fetc is 400 and removes nothing; an unknown id is 404', async () => {
    const h = await mount();
    const fixture = await fixtureArchive();
    await postJson(h, '/api/packs/install', { source: fixture.archivePath });
    const traversal = await request(h, '/api/packs/..%2F..%2Fetc', { method: 'DELETE' });
    expect(traversal.status).toBe(400);
    expect(traversal.json().error.code).toBe('BAD_REQUEST');
    const unknown = await request(h, '/api/packs/not-installed', { method: 'DELETE' });
    expect(unknown.status).toBe(404);
    expect(unknown.json().error.code).toBe('PACK_NOT_FOUND');
    expect(parsePackListResponse((await request(h, '/api/packs')).json())?.packs.map((pack) => pack.id)).toEqual([FIXTURE_PACK_ID]);

    const removed = await request(h, `/api/packs/${FIXTURE_PACK_ID}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removed.json()).toEqual({ ok: true, id: FIXTURE_PACK_ID, removedVersion: '1.0.0' });
    expect((await request(h, '/api/packs')).json()).toEqual({ packs: [] });
  });

  it('(g) a second install while one is in flight is 409 INSTALL_IN_PROGRESS', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFetcher = new Promise<void>((resolve) => { entered = resolve; });
    const fetcher: GithubPackFetcher = async () => {
      entered();
      await gate;
      throw new PackFetchError('FETCH_FAILED', 'held');
    };
    const h = await mount({ githubFetcher: fetcher });
    const first = postJson(h, '/api/packs/install', { source: 'github:example-org/example-pack' });
    await inFetcher;
    const fixture = await fixtureArchive();
    const second = await postJson(h, '/api/packs/install', { source: fixture.archivePath });
    expect(second.status).toBe(409);
    expect(second.json().error.code).toBe('INSTALL_IN_PROGRESS');
    const removing = await request(h, `/api/packs/${FIXTURE_PACK_ID}`, { method: 'DELETE' });
    expect(removing.status).toBe(409);
    release();
    const firstResponse = await first;
    expect(sseEvents(firstResponse.text).at(-1)).toMatchObject({ event: 'error', data: { code: 'FETCH_FAILED' } });
  });

  it('a client that disconnects mid-install aborts it and frees the install lock', async () => {
    let entered!: () => void;
    const inFetcher = new Promise<void>((resolve) => { entered = resolve; });
    let aborted!: () => void;
    const sawAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const fetcher: GithubPackFetcher = async (_source, opts) => {
      entered();
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
      aborted();
      throw new PackFetchError('FETCH_FAILED', 'cancelled');
    };
    const h = await mount({ githubFetcher: fetcher });
    const client = new AbortController();
    const pending = fetch(`${h.baseUrl}/api/packs/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'github:example-org/example-pack' }),
      signal: client.signal,
    }).then((response) => response.text()).catch(() => 'aborted');
    await inFetcher;
    client.abort();
    await sawAbort;
    expect(await pending).toBe('aborted');
    // The lock is free again: a new install is not refused with 409.
    const fixture = await fixtureArchive();
    const next = await postJson(h, '/api/packs/install', { source: fixture.archivePath });
    expect(next.status).toBe(200);
    expect(sseEvents(next.text).at(-1)?.event).toBe('success');
  });

  it('(h) a github: source with no fetcher wired yields error SOURCE_UNSUPPORTED', async () => {
    const h = await mount();
    const response = await postJson(h, '/api/packs/install', { source: 'github:ZeroSum-Solutions/mishh-licensed@1.0.0' });
    expect(response.status).toBe(400);
    expect(response.json().error.code).toBe('SOURCE_UNSUPPORTED');
  });

  it('(i) an upload over the archive cap is 413 TOO_LARGE and the partial file is deleted', async () => {
    const h = await mount({ archiveMaxBytes: 1024 });
    const form = new FormData();
    form.append('sha256', 'a'.repeat(64));
    form.append('archive', new Blob([Buffer.alloc(64 * 1024, 7)]), 'big.tgz');
    const response = await request(h, '/api/packs/install', { method: 'POST', body: form, headers: { [PACK_UPLOAD_HEADER]: '1' } });
    expect(response.status).toBe(413);
    expect(response.json().error.code).toBe('TOO_LARGE');
    expect(stagingFiles(h)).toEqual([]);
  });

  it('(j) no SSE event or error body contains an http(s) URL or the temp directory path', async () => {
    const leakyFetcher: GithubPackFetcher = async () => {
      throw new Error(`GET https://api.github.com/repos/x/y failed at ${tmpdir()} with ghp_${'b'.repeat(36)}`);
    };
    const authFetcher: GithubPackFetcher = async () => {
      throw new PackFetchError('AUTH_REQUIRED', 'https://api.github.com/repos/x/y returned 404');
    };
    const h = await mount({ githubFetcher: leakyFetcher });
    const h2 = await mount({ githubFetcher: authFetcher });
    const good = await fixtureArchive();
    const bad = writeFixturePack();
    cleanup.push(bad.dir);
    const notAnArchive = path.join(bad.dir, 'not-a-pack.tgz');
    writeFileSync(notAnArchive, 'plain text, not gzip');
    writeSidecar(notAnArchive);

    const responses = [
      await postJson(h, '/api/packs/install', { source: 'github:example-org/example-pack' }),
      await postJson(h2, '/api/packs/install', { source: 'github:example-org/example-pack' }),
      await postJson(h, '/api/packs/install', { source: good.archivePath, sha256: 'c'.repeat(64) }),
      await postJson(h, '/api/packs/install', { source: notAnArchive }),
      await postJson(h, '/api/packs/install', { source: path.join(h.dataDir, 'missing.tgz') }),
      await postJson(h, '/api/packs/install', { source: bad.dir }),
      await postJson(h, '/api/packs/install', { source: bad.dir, sha256: 'd'.repeat(64) }),
      await request(h, '/api/packs/missing-pack', { method: 'DELETE' }),
    ];
    const codes = responses.map((response) => {
      if (response.status === 200) {
        const last = sseEvents(response.text).at(-1)!;
        return last.event === 'error' ? last.data.code : last.event;
      }
      return response.json().error.code;
    });
    expect(codes).toEqual([
      'FETCH_FAILED',
      'AUTH_REQUIRED',
      'INTEGRITY_MISMATCH',
      'INVALID_ARCHIVE',
      'BAD_REQUEST',
      'DIGEST_REQUIRED',
      'INTEGRITY_MISMATCH',
      'PACK_NOT_FOUND',
    ]);
    const roots = [tmpdir(), path.resolve(tmpdir()), homedir(), h.dataDir, h2.dataDir];
    for (const body of [...h.bodies, ...h2.bodies]) {
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toMatch(/ghp_/);
      for (const root of roots) expect(body).not.toContain(root);
    }
  });

  it('(k) github-access status never includes the token; POST stores it through the injected access and returns only {configured, source}', async () => {
    const access = fakeAccess({ configured: true, source: 'gh-cli' });
    const h = await mount({ githubAccess: access.access });
    const token = `github_pat_${'Z'.repeat(40)}`;

    const before = await request(h, '/api/packs/github-access');
    expect(before.status).toBe(200);
    expect(parsePackGithubAccessStatus(before.json())).toEqual({ configured: true, source: 'gh-cli' });

    const saved = await postJson(h, '/api/packs/github-access', { token });
    expect(saved.status).toBe(200);
    expect(saved.json()).toEqual({ configured: true, source: 'stored' });
    expect(access.stored).toEqual([token]);

    const invalid = await postJson(h, '/api/packs/github-access', { token: 'not-a-token-zzzz' });
    expect(invalid.status).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_TOKEN_FORMAT');
    const missing = await postJson(h, '/api/packs/github-access', { secret: token });
    expect(missing.status).toBe(400);
    expect(missing.json().error.code).toBe('BAD_REQUEST');

    access.fail(new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE'));
    const unsafe = await postJson(h, '/api/packs/github-access', { token });
    expect(unsafe.status).toBe(409);
    expect(unsafe.json().error.code).toBe('CREDENTIAL_STORE_UNSAFE');
    access.fail(Object.assign(new Error(`EACCES: permission denied, open '${h.packsDir}/.credentials/github.json'`), { code: 'EACCES' }));
    const denied = await postJson(h, '/api/packs/github-access', { token });
    expect(denied.status).toBe(500);
    expect(denied.json().error.code).toBe('CREDENTIAL_STORE_FAILED');
    expect(denied.text).not.toContain(h.packsDir);
    expect(denied.text).not.toContain('.credentials');
    access.fail(null);

    // Sol #191: a clear the store refuses (unsafe .credentials) reports CREDENTIAL_STORE_UNSAFE, as a write does.
    access.fail(new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE'));
    const unsafeClear = await request(h, '/api/packs/github-access', { method: 'DELETE' });
    expect(unsafeClear.status).toBe(409);
    expect(unsafeClear.json().error.code).toBe('CREDENTIAL_STORE_UNSAFE');
    access.fail(null);

    const cleared = await request(h, '/api/packs/github-access', { method: 'DELETE' });
    expect(cleared.json()).toEqual({ configured: false, source: 'none' });

    for (const body of h.bodies) {
      expect(body).not.toContain(token);
      expect(body).not.toContain('Z'.repeat(8));
      expect(body).not.toContain('not-a-token');
    }
  });

  it('without an injected GitHub access the status is not configured and writes are refused', async () => {
    const h = await mount();
    expect((await request(h, '/api/packs/github-access')).json()).toEqual({ configured: false, source: 'none' });
    const response = await postJson(h, '/api/packs/github-access', { token: `ghp_${'a'.repeat(36)}` });
    expect(response.status).toBe(500);
    expect(response.json().error.code).toBe('CREDENTIAL_STORE_FAILED');
  });
});

describe('pack write routes refuse browser cross-origin requests (lane round B1)', () => {
  const uploadForm = async () => {
    const fixture = await fixtureArchive({}, false);
    const form = new FormData();
    form.append('sha256', fixture.digest);
    form.append('archive', new Blob([readFileSync(fixture.archivePath)]), 'p.tgz');
    return form;
  };

  it('refuses the powered-preview probe: a CORS-simple multipart POST from Origin http://localhost:P to Host 127.0.0.1:P', async () => {
    const h = await mount();
    const response = await request(h, '/api/packs/install', {
      method: 'POST',
      body: await uploadForm(),
      headers: { origin: `http://localhost:${h.port}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
    });
    expect(response.status).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(stagingFiles(h)).toEqual([]);
    expect((await request(h, '/api/packs')).json()).toEqual({ packs: [] });
  });

  it('refuses a multipart upload without the X-OD-Pack-Upload header even with no fetch metadata', async () => {
    const h = await mount();
    const response = await request(h, '/api/packs/install', {
      method: 'POST',
      body: await uploadForm(),
      headers: { origin: `http://localhost:${h.port}` },
    });
    expect(response.status).toBe(403);
    expect(stagingFiles(h)).toEqual([]);
  });

  it('refuses every write when Sec-Fetch-Site is cross-site or same-site', async () => {
    const access = fakeAccess({ configured: false, source: 'none' });
    const h = await mount({ githubAccess: access.access });
    const fixture = await fixtureArchive();
    for (const site of ['cross-site', 'same-site']) {
      const headers = { 'content-type': 'application/json', 'sec-fetch-site': site };
      const responses = [
        await request(h, '/api/packs/install', { method: 'POST', headers, body: JSON.stringify({ source: fixture.archivePath }) }),
        await request(h, '/api/packs/install', { method: 'POST', body: await uploadForm(), headers: { 'sec-fetch-site': site, [PACK_UPLOAD_HEADER]: '1' } }),
        await request(h, `/api/packs/${FIXTURE_PACK_ID}`, { method: 'DELETE', headers }),
        await request(h, '/api/packs/github-access', { method: 'POST', headers, body: JSON.stringify({ token: `ghp_${'a'.repeat(36)}` }) }),
        await request(h, '/api/packs/github-access', { method: 'DELETE', headers }),
      ];
      for (const response of responses) {
        expect(response.status, site).toBe(403);
        expect(response.json().error.code).toBe('FORBIDDEN');
      }
    }
    expect(access.stored).toEqual([]);
    expect((await request(h, '/api/packs')).json()).toEqual({ packs: [] });
  });

  it("still accepts the web client's request shape (same-origin, upload header) and the CLI's (no fetch metadata)", async () => {
    const access = fakeAccess({ configured: false, source: 'none' });
    const h = await mount({ githubAccess: access.access });
    const sameOrigin = { origin: h.baseUrl, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
    const web = await request(h, '/api/packs/install', {
      method: 'POST',
      body: await uploadForm(),
      headers: { ...sameOrigin, [PACK_UPLOAD_HEADER]: '1' },
    });
    expect(web.status).toBe(200);
    expect(sseEvents(web.text).at(-1)?.event).toBe('success');
    const token = await request(h, '/api/packs/github-access', {
      method: 'POST',
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: `ghp_${'a'.repeat(36)}` }),
    });
    expect(token.status).toBe(200);
    const removedByWeb = await request(h, `/api/packs/${FIXTURE_PACK_ID}`, { method: 'DELETE', headers: sameOrigin });
    expect(removedByWeb.status).toBe(200);

    // The CLI: Node fetch, JSON, no Origin and no Sec-Fetch-* headers.
    const fixture = await fixtureArchive();
    const cli = await postJson(h, '/api/packs/install', { source: fixture.archivePath });
    expect(sseEvents(cli.text).at(-1)?.event).toBe('success');
    const navigate = await request(h, `/api/packs/${FIXTURE_PACK_ID}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'none' } });
    expect(navigate.status).toBe(200);
  });
});

describe('lane round N1, N2, N4 and the reserved id', () => {
  it('N1: with the global 4 MB parser present, a pack body over 64 KB is refused and malformed JSON echoes nothing', async () => {
    const access = fakeAccess({ configured: false, source: 'none' });
    const h = await mount({ githubAccess: access.access });
    const big = await postJson(h, '/api/packs/install', { source: `/${'a'.repeat(70 * 1024)}` });
    expect(big.status).toBe(413);
    const secret = `ghp_${'S'.repeat(36)}`;
    const malformed = await request(h, '/api/packs/github-access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"token": "${secret}"`,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toContain('SSSS');
  });

  it('N2: finds the .sha256 sidecar beside the path the user gave, not only beside its realpath', async () => {
    const h = await mount();
    const fixture = await fixtureArchive({}, false);
    const linkDir = mkdtempSync(path.join(tmpdir(), 'od-pack-link-'));
    cleanup.push(linkDir);
    const link = path.join(linkDir, 'licensed.tgz');
    symlinkSync(fixture.archivePath, link);
    writeFileSync(`${link}.sha256`, `${fixture.digest}  licensed.tgz\n`);
    const response = await postJson(h, '/api/packs/install', { source: link });
    expect(response.status).toBe(200);
    expect(sseEvents(response.text).at(-1), response.text).toMatchObject({ event: 'success', data: { pack: { source: 'local:licensed.tgz' } } });
  });

  it('N4: refuses an upload with 409 before writing a byte when an install is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFetcher = new Promise<void>((resolve) => { entered = resolve; });
    const fetcher: GithubPackFetcher = async () => {
      entered();
      await gate;
      throw new PackFetchError('FETCH_FAILED', 'held');
    };
    const h = await mount({ githubFetcher: fetcher });
    const first = postJson(h, '/api/packs/install', { source: 'github:example-org/example-pack' });
    await inFetcher;
    const fixture = await fixtureArchive({}, false);
    const form = new FormData();
    form.append('sha256', fixture.digest);
    form.append('archive', new Blob([readFileSync(fixture.archivePath)]), 'p.tgz');
    const staged = stagingFiles(h);
    // multer asks the service for the staging dir before it writes; it must never get that far.
    let stagingCalls = 0;
    const stagingDir = h.service.stagingDir.bind(h.service);
    (h.service as { stagingDir: () => string }).stagingDir = () => {
      stagingCalls += 1;
      return stagingDir();
    };
    const response = await request(h, '/api/packs/install', { method: 'POST', body: form, headers: { [PACK_UPLOAD_HEADER]: '1' } });
    expect(stagingCalls).toBe(0);
    expect(response.status).toBe(409);
    expect(response.json().error.code).toBe('INSTALL_IN_PROGRESS');
    expect(stagingFiles(h).filter((name) => name.startsWith('upload-'))).toEqual([]);
    expect(stagingFiles(h)).toEqual(staged);
    release();
    await first;
  });

  it('a pack folder named github-access cannot be installed (the id is reserved for the token route)', async () => {
    const h = await mount();
    const pack = writeFixturePack({ id: 'github-access' });
    cleanup.push(pack.dir);
    const response = await postJson(h, '/api/packs/install', { source: pack.dir, sha256: 'a'.repeat(64) });
    const last = response.status === 200 ? sseEvents(response.text).at(-1) : null;
    expect(last?.event === 'error' ? last.data.code : response.json().error.code).toBe('INVALID_MANIFEST');
  });
});
