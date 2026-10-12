// Red spec for audit f13f14-r2 BLOCK: licensed Cult UI Pro source reached LAN clients through
// Next's own dev rewrite proxy.
//
// `/API/...` (any case) missed the sidecar's case-sensitive daemon-path check, fell through to Next,
// and Next's case-insensitive `/api/:path*` rewrite proxied it to the daemon itself: no
// X-Forwarded-For, and X-Forwarded-Host copied from whatever Host the client sent. Plain `next dev`
// (no sidecar) leaked the same way for `/api/...`.
//
// This runs the real sidecar handler in front of a real `next({ dev: true })` server that carries
// apps/web's own dev rewrites, both bound to a LAN interface. The daemon stand-in decides with
// `cultLocalOnlyRefusal` from @mish/contracts, the exact rule the daemon's cult routes use.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cultLocalOnlyRefusal } from '@mish/contracts';

import { createDaemonProxyHandler } from '../sidecar/server';

const LAN = Object.values(networkInterfaces()).flat().find((entry) => entry != null && entry.family === 'IPv4' && !entry.internal)?.address;
const SOURCE = 'LICENSED-SOURCE-MARKER';
const WEB_ROOT = path.resolve(__dirname, '..');

type NextApp = { prepare(): Promise<void>; close?(): Promise<void>; getRequestHandler(): (req: never, res: never) => Promise<void> };

const servers: HttpServer[] = [];
const seen: IncomingHttpHeaders[] = [];
let daemonPort = 0;
let nextApp: NextApp | null = null;
let nextDir = '';

async function listen(server: HttpServer, host: string): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  return (server.address() as AddressInfo).port;
}

function get(port: number, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: LAN, port, path: pathname, headers, localAddress: LAN }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(LAN === undefined)('licensed source over the LAN, through the sidecar and Next dev', () => {
  beforeAll(async () => {
    daemonPort = await listen(createHttpServer((req, res) => {
      seen.push(req.headers);
      const header = (name: string) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value;
      };
      const refusal = cultLocalOnlyRefusal({ peer: req.socket.remoteAddress, header });
      res.statusCode = refusal === null ? 200 : 403;
      res.end(refusal === null ? SOURCE : JSON.stringify({ error: { code: 'FORBIDDEN', message: refusal } }));
    }), '127.0.0.1');

    // apps/web's own dev rewrites, pointed at the stand-in daemon.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OD_PORT', String(daemonPort));
    vi.resetModules();
    const config = (await import('../next.config')).default as { rewrites?: () => Promise<unknown> };
    vi.unstubAllEnvs();
    expect(typeof config.rewrites).toBe('function');

    // A throwaway app dir inside apps/web (git-ignored .tmp/) so Next resolves react from here.
    mkdirSync(path.join(WEB_ROOT, '.tmp'), { recursive: true });
    nextDir = mkdtempSync(path.join(WEB_ROOT, '.tmp', 'cult-lan-next-'));
    // Next dev can still finish queued directory reads after close() resolves.
    // Keep this owned fixture until the Vitest fork exits, so teardown cannot
    // turn those reads into unrelated unhandled ENOENT rejections. Cleanup is
    // best effort on graceful exit; forced worker termination leaves it in
    // ignored .tmp (the ephemeral CI VM discards it after the job).
    const fixtureDir = nextDir;
    process.once('exit', () => rmSync(fixtureDir, { recursive: true, force: true }));
    mkdirSync(path.join(nextDir, 'app'));
    writeFileSync(path.join(nextDir, 'app', 'layout.js'), 'export default function L({ children }) { return children; }\n');
    writeFileSync(path.join(nextDir, 'app', 'page.js'), 'export default function P() { return null; }\n');
    // Next's dev router reads the config file from its dir, so write apps/web's rewrites there verbatim.
    const rewrites = await config.rewrites!();
    writeFileSync(path.join(nextDir, 'next.config.mjs'), `export default { async rewrites() { return ${JSON.stringify(rewrites)}; } };\n`);
    const createNext = createRequire(path.join(WEB_ROOT, 'package.json'))('next') as (options: object) => NextApp;
    nextApp = createNext({ dev: true, dir: nextDir, webpack: true });
    await nextApp.prepare();
  }, 120_000);

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await nextApp?.close?.();
  }, 60_000);

  it('the sidecar proxies /API and /Api itself, names the LAN client, and the source is refused', async () => {
    const handle = nextApp!.getRequestHandler() as never;
    const port = await listen(createHttpServer(createDaemonProxyHandler(`http://127.0.0.1:${daemonPort}`, handle)), LAN!);
    seen.length = 0;
    for (const pathname of ['/API/cult/r/pricing-shelf.json', '/Api/cult/copy/cult:pricing-shelf', '/api/cult/r/pricing-shelf.json']) {
      const res = await get(port, pathname, { host: `localhost:${port}`, 'x-forwarded-for': '127.0.0.1' });
      expect(res.status, pathname).toBe(403);
      expect(res.body, pathname).not.toContain(SOURCE);
    }
    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(headers['x-forwarded-for']).toBe(`127.0.0.1, ${LAN}`);
      expect(headers['x-forwarded-host']).toBeUndefined();
    }
  }, 60_000);

  it('plain Next dev (no sidecar) relays a spoofed Host, and the source is refused', async () => {
    const handle = nextApp!.getRequestHandler();
    const port = await listen(createHttpServer((req, res) => void handle(req as never, res as never)), LAN!);
    seen.length = 0;
    for (const pathname of ['/api/cult/r/pricing-shelf.json', '/API/cult/r/pricing-shelf.json', '/Api/cult/copy/cult:pricing-shelf']) {
      const res = await get(port, pathname, { host: `localhost:${port}`, 'x-forwarded-for': '127.0.0.1' });
      expect(res.status, pathname).toBe(403);
      expect(res.body, pathname).not.toContain(SOURCE);
    }
    // Next's rewrite did reach the daemon: this is the path the route itself must refuse.
    expect(seen).toHaveLength(3);
    for (const headers of seen) expect(headers['x-forwarded-host']).toBe(`localhost:${port}`);
  }, 60_000);
});
