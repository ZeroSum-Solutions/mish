import { withVercelSiteProvider, resetVercelSiteProviderFixtures } from './helpers/vercel-site-provider.js';
import type http from 'node:http';
import type { DeployPreflightResponse } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type JsonLike = Record<string, unknown>;

import {
  CLOUDFLARE_PAGES_PROVIDER_ID,
  cloudflarePagesProjectNameForProject,
  deployConfigPath,
  vercelProjectNameForProject,
  waitForReachableDeploymentUrl,
  VERCEL_PROVIDER_ID,
  SAVED_CLOUDFLARE_TOKEN_MASK,
} from '../src/deploy.js';
import { getDeployment, openDatabase } from '../src/db.js';
import { ensureProject } from '../src/projects.js';
import { startServer } from '../src/server.js';

/** The entry page the Vercel route tests deploy. */
const DEPLOYED_PAGE = '<!doctype html><h1>Hello</h1>';

/**
 * An anonymous probe answer for a preview URL. `public` needs an anonymous GET
 * that reaches the deployed page itself, so a GET gets the page the test
 * deployed; a HEAD stays empty.
 */
function probePage(method: string, status = 200, body = DEPLOYED_PAGE): Response {
  if (method === 'GET' && status >= 200 && status < 300) {
    return new Response(body, { status, headers: { 'content-type': 'text/html' } });
  }
  return new Response('', { status });
}

