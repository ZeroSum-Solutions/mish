// `provider`/`model` on `POST /api/agency/build` (docs/plans/2026-09-22-generative-ui-plan-part-2.md
// Task 6, steps 1 to 3): a request may name the fill provider (`deepseek` or `cerebras`) and an
// optional model override; both reach the fast lane's `runBuild` exactly as given, an unknown
// provider is refused the same way a bad `mode` already is, and a repair on a `verify: 'after'`
// build re-fills with the SAME provider (and model) the original build ran with — never the
// daemon's own default — because the pair is kept on the build's `forkSeed`, which is what
// survives a daemon restart (see `agency-build-store.ts`'s `AgencyBuildForkSeed`).
//
// Harness copied from `agency-build-verify-after.test.ts`: `registerAgencyBuildRoutes` mounted on
// a bare Express app with a fake `runBuild`, so nothing here spends a model call or reaches Jev.

import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencyBuildResponse, AgencyBuildSnapshot, ApiErrorResponse } from '@open-design/contracts';
import type { BuildDeps, BuildInput, BuildResult, PreparedBuild } from '@open-design/agency-fast-lane/build';
import { ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError } from '@open-design/agency-fast-lane/deepseek';
import { ProviderFailoverError } from '@open-design/agency-fast-lane/failover';
import { withBuildProvenance } from '@open-design/agency-fast-lane/build';

import { AgencyJevConfigUnreadableError, AgencyModelKeyUnavailableError, createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';
const FLAGGED_PATH = 'sections[0].text.heading';

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
/** Every `BuildInput` `runBuild` was called with, in call order — this suite's own assertion
 * surface for what `provider`/`model` actually reached the fast lane. */
let calls: BuildInput[];
let repairPrepared: PreparedBuild | undefined;
/** What the injected store's `resolveModelKey` does; a test replaces it to make the key fail. */
let modelKeyImpl: (provider: string) => Promise<string>;
/** `registerAgencyBuildRoutes`'s own completion signal for its build store: `persist()` saves a
 * build to disk fire-and-forget, so `afterEach` awaits this before removing `tempRoot` instead of
 * racing that background write (which otherwise intermittently loses `rmSync` to `ENOTEMPTY`). */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-build-provider-'));
  calls = [];
  repairPrepared = undefined;
  modelKeyImpl = () => Promise.resolve('model-key');
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
        resolveModelKey: (provider) => modelKeyImpl(provider),
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
  // Drain the store's own serialized save/load chain before touching its directory: `persist()`
  // in `routes/agency-build.ts` writes to `tempRoot/agency-builds/index.json` fire-and-forget, so
  // without this `rmSync` below can race that write and intermittently throw `ENOTEMPTY`.
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

// ---------------------------------------------------------------------------
// `routes.idle()` must wait for a build still running, not only for whatever the store already
// has queued: the 202 from `POST /api/agency/build` (or `/fork`) is sent before `startBuild`'s
// detached task even calls `runBuild`, so a caller that only awaits that response — exactly the
// shape of a test that starts a build and exits without polling it to a terminal status — cannot
// tell whether this build's `persist()` calls have happened yet. Draining only the store (as an
// earlier version of `idle()` did) can return before `persist()` is even CALLED, which leaves
// `afterEach`'s `rmSync` racing that call the same way it used to race `persist()`'s disk write.
// ---------------------------------------------------------------------------

describe('idle() waits for an in-flight build, not only for what the store already has queued', () => {
  it('a build that is never polled to a terminal status still blocks idle() until it actually finishes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    buildImpl = async (input) => {
      await gate;
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }],
        family: 'wrenfield', projectId: 'project-1', report: reportFixture(),
      };
    };

    try {
      const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
      // Deliberately no `pollUntil` here — this is exactly the "exits before the build reaches a
      // terminal state" shape the daemon's 202 contract allows a caller to stop at.
      const midFlight = await buildOf(await get(`/api/agency/builds/${started.id}`));
      expect(midFlight.status).not.toBe('done');

      const idled = routes.idle();
      let settledEarly = false;
      void idled.then(() => { settledEarly = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // `idle()` must still be pending: the build has not reached a terminal state, so its own
      // `persist()` call has not happened yet — a store-only drain would already have returned here,
      // since the only save queued so far (the build's initial `queued` record) settles almost
      // instantly.
      expect(settledEarly).toBe(false);

      release();
      await idled;
      expect(settledEarly).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      // A failed assertion above must not leave the build gated, or teardown's idle() waits on it.
      release();
    }
  });
});

