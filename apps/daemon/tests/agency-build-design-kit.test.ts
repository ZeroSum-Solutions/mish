// `designSystemId` on `POST /api/agency/build` (Home "Build with Jev" with a kit picked): the kit
// is resolved with build-on-brand's rules before anything starts, its approved tokens reach the
// fast lane as a direction, the composition receipt says whether the page wears it, and a fork
// re-reads the kit. Harness: `agency-build-composition.test.ts`'s bare Express app with a fake
// `runBuild`, plus fake kit readers — no model, Jev or filesystem kit is touched.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgencyBuildResponse, AgencyBuildSnapshot, ApiErrorResponse, DesignSystemSummary } from '@mish/contracts';
import type { BuildInput, BuildResult } from '@mish/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { createScopedKitLister, type AgencyDesignKitDeps } from '../src/routes/agency-build-kit.js';
import { registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'Northbeam Advisory, a cloud, data and AI consultancy in Chicago. Book a readiness review.';
const KIT_ID = 'user:atlas-beyond-tl03';
const REVISION = 'a'.repeat(64);
const TOKENS = ':root { --ink: #171d1d; --bg: #edf0ed; --surface: #f6f7f6; --fg: var(--ink); --accent: #eb461f; --font-display: "Newsreader", Georgia, serif; --font-body: "Instrument Sans", Arial, sans-serif; }';
const PLAN = { spine: 'TL', directionId: 'modern-minimal', blocks: ['hyperui:marketing/sections/1', 'hyperui:marketing/ctas/1'] };

type Report = Extract<BuildResult, { outcome: 'built' }>['report'];

function kitSummary(overrides: Partial<DesignSystemSummary> = {}): DesignSystemSummary {
  return {
    id: KIT_ID, title: 'Atlas · TL.03 cloud-advisory', category: 'Atlas reference', summary: '', swatches: [], surface: 'web',
    source: 'user', status: 'published', isEditable: true,
    approval: { status: 'approved', revision: REVISION, approvedRevision: REVISION },
    ...overrides,
  } as DesignSystemSummary;
}

/** A fake `buildSite` for a composed build that wears the kit it was given. */
async function composedBuild(input: BuildInput): Promise<BuildResult> {
  const designKit = input.designKit ? { id: input.designKit.id, title: input.designKit.title, applied: true } : undefined;
  const composition = { requested: input.composition ?? 'family', used: 'blocks' as const, ...PLAN, source: 'jev' as const, ...(designKit ? { designKit } : {}) };
  input.onEvent?.({ type: 'composition', result: composition, ms: 3 });
  input.onEvent?.({ type: 'project', projectId: 'project-1', created: true });
  const report = {
    family: 'composed', mode: 'sections', model: 'deepseek-v4-flash', entry: 'composed-r1.html', revision: 1, projectId: 'project-1',
    timings: { totalMs: 10, registeredMs: 9 }, calls: 3, repairs: 0, retries: 0, paints: 1, usage: { input: 1, output: 1, cachedRead: 0 },
    applied: 4, missing: [], nulled: [], truncated: [], units: [], recipeDigest: 'd', recipe: { kind: 'composed-page' }, html: '<!doctype html>',
    manifest: { entry: 'composed-r1.html', supportingFiles: [], metadata: { agencySite: { recipeDigest: 'd', revision: '1', family: 'composed' } } },
    approvedAssets: [],
    composition: { ...composition, effects: { mode: 'off', reason: 'no-placements' } },
  } as unknown as Report;
  return { outcome: 'built', provider: 'deepseek', model: 'deepseek-v4-flash', providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }], family: 'composed', projectId: 'project-1', report };
}

interface Harness { baseUrl: string; calls: BuildInput[]; kits: { summaries: DesignSystemSummary[]; disabled: string[]; revision: string; tokens: string | null }; close: () => Promise<void> }

async function startApp(dataDir: string, options: { withKits?: boolean; designKits?: AgencyDesignKitDeps } = {}): Promise<Harness> {
  const calls: BuildInput[] = [];
  const kits: Harness['kits'] = { summaries: [kitSummary()], disabled: [], revision: REVISION, tokens: TOKENS };
  const designKits: AgencyDesignKitDeps = {
    listKits: async () => ({ kits: kits.summaries.map((summary) => ({ summary, root: '/kits' })) }),
    disabledKitIds: async () => kits.disabled,
    readKitAssets: async () => ({ revision: kits.revision, tokensCss: kits.tokens }),
  };
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
      runBuild: (input) => { calls.push(input); return composedBuild(input); },
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
      ...(options.withKits === false ? {} : { designKits: options.designKits ?? designKits }),
    },
  });
  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, kits, close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

