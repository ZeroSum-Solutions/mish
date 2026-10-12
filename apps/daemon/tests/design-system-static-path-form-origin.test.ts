// Path-form package URLs (/api/design-systems/:id/static/<path>) must meet
// the same real /api origin middleware as the query form: a sandboxed
// (`Origin: null`) font request reaches the route's OFL provenance check in
// both forms, and nothing else is opened to opaque origins.
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

const originalDataDir = process.env.OD_DATA_DIR;
let dataDir = '';
let started: StartedServer | null = null;
const ID = encodeURIComponent('user:origin-kit');

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'od-ds-path-form-origin-'));
  const kit = join(dataDir, 'design-systems', 'origin-kit');
  await mkdir(join(kit, 'fonts', 'display'), { recursive: true });
  await mkdir(join(kit, 'system'), { recursive: true });
  await writeFile(join(kit, 'manifest.json'), JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id: 'origin-kit',
    name: 'Origin kit',
    category: 'Test',
    files: { design: 'DESIGN.md', tokens: 'tokens.css' },
    fonts: [{ family: 'Display', file: 'fonts/display/Display.woff2' }],
  }));
  await writeFile(join(kit, 'DESIGN.md'), '# Origin kit\n');
  await writeFile(join(kit, 'tokens.css'), ':root{--bg:#fff}');
  await writeFile(join(kit, 'MOTION.json'), '{"motion":"none"}');
  await writeFile(join(kit, 'system', 'kit.html'), '<!doctype html><html><head></head><body>kit</body></html>');
  // Unlicensed bytes: no provenance file, so opaque origins must be refused
  // by the route's provenance check, not by the middleware.
  await writeFile(join(kit, 'fonts', 'display', 'Display.woff2'), 'wOF2-unlicensed');
  process.env.OD_DATA_DIR = dataDir;
  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as StartedServer;
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
  if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
  else process.env.OD_DATA_DIR = originalDataDir;
  vi.resetModules();
}, 30_000);

const PROVENANCE_ERROR = 'Sandbox font access requires matching OFL bundle provenance';

it('sends Origin: null font reads in both forms to the same provenance check', async () => {
  const query = `${started!.url}/api/design-systems/${ID}/static?path=${encodeURIComponent('fonts/display/Display.woff2')}`;
  const pathForm = `${started!.url}/api/design-systems/${ID}/static/fonts/display/Display.woff2`;
  for (const url of [query, pathForm]) {
    const opaque = await fetch(url, { headers: { Origin: 'null' } });
    expect(opaque.status, url).toBe(403);
    expect(await opaque.json(), url).toEqual({ error: PROVENANCE_ERROR });
    expect(opaque.headers.get('access-control-allow-origin'), url).toBeNull();

    const local = await fetch(url);
    expect(local.status, url).toBe(200);
    expect(local.headers.get('x-content-type-options'), url).toBe('nosniff');
    expect(await local.text(), url).toBe('wOF2-unlicensed');
  }
});

// Pinned on purpose. A kit page rendered as srcdoc in the sandboxed native
// viewer has an opaque origin, so its own fetch('../MOTION.json') arrives with
// `Origin: null` and is refused — exactly as main refuses the query form. Any
// website can send `Origin: null` from a sandboxed iframe of its own, so
// opening it to package files would let any page read a user's local kit
// through the loopback daemon. Fonts pass only with OFL provenance. A real fix
// proxies kit reads through the web host or gives the viewer a same-origin
// iframe src; until then this stays closed.
it('keeps kit JSON closed to opaque origins in both forms (srcdoc kit fetches stay 403)', async () => {
  for (const url of [
    `${started!.url}/api/design-systems/${ID}/static/MOTION.json`,
    `${started!.url}/api/design-systems/${ID}/static?path=MOTION.json`,
  ]) {
    const opaque = await fetch(url, { headers: { Origin: 'null' } });
    expect(opaque.status, url).toBe(403);
    expect(await opaque.json(), url).toEqual({ error: 'Origin: null not allowed for this route' });
    expect(opaque.headers.get('access-control-allow-origin'), url).toBeNull();
  }
});

it('keeps non-font path-form reads closed to opaque origins', async () => {
  for (const rel of ['system/kit.html', 'tokens.css', 'fonts/..%2Fsystem%2Fkit.woff2']) {
    const res = await fetch(`${started!.url}/api/design-systems/${ID}/static/${rel}`, { headers: { Origin: 'null' } });
    expect(res.status, rel).toBe(403);
    expect(await res.json(), rel).toEqual({ error: 'Origin: null not allowed for this route' });
    expect(res.headers.get('x-content-type-options'), rel).toBe('nosniff');
  }
});
