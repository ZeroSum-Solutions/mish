// A page over the byte budget on the REAL build path: the daemon's routes, the fast lane's real
// `buildSite`/`runFastLane`, and the real marketing-site family package — only the model and the
// daemon's own project API are faked. The family's render is wrapped so every page carries a
// synthetic section of `PAGE_BYTE_LIMIT` bytes (spliced through the compiler's `compose` hook),
// so the final page is over the limit only once the project already exists.
//
// A non-strict build (`verify: 'off'`) creates its project before the fill and paints into it.
// `PageTooLargeError` must still leave nothing published: the project it created is deleted, and
// the failed snapshot carries the code and no `projectId`. A project the caller supplied is never
// deleted and stays on the snapshot.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencyBuildResponse, AgencyBuildSnapshot } from '@mish/contracts';
import { buildSite, PAGE_TOO_LARGE } from '@mish/agency-fast-lane/build';
import type { ModelCall } from '@mish/agency-fast-lane/deepseek';
import { PAGE_BYTE_LIMIT } from '@mish/agency-fast-lane/effects';
import { loadFamilyPackage, type FamilyPackage } from '@mish/agency-fast-lane/family';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { familyPackageDir, registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'Ashgrove Language Academy teaches adult Spanish and French in Boston.';
const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'plugins', '_official');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The JSON block after a heading in a fast-lane prompt (`TEMPLATE`, `LIMITS`). */
function promptBlock(prompt: string, heading: 'LIMITS' | 'TEMPLATE'): Json {
  const start = prompt.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`prompt has no ${heading} block`);
  const body = prompt.slice(start + heading.length + 2);
  const end = ['\n\nTEMPLATE\n', '\n\nYOUR PREVIOUS ANSWER WAS REJECTED\n'].map((marker) => body.indexOf(marker)).filter((index) => index >= 0);
  return JSON.parse(end.length > 0 ? body.slice(0, Math.min(...end)) : body) as Json;
}

/** Fills every template string (anchors kept) with a short value inside its limit. */
function fillTemplate(template: Json, limits: Json | undefined, key = ''): Json {
  if (typeof template === 'string') {
    if (key === 'id') return template;
    if (key === 'links') return null;
    return `Ashgrove ${key}`.slice(0, typeof limits === 'number' ? limits : Infinity);
  }
  if (Array.isArray(template)) return template.map((item, index) => fillTemplate(item, Array.isArray(limits) ? limits[index] : undefined, key));
  if (template && typeof template === 'object') {
    const lim = limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : {};
    return Object.fromEntries(Object.entries(template).map(([childKey, child]) => [childKey, fillTemplate(child, lim[childKey], childKey)]));
  }
  return template;
}

const fakeModel: ModelCall = async ({ user }) => ({
  text: JSON.stringify(fillTemplate(promptBlock(user, 'TEMPLATE'), promptBlock(user, 'LIMITS'))),
  usage: { input: 100, output: 50, cachedRead: 0 },
  firstTokenMs: 1,
  ms: 2,
  retries: 0,
});