// ---------------------------------------------------------------------------

describe('provider and model on POST /api/agency/build', () => {
  it('reaches runBuild with the requested provider and model', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture({ model: 'gpt-oss-120b' }) };
    };

    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF, family: 'wrenfield', provider: 'cerebras', model: 'gpt-oss-120b',
    }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('cerebras');
    expect(calls[0]?.model).toBe('gpt-oss-120b');
  });

  it('defaults to deepseek with no model override when the request names neither', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('deepseek');
    expect(calls[0]?.model).toBeUndefined();
  });

  it('refuses an unknown provider the same way a bad mode is refused', async () => {
    const response = await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', provider: 'openai' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('a repair on an after build made with cerebras calls runBuild with cerebras again', async () => {
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
          outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      repairPrepared = await input.prepare(input.family === 'auto' ? 'wrenfield' : input.family);
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ recipe: RECIPE, verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 4 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', {
      brief: BRIEF, family: 'wrenfield', verify: 'after', provider: 'cerebras', model: 'gpt-oss-120b',
    }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('cerebras');

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.provider).toBe('cerebras');
    expect(calls[1]?.model).toBe('gpt-oss-120b');
    expect(repairPrepared).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 6 step 9: `DEFAULT_MODEL_BY_FAMILY` — the 2026-09-22 bake-off winners
// (`work/genui-2026-09-22/bakeoff/REPORT.md`) as the per-family fill default, applied only when
// the request omits `provider`. `family: 'auto'` is resolved a different way (see the last case
// below): the family is not known until `runBuild` itself routes the brief, so the daemon threads
// `defaultModelFor` through to it instead of resolving eagerly.
// ---------------------------------------------------------------------------

describe('bake-off winners as the default fill model per family (Task 6 step 9)', () => {
  it('family: crm-dashboard with no provider reaches runBuild with the bake-off winner', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'crm-dashboard', projectId: 'project-1', report: reportFixture({ family: 'crm-dashboard', model: 'gpt-oss-120b' }) };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'crm-dashboard' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('cerebras');
    expect(calls[0]?.model).toBe('gpt-oss-120b');
  });

  it.each(['listings', 'publication', 'nonprofit', 'docs-hub'])('family: %s (an M4 page kind) with no provider reaches runBuild on cerebras gpt-oss-120b', async (family) => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return {
        outcome: 'built', provider: 'cerebras', model: 'gpt-oss-120b', providers: [{ provider: 'cerebras', model: 'gpt-oss-120b' }], family, projectId: 'project-1',
        report: reportFixture({ family, model: 'gpt-oss-120b' }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('cerebras');
    expect(calls[0]?.model).toBe('gpt-oss-120b');
  });

  it('a family the bake-off did not cover keeps the daemon default, no model, when the request names no provider', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'watson', projectId: 'project-1', report: reportFixture({ family: 'watson' }) };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'watson' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('deepseek');
    expect(calls[0]?.model).toBeUndefined();
  });

  it('family: restaurant (an explicit DEFAULT_MODEL_BY_FAMILY entry with no model) resolves identically to a family the table does not mention at all', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'restaurant', projectId: 'project-1', report: reportFixture({ family: 'restaurant' }) };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'restaurant' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('deepseek');
    expect(calls[0]?.model).toBeUndefined();
  });

  it('family: crm-dashboard with an explicit provider keeps that provider and no model, same as today', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'crm-dashboard', projectId: 'project-1', report: reportFixture({ family: 'crm-dashboard' }) };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'crm-dashboard', provider: 'deepseek' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('deepseek');
    expect(calls[0]?.model).toBeUndefined();
  });

  it('family: auto with no provider leaves runBuild to resolve the winner once it knows the routed family', async () => {
    // `startBuild` cannot pick `crm-dashboard`'s default before `family: 'auto'` routes — nothing
    // in the route handler learns the routed family. So the request reaches the fake `runBuild`
    // with `provider` still unresolved, plus a `defaultModelFor` callback; this fake plays the
    // part `buildSite` plays for real (route, then resolve), calling it once it "knows" the brief
    // routed to `crm-dashboard`, exactly as the real build path does right after routing.
    let resolved: { provider: string; model?: string } | undefined;
    buildImpl = async (input) => {
      resolved = input.defaultModelFor?.('crm-dashboard');
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return { outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'crm-dashboard', projectId: 'project-1', report: reportFixture({ family: 'crm-dashboard', model: 'gpt-oss-120b' }) };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'auto' }));
    await pollUntil(started.id, (s) => s.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBeUndefined();
    expect(calls[0]?.defaultModelFor).toBeInstanceOf(Function);
    expect(resolved).toEqual({ provider: 'cerebras', model: 'gpt-oss-120b' });
  });
});

