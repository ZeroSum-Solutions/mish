// The daemon's own TypeSafe (Jev) credential: `GET`/`PUT /api/agency/config`, the store behind
// them, and the rule that a saved or cleared key takes effect on the next Jev request without a
// daemon restart.
//
// Nothing here reads a real secret. The vault reader is a stub, `TYPESAFE_API_KEY` is set and
// deleted per test, and the one test that exercises a real `createJevRouter` gives it a fake
// `fetchImpl`, so the Authorization header can be inspected without a network call.

import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencyJevConfigResponse, ApiErrorResponse } from '@open-design/contracts';
import type { AgencyModelProvider } from '@open-design/contracts';
import { AGENCY_JEV_KEY_ENV, AGENCY_JEV_KEY_MAX_CHARS, AGENCY_MODEL_KEY_ENV, AGENCY_MODEL_PROVIDERS } from '@open-design/contracts';
import { PROVIDERS, createProviderKeyResolver } from '@open-design/agency-fast-lane/deepseek';
import { loadAtlasData } from '@open-design/agency-fast-lane/atlas';
import { createJevProfiler } from '@open-design/agency-fast-lane/profile';
import { DEFAULT_CONSENSUS_K, createJevRouter } from '@open-design/agency-fast-lane/route';
import { loadDesignTaxonomy } from '@open-design/agency-fast-lane/taxonomy';

import {
  AgencyJevConfigUnreadableError,
  AgencyModelKeyUnavailableError,
  createAgencyJevKeyStore,
  freshPerGeneration,
} from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { jevKeyResolver, registerDesignIndexRoutes } from '../src/routes/design-index.js';

const { atlas, registry } = await loadAtlasData();
const taxonomy = await loadDesignTaxonomy();

const STORED_KEY = 'stored-key-never-logged';
const ENV_KEY = 'env-key-never-logged';
const VAULT_KEY = 'vault-key-never-logged';

let dataDir = '';
let vaultReads = 0;
let vaultAnswer: () => Promise<string>;
const priorEnv = process.env[AGENCY_JEV_KEY_ENV];

function makeStore() {
  return createAgencyJevKeyStore({
    dataDir,
    readVaultSecret: () => {
      vaultReads += 1;
      return vaultAnswer();
    },
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'od-agency-config-'));
  vaultReads = 0;
  vaultAnswer = async () => VAULT_KEY;
  delete process.env[AGENCY_JEV_KEY_ENV];
});

