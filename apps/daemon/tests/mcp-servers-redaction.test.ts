import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
// B-121: GET and PUT /api/mcp/servers never return a saved secret. Header and env values,
// secret-looking args and secret query parameters come back as `MCP_SECRET_MASK`; a PUT that
// sends a mask back keeps the stored secret for that same slot, refuses a mask it cannot place,
// and never writes a mask to disk. mcp-config.json and mcp-tokens.json are owner-only (0600)
// from the moment they are created, temp files included.
//
// Harness: `registerMcpRoutes` on a bare Express app with a temporary daemon data root.

import type http from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_SECRET_MASK, type McpServerConfig, type McpServersResponse } from '@open-design/contracts';
import { sendApiError } from '../src/http/api-errors.js';
import { registerMcpRoutes } from '../src/mcp-routes.js';
import { readMcpConfig, sanitizeMcpConfig, writeMcpConfig } from '../src/mcp-config.js';
import { setToken } from '../src/mcp-tokens.js';
import { getOrRegisterClient, PendingAuthCache } from '../src/mcp-oauth.js';

const { credentialIo } = vi.hoisted(() => ({ credentialIo: {
  failReplacement: false,
  failRollback: false,
  foreignRecoveryRoot: false,
  gate: null as null | { filename: string; entered: () => void; wait: Promise<void> },
} }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (credentialIo.failReplacement && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('synthetic-filesystem-canary'), { code: 'ENOSPC' });
      return actual.open(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      if (credentialIo.foreignRecoveryRoot && path.basename(String(args[0])) === 'mcp-credential-recovery') {
        return new Proxy(info, { get: (target, key, receiver) => key === 'uid' ? (process.getuid?.() ?? 0) + 1 : Reflect.get(target, key, receiver) });
      }
      return info;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (credentialIo.failRollback && String(args[0]).includes('mcp-credential-recovery')) throw Object.assign(new Error('synthetic-filesystem-canary'), { code: 'EACCES' });
      return actual.rename(...args);
    },
  };
});
vi.mock('../src/mcp-private-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mcp-private-file.js')>();
  return { ...actual, readPrivateMcpFile: async (file: string) => {
    const gate = credentialIo.gate;
    if (gate && path.basename(file) === gate.filename) {
      credentialIo.gate = null;
      gate.entered();
      await gate.wait;
    }
    return actual.readPrivateMcpFile(file);
  } };
});

const HEADER_SECRET = `Bearer ${['fixture', 'mcp', 'header', 'canary'].join('-')}`;
const ENV_SECRET = ['fixture', 'mcp', 'env', 'canary'].join('-');
const ARG_SECRET = ['fixture', 'mcp', 'argument', 'canary'].join('-');
const URL_SECRET = ['fixture', 'mcp', 'url', 'canary'].join('-');

const SERVERS: McpServerConfig[] = [
  {
    id: 'remote',
    transport: 'http',
    enabled: true,
    url: `https://mcp.example.test/mcp?api_key=${URL_SECRET}&team=design`,
    headers: { Authorization: HEADER_SECRET, 'X-Workspace': 'studio' },
  },
  {
    id: 'local',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@acme/mcp', '--api-key', ARG_SECRET, `--token=${ARG_SECRET}`, '--port', '3000'],
    env: { ACME_API_KEY: ENV_SECRET, EMPTY_VALUE: '' },
  },
];

/** What the daemon stores for SERVERS: sanitized (empty env values dropped, authMode settled). */
const STORED = sanitizeMcpConfig({ servers: SERVERS }).servers;

let server: http.Server;
let baseUrl = '';
let dataDir = '';
let pendingAuth: PendingAuthCache;
let localRequest = true;

