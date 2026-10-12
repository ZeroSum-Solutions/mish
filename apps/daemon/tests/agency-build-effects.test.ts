// Effects on a fast-lane build (Sol ruling 2026-09-25, catalog-port/sol-wiring-ruling.md §3/§6.4).
//
// Same harness shape as `agency-build-routes.test.ts`: a bare Express app, a fake `runBuild`, and a
// fake `loadPackage` whose packages carry a test-owned `effects` declaration, read through the fast
// lane's real `familyEffectsResponse` over a small test catalog — so nothing here spends a model
// call or depends on which bundled families have declared placements yet.
//
// What these cases hold: a request's `effects` is refused (400) for a bad shape, an unknown
// placement, too many entries, or an id a NAMED family does not allow; it reaches `buildSite`
// unchanged and survives a fork (with `null` resetting it) and a restart; the snapshot carries only
// the ids and fixed codes of the run's result; the `effects` event is counts only; and
// `GET /api/agency/families/:family/effects` answers 404 / empty / populated.

import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  AgencyEffectsResult,
  AgencyFamilyEffectsResponse,
  ApiErrorResponse,
} from '@open-design/contracts';
import { AGENCY_BUILD_MAX_EFFECT_HINTS } from '@open-design/contracts';
import { PageTooLargeError, type BuildDeps, type BuildInput, type BuildResult } from '@open-design/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes, repairEffectsOf } from '../src/routes/agency-build.js';
import { createAgencyBuildStore } from '../src/agency-build-store.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

type BuiltResult = Extract<BuildResult, { outcome: 'built' }>;
type Report = BuiltResult['report'];

function reportFixture(overrides: Record<string, unknown> = {}): Report {
  return {
    family: 'marketing-site',
    mode: 'sections',
    model: 'deepseek-chat',
    entry: 'marketing-site-r1.html',
    revision: 1,
    projectId: 'project-1',
    timings: { totalMs: 4_200, firstTokenMs: 90, registeredMs: 4_100 },
    calls: 2,
    repairs: 0,
    retries: 0,
    paints: 1,
    usage: { input: 1_200, output: 340, cachedRead: 0 },
    applied: 12,
    missing: [],
    nulled: [],
    truncated: [],
    units: [],
    recipeDigest: 'digest-one',
    recipe: {},
    html: '<!doctype html><p>page</p>',
    manifest: { entry: 'marketing-site-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'digest-one', revision: '1', family: 'marketing-site' } } },
    approvedAssets: [],
    ...overrides,
  } as unknown as Report;
}

const MARKETING_OFFER: AgencyFamilyEffectsResponse = {
  family: 'marketing-site',
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: [
    { placement: 'hero-title', host: 'marketing-site-hero-heading', allow: [{ id: 'shiny-text', name: 'Shiny Text', kind: 'css-only', bytes: { js: 2341, css: 1677 } }, { id: 'split-text', name: 'Split Text', kind: 'js', bytes: { js: 4714, css: 696 } }] },
    { placement: 'card-surface', host: 'marketing-site-features', allow: [{ id: 'glass-surface', name: 'Glass Surface', kind: 'css-only', bytes: { js: 3444, css: 2022 } }] },
  ],
};

/** The catalog slice the offers are read from (`BuildInput.effectCatalog`'s shape). */
const CATALOG = {
  components: [
    { id: 'shiny-text', name: 'Shiny Text', kind: 'css-only' as const, bytes: { js: 2341, css: 1677 } },
    { id: 'split-text', name: 'Split Text', kind: 'js' as const, bytes: { js: 4714, css: 696 } },
    { id: 'glass-surface', name: 'Glass Surface', kind: 'css-only' as const, bytes: { js: 3444, css: 2022 } },
  ],
};

/** The marketing-site declaration `MARKETING_OFFER` is read from. */
const MARKETING_DECLARATION = {
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: {
    'hero-title': { host: { id: 'marketing-site-hero-heading' }, allow: ['shiny-text', 'split-text'] },
    'card-surface': { host: { id: 'marketing-site-features' }, allow: ['glass-surface'] },
  },
};

const RESULT: AgencyEffectsResult = {
  mode: 'mixed',
  applied: [
    { placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' },
    { placement: 'card-surface', componentId: 'glass-surface', kind: 'css-only', source: 'jev' },
  ],
  skipped: [{ placement: 'hero-background', reason: 'max-effects' }],
  bytesAdded: 4_120,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempRoot = '';
let server: http.Server | undefined;
let baseUrl = '';
/** `registerAgencyBuildRoutes`'s own completion signal, reassigned on every `startApp()` call
 * (this file remounts mid-test to simulate a restart) so `afterEach` always drains the LATEST
 * mount before `rmSync` — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };
let buildCalls: Array<{ input: BuildInput; deps: BuildDeps }> = [];
let buildImpl: (input: BuildInput) => Promise<BuildResult>;
let loadedFamilies: string[] = [];
/** The families the registry lists, and the `effects` declaration each one's package carries. */
let declarations: Record<string, unknown> = {};

function startApp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  routes = registerAgencyBuildRoutes(app, {
    http: { sendApiError, createSseResponse, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: Object.keys(declarations).map((family) => ({ family, pageKind: family === 'app-shell' ? 'app' : 'site' })) } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: async () => 'jev-key' }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input, deps) => {
        buildCalls.push({ input, deps });
        return buildImpl(input);
      },
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: async () => 'jev-key',
        resolveModelKey: async () => 'model-key',
      },
      loadPackage: async (family) => {
        loadedFamilies.push(family);
        return { family, effects: declarations[family] ?? null } as never;
      },
      effectCatalog: CATALOG,
      buildsFile: path.join(tempRoot, 'agency-builds', 'index.json'),
    },
  });
  server = app.listen(0);
  return new Promise<void>((resolve) => server!.once('listening', () => {
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    resolve();
  }));
}