afterEach(() => {
  if (dataDir) rmSync(dataDir, { force: true, recursive: true });
  dataDir = '';
  if (priorEnv === undefined) delete process.env[AGENCY_JEV_KEY_ENV];
  else process.env[AGENCY_JEV_KEY_ENV] = priorEnv;
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the Jev key store', () => {
  it('reports unset and refuses to resolve when nothing is configured', async () => {
    vaultAnswer = async () => {
      throw new Error('zsvault is not installed on this machine');
    };
    const store = makeStore();

    expect(await store.status()).toMatchObject({ configured: false, source: 'unset' });
    await expect(store.resolveKey()).rejects.toThrow();
  });

  it('prefers the environment variable over a stored key and never reaches the vault', async () => {
    const store = makeStore();
    await store.save(STORED_KEY);
    process.env[AGENCY_JEV_KEY_ENV] = ENV_KEY;

    expect(await store.status()).toMatchObject({ configured: true, source: 'env' });
    expect(await store.resolveKey()).toBe(ENV_KEY);
    expect(vaultReads).toBe(0);
  });

  it('prefers a stored key over the local vault', async () => {
    const store = makeStore();
    expect(await store.save(STORED_KEY)).toMatchObject({ configured: true, source: 'stored' });

    expect(await store.status()).toMatchObject({ configured: true, source: 'stored' });
    expect(await store.resolveKey()).toBe(STORED_KEY);
    expect(vaultReads).toBe(0);
  });

  it('falls back to the local vault only when neither env nor a stored key answers', async () => {
    const store = makeStore();

    expect(await store.status()).toMatchObject({ configured: true, source: 'vault' });
    expect(await store.resolveKey()).toBe(VAULT_KEY);
    expect(vaultReads).toBeGreaterThan(0);
  });

  it('reports unset rather than failing when the vault read fails', async () => {
    vaultAnswer = async () => {
      throw new Error('failed to read typesafe_api_key from zsvault');
    };
    const store = makeStore();

    expect(await store.status()).toMatchObject({ configured: false, source: 'unset' });
  });

  it('writes the key to a 0600 file under the data dir and clears it back out', async () => {
    const store = makeStore();
    await store.save(STORED_KEY);

    const file = path.join(dataDir, 'agency-config.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ jev: { apiKey: STORED_KEY } });

    vaultAnswer = async () => {
      throw new Error('no vault here');
    };
    expect(await store.clear()).toMatchObject({ configured: false, source: 'unset' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('refuses to guess at a corrupt config file, rather than letting the vault take over', async () => {
    // "Unreadable" and "absent" are different facts. Treating the first as the second would hand
    // the machine back to the vault — silently, on the one screen built to explain where the key
    // in effect comes from — and leave a corrupt file nobody is told about.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dataDir, 'agency-config.json'), 'not json at all', 'utf8');
    const store = makeStore();

    await expect(store.status()).rejects.toBeInstanceOf(AgencyJevConfigUnreadableError);
    await expect(store.resolveKey()).rejects.toBeInstanceOf(AgencyJevConfigUnreadableError);
    expect(vaultReads, 'an unreadable stored key must not fall through to the vault').toBe(0);
  });

  it('refuses the same way when the config file cannot be opened at all', async () => {
    const { chmodSync, writeFileSync } = await import('node:fs');
    const file = path.join(dataDir, 'agency-config.json');
    writeFileSync(file, JSON.stringify({ jev: { apiKey: STORED_KEY } }), 'utf8');
    chmodSync(file, 0o000);
    const store = makeStore();

    try {
      await expect(store.status()).rejects.toBeInstanceOf(AgencyJevConfigUnreadableError);
      expect(vaultReads).toBe(0);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it.each([
    ['no jev key at all', {}],
    ['a jev object with no apiKey property', { jev: {} }],
  ])('treats %s as simply absent', async (_label, document) => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dataDir, 'agency-config.json'), JSON.stringify(document), 'utf8');

    expect(await makeStore().status()).toMatchObject({ configured: true, source: 'vault' });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a key with a line break in it', 'part one\npart two'],
    ['a key with a space in it', 'part one part two'],
    ['leading and trailing whitespace', '  a-key  '],
    ['a key past the length cap', 'k'.repeat(AGENCY_JEV_KEY_MAX_CHARS + 1)],
  ])('refuses a stored apiKey that is %s, instead of quietly falling back', async (_label, stored) => {
    // A key that is PRESENT but unusable is a broken file, not an empty one. Trimming it into
    // shape would store something the user cannot reproduce; treating it as absent would hand
    // the machine to the vault without anyone being told the file needs repairing. Both are the
    // same mistake in different clothes, so neither is made.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path.join(dataDir, 'agency-config.json'),
      JSON.stringify({ jev: { apiKey: stored } }),
      'utf8',
    );
    const store = makeStore();

    await expect(store.status()).rejects.toBeInstanceOf(AgencyJevConfigUnreadableError);
    await expect(store.resolveKey()).rejects.toBeInstanceOf(AgencyJevConfigUnreadableError);
    expect(vaultReads, 'a broken stored key must never reach the vault').toBe(0);
  });

  it('accepts a stored key exactly as written, without normalizing it', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path.join(dataDir, 'agency-config.json'),
      JSON.stringify({ jev: { apiKey: STORED_KEY } }),
      'utf8',
    );

    expect(await makeStore().resolveKey()).toBe(STORED_KEY);
    expect(vaultReads).toBe(0);
  });

  it('logs nothing of the file, the path or the error when a read fails', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dataDir, 'agency-config.json'), `{"jev":{"apiKey":"${STORED_KEY}"`, 'utf8');
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      await makeStore().resolveKey().catch(() => {});
    } finally {
      spy.mockRestore();
    }
    const text = JSON.stringify(logged);
    expect(text).not.toContain(STORED_KEY);
    expect(text).not.toContain(dataDir);
    expect(text).not.toContain('JSON');
  });
});

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

