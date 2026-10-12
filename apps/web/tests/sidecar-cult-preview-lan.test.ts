// Live preview over the LAN: the preview routes render licensed source, so a LAN browser must be
// refused through the real web sidecar exactly as the copy routes are.
//
// This drives the real `createDaemonProxyHandler` bound to a LAN interface and requests the
// preview info and frame routes from that address, and from loopback for the served case. The
// daemon stand-in decides with `cultLocalOnlyRefusal` from @mish/contracts, the rule
// apps/daemon/src/routes/cult-live-preview.ts applies (its own tests drive that route with a real
// LAN peer and with the header shape this proxy sends).

import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { CULT_CLIENT_HOST_HEADER, cultLocalOnlyRefusal, cultPreviewFrameUrl, cultPreviewInfoUrl } from '@mish/contracts';

import { createDaemonProxyHandler } from '../sidecar/server';

const LAN = Object.values(networkInterfaces()).flat().find((entry) => entry != null && entry.family === 'IPv4' && !entry.internal)?.address;
const SOURCE = 'LICENSED-PREVIEW-MARKER';
const PATHS = [
  cultPreviewInfoUrl('cult:glow-badge'),
  cultPreviewFrameUrl('cult:glow-badge', 'dark'),
  cultPreviewFrameUrl('cult:hero-glow'),
  '/API/cult/preview/cult:hero-glow/frame',
];

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

async function startDaemon(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const port = await listen(createHttpServer((req, res) => {
    seen.push(req.headers);
    const header = (name: string) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : value;
    };
    const refusal = cultLocalOnlyRefusal({ peer: req.socket.remoteAddress, header });
    res.statusCode = refusal === null ? 200 : 403;
    res.end(refusal === null ? SOURCE : JSON.stringify({ error: { code: 'FORBIDDEN', message: refusal } }));
  }), '127.0.0.1');
  return { port, seen };
}

async function startSidecar(daemonPort: number, host: string): Promise<number> {
  return listen(createHttpServer(createDaemonProxyHandler(`http://127.0.0.1:${daemonPort}`, async (_req, res) => {
    res.statusCode = 404;
    res.end('fallback');
  })), host);
}

function get(host: string, port: number, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: pathname, headers, localAddress: host }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('live preview routes through the web sidecar', () => {
  it.skipIf(LAN === undefined)('refuses a LAN browser, even one that sends a loopback Host and a spoofed loopback hop', async () => {
    const daemon = await startDaemon();
    const port = await startSidecar(daemon.port, LAN!);
    for (const pathname of PATHS) {
      const res = await get(LAN!, port, pathname, { host: `localhost:${port}`, 'x-forwarded-for': '127.0.0.1' });
      expect(res.status, pathname).toBe(403);
      expect(res.body, pathname).not.toContain(SOURCE);
      expect(res.body, pathname).toContain('a forwarded client is not loopback');
    }
    expect(daemon.seen).toHaveLength(PATHS.length);
    for (const headers of daemon.seen) expect(headers['x-forwarded-for']).toBe(`127.0.0.1, ${LAN}`);
  });

  it('refuses a page on this machine that DNS-rebinds its own name to loopback, whatever it claims', async () => {
    const daemon = await startDaemon();
    const port = await startSidecar(daemon.port, '127.0.0.1');
    for (const pathname of PATHS) {
      const res = await get('127.0.0.1', port, pathname, { host: `evil.example:${port}`, [CULT_CLIENT_HOST_HEADER]: `localhost:${port}` });
      expect(res.status, pathname).toBe(403);
      expect(res.body, pathname).not.toContain(SOURCE);
      expect(res.body, pathname).toContain('the browser asked the web proxy for a host that is not loopback');
    }
    // The daemon sees its own Host; the client's travels in the header the sidecar overwrote.
    for (const headers of daemon.seen) {
      expect(headers.host).toBe(`127.0.0.1:${daemon.port}`);
      expect(headers[CULT_CLIENT_HOST_HEADER]).toBe(`evil.example:${port}`);
    }
  });

  it('serves a browser on this machine', async () => {
    const daemon = await startDaemon();
    const port = await startSidecar(daemon.port, '127.0.0.1');
    for (const pathname of PATHS) {
      const res = await get('127.0.0.1', port, pathname, { host: `localhost:${port}` });
      expect(res.status, pathname).toBe(200);
      expect(res.body, pathname).toBe(SOURCE);
    }
  });
});
