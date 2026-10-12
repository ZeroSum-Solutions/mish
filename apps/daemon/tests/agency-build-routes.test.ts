// The fast-lane build job API (docs/plans/2026-09-20-follow-ups-design.md §6.4 and §8 "6b").
//
// `registerAgencyBuildRoutes` is mounted on a bare Express app with a fake `buildSite`, so nothing
// here spends a model call, reaches Jev, or writes a project. Cancellation regressions also run
// the real build/router with a synthetic transport. The real `sendApiError` and the real
// `createSseResponse` are used, so the envelope and the SSE framing under test are the ones the
// daemon actually sends.
//
// What these cases exist to hold: the endpoints are local-only (a build spends money), the replay
// → live hand-off on the event stream neither drops nor duplicates an event, and nothing the model
// or the caller wrote — the brief, a repair's message, an error's text — ever reaches a client.

import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgencyBuildEvent,
  AgencyFamilySectionsResponse,
  AgencyBuildListResponse,
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  ApiErrorResponse,
} from '@open-design/contracts';
import { AGENCY_BUILD_HISTORY_LIMIT, AGENCY_ROUTE_MAX_CHARS } from '@open-design/contracts';
import { loadFamilyPackage } from '@open-design/agency-fast-lane/family';
import type { BuildDeps, BuildEvent, BuildInput, BuildResult } from '@open-design/agency-fast-lane/build';
import { parseSectionCatalogResponse, type SectionEntryResponse, type SectionsListResponse } from '@open-design/contracts/api/section-catalog';
import { buildSite, RenderQualityError, UnitDeadlineError, UnitRefusedError } from '@open-design/agency-fast-lane/build';
import { createJevRouter } from '@open-design/agency-fast-lane/route';
import { loadAtlasData } from '@open-design/agency-fast-lane/atlas';

import { AgencyModelKeyUnavailableError, createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { familyPackageDir, registerAgencyBuildRoutes } from '../src/routes/agency-build.js';
import { publicCultEntry, registerSectionsRoutes } from '../src/routes/sections.js';
import cultSlugsJson from '@open-design/cult-ui-catalog/generated/slugs.json' with { type: 'json' };
import { brandHit } from './helpers/cult-brands.js';

/** The public id `GET /api/sections` serves for the insertable Cult section `cult:marketing-cta-cosmic`. */
const CTA_COSMIC = `cult:${(cultSlugsJson as unknown as { items: Record<string, string> }).items['cult:marketing-cta-cosmic']}`;

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

type BuiltResult = Extract<BuildResult, { outcome: 'built' }>;
type Report = BuiltResult['report'];

/** A run report with only the fields the snapshot summary reads. */
function reportFixture(overrides: Partial<Report> = {}): Report {
  return {
    family: 'wrenfield',
    mode: 'sections',
    model: 'deepseek-chat',
    entry: 'wrenfield-r1.html',
    revision: 1,
    projectId: 'project-1',
    timings: { totalMs: 42_000, firstTokenMs: 900, registeredMs: 41_000 },
    calls: 6,
    repairs: 1,
    retries: 0,
    paints: 3,
    usage: { input: 12_000, output: 3_400, cachedRead: 0 },
    applied: 48,
    missing: [],
    nulled: ['hero.badge'],
    truncated: [],
    units: [],
    recipeDigest: 'digest-one',
    recipe: {},
    html: `<!doctype html><p>${BRIEF}</p>`,
    manifest: { entry: 'wrenfield-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'digest-one', revision: '1', family: 'wrenfield' } } },
    approvedAssets: [],
    ...overrides,
  } as Report;
}

const ROUTED_EVENT: BuildEvent = {
  type: 'route',
  decision: {
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
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
let tempRoot = '';
let sameOrigin = true;
let jevKey: () => Promise<string>;
let modelKey: () => Promise<string>;
let buildImpl: (input: BuildInput, deps: BuildDeps) => Promise<BuildResult>;
let buildCalls: Array<{ input: BuildInput; deps: BuildDeps }> = [];
let loadedFamilies: string[] = [];
let loadPackageImpl: (family: string) => Promise<unknown> | never;
/** The registry the routes see; a test may list families in it. */
let registryFixture: { families: Array<{ family: string; pageKind?: string }> } = { families: [] };

/** A daemon the build publishes into: records the headers every self-call carries. */
let publishTarget: { url: string; requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>; close: () => Promise<void> };
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's (or fork's, or repair's) fire-and-forget `persist()` write never races the
 * directory it writes into being removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  // The key store resolves `TYPESAFE_API_KEY` first, and a developer machine usually has one. The
  // preflight case has to be able to make the key genuinely unresolvable.
  vi.stubEnv('TYPESAFE_API_KEY', '');
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-build-'));
  sameOrigin = true;
  buildCalls = [];
  loadedFamilies = [];
  loadPackageImpl = async (family) => ({ family });
  registryFixture = { families: [] };
  jevKey = async () => 'jev-key';
  modelKey = async () => 'model-key';
  buildImpl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() });

  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const target = (await import('node:http')).createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  target.listen(0);
  await new Promise<void>((resolve) => target.once('listening', () => resolve()));
  publishTarget = {
    url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => target.close(() => resolve())),
  };

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  routes = registerAgencyBuildRoutes(app, {
    http: {
      sendApiError,
      createSseResponse,
      isLocalSameOrigin: () => sameOrigin,
      resolvedPortRef: { current: 0 },
    } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: registryFixture as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: () => jevKey() }),
      daemonUrlRef: { get current() { return publishTarget.url; } },
      runBuild: (input, deps) => {
        buildCalls.push({ input, deps });
        return buildImpl(input, deps);
      },
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: () => jevKey(),
        resolveModelKey: () => modelKey(),
      },
      loadPackage: async (family) => {
        loadedFamilies.push(family);
        return await loadPackageImpl(family) as never;
      },
      buildsFile: path.join(tempRoot, 'agency-builds', 'index.json'),
    },
  });
  registerSectionsRoutes(app, {
    http: { sendApiError, createSseResponse, isLocalSameOrigin: () => sameOrigin, resolvedPortRef: { current: 0 } } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await publishTarget.close();
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
const get = (url: string, init?: RequestInit) => fetch(`${baseUrl}${url}`, init);
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;
const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;

/** Waits for one build to reach a terminal status. */
async function waitFor(id: string): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await buildOf(await get(`/api/agency/builds/${id}`));
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}

/** Starts a build and waits for it to reach a terminal status. */
async function runToEnd(body: Record<string, unknown> = { brief: BRIEF }): Promise<AgencyBuildSnapshot> {
  const started = await buildOf(await post('/api/agency/build', body));
  return waitFor(started.id);
}

/**
 * The on-disk build store (`<tempRoot>/agency-builds/index.json`) — the actual persistence
 * boundary a sentinel-leak test must read, not just the HTTP snapshot/SSE stream (delta audit
 * findings 14/15: those only prove the WIRE response is clean, not the file a restart or a later
 * `/fork` would read back). `persist()` is fire-and-forget, so this polls the same way
 * `agency-build-persistence.test.ts`'s `waitForPersisted` does, until `id` shows `status` on disk.
 */
async function waitForPersistedIndex(id: string, status: string): Promise<{ builds: Array<{ snapshot: AgencyBuildSnapshot; fork?: Record<string, unknown> }> }> {
  const file = path.join(tempRoot, 'agency-builds', 'index.json');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { builds: Array<{ snapshot: AgencyBuildSnapshot; fork?: Record<string, unknown> }> };
      const found = parsed.builds.find((entry) => entry.snapshot.id === id);
      if (found && found.snapshot.status === status) return parsed;
    } catch {
      // Not written yet, or not valid JSON mid-rename: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`build ${id} never reached "${status}" in the on-disk store`);
}

/** Reads one SSE stream to its end and splits it into `{ event, data, id }` records. */
async function readStream(url: string, init?: RequestInit): Promise<Array<{ event: string; data: any; id?: string }>> {
  const response = await get(url, init);
  expect(response.ok).toBe(true);
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0 && !frame.startsWith(':'))
    .map((frame) => {
      const record: { event: string; data: any; id?: string } = { event: 'message', data: undefined };
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) record.id = line.slice(3).trim();
        else if (line.startsWith('event:')) record.event = line.slice(6).trim();
        else if (line.startsWith('data:')) record.data = JSON.parse(line.slice(5).trim());
      }
      return record;
    });
}

