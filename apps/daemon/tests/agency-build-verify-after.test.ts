// The verify-after-render play's daemon half (docs/plans/2026-09-22-generative-ui-design.md §5,
// docs/plans/2026-09-22-generative-ui-plan.md Task 3): a `verify: 'after'` build's deferred
// faithfulness verdict lands on the build's own `verify` field — `pending` the moment the page
// publishes, `done` (with the flagged slot paths) once the background check resolves, which here
// is deliberately AFTER this suite's own poll has already observed `pending` — and
// `POST /api/agency/builds/:id/repair` re-fills exactly those flagged paths, with every other
// editable path locked, and reports what it cleared.
//
// `registerAgencyBuildRoutes` is mounted on a bare Express app with a fake `runBuild` (the fast
// lane's `buildSite`, injected exactly as `agency-build-routes.test.ts` and
// `agency-build-persistence.test.ts` already do), so nothing here spends a model call or reaches
// Jev. The fake controls BOTH the events it emits and what it returns, so it can simulate the
// deferred check taking real wall-clock time before the daemon ever sees a `verify` event.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgencyBuildRepairResponse,
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  ApiErrorResponse,
} from '@open-design/contracts';
import type { BuildDeps, BuildInput, BuildResult, PreparedBuild } from '@open-design/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

/** The one slot the deferred check flags. A real absolute path label, so this suite's own
 * `lockPaths` assertion (every OTHER editable path in `RECIPE` below) means something. */
const FLAGGED_PATH = 'sections[0].text.heading';

/** A minimal recipe the fake build "publishes": one brand field and one section with two text
 * leaves. `id`/`type` are excluded from `collectFaithfulnessSlots`'s walk the same way the real
 * fast lane excludes them (the anchor key, and a structural key locked everywhere), so this
 * recipe's only three editable text paths are `brand.name`, `sections[0].text.heading` (flagged)
 * and `sections[0].text.body`. */
const RECIPE = {
  schemaVersion: 2,
  family: 'wrenfield',
  revision: 1,
  brand: { name: 'Wrenfield Remodeling' },
  sections: [{ id: 'hero', type: 'hero', text: { heading: 'Old heading the check flagged', body: 'Body copy nobody flagged.' } }],
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

// ---------------------------------------------------------------------------
// Harness — one bare Express app per test, a fully injected `runBuild`.
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
let tempRoot = '';
let buildImpl: (input: BuildInput, deps: BuildDeps) => Promise<BuildResult>;
/** What the repair call's own `prepare()` resolved to — the daemon calls it with the routed
 * family, exactly as a normal build does; capturing it here is how this suite checks the
 * `lockPaths` a repair actually asked for without needing a real fast-lane fill. */
let repairPrepared: PreparedBuild | undefined;
/** The family schema the fake package carries; a test marks `x-mock` slots on it. */
let packageSchema: Record<string, unknown> = {};
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's (or repair's) fire-and-forget `persist()` write never races the directory it
 * writes into being removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-build-verify-after-'));
  repairPrepared = undefined;
  packageSchema = {};
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
      runBuild: (input, deps) => buildImpl(input, deps),
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: () => Promise.resolve('jev-key'),
        resolveModelKey: () => Promise.resolve('model-key'),
      },
      loadPackage: async (family) => ({ family, schema: packageSchema }) as never,
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

/** Polls `GET /api/agency/builds/:id` until `predicate` is true, or fails after ~2s. Used instead
 * of waiting for a terminal status: this suite's whole point is a window where the build is still
 * running (or already `done`) but `verify` has not caught up to `done` yet. */