/** The daemon's project API: the ids it holds, and every call in order. */
function fakeDaemon() {
  const projects = new Set<string>();
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: string } : undefined;
    if (method === 'POST' && url.endsWith('/api/projects')) projects.add(String(body!.id));
    if (method === 'DELETE') {
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      if (!projects.delete(id)) return new Response(JSON.stringify({ error: { code: 'PROJECT_NOT_FOUND', message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify(body?.id ? { id: body.id } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { projects, calls, fetchImpl };
}

/** A synthetic section of `size` UTF-8 bytes spliced before `</body>`. */
function pad(size: number) {
  const open = '<section id="synthetic-oversized"><p>';
  const close = '</p></section>';
  return (html: string) => {
    const at = html.lastIndexOf('</body>');
    return `${html.slice(0, at)}${open}${'x'.repeat(size - open.length - close.length)}${close}${html.slice(at)}`;
  };
}

let tempRoot = '';
let server: http.Server | undefined;
let baseUrl = '';
let daemon: ReturnType<typeof fakeDaemon>;
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's fire-and-forget `persist()` write never races the directory it writes into being
 * removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-page-budget-'));
  daemon = fakeDaemon();
  const real = await loadFamilyPackage(familyPackageDir(BUNDLED, 'marketing-site'), 'marketing-site');
  const oversized: FamilyPackage = {
    ...real,
    render: (input, entry, options) => real.render(input, entry, { ...options, compose: (html) => pad(PAGE_BYTE_LIMIT)(options?.compose ? options.compose(html) : html) }),
  };
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  routes = registerAgencyBuildRoutes(app, {
    http: { sendApiError, createSseResponse, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: [{ family: 'marketing-site', pageKind: 'site' }] } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: async () => 'jev-key' }),
      daemonUrlRef: { current: 'http://daemon.test' },
      // The real build: only the model and the daemon's project API are faked.
      runBuild: (input, deps) => buildSite(input, { ...deps, createModelCaller: () => fakeModel, daemonFetch: daemon.fetchImpl }),
      buildDeps: {
        createModelCaller: () => fakeModel,
        createJevChecker: () => { throw new Error('verify is off in this suite'); },
        createJevRouter: () => { throw new Error('the family is named in this suite'); },
        resolveJevCredential: async () => 'jev-key',
        resolveModelKey: async () => 'model-key',
      },
      loadPackage: async () => oversized,
      buildsFile: path.join(tempRoot, 'agency-builds', 'index.json'),
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  // Drains any build still in flight, then the store's own save/load chain, so `rmSync` below
  // never races a `persist()` write that is still touching `tempRoot/agency-builds/`.
  await routes.idle();
  rmSync(tempRoot, { force: true, recursive: true });
});

const buildOf = async (response: Response) => (await response.json() as AgencyBuildResponse).build;

async function runToEnd(body: Record<string, unknown>): Promise<AgencyBuildSnapshot> {
  const response = await fetch(`${baseUrl}/api/agency/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(202);
  const { id } = await buildOf(response);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = await buildOf(await fetch(`${baseUrl}/api/agency/builds/${id}`));
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}

describe('page-too-large on the real build path', () => {
  it('removes the project a non-strict build created, and the failed snapshot names no project', async () => {
    const snapshot = await runToEnd({ brief: BRIEF, family: 'marketing-site', verify: 'off' });

    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('BUILD_FAILED');
    expect(snapshot.error?.message).toContain(`(${PAGE_TOO_LARGE})`);
    expect(snapshot.failure).toBeDefined();
    expect(snapshot.projectId).toBeUndefined();

    // The project existed before the throw: created, painted into, then deleted.
    const created = snapshot.events.find((event) => event.type === 'project');
    expect(created).toMatchObject({ created: true });
    const projectId = (created as { projectId: string }).projectId;
    const methods = daemon.calls.map((call) => `${call.method} ${call.url.replace('http://daemon.test', '')}`);
    const createAt = methods.indexOf('POST /api/projects');
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(methods.slice(createAt + 1).some((call) => call.startsWith(`POST /api/projects/${projectId}/files`))).toBe(true);
    expect(methods.at(-1)).toBe(`DELETE /api/projects/${projectId}`);
    expect(daemon.projects.size).toBe(0);
  }, 30_000);

  it('never deletes a project the caller supplied; the snapshot keeps it', async () => {
    const snapshot = await runToEnd({ brief: BRIEF, family: 'marketing-site', verify: 'off', projectId: 'caller-owned' });

    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.message).toContain(`(${PAGE_TOO_LARGE})`);
    expect(snapshot.projectId).toBe('caller-owned');
    expect(daemon.calls.some((call) => call.method === 'DELETE')).toBe(false);
  }, 30_000);
});
