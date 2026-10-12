// Block composition through the build job API (Sol ruling 2026-09-25, cult-port-sol.md task 7):
// `composition` is validated, threaded to `buildSite` with the block catalog, reported on the
// snapshot and its `composition` event, persisted with the plan a composed build used, replayed
// exactly by a fork (and dropped when the fork names another composition), and replayed by a
// repair of a composed page. The harness is `agency-build-persistence.test.ts`'s: a bare Express
// app, a fake `runBuild`, mounted twice on one data directory for the restart case.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgencyBuildForkResponse, AgencyBuildResponse, AgencyBuildSnapshot, ApiErrorResponse } from '@mish/contracts';
import type { BuildDeps, BuildInput, BuildResult } from '@mish/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { brandHit } from './helpers/cult-brands.js';
import { registerAgencyBuildRoutes, toCompositionDto, publicSnapshotIds } from '../src/routes/agency-build.js';

const BRIEF = 'Ledgerline, accounting software for small agencies. Start a free trial.';
const PLAN = { spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-shadcn', 'cult:marketing-cta-cosmic', 'cult:marketing-footer-apple'] };
/** `PLAN.blocks` as a build reports them: Cult blocks by public id. */
const PUBLIC_BLOCKS = ['hyperui:marketing/sections/1', 'cult:bento-gradient', 'cult:cta-cosmic', 'cult:footer-series-a'];

type Report = Extract<BuildResult, { outcome: 'built' }>['report'];

function composedRecipe() {
  return { kind: 'composed-page', version: 1, plan: PLAN, chrome: { text: { brand: 'Ledgerline', tagline: 'Accounting software' } }, blocks: PLAN.blocks.map(() => ({ text: { heading: 'x' } })) };
}

/** `overrides` may set a field to `undefined` to drop it. */
function report(overrides: { [K in keyof Report]?: Report[K] | undefined } = {}): Report {
  const built: Record<string, unknown> = {
    family: 'composed', mode: 'sections', model: 'deepseek-v4-flash', entry: 'composed-r1.html', revision: 1, projectId: 'project-1',
    timings: { totalMs: 10, registeredMs: 9 }, calls: 5, repairs: 0, retries: 0, paints: 1, usage: { input: 1, output: 1, cachedRead: 0 },
    applied: 10, missing: [], nulled: [], truncated: [], units: [], recipeDigest: 'd', recipe: composedRecipe(), html: '<!doctype html>',
    manifest: { entry: 'composed-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'd', revision: '1', family: 'composed' } } },
    approvedAssets: [],
    composition: { requested: 'blocks', used: 'blocks', spine: PLAN.spine, directionId: PLAN.directionId, blocks: PLAN.blocks, source: 'jev', planner: { calls: 2, ms: 1000 }, effects: { mode: 'off', reason: 'no-placements' } },
    ...overrides,
  };
  for (const key of Object.keys(built)) if (built[key] === undefined) delete built[key];
  return built as unknown as Report;
}

/** A fake `buildSite` that behaves like a composed build: the composition event first, then the report. */
async function composedBuild(input: BuildInput): Promise<BuildResult> {
  const source = input.blockPlan ? 'replay' : 'jev';
  const composition = { requested: input.composition ?? 'family', used: 'blocks' as const, spine: PLAN.spine, directionId: PLAN.directionId, blocks: PLAN.blocks, source: source as 'jev' | 'replay', ...(source === 'jev' ? { planner: { calls: 2, ms: 1000 } } : {}) };
  input.onEvent?.({ type: 'composition', result: composition, ms: 3 });
  input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
  return {
    outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'composed', projectId: 'project-1',
    report: report({
      composition: { ...composition, effects: { mode: 'off', reason: 'no-placements' } },
    }),
  };
}

interface Harness { baseUrl: string; calls: BuildInput[]; state: { impl: (input: BuildInput, deps: BuildDeps) => Promise<BuildResult> }; close: () => Promise<void> }

async function startApp(dataDir: string): Promise<Harness> {
  const calls: BuildInput[] = [];
  const state: Harness['state'] = { impl: composedBuild };
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const routes = registerAgencyBuildRoutes(app, {
    http: { sendApiError, createSseResponse, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as never,
    paths: { RUNTIME_DATA_DIR: dataDir } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: [] } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir, readVaultSecret: () => Promise.resolve('jev-key') }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input, deps) => { calls.push(input); return state.impl(input, deps); },
      buildDeps: {
        createModelCaller: () => { throw new Error('no model'); },
        createJevChecker: () => { throw new Error('no jev'); },
        createJevRouter: () => { throw new Error('no jev'); },
        resolveJevCredential: () => Promise.resolve('jev-key'),
        resolveModelKey: () => Promise.resolve('model-key'),
      },
      loadPackage: async (family) => ({ family, schema: {} }) as never,
      buildsFile: path.join(dataDir, 'agency-builds', 'index.json'),
      loadBlockCatalog: async () => ({ blocks: [] }),
    },
  });
  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, state, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    // Drains any build still in flight, then the store's own save/load chain — never only the
    // store, which can return before a build that was never polled to a terminal status has even
    // called `persist()` once (see `agency-build-provider.test.ts`'s `idle()` tests).
    await routes.idle();
  } };
}