// ---------------------------------------------------------------------------
// POST /api/agency/build
// ---------------------------------------------------------------------------

describe('POST /api/agency/build', () => {
  it('answers 202 with a queued snapshot and runs the build in the background', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF });
    expect(response.status).toBe(202);
    const build = await buildOf(response);
    expect(build.status).toBe('queued');
    expect(build.events).toEqual([]);
    expect(build.startedAt).toMatch(/^\d{4}-/);
    expect(build.finishedAt).toBeUndefined();

    const finished = await runToEnd();
    expect(finished.status).toBe('done');
    expect(finished.projectId).toBe('project-1');
    expect(finished.summary).toMatchObject({ calls: 6, repairs: 1, missing: 0, nulled: 1 });
  });

  it('defaults family to auto, verify to strict and mode to sections', async () => {
    await runToEnd();
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]!.input.family).toBe('auto');
    expect(buildCalls[0]!.input.verify).toBe('strict');
    expect(buildCalls[0]!.input.mode).toBe('sections');
  });

  it('publishes through the daemon\'s own URL, never a reconstructed one', async () => {
    await runToEnd({ brief: BRIEF, projectName: 'Riverbend Dental' });
    expect(buildCalls[0]!.input.project).toEqual({
      daemonUrl: publishTarget.url,
      name: 'Riverbend Dental',
    });
  });

  it('forwards the initiating request\'s workspace and auth scope to every self-call', async () => {
    buildImpl = async (_input, deps) => {
      await deps.daemonFetch(`${publishTarget.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const started = await buildOf(await fetch(`${baseUrl}/api/agency/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-one',
        'x-od-workspace-id': 'workspace-one',
        'x-od-workspace-member-id': 'member-one',
      },
      body: JSON.stringify({ brief: BRIEF }),
    }));
    expect(started.status).toBe('queued');
    // Wait on THIS build. A second POST would race the lock and could answer 409 instead.
    expect((await waitFor(started.id)).status).toBe('done');

    const selfCall = publishTarget.requests.find((request) => request.url === '/api/projects');
    expect(selfCall?.headers.authorization).toBe('Bearer token-one');
    expect(selfCall?.headers['x-od-workspace-id']).toBe('workspace-one');
    expect(selfCall?.headers['x-od-workspace-member-id']).toBe('member-one');
    expect(selfCall?.headers['content-type']).toBe('application/json');
  });

  it('prepares the routed family\'s package and the entry the CLI uses', async () => {
    buildImpl = async (input) => {
      const prepared = await input.prepare('wrenfield');
      expect(prepared.entry).toBe('wrenfield-r1.html');
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const finished = await runToEnd();
    expect(finished.status).toBe('done');
    expect(loadedFamilies).toEqual(['wrenfield']);
  });

  it('rejects a missing, empty or oversized brief', async () => {
    expect((await errorOf(await post('/api/agency/build', {}))).code).toBe('BAD_REQUEST');
    expect((await errorOf(await post('/api/agency/build', { brief: '   ' }))).code).toBe('BAD_REQUEST');
    const long = await post('/api/agency/build', { brief: 'x'.repeat(AGENCY_ROUTE_MAX_CHARS + 1) });
    expect(long.status).toBe(400);
    expect(buildCalls).toHaveLength(0);
  });

  it('rejects a family, mode or verify it does not know', async () => {
    expect((await post('/api/agency/build', { brief: BRIEF, family: 'Not A Family' })).status).toBe(400);
    expect((await post('/api/agency/build', { brief: BRIEF, mode: 'chapters' })).status).toBe(400);
    expect((await post('/api/agency/build', { brief: BRIEF, verify: 'maybe' })).status).toBe(400);
    expect(buildCalls).toHaveLength(0);
  });

  it('forwards optional-section hints and refuses malformed ones', async () => {
    for (const sections of [[], 'reviews', { Reviews: 'drop' }, { reviews: 'maybe' }, Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`s-${index}`, 'drop']))]) {
      const refused = await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', sections });
      expect(refused.status).toBe(400);
      expect((await errorOf(refused)).code).toBe('BAD_REQUEST');
    }
    expect(buildCalls).toHaveLength(0);

    await runToEnd({ brief: BRIEF, family: 'wrenfield', sections: { reviews: 'drop', 'final-cta': 'keep' } });
    expect(buildCalls[0]!.input.sections).toEqual({ reviews: 'drop', 'final-cta': 'keep' });
    expect(buildCalls[0]!.input.judgeSections).toBeUndefined();

    await runToEnd({ brief: BRIEF, family: 'wrenfield' });
    expect(buildCalls[1]!.input.sections).toBeUndefined();
  });

  it('shows the sections decision as ids and a fixed code, and a fork reuses the hints', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'sections', kept: [], dropped: ['reviews'], source: 'jev', // Typed as a fixed code now; a stray message is still never forwarded.
      skipped: 'jev 503 upstream error <html>' as 'jev-http-error', warnings: ['nonsense: not an optional section'], ms: 420 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const done = await runToEnd({ brief: BRIEF, family: 'wrenfield', sections: { reviews: 'drop' } });
    const event = done.events.find((candidate) => candidate.type === 'sections');
    expect(event).toEqual({ seq: event!.seq, at: event!.at, type: 'sections', ms: 420, keptSections: [], droppedSections: ['reviews'], sectionSource: 'jev', reason: 'jev-unavailable' });
    expect(JSON.stringify(done)).not.toContain('upstream error');
    expect(JSON.stringify(done)).not.toContain('nonsense');

    const forked = await post(`/api/agency/builds/${done.id}/fork`, {});
    expect(forked.status).toBe(202);
    await waitFor((await buildOf(forked)).id);
    expect(buildCalls[1]!.input.sections).toEqual({ reviews: 'drop' });
  });

  it('a fork merges its own section hints over the saved build\'s, and validates them', async () => {
    const done = await runToEnd({ brief: BRIEF, family: 'wrenfield', sections: { reviews: 'drop', 'final-cta': 'keep' } });
    for (const sections of [[], { Reviews: 'drop' }, { reviews: 'maybe' }, Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`s-${index}`, 'drop']))]) {
      const refused = await post(`/api/agency/builds/${done.id}/fork`, { sections });
      expect(refused.status).toBe(400);
    }
    expect(buildCalls).toHaveLength(1);

    const forked = await post(`/api/agency/builds/${done.id}/fork`, { brief: 'A different brief.', sections: { reviews: 'keep', support: 'drop' } });
    expect(forked.status).toBe(202);
    await waitFor((await buildOf(forked)).id);
    expect(buildCalls[1]!.input.brief).toBe('A different brief.');
    expect(buildCalls[1]!.input.sections).toEqual({ reviews: 'keep', 'final-cta': 'keep', support: 'drop' });
  });

  it('lists each build with the hints it ran with, and a fork\'s auto clears a saved hint', async () => {
    const done = await runToEnd({ brief: BRIEF, family: 'wrenfield', sections: { reviews: 'drop', 'final-cta': 'keep' } });
    const listed = (await (await get('/api/agency/builds')).json()) as { builds: Array<{ id: string; sections?: Record<string, string> }> };
    expect(listed.builds.find((build) => build.id === done.id)?.sections).toEqual({ reviews: 'drop', 'final-cta': 'keep' });

    // `auto` is a fork-only value: a fresh build still refuses it.
    expect((await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', sections: { reviews: 'auto' } })).status).toBe(400);

    const forked = await post(`/api/agency/builds/${done.id}/fork`, { sections: { reviews: 'auto' } });
    expect(forked.status).toBe(202);
    await waitFor((await buildOf(forked)).id);
    expect(buildCalls[1]!.input.sections).toEqual({ 'final-cta': 'keep' });

    const cleared = await post(`/api/agency/builds/${done.id}/fork`, { sections: { reviews: 'auto', 'final-cta': 'auto' } });
    expect(cleared.status).toBe(202);
    await waitFor((await buildOf(cleared)).id);
    expect(buildCalls[2]!.input.sections).toBeUndefined();
  });

  it('lists a bundled family\'s optional sections, and 404s a family the registry does not list', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundledRoot = path.resolve(here, '../../..', 'plugins', '_official');
    loadPackageImpl = (family) => loadFamilyPackage(familyPackageDir(bundledRoot, family), family);
    registryFixture.families.push({ family: 'wrenfield', pageKind: 'site' });

    const listed = await get('/api/agency/families/wrenfield/sections');
    expect(listed.status).toBe(200);
    const body = await listed.json() as AgencyFamilySectionsResponse;
    expect(body.family).toBe('wrenfield');
    expect(body.outputScope).toBe('site');
    expect(body.sections.map(({ id, type }) => ({ id, type }))).toEqual([{ id: 'trust', type: 'trust' }, { id: 'reviews', type: 'reviews' }]);
    expect(body.sections[0]!.label.length).toBeGreaterThan(0);

    for (const family of ['watson', 'Bad!', '..']) {
      const missing = await get(`/api/agency/families/${encodeURIComponent(family)}/sections`);
      expect(missing.status).toBe(404);
    }
    expect(loadedFamilies).toEqual(['wrenfield']);
  }, 30_000);

  it('answers 500, not an unlabelled family, when a listed family has no valid pageKind', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundledRoot = path.resolve(here, '../../..', 'plugins', '_official');
    loadPackageImpl = (family) => loadFamilyPackage(familyPackageDir(bundledRoot, family), family);
    registryFixture.families.push({ family: 'wrenfield' });
    const sections = await get('/api/agency/families/wrenfield/sections');
    expect(sections.status).toBe(500);
    expect(JSON.stringify(await sections.json())).toContain('no output scope');
    const families = await get('/api/agency/families');
    expect(families.status).toBe(500);
  }, 30_000);

  it('answers 503 and starts nothing when Jev cannot be resolved', async () => {
    jevKey = async () => { throw new Error('vault entry typesafe_api_key is missing'); };
    const response = await post('/api/agency/build', { brief: BRIEF });
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.code).toBe('JEV_UNAVAILABLE');
    expect(error.message).toBe('Jev is not available on this daemon');
    expect(buildCalls).toHaveLength(0);
  });

  it('skips the Jev preflight for a named family with verify off', async () => {
    jevKey = async () => { throw new Error('vault entry typesafe_api_key is missing'); };
    const response = await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'off' });
    expect(response.status).toBe(202);
  });

  it('answers 409 with the active build while one is running', async () => {
    let release = () => {};
    buildImpl = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    try {
      const first = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
      const second = await post('/api/agency/build', { brief: BRIEF });
      expect(second.status).toBe(409);
      const error = await errorOf(second);
      expect(error.code).toBe('BUILD_BUSY');
      expect(error.details).toEqual({ kind: 'agency-build-busy', activeId: first.id });
    } finally {
      // A failed assertion above must not leave the build gated, or afterEach's `idle()` waits
      // on it until the hook times out.
      release();
    }
  });

  it('frees the lock when the family package cannot be loaded', async () => {
    // The worst shape of this failure: the build is already holding the one-at-a-time lock when
    // `prepare` throws. A lock left behind answers 409 for every later build until the daemon is
    // restarted, so what is asserted is the NEXT build, not this one's error.
    buildImpl = async (input) => {
      await input.prepare('wrenfield');
      throw new Error('unreachable');
    };
    loadPackageImpl = () => { throw new Error('ENOENT: no such file or directory'); };

    const failed = await runToEnd();
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('BUILD_FAILED');

    buildImpl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() });
    loadPackageImpl = async (family) => ({ family } as never);
    expect((await post('/api/agency/build', { brief: BRIEF })).status).toBe(202);
  });

  it('frees the lock when the build step rejects before it emits anything', async () => {
    buildImpl = async () => { throw new Error('the provider refused'); };
    expect((await runToEnd()).status).toBe('failed');
    buildImpl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() });
    expect((await post('/api/agency/build', { brief: BRIEF })).status).toBe(202);
  });

  it('cancels a build that has not emitted anything yet, and frees the lock', async () => {
    buildImpl = async (input) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { outcome: 'cancelled' };
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    expect(started.status).toBe('queued');
    expect((await post(`/api/agency/builds/${started.id}/cancel`)).status).toBe(202);
    expect((await waitFor(started.id)).status).toBe('cancelled');

    buildImpl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() });
    expect((await post('/api/agency/build', { brief: BRIEF })).status).toBe(202);
  });
});