async function stopApp(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
}

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-effects-'));
  buildCalls = [];
  loadedFamilies = [];
  declarations = { 'marketing-site': MARKETING_DECLARATION, 'app-shell': null };
  buildImpl = async () => ({
    outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
    family: 'marketing-site', projectId: 'project-1', report: reportFixture({ effects: RESULT }),
  });
  await startApp();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await stopApp();
  // Drains any build still in flight, then the store's own save/load chain, so `rmSync` below
  // never races a `persist()` write that is still touching `tempRoot/agency-builds/`.
  await routes.idle();
  rmSync(tempRoot, { force: true, recursive: true });
});

const post = (url: string, body?: unknown) =>
  fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (url: string) => fetch(`${baseUrl}${url}`);
const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;

async function waitFor(id: string): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await buildOf(await get(`/api/agency/builds/${id}`));
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}

async function runToEnd(body: Record<string, unknown>): Promise<AgencyBuildSnapshot> {
  const response = await post('/api/agency/build', body);
  expect(response.status).toBe(202);
  return waitFor((await buildOf(response)).id);
}

async function waitForPersisted(id: string, status: string): Promise<{ builds: Array<{ snapshot: AgencyBuildSnapshot; fork?: Record<string, unknown> }> }> {
  const file = path.join(tempRoot, 'agency-builds', 'index.json');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { builds: Array<{ snapshot: AgencyBuildSnapshot; fork?: Record<string, unknown> }> };
      if (parsed.builds.some((entry) => entry.snapshot.id === id && entry.snapshot.status === status)) return parsed;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`build ${id} never reached "${status}" on disk`);
}

// ---------------------------------------------------------------------------
// POST /api/agency/build
// ---------------------------------------------------------------------------

