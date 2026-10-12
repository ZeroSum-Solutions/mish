// Flagship step 4, Improve prompt (B8-1), over fake deps: `POST /api/build-on-brand/project` makes
// the empty project an Improve-prompt brief lives in, and a build that names an accepted brief runs
// in THAT project with the resolved brief on the run body. A brief the daemon refuses (not
// accepted, stale) or a project that is not an empty first-draft project starts nothing.
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DesignSystemSummary } from '@mish/contracts';

import { registerBuildOnBrandRoutes, type BuildOnBrandStartInput } from '../src/routes/build-on-brand.js';
import { sendApiError } from '../src/http/api-errors.js';

const KIT = 'neutral-product';
const BRIEF = 'Bright Smile Family Dentistry, Portland. Book online.';
const HASH = 'b'.repeat(64);
const RESOLVED = { id: 'brief_1', revision: 2, hash: HASH, state: 'accepted', renderedPrompt: 'Accepted brief text' };

describe('build-on-brand with an accepted design brief', () => {
  let server: http.Server;
  let base: string;
  const started: BuildOnBrandStartInput[] = [];
  const made: Array<{ name: string; designSystemId: string }> = [];
  let briefRefusal: { status: number; code: string; message: string } | null = null;
  const projects = new Map<string, { designSystemId: string; intent: string; hasPages: boolean }>();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerBuildOnBrandRoutes(app, {
      http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } },
      authorizeProjectRequest: async () => true,
      listKits: async () => [{ id: KIT, title: 'Neutral Product', status: 'published', source: 'built-in', approval: { status: 'approved', revision: 'a'.repeat(64), approvedRevision: 'a'.repeat(64) } } as DesignSystemSummary],
      disabledKitIds: async () => [],
      readKitAssets: async () => ({ revision: 'a'.repeat(64), designMd: '# Kit', tokensCss: ':root { --accent: #1e5a78; }', hasComponentsManifest: false }),
      resolveAgent: async () => ({ agentId: 'claude', agentName: 'Claude Code' }),
      assertPublicUrl: async () => {},
      referenceFetcher: async () => ({ status: 404, contentType: 'text/html', body: '' }),
      catalog: () => [],
      renderInsert: async () => null,
      createProjectAndRun: async (input) => {
        started.push(input);
        return { projectId: input.projectId ?? 'p-new', conversationId: 'c-1', runId: 'r-1' };
      },
      createEmptyProject: async ({ name, designSystemId }) => {
        made.push({ name, designSystemId });
        projects.set('bob-empty', { designSystemId, intent: 'build-on-brand', hasPages: false });
        return { projectId: 'bob-empty' };
      },
      readBuildProject: async (projectId) => projects.get(projectId) ?? null,
      resolveDesignBrief: async (binding) => {
        if (briefRefusal) throw Object.assign(new Error(briefRefusal.message), briefRefusal);
        expect(binding).toEqual({ projectId: 'bob-empty', id: 'brief_1', revision: 2, hash: HASH });
        return RESOLVED as never;
      },
      readSiteFiles: async () => null,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    started.length = 0;
    made.length = 0;
    briefRefusal = null;
    projects.clear();
  });

  const post = async (pathname: string, body: unknown) => {
    const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as any };
  };
  const binding = { projectId: 'bob-empty', id: 'brief_1', revision: 2, hash: HASH };

  it('makes an empty first-draft project bound to the kit for Improve prompt', async () => {
    const response = await post('/api/build-on-brand/project', { designSystemId: KIT, brief: BRIEF });
    expect(response.status).toBe(201);
    expect(response.json).toEqual({ projectId: 'bob-empty' });
    expect(made).toEqual([{ name: expect.stringMatching(/^First draft · Bright Smile/u), designSystemId: KIT }]);
  });

  it('refuses a draft-kit project the same way a build refuses it', async () => {
    const response = await post('/api/build-on-brand/project', { designSystemId: 'user:nope' });
    expect(response.status).toBe(422);
    expect(made).toEqual([]);
  });

  it('runs in the brief\'s project with the resolved brief on the run', async () => {
    await post('/api/build-on-brand/project', { designSystemId: KIT });
    const response = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT, designBrief: binding });
    expect(response.status).toBe(202);
    expect(response.json.projectId).toBe('bob-empty');
    expect(started).toHaveLength(1);
    expect(started[0]!.projectId).toBe('bob-empty');
    expect(started[0]!.designBrief).toEqual(RESOLVED);
  });

  it('passes a brief refusal through and starts nothing', async () => {
    await post('/api/build-on-brand/project', { designSystemId: KIT });
    briefRefusal = { status: 409, code: 'brief-stale', message: 'The brief changed since it was accepted; review it again' };
    const response = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT, designBrief: binding });
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe('brief-stale');
    expect(started).toEqual([]);
  });

  it('refuses a brief whose project is not an empty first-draft project on the same kit', async () => {
    projects.set('bob-empty', { designSystemId: KIT, intent: 'build-on-brand', hasPages: true });
    const used = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT, designBrief: binding });
    expect(used.status).toBe(409);
    projects.set('bob-empty', { designSystemId: 'other-kit', intent: 'build-on-brand', hasPages: false });
    const otherKit = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT, designBrief: binding });
    expect(otherKit.status).toBe(409);
    projects.delete('bob-empty');
    const missing = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT, designBrief: binding });
    expect(missing.status).toBe(404);
    expect(started).toEqual([]);
  });
});