async function pollUntil(id: string, predicate: (snapshot: AgencyBuildSnapshot) => boolean): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await buildOf(await get(`/api/agency/builds/${id}`));
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition never became true for build ${id}`);
}

// ---------------------------------------------------------------------------

describe('verify: after — the deferred verdict and the repair pass', () => {
  it('records verify.status pending, then done with the flagged path, once the background check resolves', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
      // The check "resolves after the build response": `POST /api/agency/build` already answered
      // 202 before this function was even called (`startBuild` writes the response, then runs the
      // build in a background IIFE — see `routes/agency-build.ts`), and this delay proves the
      // `pending` state is independently observable before `verify` fires, not just a value that
      // happens to flash past between two synchronous events.
      await new Promise((resolve) => setTimeout(resolve, 40));
      input.onEvent?.({
        type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
        flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
      });
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    expect(started.status).toBe('queued');

    const pending = await pollUntil(started.id, (s) => s.verify !== undefined);
    expect(pending.verify).toEqual({ status: 'pending', flagged: [] });
    // Not yet `done`: the check is still "running" (the 40ms delay above has not elapsed).
    expect(['queued', 'routing', 'building', 'verifying', 'publishing']).toContain(pending.status);

    const done = await pollUntil(started.id, (s) => s.verify?.status === 'done');
    expect(done.verify).toEqual({ status: 'done', flagged: [FLAGGED_PATH], ms: 12 });
    expect(done.status).toBe('done');
  });

  it('POST .../:id/repair re-fills only the flagged path, locking everything else, and clears the verdict', async () => {
    let repairJudged: boolean | undefined;
    let repairReplay: boolean | undefined;
    buildImpl = async (input) => {
      if (input.verify === 'after') {
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
          flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
        });
        return {
          outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      // The repair pass: `verify: 'advisory'`, the SAME project, every path locked but the one
      // flagged — asserted below via `repairPrepared`, not here, so the assertion reads as the
      // test's own claim rather than something the fake quietly enforces on itself.
      repairPrepared = await input.prepare(input.family === 'auto' ? 'wrenfield' : input.family);
      repairJudged = input.judgeSections;
      repairReplay = input.effectsReplay;
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({
          recipe: { ...RECIPE, sections: [{ id: 'hero', type: 'hero', text: { heading: 'A heading the brief actually supports', body: 'Body copy nobody flagged.' } }] },
          verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 4 },
        }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    const done = await pollUntil(started.id, (s) => s.verify?.status === 'done');
    expect(done.verify?.flagged).toEqual([FLAGGED_PATH]);
    expect(done.projectId).toBe('project-1');

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);
    const body = await repairResponse.json() as AgencyBuildRepairResponse;
    expect(body).toEqual({ repaired: [FLAGGED_PATH], remaining: [] });

    // Every editable path this recipe carries EXCEPT the flagged one was locked — proving the
    // repair asked the fast lane to re-fill exactly one path, not the whole page again.
    expect(repairPrepared).toBeDefined();
    expect([...repairPrepared!.lockPaths ?? []].sort()).toEqual(['brand.name', 'sections[0].text.body']);
    expect(repairPrepared!.spine).toEqual(RECIPE);
    expect(repairPrepared!.entry).toBe('wrenfield-r1.html');
    // The published recipe's optional-section drops are already decided: no new keep/drop request.
    expect(repairJudged).toBe(false);
    // The effect plan is a replay: its ids come back as `source: 'repair'`, not as request hints.
    expect(repairReplay).toBe(true);

    // The build's own verdict now shows nothing flagged.
    const after = await buildOf(await get(`/api/agency/builds/${started.id}`));
    expect(after.verify).toEqual({ status: 'done', flagged: [], ms: 4 });
  });

  it('POST .../:id/repair never re-generates an x-mock slot, even when a flag names one', async () => {
    // `body` is illustrative sample data in this schema. A checker regression flags it alongside
    // the heading; the repair must still lock it and re-fill only the heading.
    packageSchema = {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'object', properties: { text: { type: 'object', properties: { body: { type: 'string', 'x-mock': true } } } } } },
      },
    };
    const MOCK_PATH = 'sections[0].text.body';
    buildImpl = async (input) => {
      if (input.verify === 'after') {
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 2, repaired: 0, remaining: 2, ms: 12,
          flaggedPaths: [FLAGGED_PATH, MOCK_PATH], remainingPaths: [FLAGGED_PATH, MOCK_PATH],
        });
        return {
          outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH, MOCK_PATH], repaired: 0, remaining: [FLAGGED_PATH, MOCK_PATH], ms: 12 } }),
        };
      }
      repairPrepared = await input.prepare(input.family === 'auto' ? 'wrenfield' : input.family);
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ verify: { provider: 'jev', checked: 1, illustrative: 1, flagged: [], repaired: 0, remaining: [], ms: 4 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');
    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);

    const locked = [...repairPrepared!.lockPaths ?? []].sort();
    expect(locked).toContain(MOCK_PATH);
    expect(locked).not.toContain(FLAGGED_PATH);
    expect(locked).toEqual(['brand.name', MOCK_PATH]);
  });

  it('guards against two near-simultaneous repairs: the second gets 409, only one runBuild happens, and a later repair is allowed again', async () => {
    let repairCalls = 0;
    buildImpl = async (input) => {
      if (input.verify === 'after') {
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
          flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
        });
        return {
          outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      // The repair pass. Deliberately takes real wall-clock time (so a second request fired
      // without awaiting the first actually lands while this one is still in flight) and
      // deliberately never clears the flag (`remaining` always still names it) — this suite
      // repairs the SAME build three times, and each call needs something left to repair.
      repairCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ recipe: RECIPE, verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [FLAGGED_PATH], ms: 4 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');

    // Fired together, neither awaited on its own — both requests are in flight before either
    // answers, which is exactly the window the `repairing` guard exists to close.
    const [first, second] = await Promise.all([
      post(`/api/agency/builds/${started.id}/repair`),
      post(`/api/agency/builds/${started.id}/repair`),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect((await errorOf(loser)).code).toBe('BUILD_REPAIR_IN_PROGRESS');
    expect(repairCalls).toBe(1);

    // The winner's own answer is still the ordinary repair response.
    const winner = first.status === 200 ? first : second;
    expect(await winner.json()).toEqual({ repaired: [], remaining: [FLAGGED_PATH] });

    // Once the first repair has answered, a later one is allowed again — the guard is per-call,
    // not a one-way latch.
    const third = await post(`/api/agency/builds/${started.id}/repair`);
    expect(third.status).toBe(200);
    expect(repairCalls).toBe(2);
  });

  it('refuses BUILD_NOT_REPAIRABLE for a build that has nothing flagged', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
      input.onEvent?.({ type: 'verify', checked: 2, illustrative: 0, flagged: 0, repaired: 0, remaining: 0, ms: 12, flaggedPaths: [], remainingPaths: [] });
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 12 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(409);
    expect((await errorOf(repairResponse)).code).toBe('BUILD_NOT_REPAIRABLE');
  });

  it('refuses BUILD_NOT_REPAIRABLE for a build that was never verify: after (no verify field at all)', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'strict' }));
    const done = await pollUntil(started.id, (s) => s.status === 'done');
    expect(done.verify).toBeUndefined();

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(409);
    expect((await errorOf(repairResponse)).code).toBe('BUILD_NOT_REPAIRABLE');
  });
});