const post = (baseUrl: string, url: string, body?: unknown) => fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;

async function waitFor(baseUrl: string, id: string, predicate: (build: AgencyBuildSnapshot) => boolean): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const build = await buildOf(await fetch(`${baseUrl}/api/agency/builds/${id}`));
    if (predicate(build)) return build;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never reached the expected state');
}
const terminal = (build: AgencyBuildSnapshot) => ['done', 'unrouted', 'failed', 'cancelled'].includes(build.status);

let tempRoot = '';
beforeEach(() => { tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-composition-')); });
afterEach(() => { if (tempRoot) rmSync(tempRoot, { force: true, recursive: true }); tempRoot = ''; });

describe('POST /api/agency/build composition', () => {
  it('rejects an unknown composition and blocks/auto with a sectionSelection', async () => {
    const app = await startApp(tempRoot);
    try {
      const bad = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'pages' });
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).message).toBe('composition must be one of family, blocks, auto');
      const mixed = await post(app.baseUrl, '/api/agency/build', {
        brief: BRIEF, family: 'wrenfield', composition: 'blocks',
        sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'hero' }, directionId: 'modern-minimal' },
      });
      expect(mixed.status).toBe(400);
      expect(app.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('family (omitted) passes no composition and no block catalog to the build', async () => {
    const app = await startApp(tempRoot);
    app.state.impl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'm', providers: [], family: 'wrenfield', projectId: 'project-1', report: report({ family: 'wrenfield', composition: undefined, recipe: {} }) });
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF }));
      const done = await waitFor(app.baseUrl, started.id, terminal);
      expect(done.composition).toBeUndefined();
      expect(app.calls[0]!.composition).toBeUndefined();
      expect(app.calls[0]!.loadBlockCatalog).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('blocks: threads the catalog, reports the plan on the snapshot and its composition event', async () => {
    const app = await startApp(tempRoot);
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'blocks' }));
      const done = await waitFor(app.baseUrl, started.id, terminal);
      expect(done.status).toBe('done');
      expect(app.calls[0]!.composition).toBe('blocks');
      expect(typeof app.calls[0]!.loadBlockCatalog).toBe('function');
      expect(done.family).toBe('composed');
      expect(done.outputScope).toBe('site');
      // Cult blocks are reported by public id (`cult:<slug>`), on the snapshot and in its event.
      expect(done.composition).toEqual({ requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'tech-utility', blocks: PUBLIC_BLOCKS, source: 'jev', planner: { calls: 2, ms: 1000 }, effects: { mode: 'off', reason: 'no-placements' } });
      const event = done.events.find((entry) => entry.type === 'composition');
      expect(event?.composition?.blocks).toEqual(PUBLIC_BLOCKS);
      expect(event?.composition?.planner).toEqual({ calls: 2, ms: 1000 });
      // The whole snapshot names a model provider (`deepseek`), so the check reads the Cult parts.
      expect(brandHit(JSON.stringify([done.composition, event]))).toBeNull();
      const { builds } = await (await fetch(`${app.baseUrl}/api/agency/builds`)).json() as { builds: Array<{ id: string; composition?: unknown }> };
      const listed = builds.find((build) => build.id === started.id)!;
      expect((listed.composition as { blocks: string[] }).blocks).toEqual(PUBLIC_BLOCKS);
      expect(brandHit(JSON.stringify(listed.composition))).toBeNull();
      expect(JSON.stringify(done)).not.toContain(BRIEF);
    } finally {
      await app.close();
    }
  });

  it('a family fallback is reported with its fixed code and the build keeps its routed family', async () => {
    const app = await startApp(tempRoot);
    app.state.impl = async (input) => {
      input.onEvent?.({ type: 'composition', result: { requested: 'auto', used: 'family', fallback: 'no-coverage' }, ms: 1 });
      return { outcome: 'built', provider: 'deepseek', model: 'm', providers: [], family: 'wrenfield', projectId: 'project-1', report: report({ family: 'wrenfield', recipe: {}, composition: { requested: 'auto', used: 'family', fallback: 'no-coverage' } }) };
    };
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'auto' }));
      const done = await waitFor(app.baseUrl, started.id, terminal);
      expect(done.composition).toEqual({ requested: 'auto', used: 'family', fallback: 'no-coverage' });
      expect(done.family).toBe('wrenfield');
    } finally {
      await app.close();
    }
  });
});

