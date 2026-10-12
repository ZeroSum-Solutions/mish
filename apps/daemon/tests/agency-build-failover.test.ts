// `failover` on `POST /api/agency/build` (G8 matrix prerequisite: the live-build matrix needs
// every family x provider run with failover explicitly OFF, and until this field existed there
// was no way to ask for that — `packages/agency-fast-lane/src/build.ts:207-209` already supports
// `fallbackProvider: null`, but nothing on the request could reach it).
//
// `failover` defaults to `true` (today's behavior, unchanged): the daemon passes nothing to
// `runBuild`, so `buildSite`'s own default fallback still applies. `failover: false` reaches
// `runBuild` as `fallbackProvider: null` and is recorded on the build's snapshot so a client (or
// the G8 harness) can confirm which setting a build actually ran with.
//
// Harness copied from `agency-build-provider.test.ts`: `registerAgencyBuildRoutes` mounted on a
// bare Express app with a fake `runBuild`, so nothing here spends a model call or reaches Jev.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgencyBuildResponse, AgencyBuildSnapshot, ApiErrorResponse } from '@open-design/contracts';
import type { BuildDeps, BuildInput, BuildResult, PreparedBuild } from '@open-design/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

const RECIPE = {
  schemaVersion: 2,
  family: 'wrenfield',
  revision: 1,
  brand: { name: 'Wrenfield Remodeling' },
  sections: [{ id: 'hero', type: 'hero', text: { heading: 'Heading', body: 'Body copy.' } }],
};

type BuiltResult = Extract<BuildResult, { outcome: 'built' }>;
type Report = BuiltResult['report'];

function reportFixture(overrides: Partial<Report> = {}): Report {
  return {
    family: 'wrenfield',
    mode: 'sections',
    model: 'deepseek-chat',
    entry: 'wrenfield-r1.html',
    revision: 1,
    projectId: 'project-1',
    timings: { totalMs: 900, registeredMs: 900 },
    calls: 2,
    repairs: 0,
    retries: 0,
    paints: 1,
    usage: { input: 100, output: 50, cachedRead: 0 },
    applied: 2,
    missing: [],
    nulled: [],
    truncated: [],
    units: [],
    recipeDigest: 'digest-one',
    recipe: RECIPE,
    html: `<!doctype html><p>${BRIEF}</p>`,
    manifest: { entry: 'wrenfield-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'digest-one', revision: '1', family: 'wrenfield' } } },
    approvedAssets: [],
    ...overrides,
  } as Report;
}

let server: http.Server;
let baseUrl: string;
let tempRoot = '';
let buildImpl: (input: BuildInput, deps: BuildDeps) => Promise<BuildResult>;
let calls: BuildInput[];
let repairPrepared: PreparedBuild | undefined;
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's (or fork's, or repair's) fire-and-forget `persist()` write never races the
 * directory it writes into being removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-build-failover-'));
  calls = [];
  repairPrepared = undefined;
  buildImpl = async () => { throw new Error('buildImpl not configured for this test'); };

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  routes = registerAgencyBuildRoutes(app, {
    http: {
      sendApiError,
      createSseResponse,
      isLocalSameOrigin: () => true,
      resolvedPortRef: { current: 0 },
    } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: [] } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: () => Promise.resolve('jev-key') }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input, deps) => {
        calls.push(input);
        return buildImpl(input, deps);
      },
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: () => Promise.resolve('jev-key'),
        resolveModelKey: () => Promise.resolve('model-key'),
      },
      loadPackage: async (family) => ({ family, schema: {} }) as never,
      buildsFile: path.join(tempRoot, 'agency-builds', 'index.json'),
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Drains any build still in flight, then the store's own save/load chain, so `rmSync` below
  // never races a `persist()` write that is still touching `tempRoot/agency-builds/`.
  await routes.idle();
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
  tempRoot = '';
});

const post = (url: string, body?: unknown) =>
  fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (url: string) => fetch(`${baseUrl}${url}`);
const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;

async function pollUntil(id: string, predicate: (snapshot: AgencyBuildSnapshot) => boolean): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await buildOf(await get(`/api/agency/builds/${id}`));
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition never became true for build ${id}`);
}

function builtResult(overrides: Partial<Report> = {}): BuiltResult {
  return {
    outcome: 'built',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
    family: 'wrenfield',
    projectId: 'project-1',
    report: reportFixture(overrides),
  };
}

describe('failover on POST /api/agency/build', () => {
  it('failover: false reaches runBuild as fallbackProvider: null', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return builtResult();
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', failover: false }));
    const done = await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fallbackProvider).toBeNull();
    expect(started.failover).toBe(false);
    expect(done.failover).toBe(false);
  });

  it('omitted failover defaults to true and passes no fallbackProvider override', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return builtResult();
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fallbackProvider).toBeUndefined();
    expect(started.failover).toBe(true);
  });

  it('failover: true is equivalent to omitting it', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return builtResult();
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', failover: true }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fallbackProvider).toBeUndefined();
    expect(started.failover).toBe(true);
  });

  it('refuses a non-boolean failover the same way a bad mode is refused', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', failover: 'off' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('a fork of a failover: false build keeps failover off without the fork request naming it', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return builtResult();
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', failover: false }));
    await pollUntil(started.id, (s) => s.status === 'done');
    expect(calls).toHaveLength(1);

    const forked = await buildOf(await post(`/api/agency/builds/${started.id}/fork`));
    expect(forked.failover).toBe(false);
    await pollUntil(forked.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(2);
    expect(calls[1]?.fallbackProvider).toBeNull();
  });

  it('a repair on a failover: false build after a verify-after run keeps failover off', async () => {
    const FLAGGED_PATH = 'sections[0].text.heading';
    buildImpl = async (input) => {
      if (input.verify === 'after') {
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
          flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
        });
        return builtResult({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } });
      }
      repairPrepared = await input.prepare(input.family === 'auto' ? 'wrenfield' : input.family);
      return builtResult({ recipe: RECIPE, verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 4 } });
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after', failover: false }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fallbackProvider).toBeNull();

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.fallbackProvider).toBeNull();
    expect(repairPrepared).toBeDefined();
  });
});
