// A sandboxed plugin preview (opaque `Origin: null`) loads its `@font-face`
// fonts from /api/plugins/:id/asset/*. The request must pass the REAL /api
// origin middleware in server.ts, not only the route: the route's CORS echo
// is worthless if the guard answers 403 first. The allowance is exactly as
// narrow as this: GET/HEAD, font extensions, bundled official plugins.
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

const originalDataDir = process.env.OD_DATA_DIR;
let dataDir = '';
let fixtureRoot = '';
let started: StartedServer | null = null;

// A real plugin under plugins/_official/, registered as bundled at boot.
const BUNDLED_ID = 'example-dreamcore-landing';
const BUNDLED_FONT = 'assets/archivo.woff2';
const USER_ID = 'user-font-null-origin-fixture';
const GUARD_ERROR = { error: 'Origin: null not allowed for this route' };

async function installUserPlugin(baseUrl: string, folder: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ source: folder }),
  });
  const raw = await res.text();
  if (!raw.includes('event: success')) throw new Error(`installer did not finalize:\n${raw}`);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'od-plugin-font-guard-data-'));
  fixtureRoot = await mkdtemp(join(tmpdir(), 'od-plugin-font-guard-src-'));
  const folder = join(fixtureRoot, USER_ID);
  await mkdir(join(folder, 'fonts'), { recursive: true });
  await writeFile(join(folder, 'fonts', 'Licensed.woff2'), 'wOF2-licensed');
  await writeFile(join(folder, 'mish.json'), JSON.stringify({
    name: USER_ID,
    title: 'User font fixture',
    version: '1.0.0',
    description: 'fixture',
    license: 'MIT',
    od: { kind: 'skill', capabilities: ['prompt:inject'] },
  }));
  await writeFile(join(folder, 'SKILL.md'), `---\nname: ${USER_ID}\ndescription: fixture\n---\n# fixture\n`);
  process.env.OD_DATA_DIR = dataDir;
  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as StartedServer;
  await installUserPlugin(started.url, folder);
}, 60_000);

afterAll(async () => {
  const current = started;
  started = null;
  if (current) {
    await Promise.resolve(current.shutdown?.());
    current.server.closeAllConnections?.();
    if (current.server.listening) await new Promise<void>((resolve) => current.server.close(() => resolve()));
  }
  const { closeDatabase } = await import('../src/db.js');
  closeDatabase();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
  else process.env.OD_DATA_DIR = originalDataDir;
  vi.resetModules();
}, 30_000);

const assetUrl = (id: string, rel: string) => `${started!.url}/api/plugins/${id}/asset/${rel}`;

it('lets an Origin: null GET/HEAD for a bundled official plugin font through the guard with the CORS echo', async () => {
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(assetUrl(BUNDLED_ID, BUNDLED_FONT), { method, headers: { Origin: 'null' } });
    expect(res.status, method).toBe(200);
    expect(res.headers.get('access-control-allow-origin'), method).toBe('null');
    expect(res.headers.get('content-type'), method).toBe('font/woff2');
    expect(res.headers.get('vary') ?? '', method).toMatch(/Origin/);
  }
});

it('refuses Origin: null for a non-font asset of a bundled official plugin', async () => {
  for (const rel of ['SKILL.md', 'mish.json']) {
    const res = await fetch(assetUrl(BUNDLED_ID, rel), { headers: { Origin: 'null' } });
    expect(res.status, rel).toBe(403);
    expect(await res.json(), rel).toEqual(GUARD_ERROR);
    expect(res.headers.get('access-control-allow-origin'), rel).toBeNull();
  }
});

it('refuses Origin: null font reads from a user-installed plugin', async () => {
  const res = await fetch(assetUrl(USER_ID, 'fonts/Licensed.woff2'), { headers: { Origin: 'null' } });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual(GUARD_ERROR);
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
  // Same-origin callers (no Origin) still read it, without any CORS echo.
  const local = await fetch(assetUrl(USER_ID, 'fonts/Licensed.woff2'));
  expect(local.status).toBe(200);
  expect(local.headers.get('access-control-allow-origin')).toBeNull();
});

it('refuses Origin: null for non-GET methods and prototype-named extensions', async () => {
  const post = await fetch(assetUrl(BUNDLED_ID, BUNDLED_FONT), { method: 'POST', headers: { Origin: 'null' } });
  expect(post.status).toBe(403);
  for (const rel of ['x.constructor', 'x.__proto__', 'x.toString', 'fonts/..%2FSKILL.woff2']) {
    const res = await fetch(assetUrl(BUNDLED_ID, rel), { headers: { Origin: 'null' } });
    expect(res.status, rel).toBe(403);
    expect(res.headers.get('access-control-allow-origin'), rel).toBeNull();
  }
});