describe('POST /api/agency/build with effects', () => {
  it('threads auto, off and an allowed record to the build unchanged, and omits it when absent', async () => {
    await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    await runToEnd({ brief: BRIEF, family: 'marketing-site', effects: 'auto' });
    await runToEnd({ brief: BRIEF, family: 'marketing-site', effects: 'off' });
    await runToEnd({ brief: BRIEF, family: 'marketing-site', effects: { 'hero-title': 'split-text', 'card-surface': 'none' } });
    expect(buildCalls.map((call) => (call.input as { effects?: unknown }).effects)).toEqual([
      undefined, 'auto', 'off', { 'hero-title': 'split-text', 'card-surface': 'none' },
    ]);
  });

  it('a final page over the byte budget fails the build with the fixed page-too-large code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    buildImpl = async () => { throw new PageTooLargeError(204_801); };
    const snapshot = await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed (page-too-large): the page is 204801 bytes, at or over the 204800-byte limit' });
    expect(snapshot.projectId).toBeUndefined();
  });

  it('refuses a bad shape, an unknown placement and more than the hint limit with 400', async () => {
    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= AGENCY_BUILD_MAX_EFFECT_HINTS; index += 1) tooMany[`p${index}`] = 'none';
    for (const effects of ['on', 7, ['hero-title'], { footer: 'shiny-text' }, { 'hero-title': 'Shiny Text' }, { 'hero-title': 'cta' }, tooMany]) {
      const response = await post('/api/agency/build', { brief: BRIEF, family: 'auto', effects });
      expect(response.status, JSON.stringify(effects)).toBe(400);
      expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    }
    expect(buildCalls).toHaveLength(0);
  });

  it('refuses, for a named family, an id that family does not allow at that placement', async () => {
    for (const effects of [{ 'hero-title': 'glass-surface' }, { 'hero-background': 'silk' }]) {
      const response = await post('/api/agency/build', { brief: BRIEF, family: 'marketing-site', effects });
      expect(response.status, JSON.stringify(effects)).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe('BAD_REQUEST');
      expect(error.message).toContain(Object.keys(effects)[0]!);
    }
    // A family with no declaration offers nothing, so any named id is refused.
    const app = await post('/api/agency/build', { brief: BRIEF, family: 'app-shell', effects: { 'hero-title': 'shiny-text' } });
    expect(app.status).toBe(400);
    // A family this daemon does not bundle cannot be checked, so a record for it is refused too.
    const unknown = await post('/api/agency/build', { brief: BRIEF, family: 'watson', effects: { 'hero-title': 'shiny-text' } });
    expect(unknown.status).toBe(400);
    expect(buildCalls).toHaveLength(0);
  });

  it('leaves the allowlist to buildSite for family auto, since the family is not known yet', async () => {
    await runToEnd({ brief: BRIEF, effects: { 'hero-background': 'silk' } });
    expect((buildCalls[0]!.input as { effects?: unknown }).effects).toEqual({ 'hero-background': 'silk' });
    expect(loadedFamilies).toEqual([]);
  });

  it('puts the run\'s effects result on the finished snapshot, ids and codes only', async () => {
    buildImpl = async () => ({
      outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
      family: 'marketing-site', projectId: 'project-1',
      report: reportFixture({ effects: { ...RESULT, answers: ['ZZ-JEV-PROSE-ZZ'], applied: RESULT.applied.map((entry) => ({ ...entry, criteria: 'ZZ-JEV-PROSE-ZZ' })) } }),
    });
    const finished = await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    expect(finished.effects).toEqual(RESULT);
    expect(JSON.stringify(finished)).not.toContain('ZZ-JEV-PROSE-ZZ');
  });

  it('drops a result carrying a code outside the closed sets rather than serving it', async () => {
    buildImpl = async () => ({
      outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
      family: 'marketing-site', projectId: 'project-1',
      report: reportFixture({ effects: { ...RESULT, skipped: [{ placement: 'cta', reason: 'Jev thought the brief was quiet' }] } }),
    });
    const finished = await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    expect(finished.status).toBe('done');
    expect(finished.effects).toBeUndefined();
  });

  it('maps the effects event to counts only', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'effects', applied: 2, skipped: 1, ms: 12 } as never);
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
        family: 'marketing-site', projectId: 'project-1', report: reportFixture({ effects: RESULT }),
      };
    };
    const finished = await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    const event = finished.events.find((candidate) => candidate.type === 'effects');
    expect(event).toBeDefined();
    const { seq: _seq, at: _at, ...rest } = event!;
    expect(rest).toEqual({ type: 'effects', ms: 12, label: '2 applied, 1 skipped' });
  });
});

// ---------------------------------------------------------------------------
// Fork and persistence
// ---------------------------------------------------------------------------

describe('effects on a fork and across a restart', () => {
  it('reuses the saved effects, replaces them, and resets them with null', async () => {
    const saved = { 'hero-title': 'shiny-text' };
    const done = await runToEnd({ brief: BRIEF, family: 'marketing-site', effects: saved });

    const reuse = await post(`/api/agency/builds/${done.id}/fork`, {});
    expect(reuse.status).toBe(202);
    await waitFor((await buildOf(reuse)).id);
    expect((buildCalls[1]!.input as { effects?: unknown }).effects).toEqual(saved);

    const replace = await post(`/api/agency/builds/${done.id}/fork`, { effects: 'off' });
    expect(replace.status).toBe(202);
    await waitFor((await buildOf(replace)).id);
    expect((buildCalls[2]!.input as { effects?: unknown }).effects).toBe('off');

    const reset = await post(`/api/agency/builds/${done.id}/fork`, { effects: null });
    expect(reset.status).toBe(202);
    const resetBuild = await waitFor((await buildOf(reset)).id);
    expect((buildCalls[3]!.input as { effects?: unknown }).effects).toBeUndefined();

    // A fork of the reset build takes the default again: nothing was saved for it.
    const again = await post(`/api/agency/builds/${resetBuild.id}/fork`, {});
    await waitFor((await buildOf(again)).id);
    expect((buildCalls[4]!.input as { effects?: unknown }).effects).toBeUndefined();
  });

  it('validates a fork override against the saved build\'s family', async () => {
    const done = await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    const refused = await post(`/api/agency/builds/${done.id}/fork`, { effects: { 'hero-title': 'glass-surface' } });
    expect(refused.status).toBe(400);
    const shape = await post(`/api/agency/builds/${done.id}/fork`, { effects: 'sometimes' });
    expect(shape.status).toBe(400);
    expect(buildCalls).toHaveLength(1);
  });

  it('persists the fork seed\'s effects and the snapshot\'s result, and both survive a restart', async () => {
    const done = await runToEnd({ brief: BRIEF, family: 'marketing-site', effects: { 'hero-title': 'shiny-text' } });
    const onDisk = await waitForPersisted(done.id, 'done');
    const record = onDisk.builds.find((entry) => entry.snapshot.id === done.id)!;
    expect(record.fork?.effects).toEqual({ 'hero-title': 'shiny-text' });
    expect(record.snapshot.effects).toEqual(RESULT);

    await stopApp();
    await startApp();
    const hydrated = await buildOf(await get(`/api/agency/builds/${done.id}`));
    expect(hydrated.effects).toEqual(RESULT);
    const fork = await post(`/api/agency/builds/${done.id}/fork`, {});
    expect(fork.status).toBe(202);
    await waitFor((await buildOf(fork)).id);
    expect((buildCalls.at(-1)!.input as { effects?: unknown }).effects).toEqual({ 'hero-title': 'shiny-text' });
  });
});