describe('the build history', () => {
  it('keeps the last 50 builds and drops the oldest', async () => {
    for (let index = 0; index < AGENCY_BUILD_HISTORY_LIMIT + 2; index += 1) await runToEnd();
    const body = await (await get('/api/agency/builds')).json() as AgencyBuildListResponse;
    expect(body.builds).toHaveLength(AGENCY_BUILD_HISTORY_LIMIT);

    // The two oldest are gone; the newest is still there with its events.
    const oldest = body.builds[body.builds.length - 1]!;
    expect((await get(`/api/agency/builds/${oldest.id}`)).status).toBe(200);
  }, 30_000);
});

describe('the family package path', () => {
  it('resolves the real bundled package from the daemon\'s plugins root', async () => {
    // Not a mock: this is the directory `tools/pack` ships into a packaged build, loaded by the
    // fast lane's own loader. `tools/pack/tests/prebundle/fast-lane-data.test.ts` proves the same
    // path survives the prebundle, and that the fast lane's `defaultPackageDir` does not.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundledRoot = path.resolve(here, '../../..', 'plugins', '_official');
    const pkg = await loadFamilyPackage(familyPackageDir(bundledRoot, 'wrenfield'), 'wrenfield');
    expect(pkg.family).toBe('wrenfield');
    expect(typeof pkg.render).toBe('function');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// GET /api/agency/builds and /api/agency/builds/:id
// ---------------------------------------------------------------------------

describe('the build reads', () => {
  it('lists builds newest first and omits their event arrays', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const first = await runToEnd();
    const second = await runToEnd();

    const response = await get('/api/agency/builds');
    expect(response.status).toBe(200);
    const body = await response.json() as AgencyBuildListResponse;
    expect(body.builds.map((item) => item.id)).toEqual([second.id, first.id]);
    for (const item of body.builds) expect(item).not.toHaveProperty('events');
    // The full snapshot still has them.
    expect((await buildOf(await get(`/api/agency/builds/${first.id}`))).events.length).toBeGreaterThan(0);
  });

  it('answers 404 for a build it does not hold', async () => {
    const response = await get('/api/agency/builds/no-such-build');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('BUILD_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /api/agency/builds/:id/events
// ---------------------------------------------------------------------------

describe('GET /api/agency/builds/:id/events', () => {
  it('replays what happened, streams what follows, and ends with exactly one status frame', async () => {
    let emit: ((event: BuildEvent) => void) | undefined;
    let finish = (_: BuildResult) => {};
    const finished = new Promise<BuildResult>((resolve) => { finish = resolve; });
    buildImpl = async (input) => {
      emit = (event) => input.onEvent?.(event);
      emit(ROUTED_EVENT);
      emit({ type: 'project', projectId: 'project-1', created: true });
      return finished;
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    // Both events above are already recorded; the stream must replay them before it streams.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stream = readStream(`/api/agency/builds/${started.id}/events`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit!({ type: 'unit', label: 'hero', ms: 8_100, repairs: 0 });
    emit!({ type: 'registered', ms: 41_000 });
    finish({ outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() });

    const records = await stream;
    const events = records.filter((record) => record.event === 'build-event');
    const terminal = records.filter((record) => record.event === 'status');
    expect(events.map((record) => record.data.type)).toEqual(['route', 'project', 'unit', 'registered']);
    expect(events.map((record) => record.id)).toEqual(['1', '2', '3', '4']);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.data.status).toBe('done');
    expect(terminal[0]!.data.events.map((event: AgencyBuildEvent) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it('resumes after the last event a reconnecting client saw', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 41_000 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await runToEnd();
    const records = await readStream(`/api/agency/builds/${snapshot.id}/events`, {
      headers: { 'last-event-id': '2' },
    });
    const events = records.filter((record) => record.event === 'build-event');
    expect(events.map((record) => record.data.seq)).toEqual([3]);
    expect(records.filter((record) => record.event === 'status')).toHaveLength(1);
  });

  it('answers 404 for an unknown build', async () => {
    const response = await get('/api/agency/builds/no-such-build/events');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('BUILD_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /api/agency/builds/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /api/agency/builds/:id/cancel', () => {
  it.each(['family', 'auto'] as const)('cancels during Jev routing with %s composition before publishing', async (composition) => {
    let entered!: () => void;
    let release!: () => void;
    const routing = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let routerCalls = 0;
    const createModelCaller = vi.fn(() => { throw new Error('a cancelled route must not generate'); });
    buildImpl = (input, deps) => buildSite({ ...input, loadAtlas: loadAtlasData }, {
      ...deps,
      createModelCaller,
      createJevRouter: (options) => createJevRouter({
        ...options,
        consensusK: 1,
        fetchImpl: async (_url, init) => {
          routerCalls += 1;
          entered();
          await held;
          // The real router absorbs this abort into a failed vote and returns unrouted.
          init?.signal?.throwIfAborted();
          throw new Error('the test must cancel before releasing routing');
        },
      }),
    });
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'auto', composition }));
    try {
      await routing;
      expect((await buildOf(await get(`/api/agency/builds/${started.id}`))).status).toBe('routing');
      expect((await post(`/api/agency/builds/${started.id}/cancel`)).status).toBe(202);
    } finally {
      release();
    }
    const finished = await waitFor(started.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.projectId).toBeUndefined();
    expect(finished.events.some((event) => event.type === 'project' || event.type === 'registered')).toBe(false);
    expect(routerCalls).toBe(1);
    expect(createModelCaller).not.toHaveBeenCalled();
    expect(loadedFamilies).toEqual([]);
    expect(publishTarget.requests).toEqual([]);
  });

  it('keeps a failed Jev vote unrouted when the build was not cancelled', async () => {
    let routerCalls = 0;
    buildImpl = (input, deps) => buildSite({ ...input, loadAtlas: loadAtlasData }, {
      ...deps,
      createJevRouter: (options) => createJevRouter({
        ...options,
        consensusK: 1,
        fetchImpl: async () => { routerCalls += 1; throw new TypeError('synthetic unavailable transport'); },
      }),
    });
    const finished = await runToEnd({ brief: BRIEF, family: 'auto' });
    expect(finished.status).toBe('unrouted');
    expect(finished.projectId).toBeUndefined();
    expect(routerCalls).toBe(1);
    expect(loadedFamilies).toEqual([]);
    expect(publishTarget.requests).toEqual([]);
  });

  it('aborts a build that is verifying, and the clean-up runs before it ends cancelled', async () => {
    let cleanedUp = false;
    buildImpl = async (input, _deps) => {
      input.onEvent?.({ type: 'verify', checked: 12, illustrative: 0, flagged: 0, repaired: 0, remaining: 0, ms: 4_000 });
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      cleanedUp = true;
      return { outcome: 'cancelled', family: 'wrenfield' };
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await buildOf(await get(`/api/agency/builds/${started.id}`))).status).toBe('verifying');

    const response = await post(`/api/agency/builds/${started.id}/cancel`);
    expect(response.status).toBe(202);
    const finished = await waitFor(started.id);
    expect(finished.status).toBe('cancelled');
    expect(cleanedUp).toBe(true);
  });

  it('reports a project a cancelled build did not remove', async () => {
    // `buildSite` reports a project on `cancelled` only when one survived — here, one the caller
    // supplied, which it never deletes.
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-9', created: false });
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { outcome: 'cancelled', family: 'wrenfield', projectId: 'project-9' };
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post(`/api/agency/builds/${started.id}/cancel`);
    const finished = await waitFor(started.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.projectId).toBe('project-9');
  });

  it('forgets the project a cancelled build rolled back, so nothing offers a deleted project', async () => {
    // The `project` event announced an id; the rollback then removed it, and `buildSite` reports
    // no project. A snapshot that kept the id would list, print and offer a 404.
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-9', created: true });
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { outcome: 'cancelled', family: 'wrenfield' };
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post(`/api/agency/builds/${started.id}/cancel`);
    const finished = await waitFor(started.id);

    expect(finished.status).toBe('cancelled');
    expect(finished.projectId).toBeUndefined();
    // The event still says a project was created: that happened, and the list must not.
    expect(finished.events.some((event) => event.type === 'project' && event.projectId === 'project-9')).toBe(true);
    const listed = (await (await get('/api/agency/builds')).json() as AgencyBuildListResponse)
      .builds.find((item) => item.id === started.id);
    expect(listed?.projectId).toBeUndefined();
  });

  it('is idempotent, and a finished build answers its final snapshot', async () => {
    const snapshot = await runToEnd();
    const first = await post(`/api/agency/builds/${snapshot.id}/cancel`);
    expect(first.status).toBe(202);
    expect((await buildOf(first)).status).toBe('done');
    expect((await post(`/api/agency/builds/${snapshot.id}/cancel`)).status).toBe(202);
  });

  it('answers 404 for an unknown build', async () => {
    const response = await post('/api/agency/builds/no-such-build/cancel');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('BUILD_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe('build outcomes', () => {
  it('ends unrouted with the decision and no project', async () => {
    const { family: _family, ...routed } = (ROUTED_EVENT as Extract<BuildEvent, { type: 'route' }>).decision;
    const unrouted = {
      ...routed,
      decision: 'unrouted' as const,
      reason: 'no bundled family within transfer >= 2 of spine CS',
    };
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'route', decision: unrouted });
      return { outcome: 'unrouted', route: unrouted };
    };
    const snapshot = await runToEnd();
    expect(snapshot.status).toBe('unrouted');
    expect(snapshot.route?.decision).toBe('unrouted');
    expect(snapshot.projectId).toBeUndefined();
    expect(snapshot.error).toBeUndefined();
  });

  it('fails a strict build that did not pass the gate, with fixed text', async () => {
    // A strict gate that did not pass publishes nothing, so the report carries no project id.
    const { projectId: _unpublished, ...unpublished } = reportFixture();
    buildImpl = async () => ({
      outcome: 'built',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
      family: 'wrenfield',
      report: { ...unpublished, strict: { passed: false, reason: 'unresolved: hero.claim' } } as Report,
    });
    const snapshot = await runToEnd();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('VERIFY_FAILED');
    expect(snapshot.error?.message).not.toContain('hero.claim');
    expect(snapshot.projectId).toBeUndefined();
  });

  it('a VERIFY_FAILED record keeps the route and the slots still flagged', async () => {
    const { projectId: _unpublished, ...unpublished } = reportFixture();
    const verify = { provider: 'jev' as const, checked: 12, illustrative: 0, flagged: ['sections[2].text.price', 'sections[4].items[0].date'], repaired: 1, remaining: ['sections[4].items[0].date'], ms: 900 };
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'verify', checked: 12, illustrative: 0, flagged: 2, repaired: 1, remaining: 1, ms: 900, flaggedPaths: verify.flagged, remainingPaths: verify.remaining });
      return {
        outcome: 'built',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
        family: 'wrenfield',
        ...(ROUTED_EVENT.type === 'route' ? { route: ROUTED_EVENT.decision } : {}),
        report: { ...unpublished, verify, strict: { passed: false, reason: 'unresolved: sections[4].items[0].date' } } as Report,
      };
    };
    const snapshot = await runToEnd();
    expect(snapshot.error?.code).toBe('VERIFY_FAILED');
    expect(snapshot.route).toMatchObject({ decision: 'routed', spine: 'TL', family: 'wrenfield', probability: 0.71 });
    expect(snapshot.route?.viaSpine).toBeUndefined();
    expect(snapshot.failure).toEqual({ step: 'verifying', flaggedSlots: ['sections[4].items[0].date'] });
    // The same fields on the single-build read the CLI and the web panel use.
    const read = await fetch(`${baseUrl}/api/agency/builds/${snapshot.id}`);
    const body = (await read.json()) as AgencyBuildResponse;
    expect(body.build.failure?.flaggedSlots).toEqual(['sections[4].items[0].date']);
    expect(body.build.route?.spine).toBe('TL');
  });

  it('the route record carries viaSpine, the spine the winning family was admitted from', async () => {
    // A spread spine call: TL on top, the family reached through the runner-up SM.
    const viaRunnerUp: BuildEvent = ROUTED_EVENT.type === 'route'
      ? { type: 'route', decision: { ...ROUTED_EVENT.decision, spines: [{ code: 'TL', probability: 0.61 }, { code: 'SM', probability: 0.39 }], family: { id: 'listings', probability: 0.97, basis: 'same-spine', transfer: 3, viaSpine: 'SM' } } }
      : ROUTED_EVENT;
    buildImpl = async (input) => {
      input.onEvent?.(viaRunnerUp);
      throw new UnitRefusedError('listings-inquiry', { reason: 'invalid', error: 'sections[8].text.phone: expected a phone number' });
    };
    const snapshot = await runToEnd();
    expect(snapshot.route).toMatchObject({ decision: 'routed', spine: 'TL', viaSpine: 'SM', family: 'listings' });
    const read = await fetch(`${baseUrl}/api/agency/builds/${snapshot.id}`);
    const body = (await read.json()) as AgencyBuildResponse;
    expect(body.build.route?.viaSpine).toBe('SM');
    expect(body.build.route?.spine).toBe('TL');
  });

  it('the route record carries routeAttempts, 2 after the one bounded routing retry', async () => {
    const retried: BuildEvent = ROUTED_EVENT.type === 'route'
      ? { type: 'route', decision: { ...ROUTED_EVENT.decision, routeAttempts: 2 } }
      : ROUTED_EVENT;
    buildImpl = async (input) => {
      input.onEvent?.(retried);
      throw new UnitRefusedError('listings-inquiry', { reason: 'invalid', error: 'sections[8].text.phone: expected a phone number' });
    };
    const snapshot = await runToEnd();
    expect(snapshot.route?.routeAttempts).toBe(2);
    const read = await fetch(`${baseUrl}/api/agency/builds/${snapshot.id}`);
    const body = (await read.json()) as AgencyBuildResponse;
    expect(body.build.route?.routeAttempts).toBe(2);
  });

  it('a BUILD_FAILED record keeps the route and the last validation error, never the refused value', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'repair', label: 'listings-inquiry', reason: 'invalid' });
      throw new UnitRefusedError('listings-inquiry', { reason: 'invalid', error: 'sections[8].text.phone: expected a phone number' });
    };
    const snapshot = await runToEnd();
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });
    expect(snapshot.route).toMatchObject({ spine: 'TL', family: 'wrenfield', probability: 0.71 });
    expect(snapshot.failure).toEqual({
      step: 'building',
      unit: 'listings-inquiry',
      reason: 'invalid',
      slot: 'sections[8].text.phone',
      lastError: 'listings-inquiry: the family compiler refused the filled unit at sections[8].text.phone (expected a phone number)',
    });

    // A validator message that quotes the refused value keeps its slot path and drops the rule.
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      throw new UnitRefusedError('brand', { reason: 'invalid', error: 'brand.name: "Anchorline Legal Partners" is not allowed' });
    };
    const echoed = await runToEnd();
    expect(echoed.failure?.lastError).toBe('brand: the family compiler refused the filled unit at brand.name');
    expect(JSON.stringify(echoed)).not.toContain('Anchorline');
  });

  it('a failure before any phase event reports step "queued", never "publishing"', async () => {
    // No `onEvent` call at all: the build never proved it reached routing, building, verifying or
    // publishing. `startBuild` still advances `snapshot.status` to 'routing' the moment the
    // background run starts (see `BuildJob.lastPhase`'s doc comment), so this only stays green if
    // `failureStep` reads the event-derived `lastPhase` rather than that early bump.
    buildImpl = async () => {
      throw new Error('failed before the fast lane emitted anything');
    };
    const snapshot = await runToEnd();
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });
    expect(snapshot.failure).toEqual({ step: 'queued' });
  });

  it('a failure during building reports step "building"', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      throw new Error('failed mid-fill');
    };
    const snapshot = await runToEnd();
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });
    expect(snapshot.failure).toEqual({ step: 'building' });
  });

  it('a model call cut off by the deadline fails with the unit and reason "deadline"', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      throw new UnitDeadlineError('watson-footer', 'build', 120000);
    };
    const snapshot = await runToEnd();
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });
    expect(snapshot.failure).toEqual({ step: 'building', unit: 'watson-footer', reason: 'deadline', lastError: 'watson-footer: the model did not answer within the build deadline' });
  });

  it('names the project a failed rollback left behind', async () => {
    buildImpl = async () => ({
      outcome: 'rollback-failed',
      family: 'wrenfield',
      projectId: 'project-7',
      message: 'the build was cancelled after creating project project-7, and removing it again failed: daemon 500',
    });
    const snapshot = await runToEnd();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('ROLLBACK_FAILED');
    expect(snapshot.projectId).toBe('project-7');
  });

  it('fails with MODEL_UNAVAILABLE when the provider key cannot be read', async () => {
    // The route wraps the injected resolver, so a missing key reaching the model caller is
    // classified rather than answered with the generic sentence — and the store's own message
    // never travels with it.
    modelKey = async () => { throw Object.assign(new AgencyModelKeyUnavailableError('deepseek'), { message: 'vault entry deepseek_api_key is missing' }); };
    buildImpl = async (_input, deps) => {
      await deps.resolveModelKey('deepseek');
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await runToEnd();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' });
    expect(JSON.stringify(snapshot)).not.toContain('deepseek_api_key');
  });

  it('any other key-store failure is an unreadable key store: a generic sentence, the cause kept, a sanitised log', async () => {
    // Only a genuinely missing key may fail over; an unknown store fault is surfaced instead.
    const storeFault = Object.assign(new TypeError('vault entry deepseek_api_key at /home/someone/keys.json is corrupt'), { code: 'ERR_STORE_IO' });
    modelKey = async () => { throw storeFault; };
    let seen: unknown;
    buildImpl = async (_input, deps) => {
      seen = await deps.resolveModelKey('deepseek').catch((error: unknown) => error);
      throw seen;
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const snapshot = await runToEnd();
      expect(snapshot.status).toBe('failed');
      // The file is not what failed, so the sentence does not blame it.
      expect(snapshot.error).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the model key store could not be read on this daemon' });
      expect(JSON.stringify(snapshot)).not.toContain('deepseek_api_key');
      // The cause is retained privately on the error the fast lane saw.
      expect((seen as Error).cause).toBe(storeFault);
      // The log names the class and code only, never the message.
      const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.some((line) => line.includes('could not read the deepseek key: TypeError ERR_STORE_IO'))).toBe(true);
      expect(lines.join('\n')).not.toContain('deepseek_api_key');
      expect(lines.join('\n')).not.toContain('keys.json');
    } finally {
      logged.mockRestore();
    }
  });

  it('fails with fixed text and never echoes the brief or the model\'s output', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'repair', label: 'hero', reason: 'unfaithful' });
      input.onEvent?.({ type: 'clipped', label: 'hero', paths: ['hero.claim'] });
      throw new Error(`the model refused: ${BRIEF} <p>invented award</p>`);
    };
    const snapshot = await runToEnd();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Riverbend');
    expect(serialized).not.toContain('invented award');
    expect(serialized).not.toContain('hero.claim');
    const repair = snapshot.events.find((event) => event.type === 'repair');
    expect(repair).toEqual({ seq: 1, at: expect.any(String), type: 'repair', label: 'hero', reason: 'unfaithful' });
  });

  it('B-113 log privacy: VERIFY_FAILED keeps safe counts and excludes generated remaining text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const generatedSentinel = 'SYNTHETIC_REMAINING_TEXT patient@example.invalid private generated claim';
      const { projectId: _unpublished, ...unpublished } = reportFixture();
      const verify = { provider: 'jev' as const, checked: 12, illustrative: 0, flagged: ['blocks[0].text.heading'], repaired: 0, remaining: ['blocks[0].text.heading'], ms: 900, remainingTexts: [{ path: 'blocks[0].text.heading', text: generatedSentinel }] };
      buildImpl = async () => ({
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield',
        report: { ...unpublished, verify, strict: { passed: false, reason: 'unresolved: blocks[0].text.heading' } } as Report,
      });
      const snapshot = await runToEnd();
      expect(snapshot.error?.code).toBe('VERIFY_FAILED');
      expect(snapshot.failure).toEqual({ step: 'verifying', flaggedSlots: ['blocks[0].text.heading'] });
      expect(JSON.stringify(snapshot)).not.toContain(generatedSentinel);
      const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.join('\n')).not.toContain(generatedSentinel);
      expect(lines.some((line) => line.includes('VERIFY_FAILED') && line.includes('remaining=1'))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it('B-113 log privacy: a discarded repair keeps its safe reason and round without generated detail', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const generatedSentinel = 'SYNTHETIC_REFUSAL patient@example.invalid private generated refusal';
      buildImpl = async (input) => {
        input.onEvent?.({ type: 'repair-discarded', label: 'hero', round: 0, reason: 'invalid', detail: `text.body: exceeds 260 characters (${generatedSentinel})` });
        throw new Error('the model refused');
      };
      const snapshot = await runToEnd();
      const discarded = snapshot.events.find((event) => event.type === 'repair-discarded');
      expect(discarded).toEqual({ seq: 1, at: expect.any(String), type: 'repair-discarded', label: 'hero', reason: 'invalid' });
      expect(JSON.stringify(snapshot)).not.toContain(generatedSentinel);
      const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.join('\n')).not.toContain(generatedSentinel);
      expect(lines.some((line) => line.endsWith('hero faithfulness repair 1 discarded (invalid)'))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps the brief out of the events and the summary of a build that succeeded', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await runToEnd();
    expect(JSON.stringify(snapshot)).not.toContain('Riverbend');
    expect(JSON.stringify(snapshot)).not.toContain('doctype');
  });
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