describe('the Jev key writer', () => {
  const file = () => path.join(dataDir, 'agency-config.json');

  it('brings the owner-only mode over with the rename instead of relaxing an existing file', async () => {
    // A file already at the final path with a permissive mode is the case that tells the two
    // designs apart: a writer that opened the final path and chmod-ed afterwards would leave the
    // key world-readable for the window in between. A rename replaces the inode, so the 0600
    // can only have come from the temp file the key was actually written into.
    const { chmodSync, writeFileSync } = await import('node:fs');
    writeFileSync(file(), '{}', 'utf8');
    chmodSync(file(), 0o666);

    await makeStore().save(STORED_KEY);

    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('never writes the key into a temp file that was left behind', async () => {
    // The previous writer named its temp file after the pid alone, so a crashed or concurrent
    // daemon with the same pid — or a planted file — received the key at a predictable path.
    const { readFileSync: read, writeFileSync } = await import('node:fs');
    const predictable = `${file()}.${process.pid}.tmp`;
    writeFileSync(predictable, 'planted', { encoding: 'utf8', mode: 0o666 });

    await makeStore().save(STORED_KEY);

    expect(read(predictable, 'utf8')).toBe('planted');
  });

  it('leaves one consistent document behind when two writes race, and no temp files', async () => {
    const { readdirSync } = await import('node:fs');
    const store = makeStore();

    await Promise.all([store.save('first-key-never-logged'), store.save('second-key-never-logged')]);

    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { jev?: { apiKey?: string } };
    expect(['first-key-never-logged', 'second-key-never-logged']).toContain(parsed.jev?.apiKey);
    expect(await store.status()).toMatchObject({ configured: true, source: 'stored' });
    expect(readdirSync(dataDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('cleans up after itself when the rename cannot happen', async () => {
    const { readdirSync } = await import('node:fs');
    // A directory where the file should be: the rename fails, the temp file must not survive it.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(file());

    await expect(makeStore().save(STORED_KEY)).rejects.toThrow();
    expect(readdirSync(dataDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The generation guard: a save is visible to the next request, not the next boot
// ---------------------------------------------------------------------------

describe('freshPerGeneration', () => {
  it('rebuilds its value exactly when the generation moves', async () => {
    const store = makeStore();
    let builds = 0;
    const get = freshPerGeneration(store.generation, () => {
      builds += 1;
      return builds;
    });

    expect(get()).toBe(1);
    expect(get()).toBe(1);

    await store.save(STORED_KEY);
    expect(get()).toBe(2);
    expect(get()).toBe(2);

    await store.clear();
    expect(get()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe('the /api/agency/config routes', () => {
  let server: http.Server;
  let baseUrl = '';
  let sameOrigin = true;
  let store: ReturnType<typeof createAgencyJevKeyStore>;
  let fetchCalls: Array<{ authorization: string }> = [];

  beforeEach(async () => {
    sameOrigin = true;
    fetchCalls = [];
    store = makeStore();

    // The real router and profiler over a fake transport, wired exactly as `server.ts` wires
    // them — so the cache-invalidation assertion below is about production composition, not a
    // stand-in that could not have the bug.
    const apiKey = jevKeyResolver(() => store.resolveKey());
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ authorization: headers.Authorization ?? '' });
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const router = freshPerGeneration(store.generation, () => createJevRouter({ apiKey, fetchImpl }));
    const profiler = freshPerGeneration(store.generation, () => createJevProfiler({ apiKey, fetchImpl }));

    const app = express();
    app.use(express.json());
    registerDesignIndexRoutes(app, {
      http: {
        sendApiError,
        isLocalSameOrigin: () => sameOrigin,
        resolvedPortRef: { current: 0 },
      } as never,
      designIndex: {
        atlas,
        registry,
        taxonomy,
        jevKeyStore: store,
        router: { route: (input) => router().route(input) },
        profiler: { profile: (input) => profiler().profile(input) },
        indexFile: path.join(dataDir, 'index.json'),
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const getConfig = () => fetch(`${baseUrl}/api/agency/config`);
  const putConfig = (body: unknown) =>
    fetch(`${baseUrl}/api/agency/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const profileText = (input: string) =>
    fetch(`${baseUrl}/api/design-index/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'brief', input }),
    });
  const routeBrief = (brief: string) =>
    fetch(`${baseUrl}/api/agency/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
    });
  const errorOf = async (response: Response) => ((await response.json()) as ApiErrorResponse).error;

  it('reports the source and never returns the key itself', async () => {
    vaultAnswer = async () => {
      throw new Error('no vault here');
    };

    const before = await getConfig();
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ configured: false, source: 'unset' });

    const saved = await putConfig({ apiKey: STORED_KEY });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(JSON.parse(savedText) as AgencyJevConfigResponse).toMatchObject({ configured: true, source: 'stored' });
    expect(savedText).not.toContain(STORED_KEY);
    expect(savedText).not.toContain(STORED_KEY.slice(-4));

    const after = await getConfig();
    expect(await after.text()).not.toContain(STORED_KEY);
  });

  it.each([
    ['an empty body', {}],
    ['a non-string key', { apiKey: 42 }],
    ['an empty key', { apiKey: '   ' }],
    ['a key with whitespace inside', { apiKey: 'part one part two' }],
    ['an over-long key', { apiKey: 'k'.repeat(AGENCY_JEV_KEY_MAX_CHARS + 1) }],
    ['clear: false', { clear: false }],
    ['both at once', { apiKey: 'a-key', clear: true }],
    ['an array', ['a-key']],
    ['a key with an unknown companion field', { apiKey: 'a-key', extra: true }],
    ['a clear with an unknown companion field', { clear: true, extra: true }],
  ])('rejects %s with 400 and stores nothing', async (_label, body) => {
    const response = await putConfig(body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(await store.status()).toMatchObject({ source: 'vault' });
  });

  it.each([
    ['empty', { apiKey: '   ' }, 'empty'],
    ['whitespace', { apiKey: 'part one' }, 'whitespace'],
    ['too-long', { apiKey: 'k'.repeat(AGENCY_JEV_KEY_MAX_CHARS + 1) }, 'too-long'],
    ['shape', { clear: false }, 'shape'],
    ['shape for an unknown field', { apiKey: 'a-key', extra: 1 }, 'shape'],
  ])('carries a stable %s reason a client can translate', async (_label, body, reason) => {
    // The daemon has no locale, so its sentence is English on every screen. The reason is the
    // part a client is allowed to build its own copy from.
    const error = await errorOf(await putConfig(body));
    expect(error.details).toEqual({ kind: 'agency-jev-config', reason });
  });

  it('answers a body the parser could not read at all without echoing a byte of it', async () => {
    // The body-parser rejects this before any handler sees it, and its own error carries the
    // offending body and a snippet of it in the message. On the one route whose body is a
    // credential, neither may reach the response or the log.
    const marker = 'sk-typesafe-MALFORMED-BODY-MARKER';
    const logged: unknown[][] = [];
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    let text: string;
    let status: number;
    try {
      const response = await fetch(`${baseUrl}/api/agency/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: `{"apiKey":"${marker}"`,
      });
      status = response.status;
      text = await response.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(status).toBe(400);
    expect(text).not.toContain(marker);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'BAD_REQUEST',
      details: { kind: 'agency-jev-config', reason: 'shape' },
    });
    expect(JSON.stringify(logged)).not.toContain(marker);
    expect(await store.status()).toMatchObject({ source: 'vault' });
  });

  it('answers GET with a fixed code when the stored key file is unreadable', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dataDir, 'agency-config.json'), '{ corrupt', 'utf8');

    const response = await getConfig();
    expect(response.status).toBe(500);
    const error = await errorOf(response);
    expect(error.code).toBe('AGENCY_CONFIG_UNREADABLE');
    // A fixed sentence: no path, no parser detail, nothing about what the file held.
    expect(JSON.stringify(error)).not.toContain(dataDir);
    expect(JSON.stringify(error)).not.toContain('JSON');
  });

  it('clears idempotently, and reports the source still in effect afterwards', async () => {
    // Nothing is stored; the vault still answers. A clear must succeed rather than fail on
    // "there was nothing to clear", and must report what the daemon will actually use next.
    const response = await putConfig({ clear: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, source: 'vault' });
  });

  it('refuses a cross-origin request on both verbs', async () => {
    sameOrigin = false;
    expect((await getConfig()).status).toBe(403);
    expect((await putConfig({ apiKey: STORED_KEY })).status).toBe(403);
  });

  it('uses a newly saved key on the very next Jev request, with no restart', async () => {
    vaultAnswer = async () => {
      throw new Error('no vault here');
    };

    // Nothing configured: the route answers 503 rather than calling Jev. The router's own
    // `consensusK`-way vote (default `DEFAULT_CONSENSUS_K`, wired unpinned here exactly as
    // `server.ts` wires the live endpoint) never throws — every vote fails to resolve a key and
    // the route handler maps that unanimous vote failure to 503 itself; see
    // `isUnanimousVoteFailure` in `design-index.ts`.
    const unconfigured = await routeBrief('A dental practice in Riverbend.');
    expect(unconfigured.status).toBe(503);
    expect((await errorOf(unconfigured)).code).toBe('JEV_UNAVAILABLE');
    expect(fetchCalls).toHaveLength(0);

    expect((await putConfig({ apiKey: STORED_KEY })).status).toBe(200);
    expect((await routeBrief('A dental practice in Riverbend.')).status).toBe(200);
    // One Jev request per concurrent vote in the round, all carrying the same key.
    expect(fetchCalls).toHaveLength(DEFAULT_CONSENSUS_K);
    for (const call of fetchCalls) expect(call.authorization).toBe(`Bearer ${STORED_KEY}`);

    // And a cleared key stops working just as immediately.
    expect((await putConfig({ clear: true })).status).toBe(200);
    const cleared = await routeBrief('A dental practice in Riverbend.');
    expect(cleared.status).toBe(503);
    expect((await errorOf(cleared)).code).toBe('JEV_UNAVAILABLE');
    // The clear fails key resolution before any vote reaches fetch, so no new calls land.
    expect(fetchCalls).toHaveLength(DEFAULT_CONSENSUS_K);
  });

  it('gives the profiler the new key too, not only the router', async () => {
    // The profiler is built from the same resolver and cached the same way, so it needs its own
    // proof: constructing it per generation is not the same as calling it per generation.
    //
    // The fake transport answers with an empty answer set, which the profiler refuses as
    // malformed — so the expected pre-clear status is 502 JEV_FAILED, not 200. That is still the
    // assertion this test needs: 502 means the key resolved and the request went out, and the
    // captured Authorization header says which key it carried. Only an unresolvable key gives
    // 503, which is exactly what the clear below must produce — with the vault silent, so the
    // clear leaves nothing behind it.
    vaultAnswer = async () => {
      throw new Error('no vault here');
    };
    await putConfig({ apiKey: STORED_KEY });
    expect((await profileText('a page')).status).toBe(502);
    await putConfig({ apiKey: 'second-key-never-logged' });
    expect((await profileText('a page')).status).toBe(502);

    expect([...new Set(fetchCalls.map((call) => call.authorization))]).toEqual([
      `Bearer ${STORED_KEY}`,
      'Bearer second-key-never-logged',
    ]);

    expect((await putConfig({ clear: true })).status).toBe(200);
    const cleared = await profileText('a page');
    expect(cleared.status).toBe(503);
    expect((await errorOf(cleared)).code).toBe('JEV_UNAVAILABLE');
  });

  it('picks up a replacement key without a restart', async () => {
    await putConfig({ apiKey: STORED_KEY });
    await routeBrief('A brief.');
    await putConfig({ apiKey: 'second-key-never-logged' });
    await routeBrief('A brief.');

    // Each `routeBrief` awaits its whole consensus round before the next one starts, so the two
    // rounds' calls never interleave — only the `DEFAULT_CONSENSUS_K` calls within a round race
    // each other, and they all carry that round's key.
    expect(fetchCalls).toHaveLength(DEFAULT_CONSENSUS_K * 2);
    const [firstRound, secondRound] = [
      fetchCalls.slice(0, DEFAULT_CONSENSUS_K),
      fetchCalls.slice(DEFAULT_CONSENSUS_K),
    ];
    for (const call of firstRound) expect(call.authorization).toBe(`Bearer ${STORED_KEY}`);
    for (const call of secondRound) expect(call.authorization).toBe('Bearer second-key-never-logged');
  });
});

// ---------------------------------------------------------------------------
// The fill-model keys (DeepSeek, Cerebras): same file, same order, same redaction
// ---------------------------------------------------------------------------

describe('the fill-model keys', () => {
  const MODEL_ENV = [...Object.values(AGENCY_MODEL_KEY_ENV), 'OD_OPENROUTER_API_KEY'];
  const priorModelEnv = Object.fromEntries(MODEL_ENV.map((name) => [name, process.env[name]]));
  let modelVaultReads: string[] = [];
  let modelVaultAnswer: (provider: AgencyModelProvider) => Promise<string>;

  function makeModelStore() {
    return createAgencyJevKeyStore({
      dataDir,
      readVaultSecret: () => {
        vaultReads += 1;
        return vaultAnswer();
      },
      readModelVaultSecret: (provider) => {
        modelVaultReads.push(provider);
        return modelVaultAnswer(provider);
      },
    });
  }

  beforeEach(() => {
    modelVaultReads = [];
    modelVaultAnswer = async (provider) => `vault-${provider}-never-logged`;
    for (const name of MODEL_ENV) delete process.env[name];
  });

  afterEach(() => {
    for (const name of MODEL_ENV) {
      if (priorModelEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorModelEnv[name];
    }
  });

  // OpenRouter backs the Gemini design reviewer, not the fast lane, so the fast-lane parity checks skip it.
  const FAST_LANE_PROVIDERS = AGENCY_MODEL_PROVIDERS.filter((provider): provider is Exclude<typeof provider, 'openrouter'> => provider !== 'openrouter');

  it('names the same env var per provider as the fast lane does', () => {
    for (const provider of FAST_LANE_PROVIDERS) {
      expect(AGENCY_MODEL_KEY_ENV[provider]).toBe(PROVIDERS[provider].envKey);
    }
    expect([...FAST_LANE_PROVIDERS].sort()).toEqual(Object.keys(PROVIDERS).sort());
    expect(AGENCY_MODEL_PROVIDERS).toContain('openrouter');
  });

  it.each(AGENCY_MODEL_PROVIDERS)('%s: env wins, and a rejecting vault is read zero times', async (provider) => {
    modelVaultAnswer = async () => {
      throw new Error('zsvault is not installed on this machine');
    };
    process.env[AGENCY_MODEL_KEY_ENV[provider]] = `env-${provider}-never-logged`;
    const store = makeModelStore();

    expect(await store.resolveModelKey(provider)).toBe(`env-${provider}-never-logged`);
    expect(await store.modelStatus(provider)).toEqual({ configured: true, source: 'env' });
    expect(modelVaultReads.filter((read) => read === provider)).toHaveLength(0);
  });

  it.each(AGENCY_MODEL_PROVIDERS)('%s: a stored key beats the vault', async (provider) => {
    const store = makeModelStore();
    await store.saveModelKey(provider, `stored-${provider}-never-logged`);

    expect(await store.resolveModelKey(provider)).toBe(`stored-${provider}-never-logged`);
    expect(await store.modelStatus(provider)).toEqual({ configured: true, source: 'stored' });
    expect(modelVaultReads.filter((read) => read === provider)).toHaveLength(0);
  });

  it.each(AGENCY_MODEL_PROVIDERS)('%s: a blank env var is absent and falls through to stored, then the vault', async (provider) => {
    process.env[AGENCY_MODEL_KEY_ENV[provider]] = '   ';
    const store = makeModelStore();

    expect(await store.resolveModelKey(provider)).toBe(`vault-${provider}-never-logged`);
    expect(await store.modelStatus(provider)).toEqual({ configured: true, source: 'vault' });

    await store.saveModelKey(provider, `stored-${provider}-never-logged`);
    expect(await store.resolveModelKey(provider)).toBe(`stored-${provider}-never-logged`);
    expect(await store.modelStatus(provider)).toEqual({ configured: true, source: 'stored' });
  });

  it.each(FAST_LANE_PROVIDERS)('%s: the env value is trimmed exactly as the fast lane trims it', async (provider) => {
    process.env[AGENCY_MODEL_KEY_ENV[provider]] = `  env-${provider}-never-logged\n`;
    const store = makeModelStore();
    const fastLane = createProviderKeyResolver(process.env, async () => {
      throw new Error('the vault is not read when the env supplies the key');
    });

    expect(await store.resolveModelKey(provider)).toBe(await fastLane(provider));
    expect(await store.resolveModelKey(provider)).toBe(`env-${provider}-never-logged`);
  });

  it('falls back to the vault, and rejects with a provider-only error when nothing answers', async () => {
    const store = makeModelStore();
    expect(await store.resolveModelKey('deepseek')).toBe('vault-deepseek-never-logged');

    modelVaultAnswer = async () => {
      throw new Error('failed to read cerebras_api_key from zsvault');
    };
    await expect(store.resolveModelKey('cerebras')).rejects.toThrow(AgencyModelKeyUnavailableError);
    await expect(store.resolveModelKey('cerebras')).rejects.toThrow('no cerebras key is configured on this daemon');
    expect(await store.modelStatus('cerebras')).toEqual({ configured: false, source: 'unset' });
  });

  it('saving the Jev key keeps the model keys, and saving a model key keeps the Jev key', async () => {
    const store = makeModelStore();
    await store.saveModelKey('deepseek', 'stored-deepseek-never-logged');
    await store.save(STORED_KEY);
    await store.saveModelKey('cerebras', 'stored-cerebras-never-logged');

    const parsed = JSON.parse(readFileSync(path.join(dataDir, 'agency-config.json'), 'utf8'));
    expect(parsed).toEqual({
      jev: { apiKey: STORED_KEY },
      models: { deepseek: { apiKey: 'stored-deepseek-never-logged' }, cerebras: { apiKey: 'stored-cerebras-never-logged' } },
    });

    await store.clear();
    await store.clearModelKey('cerebras');
    expect(JSON.parse(readFileSync(path.join(dataDir, 'agency-config.json'), 'utf8'))).toEqual({
      models: { deepseek: { apiKey: 'stored-deepseek-never-logged' } },
    });
    expect(await store.resolveModelKey('deepseek')).toBe('stored-deepseek-never-logged');
  });

  it('keeps every key when Jev and model writes race', async () => {
    const store = makeModelStore();
    await Promise.all([
      store.save(STORED_KEY),
      store.saveModelKey('deepseek', 'stored-deepseek-never-logged'),
      store.saveModelKey('cerebras', 'stored-cerebras-never-logged'),
    ]);
    const parsed = JSON.parse(readFileSync(path.join(dataDir, 'agency-config.json'), 'utf8'));
    expect(parsed.jev.apiKey).toBe(STORED_KEY);
    expect(Object.keys(parsed.models).sort()).toEqual(['cerebras', 'deepseek']);
  });

  describe('over HTTP', () => {
    let server: http.Server;
    let baseUrl = '';
    let store: ReturnType<typeof createAgencyJevKeyStore>;

    beforeEach(async () => {
      store = makeModelStore();
      const app = express();
      app.use(express.json());
      registerDesignIndexRoutes(app, {
        http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as never,
        designIndex: {
          atlas,
          registry,
          taxonomy,
          jevKeyStore: store,
          router: { route: async () => { throw new Error('not used'); } },
          profiler: { profile: async () => { throw new Error('not used'); } },
          indexFile: path.join(dataDir, 'index.json'),
        } as never,
      });
      server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const put = (body: unknown) =>
      fetch(`${baseUrl}/api/agency/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('GET reports every model key status and never a key', async () => {
      process.env.DEEPSEEK_API_KEY = 'env-deepseek-never-logged';
      await store.saveModelKey('cerebras', 'stored-cerebras-never-logged');

      const response = await fetch(`${baseUrl}/api/agency/config`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect((JSON.parse(text) as AgencyJevConfigResponse).models).toEqual({
        deepseek: { configured: true, source: 'env' },
        cerebras: { configured: true, source: 'stored' },
        openrouter: { configured: true, source: 'vault' }, // the test vault answers for every provider
      });
      expect(text).not.toContain('never-logged');
    });

    it('PUT with a provider stores that key, answers status only, and leaves Jev alone', async () => {
      await store.save(STORED_KEY);
      const response = await put({ provider: 'deepseek', apiKey: 'put-deepseek-never-logged' });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain('put-deepseek-never-logged');
      expect(JSON.parse(text)).toMatchObject({ source: 'stored', models: { deepseek: { configured: true, source: 'stored' } } });
      expect(await store.resolveKey()).toBe(STORED_KEY);

      const cleared = await put({ provider: 'deepseek', clear: true });
      expect(((await cleared.json()) as AgencyJevConfigResponse).models.deepseek.source).toBe('vault');
    });

    it.each([
      ['a malformed Jev section', { jev: { apiKey: 'has a space' }, models: { cerebras: { apiKey: 'stored-cerebras' } } }],
      ['a malformed other model section', { jev: { apiKey: 'jev-ok' }, models: { cerebras: 'not an object' } }],
    ])('PUT refuses before writing when the file holds %s: 409, file unchanged', async (_label, document) => {
      const { readFileSync, writeFileSync } = await import('node:fs');
      const file = path.join(dataDir, 'agency-config.json');
      const before = `${JSON.stringify(document)}\n`;
      writeFileSync(file, before, 'utf8');

      const response = await put({ provider: 'deepseek', apiKey: 'put-deepseek-never-logged' });
      expect(response.status).toBe(409);
      const text = await response.text();
      const error = (JSON.parse(text) as ApiErrorResponse).error;
      expect(error.code).toBe('AGENCY_CONFIG_UNREADABLE');
      expect(error.message).toMatch(/malformed section, so nothing was saved/);
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain('never-logged');
      expect(readFileSync(file, 'utf8')).toBe(before);

      // A clear of an untouched provider is refused the same way, and still writes nothing.
      const cleared = await put({ provider: 'deepseek', clear: true });
      expect(cleared.status).toBe(409);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('PUT on the malformed section itself repairs it: the write replaces exactly that section', async () => {
      const { readFileSync, writeFileSync } = await import('node:fs');
      const file = path.join(dataDir, 'agency-config.json');
      writeFileSync(file, JSON.stringify({ jev: { apiKey: STORED_KEY }, models: { deepseek: { apiKey: 'bad key' } } }), 'utf8');
      const response = await put({ provider: 'deepseek', apiKey: 'fixed-deepseek' });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ jev: { apiKey: STORED_KEY }, models: { deepseek: { apiKey: 'fixed-deepseek' } } });
    });

    const ALL_THREE = {
      jev: { apiKey: 'jev-never-logged' },
      models: { deepseek: { apiKey: 'deepseek-never-logged' }, cerebras: { apiKey: 'cerebras-never-logged' } },
    };

    it.each([
      ['a corrupt (not parseable)', 'corrupt'],
      ['an unreadable (no read permission)', 'unreadable'],
    ] as const)('%s file holding all three keys stays byte-identical after a PUT and a clear', async (_label, kind) => {
      const { chmodSync, writeFileSync } = await import('node:fs');
      const file = path.join(dataDir, 'agency-config.json');
      // Every key is in the bytes; the corrupt variant breaks only the tail.
      const before = kind === 'corrupt' ? `${JSON.stringify(ALL_THREE)}\n}}garbage` : `${JSON.stringify(ALL_THREE)}\n`;
      writeFileSync(file, before, 'utf8');
      if (kind === 'unreadable') chmodSync(file, 0o000);
      try {
        for (const body of [
          { provider: 'deepseek', apiKey: 'put-deepseek-never-logged' },
          { provider: 'cerebras', clear: true },
          { apiKey: 'put-jev-never-logged' },
          { clear: true },
        ]) {
          const response = await put(body);
          expect(response.status, JSON.stringify(body)).toBe(409);
          const text = await response.text();
          expect((JSON.parse(text) as ApiErrorResponse).error.code).toBe('AGENCY_CONFIG_UNREADABLE');
          expect(text).not.toContain(dataDir);
          expect(text).not.toContain('never-logged');
        }
        // The store refuses the same way when called directly.
        await expect(store.saveModelKey('deepseek', 'direct-never-logged')).rejects.toThrow(/nothing was saved/);
        await expect(store.clear()).rejects.toThrow(/nothing was saved/);
      } finally {
        if (kind === 'unreadable') chmodSync(file, 0o600);
      }
      expect(readFileSync(file, 'utf8')).toBe(before);
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(dataDir).filter((name) => name.startsWith('agency-config.json'))).toEqual(['agency-config.json']);
    });

    const repair = (body: unknown) =>
      fetch(`${baseUrl}/api/agency/config/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('repair needs { confirm: true }, then renames the unreadable file aside and never deletes it', async () => {
      const { readdirSync, writeFileSync } = await import('node:fs');
      const file = path.join(dataDir, 'agency-config.json');
      const before = `${JSON.stringify(ALL_THREE)}\n}}garbage`;
      writeFileSync(file, before, 'utf8');

      for (const body of [{}, { confirm: false }, { confirm: true, extra: 1 }]) {
        expect((await repair(body)).status).toBe(400);
      }
      expect(readFileSync(file, 'utf8')).toBe(before);

      const response = await repair({ confirm: true });
      const text = await response.text();
      expect(response.status).toBe(200);
      const answer = JSON.parse(text) as AgencyJevConfigResponse & { repaired: boolean; movedTo: string };
      expect(answer.repaired).toBe(true);
      expect(answer.movedTo).toMatch(/^agency-config\.json\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain('never-logged');
      expect(answer.source).toBe('vault');
      // The old bytes are kept, under the new name; the key file itself is gone.
      expect(readdirSync(dataDir)).toContain(answer.movedTo);
      expect(readFileSync(path.join(dataDir, answer.movedTo), 'utf8')).toBe(before);
      expect(readdirSync(dataDir)).not.toContain('agency-config.json');

      // A save now starts fresh.
      expect((await put({ provider: 'deepseek', apiKey: 'fresh-deepseek' })).status).toBe(200);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ models: { deepseek: { apiKey: 'fresh-deepseek' } } });
    });

    it('repair leaves a healthy or missing file alone', async () => {
      const { readdirSync } = await import('node:fs');
      const missing = (await (await repair({ confirm: true })).json()) as { repaired: boolean; movedTo: string | null };
      expect(missing).toMatchObject({ repaired: false, movedTo: null });

      await store.saveModelKey('cerebras', 'stored-cerebras');
      const file = path.join(dataDir, 'agency-config.json');
      const before = readFileSync(file, 'utf8');
      const healthy = (await (await repair({ confirm: true })).json()) as { repaired: boolean; movedTo: string | null };
      expect(healthy).toMatchObject({ repaired: false, movedTo: null });
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dataDir).filter((name) => name.includes('corrupt'))).toEqual([]);
    });

    it.each([
      ['an unknown provider', { provider: 'openai', apiKey: 'a-key' }, 'shape'],
      ['a provider alone', { provider: 'deepseek' }, 'shape'],
      ['a provider with both fields', { provider: 'deepseek', apiKey: 'a-key', clear: true }, 'shape'],
      ['a provider key with whitespace', { provider: 'cerebras', apiKey: 'part one' }, 'whitespace'],
    ])('rejects %s with 400 %s', async (_label, body, reason) => {
      const response = await put(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiErrorResponse).error.details).toEqual({ kind: 'agency-jev-config', reason });
    });
  });
});
