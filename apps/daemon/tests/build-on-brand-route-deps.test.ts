// Flagship "client brief → working first draft": the route's own decisions, over fake deps
// (the full daemon path is pinned by build-on-brand-route.test.ts). Pins the "no agent runtime
// available" refusal (503 AGENT_UNAVAILABLE with a one-line fix, nothing created) and that the
// Design Index route reaches the plan and the run message.
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { AGENT_UNAVAILABLE_FIX, readCappedText, registerBuildOnBrandRoutes, type BuildOnBrandStartInput } from '../src/routes/build-on-brand.js';
import { sendApiError } from '../src/http/api-errors.js';

const KIT = 'neutral-product';
const BRIEF = 'Bright Smile Family Dentistry, Portland. Book online.';

describe('build-on-brand route decisions', () => {
  let server: http.Server;
  let base: string;
  let agentAvailable = true;
  let assetRevision = 'a'.repeat(64);
  let invalidAssets = false;
  const started: BuildOnBrandStartInput[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerBuildOnBrandRoutes(app, {
      http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } },
      authorizeProjectRequest: async () => true,
      listKits: async () => [
        { id: KIT, title: 'Neutral Product', status: 'published', source: 'built-in', approval: { status: 'approved', revision: 'a'.repeat(64), approvedRevision: 'a'.repeat(64) } } as DesignSystemSummary,
        { id: 'user:draft-kit', title: 'Draft', status: 'draft', source: 'user', approval: { status: 'approved', revision: 'a'.repeat(64), approvedRevision: 'a'.repeat(64) } } as DesignSystemSummary,
      ],
      disabledKitIds: async () => [],
      readKitAssets: async () => {
        if (invalidAssets) throw new Error('Design kit text must be valid UTF-8');
        return { revision: assetRevision, designMd: '# Kit', tokensCss: ':root { --bg: #fff; --accent: #1e5a78; }', hasComponentsManifest: false };
      },
      resolveAgent: async () => (agentAvailable ? { agentId: 'claude', agentName: 'Claude Code' } : null),
      assertPublicUrl: async () => {},
      referenceFetcher: async () => ({ status: 404, contentType: 'text/html', body: '' }),
      catalog: () => [],
      renderInsert: async () => null,
      createProjectAndRun: async (input) => {
        started.push(input);
        return { projectId: 'p-1', conversationId: 'c-1', runId: 'r-1' };
      },
      createEmptyProject: async () => ({ projectId: 'p-empty' }),
      readBuildProject: async () => null,
      resolveDesignBrief: async () => { throw new Error('no briefs in this test'); },
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
    agentAvailable = true;
    assetRevision = 'a'.repeat(64);
    invalidAssets = false;
  });

  const post = async (pathname: string, body: unknown) => {
    const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as any };
  };

  it('answers 503 AGENT_UNAVAILABLE with a one-line fix and starts nothing when no agent runtime is installed', async () => {
    agentAvailable = false;
    const response = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT });
    expect(response.status).toBe(503);
    expect(response.json.error.code).toBe('AGENT_UNAVAILABLE');
    expect(response.json.error.details.fix).toBe(AGENT_UNAVAILABLE_FIX);
    expect(AGENT_UNAVAILABLE_FIX).not.toContain('\n');
    expect(started).toEqual([]);
  });

  it('still plans a dry run with no agent runtime', async () => {
    agentAvailable = false;
    const response = await post('/api/build-on-brand/plan', { brief: BRIEF, designSystemId: KIT, pageCount: 3 });
    expect(response.status).toBe(200);
    expect(response.json.plan.pages).toHaveLength(3);
    expect(started).toEqual([]);
  });

  it('refuses a draft kit with reason draft', async () => {
    const response = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: 'user:draft-kit' });
    expect(response.status).toBe(422);
    expect(response.json.error.details.reason).toBe('draft');
    expect(started).toEqual([]);
  });

  it.each(['/api/build-on-brand', '/api/build-on-brand/plan'])('refuses bytes from an unapproved revision at %s before staging or fetching', async pathname => {
    assetRevision = 'b'.repeat(64);
    const response = await post(pathname, { brief: BRIEF, designSystemId: KIT, referenceUrl: 'https://example.test' });
    expect(response.status).toBe(422);
    expect(response.json.error.details.reason).toBe('unreviewed');
    expect(started).toEqual([]);
  });

  it('refuses unreadable asset text with 422 before creating a project or run', async () => {
    invalidAssets = true;
    const response = await post('/api/build-on-brand', { brief: BRIEF, designSystemId: KIT });
    expect(response.status).toBe(422);
    expect(response.json.error.details.reason).toBe('design-md-missing');
    expect(started).toEqual([]);
  });

  it('carries the Design Index route into the plan and the run message', async () => {
    const response = await post('/api/build-on-brand', {
      brief: BRIEF,
      designSystemId: KIT,
      route: { spine: 'PA', family: 'wrenfield', sections: { trust: 'keep' } },
    });
    expect(response.status).toBe(202);
    expect(response.json.plan.route).toEqual({ spine: 'PA', family: 'wrenfield', sections: { trust: 'keep' } });
    expect(started).toHaveLength(1);
    expect(started[0]!.designSystemId).toBe(KIT);
    expect(started[0]!.agentId).toBe('claude');
    expect(started[0]!.message).toContain('Site family: wrenfield');
    expect(started[0]!.message).toContain('Family section trust: keep');
    expect(Object.keys(started[0]!.files)).toContain('tokens.css');
    expect(started[0]!.name).toMatch(/^First draft · Bright Smile/u);
  });

  it('stops reading a reference body past the byte cap', async () => {
    expect(await readCappedText(new Response('x'.repeat(10)), 16)).toBe('xxxxxxxxxx');
    expect(await readCappedText(new Response('x'.repeat(32)), 16)).toBeNull();
    expect(await readCappedText(new Response('small', { headers: { 'content-length': '99999999' } }), 16)).toBeNull();
  });
});