describe('deploy provider routes', () => {
  beforeEach(resetVercelSiteProviderFixtures);
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('rejects preflight for an orphaned project directory before reading files', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required');
    const projectId = `agency-orphan-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<h1>Orphan</h1>');
    await writeFile(path.join(dir, 'brief.md'), 'Private brief');
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/deploy/preflight`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'index.html' }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('brief.md');
  });

  it('enforces agency scope from persisted skill before provider access and sends the preflight file set', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'agency-provider-scope-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `agency-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    const realFetch = globalThis.fetch;
    const providerCalls: { url: string; body: unknown; digest: string | null; bytes: number | null }[] = [];
    const jsonRequest = (route: string, body: unknown, method = 'POST') => realFetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect((await jsonRequest('/api/projects', { id: projectId, name: 'Agency proof', skillId: 'agency-site', designSystemId: null })).status).toBe(200);
      await jsonRequest('/api/deploy/config', { providerId: VERCEL_PROVIDER_ID, token: 'test-provider-token' }, 'PUT');
      const fileUrl = `/api/projects/${projectId}/files`;
      const asset = 'assets/agency-site/r1/hero.png';
      const manifest = { version: 1, kind: 'html', renderer: 'html', exports: ['html'], entry: 'site-r1.html', sourceSkillId: 'agency-site', supportingFiles: [asset], metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', rendererVersion: '1.0.0', recipeDigest: 'b'.repeat(64), revision: 'r1' } } };
      expect((await jsonRequest(fileUrl, { name: 'site-r1.html', content: `<h1>Agency</h1><img src="${asset}">`, artifactManifest: manifest })).status).toBe(200);
      expect((await jsonRequest(fileUrl, { name: asset, content: 'asset-bytes' })).status).toBe(200);
      expect((await jsonRequest(fileUrl, { name: 'brief.md', content: 'Private working brief' })).status).toBe(200);
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        const headers = new Headers(init?.headers);
        const isJson = (headers.get('content-type') || '').includes('application/json');
        providerCalls.push({
          url,
          body: isJson && init?.body ? JSON.parse(String(init.body)) : null,
          digest: headers.get('x-vercel-digest'),
          bytes: init?.body instanceof Uint8Array ? init.body.byteLength : null,
        });
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.startsWith('https://api.vercel.com/')) return new Response(JSON.stringify({ id: 'dpl-agency-test', url: 'agency-test.vercel.app', readyState: 'READY' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === 'https://agency-test.vercel.app') return new Response('<h1>Ready</h1>', { status: 200 });
        throw new Error(`Unexpected provider URL: ${url}`);
      }), {"projectId":"prj_agency","deploymentId":"dpl-agency-test","host":"agency-test.vercel.app"}));
      const preflight = await jsonRequest(`/api/projects/${projectId}/deploy/preflight`, { fileName: 'site-r1.html' });
      expect(preflight.status).toBe(200);
      const planned = await preflight.json() as DeployPreflightResponse;
      const deployed = await jsonRequest(`/api/projects/${projectId}/deploy`, { fileName: 'site-r1.html', target: 'preview' });
      expect(deployed.status, await deployed.clone().text()).toBe(200);
      expect(await deployed.json()).toMatchObject({ providerId: 'vercel-self', target: 'preview', deploymentId: 'dpl-agency-test', deploymentCount: 1 });
      // Every file goes up through the file-upload API by SHA-1 digest first; the deployment
      // request then references those digests instead of inlining base64 (10 MB body cap).
      const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
      const fileUploads = providerCalls.filter((c) => c.url.startsWith('https://api.vercel.com/v2/files'));
      const deploymentIndex = providerCalls.findIndex((c) => c.url.includes('/v13/deployments'));
      expect(fileUploads).toHaveLength(2);
      expect(fileUploads.every((c) => c.body === null && typeof c.bytes === 'number' && c.bytes > 0)).toBe(true);
      expect(fileUploads.map((c) => c.digest)).toContain(sha1('asset-bytes'));
      expect(providerCalls.slice(0, deploymentIndex).filter((c) => c.url.startsWith('https://api.vercel.com/v2/files'))).toHaveLength(2);
      const upload = providerCalls[deploymentIndex]?.body as { files: { file: string; sha: string; size: number; data?: unknown; encoding?: unknown }[]; projectSettings: { framework: unknown } };
      expect(upload.files.map((f) => f.file)).toEqual(planned.files.map((f: { path: string }) => f.path));
      expect(upload.files.map((f) => f.file)).toEqual(['index.html', asset]);
      expect(upload.files.map((f) => f.sha).sort()).toEqual(fileUploads.map((c) => c.digest).sort());
      expect(upload.files.find((f) => f.file === asset)).toEqual({ file: asset, sha: sha1('asset-bytes'), size: Buffer.byteLength('asset-bytes') });
      expect(upload.files.every((f) => f.data === undefined && f.encoding === undefined)).toBe(true);
      expect(fileUploads.find((c) => c.digest === upload.files[0]?.sha)?.bytes).toBe(planned.files[0]?.size);
      expect(upload.projectSettings.framework).toBeNull();
      providerCalls.length = 0;
      for (const state of ['missing', 'corrupt', 'private-reference']) {
        if (state === 'missing') await rm(path.join(dir, 'site-r1.html.artifact.json'));
        if (state === 'corrupt') await writeFile(path.join(dir, 'site-r1.html.artifact.json'), '{broken');
        if (state === 'private-reference') {
          await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify(manifest));
          await writeFile(path.join(dir, 'site-r1.html'), '<img src="brief.md">');
        }
        for (const suffix of ['/preflight', '']) {
          const response = await jsonRequest(`/api/projects/${projectId}/deploy${suffix}`, { fileName: 'site-r1.html', requireAgencySiteScope: false, includeProjectFiles: true });
          expect(response.status, `${state}${suffix}`).toBe(400);
        }
        expect(providerCalls).toEqual([]);
      }
    } finally {
      vi.unstubAllGlobals();
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('dispatches deploy config reads and writes by providerId', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-config-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);
      expect(await saveResp.json()).toMatchObject({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        configured: true,
        tokenMask: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_123',
        projectName: '',
      });

      const getResp = await fetch(
        `${baseUrl}/api/deploy/config?providerId=${CLOUDFLARE_PAGES_PROVIDER_ID}`,
      );
      expect(getResp.status).toBe(200);
      expect(await getResp.json()).toMatchObject({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        configured: true,
        tokenMask: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_123',
        projectName: '',
      });
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8'))).toEqual({
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: '',
      });

      const maskedResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: SAVED_CLOUDFLARE_TOKEN_MASK,
          accountId: 'account_456',
        }),
      });
      expect(maskedResp.status).toBe(200);
      expect(await maskedResp.json()).toMatchObject({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        configured: true,
        tokenMask: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_456',
        projectName: '',
      });
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8'))).toEqual({
        token: 'cloudflare-token-secret',
        accountId: 'account_456',
        projectName: '',
      });
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('lists Cloudflare Pages zones for saved account credentials', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-zones-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
          cloudflarePages: {
            lastZoneId: 'zone-1',
            lastZoneName: 'example.com',
            lastDomainPrefix: 'demo',
          },
        }),
      });
      expect(saveResp.status).toBe(200);

      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        expect(url).toContain('/zones?');
        expect(url).toContain('account.id=account_123');
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: 'zone-1', name: 'example.com', status: 'active', type: 'full' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const zonesResp = await fetch(`${baseUrl}/api/deploy/cloudflare-pages/zones`);
        expect(zonesResp.status).toBe(200);
        expect(await zonesResp.json()).toEqual({
          zones: [{ id: 'zone-1', name: 'example.com', status: 'active', type: 'full' }],
          cloudflarePages: {
            lastZoneId: 'zone-1',
            lastZoneName: 'example.com',
            lastDomainPrefix: 'demo',
          },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('dispatches deploy preflight by providerId', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const projectId = `deploy-route-${Date.now()}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Preflight provider proof' }),
    });
    expect(created.status).toBe(200);
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width"><h1>Hello</h1>',
    );

    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'index.html',
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      entry: 'index.html',
      totalFiles: 1,
    });
  });

  it('derives Cloudflare Pages project names from the Mishh Mashh project', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-auto-project-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = 'cf-route-123456';
    const expectedPagesProject = 'od-ai-cf-route-123';
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'AI 生图网站',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const createFileResp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'index.html',
          content: '<!doctype html><h1>Hello</h1>',
          artifactManifest: {
            version: 1,
            kind: 'html',
            title: 'Index',
            entry: 'index.html',
            renderer: 'html',
            exports: ['html'],
          },
        }),
      });
      expect(createFileResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.endsWith(`/pages/projects/${expectedPagesProject}`) && method === 'GET') {
          return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/projects') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body).toMatchObject({
            name: expectedPagesProject,
            production_branch: 'main',
          });
          return new Response(JSON.stringify({ success: true, result: { name: body.name } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/upload-token`) && method === 'GET') {
          return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { hashes?: string[] };
          expect(Array.isArray(body.hashes)).toBe(true);
          expect(body.hashes?.length).toBeGreaterThan(0);
          return new Response(JSON.stringify({ success: true, result: body.hashes }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/assets/upload') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '[]')) as Array<{
            key?: string;
            value?: string;
            metadata?: { contentType?: string };
            base64?: boolean;
          }>;
          expect(body).toHaveLength(1);
          expect(body[0]?.base64).toBe(true);
          expect(body[0]?.metadata?.contentType).toMatch(/^text\/html/);
          expect(body[0]?.key).toMatch(/^[a-f0-9]{32}$/);
          expect(body[0]?.value).toEqual(expect.any(String));
          return new Response(JSON.stringify({ success: true, result: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { hashes?: string[] };
          expect(Array.isArray(body.hashes)).toBe(true);
          expect(body.hashes?.length).toBeGreaterThan(0);
          return new Response(JSON.stringify({ success: true, result: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/deployments`) && method === 'POST') {
          const form = init?.body as FormData;
          const manifest = JSON.parse(String(form.get('manifest') ?? '{}')) as Record<string, string>;
          expect(Object.keys(manifest)).toContain('/index.html');
          expect(form.get('branch')).toBe('main');
          expect(form.get('pages_build_output_dir')).toBeNull();
          return new Response(JSON.stringify({
            success: true,
            result: { id: 'cf_dep_123', url: `https://d34527d9.${expectedPagesProject}.pages.dev` },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === `https://${expectedPagesProject}.pages.dev` && method === 'HEAD') {
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          }),
        });
        const deployBody = await deployResp.text();
        expect(deployResp.status, deployBody).toBe(200);
        const deployment = JSON.parse(deployBody) as { id: string };
        expect(deployment).toMatchObject({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          deploymentId: 'cf_dep_123',
          url: `https://${expectedPagesProject}.pages.dev`,
          status: 'ready',
          cloudflarePages: {
            projectName: expectedPagesProject,
            pagesDev: {
              url: `https://${expectedPagesProject}.pages.dev`,
              status: 'ready',
            },
          },
        });
        expect(deployment).not.toHaveProperty('providerMetadata');

        const renameResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed project after deploy' }),
        });
        expect(renameResp.status).toBe(200);

        const checkResp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deployment.id}/check-link`, {
          method: 'POST',
        });
        expect(checkResp.status).toBe(200);
        expect(await checkResp.json()).toMatchObject({
          url: `https://${expectedPagesProject}.pages.dev`,
          status: 'ready',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid Cloudflare custom-domain selection before Pages deploy', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-invalid-domain-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `cf-invalid-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Invalid domain test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        throw new Error(`No external fetch expected before invalid-prefix rejection: ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            cloudflarePages: {
              zoneId: 'zone-1',
              zoneName: 'example.com',
              domainPrefix: 'bad.prefix',
            },
          }),
        });
        expect(deployResp.status).toBe(400);
        expect(await deployResp.text()).toMatch(/valid subdomain prefix/i);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('refreshes Cloudflare Pages custom-domain API status during check-link', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-domain-check-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `cf-domain-check-${Date.now()}`;
    const expectedPagesProject = cloudflarePagesProjectNameForProject(projectId, 'Domain check test');
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Domain check test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const realFetch = globalThis.fetch;
      let domainListCount = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.endsWith(`/pages/projects/${expectedPagesProject}`) && method === 'GET') {
          return new Response(JSON.stringify({ success: true, result: { name: expectedPagesProject } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/upload-token`) && method === 'GET') {
          return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
          return new Response(JSON.stringify({ success: true, result: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
          return new Response(JSON.stringify({ success: true, result: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/deployments`) && method === 'POST') {
          return new Response(JSON.stringify({
            success: true,
            result: { id: 'cf_dep_domain_check', url: `https://d34527d9.${expectedPagesProject}.pages.dev` },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === `https://${expectedPagesProject}.pages.dev` && method === 'HEAD') {
          return new Response('', { status: 200 });
        }
        if (url.endsWith('/zones/zone-1') && method === 'GET') {
          return new Response(JSON.stringify({
            success: true,
            result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/zones/zone-1/dns_records?') && method === 'GET') {
          return new Response(JSON.stringify({ success: true, result: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/zones/zone-1/dns_records') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          return new Response(JSON.stringify({ success: true, result: { id: 'dns-1', ...body } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/domains/demo.example.com`) && method === 'GET') {
          domainListCount += 1;
          if (domainListCount === 1) {
            return new Response(JSON.stringify({
              success: false,
              errors: [{ message: 'Custom domain not found' }],
            }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          }
          const result = {
            name: 'demo.example.com',
            status: domainListCount === 2 ? 'pending' : 'active',
            validation_data: { txt_name: '_cf-custom-hostname.demo.example.com' },
            verification_data: { cname: `${expectedPagesProject}.pages.dev` },
          };
          return new Response(JSON.stringify({ success: true, result }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith(`/pages/projects/${expectedPagesProject}/domains`) && method === 'POST') {
          expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ name: 'demo.example.com' });
          return new Response(JSON.stringify({
            success: true,
            result: { name: 'demo.example.com', status: 'pending' },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'https://demo.example.com' && method === 'HEAD') {
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            cloudflarePages: {
              zoneId: 'zone-1',
              zoneName: 'example.com',
              domainPrefix: 'demo',
            },
          }),
        });
        const deployBody = await deployResp.text();
        expect(deployResp.status, deployBody).toBe(200);
        const deployment = JSON.parse(deployBody) as { id: string };
        expect(deployment).toMatchObject({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          url: `https://${expectedPagesProject}.pages.dev`,
          status: 'link-delayed',
          cloudflarePages: {
            pagesDev: { url: `https://${expectedPagesProject}.pages.dev`, status: 'ready' },
            customDomain: {
              hostname: 'demo.example.com',
              status: 'pending',
              domainStatus: 'pending',
            },
          },
        });
        expect(deployment).not.toHaveProperty('providerMetadata');

        const pendingResp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deployment.id}/check-link`, {
          method: 'POST',
        });
        expect(pendingResp.status).toBe(200);
        const pending = await pendingResp.json();
        expect(pending).toMatchObject({
          url: `https://${expectedPagesProject}.pages.dev`,
          status: 'link-delayed',
          cloudflarePages: {
            customDomain: {
              hostname: 'demo.example.com',
              status: 'pending',
              domainStatus: 'pending',
              pagesDomainStatus: 'pending',
            },
          },
        });
        expect(pending).not.toHaveProperty('providerMetadata');

        const readyResp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deployment.id}/check-link`, {
          method: 'POST',
        });
        expect(readyResp.status).toBe(200);
        const ready = await readyResp.json();
        expect(ready).toMatchObject({
          url: `https://${expectedPagesProject}.pages.dev`,
          status: 'ready',
          cloudflarePages: {
            customDomain: {
              hostname: 'demo.example.com',
              status: 'ready',
              domainStatus: 'active',
              pagesDomainStatus: 'active',
              validationData: { txt_name: '_cf-custom-hostname.demo.example.com' },
              verificationData: { cname: `${expectedPagesProject}.pages.dev` },
            },
          },
        });
        expect(ready).not.toHaveProperty('providerMetadata');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps Vercel deploy payload free of Cloudflare custom-domain fields', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-payload-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `vercel-payload-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    await writeFile(path.join(dir, 'index-v1.html'), '<!doctype html><h1>V1</h1>');
    await mkdir(path.join(dir, 'screens'), { recursive: true });
    await writeFile(path.join(dir, 'screens', 'k1-waiting.html'), '<!doctype html><h1>K1</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Vercel payload test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: VERCEL_PROVIDER_ID,
          token: 'vercel-token-secret',
        }),
      });
      expect(saveResp.status).toBe(200);

      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        // File-upload API: every deploy now stores each file by digest before creating the deployment.
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments') && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          expect(body).not.toHaveProperty('cloudflarePages');
          expect(JSON.stringify(body)).not.toContain('example.com');
          expect(body.files.map((item: { file: string }) => item.file).sort()).toEqual([
            'index.html',
          ]);
          return new Response(JSON.stringify({
            id: 'vercel-dep-1',
            readyState: 'READY',
            url: 'vercel-payload.vercel.app',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/v13/deployments/vercel-dep-1') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-1',
            readyState: 'READY',
            url: 'vercel-payload.vercel.app',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'https://vercel-payload.vercel.app' && method === 'HEAD') {
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_payload","deploymentId":"vercel-dep-1","host":"vercel-payload.vercel.app"}));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: VERCEL_PROVIDER_ID,
            cloudflarePages: {
              zoneId: 'zone-1',
              zoneName: 'example.com',
              domainPrefix: 'demo',
            },
          }),
        });
        expect(deployResp.status).toBe(200);
        expect(await deployResp.json()).toMatchObject({
          providerId: VERCEL_PROVIDER_ID,
          url: 'https://vercel-payload.vercel.app',
          status: 'ready',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // --- target threading tests (issue #4483) ---

  function makeCfPagesMockForRouteTarget(options: {
    previewDeployUrl: string;
    captureFormData: { branch: string | undefined };
    expectedPagesProject: string;
  }) {
    const { previewDeployUrl, captureFormData, expectedPagesProject } = options;
    const realFetch = globalThis.fetch;
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      if (url.endsWith(`/pages/projects/${expectedPagesProject}`) && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: expectedPagesProject } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(`/pages/projects/${expectedPagesProject}/upload-token`) && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(`/pages/projects/${expectedPagesProject}/deployments`) && method === 'POST') {
        const form = init?.body as FormData;
        captureFormData.branch = form?.get('branch') as string | undefined ?? undefined;
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'cf_dep_target_test', url: previewDeployUrl },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
  }

  it('threads target=preview from POST body into the deployment record', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-target-preview-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `cf-target-preview-${Date.now()}`;
    const expectedPagesProject = cloudflarePagesProjectNameForProject(projectId, 'Target preview test');
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Target preview test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const captureFormData: { branch: string | undefined } = { branch: undefined };
      const fetchMock = makeCfPagesMockForRouteTarget({
        previewDeployUrl: `https://abc123.${expectedPagesProject}.pages.dev`,
        captureFormData,
        expectedPagesProject,
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            target: 'preview',
          }),
        });
        const deployBody = await deployResp.text();
        expect(deployResp.status, deployBody).toBe(200);
        const deployment = JSON.parse(deployBody) as { target: string };
        // Route must persist the actual requested target, not always 'preview'
        expect(deployment.target).toBe('preview');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('threads target=production from POST body into the deployment record', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-target-prod-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `cf-target-prod-${Date.now()}`;
    const expectedPagesProject = cloudflarePagesProjectNameForProject(projectId, 'Target prod test');
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Target prod test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const captureFormData: { branch: string | undefined } = { branch: undefined };
      const fetchMock = makeCfPagesMockForRouteTarget({
        previewDeployUrl: `https://abc123.${expectedPagesProject}.pages.dev`,
        captureFormData,
        expectedPagesProject,
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            target: 'production',
          }),
        });
        const deployBody = await deployResp.text();
        expect(deployResp.status, deployBody).toBe(200);
        const deployment = JSON.parse(deployBody) as { target: string };
        // An explicit target='production' in the body must be reflected in
        // the persisted record; the current code hardcodes 'preview' and will fail.
        expect(deployment.target).toBe('production');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // --- target validation tests (P1 finding on PR #4576) ---

  /**
   * Helper: minimal project + CF config setup, no fetch mock needed.
   * Returns the projectId so callers can POST to /deploy.
   */
  async function setupProjectAndCfConfig(
    stateRoot: string,
    projectIdPrefix: string,
    projectName: string,
  ): Promise<string> {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const projectId = `${projectIdPrefix}-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: projectName, skillId: null, designSystemId: null }),
    });
    expect(createProjectResp.status).toBe(200);
    const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
      }),
    });
    expect(saveResp.status).toBe(200);
    return projectId;
  }

  it('rejects a misspelled target value with HTTP 400 and does not invoke Cloudflare deploy', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-invalid-target-typo-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndCfConfig(stateRoot, 'cf-invalid-typo', 'Invalid target typo test');

      // Stub fetch so any accidental external call fails loudly — the route
      // must return 400 BEFORE attempting a Cloudflare API call.
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        throw new Error(`No Cloudflare deploy call expected for an invalid target: ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            target: 'preveiw', // deliberate typo — not 'preview' or 'production'
          }),
        });
        // Must reject with 400, not silently coerce to 'production'
        expect(deployResp.status).toBe(400);
        // Cloudflare deploy endpoint must never have been called
        const cfDeployCalls = fetchMock.mock.calls.filter((args) => {
          const u = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
          return !u.startsWith(baseUrl);
        });
        expect(cfDeployCalls).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects an empty-string target value with HTTP 400 and does not invoke Cloudflare deploy', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-invalid-target-empty-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndCfConfig(stateRoot, 'cf-invalid-empty', 'Invalid target empty test');

      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        throw new Error(`No Cloudflare deploy call expected for an empty-string target: ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            target: '', // supplied but empty — not a valid value, not the same as omitted
          }),
        });
        // An explicitly supplied empty string is an invalid target; must be 400
        expect(deployResp.status).toBe(400);
        const cfDeployCalls = fetchMock.mock.calls.filter((args) => {
          const u = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
          return !u.startsWith(baseUrl);
        });
        expect(cfDeployCalls).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // Regression guards — these must PASS both before and after the fix to pin
  // the correct contract for the two valid explicit values and the omitted case.

  it('defaults to target=production and records production in the deployment when no target is sent', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-target-default-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    const projectId = `cf-target-default-${Date.now()}`;
    const expectedPagesProject = cloudflarePagesProjectNameForProject(projectId, 'Target default test');
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    try {
      const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Target default test',
          skillId: null,
          designSystemId: null,
        }),
      });
      expect(createProjectResp.status).toBe(200);

      const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
          token: 'cloudflare-token-secret',
          accountId: 'account_123',
        }),
      });
      expect(saveResp.status).toBe(200);

      const captureFormData: { branch: string | undefined } = { branch: undefined };
      const fetchMock = makeCfPagesMockForRouteTarget({
        previewDeployUrl: `https://abc123.${expectedPagesProject}.pages.dev`,
        captureFormData,
        expectedPagesProject,
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
            // no target field — should default to production
          }),
        });
        const deployBody = await deployResp.text();
        expect(deployResp.status, deployBody).toBe(200);
        const deployment = JSON.parse(deployBody) as { target: string };
        // When target is not supplied the deployment record must say 'production',
        // not 'preview' (which is the current hardcoded behaviour)
        expect(deployment.target).toBe('production');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // --- Vercel production-target rejection tests (P2 review finding on PR #4576) ---
  //
  // Vercel production-target deploys are out of scope for this PR (which only
  // adds target support for Cloudflare Pages). The route must reject
  // providerId === VERCEL_PROVIDER_ID + resolved target === 'production' with
  // HTTP 400 / BAD_REQUEST *before* attempting any deploy call, instead of
  // silently deploying as preview.

  /**
   * Helper: minimal project + Vercel config setup, no fetch mock needed.
   * Returns the projectId so callers can POST to /deploy.
   */
  async function setupProjectAndVercelConfig(
    projectIdPrefix: string,
    projectName: string,
  ): Promise<string> {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const projectId = `${projectIdPrefix}-${Date.now()}`;
    const dir = await ensureProject(path.join(dataDir, 'projects'), projectId);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');
    const createProjectResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: projectName, skillId: null, designSystemId: null }),
    });
    expect(createProjectResp.status).toBe(200);
    const saveResp = await fetch(`${baseUrl}/api/deploy/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: VERCEL_PROVIDER_ID,
        token: 'vercel-token-secret',
      }),
    });
    expect(saveResp.status).toBe(200);
    return projectId;
  }

  function makeVercelDeployMock() {
    const realFetch = globalThis.fetch;
    return withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      // File-upload API: every deploy now stores each file by digest before creating the deployment.
      if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/v13/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          id: 'vercel-dep-still-works',
          readyState: 'READY',
          url: 'vercel-still-works.vercel.app',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v13/deployments/vercel-dep-still-works') && method === 'GET') {
        return new Response(JSON.stringify({
          id: 'vercel-dep-still-works',
          readyState: 'READY',
          url: 'vercel-still-works.vercel.app',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://vercel-still-works.vercel.app' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }), {projectId: 'prj_fixture', deploymentId: 'vercel-dep-still-works', host: 'vercel-still-works.vercel.app'});
  }

  // Every deploy failure used to flatten to the envelope's BAD_REQUEST, so a
  // missing token, a non-HTML file, an unresolved asset reference and an
  // oversized asset were indistinguishable once the client mirrored the code
  // into `artifact_deploy_result.error_code` — in production that collapsed
  // into one opaque HTTP_400 bucket we could not act on. Distinct causes must
  // carry distinct codes.
  it('surfaces a specific error code for a non-HTML deploy instead of a generic BAD_REQUEST', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-error-code-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('deploy-error-code', 'Deploy error code test');
      await writeFile(path.join(dataDir, 'projects', projectId, 'notes.txt'), 'not html');

      const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'notes.txt', providerId: VERCEL_PROVIDER_ID }),
      });
      const text = await resp.text();
      expect(resp.status, text).toBe(400);
      const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('NOT_HTML');
      expect(body.error?.message).toMatch(/HTML/i);
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // The other half of the same telemetry contract: a failure the provider
  // rejected is classified by ITS HTTP status client-side (HTTP_403 /
  // HTTP_429 / HTTP_502), and the client only falls back to that status when
  // the envelope code is generic. So the provider catch-alls must NOT stamp a
  // structured code — doing so would fold auth, quota and upstream faults into
  // one bucket, which is coarser than what production already had.
  it('leaves a provider-rejected deploy on the generic envelope code so the client keeps status bucketing', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-provider-status-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('provider-status', 'Provider status test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        // File-upload API: every deploy now stores each file by digest before creating the deployment.
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments')) {
          return new Response(JSON.stringify({ error: { code: 'too_many_requests', message: 'Too many requests.' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_failed","deploymentId":"dep-failed","host":"failed.vercel.app"}));
      try {
        const resp = await realFetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const text = await resp.text();
        expect(resp.status, text).toBe(429);
        const body = JSON.parse(text) as { error?: { code?: string } };
        expect(body.error?.code).toBe('BAD_REQUEST');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // A provider failure whose CAUSE is known — not merely its status — still
  // earns a specific code.
  it('reports PROVIDER_FORBIDDEN when the provider names a permission failure', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-provider-forbidden-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('provider-forbidden', 'Provider forbidden test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        // File-upload API: every deploy now stores each file by digest before creating the deployment.
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments')) {
          return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Not authorized.' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_failed","deploymentId":"dep-failed","host":"failed.vercel.app"}));
      try {
        const resp = await realFetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const text = await resp.text();
        expect(resp.status, text).toBe(403);
        const body = JSON.parse(text) as { error?: { code?: string } };
        expect(body.error?.code).toBe('PROVIDER_FORBIDDEN');
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // The config-save route is the only place CF_TOKEN_REQUIRED can surface, so
  // it needs the same passthrough as the deploy route — otherwise the code is
  // dead on arrival.
  it('surfaces CF_TOKEN_REQUIRED when saving a Cloudflare Pages config without a token', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-cf-token-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const resp = await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: CLOUDFLARE_PAGES_PROVIDER_ID, accountId: 'acct-1' }),
      });
      const text = await resp.text();
      expect(resp.status, text).toBe(400);
      const body = JSON.parse(text) as { error?: { code?: string } };
      expect(body.error?.code).toBe('CF_TOKEN_REQUIRED');
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects vercel-self target=production with 400 BAD_REQUEST before attempting a deploy', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-prod-reject-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-prod-reject', 'Vercel production reject test');

      // Use a fetch mock that WOULD happily complete a Vercel deploy if the
      // route called it — this is the same mock the "still works" companion
      // tests use for a legitimate preview deploy. If the route's guard is
      // missing (today's bug), the deploy proceeds and this mock lets it
      // succeed with 200, which is exactly the silent-preview-deploy bug
      // this test must catch. A correct fix never reaches this mock at all.
      const fetchMock = vi.fn(makeVercelDeployMock());
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: VERCEL_PROVIDER_ID,
            target: 'production',
          }),
        });
        const bodyText = await deployResp.text();
        // Must reject with 400, not silently deploy as preview (the bug: this
        // currently returns 200 with a deployment that is actually 'preview').
        expect(deployResp.status, bodyText).toBe(400);
        const body = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
        expect(body.error?.code).toBe('BAD_REQUEST');
        expect(body.error?.message).toMatch(/production|target/i);

        // The Vercel deploy endpoint must never have been called — the route
        // must reject before attempting any deploy call.
        const vercelDeployCalls = fetchMock.mock.calls.filter((args) => {
          const u = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
          return !u.startsWith(baseUrl);
        });
        expect(vercelDeployCalls).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('still deploys vercel-self successfully when target=preview is explicit (no regression)', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-preview-ok-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-preview-ok', 'Vercel preview still works test');

      const fetchMock = vi.fn(makeVercelDeployMock());
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: VERCEL_PROVIDER_ID,
            target: 'preview',
          }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        const deployment = JSON.parse(bodyText) as { providerId: string; url: string; status: string };
        expect(deployment).toMatchObject({
          providerId: VERCEL_PROVIDER_ID,
          url: 'https://vercel-still-works.vercel.app',
          status: 'ready',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('still deploys vercel-self successfully when target is omitted (no regression)', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-omitted-ok-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-omitted-ok', 'Vercel omitted target still works test');

      const fetchMock = vi.fn(makeVercelDeployMock());
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'index.html',
            providerId: VERCEL_PROVIDER_ID,
            // no target field — must keep working exactly as before the fix.
          }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        const deployment = JSON.parse(bodyText) as { providerId: string; url: string; status: string };
        expect(deployment).toMatchObject({
          providerId: VERCEL_PROVIDER_ID,
          url: 'https://vercel-still-works.vercel.app',
          status: 'ready',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // --- Vercel Deployment Protection honesty (last night's hosted previews
  // all needed "Vercel Authentication" turned off by hand; the daemon never
  // said the link was walled) ---

  it('reports a preview walled by Vercel Authentication as protected and stores the protection facts', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-sso-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-sso', 'Vercel SSO protected test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments') && method === 'POST') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-sso',
            projectId: 'prj_sso_protected',
            readyState: 'READY',
            url: 'sso-protected.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/v13/deployments/vercel-dep-sso') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-sso',
            projectId: 'prj_sso_protected',
            readyState: 'READY',
            url: 'sso-protected.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('https://api.vercel.com/v9/projects/prj_sso_protected') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'prj_sso_protected',
            ssoProtection: { deploymentType: 'all_except_custom_domains' },
            passwordProtection: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_sso_protected","deploymentId":"vercel-dep-sso","host":"sso-protected.vercel.app"}));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        const deployment = JSON.parse(bodyText) as { status: string; statusMessage?: string };
        expect(deployment.status).toBe('protected');
        expect(deployment.statusMessage).toMatch(/Vercel Authentication/);

        const dataDir = process.env.OD_DATA_DIR;
        if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
        const db = openDatabase(path.join(dataDir, 'projects'), { dataDir });
        const stored = getDeployment(db, projectId, 'index.html', VERCEL_PROVIDER_ID);
        expect(stored?.providerMetadata).toMatchObject({
          protection: { sso: 'all_except_custom_domains', password: false },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reports ready when the project has Vercel Authentication and password protection both off', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-unprotected-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-open', 'Vercel unprotected test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments') && method === 'POST') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-open',
            projectId: 'prj_open',
            readyState: 'READY',
            url: 'open-preview.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/v13/deployments/vercel-dep-open') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-open',
            projectId: 'prj_open',
            readyState: 'READY',
            url: 'open-preview.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('https://api.vercel.com/v9/projects/prj_open') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'prj_open',
            ssoProtection: null,
            passwordProtection: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url === 'https://open-preview.vercel.app' && (method === 'HEAD' || method === 'GET')) {
          return probePage(method);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_open","deploymentId":"vercel-dep-open","host":"open-preview.vercel.app"}));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        // url/status/statusMessage/reachableAt must match the pre-PR shape
        // exactly — the protection read must not change the reachable path.
        expect(JSON.parse(bodyText)).toMatchObject({
          url: 'https://open-preview.vercel.app',
          status: 'ready',
          access: 'public',
          statusMessage: 'Public link is ready.',
          reachableAt: expect.any(Number),
        });

        const dataDir = process.env.OD_DATA_DIR;
        if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
        const db = openDatabase(path.join(dataDir, 'projects'), { dataDir });
        const stored = getDeployment(db, projectId, 'index.html', VERCEL_PROVIDER_ID);
        expect(stored?.providerMetadata).toMatchObject({
          protection: { sso: null, password: false },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the URL probe and still reports protected when the project-settings read is forbidden', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-forbidden-redirect-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-403-redirect', 'Vercel 403 redirect test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments') && method === 'POST') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-403-redirect',
            projectId: 'prj_403_redirect',
            readyState: 'READY',
            url: 'sso-redirect.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/v13/deployments/vercel-dep-403-redirect') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-403-redirect',
            projectId: 'prj_403_redirect',
            readyState: 'READY',
            url: 'sso-redirect.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('https://api.vercel.com/v9/projects/prj_403_redirect') && method === 'GET') {
          return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Not authorized.' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'https://sso-redirect.vercel.app' && (method === 'HEAD' || method === 'GET')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fsso-redirect.vercel.app' },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_403_redirect","deploymentId":"vercel-dep-403-redirect","host":"sso-redirect.vercel.app"}));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        expect(JSON.parse(bodyText)).toMatchObject({ status: 'protected' });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reports ready with a could-not-check note when the project-settings read is forbidden but the link is reachable', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-route-vercel-forbidden-reachable-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const projectId = await setupProjectAndVercelConfig('vercel-403-reachable', 'Vercel 403 reachable test');
      const realFetch = globalThis.fetch;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://api.vercel.com/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.includes('/v13/deployments') && method === 'POST') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-403-reachable',
            projectId: 'prj_403_reachable',
            readyState: 'READY',
            url: 'unchecked-but-open.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/v13/deployments/vercel-dep-403-reachable') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 'vercel-dep-403-reachable',
            projectId: 'prj_403_reachable',
            readyState: 'READY',
            url: 'unchecked-but-open.vercel.app',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('https://api.vercel.com/v9/projects/prj_403_reachable') && method === 'GET') {
          return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Not authorized.' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'https://unchecked-but-open.vercel.app' && method === 'HEAD') {
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', withVercelSiteProvider(fetchMock, {"projectId":"prj_403_reachable","deploymentId":"vercel-dep-403-reachable","host":"unchecked-but-open.vercel.app"}));
      try {
        const deployResp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID }),
        });
        const bodyText = await deployResp.text();
        expect(deployResp.status, bodyText).toBe(200);
        const deployment = JSON.parse(bodyText) as { status: string; statusMessage?: string; access?: string };
        // Reachable, but the protection read failed: the link answered and
        // is NOT confirmed public. The old contradictory "Public link is
        // ready. …could not be checked" sentence must be gone.
        expect(deployment.status).toBe('ready');
        expect(deployment.access).toBe('unknown');
        expect(deployment.statusMessage).toMatch(/could not be checked/i);
        expect(deployment.statusMessage).toMatch(/not confirmed public/i);
        expect(deployment.statusMessage).not.toMatch(/Public link is ready/i);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // --- "Make preview public" (publicAccess) -------------------------------
  //
  // The account-level deployment-protection default walls every preview, so a
  // deploy of an agency site produced a link the client could not open. With
  // `publicAccess: true` the daemon turns Vercel Authentication and password
  // protection OFF on the ONE od-* project it just created, verifies the
  // change, and only then probes the preview anonymously.
  //
  // A live deploy showed the edge keeps answering with the SSO wall for a few
  // seconds AFTER the protection is verifiably off, so the daemon reported a
  // change that had worked as a failure. The probe therefore tolerates the
  // wall for a bounded window before it gives up.
  //
  // Every outcome is reported as a stable `publicAccessOutcome` code, because
  // the English `statusMessage` cannot be localized by the web UI.

  type ProviderCall = { method: string; url: string; body: unknown; auth: string | null };

  /**
   * Helper: the Vercel API surface a publicAccess deploy touches. Records
   * every non-daemon call in order so a test can assert both what was sent
   * and the sequence it was sent in.
   */
  function makeVercelPublicAccessMock(options: {
    vercelProjectId: string;
    projectName: string;
    deploymentId: string;
    host: string;
    calls: ProviderCall[];
    /** Project settings the re-read after the PATCH reports. */
    afterPatch?: { ssoProtection: unknown; passwordProtection: unknown };
    /** Non-2xx status for the PATCH; `patchTransportError` throws instead. */
    patchStatus?: number;
    patchTransportError?: boolean;
    /** Shape of a 2xx PATCH response: normal JSON, 204 no body, or plain text. */
    patchResponse?: 'json' | 'empty' | 'text';
    /** Extra fields the project GET reports alongside its name. */
    projectExtras?: JsonLike;
    /** Fail the FIRST project GET (identity read). */
    initialReadStatus?: number;
    /** Fail the project GET that follows the PATCH (verification read). */
    verifyReadStatus?: number;
    /** Number of leading probe answers that are the SSO wall. */
    wallProbeCount?: number;
    errorBody?: JsonLike;
  }) {
    const {
      vercelProjectId, projectName, deploymentId, host, calls,
      afterPatch = { ssoProtection: null, passwordProtection: null },
      patchStatus = 200,
      patchTransportError = false,
      patchResponse = 'json',
      projectExtras = {},
      initialReadStatus = 200,
      verifyReadStatus = 200,
      wallProbeCount = 0,
      errorBody = { error: { code: 'forbidden', message: 'Not authorized.' } },
    } = options;
    const realFetch = globalThis.fetch;
    let patched = false;
    let probes = 0;
    return withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      calls.push({
        method,
        url,
        body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null,
        auth: new Headers(init?.headers).get('authorization'),
      });
      if (url.startsWith('https://api.vercel.com/v2/files')) {
        return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const deployment = { id: deploymentId, projectId: vercelProjectId, readyState: 'READY', url: host };
      if (url.includes('/v13/deployments') && method === 'POST') {
        return new Response(JSON.stringify(deployment), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(`/v13/deployments/${deploymentId}`) && method === 'GET') {
        return new Response(JSON.stringify(deployment), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'PATCH') {
        if (patchTransportError) throw new TypeError('fetch failed');
        patched = true;
        if (patchStatus !== 200) {
          return new Response(JSON.stringify(errorBody), { status: patchStatus, headers: { 'content-type': 'application/json' } });
        }
        if (patchResponse === 'empty') return new Response(null, { status: 204 });
        if (patchResponse === 'text') return new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } });
        return new Response(JSON.stringify({ id: vercelProjectId, name: projectName, ...afterPatch }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
        const status = patched ? verifyReadStatus : initialReadStatus;
        if (status !== 200) {
          return new Response(JSON.stringify(errorBody), { status, headers: { 'content-type': 'application/json' } });
        }
        const settings = patched
          ? afterPatch
          : { ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null };
        return new Response(JSON.stringify({ id: vercelProjectId, name: projectName, ...projectExtras, ...settings }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url === `https://${host}` && (method === 'HEAD' || method === 'GET')) {
        probes += 1;
        if (probes <= wallProbeCount) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://vercel.com/sso-api?url=https%3A%2F%2F${host}` },
          });
        }
        return probePage(method);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }), {projectId: vercelProjectId, deploymentId, host});
  }

  async function withPublicAccessState<T>(slug: string, run: () => Promise<T>): Promise<T> {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), `od-deploy-route-${slug}-`));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      return await run();
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  }

  async function postDeploy(projectId: string, body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'index.html', providerId: VERCEL_PROVIDER_ID, ...body }),
    });
    return { status: resp.status, text: await resp.text() };
  }

  function storedDeployment(projectId: string) {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    const db = openDatabase(path.join(dataDir, 'projects'), { dataDir });
    return getDeployment(db, projectId, 'index.html', VERCEL_PROVIDER_ID);
  }

  /** One deploy with the standard fixture, returning the parsed body + calls. */
  async function publicAccessDeploy(
    slugAndPrefix: string,
    mockOptions: Partial<Parameters<typeof makeVercelPublicAccessMock>[0]>,
    requestBody: Record<string, unknown> = { publicAccess: true },
  ) {
    return withPublicAccessState(slugAndPrefix, async () => {
      const projectId = await setupProjectAndVercelConfig(slugAndPrefix, `Vercel ${slugAndPrefix}`);
      const calls: ProviderCall[] = [];
      const host = mockOptions.host ?? `${slugAndPrefix}.vercel.app`;
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: `prj_${slugAndPrefix.replace(/-/g, '_')}`,
        projectName: vercelProjectNameForProject(projectId),
        deploymentId: `dep-${slugAndPrefix}`,
        host,
        calls,
        ...mockOptions,
      })));
      try {
        const { status, text } = await postDeploy(projectId, requestBody);
        return { projectId, host, calls, status, text, body: JSON.parse(text) as Record<string, any> };
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  it('leaves the Vercel project untouched when publicAccess is omitted', async () => {
    const { status, text, body, calls } = await publicAccessDeploy('pa-omitted', {}, {});
    expect(status, text).toBe(200);
    expect(body.status).toBe('protected');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(body.publicAccess).toBeUndefined();
    expect(body.publicAccessOutcome).toBeUndefined();
  });

  it('leaves the Vercel project untouched when publicAccess is explicitly false', async () => {
    const { status, text, body, calls } = await publicAccessDeploy('pa-false', {}, { publicAccess: false });
    expect(status, text).toBe(200);
    expect(body.status).toBe('protected');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(body.publicAccessOutcome).toBeUndefined();
  });

  it('reads, patches, verifies and probes in that order, then reports ready', async () => {
    const { status, text, body, calls, projectId } = await publicAccessDeploy('pa-ok', {});
    expect(status, text).toBe(200);
    expect(body).toMatchObject({
      status: 'ready',
      access: 'public',
      publicAccess: true,
      publicAccessOutcome: 'ready',
    });

    // Exact identity of the protection exchange: read the project, write the
    // two settings off, read it back, then ask the preview anonymously.
    const projectCalls = calls.filter((call) => call.url.includes('/v9/projects/'));
    expect(projectCalls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(projectCalls[1]!.body).toEqual({ ssoProtection: null, passwordProtection: null });
    const probeIndex = calls.findIndex((call) => call.url.startsWith('https://pa-ok.vercel.app'));
    const verifyIndex = calls.indexOf(projectCalls[2]!);
    expect(probeIndex).toBeGreaterThan(verifyIndex);

    expect(storedDeployment(projectId)).toMatchObject({
      publicAccess: true,
      publicAccessOutcome: 'ready',
      providerMetadata: { protection: { sso: null, password: false } },
    });
  });

  // The live finding: Vercel's edge kept answering with the SSO wall for a few
  // seconds after the protection was verifiably off, and the daemon called a
  // change that had worked a failure.
  it('keeps probing through an authentication wall that clears, and reports ready', async () => {
    const { status, text, body } = await publicAccessDeploy('pa-late', { wallProbeCount: 2 });
    expect(status, text).toBe(200);
    expect(body).toMatchObject({ status: 'ready', publicAccessOutcome: 'ready' });
    expect(body.statusMessage).toBe('Public link is ready.');
  });

  it('reports auth-wall once the probe window has elapsed', async () => {
    // Window semantics live in waitForReachableDeploymentUrl, so they are
    // asserted there rather than by holding a route test open for 30s.
    const wall = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fwalled.example' },
    }));
    vi.stubGlobal('fetch', withVercelSiteProvider(wall));
    try {
      const result = await waitForReachableDeploymentUrl(['https://walled.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 40,
        intervalMs: 10,
        timeoutMs: 400,
      });
      expect(result.status).toBe('protected');
      // It did not give up on the first wall: the grace window was polled.
      expect(wall.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still reports link-delayed, not protected, when the preview is merely not live yet', async () => {
    const offline = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', withVercelSiteProvider(offline));
    try {
      const result = await waitForReachableDeploymentUrl(['https://not-live-yet.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 40,
        intervalMs: 10,
        timeoutMs: 60,
      });
      expect(result.status).toBe('link-delayed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports read-failed without sending a PATCH when the project cannot be read', async () => {
    const { body, calls } = await publicAccessDeploy('pa-read-failed', { initialReadStatus: 403 });
    // Nothing confirmed a wall, so the link is `unknown`, never `protected`.
    expect(body.status).toBe('unknown');
    expect(body.access).toBe('unknown');
    expect(body.publicAccessOutcome).toBe('read-failed');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('refuses a provider response without a bindable project identity', async () => {
    const { status, body, calls } = await publicAccessDeploy('pa-no-project', { vercelProjectId: '' });
    expect(status).toBe(409);
    expect(body.error.code).toBe('VERCEL_IDENTITY_MISMATCH');
    expect(calls.filter((call) => call.url.includes('/v9/projects/'))).toHaveLength(0);
  });

  it('refuses to PATCH a Vercel project whose name is not this project’s generated od-* name', async () => {
    const { body, calls } = await publicAccessDeploy('pa-mismatch', { projectName: 'od-some-other-project' });
    // Nothing confirmed a wall, so the link is `unknown`, never `protected`.
    expect(body.status).toBe('unknown');
    expect(body.access).toBe('unknown');
    expect(body.publicAccessOutcome).toBe('name-mismatch');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('reports patch-rejected when Vercel refuses the protection write', async () => {
    const { body } = await publicAccessDeploy('pa-rejected', { patchStatus: 403 });
    // Nothing confirmed a wall, so the link is `unknown`, never `protected`.
    expect(body.status).toBe('unknown');
    expect(body.access).toBe('unknown');
    expect(body.publicAccessOutcome).toBe('patch-rejected');
    expect(body.statusMessage).toMatch(/HTTP 403/);
  });

  it('reports patch-transport, never "HTTP 0", when the protection write cannot be sent', async () => {
    const { body } = await publicAccessDeploy('pa-transport', { patchTransportError: true });
    // Nothing confirmed a wall, so the link is `unknown`, never `protected`.
    expect(body.status).toBe('unknown');
    expect(body.access).toBe('unknown');
    expect(body.publicAccessOutcome).toBe('patch-transport');
    expect(body.statusMessage).not.toMatch(/HTTP 0/);
  });

  it('reports verify-failed, and does not claim protection was left on, when the re-read fails', async () => {
    const { body } = await publicAccessDeploy('pa-verify-failed', { verifyReadStatus: 500 });
    // Nothing confirmed a wall, so the link is `unknown`, never `protected`.
    expect(body.status).toBe('unknown');
    expect(body.access).toBe('unknown');
    expect(body.publicAccessOutcome).toBe('verify-failed');
    // The PATCH may well have landed; saying it "was left on" would be a guess.
    expect(body.statusMessage).not.toMatch(/left on/i);
  });

  it('reports verify-failed when the re-read after the PATCH is a 200 for another project', async () => {
    const { body } = await publicAccessDeploy('pa-verify-other', {
      afterPatch: { ssoProtection: null, passwordProtection: null, id: 'prj_someone_else' } as never,
    });
    expect(body.publicAccessOutcome).toBe('verify-failed');
    expect(body.access).not.toBe('public');
  });

  it('never calls a deploy public when the project read is a 200 for another project', async () => {
    const { body } = await publicAccessDeploy('pa-read-other', { projectExtras: { id: 'prj_someone_else' } }, {});
    expect(body.status).toBe('ready');
    expect(body.access).toBe('unknown');
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
  });

  it('reports still-protected when SSO survives the PATCH', async () => {
    const { body } = await publicAccessDeploy('pa-sticky-sso', {
      afterPatch: { ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null },
    });
    expect(body.status).toBe('protected');
    expect(body.publicAccessOutcome).toBe('still-protected');
  });

  it('reports still-protected when password protection survives the PATCH', async () => {
    const { body } = await publicAccessDeploy('pa-sticky-password', {
      afterPatch: { ssoProtection: null, passwordProtection: { deploymentType: 'all' } },
    });
    expect(body.status).toBe('protected');
    expect(body.publicAccessOutcome).toBe('still-protected');
  });

  it('rejects a non-boolean publicAccess with 400 before any provider call', async () => {
    const { status, text, calls } = await publicAccessDeploy('pa-invalid', {}, { publicAccess: 'yes' });
    expect(status, text).toBe(400);
    expect(text).toMatch(/publicAccess/);
    expect(calls).toHaveLength(0);
  });

  it('keeps every protection call team-scoped and aimed at the provider API only', async () => {
    await withPublicAccessState('pa-team', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-team', 'Vercel team scope');
      expect((await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: VERCEL_PROVIDER_ID, token: 'vercel-token-secret', teamId: 'team_abc' }),
      })).status).toBe(200);
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: 'prj_team',
        projectName: vercelProjectNameForProject(projectId),
        deploymentId: 'dep-pa-team',
        host: 'pa-team.vercel.app',
        calls,
      })));
      try {
        const { status, text } = await postDeploy(projectId, { publicAccess: true });
        expect(status, text).toBe(200);
        const projectCalls = calls.filter((call) => call.url.includes('/v9/projects/'));
        expect(projectCalls).toHaveLength(3);
        for (const call of projectCalls) {
          expect(call.url.startsWith('https://api.vercel.com/v9/projects/prj_team')).toBe(true);
          expect(call.url).toContain('teamId=team_abc');
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('keeps the token, the upstream project name and the provider error body out of the response and the record', async () => {
    const { text, projectId } = await publicAccessDeploy('pa-no-leak', {
      projectName: 'od-someone-elses-secret-project',
      errorBody: { error: { code: 'forbidden', message: 'tripwire-upstream-detail' } },
    });
    const stored = JSON.stringify(storedDeployment(projectId));
    for (const secret of ['vercel-token-secret', 'od-someone-elses-secret-project', 'tripwire-upstream-detail']) {
      expect(text).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  // Retry link: a user who saw `protected` must be able to ask again without
  // paying for a whole redeploy, because the usual cause is Vercel's edge
  // still catching up rather than a refused change.
  it('re-verifies protection and re-probes when Retry link is used on a public-access deployment', async () => {
    await withPublicAccessState('pa-retry', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-retry', 'Vercel retry link');
      const calls: ProviderCall[] = [];
      const projectName = vercelProjectNameForProject(projectId);
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: 'prj_retry',
        projectName,
        deploymentId: 'dep-pa-retry',
        host: 'pa-retry.vercel.app',
        calls,
        // The deploy ends `protected` (the project still read as protected),
        // which is the state a user retries from. Using this rather than a
        // never-clearing wall keeps the setup off the 30s probe window.
        afterPatch: { ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null },
      })));
      let deploymentId = '';
      try {
        const { text } = await postDeploy(projectId, { publicAccess: true });
        const body = JSON.parse(text) as Record<string, any>;
        // The record remembers the intent, so a retry knows to re-verify.
        expect(body.publicAccess).toBe(true);
        expect(body.publicAccessOutcome).toBe('still-protected');
        deploymentId = body.id;
      } finally {
        vi.unstubAllGlobals();
      }
      expect(storedDeployment(projectId)?.publicAccess).toBe(true);

      const retryCalls: ProviderCall[] = [];
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        retryCalls.push({ method, url, body: null, auth: null });
        if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
          return new Response(JSON.stringify({ id: 'prj_retry', name: projectName, ssoProtection: null, passwordProtection: null }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('https://pa-retry.vercel.app')) return probePage(method);
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })));
      try {
        const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deploymentId}/check-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const retryText = await resp.text();
        expect(resp.status, retryText).toBe(200);
        expect(JSON.parse(retryText)).toMatchObject({ status: 'ready', publicAccessOutcome: 'ready' });
        // It re-read the project's protection rather than trusting the record.
        expect(retryCalls.some((call) => call.url.includes('/v9/projects/'))).toBe(true);
        // And it never wrote: a retry confirms, it does not change settings.
        expect(retryCalls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // Retry link on a deployment made WITHOUT "Make preview public" used to
  // probe the URL only and call any 200 "Public link is ready." It now
  // re-reads the project's protection (GET only) so a protected project whose
  // URL happens to answer 200 is reported as protected, never public.
  const plainRetry = async (
    slug: string,
    projectRead: { ssoProtection: unknown; passwordProtection: unknown } | 'forbidden' | { raw: string },
    probeStatus = 200,
    gatedGet: false | string = false,
  ) => {
    let result: { status: number; body: Record<string, any>; retryCalls: ProviderCall[] } | undefined;
    await withPublicAccessState(slug, async () => {
      const projectId = await setupProjectAndVercelConfig(slug, `Vercel ${slug}`);
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: `prj_${slug}`,
        projectName: vercelProjectNameForProject(projectId),
        deploymentId: `dep-${slug}`,
        host: `${slug}.vercel.app`,
        calls,
      })));
      let deploymentId = '';
      try {
        const { text } = await postDeploy(projectId, {});
        deploymentId = (JSON.parse(text) as Record<string, any>).id;
      } finally {
        vi.unstubAllGlobals();
      }

      const retryCalls: ProviderCall[] = [];
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        retryCalls.push({ method, url, body: null, auth: null });
        if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
          if (projectRead === 'forbidden') return new Response('{}', { status: 403 });
          if ('raw' in projectRead) {
            return new Response(projectRead.raw, { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ id: `prj_${slug}`, ...projectRead }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith(`https://${slug}.vercel.app`)) {
          // A HEAD that answers 200 while the GET a visitor sends meets the
          // SSO wall's page.
          if (gatedGet !== false && method === 'GET') {
            return new Response(gatedGet, { status: 200, headers: { 'content-type': 'text/html' } });
          }
          return probePage(method, probeStatus);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })));
      try {
        const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deploymentId}/check-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        result = { status: resp.status, body: JSON.parse(await resp.text()) as Record<string, any>, retryCalls };
      } finally {
        vi.unstubAllGlobals();
      }
    });
    if (!result) throw new Error('retry did not run');
    return result;
  };

  it('reports a protected project as protected on Retry link even when the URL answers 200', async () => {
    const { status, body, retryCalls } = await plainRetry('pa-retry-plain', {
      ssoProtection: { deploymentType: 'all_except_custom_domains' },
      passwordProtection: null,
    });
    expect(status).toBe(200);
    expect(body.access).toBe('protected');
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
    // It re-read the project's protection, and never wrote.
    expect(retryCalls.some((call) => call.url.includes('/v9/projects/') && call.method === 'GET')).toBe(true);
    expect(retryCalls.filter((call) => call.method !== 'GET' && call.method !== 'HEAD')).toHaveLength(0);
  });

  it('reports public on Retry link only when protection reads off and the probe gets a 2xx', async () => {
    const { body, retryCalls } = await plainRetry('pa-retry-open', { ssoProtection: null, passwordProtection: null });
    expect(body).toMatchObject({ status: 'ready', access: 'public', statusMessage: 'Public link is ready.' });
    expect(retryCalls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('reports unknown on Retry link when HEAD answers 200 but the anonymous GET meets a login page', async () => {
    const { body, retryCalls } = await plainRetry(
      'pa-retry-gated-get',
      { ssoProtection: null, passwordProtection: null },
      200,
      '<!doctype html><html><title>Vercel Authentication</title></html>',
    );
    expect(retryCalls.some((call) => call.method === 'HEAD' && call.url.startsWith('https://pa-retry-gated-get.vercel.app'))).toBe(true);
    expect(retryCalls.some((call) => call.method === 'GET' && call.url.startsWith('https://pa-retry-gated-get.vercel.app'))).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.access).toBe('unknown');
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
  });

  // Same host, 2xx, HTML, and no provider wall string: only the content match
  // against the deployed page ('<h1>Hello</h1>') can tell these from the site.
  it.each([
    ['a generic sign-in page', '<!doctype html><html><head><title>Sign in</title></head><body><form><input type="password"></form></body></html>'],
    ['the page with a password form added', '<!doctype html><h1>Hello</h1><form><input type="password" name="pw"></form>'],
    ['an HTML page that is not the deployed one', '<!doctype html><html><body><p>Welcome</p></body></html>'],
  ])('reports unknown on Retry link when a same-host 2xx GET serves %s', async (_label, wall) => {
    const { body } = await plainRetry(`pa-retry-wall-${wall.length}`, { ssoProtection: null, passwordProtection: null }, 200, wall);
    expect(body).toMatchObject({ status: 'ready', access: 'unknown' });
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
  });

  it('reports unknown on Retry link when the protection read fails, even though the URL answers', async () => {
    const { body } = await plainRetry('pa-retry-unread', 'forbidden');
    expect(body.status).toBe('ready');
    expect(body.access).toBe('unknown');
    expect(body.statusMessage).toMatch(/not confirmed public/i);
  });

  // A 200 whose body is not a readable copy of THIS project says nothing
  // about its protection, so an anonymous 200 must not become `public`.
  it.each([
    ['null', 'pa-retry-null', 'null'],
    ['an empty object', 'pa-retry-empty', '{}'],
    ['another project', 'pa-retry-other', JSON.stringify({ id: 'prj_someone_else', ssoProtection: null, passwordProtection: null })],
    ['a mistyped setting', 'pa-retry-typed', JSON.stringify({ id: 'prj_pa-retry-typed', ssoProtection: 'off', passwordProtection: null })],
  ])('reports unknown on Retry link when the project read is 200 with %s', async (_label, slug, raw) => {
    const { body } = await plainRetry(slug, { raw });
    expect(body.status).toBe('ready');
    expect(body.access).toBe('unknown');
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
  });

  it('reports unknown on Retry link when the probe only saw a redirect', async () => {
    const { body } = await plainRetry('pa-retry-redirect', { ssoProtection: null, passwordProtection: null }, 307);
    expect(body.access).toBe('unknown');
    expect(body.statusMessage).not.toMatch(/Public link is ready/i);
  });

  // Vercel's Security Checkpoint answers a probe with `x-vercel-mitigated:
  // challenge`. Read as a plain HTTP failure the route reported `link-delayed`
  // and an HTTP number, which says "wait" about a link that needs a browser.
  it('reports a Retry link that met the Security Checkpoint as challenged, with its own sentence', async () => {
    await withPublicAccessState('pa-challenged', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-challenged', 'Vercel checkpoint');
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: 'prj_challenged',
        projectName: vercelProjectNameForProject(projectId),
        deploymentId: 'dep-pa-challenged',
        host: 'pa-challenged.vercel.app',
        calls,
      })));
      let deploymentId = '';
      try {
        const { text } = await postDeploy(projectId, {});
        deploymentId = (JSON.parse(text) as Record<string, any>).id;
      } finally {
        vi.unstubAllGlobals();
      }

      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://pa-challenged.vercel.app')) {
          return new Response('<html>checkpoint</html>', {
            status: 403,
            headers: { 'x-vercel-mitigated': 'challenge', 'content-type': 'text/html' },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })));
      try {
        const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deploymentId}/check-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const text = await resp.text();
        expect(resp.status, text).toBe(200);
        const body = JSON.parse(text) as Record<string, any>;
        expect(body.status).toBe('challenged');
        expect(body.statusMessage).toMatch(/Security Checkpoint/);
        // Not an HTTP number the reader has to interpret.
        expect(body.statusMessage).not.toMatch(/HTTP 403/);
        expect(storedDeployment(projectId)).toMatchObject({ status: 'challenged' });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // --- Round 3: probe-window honesty, PATCH body handling, provenance ------

  it('reports link-delayed when a wall inside the grace window is followed by ordinary not-ready answers', async () => {
    // The wall must not be sticky: once the preview stops answering with the
    // wall, the honest terminal answer is "not reachable yet", not "protected".
    let calls = 0;
    vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async () => {
      calls += 1;
      if (calls <= 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fmixed.example' },
        });
      }
      return new Response('', { status: 503 });
    })));
    try {
      const result = await waitForReachableDeploymentUrl(['https://mixed.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 200,
        intervalMs: 10,
        timeoutMs: 120,
      });
      expect(result.status).toBe('link-delayed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to store an unassigned stable alias as a ready site address', async () => {
    const { status, body, projectId } = await publicAccessDeploy('pa-pending', { host: '' });
    expect(status).toBe(502);
    expect(body.error.code).toBe('VERCEL_ALIAS_UNVERIFIED');
    expect(storedDeployment(projectId)).toMatchObject({ status: 'binding', url: '', access: 'unknown', providerMetadata: { vercelProjectName: vercelProjectNameForProject(projectId) } });
    const deployments = await fetch(`${baseUrl}/api/projects/${projectId}/deployments`);
    expect(deployments.status).toBe(200);
    expect(await deployments.json()).toEqual({ deployments: [] });
  });

  it('accepts an empty-body 2xx PATCH instead of calling it a transport failure', async () => {
    const { body } = await publicAccessDeploy('pa-204', { patchResponse: 'empty' });
    expect(body.publicAccessOutcome).toBe('ready');
    expect(body.status).toBe('ready');
  });

  it('accepts a non-JSON 2xx PATCH, because the verification GET is what proves the state', async () => {
    const { body } = await publicAccessDeploy('pa-non-json', { patchResponse: 'text' });
    expect(body.publicAccessOutcome).toBe('ready');
    expect(body.status).toBe('ready');
  });

  it('keeps the token, an upstream detail and a provider error body out of a refused PATCH', async () => {
    // The name matches, so the PATCH is actually sent and actually refused —
    // the path where a provider error body exists to leak in the first place.
    const { text, projectId, calls } = await publicAccessDeploy('pa-leak-patch', {
      patchStatus: 403,
      errorBody: { error: { code: 'forbidden', message: 'tripwire-error-body' } },
      projectExtras: { privateDetail: 'tripwire-upstream-detail' },
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    const stored = JSON.stringify(storedDeployment(projectId));
    for (const secret of ['vercel-token-secret', 'tripwire-error-body', 'tripwire-upstream-detail']) {
      expect(text).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  it('retries against the recorded Vercel project id with team scoping, and refuses a name mismatch', async () => {
    await withPublicAccessState('pa-retry-provenance', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-retry-provenance', 'Vercel retry provenance');
      expect((await fetch(`${baseUrl}/api/deploy/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: VERCEL_PROVIDER_ID, token: 'vercel-token-secret', teamId: 'team_xyz' }),
      })).status).toBe(200);
      const projectName = vercelProjectNameForProject(projectId);
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: 'prj_recorded',
        projectName,
        deploymentId: 'dep-pa-retry-provenance',
        host: 'pa-retry-provenance.vercel.app',
        calls,
        afterPatch: { ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null },
      })));
      let deploymentId = '';
      try {
        const { text } = await postDeploy(projectId, { publicAccess: true });
        deploymentId = (JSON.parse(text) as Record<string, any>).id;
      } finally {
        vi.unstubAllGlobals();
      }

      const retryLink = async (returnedName: string) => {
        const retryCalls: ProviderCall[] = [];
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const method = init?.method || (input instanceof Request ? input.method : 'GET');
          if (url.startsWith(baseUrl)) return realFetch(input, init);
          retryCalls.push({ method, url, body: null, auth: new Headers(init?.headers).get('authorization') });
          if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
            return new Response(JSON.stringify({ id: 'prj_recorded', name: returnedName, ssoProtection: null, passwordProtection: null }), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
          }
          if (url.startsWith('https://pa-retry-provenance.vercel.app')) return probePage(method);
          throw new Error(`Unexpected fetch: ${method} ${url}`);
        })));
        try {
          const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deploymentId}/check-link`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          return { status: resp.status, body: JSON.parse(await resp.text()) as Record<string, any>, retryCalls };
        } finally {
          vi.unstubAllGlobals();
        }
      };

      const ok = await retryLink(projectName);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: 'ready', publicAccessOutcome: 'ready' });
      const projectReads = ok.retryCalls.filter((call) => call.url.includes('/v9/projects/'));
      expect(projectReads.length).toBeGreaterThan(0);
      for (const call of projectReads) {
        // The id the daemon recorded at deploy time, never one from the request.
        expect(call.url.startsWith('https://api.vercel.com/v9/projects/prj_recorded')).toBe(true);
        expect(call.url).toContain('teamId=team_xyz');
      }

      // Same recorded id, but the project now answers with a different name:
      // the retry must refuse instead of reporting the link public.
      const mismatched = await retryLink('od-somebody-elses-project');
      // A refused identity check proves no wall either: `unknown`, not `protected`.
      expect(mismatched.body).toMatchObject({ status: 'unknown', access: 'unknown', publicAccessOutcome: 'name-mismatch' });
      expect(mismatched.retryCalls.some((call) => call.url.startsWith('https://pa-retry-provenance.vercel.app'))).toBe(false);
    });
  });

  // --- Round 4: one successful probe is not proof -------------------------
  //
  // A live deploy answered `ready` 4.5s after the protection change; 0.4s
  // later the same URL returned the SSO wall, and only ~20s after that did it
  // answer 200 consistently. Vercel's edge is inconsistent for several
  // seconds either way, so the public path requires consecutive successes.

  /** Scripted probe answers: 'ok' = 200, 'wall' = SSO redirect, '503'. */
  function scriptedProbe(script: ('ok' | 'wall' | '503')[], tail: 'ok' | 'wall' | '503') {
    let i = 0;
    return vi.fn(async () => {
      const answer = script[i] ?? tail;
      i += 1;
      if (answer === 'wall') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fflaky.example' },
        });
      }
      if (answer === '503') return new Response('', { status: 503 });
      return new Response('', { status: 200 });
    });
  }

  it('does not call a preview ready until it answers twice in a row', async () => {
    const probe = scriptedProbe(['ok', 'wall', 'ok', 'ok'], 'ok');
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    // Exact probe counts require a deterministic confirmation-spacing clock.
    // CI's real 5ms timers can add a valid extra probe before the gap elapses.
    vi.useFakeTimers();
    try {
      let settled = false;
      const resultPromise = waitForReachableDeploymentUrl(['https://flaky.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 10_000,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      }).then(result => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(true);
      const result = await resultPromise;
      expect(result.status).toBe('ready');
      // The first success did not end it: the wall reset the run, so it took
      // the two consecutive successes that follow.
      expect(probe.mock.calls.length).toBe(4);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('still returns on the first success with the historical confirmation count', async () => {
    const probe = scriptedProbe(['ok'], 'wall');
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    try {
      const result = await waitForReachableDeploymentUrl(['https://flaky.example'], {
        providerLabel: 'Vercel',
        intervalMs: 5,
        timeoutMs: 3_000,
      });
      expect(result.status).toBe('ready');
      expect(probe.mock.calls.length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the grace rule decide when a success is followed by a wall that never clears', async () => {
    const probe = scriptedProbe(['ok'], 'wall');
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    try {
      const result = await waitForReachableDeploymentUrl(['https://flaky.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 30,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 400,
      });
      expect(result.status).toBe('protected');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the link as unconfirmed, not ready, when successes never become consecutive', async () => {
    // Alternating sweeps, never two good ones in a row. Keyed on the HEAD
    // that opens each sweep, so the GET fallback inside one sweep reports the
    // same answer rather than flipping mid-check.
    let sweep = 0;
    let answer: 'ok' | '503' = 'ok';
    vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'HEAD') {
        sweep += 1;
        answer = sweep % 2 === 1 ? 'ok' : '503';
      }
      return new Response('', { status: answer === 'ok' ? 200 : 503 });
    })));
    try {
      const result = await waitForReachableDeploymentUrl(['https://flaky.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 10_000,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 120,
      });
      expect(result.status).toBe('link-delayed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires the same consecutive successes on the Retry link path', async () => {
    await withPublicAccessState('pa-retry-confirm', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-retry-confirm', 'Vercel retry confirmations');
      const projectName = vercelProjectNameForProject(projectId);
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(makeVercelPublicAccessMock({
        vercelProjectId: 'prj_retry_confirm',
        projectName,
        deploymentId: 'dep-pa-retry-confirm',
        host: 'pa-retry-confirm.vercel.app',
        calls,
        afterPatch: { ssoProtection: { deploymentType: 'all_except_custom_domains' }, passwordProtection: null },
      })));
      let deploymentId = '';
      try {
        const { text } = await postDeploy(projectId, { publicAccess: true });
        deploymentId = (JSON.parse(text) as Record<string, any>).id;
      } finally {
        vi.unstubAllGlobals();
      }

      let probes = 0;
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
          return new Response(JSON.stringify({ id: 'prj_retry_confirm', name: projectName, ssoProtection: null, passwordProtection: null }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('https://pa-retry-confirm.vercel.app')) {
          probes += 1;
          // 200, then the wall, then steady 200s — the live shape.
          if (probes === 2) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fpa-retry-confirm.vercel.app' },
            });
          }
          return probePage(method);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })));
      try {
        const resp = await fetch(`${baseUrl}/api/projects/${projectId}/deployments/${deploymentId}/check-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const body = JSON.parse(await resp.text()) as Record<string, any>;
        expect(resp.status).toBe(200);
        expect(body).toMatchObject({ status: 'ready', publicAccessOutcome: 'ready' });
        // A single 200 was not enough: the wall reset the run.
        expect(probes).toBeGreaterThanOrEqual(4);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // --- Round 5: a confirmation run is per candidate URL -------------------
  //
  // A deploy hands the probe the deployment URL plus every alias. With one
  // shared run keyed to a single URL, each candidate reset the other's count
  // on every pass, so two reachable candidates could never reach two
  // consecutive successes: two live deploys sat out the full 60s and reported
  // `link-delayed` for a link that answered 200 continuously for 90s after.

  /** Answers per URL, so a candidate can be walled while another is fine. */
  function perUrlProbe(answers: Record<string, 'ok' | 'wall' | '503'>) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const answer = answers[url] ?? 'ok';
      if (answer === 'wall') {
        return new Response(null, {
          status: 302,
          headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(url)}` },
        });
      }
      if (answer === '503') return new Response('', { status: 503 });
      return new Response('', { status: 200 });
    });
  }

  it('confirms a candidate across passes even when a second candidate is also reachable', async () => {
    // Real timers made this flaky under CI's event-loop jitter: `waitForReachableDeploymentUrl`
    // gates a second success on `Date.now() - run.lastAt >= confirmSpacingMs` (5ms here), and a
    // slow tick between pass 1 and pass 2 could shave that gap under 5ms, costing an extra pass
    // and pushing `probe.mock.calls.length` to 4. Fake timers make `Date.now()` and `setTimeout`
    // both deterministic, so the gap between passes is always exactly `intervalMs`, never less.
    const probe = perUrlProbe({
      'https://dep.example': 'ok',
      'https://alias.example': 'ok',
    });
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    vi.useFakeTimers();
    try {
      const resultPromise = waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 10_000,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      });
      // Advances past every `setTimeout(intervalMs)` gap the loop schedules along the way, up to
      // the full timeout window — the promise resolves well before that once confirmed, and the
      // extra advancement is a no-op once no more timers are pending.
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await resultPromise;
      expect(result.status).toBe('ready');
      expect(result.url).toBe('https://dep.example');
      // Pass 1 probes both candidates, pass 2 confirms the first one.
      expect(probe.mock.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('lets a walled alias sit inside the grace window without blocking the deployment URL', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'ok',
      'https://alias.example': 'wall',
    });
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    try {
      const result = await waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 10_000,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      });
      expect(result.status).toBe('ready');
      expect(result.url).toBe('https://dep.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resets only the candidate that failed, not the one that is answering', async () => {
    // The alias flaps; the deployment URL is steady. The steady one must
    // still confirm, and the flapping one must not carry a stale count.
    // Flipped on the HEAD that opens each check, so the GET fallback inside
    // one check reports the same answer instead of flipping mid-check.
    let aliasSweep = 0;
    let aliasAnswer = 200;
    vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://alias.example')) {
        if ((init?.method || 'GET') === 'HEAD') {
          aliasSweep += 1;
          aliasAnswer = aliasSweep % 2 === 1 ? 200 : 503;
        }
        return new Response('', { status: aliasAnswer });
      }
      return new Response('', { status: 200 });
    })));
    try {
      const result = await waitForReachableDeploymentUrl(['https://alias.example', 'https://dep.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 10_000,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      });
      expect(result.status).toBe('ready');
      expect(result.url).toBe('https://dep.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // --- Round 6: candidate-local walls and a body read the timer still guards

  it('keeps confirming a healthy candidate when another candidate is walled after the grace window', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'ok',
      'https://alias.example': 'wall',
    });
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    try {
      const result = await waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
        providerLabel: 'Vercel',
        // Every wall is post-grace. One walled alias must not decide the
        // answer for a deployment URL that is answering perfectly well.
        protectedGraceMs: 0,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      });
      expect(result.status).toBe('ready');
      expect(result.url).toBe('https://dep.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still reports protected once every candidate is walled after the grace window', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'wall',
      'https://alias.example': 'wall',
    });
    vi.stubGlobal('fetch', withVercelSiteProvider(probe));
    try {
      const result = await waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
        providerLabel: 'Vercel',
        protectedGraceMs: 0,
        intervalMs: 5,
        confirmSpacingMs: 5,
        confirmations: 2,
        timeoutMs: 3_000,
      });
      expect(result.status).toBe('protected');
      // Reported against the deployment URL, not whichever alias answered last.
      expect(result.url).toBe('https://dep.example');
      // Two probes decided it: each candidate answered once, and neither is
      // asked again once its wall is definitive.
      expect(probe.mock.calls.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives up on a project read whose headers arrive but whose body never does', async () => {
    // The abort timer used to be cleared as soon as headers landed, so a 2xx
    // that stalls its body hung the deploy for as long as the socket stayed
    // open. The timer has to cover the body read too.
    await withPublicAccessState('pa-stalled-body', async () => {
      const projectId = await setupProjectAndVercelConfig('pa-stalled-body', 'Vercel stalled body');
      const realFetch = globalThis.fetch;
      const calls: ProviderCall[] = [];
      vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        if (url.startsWith(baseUrl)) return realFetch(input, init);
        calls.push({ method, url, body: null, auth: null });
        if (url.startsWith('https://api.vercel.com/v2/files')) {
          return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const deployment = { id: 'dep-stalled', projectId: 'prj_stalled', readyState: 'READY', url: 'stalled.vercel.app' };
        if (url.includes('/v13/deployments')) {
          return new Response(JSON.stringify(deployment), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('https://api.vercel.com/v9/projects/') && method === 'GET') {
          // Headers now, body never — until the caller's own signal fires.
          return {
            ok: true,
            status: 200,
            body: null,
            json: () => new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }), { projectId: 'prj_stalled', deploymentId: 'dep-stalled', host: 'stalled.vercel.app' }));
      try {
        const { status, text } = await postDeploy(projectId, { publicAccess: true });
        expect(status, text).toBe(200);
        const body = JSON.parse(text) as Record<string, any>;
        expect(body.publicAccessOutcome).toBe('read-failed');
        // Nothing was written: the identity read never completed.
        expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }, 30_000);
});