describe('local origin', () => {
  it('rejects a cross-origin request on every endpoint', async () => {
    const snapshot = await runToEnd();
    sameOrigin = false;
    const responses = await Promise.all([
      post('/api/agency/build', { brief: BRIEF }),
      get('/api/agency/builds'),
      get(`/api/agency/builds/${snapshot.id}`),
      get(`/api/agency/builds/${snapshot.id}/events`),
      post(`/api/agency/builds/${snapshot.id}/cancel`),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('FORBIDDEN');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/sections, GET /api/sections/:id (sol-design.md §1/§5, phase D row)
// ---------------------------------------------------------------------------

describe('GET /api/sections', () => {
  it('lists the local catalog (HyperUI + family-section entries), with the built-in directions', async () => {
    const response = await get('/api/sections');
    expect(response.status).toBe(200);
    const body = await response.json() as SectionsListResponse;
    expect(body.catalog.schema).toBe('section-catalog/1');
    expect(Array.isArray(body.catalog.entries)).toBe(true);
    expect(body.catalog.entries.length).toBeGreaterThan(100);
    expect(body.catalog.entries.some((entry: { id: string }) => entry.id === 'hyperui:marketing/ctas/1')).toBe(true);
    expect(Array.isArray(body.directions)).toBe(true);
    expect(body.directions.length).toBe(5);
    expect(body.directions.every((d: { id: string; label: string }) => typeof d.id === 'string' && typeof d.label === 'string')).toBe(true);
  });

  it('lists the Cult UI Pro projection, insertable only through a checked adapter, in a shape the client parser accepts', async () => {
    const response = await get('/api/sections');
    const body = await response.json() as SectionsListResponse;
    // The web picker and `od sections` parse this exact body; a server/client policy drift fails here.
    expect(() => parseSectionCatalogResponse(body)).not.toThrow();
    const cult = body.catalog.entries.filter((entry) => entry.sourceKind === 'cult-pro');
    expect(cult.length).toBeGreaterThan(100);
    for (const entry of cult) {
      expect(entry.id.startsWith('cult:')).toBe(true);
      const adapterId = entry.content.kind === 'cult-item' ? entry.content.adapterId : undefined;
      expect(entry.availability).toBe(adapterId === entry.id ? 'insertable' : 'adapter-needed');
      expect(entry.rights).toEqual({ license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' });
      expect(entry.title).not.toMatch(/\b(vercel|vite|apple|shadcn|heerich)\b/i);
    }
    expect(cult.some((entry) => entry.sectionKind === 'page-composition')).toBe(true);
    expect(cult.some((entry) => entry.sectionKind === 'unclassified')).toBe(false);
    // INSERTABLE_V1 is still exactly the three reviewed HyperUI blocks; every other insertable
    // entry is a Cult section with a checked adapter.
    const insertable = body.catalog.entries.filter((entry) => entry.availability === 'insertable');
    expect(insertable.filter((entry) => entry.sourceKind === 'hyperui').map((entry) => entry.id).sort())
      .toEqual(['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1']);
    const cultInsertable = insertable.filter((entry) => entry.sourceKind === 'cult-pro').map((entry) => entry.id);
    expect(insertable.length).toBe(3 + cultInsertable.length);
    expect(cultInsertable).toContain(CTA_COSMIC);
  });

  it('filters by kind', async () => {
    const response = await get('/api/sections?kind=cta-band');
    expect(response.status).toBe(200);
    const body = await response.json() as SectionsListResponse;
    expect(body.catalog.entries.length).toBeGreaterThan(0);
    for (const entry of body.catalog.entries) expect(entry.sectionKind).toBe('cta-band');
  });

  it('filters by spine, excluding "unclassified" entries', async () => {
    const response = await get('/api/sections?spine=TL');
    expect(response.status).toBe(200);
    const body = await response.json() as SectionsListResponse;
    for (const entry of body.catalog.entries) {
      expect(entry.spineAffinities === 'any' || (Array.isArray(entry.spineAffinities) && entry.spineAffinities.includes('TL'))).toBe(true);
    }
  });

  it('400s on an invalid spine', async () => {
    const response = await get('/api/sections?spine=ZZ');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('400s on an invalid kind', async () => {
    const response = await get('/api/sections?kind=not-a-real-kind');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });
});

describe('GET /api/sections, brand-free Cult entries', () => {
  it('serves every Cult entry under its public id, with brand-free content', async () => {
    const response = await get('/api/sections');
    const body = await response.json() as SectionsListResponse;
    const cult = body.catalog.entries.filter((entry) => entry.sourceKind === 'cult-pro');
    expect(cult.length).toBeGreaterThan(100);
    for (const entry of cult) {
      expect(entry.id, entry.id).toMatch(/^cult:[a-z0-9]+(?:-[a-z0-9]+)*$/);
      // The whole served entry: id, title, summary, source title, provenance and adapter id.
      expect(brandHit(JSON.stringify(entry)), entry.id).toBeNull();
    }
    expect(cult.map((entry) => entry.id)).toContain('cult:bento-series-v');
    expect(cult.map((entry) => entry.id)).not.toContain('cult:marketing-bento-vercel');
  });

  it('leaves out a Cult entry that has no public id yet instead of serving it branded', () => {
    const entry = { id: 'cult:marketing-new-vercel', title: 'New (series V)', sourceKind: 'cult-pro', sectionKind: 'hero', spineAffinities: 'unclassified', rights: { license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' }, access: 'local', availability: 'adapter-needed', preview: { kind: 'none' }, content: { kind: 'cult-item', summary: 'A Vercel-inspired hero.', sourceTitle: 'Marketing New Vercel', provenance: { cultId: 'cult:marketing-new-vercel', snapshotId: 'cult-ui-pro@6b9560102fcd5ae5' } } } as const;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicCultEntry(entry as never)).toBeUndefined();
    spy.mockRestore();
  });

  it('answers a Cult entry by its public id, bare slug or old internal id, and never echoes an unknown id', async () => {
    for (const key of ['cult:pricing-series-v', 'pricing-series-v', 'cult:marketing-pricing-vercel']) {
      const response = await get(`/api/sections/${encodeURIComponent(key)}`);
      expect(response.status, key).toBe(200);
      const text = await response.text();
      expect(brandHit(text), key).toBeNull();
      expect((JSON.parse(text) as SectionEntryResponse).entry.id).toBe('cult:pricing-series-v');
    }
    const missing = await get(`/api/sections/${encodeURIComponent('cult:vercel-nope')}`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('vercel');
  });
});

describe('GET /api/sections/:id', () => {
  // An entry id embeds a literal ":" and "/" (e.g. "hyperui:marketing/ctas/1"), so the client must
  // percent-encode the whole id as one path segment for Express's `/api/sections/:id` to route it
  // as a single param rather than splitting on the slash; Express decodes it back with
  // `decodeURIComponent` before the handler sees `req.params.id`, exactly like `POST
  // /api/agency/builds/:id/fork`'s existing `id` param.
  it('returns a known entry', async () => {
    const response = await get(`/api/sections/${encodeURIComponent('hyperui:marketing/ctas/1')}`);
    expect(response.status).toBe(200);
    const body = await response.json() as SectionEntryResponse;
    expect(body.entry.id).toBe('hyperui:marketing/ctas/1');
    expect(body.entry.availability).toBe('insertable');
  });

  it('returns a Cult entry with its public provenance and a brand-free source title and summary', async () => {
    const response = await get(`/api/sections/${encodeURIComponent('cult:pricing-series-v')}`);
    expect(response.status).toBe(200);
    const body = await response.json() as SectionEntryResponse;
    expect(body.entry).toMatchObject({ id: 'cult:pricing-series-v', title: 'Pricing (series V)', sourceKind: 'cult-pro', sectionKind: 'pricing', availability: 'insertable' });
    expect(body.entry.content).toMatchObject({ kind: 'cult-item', sourceTitle: 'Pricing (series V)', provenance: { cultId: 'cult:pricing-series-v' }, adapterId: 'cult:pricing-series-v' });
    expect(body.entry.content.kind === 'cult-item' && body.entry.content.summary).toMatch(/^Series V pricing section/);
  });

  it('404s on an unknown id', async () => {
    const response = await get(`/api/sections/${encodeURIComponent('hyperui:marketing/does-not-exist/999')}`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// sectionSelection / designReference (sol-design.md §2)
// ---------------------------------------------------------------------------

describe('POST /api/agency/build with sectionSelection', () => {
  const VALID_SELECTION = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'hero' }, directionId: 'modern-minimal' };

  it('accepts a valid sectionSelection and threads it to the build input', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, sectionSelection: VALID_SELECTION });
    expect(response.status).toBe(202);
    await waitFor((await buildOf(response)).id);
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]!.input.sectionSelection).toEqual(VALID_SELECTION);
  });

  it('accepts a Cult entry with a checked adapter as entryId, by the id the catalog serves', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, sectionSelection: { ...VALID_SELECTION, entryId: CTA_COSMIC } });
    expect(response.status).toBe(202);
    await waitFor((await buildOf(response)).id);
    expect(buildCalls).toHaveLength(1);
    // The build runs on the internal id the adapter registry keys on.
    expect(buildCalls[0]!.input.sectionSelection).toEqual({ ...VALID_SELECTION, entryId: 'cult:marketing-cta-cosmic' });
  });

  it('still accepts the old internal id as entryId', async () => {
    const selection = { ...VALID_SELECTION, entryId: 'cult:marketing-cta-cosmic' };
    const response = await post('/api/agency/build', { brief: BRIEF, sectionSelection: selection });
    expect(response.status).toBe(202);
    await waitFor((await buildOf(response)).id);
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]!.input.sectionSelection).toEqual(selection);
  });

  it('accepts a Cult entry by its public id and threads the internal id to the build', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, sectionSelection: { ...VALID_SELECTION, entryId: 'cult:pricing-series-v' } });
    expect(response.status).toBe(202);
    await waitFor((await buildOf(response)).id);
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]!.input.sectionSelection).toEqual({ ...VALID_SELECTION, entryId: 'cult:marketing-pricing-vercel' });
  });

  it('rejects a catalogued Cult entry (adapter-needed, not insertable) as entryId with 400', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: { ...VALID_SELECTION, entryId: 'cult:marketing-hero-hex' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('refuses a not-yet-insertable Cult entry by its public id without naming its internal id', async () => {
    // `cult:bento-series-v` is `cult:marketing-bento-vercel` inside; the refusal says the public one.
    const response = await post('/api/agency/build', { brief: BRIEF, sectionSelection: { ...VALID_SELECTION, entryId: 'cult:bento-series-v' } });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain('cult:bento-series-v');
    expect(brandHit(error.message)).toBeNull();
    expect(buildCalls).toHaveLength(0);
  });

  it('rejects an unknown/not-yet-reviewed entryId with 400', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: { ...VALID_SELECTION, entryId: 'hyperui:marketing/does-not-exist/999' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('rejects an unknown directionId with 400', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: { ...VALID_SELECTION, directionId: 'not-a-real-direction' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('rejects a malformed placement with 400', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: { entryId: VALID_SELECTION.entryId, placement: { mode: 'sideways' }, directionId: VALID_SELECTION.directionId },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('rejects designReferenceId without a sectionSelection', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, designReferenceId: 'motionsites-prompt:abc' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('rejects designReferenceId and designReferenceText together', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'motionsites-prompt:abc',
      designReferenceText: 'inline text',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('answers MOTIONSITES_LOGIN_REQUIRED for a motionsites-prompt designReferenceId with no stored connection', async () => {
    // tempRoot is a fresh temp dir every test — no mcp-tokens.json, so the MotionSites bridge has
    // no usable token and `fetchMotionSitesDesignReference` throws `MotionSitesLoginRequiredError`
    // before any build starts.
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'motionsites-prompt:some-prompt',
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('MOTIONSITES_LOGIN_REQUIRED');
    expect(buildCalls).toHaveLength(0);
  });

  it('never persists designReferenceText in the snapshot, the SSE stream, or forkSeed', async () => {
    const SENTINEL = 'ZZ-ROUTE-DESIGN-REFERENCE-SENTINEL-4f1c-ZZ';
    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceText: `Editorial, high-contrast: ${SENTINEL}`,
    }));
    // The fast lane itself received the real text (in-memory, this call only).
    expect(buildCalls[0]!.input.designReference).toContain(SENTINEL);

    const finished = await waitFor(started.id);
    expect(JSON.stringify(finished)).not.toContain(SENTINEL);

    const events = await readStream(`/api/agency/builds/${started.id}/events`);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);

    const listed = await (await get('/api/agency/builds')).json() as AgencyBuildListResponse;
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);

    // The actual persistence boundary (delta audit finding 14): the on-disk record itself, not
    // just what the HTTP surface answers with.
    const onDisk = await waitForPersistedIndex(started.id, 'done');
    expect(JSON.stringify(onDisk)).not.toContain(SENTINEL);
  });

  it('carries sectionOverlay through to the finished snapshot when the report has one', async () => {
    buildImpl = async () => ({
      outcome: 'built',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
      family: 'wrenfield',
      projectId: 'project-1',
      report: reportFixture({
        sectionOverlay: { entryId: VALID_SELECTION.entryId, directionId: VALID_SELECTION.directionId, placement: VALID_SELECTION.placement, flagged: [], remaining: [] },
      } as Partial<Report>),
    });
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, sectionSelection: VALID_SELECTION }));
    const finished = await waitFor(started.id);
    expect(finished.sectionOverlay).toEqual({ entryId: VALID_SELECTION.entryId, directionId: VALID_SELECTION.directionId, placement: VALID_SELECTION.placement, flagged: [], remaining: [] });
  });

  it('names a Cult section overlay by its public id on the snapshot, the build list and the SSE build event', async () => {
    const internal = { entryId: 'cult:marketing-pricing-vercel', directionId: VALID_SELECTION.directionId, placement: VALID_SELECTION.placement, flagged: [], remaining: [] };
    buildImpl = async () => ({
      outcome: 'built',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
      family: 'wrenfield',
      projectId: 'project-1',
      // A report naming the internal id (as a build from before public ids did).
      report: reportFixture({ sectionOverlay: internal } as Partial<Report>),
    });
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, sectionSelection: { ...VALID_SELECTION, entryId: 'cult:pricing-series-v' } }));
    const finished = await waitFor(started.id);
    expect(finished.sectionOverlay).toEqual({ ...internal, entryId: 'cult:pricing-series-v' });
    const one = await (await get(`/api/agency/builds/${started.id}`)).text();
    const listed = await (await get('/api/agency/builds')).text();
    const events = JSON.stringify(await readStream(`/api/agency/builds/${started.id}/events`));
    for (const [where, text] of [['GET /:id', one], ['GET list', listed], ['SSE', events]] as const) {
      expect(text, where).toContain('cult:pricing-series-v');
      expect(text, where).not.toContain('marketing-pricing-vercel');
    }
  });

  it('carries sectionSelection and designReferenceId (never designReferenceText) onto a fork', async () => {
    const SENTINEL = 'ZZ-FORK-SEED-SENTINEL-8a2b-ZZ';
    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceText: `some guidance ${SENTINEL}`,
    }));
    await waitFor(started.id);

    // A fork with no override re-fetches the id, not the text — and this build had none (it used
    // designReferenceText), so a fork of it must not carry any reference forward, and above all
    // must never carry the original build's own fetched/supplied text.
    const forkResponse = await post(`/api/agency/builds/${started.id}/fork`, {});
    expect(forkResponse.status).toBe(202);
    const forked = await buildOf(forkResponse);
    await waitFor(forked.id);
    expect(buildCalls[1]!.input.sectionSelection).toEqual(VALID_SELECTION);
    expect(buildCalls[1]!.input.designReference).toBeUndefined();
    expect(JSON.stringify(forked)).not.toContain(SENTINEL);

    // The persisted FORK SEED specifically (delta audit finding 15): `forked` above is the
    // snapshot, which a later `/fork` never reads — the seed is what actually feeds a subsequent
    // fork, so it is this field, not just the snapshot, that must never carry the sentinel.
    const onDisk = await waitForPersistedIndex(forked.id, 'done');
    const forkedRecord = onDisk.builds.find((entry) => entry.snapshot.id === forked.id);
    expect(forkedRecord?.fork).toBeDefined();
    expect(JSON.stringify(forkedRecord?.fork)).not.toContain(SENTINEL);
    expect(JSON.stringify(onDisk)).not.toContain(SENTINEL);
  });

  it('never discards a supplied designReferenceText/Id when the OTHER field is explicitly null on a fork', async () => {
    // First build has no sectionSelection at all (so its own forkSeed carries none), which makes
    // the "reuse saved" path irrelevant — every case below is a fresh value the fork request
    // itself supplies, never a fallback to something already on the seed.
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF }));
    await waitFor(started.id);

    // Case 1: designReferenceId is null, designReferenceText is a real string — the string must
    // win, not be silently discarded because the sibling field is null (delta audit finding 11).
    const SENTINEL_TEXT = 'ZZ-NULL-CLEAR-TEXT-SENTINEL-71dd-ZZ';
    const forkText = await buildOf(await post(`/api/agency/builds/${started.id}/fork`, {
      sectionSelection: VALID_SELECTION,
      designReferenceId: null,
      designReferenceText: `guidance ${SENTINEL_TEXT}`,
    }));
    await waitFor(forkText.id);
    const textCall = buildCalls.find((call) => call.input.sectionSelection !== undefined && call.input.designReference?.includes(SENTINEL_TEXT));
    expect(textCall, 'the supplied designReferenceText must reach the fast lane, not be dropped').toBeDefined();

    // Case 2: designReferenceText is null, designReferenceId is a real string — the id must win
    // and actually be resolved (a zerosum-kit id needs no connection, so this proves the id was
    // used rather than silently cleared).
    const forkId = await buildOf(await post(`/api/agency/builds/${started.id}/fork`, {
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'zerosum-kit:zs-s1-booking-adapter',
      designReferenceText: null,
    }));
    const finishedId = await waitFor(forkId.id);
    expect(finishedId.status).toBe('done');
    const idCall = buildCalls.find((call) => call.input.sectionSelection !== undefined && typeof call.input.designReference === 'string' && call.input.designReference.length > 0 && !call.input.designReference.includes(SENTINEL_TEXT));
    expect(idCall, 'the supplied designReferenceId must actually be resolved and used, not dropped').toBeDefined();
  });

  it('resolves a zerosum-kit designReferenceId through the local-corpus source (no MotionSites connection needed)', async () => {
    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'zerosum-kit:zs-s1-booking-adapter',
    }));
    const finished = await waitFor(started.id);
    expect(finished.status).toBe('done');
    expect(typeof buildCalls[0]!.input.designReference).toBe('string');
    expect(buildCalls[0]!.input.designReference!.length).toBeGreaterThan(0);
  });

  it('rejects an unrecognized designReferenceId prefix with 400, never reaching the fetch', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'not-a-real-prefix:abc',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('rejects a designReferenceId that is a recognized prefix followed only by whitespace (delta audit round 2 finding 2)', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: 'motionsites-prompt: ',
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('rejects a designReferenceId longer than the bound', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: `motionsites-prompt:${'a'.repeat(200)}`,
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('accepts a designReferenceId exactly at the bound (passes shape validation)', async () => {
    // 'zerosum-kit:' (12 chars) + 188 = 200, the literal boundary value.
    const idAtBound = `zerosum-kit:${'z'.repeat(188)}`;
    expect(idAtBound.length).toBe(200);
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceId: idAtBound,
    });
    // Still 400 — but for "no such local-corpus row" (the id is fake), not for its length. The
    // message distinguishes the two: a length rejection names the bound, this one names the row.
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).not.toContain('characters');
    expect(error.message).toContain('No local-corpus row');
  });

  it('rejects a designReferenceText longer than AGENCY_ROUTE_MAX_CHARS', async () => {
    const response = await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceText: 'x'.repeat(AGENCY_ROUTE_MAX_CHARS + 1),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(buildCalls).toHaveLength(0);
  });

  it('accepts a designReferenceText exactly at AGENCY_ROUTE_MAX_CHARS', async () => {
    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF,
      sectionSelection: VALID_SELECTION,
      designReferenceText: 'x'.repeat(AGENCY_ROUTE_MAX_CHARS),
    }));
    const finished = await waitFor(started.id);
    expect(finished.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Boot: the routes are registered on the real server
// ---------------------------------------------------------------------------

describe('build routes on a booted daemon', () => {
  let bootedServer: http.Server;
  let bootedUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const { startServer } = await import('../src/server.js');
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    bootedUrl = started.url;
    bootedServer = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => bootedServer.close(() => resolve()));
  });

  it('serves the build list, proving registration in server.ts and not only in this harness', async () => {
    const response = await fetch(`${bootedUrl}/api/agency/builds`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ builds: [] });
  });

  it('answers 404 rather than the SPA fallback for an unknown build', async () => {
    const response = await fetch(`${bootedUrl}/api/agency/builds/no-such-build`);
    expect(response.status).toBe(404);
    expect((await response.json() as ApiErrorResponse).error.code).toBe('BUILD_NOT_FOUND');
  });
});