describe('the build store', () => {
  it('drops a malformed stored effects value and result on their own, keeping the record', async () => {
    const file = path.join(tempRoot, 'store', 'index.json');
    const store = createAgencyBuildStore(file);
    const snapshot = { id: 'b1', status: 'done', events: [], startedAt: '2026-09-25T00:00:00.000Z', projectId: 'p1' } as AgencyBuildSnapshot;
    const fork = { brief: BRIEF, family: 'marketing-site', mode: 'sections', verify: 'strict', provider: 'deepseek' } as const;

    await store.save({ snapshot: { ...snapshot, effects: RESULT }, fork: { ...fork, effects: 'off' } });
    await store.save({ snapshot: { ...snapshot, id: 'b2', effects: { ...RESULT, mode: 'loud' } as never }, fork: { ...fork, effects: { footer: 'x' } as never } });
    const [good, bad] = await store.load();
    expect(good!.snapshot.effects).toEqual(RESULT);
    expect(good!.fork?.effects).toBe('off');
    expect(bad!.snapshot.id).toBe('b2');
    expect(bad!.snapshot).not.toHaveProperty('effects');
    expect(bad!.fork).toBeDefined();
    expect(bad!.fork).not.toHaveProperty('effects');
  });
});

// ---------------------------------------------------------------------------
// GET /api/agency/families/:family/effects
// ---------------------------------------------------------------------------

describe('GET /api/agency/families/:family/effects', () => {
  it('lists a family\'s placements and allowed components', async () => {
    const response = await get('/api/agency/families/marketing-site/effects');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(MARKETING_OFFER);
  });

  it('answers empty placements for a family without a declaration', async () => {
    const response = await get('/api/agency/families/app-shell/effects');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ family: 'app-shell', scriptPolicy: 'none', maxEffects: 0, placements: [] });
  });

  it('404s a family the registry does not list, before loading anything', async () => {
    for (const family of ['watson', 'Bad!', '..']) {
      const response = await get(`/api/agency/families/${encodeURIComponent(family)}/effects`);
      expect(response.status, family).toBe(404);
    }
    expect(loadedFamilies).toEqual([]);
  });

  it('answers 500 rather than a malformed offer', async () => {
    declarations['marketing-site'] = { ...MARKETING_DECLARATION, scriptPolicy: 'anything' };
    const response = await get('/api/agency/families/marketing-site/effects');
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('anything');
  });

});

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe('repairEffectsOf', () => {
  it('replays the applied components as explicit ids, none everywhere else, so Jev is never asked again', () => {
    const replay = repairEffectsOf(RESULT) as Record<string, string>;
    expect(replay['hero-title']).toBe('shiny-text');
    expect(replay['card-surface']).toBe('glass-surface');
    expect(Object.keys(replay)).toHaveLength(10);
    expect(Object.entries(replay).filter(([, id]) => id !== 'none')).toHaveLength(2);
  });

  it('is off when the build applied nothing or has no result', () => {
    expect(repairEffectsOf(undefined)).toBe('off');
    expect(repairEffectsOf({ ...RESULT, applied: [] })).toBe('off');
  });
});

describe('the build input', () => {
  it('threads the effect catalog to every build', async () => {
    await runToEnd({ brief: BRIEF, family: 'marketing-site' });
    expect((buildCalls[0]!.input as { effectCatalog?: unknown }).effectCatalog).toBe(CATALOG);
  });
});
