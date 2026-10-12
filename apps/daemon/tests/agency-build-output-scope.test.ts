// C16 output-scope labels on the daemon: app and dashboard families are static prototypes, and
// every surface a client reads says so — the build snapshot (202, GET status, list), the persisted
// `index.json`, the AG-UI state, the `route` event, and the family endpoints.
//
// Mounted like `agency-build-routes.test.ts` (bare Express, fake `buildSite`), but against the
// REAL bundled family registry, so the labels asserted here are the ones the daemon ships.

import type http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgencyBuildAguiState,
  AgencyBuildListResponse,
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  AgencyFamiliesResponse,
  AgencyFamilySectionsResponse,
} from '@mish/contracts';
import { applyJsonPatch, type JsonPatchOp } from '@mish/agui-adapter';
import { familyRegistry } from '@mish/agency-fast-lane/data';
import type { BuildEvent, BuildInput, BuildResult } from '@mish/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'A sales team that wants one screen for its pipeline.';

type Report = Extract<BuildResult, { outcome: 'built' }>['report'];

function reportFixture(family: string): Report {
  return {
    family,
    mode: 'sections',
    model: 'deepseek-chat',
    entry: `${family}-r1.html`,
    revision: 1,
    projectId: 'project-1',
    timings: { totalMs: 4_000 },
    calls: 1,
    repairs: 0,
    retries: 0,
    paints: 1,
    usage: { input: 1, output: 1, cachedRead: 0 },
    applied: 1,
    missing: [],
    nulled: [],
    truncated: [],
    units: [],
    recipeDigest: 'digest',
    recipe: {},
    html: '<!doctype html>',
    manifest: { entry: `${family}-r1.html`, supportingFiles: [], metadata: {} },
    approvedAssets: [],
  } as unknown as Report;
}

function routedTo(family: string): BuildEvent {
  return {
    type: 'route',
    decision: {
      decision: 'routed',
      spine: { code: 'TU', name: 'Tool use', confidence: 0.8, probabilities: { TU: 0.8 } },
      spines: [{ code: 'TU', probability: 0.8 }],
      archetype: { id: 'TU.01', name: 'Tool', confidence: 0.7 },
      skin: { choice: 'Editorial', confidence: 0.6 },
      family: { id: family, probability: 0.8, basis: 'exact', transfer: 3 },
      candidates: [],
      warnings: [],
      ms: 500,
      calls: 1,
      model: 'jev-1.13.0',
    },
  } as BuildEvent;
}

let server: http.Server;
let baseUrl = '';
let tempRoot = '';
let buildsFile = '';
let buildImpl: (input: BuildInput) => Promise<BuildResult>;
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's fire-and-forget `persist()` write never races the directory it writes into being
 * removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

async function mount(): Promise<void> {
  const app = express();
  app.use(express.json());
  routes = registerAgencyBuildRoutes(app, {
    http: { sendApiError, createSseResponse, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: familyRegistry,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: async () => 'jev-key' }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input) => buildImpl(input),
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: async () => 'jev-key',
        resolveModelKey: async () => 'model-key',
      },
      loadPackage: async (family) => ({ family, schema: { properties: {} }, fixture: { sections: [] } }) as never,
      buildsFile,
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-scope-'));
  buildsFile = path.join(tempRoot, 'agency-builds', 'index.json');
  buildImpl = async (input) => ({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: input.family, projectId: 'project-1', report: reportFixture(input.family) });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Drains any build still in flight, then the store's own save/load chain, so `rmSync` below
  // never races a `persist()` write that is still touching `tempRoot/agency-builds/`. `mount()`
  // may never have been called (a test can fail before reaching it), so guard on `routes`.
  if (routes) await routes.idle();
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
});