let tempRoot = '';
beforeEach(() => { tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-design-kit-')); });
afterEach(() => { if (tempRoot) rmSync(tempRoot, { force: true, recursive: true }); tempRoot = ''; });

describe('POST /api/agency/build designSystemId', () => {
  it('wears an approved kit: composition defaults to auto, the kit direction reaches the fast lane, the receipt names it', async () => {
    const app = await startApp(tempRoot);
    try {
      const response = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID });
      expect(response.status, JSON.stringify(response.status === 202 ? {} : await response.clone().json())).toBe(202);
      const done = await waitFor(app.baseUrl, (await buildOf(response)).id, (build) => build.status === 'done');
      const input = app.calls[0]!;
      expect(input.composition).toBe('auto');
      expect(input.designKit?.id).toBe(KIT_ID);
      expect(input.designKit?.revision).toBe(REVISION);
      expect(input.designKit?.direction.id).toBe(`kit:${KIT_ID}`);
      expect(input.designKit?.direction.displayFont).toBe('"Newsreader", Georgia, serif');
      expect(input.designKit?.direction.palette.accent).toMatch(/^oklch\(/u);
      expect(done.composition?.designKit).toEqual({ id: KIT_ID, title: 'Atlas · TL.03 cloud-advisory', applied: true });
    } finally { await app.close(); }
  });

  it('refuses composition "family" with a kit, and a malformed id, before anything runs', async () => {
    const app = await startApp(tempRoot);
    try {
      const family = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID, composition: 'family' });
      expect(family.status).toBe(400);
      const blank = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: '  ' });
      expect(blank.status).toBe(400);
      expect(app.calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('refuses a kit that is not approved, has changed since approval, is off, or is missing', async () => {
    const app = await startApp(tempRoot);
    try {
      const cases: Array<[() => void, string]> = [
        [() => { app.kits.summaries = [kitSummary({ approval: { status: 'unreviewed', revision: REVISION } })]; }, 'unreviewed'],
        [() => { app.kits.summaries = [kitSummary()]; app.kits.revision = 'b'.repeat(64); }, 'unreviewed'],
        [() => { app.kits.revision = REVISION; app.kits.disabled = [KIT_ID]; }, 'disabled'],
        [() => { app.kits.disabled = []; app.kits.summaries = []; }, 'not-installed'],
      ];
      for (const [arrange, reason] of cases) {
        arrange();
        const response = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID });
        expect(response.status, reason).toBe(422);
        const error = await errorOf(response);
        expect(error.code, reason).toBe('DESIGN_SYSTEM_NOT_SELECTABLE');
        expect(error.details, reason).toMatchObject({ designSystemId: KIT_ID, reason });
      }
      expect(app.calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('refuses a kit whose tokens have no colour roles the fast lane can use', async () => {
    const app = await startApp(tempRoot);
    try {
      app.kits.tokens = ':root { --color-canvas-white: #fbf8f6; --color-ink-black: #000; }';
      const response = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID });
      expect(response.status).toBe(422);
      const error = await errorOf(response);
      expect(error.code).toBe('DESIGN_SYSTEM_TOKENS_UNUSABLE');
      expect(error.details).toMatchObject({ reason: 'missing-token', token: '--bg' });
      app.kits.tokens = null;
      const missing = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID });
      expect((await errorOf(missing)).details).toMatchObject({ reason: 'tokens-missing' });
      expect(app.calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('a daemon without kit readers refuses every kit as not installed', async () => {
    const app = await startApp(tempRoot, { withKits: false });
    try {
      const response = await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID });
      expect(response.status).toBe(422);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'not-installed' });
    } finally { await app.close(); }
  });

  it('a fork re-reads the kit: it wears it again while approved, and is refused once it is not', async () => {
    const app = await startApp(tempRoot);
    try {
      const first = await buildOf(await post(app.baseUrl, '/api/agency/build', { brief: BRIEF, designSystemId: KIT_ID }));
      await waitFor(app.baseUrl, first.id, (build) => build.status === 'done');
      const fork = await post(app.baseUrl, `/api/agency/builds/${first.id}/fork`, {});
      expect(fork.status).toBe(202);
      await waitFor(app.baseUrl, (await buildOf(fork)).id, (build) => build.status === 'done');
      expect(app.calls[1]?.designKit?.id).toBe(KIT_ID);

      app.kits.summaries = [kitSummary({ approval: { status: 'unreviewed', revision: REVISION } })];
      const refused = await post(app.baseUrl, `/api/agency/builds/${first.id}/fork`, {});
      expect(refused.status).toBe(422);
      expect((await errorOf(refused)).code).toBe('DESIGN_SYSTEM_NOT_SELECTABLE');
      expect(app.calls).toHaveLength(2);
    } finally { await app.close(); }
  });
});

