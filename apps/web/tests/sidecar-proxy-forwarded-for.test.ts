// Red spec for audit f13 finding 1: the web sidecar proxy made LAN requests look local.
//
// The sidecar proxies /api to the daemon from its own loopback socket, with the daemon's Host and
// (for a same-host LAN page) the daemon's own Origin. Before this fix it sent no X-Forwarded-For,
// so the daemon's loopback-only routes (the licensed Cult UI Pro source, GET /api/cult/r/*) saw a
// loopback peer, Host and Origin for a phone on the LAN and served it. The daemon half of the
// check — any non-loopback hop in X-Forwarded-For is refused — is covered with exactly the header
// shape asserted here in apps/daemon/tests/cult-registry-routes.test.ts.
//
// This drives the real `createDaemonProxyHandler` bound to a non-loopback interface address and
// requests it from that address, so the proxy's client is genuinely not loopback.

import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { appendForwardedFor, createDaemonProxyHandler } from '../sidecar/server';

const LAN_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry != null && entry.family === 'IPv4' && !entry.internal)?.address;

// The proxy only rewrites a same-host Origin to the daemon's for loopback/private-LAN hosts
// (`isLoopbackOrPrivateLanHost` in sidecar/server.ts). A host whose only external interface is
// outside those ranges (e.g. a CI sandbox on 192.0.2.0/24) keeps its Origin untouched.
function isPrivateLanIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function listen(server: HttpServer, host: string): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/** A daemon stand-in that records the headers of every request it receives. */
async function startRecordingDaemon(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const port = await listen(createHttpServer((request, response) => {
    seen.push(request.headers);
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  }), '127.0.0.1');
  return { port, seen };
}

async function startProxy(daemonPort: number, host: string): Promise<number> {
  return listen(createHttpServer(createDaemonProxyHandler(`http://127.0.0.1:${daemonPort}`, async (_request, response) => {
    response.statusCode = 404;
    response.end('fallback');
  })), host);
}

describe('sidecar daemon proxy X-Forwarded-For', () => {
  it.skipIf(LAN_ADDRESS === undefined)('names a LAN client in X-Forwarded-For, even with a same-host LAN Origin', async () => {
    const daemon = await startRecordingDaemon();
    const proxyPort = await startProxy(daemon.port, LAN_ADDRESS!);
    const origin = `http://${LAN_ADDRESS}:${proxyPort}`;

    const plain = await fetch(`${origin}/api/cult/r/pricing-shelf.json`);
    expect(plain.status).toBe(200);
    const withOrigin = await fetch(`${origin}/api/cult/copy/cult:pricing-shelf`, { headers: { origin } });
    expect(withOrigin.status).toBe(200);

    expect(daemon.seen).toHaveLength(2);
    for (const headers of daemon.seen) {
      // Everything else the daemon sees looks local; the forwarded hop is what tells the truth.
      expect(headers.host).toBe(`127.0.0.1:${daemon.port}`);
      expect(headers['x-forwarded-for']).toBe(LAN_ADDRESS);
    }
    expect(daemon.seen[1]!.origin).toBe(
      isPrivateLanIpv4(LAN_ADDRESS!) ? `http://127.0.0.1:${daemon.port}` : origin,
    );
  });

  it('keeps a client-sent chain and appends the real peer, so a spoofed loopback hop cannot hide it', async () => {
    const daemon = await startRecordingDaemon();
    const proxyPort = await startProxy(daemon.port, '127.0.0.1');
    await fetch(`http://127.0.0.1:${proxyPort}/api/health`, { headers: { 'x-forwarded-for': '127.0.0.1, 10.1.2.3' } });
    await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
    expect(daemon.seen.map((headers) => headers['x-forwarded-for'])).toEqual(['127.0.0.1, 10.1.2.3, 127.0.0.1', '127.0.0.1']);
  });

  it('records an unknown peer as unknown', () => {
    expect(appendForwardedFor(undefined, undefined)).toBe('unknown');
    expect(appendForwardedFor(['a, b', 'c'], '::1')).toBe('a, b, c, ::1');
  });
});