describe('render quality transport', () => {
  it('reports fixed checks and counts without generated target or reason text', async () => {
    const quality: NonNullable<Report['renderQuality']> = { passed: true, checks: ['page-heading', 'unique-ids'], scope: 'site', issues: [] };
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'render-quality', report: quality });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: { ...reportFixture(), renderQuality: quality } };
    };
    const build = await runToEnd();
    expect(build.status).toBe('done');
    const serialized = JSON.parse(JSON.stringify(build));
    expect(serialized.renderQuality).toEqual({ passed: true, checks: ['page-heading', 'unique-ids'], scope: 'site', issueCounts: [] });
    expect(serialized.events.find((event: { type: string }) => event.type === 'render-quality').renderQuality).toEqual(serialized.renderQuality);
  });

  it('reports a failed gate without leaking generated text or retaining a rolled-back project', async () => {
    const quality: NonNullable<Report['renderQuality']> = { passed: false, checks: ['unique-ids', 'link-destinations'], scope: 'site', issues: [
      { check: 'link-destinations', target: 'PRIVATE_GENERATED_TARGET', reason: 'PRIVATE_MODEL_REASON' },
      { check: 'link-destinations', target: 'PRIVATE_SECOND_TARGET', reason: 'PRIVATE_SECOND_REASON' },
    ] };
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'render-quality', report: quality });
      throw new RenderQualityError(quality);
    };
    const build = await runToEnd();
    expect(build.status).toBe('failed');
    expect(build.projectId).toBeUndefined();
    expect(build.error?.code).toBe('RENDER_QUALITY_FAILED');
    expect(build.renderQuality).toEqual({ passed: false, checks: ['unique-ids', 'link-destinations'], scope: 'site', issueCounts: [{ check: 'link-destinations', count: 2 }] });
    expect(JSON.stringify(build)).not.toContain('PRIVATE_');
  });
});