beforeEach(async () => {
  localRequest = true;
  credentialIo.failReplacement = false;
  credentialIo.failRollback = false;
  credentialIo.foreignRecoveryRoot = false;
  credentialIo.gate = null;
  dataDir = mkdtempSync(path.join(tmpdir(), 'od-b121-'));
  pendingAuth = new PendingAuthCache();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerMcpRoutes(app, {
    http: { isLocalSameOrigin: () => localRequest, resolvedPortRef: { current: 0 }, sendApiError } as never,
    paths: { RUNTIME_DATA_DIR: dataDir, OD_BIN: '/nonexistent/od', PROJECTS_DIR: path.join(dataDir, 'projects') } as never,
    mcp: { pendingAuth, daemonUrlRef: { current: 'http://127.0.0.1:1' }, inheritedEnvironment: {} } as never,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  pendingAuth.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

const put = (servers: unknown) => fetch(`${baseUrl}/api/mcp/servers`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ servers }),
});
const get = () => fetch(`${baseUrl}/api/mcp/servers`);
const SECRETS = [HEADER_SECRET, HEADER_SECRET.slice('Bearer '.length), ENV_SECRET, ARG_SECRET, URL_SECRET];
const leaks = (text: string) => SECRETS.filter((secret) => text.includes(secret));
const mode = (file: string) => statSync(file).mode & 0o777;

describe('GET and PUT /api/mcp/servers never return a saved secret', () => {
  it('masks header and env values, secret args and secret query parameters in both responses', async () => {
    const saved = await put(SERVERS);
    expect(saved.status).toBe(200);
    const putText = await saved.text();
    expect(leaks(putText)).toEqual([]);

    const listed = await get();
    const getText = await listed.text();
    expect(leaks(getText)).toEqual([]);

    const body = JSON.parse(getText) as McpServersResponse;
    const remote = body.servers.find((entry) => entry.id === 'remote')!;
    const local = body.servers.find((entry) => entry.id === 'local')!;
    expect(remote.headers).toEqual({ Authorization: MCP_SECRET_MASK, 'X-Workspace': MCP_SECRET_MASK });
    expect(remote.url).toBe(MCP_SECRET_MASK);
    expect(local.env).toEqual({ ACME_API_KEY: MCP_SECRET_MASK });
    expect(local.command).toBe(MCP_SECRET_MASK);
    expect(local.args).toEqual(SERVERS[1]!.args!.map(() => MCP_SECRET_MASK));
    // The daemon itself still holds the real values for spawning agents.
    expect((await readMcpConfig(dataDir)).servers).toEqual(STORED);
  });

  it('a PUT that sends the masks back keeps every stored secret and never writes a mask', async () => {
    await put(SERVERS);
    const masked = ((await (await get()).json()) as McpServersResponse).servers;
    const resaved = await put(masked);
    expect(resaved.status).toBe(200);
    expect((await readMcpConfig(dataDir)).servers).toEqual(STORED);
    expect(readFileSync(path.join(dataDir, 'mcp-config.json'), 'utf8')).not.toContain(MCP_SECRET_MASK);
  });

  it('a partial update needs the other secrets on that server entered again; then it saves', async () => {
    await put(SERVERS);
    const masked = ((await (await get()).json()) as McpServersResponse).servers;
    const remote = masked.find((entry) => entry.id === 'remote')!;
    const local = masked.find((entry) => entry.id === 'local')!;
    // Replacing one header and deleting another while the URL secret is still masked is refused.
    expect((await put([{ ...remote, headers: { Authorization: 'Bearer new-token' } }, local])).status).toBe(400);
    // With the URL entered again it saves; the untouched local server keeps all of its secrets.
    expect((await put([{ ...remote, url: SERVERS[0]!.url, headers: { Authorization: 'Bearer new-token' } }, local])).status).toBe(200);
    const stored = (await readMcpConfig(dataDir)).servers;
    const savedRemote = stored.find((entry) => entry.id === 'remote')!;
    expect(savedRemote.headers).toEqual({ Authorization: 'Bearer new-token' });
    expect(savedRemote.url).toBe(SERVERS[0]!.url);
    expect(stored.find((entry) => entry.id === 'local')).toEqual(STORED.find((entry) => entry.id === 'local'));
  });

  it('a stdio server whose env changes keeps no masked secret: the save is refused and names the field', async () => {
    await put(SERVERS);
    const before = readFileSync(path.join(dataDir, 'mcp-config.json'), 'utf8');
    const masked = ((await (await get()).json()) as McpServersResponse).servers;
    const local = masked.find((entry) => entry.id === 'local')!;
    const remote = masked.find((entry) => entry.id === 'remote')!;
    const response = await put([remote, { ...local, env: { ACME_API_KEY: 'replaced-key' } }]);
    expect(response.status).toBe(400);
    const body = await response.json() as { code?: string; serverId?: string; field?: string };
    expect(body).toMatchObject({ code: 'MCP_SECRET_MASK_UNMATCHED', serverId: 'local' });
    expect(readFileSync(path.join(dataDir, 'mcp-config.json'), 'utf8')).toBe(before);
    // Entering every secret again saves.
    expect((await put([remote, { ...local, env: { ACME_API_KEY: 'replaced-key' }, command: SERVERS[1]!.command, args: SERVERS[1]!.args }])).status).toBe(200);
  });

  it('refuses a mask it cannot place, without writing anything or echoing a value', async () => {
    await put(SERVERS);
    const before = readFileSync(path.join(dataDir, 'mcp-config.json'), 'utf8');
    const cases: unknown[] = [
      [{ id: 'brand-new', transport: 'http', enabled: true, url: 'https://x.test/mcp', headers: { Authorization: MCP_SECRET_MASK } }],
      [{ ...SERVERS[0], headers: { 'X-Unknown': MCP_SECRET_MASK } }, SERVERS[1]],
      [SERVERS[0], { ...SERVERS[1], args: ['-y', MCP_SECRET_MASK] }],
      [{ ...SERVERS[0], url: `https://other.test/mcp?api_key=${MCP_SECRET_MASK}` }, SERVERS[1]],
    ];
    for (const servers of cases) {
      const response = await put(servers);
      expect(response.status, JSON.stringify(servers)).toBe(400);
      const text = await response.text();
      expect(leaks(text)).toEqual([]);
    }
    expect(readFileSync(path.join(dataDir, 'mcp-config.json'), 'utf8')).toBe(before);
  });

  it('never logs a secret value', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      await put(SERVERS);
      await get();
      await put([{ ...SERVERS[0], headers: { 'X-Unknown': MCP_SECRET_MASK } }, SERVERS[1]]);
      const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' '))).join('\n');
      expect(leaks(logged)).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('MCP config and token files are owner-only from creation', () => {
  it.skipIf(process.platform === 'win32')('mcp-config.json is 0600 on create and on replace, even over a looser file', async () => {
    const file = path.join(dataDir, 'mcp-config.json');
    await writeMcpConfig(dataDir, { servers: SERVERS });
    expect(mode(file)).toBe(0o600);
    writeFileSync(file, '{"servers":[]}', { mode: 0o644 });
    await writeMcpConfig(dataDir, { servers: SERVERS });
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('mcp-tokens.json is 0600 on create and replace', async () => {
    const file = path.join(dataDir, 'mcp-tokens.json');
    await setToken(dataDir, 'remote', { accessToken: 'secret-access', tokenType: 'Bearer', savedAt: 1 });
    expect(mode(file)).toBe(0o600);
    writeFileSync(file, '{"servers":{}}', { mode: 0o644 });
    await setToken(dataDir, 'remote', { accessToken: 'secret-access-2', tokenType: 'Bearer', savedAt: 2 });
    expect(mode(file)).toBe(0o600);
  });
});

describe('the OAuth start flow never exposes a URL secret (Sol round 6)', () => {
  it('a failing OAuth start never returns or logs the stored URL secret', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'oauthy', transport: 'http', enabled: true, authMode: 'oauth', url: `https://mcp.example.test/path-sentinel?api_key=${URL_SECRET}` }] });
    const realFetch = globalThis.fetch;
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    // Discovery is the first outbound call: fail it with a message quoting the URL, as fetch errors do.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      throw new Error(`discovery failed for ${url}`);
    });
    try {
      const response = await realFetch(`${baseUrl}/api/mcp/oauth/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: 'oauthy' }),
      });
      const text = await response.text();
      expect(leaks(text)).toEqual([]);
      const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' '))).join('\n');
      expect(leaks(logged)).toEqual([]);
      expect(logged).not.toContain(URL_SECRET);
      expect(logged).not.toContain('path-sentinel');
    } finally {
      fetchSpy.mockRestore();
      for (const spy of spies) spy.mockRestore();
    }
  });
});


describe('OAuth callback keeps upstream errors private', () => {
  it('does not echo provider query errors', async () => {
    const response = await fetch(`${baseUrl}/api/mcp/oauth/callback?error=synthetic-provider-canary`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('synthetic-provider-canary');
  });
  it('does not expose token errors in HTML or logs', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://mcp.example.test/mcp' }] });
    pendingAuth.put('synthetic-state', { serverId: 'test', authServerIssuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/token', clientId: 'id', redirectUri: `${baseUrl}/callback`, codeVerifier: 'verifier', endpointFingerprint: mcpEndpointFingerprint('https://mcp.example.test/mcp'), createdAt: Date.now() });
    const realFetch = globalThis.fetch;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith(baseUrl) ? realFetch(input, init) : new Response('synthetic-token-body-canary', { status: 400 }));
    try {
      const response = await realFetch(`${baseUrl}/api/mcp/oauth/callback?code=synthetic-code&state=synthetic-state`);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('synthetic-token-body-canary');
      expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-token-body-canary');
    } finally { spy.mockRestore(); log.mockRestore(); }
  });
});


it('gives Settings recovery guidance when OAuth callback encounters unsafe token storage', async () => {
  await writeMcpConfig(dataDir, { servers: [{ id: 'test', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://mcp.example.test/mcp' }] });
  const target = unsafeOAuthStore('mcp-tokens.json');
  pendingAuth.put('synthetic-state', { serverId: 'test', authServerIssuer: 'https://auth.example.test', tokenEndpoint: 'https://auth.example.test/token', clientId: 'id', redirectUri: `${baseUrl}/callback`, codeVerifier: 'verifier', endpointFingerprint: mcpEndpointFingerprint('https://mcp.example.test/mcp'), createdAt: Date.now() });
  const realFetch = globalThis.fetch;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith(baseUrl)
    ? realFetch(input, init) : new Response(JSON.stringify({ access_token: 'synthetic-new-token-canary', token_type: 'Bearer' }), { status: 200 }));
  try {
    const response = await realFetch(`${baseUrl}/api/mcp/oauth/callback?code=synthetic-code&state=synthetic-state`);
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain('mcp-tokens.json');
    expect(html).toMatch(/Settings.*reset/i);
    expect(html).not.toContain(dataDir);
    expect(html).not.toContain('synthetic-new-token-canary');
    expect(JSON.stringify(log.mock.calls)).toContain('MCP_CREDENTIAL_FILE_UNSAFE');
    expect(JSON.stringify(log.mock.calls)).not.toContain(dataDir);
    expect(readlinkSync(path.join(dataDir, 'mcp-tokens.json'))).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('synthetic-preserved-credential');
  } finally { spy.mockRestore(); log.mockRestore(); }
});


describe('precise reconnect status and private config recovery', () => {
  it.each([
    { enabled: true, authMode: 'oauth', token: false, code: undefined },
    { enabled: false, authMode: 'oauth', token: true, code: undefined },
    { enabled: true, authMode: 'none', token: true, code: undefined },
    { enabled: true, authMode: 'oauth', token: true, code: 'MCP_OAUTH_RECONNECT_REQUIRED' },
  ])('reports only a stale saved authorization as reconnect-required: %j', async state => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'status', transport: 'http', enabled: state.enabled, authMode: state.authMode, url: 'https://mcp.test/mcp' }] });
    if (state.token) await setToken(dataDir, 'status', { accessToken: 'synthetic-token', tokenType: 'Bearer', savedAt: 1 });
    const response = await fetch(`${baseUrl}/api/mcp/oauth/status?serverId=status`);
    expect(await response.json()).toEqual({ connected: false, ...(state.code ? { code: state.code } : {}) });
  });

  it('reports unsafe config explicitly and repairs it only with a full unmasked replacement', async () => {
    const target = path.join(dataDir, 'unrelated.json');
    const contents = JSON.stringify({ servers: SERVERS });
    writeFileSync(target, contents, { mode: 0o644 });
    symlinkSync(target, path.join(dataDir, 'mcp-config.json'));
    const listed = await get();
    expect(listed.status).toBe(409);
    expect(await listed.json()).toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE' });
    expect((await put([{ ...SERVERS[0], headers: { Authorization: MCP_SECRET_MASK } }])).status).toBe(409);
    expect((await put(SERVERS)).status).toBe(200);
    expect((await readMcpConfig(dataDir)).servers).toEqual(STORED);
    expect(readFileSync(target, 'utf8')).toBe(contents);
    if (process.platform !== 'win32') expect(mode(target)).toBe(0o644);
  });

  it.each(['status', 'disconnect'])('reports unsafe token storage from OAuth %s without reading its target', async action => {
    const target = path.join(dataDir, 'unrelated-tokens.json');
    const contents = JSON.stringify({ servers: { status: { accessToken: 'synthetic-unrelated-token', tokenType: 'Bearer', savedAt: 1 } } });
    writeFileSync(target, contents, { mode: 0o644 });
    symlinkSync(target, path.join(dataDir, 'mcp-tokens.json'));
    const response = action === 'status'
      ? await fetch(`${baseUrl}/api/mcp/oauth/status?serverId=status`)
      : await fetch(`${baseUrl}/api/mcp/oauth/disconnect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: 'status' }) });
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE' });
    expect(body).not.toContain('synthetic-unrelated-token');
    expect(body).not.toContain(target);
    expect(readFileSync(target, 'utf8')).toBe(contents);
    if (process.platform !== 'win32') expect(mode(target)).toBe(0o644);
  });

});