// ---------------------------------------------------------------------------
// `BUILD_FAILED` classifies WHAT threw and builds a fixed sentence from its structured fields —
// never a copy of `.message`, which can carry a response body (an earlier version of this read
// the caught error's first line, which fixed the body leak below but reopened the same hole for
// any error whose `.message` embeds free text, such as a model-refusal error quoting the brief
// and the model's own output). `console.error` still gets the whole error either way — this only
// changes what a client sees on the snapshot.
// ---------------------------------------------------------------------------

describe('BUILD_FAILED names the cause from the error\'s class, never its free text', () => {
  it('an error with no recognized class gets the plain sentence, not a copy of its message', async () => {
    buildImpl = async () => {
      throw new Error('recipe refused: sections[1].items[0].value exceeds 24 chars\nmore');
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');

    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed' });
  });

  it('a ProviderHttpError becomes a status-only sentence built from its own fields, never its detail', async () => {
    buildImpl = async () => {
      throw new ProviderHttpError('cerebras', 429, 'SECRET-BODY');
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');

    expect(snapshot.error).toEqual({ code: 'BUILD_FAILED', message: 'the build failed: cerebras answered 429' });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET-BODY');
  });
});

// ---------------------------------------------------------------------------
// The fork seed catches up once `family: 'auto'` has actually routed (bake-off follow-up): a
// build made with no `provider` named routes first, then fills with `defaultModelFor(routedFamily)`
// inside `runBuild` — so `job.forkSeed`, built before routing ran, must be corrected once
// `settle()` learns the routed family, or `/repair` would silently re-fill with the placeholder
// provider instead of the one this build actually used.
// ---------------------------------------------------------------------------

describe('the fork seed catches up once family: auto has actually routed', () => {
  it('a repair on an auto-routed, provider-omitted build reuses the resolved winner, not the placeholder', async () => {
    buildImpl = async (input) => {
      if (input.verify === 'after') {
        // Plays the part `buildSite` plays for real: `family: 'auto'` routes to `marketing-site`,
        // then resolves the default via the threaded `defaultModelFor` callback.
        expect(input.provider).toBeUndefined();
        expect(input.defaultModelFor?.('marketing-site')).toEqual({ provider: 'cerebras', model: 'gpt-oss-120b' });
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/marketing-site-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
          flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
        });
        return {
          outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'marketing-site', projectId: 'project-1',
          report: reportFixture({ family: 'marketing-site', model: 'gpt-oss-120b', verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      repairPrepared = await input.prepare(input.family === 'auto' ? 'marketing-site' : input.family);
      return {
        outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'marketing-site', projectId: 'project-1',
        report: reportFixture({ family: 'marketing-site', recipe: RECIPE, verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 4 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'auto', verify: 'after' }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBeUndefined();

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.provider).toBe('cerebras');
    expect(calls[1]?.model).toBe('gpt-oss-120b');
    expect(repairPrepared).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Provider failover (M1 / C5): the failure sentence names the error class and both outcomes, a
// missing key on both sides stays MODEL_UNAVAILABLE, and the snapshot records the provider that
// actually answered while the fork seed keeps the requested primary.
// ---------------------------------------------------------------------------

describe('provider failover on the build snapshot', () => {
  it('a ProviderFailoverError names its class and both provider outcomes, status-only', async () => {
    buildImpl = async () => {
      throw new ProviderFailoverError([
        { provider: 'deepseek', reason: 'rate-limited', status: 429 },
        { provider: 'cerebras', reason: 'timeout' },
      ]);
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');

    expect(snapshot.error).toEqual({
      code: 'BUILD_FAILED',
      message: 'the build failed (ProviderFailoverError): deepseek answered 429, then cerebras timed out',
    });
  });

  it('a section accepted from one provider, then a dual-provider failure: the failed snapshot keeps that provider', async () => {
    // What `buildSite` throws when the hero answered on deepseek and a later section then lost
    // both providers: the failover error, carrying the accepted section's provenance.
    buildImpl = async () => {
      throw withBuildProvenance(
        new ProviderFailoverError([
          { provider: 'deepseek', reason: 'server-error', status: 503 },
          { provider: 'cerebras', reason: 'server-error', status: 503 },
        ]),
        { provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash', sections: ['hero'] }] },
      );
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', mode: 'sections' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');

    expect(snapshot.error?.code).toBe('BUILD_FAILED');
    expect(snapshot.provider).toBe('deepseek');
    expect(snapshot.model).toBe('deepseek-flash');
    expect(snapshot.providers).toEqual([{ provider: 'deepseek', model: 'deepseek-flash', sections: ['hero'] }]);
    // Persisted, not only held in memory: the build history file carries it too.
    // The write is asynchronous and an earlier write holds the queued snapshot, so wait for the
    // failed one rather than read once.
    const indexFile = path.join(tempRoot, 'agency-builds', 'index.json');
    const failedRecord = (text: string) => text.includes('"status":"failed"') && text.includes(started.id);
    let persisted = '';
    for (let attempt = 0; attempt < 200 && !failedRecord(persisted); attempt += 1) {
      try { persisted = JSON.stringify(JSON.parse(readFileSync(indexFile, 'utf8'))); } catch { persisted = ''; }
      if (!failedRecord(persisted)) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(persisted).toMatch(/"providers":\[\{"provider":"deepseek","model":"deepseek-flash","sections":\["hero"\]\}\]/);
  });

  it('a failure before any provider answered leaves provider, model and providers unset', async () => {
    buildImpl = async () => { throw new ProviderFailoverError([{ provider: 'deepseek', reason: 'timeout' }, { provider: 'cerebras', reason: 'timeout' }]); };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');
    expect(snapshot.provider).toBeUndefined();
    expect(snapshot.providers).toBeUndefined();
  });

  it('a repair whose key store fails logs the class and code only, never the resolver cause', async () => {
    const SECRET = 'sk-live-SENTINEL-4f9a2c';
    buildImpl = async (input, deps) => {
      if (input.verify === 'after') {
        input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
        input.onEvent?.({ type: 'registered', ms: 900 });
        input.onEvent?.({ type: 'preview', url: 'project-1/wrenfield-r1.html', ms: 900 });
        input.onEvent?.({
          type: 'verify', checked: 2, illustrative: 0, flagged: 1, repaired: 0, remaining: 1, ms: 12,
          flaggedPaths: [FLAGGED_PATH], remainingPaths: [FLAGGED_PATH],
        });
        return {
          outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      // The repair pass: the key store throws an error whose message carries the key itself.
      modelKeyImpl = async () => { throw Object.assign(new TypeError(`parse failed near "${SECRET}"`), { code: 'ERR_STORE_IO' }); };
      await deps.resolveModelKey('deepseek');
      throw new Error('unreachable: the resolver threw');
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after' }));
    await pollUntil(started.id, (s) => s.verify?.status === 'done');

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
      expect(repairResponse.status).toBe(500);
      const lines = logged.mock.calls.map((call) => call.map((part) => (part instanceof Error ? `${part.stack} ${String(part.cause)}` : String(part))).join(' '));
      expect(lines.some((line) => line.includes('repair failed: could not read the deepseek key: TypeError ERR_STORE_IO'))).toBe(true);
      expect(lines.join('\n')).not.toContain(SECRET);
      expect(JSON.stringify(logged.mock.calls, (_key, value) => (value instanceof Error ? { message: value.message, cause: value.cause } : value))).not.toContain(SECRET);
    } finally {
      logged.mockRestore();
    }
  });

  it('a ProviderKeyError (no key on either provider) is MODEL_UNAVAILABLE, not BUILD_FAILED', async () => {
    buildImpl = async () => {
      throw new ProviderKeyError('cerebras', new Error('failed to read cerebras_api_key from zsvault'));
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');

    expect(snapshot.error).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' });
    expect(JSON.stringify(snapshot)).not.toContain('zsvault');
  });

  it('records the provider and model that answered, maps the failover event, and a fork retries the primary', async () => {
    buildImpl = async (input) => {
      input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
      input.onEvent?.({ type: 'failover', from: 'deepseek', to: 'cerebras', reason: 'server-error' });
      input.onEvent?.({ type: 'registered', ms: 900 });
      return {
        outcome: 'built', provider: 'cerebras', model: 'gpt-oss-120b', family: 'wrenfield', projectId: 'project-1',
        // Sections ran concurrently: two landed on deepseek before the switch, one after it.
        providers: [
          { provider: 'deepseek', model: 'deepseek-flash', sections: ['hero', 'about'] },
          { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['footer'] },
        ],
        report: reportFixture({ model: 'gpt-oss-120b' }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', provider: 'deepseek' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'done');

    expect(snapshot.provider).toBe('cerebras');
    expect(snapshot.model).toBe('gpt-oss-120b');
    expect(snapshot.providers).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash', sections: ['hero', 'about'] },
      { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['footer'] },
    ]);
    const failover = snapshot.events.find((event) => event.type === 'failover');
    expect(failover).toMatchObject({ type: 'failover', label: 'cerebras', reason: 'server-error' });

    const forked = await buildOf(await post(`/api/agency/builds/${snapshot.id}/fork`, {}));
    await pollUntil(forked.id, (s) => s.status === 'done');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.provider).toBe('deepseek');
  });
  it('a repair that fails over records the provider and model that answered the repair', async () => {
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
          outcome: 'built', provider: 'deepseek', model: 'deepseek-flash', providers: [{ provider: 'deepseek', model: 'deepseek-flash' }], family: 'wrenfield', projectId: 'project-1',
          report: reportFixture({ verify: { provider: 'jev', checked: 2, illustrative: 0, flagged: [FLAGGED_PATH], repaired: 0, remaining: [FLAGGED_PATH], ms: 12 } }),
        };
      }
      // The repair's own run: deepseek failed before output and cerebras answered.
      await input.prepare(input.family === 'auto' ? 'wrenfield' : input.family);
      return {
        outcome: 'built', provider: 'cerebras', model: 'gpt-oss-120b', providers: [{ provider: 'cerebras', model: 'gpt-oss-120b', sections: ['hero'] }], family: 'wrenfield', projectId: 'project-1',
        report: reportFixture({ model: 'gpt-oss-120b', recipe: RECIPE, verify: { provider: 'jev', checked: 1, illustrative: 0, flagged: [], repaired: 0, remaining: [], ms: 4 } }),
      };
    };

    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield', verify: 'after', provider: 'deepseek' }));
    const before = await pollUntil(started.id, (s) => s.verify?.status === 'done');
    expect(before.provider).toBe('deepseek');
    expect(before.model).toBe('deepseek-flash');

    const repairResponse = await post(`/api/agency/builds/${started.id}/repair`);
    expect(repairResponse.status).toBe(200);
    expect(calls[1]?.provider).toBe('deepseek');

    const after = await buildOf(await get(`/api/agency/builds/${started.id}`));
    expect(after.provider).toBe('cerebras');
    expect(after.model).toBe('gpt-oss-120b');
    expect(after.verify).toMatchObject({ status: 'done', flagged: [] });
    // The build's own deepseek output stays listed; the repair's cerebras output is added.
    expect(after.providers).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['hero'] },
    ]);

  });
});

describe('model key errors reach the fast lane classified', () => {
  it('a missing key reaches the fast lane as a plain rejection (eligible for failover)', async () => {
    modelKeyImpl = (provider) => Promise.reject(new AgencyModelKeyUnavailableError(provider as 'deepseek'));
    let seen: unknown;
    buildImpl = async (_input, deps) => {
      seen = await deps.resolveModelKey('deepseek').catch((error: unknown) => error);
      throw new ProviderKeyError('deepseek', seen);
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');
    expect(seen).toBeInstanceOf(Error);
    expect(seen).not.toBeInstanceOf(ProviderKeyUnreadableError);
    expect(snapshot.error).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' });
  });

  it('an unreadable stored config is a ProviderKeyUnreadableError with its own sentence', async () => {
    modelKeyImpl = () => Promise.reject(new AgencyJevConfigUnreadableError());
    let seen: unknown;
    buildImpl = async (_input, deps) => {
      seen = await deps.resolveModelKey('deepseek').catch((error: unknown) => error);
      throw seen;
    };
    const started = await buildOf(await post('/api/agency/build', { brief: BRIEF, family: 'wrenfield' }));
    const snapshot = await pollUntil(started.id, (s) => s.status === 'failed');
    expect(seen).toBeInstanceOf(ProviderKeyUnreadableError);
    expect((seen as ProviderKeyUnreadableError).provider).toBe('deepseek');
    expect((seen as ProviderKeyUnreadableError).cause).toBeInstanceOf(AgencyJevConfigUnreadableError);
    expect(snapshot.error).toEqual({ code: 'MODEL_UNAVAILABLE', message: 'the stored model key file could not be read on this daemon' });
  });
});
