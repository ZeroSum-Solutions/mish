// DNS-rebinding regression suite. A page on `attacker.example` whose name
// re-resolves to 127.0.0.1 is same-origin with itself, so its GETs reach the
// daemon without an Origin header. The daemon must refuse them by Host (or by
// the Host the web sidecar relays in X-OD-Client-Host), while the web UI,
// desktop shell and CLI callers keep working.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('DNS rebinding host guard', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
    server = started.server;
    port = Number(new URL(started.url).port);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const sameOriginFetch = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

  it('refuses a rebound same-origin GET that carries no Origin header', async () => {
    for (const headers of [
      // Plain http: no Origin and no fetch metadata on a same-origin GET.
      { host: `attacker.example:${port}` },
      { host: `attacker.example:${port}`, ...sameOriginFetch },
    ]) {
      const res = await rawRequest(port, { path: '/api/projects', headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body).toContain('request host is not allowed');
    }
  });

  it('refuses a rebound request relayed by the web sidecar', async () => {
    const res = await rawRequest(port, {
      path: '/api/projects',
      headers: { host: `127.0.0.1:${port}`, 'x-od-client-host': 'attacker.example:17573', ...sameOriginFetch },
    });
    expect(res.status).toBe(403);
  });

  it('serves the web UI on loopback hosts, directly and through the sidecar', async () => {
    for (const headers of [
      { host: `127.0.0.1:${port}`, ...sameOriginFetch },
      // `localhost:<daemon port>` is the powered-preview authority, refused by its own guard.
      { host: `127.0.0.1:${port}`, 'x-od-client-host': '127.0.0.1:17573', ...sameOriginFetch },
      { host: `127.0.0.1:${port}`, 'x-od-client-host': 'localhost:17573', ...sameOriginFetch },
      { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...sameOriginFetch },
    ]) {
      const res = await rawRequest(port, { path: '/api/projects', headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it('leaves CLI callers on loopback unchanged', async () => {
    const res = await rawRequest(port, { path: '/api/projects', headers: { host: `127.0.0.1:${port}` } });
    expect(res.status).toBe(200);
    const health = await rawRequest(port, { path: '/api/health', headers: { host: `localhost:${port}` } });
    expect(health.status).toBe(200);
  });
});
