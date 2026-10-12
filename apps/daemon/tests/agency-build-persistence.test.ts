// Build persistence and "start from this build" (Move 4, six-moves eval
// `4-build-persistence.sh`).
//
// Two things this file exists to hold, kept apart from `agency-build-routes.test.ts` because both
// need to mount the routes TWICE against the SAME data directory — once to record a build, once
// more to simulate the daemon coming back up:
//
//   1. `GET /api/agency/builds` (and `.../:id`) still lists a build after a restart, with its
//      terminal status and `projectId` intact; a build the store still shows mid-flight when the
//      daemon starts is hydrated as `failed` with a fixed sentence, never as running.
//   2. `POST /api/agency/builds/:id/fork` — "start from this build" — starts a new build from a
//      saved one's family, brief and options, with the same busy/lock/404 rules as `POST
//      /api/agency/build`, and refuses a build with no publishable project.
//
// The harness copies `agency-build-routes.test.ts`'s shape (bare Express app, fake
// `runBuild`/`loadPackage`, `mkdtempSync`), but factored into `startApp()` so a test can call it
// more than once against one directory.

import type http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgencyBuildForkResponse,
  AgencyBuildListResponse,
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  ApiErrorResponse,
} from '@open-design/contracts';
import type { BuildDeps, BuildInput, BuildResult } from '@open-design/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';
import { createAgencyBuildStore, type PersistedAgencyBuild } from '../src/agency-build-store.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

type BuiltResult = Extract<BuildResult, { outcome: 'built' }>;
type Report = BuiltResult['report'];

/** A run report with only the fields the snapshot summary reads — same fixture as
 * `agency-build-routes.test.ts`. */
function reportFixture(overrides: Partial<Report> = {}): Report {
  return {
    family: 'wrenfield',
    mode: 'sections',
    model: 'deepseek-chat',
    entry: 'wrenfield-r1.html',
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
    html: `<!doctype html><p>${BRIEF}</p>`,
    manifest: { entry: 'wrenfield-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'digest-one', revision: '1', family: 'wrenfield' } } },
    approvedAssets: [],
    ...overrides,
  } as Report;
}

const DONE_RESULT: BuildResult = { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  server: http.Server;
  baseUrl: string;
  buildCalls: BuildInput[];
  /** Mutable so a test can swap `buildImpl` mid-suite (e.g. to hang the lock) without remounting
   * the routes — the wrapper passed to `registerAgencyBuildRoutes` always reads `state.buildImpl`. */
  state: { buildImpl: (input: BuildInput, deps: BuildDeps) => Promise<BuildResult> };
  /** `drain` (default `true`) awaits `registerAgencyBuildRoutes`'s own `idle()` — every build
   * still in flight, then the store's own save/load chain — before closing the server, so this
   * app's `agency-builds/index.json` write cannot still be running when the caller's `afterEach`
   * removes `tempRoot`. A test that deliberately leaves a build gated forever (the lock test
   * below) passes `{ drain: false }`: `idle()` would otherwise wait on it until the hook times
   * out, since that build is never meant to finish. */
  close: (opts?: { drain?: boolean }) => Promise<void>;
}

/** Mounts `registerAgencyBuildRoutes` on a bare Express app against `dataDir`. Calling this twice
 * on the SAME `dataDir` is the "restart" this file's first suite exercises: the second call's
 * `hydrated` promise reloads whatever the first call's store wrote. */
async function startApp(dataDir: string): Promise<Harness> {
  const state: Harness['state'] = { buildImpl: async () => DONE_RESULT };
  const buildCalls: BuildInput[] = [];
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const routes = registerAgencyBuildRoutes(app, {
    http: {
      sendApiError,
      createSseResponse,
      isLocalSameOrigin: () => true,
      resolvedPortRef: { current: 0 },
    } as never,
    paths: { RUNTIME_DATA_DIR: dataDir } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: [] } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir, readVaultSecret: () => Promise.resolve('jev-key') }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input, deps) => {
        buildCalls.push(input);
        return state.buildImpl(input, deps);
      },
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: () => Promise.resolve('jev-key'),
        resolveModelKey: () => Promise.resolve('model-key'),
      },
      loadPackage: async (family) => ({ family, schema: {} }) as never,
      buildsFile: buildsFileFor(dataDir),
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    baseUrl,
    buildCalls,
    state,
    close: async (opts) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (opts?.drain !== false) await routes.idle();
    },
  };
}

function buildsFileFor(dataDir: string): string {
  return path.join(dataDir, 'agency-builds', 'index.json');
}

const post = (baseUrl: string, url: string, body?: unknown) =>
  fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (baseUrl: string, url: string) => fetch(`${baseUrl}${url}`);
const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;