const get = (url: string) => fetch(`${baseUrl}${url}`);
async function start(body: Record<string, unknown>): Promise<AgencyBuildSnapshot> {
  const response = await fetch(`${baseUrl}/api/agency/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  return (await response.json() as AgencyBuildResponse).build;
}
async function waitFor(id: string): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { build } = await (await get(`/api/agency/builds/${id}`)).json() as AgencyBuildResponse;
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}
async function aguiState(id: string): Promise<{ opening: AgencyBuildAguiState; final: AgencyBuildAguiState }> {
  const text = await (await get(`/api/agency/builds/${id}/agui`)).text();
  const frames = text.split('\n\n').map((frame) => frame.trim()).filter((frame) => frame.startsWith('data:') || frame.includes('\ndata:'))
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data:'))!.slice(5)));
  let state: any;
  let opening: any;
  for (const data of frames) {
    if (data.type === 'STATE_SNAPSHOT') opening = state = data.snapshot;
    if (data.type === 'STATE_DELTA') state = applyJsonPatch(state, data.delta as JsonPatchOp[]);
  }
  return { opening, final: state };
}
function persisted(): Array<{ snapshot: AgencyBuildSnapshot }> {
  const index = JSON.parse(readFileSync(buildsFile, 'utf8')) as { builds?: Array<{ snapshot: AgencyBuildSnapshot }> };
  return index.builds ?? [];
}

describe('C16 output scope on the daemon', () => {
  it('labels a named dashboard build a static prototype: 202, status, list, index.json and AG-UI state', async () => {
    await mount();
    const queued = await start({ brief: BRIEF, family: 'crm-dashboard' });
    expect(queued.outputScope).toBe('static-prototype');
    const done = await waitFor(queued.id);
    expect(done.status).toBe('done');
    expect(done.outputScope).toBe('static-prototype');

    const list = await (await get('/api/agency/builds')).json() as AgencyBuildListResponse;
    expect(list.builds.find((item) => item.id === queued.id)?.outputScope).toBe('static-prototype');

    await vi.waitFor(() => expect(persisted().find((entry) => entry.snapshot.id === queued.id)?.snapshot.status).toBe('done'));
    expect(persisted().find((entry) => entry.snapshot.id === queued.id)!.snapshot.outputScope).toBe('static-prototype');

    const { opening, final } = await aguiState(queued.id);
    expect(opening.outputScope).toBe('static-prototype');
    expect(final.outputScope).toBe('static-prototype');
  });

  it('labels an auto build at routing: the route event, the snapshot and the AG-UI state', async () => {
    await mount();
    buildImpl = async (input) => {
      input.onEvent?.(routedTo('app-shell'));
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'app-shell', projectId: 'project-1', report: reportFixture('app-shell') };
    };
    const queued = await start({ brief: BRIEF });
    expect(queued.outputScope).toBeUndefined();
    const done = await waitFor(queued.id);
    expect(done.outputScope).toBe('static-prototype');
    expect(done.events.find((event) => event.type === 'route')?.outputScope).toBe('static-prototype');
    expect((await aguiState(queued.id)).final.outputScope).toBe('static-prototype');
  });

  it('labels a site family a site', async () => {
    await mount();
    const done = await waitFor((await start({ brief: BRIEF, family: 'marketing-site' })).id);
    expect(done.outputScope).toBe('site');
    expect((await aguiState(done.id)).final.outputScope).toBe('site');
  });

  it('lists every family with its page kind and output scope, and labels the sections response', async () => {
    await mount();
    const body = await (await get('/api/agency/families')).json() as AgencyFamiliesResponse;
    expect(body.families).toHaveLength(familyRegistry.families.length);
    const prototypes = body.families.filter((entry) => entry.outputScope === 'static-prototype').map((entry) => entry.family).sort();
    expect(prototypes).toEqual(['app-shell', 'crm-dashboard']);
    expect(body.families.find((entry) => entry.family === 'crm-dashboard')).toEqual({ family: 'crm-dashboard', pageKind: 'dashboard', outputScope: 'static-prototype' });
    expect(body.families.find((entry) => entry.family === 'marketing-site')).toEqual({ family: 'marketing-site', pageKind: 'site', outputScope: 'site' });

    const sections = await (await get('/api/agency/families/app-shell/sections')).json() as AgencyFamilySectionsResponse;
    expect(sections.outputScope).toBe('static-prototype');
  });

  it('re-derives the scope of a saved build that has none, or a malformed one, on hydration', async () => {
    mkdirSync(path.dirname(buildsFile), { recursive: true });
    const saved = (id: string, extra: Record<string, unknown>) => ({
      snapshot: { id, status: 'done', family: 'crm-dashboard', events: [], startedAt: '2026-09-23T10:00:00.000Z', finishedAt: '2026-09-23T10:01:00.000Z', ...extra },
    });
    writeFileSync(buildsFile, JSON.stringify({ schema: 'agency-builds/1', builds: [saved('old-build', {}), saved('bad-build', { outputScope: 'working-app' }), saved('site-build', { family: 'marketing-site', outputScope: 'site' })] }));
    await mount();
    for (const id of ['old-build', 'bad-build']) {
      const { build } = await (await get(`/api/agency/builds/${id}`)).json() as AgencyBuildResponse;
      expect(build.outputScope).toBe('static-prototype');
    }
    // The backfill is persisted, not only served: the rewritten index.json carries the scope for
    // every completed record that gained one, and leaves a record that already had it as it was.
    const onDisk = new Map(persisted().map((entry) => [entry.snapshot.id, entry.snapshot]));
    expect(onDisk.get('old-build')?.outputScope).toBe('static-prototype');
    expect(onDisk.get('bad-build')?.outputScope).toBe('static-prototype');
    expect(onDisk.get('old-build')?.status).toBe('done');
    expect(onDisk.get('site-build')?.outputScope).toBe('site');
    expect(onDisk.size).toBe(3);
  });
});