const OAUTH_STORES = [
  { store: 'tokens', filename: 'mcp-tokens.json', other: 'mcp-oauth-clients.json', empty: { servers: {} } },
  { store: 'client-cache', filename: 'mcp-oauth-clients.json', other: 'mcp-tokens.json', empty: { clients: [] } },
] as const;
const resetOAuthStore = (body: unknown) => fetch(`${baseUrl}/api/mcp/oauth/reset-credentials`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
function unsafeOAuthStore(filename: string) {
  const target = path.join(dataDir, 'unrelated-credential.json');
  writeFileSync(target, 'synthetic-preserved-credential', { mode: 0o644 });
  symlinkSync(target, path.join(dataDir, filename));
  return target;
}
function preservedEntry(filename: string) {
  const recovery = path.join(dataDir, 'mcp-credential-recovery');
  const directories = readdirSync(recovery);
  expect(directories).toHaveLength(1);
  const directory = path.join(recovery, directories[0]!);
  if (process.platform !== 'win32') expect(mode(directory)).toBe(0o700);
  return path.join(directory, filename);
}

it.each(OAUTH_STORES)('explicitly repairs only unsafe $store while preserving the entry and the other store', async item => {
  const target = unsafeOAuthStore(item.filename);
  const other = path.join(dataDir, item.other);
  writeFileSync(other, 'synthetic-other-store', { mode: 0o644 });
  const response = await resetOAuthStore({ store: item.store, confirm: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const backup = preservedEntry(item.filename);
  expect(lstatSync(backup).isSymbolicLink()).toBe(true);
  expect(readlinkSync(backup)).toBe(target);
  expect(lstatSync(path.join(dataDir, item.filename)).isSymbolicLink()).toBe(false);
  expect(JSON.parse(readFileSync(path.join(dataDir, item.filename), 'utf8'))).toEqual(item.empty);
  expect(readFileSync(target, 'utf8')).toBe('synthetic-preserved-credential');
  expect(readFileSync(other, 'utf8')).toBe('synthetic-other-store');
  if (process.platform !== 'win32') {
    expect(mode(target)).toBe(0o644);
    expect(mode(other)).toBe(0o644);
    expect(mode(path.join(dataDir, item.filename))).toBe(0o600);
  }
});

it.each(['symlink', 'non-directory', 'foreign-owner'] as const)('refuses an unsafe recovery root (%s) without moving credential entries', async kind => {
  const target = unsafeOAuthStore('mcp-tokens.json');
  const root = path.join(dataDir, 'mcp-credential-recovery');
  const unrelated = path.join(dataDir, 'unrelated-directory');
  mkdirSync(unrelated, { mode: 0o700 });
  if (kind === 'symlink') symlinkSync(unrelated, root);
  else if (kind === 'non-directory') writeFileSync(root, 'synthetic-root-canary', { mode: 0o600 });
  else {
    mkdirSync(root, { mode: 0o700 });
    credentialIo.foreignRecoveryRoot = true;
  }
  const response = await resetOAuthStore({ store: 'tokens', confirm: true });
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ code: 'MCP_CREDENTIAL_RESET_FAILED' });
  expect(body).not.toContain(dataDir);
  expect(body).not.toContain('synthetic-root-canary');
  expect(readlinkSync(path.join(dataDir, 'mcp-tokens.json'))).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('synthetic-preserved-credential');
  expect(readdirSync(unrelated)).toEqual([]);
  if (kind === 'non-directory') expect(readFileSync(root, 'utf8')).toBe('synthetic-root-canary');
  else if (kind === 'foreign-owner') expect(readdirSync(root)).toEqual([]);
});

it.each([{ store: 'tokens' }, { store: 'config', confirm: true }, { store: '../arbitrary', confirm: true }])('requires explicit confirmation and an allowlisted OAuth store: %j', async body => {
  const target = unsafeOAuthStore('mcp-tokens.json');
  expect((await resetOAuthStore(body)).status).toBe(400);
  expect(readlinkSync(path.join(dataDir, 'mcp-tokens.json'))).toBe(target);
});
it('rejects cross-origin credential recovery before touching files', async () => {
  const target = unsafeOAuthStore('mcp-tokens.json');
  localRequest = false;
  expect((await resetOAuthStore({ store: 'tokens', confirm: true })).status).toBe(403);
  expect(readlinkSync(path.join(dataDir, 'mcp-tokens.json'))).toBe(target);
});
it.each([false, true])('does not reset healthy empty or safely readable storage (exists=%s)', async exists => {
  const file = path.join(dataDir, 'mcp-tokens.json');
  const contents = JSON.stringify({ servers: { p: { accessToken: 'synthetic-current-token', tokenType: 'Bearer', savedAt: 1 } } });
  if (exists) writeFileSync(file, contents, { mode: 0o600 });
  const response = await resetOAuthStore({ store: 'tokens', confirm: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'MCP_CREDENTIAL_RESET_NOT_NEEDED' });
  if (exists) expect(readFileSync(file, 'utf8')).toBe(contents);
  else expect(existsSync(file)).toBe(false);
});
it.each([false, true])('reports replacement failure safely and preserves the original (rollback failure=%s)', async failRollback => {
  const target = unsafeOAuthStore('mcp-tokens.json');
  credentialIo.failReplacement = true;
  credentialIo.failRollback = failRollback;
  const response = await resetOAuthStore({ store: 'tokens', confirm: true });
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ code: 'MCP_CREDENTIAL_RESET_FAILED' });
  expect(body).not.toContain(target);
  expect(body).not.toContain('synthetic-filesystem-canary');
  expect(body).toMatch(/original.*preserved/i);
  if (failRollback) expect(readlinkSync(preservedEntry('mcp-tokens.json'))).toBe(target);
  else expect(readlinkSync(path.join(dataDir, 'mcp-tokens.json'))).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('synthetic-preserved-credential');
});
it.each(OAUTH_STORES)('serializes $store recovery against an existing mutation', async item => {
  unsafeOAuthStore(item.filename);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  credentialIo.gate = { filename: item.filename, entered: enter, wait };
  const mutation = item.store === 'tokens'
    ? setToken(dataDir, 'p', { accessToken: 'synthetic-current-token', tokenType: 'Bearer', savedAt: 1 })
    : getOrRegisterClient(dataDir, { issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize', token_endpoint: 'https://auth.test/token' }, 'https://app.test/callback');
  // Capture the expected unsafe read immediately to avoid an unhandled rejection.
  const mutationResult = mutation.catch(error => error);
  await entered;
  const resetting = resetOAuthStore({ store: item.store, confirm: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lstatSync(path.join(dataDir, item.filename)).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(dataDir, 'mcp-credential-recovery'))).toBe(false);
  } finally { release(); }
  expect(await mutationResult).toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE' });
  expect((await resetting).status).toBe(200);
});