/** Waits for one build to reach a terminal status, polling the SAME app it was started on. */
async function waitForTerminal(baseUrl: string, id: string): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const build = await buildOf(await get(baseUrl, `/api/agency/builds/${id}`));
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}

/**
 * Waits for the persisted file to show `id` at `status`. `persist()` is deliberately
 * fire-and-forget (a save must not delay or fail the request it rides along with), so a test that
 * is about to read the SAME directory from a fresh `startApp()` has to wait for the write to have
 * actually landed on disk rather than just for the HTTP response that triggered it.
 */
async function waitForPersisted(dataDir: string, id: string, status: string): Promise<void> {
  const file = buildsFileFor(dataDir);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { builds: PersistedAgencyBuild[] };
      const found = parsed.builds.find((entry) => entry.snapshot.id === id);
      if (found && found.snapshot.status === status) return;
    } catch {
      // Not written yet, or not valid JSON mid-rename: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`build ${id} never reached "${status}" on disk`);
}

let tempRoot = '';

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-build-persistence-'));
});

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
  tempRoot = '';
});

// ---------------------------------------------------------------------------
// Builds persist across a restart
// ---------------------------------------------------------------------------

describe('builds persist across a restart', () => {
  it('GET /api/agency/builds still lists a finished build, with its terminal status and projectId', async () => {
    const first = await startApp(tempRoot);
    const started = await buildOf(await post(first.baseUrl, '/api/agency/build', { brief: BRIEF }));
    const finished = await waitForTerminal(first.baseUrl, started.id);
    expect(finished.status).toBe('done');
    expect(finished.projectId).toBe('project-1');
    await waitForPersisted(tempRoot, started.id, 'done');
    await first.close();

    // "registerAgencyBuildRoutes called again on the same dir to simulate a restart" — a brand
    // new Express app, a brand new in-memory job registry, the SAME data directory.
    const second = await startApp(tempRoot);
    try {
      const list = await (await get(second.baseUrl, '/api/agency/builds')).json() as AgencyBuildListResponse;
      const remembered = list.builds.find((build) => build.id === started.id);
      expect(remembered).toBeDefined();
      expect(remembered?.status).toBe('done');
      expect(remembered?.projectId).toBe('project-1');
      expect(remembered?.family).toBe('wrenfield');

      const single = await buildOf(await get(second.baseUrl, `/api/agency/builds/${started.id}`));
      expect(single.status).toBe('done');
      expect(single.projectId).toBe('project-1');
    } finally {
      await second.close();
    }
  });

  it('hydrates a build the store still shows mid-flight as failed, never as running', async () => {
    // Seeded directly through the store, the way a daemon that died mid-build would leave one:
    // `finish()` never ran, so the last save on disk is still in a running phase.
    const store = createAgencyBuildStore(buildsFileFor(tempRoot));
    const interrupted: AgencyBuildSnapshot = {
      id: 'interrupted-1',
      status: 'building',
      family: 'wrenfield',
      events: [],
      startedAt: new Date().toISOString(),
    };
    await store.save({
      snapshot: interrupted,
      fork: { brief: BRIEF, family: 'wrenfield', mode: 'sections', verify: 'strict', provider: 'deepseek' },
    });

    const app = await startApp(tempRoot);
    try {
      const rehydrated = await buildOf(await get(app.baseUrl, '/api/agency/builds/interrupted-1'));
      expect(rehydrated.status).toBe('failed');
      expect(rehydrated.error?.code).toBe('BUILD_FAILED');
      expect(rehydrated.error?.message).toBe('the daemon restarted while this build was running');
      expect(rehydrated.finishedAt).toBeTruthy();

      // A fresh build still starts fine — the rewritten job released no lock it never held.
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF }));
      expect(started.status).toBe('queued');
      expect((await waitForTerminal(app.baseUrl, started.id)).status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('serves a build saved before public Cult ids with public ids, and rewrites the record', async () => {
    mkdirSync(path.dirname(buildsFileFor(tempRoot)), { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(buildsFileFor(tempRoot), JSON.stringify({
      schema: 'agency-builds/1',
      builds: [{
        snapshot: {
          id: 'old-cult-build-1', status: 'done', startedAt,
          events: [
            { seq: 1, at: startedAt, type: 'composition', ms: 1, composition: { requested: 'blocks', used: 'blocks', blocks: ['cult:marketing-bento-vite'] } },
            { seq: 2, at: startedAt, type: 'unit', label: 'cult:marketing-footer-vercel', ms: 2, repairs: 0 },
          ], finishedAt: startedAt, family: 'composed', projectId: 'project-1',
          sectionOverlay: { entryId: 'cult:marketing-pricing-vercel', directionId: 'modern-minimal', placement: { mode: 'append', afterSectionId: 'hero' }, flagged: [], remaining: [] },
          composition: { requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-vite', 'cult:marketing-footer-vercel'], budgetDropped: ['cult:marketing-faq-vite'], source: 'jev' },
        },
      }],
    }));
    const app = await startApp(tempRoot);
    try {
      const text = await (await get(app.baseUrl, '/api/agency/builds/old-cult-build-1')).text();
      const snapshot = JSON.parse(text) as { build: AgencyBuildSnapshot };
      expect(snapshot.build.sectionOverlay?.entryId).toBe('cult:pricing-series-v');
      expect(snapshot.build.composition?.blocks).toEqual(['hyperui:marketing/sections/1', 'cult:bento-series-vt', 'cult:footer-series-v']);
      expect(snapshot.build.composition?.budgetDropped).toEqual(['cult:faq-series-vt']);
      expect(text).not.toMatch(/marketing-(pricing|bento|footer|faq)-/);
      expect(snapshot.build.events.map((event) => event.label ?? event.composition?.blocks?.[0])).toEqual(['cult:bento-series-vt', 'cult:footer-series-v']);
      // The hydrated record is rewritten, so the file no longer names the internal ids either.
      await waitForPersisted(tempRoot, 'old-cult-build-1', 'done');
      expect(readFileSync(buildsFileFor(tempRoot), 'utf8')).not.toContain('marketing-pricing-vercel');
    } finally {
      await app.close();
    }
  });

  it('drops a stored record whose status is outside the closed set, rather than hydrating it', async () => {
    // Written directly, bypassing `store.save()`, the way a hand-edited or otherwise malformed
    // file would arrive. A status this daemon does not recognise must not reach `isTerminal` in
    // `routes/agency-build.ts` (it would call anything unrecognised terminal) and must not be
    // served to a client as though it were a real build.
    mkdirSync(path.dirname(buildsFileFor(tempRoot)), { recursive: true });
    writeFileSync(
      buildsFileFor(tempRoot),
      JSON.stringify({
        schema: 'agency-builds/1',
        builds: [
          {
            snapshot: {
              id: 'malformed-status-1',
              status: 'banana',
              events: [],
              startedAt: new Date().toISOString(),
            },
          },
        ],
      }),
    );

    const app = await startApp(tempRoot);
    try {
      const response = await get(app.baseUrl, '/api/agency/builds/malformed-status-1');
      expect(response.status).toBe(404);
      const list = await (await get(app.baseUrl, '/api/agency/builds')).json() as AgencyBuildListResponse;
      expect(list.builds).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/agency/builds/:id/fork
// ---------------------------------------------------------------------------

describe('POST /api/agency/builds/:id/fork', () => {
  it('starts a new build with the saved build\'s family, brief and options', async () => {
    const app = await startApp(tempRoot);
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'advisory', mode: 'single' }));
      expect((await waitForTerminal(app.baseUrl, started.id)).status).toBe('done');

      const response = await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`);
      expect(response.status).toBe(202);
      const forked = (await response.json() as AgencyBuildForkResponse).build;
      expect(forked.id).not.toBe(started.id);
      expect(forked.status).toBe('queued');
      expect((await waitForTerminal(app.baseUrl, forked.id)).status).toBe('done');

      expect(app.buildCalls).toHaveLength(2);
      expect(app.buildCalls[1]).toMatchObject({ brief: BRIEF, family: 'wrenfield', verify: 'advisory', mode: 'single' });
    } finally {
      await app.close();
    }
  });

  it('overrides the saved brief when the request gives one', async () => {
    const app = await startApp(tempRoot);
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF }));
      await waitForTerminal(app.baseUrl, started.id);

      const response = await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`, { brief: 'A different brief entirely.' });
      expect(response.status).toBe(202);
      const forked = (await response.json() as AgencyBuildForkResponse).build;
      await waitForTerminal(app.baseUrl, forked.id);

      expect(app.buildCalls[1]?.brief).toBe('A different brief entirely.');
    } finally {
      await app.close();
    }
  });

  it('answers 404 for an unknown build id', async () => {
    const app = await startApp(tempRoot);
    try {
      const response = await post(app.baseUrl, '/api/agency/builds/does-not-exist/fork');
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe('BUILD_NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('answers 409 BUILD_NOT_FORKABLE when the saved build has no publishable project', async () => {
    // A cancelled build whose rollback succeeded: no `projectId` left on the snapshot, per
    // `settle()`'s `cancelled` case in `routes/agency-build.ts`.
    const store = createAgencyBuildStore(buildsFileFor(tempRoot));
    await store.save({
      snapshot: {
        id: 'rolled-back-1',
        status: 'cancelled',
        family: 'wrenfield',
        events: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      fork: { brief: BRIEF, family: 'wrenfield', mode: 'sections', verify: 'strict', provider: 'deepseek' },
    });

    const app = await startApp(tempRoot);
    try {
      const response = await post(app.baseUrl, '/api/agency/builds/rolled-back-1/fork');
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe('BUILD_NOT_FORKABLE');
      expect(app.buildCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('answers 409 BUILD_BUSY under the same one-at-a-time lock as POST /api/agency/build', async () => {
    const app = await startApp(tempRoot);
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF }));
      expect((await waitForTerminal(app.baseUrl, started.id)).status).toBe('done');

      // Hold the lock with a build that never resolves.
      app.state.buildImpl = () => new Promise<BuildResult>(() => {});
      const busy = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF }));
      expect(busy.status).toBe('queued');

      const response = await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe('BUILD_BUSY');
    } finally {
      // `busy` above is gated on a `buildImpl` that never resolves, by design — draining would
      // wait on it forever.
      await app.close({ drain: false });
    }
  });

  it('keeps a pre-provider fork seed forkable: hydrate fills provider "deepseek" rather than dropping it', async () => {
    // Written directly, bypassing `store.save()`, the way a build persisted before `provider`
    // existed on `AgencyBuildForkSeed` actually looks on disk: `fork` carries no `provider` key
    // at all. `normalizeForkSeed` (`agency-build-store.ts`) must fill it in as `'deepseek'` — this
    // daemon's only provider before the field shipped — rather than dropping the whole seed and
    // making the build unforkable and unrepairable for good.
    mkdirSync(path.dirname(buildsFileFor(tempRoot)), { recursive: true });
    writeFileSync(
      buildsFileFor(tempRoot),
      JSON.stringify({
        schema: 'agency-builds/1',
        builds: [
          {
            snapshot: {
              id: 'pre-provider-1',
              status: 'done',
              family: 'wrenfield',
              projectId: 'project-1',
              events: [],
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
            fork: { brief: BRIEF, family: 'wrenfield', mode: 'sections', verify: 'strict' },
          },
        ],
      }),
    );

    const app = await startApp(tempRoot);
    try {
      const response = await post(app.baseUrl, '/api/agency/builds/pre-provider-1/fork');
      expect(response.status).toBe(202);
      const forked = (await response.json() as AgencyBuildForkResponse).build;
      expect((await waitForTerminal(app.baseUrl, forked.id)).status).toBe('done');

      expect(app.buildCalls).toHaveLength(1);
      expect(app.buildCalls[0]?.provider).toBe('deepseek');
    } finally {
      await app.close();
    }
  });

  it('reuses a stored designReferenceId that predates (or fails) the current shape rule, without a fresh-build shape 400 (delta audit round 2 finding 1)', async () => {
    // Written directly, the way a fork seed saved before `validateDesignReferenceShape` existed
    // (or under a looser rule) actually looks on disk: an id with neither recognized prefix.
    // `normalizeForkSeed` has no format opinion on `designReferenceId` (only non-empty string), so
    // this hydrates intact. The fork route must NOT re-run the current shape rule against a
    // seed-derived id — only against one the CALLER of this fork request supplied — so an omitted
    // `designReferenceId`/`designReferenceText` (reuse-the-saved-one) must reach the real fetch
    // (`fetchMotionSitesDesignReference`) rather than being rejected up front by the shape check.
    const LEGACY_ID = 'legacy-external-id-no-recognized-prefix';
    mkdirSync(path.dirname(buildsFileFor(tempRoot)), { recursive: true });
    writeFileSync(
      buildsFileFor(tempRoot),
      JSON.stringify({
        schema: 'agency-builds/1',
        builds: [
          {
            snapshot: {
              id: 'legacy-reference-1',
              status: 'done',
              family: 'wrenfield',
              projectId: 'project-1',
              events: [],
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
            fork: {
              brief: BRIEF,
              family: 'wrenfield',
              mode: 'sections',
              verify: 'strict',
              provider: 'deepseek',
              sectionSelection: {
                entryId: 'hyperui:marketing/ctas/1',
                placement: { mode: 'append', afterSectionId: 'hero' },
                directionId: 'modern-minimal',
              },
              designReferenceId: LEGACY_ID,
            },
          },
        ],
      }),
    );

    const app = await startApp(tempRoot);
    try {
      // No designReferenceId/designReferenceText in the request: reuses the saved (legacy) id.
      const response = await post(app.baseUrl, '/api/agency/builds/legacy-reference-1/fork');
      // Refused, but by the REAL fetch's own error — not the shape validator's. A shape-rule
      // rejection would say "must start with"/"must be at most"; this must say neither, and must
      // name the id, proving `fetchMotionSitesDesignReference` actually ran against it.
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.message).toContain(LEGACY_ID);
      expect(error.message).not.toContain('must start with');
      expect(error.message).not.toContain('must be at most');
    } finally {
      await app.close();
    }
  });
});