describe('POST /api/agency/build designSystemId is resolved in the requester\'s Workspace scope', () => {
  // The real scoped lister (`createScopedKitLister` over `listOwnedDesignSystemKits`): member A
  // owns the Personal kit in workspace ws-a; the catalog hides claimed kits from a headerless
  // caller, exactly as the daemon's catalog does (spec 04 §10).
  const owned = kitSummary();
  const reads: Array<{ root: string; id: string }> = [];
  const scopedKits = (verify: 'confirm' | 'refuse' = 'confirm'): AgencyDesignKitDeps => ({
    listKits: createScopedKitLister({
      verifyWorkspaceRequestAuthority: async (req: any) => verify === 'confirm'
        ? ({ ok: true, context: { workspaceId: req.get('x-od-workspace-id'), workspaceMemberId: req.get('x-od-workspace-member-id') } } as never)
        : ({ ok: false } as never),
      listAllDesignSystems: async ({ workspaceId }) => (workspaceId ? [{ id: owned.id, title: owned.title, source: 'user' }] : []),
      visibleInWorkspaceCatalog: (_system, workspaceId, memberId) => workspaceId === 'ws-a' && memberId === 'member-a',
      userRoot: '/user-kits',
      teamRoot: (workspaceId) => `/team-kits/${workspaceId}`,
      listCatalog: async ({ workspaceId }) => (workspaceId ? [owned] : []),
      builtInRoot: '/built-in',
    }),
    disabledKitIds: async () => [],
    readKitAssets: async (root, id) => { reads.push({ root, id }); return { revision: REVISION, tokensCss: TOKENS }; },
  });
  const as = (workspaceId: string, memberId: string) => ({ 'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': memberId });
  const postAs = (baseUrl: string, headers: Record<string, string>) => fetch(`${baseUrl}/api/agency/build`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ brief: BRIEF, designSystemId: KIT_ID }),
  });

  it('refuses a kit from another workspace or another member, and reads nothing', async () => {
    reads.length = 0;
    const app = await startApp(tempRoot, { designKits: scopedKits() });
    try {
      for (const headers of [as('ws-b', 'member-b'), as('ws-a', 'member-b'), {}]) {
        const response = await postAs(app.baseUrl, headers);
        expect(response.status, JSON.stringify(headers)).toBe(422);
        expect((await errorOf(response)).details, JSON.stringify(headers)).toMatchObject({ reason: 'not-installed' });
      }
      expect(reads).toEqual([]);
      expect(app.calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('lets the owning member wear it, read from the kit\'s own root', async () => {
    reads.length = 0;
    const app = await startApp(tempRoot, { designKits: scopedKits() });
    try {
      const response = await postAs(app.baseUrl, as('ws-a', 'member-a'));
      expect(response.status).toBe(202);
      await waitFor(app.baseUrl, (await buildOf(response)).id, (build) => build.status === 'done');
      expect(reads).toEqual([{ root: '/user-kits', id: KIT_ID }]);
      expect(app.calls[0]?.designKit?.id).toBe(KIT_ID);
    } finally { await app.close(); }
  });

  it('refuses every kit when the claimed membership cannot be verified', async () => {
    const app = await startApp(tempRoot, { designKits: scopedKits('refuse') });
    try {
      const response = await postAs(app.baseUrl, as('ws-a', 'member-a'));
      expect(response.status).toBe(422);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'workspace-unverified' });
      expect(app.calls).toHaveLength(0);
    } finally { await app.close(); }
  });
});