describe('fork and repair keep the plan', () => {
  it('a fork after a restart replays the saved plan as blocks, whatever the original requested', async () => {
    const first = await startApp(tempRoot);
    const started = await buildOf(await post(first.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'auto' }));
    await waitFor(first.baseUrl, started.id, terminal);
    await first.close();

    const second = await startApp(tempRoot);
    try {
      const response = await post(second.baseUrl, `/api/agency/builds/${started.id}/fork`);
      expect(response.status).toBe(202);
      const forked = (await response.json() as AgencyBuildForkResponse).build;
      const done = await waitFor(second.baseUrl, forked.id, terminal);
      expect(second.calls[0]!.composition).toBe('blocks');
      expect(second.calls[0]!.blockPlan).toEqual(PLAN);
      expect(done.composition?.source).toBe('replay');
    } finally {
      await second.close();
    }
  });

  it('a fork that names a composition asks afresh; family drops the plan', async () => {
    const app = await startApp(tempRoot);
    try {
      const started = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'blocks' }));
      await waitFor(app.baseUrl, started.id, terminal);

      const fresh = (await (await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`, { composition: 'blocks' })).json() as AgencyBuildForkResponse).build;
      await waitFor(app.baseUrl, fresh.id, terminal);
      expect(app.calls[1]!.composition).toBe('blocks');
      expect(app.calls[1]!.blockPlan).toBeUndefined();

      app.state.impl = async () => ({ outcome: 'built', provider: 'deepseek', model: 'm', providers: [], family: 'wrenfield', projectId: 'project-1', report: report({ family: 'wrenfield', recipe: {}, composition: undefined }) });
      const bad = await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`, { composition: 'nope' });
      expect(bad.status).toBe(400);
      const family = (await (await post(app.baseUrl, `/api/agency/builds/${started.id}/fork`, { composition: 'family' })).json() as AgencyBuildForkResponse).build;
      await waitFor(app.baseUrl, family.id, terminal);
      expect(app.calls[2]!.composition).toBeUndefined();
      expect(app.calls[2]!.blockPlan).toBeUndefined();
      expect(app.calls[2]!.loadBlockCatalog).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('blocks and auto take verify strict only: any other mode is a 400, on a build and on a fork', async () => {
    const app = await startApp(tempRoot);
    try {
      for (const composition of ['blocks', 'auto']) {
        for (const verify of ['advisory', 'after', 'off']) {
          const response = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition, verify });
          expect(response.status).toBe(400);
          expect(JSON.stringify(await response.json())).toContain('strict');
        }
      }
      expect(app.calls).toHaveLength(0);
      // Strict, named or omitted, is accepted.
      const strict = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, composition: 'blocks', verify: 'strict' });
      expect(strict.status).toBe(202);
      await waitFor(app.baseUrl, (await buildOf(strict)).id, terminal);
      // A fork keeps the saved verify mode: composing a family build that ran with `off` is refused.
      const off = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, verify: 'off' }));
      await waitFor(app.baseUrl, off.id, terminal);
      const fork = await post(app.baseUrl, `/api/agency/builds/${off.id}/fork`, { composition: 'auto' });
      expect(fork.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('toCompositionDto', () => {
  it('retains planner counts in the API receipt and strips nested prose on hydration', () => {
    const composition = { requested: 'blocks', used: 'blocks', planner: { calls: 2, ms: 1000, prose: 'private provider answer' } };
    expect(toCompositionDto(composition as never).planner).toEqual({ calls: 2, ms: 1000 });
    const snapshot = publicSnapshotIds({ composition } as never);
    expect(snapshot.composition?.planner).toEqual({ calls: 2, ms: 1000 });
    expect(JSON.stringify(snapshot)).not.toContain('private');
    expect(toCompositionDto({ ...composition, planner: { calls: -1, ms: Infinity } } as never).planner).toBeUndefined();
  });

  it('drops invalid persisted support receipts instead of retaining the unsanitized original', () => {
    const snapshot = publicSnapshotIds({ composition: { requested: 'blocks', used: 'blocks', supportGate: {
      threshold: 2, added: [], removed: [], decisions: [], extra: 'private provider prose',
    } } } as never);
    expect(snapshot.composition?.supportGate).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('private provider prose');
  });

  it('retains support receipts with public ids and strips nested extra fields', () => {
    const dto = toCompositionDto({ requested: 'blocks', used: 'blocks', supportGate: {
      threshold: 0.8, extra: 'private brief',
      added: [{ kind: 'team', id: 'cult:marketing-team-minimal', probability: 0.95, reason: 'jev-brief-support', prose: 'private provider answer' }],
      removed: [], decisions: [{ kind: 'team', probability: 0.95, reason: 'supported', extra: 'private' }], skipped: 'arbitrary provider message',
    } } as never);
    expect(dto.supportGate?.added[0]?.id).not.toBe('cult:marketing-team-minimal');
    expect(dto.supportGate).toEqual({ threshold: 0.8,
      added: [{ kind: 'team', id: dto.supportGate?.added[0]?.id, probability: 0.95, reason: 'jev-brief-support' }],
      removed: [], decisions: [{ kind: 'team', probability: 0.95, reason: 'supported' }],
    });
    expect(JSON.stringify(dto)).not.toContain('private');
    expect(JSON.stringify(dto)).not.toContain('provider');
  });

  it('copies named fields only', () => {
    const dto = toCompositionDto({ requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'x', blocks: ['a'], source: 'jev', extra: 'leak' } as never);
    expect(dto).toEqual({ requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'x', blocks: ['a'], source: 'jev' });
  });

  it('drops an unknown fallback code and any effects value but off/no-placements', () => {
    expect(toCompositionDto({ requested: 'auto', used: 'family', fallback: 'surprise' } as never)).toEqual({ requested: 'auto', used: 'family' });
    expect(toCompositionDto({ requested: 'blocks', used: 'blocks', effects: { mode: 'auto', reason: 'x' } } as never)).toEqual({ requested: 'blocks', used: 'blocks' });
    expect(toCompositionDto({ requested: 'blocks', used: 'blocks', effects: { mode: 'off', reason: 'no-placements' } })).toEqual({ requested: 'blocks', used: 'blocks', effects: { mode: 'off', reason: 'no-placements' } });
  });
});
