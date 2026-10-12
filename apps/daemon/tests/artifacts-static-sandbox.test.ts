// Security regression (audit D1): HTML saved through POST /api/artifacts/save
// is served under /artifacts/. Agent-written HTML opened there must never run
// with the daemon origin, or its script can read the whole /api surface
// same-origin. Every /artifacts response therefore carries a CSP sandbox
// without `allow-same-origin` (opaque origin) and `nosniff`, on a plain
// same-origin navigation too, not only on the cross-site ones the SEC-1
// middleware already covers.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function cspPolicies(headers: http.IncomingHttpHeaders): string[] {
  const value = headers['content-security-policy'];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(/,(?=\s*[a-z-]+\s)/u));
}

function expectOpaqueScriptSandbox(headers: http.IncomingHttpHeaders, label: string): void {
  const policies = cspPolicies(headers);
  expect(
    policies.some((policy) => /(?:^|;)\s*sandbox\b[^;]*\ballow-scripts\b/u.test(policy)),
    `${label}: CSP sandbox allow-scripts (got ${JSON.stringify(policies)})`,
  ).toBe(true);
  expect(
    policies.some((policy) => /(?:^|;)\s*sandbox\b[^;]*allow-same-origin/u.test(policy)),
    `${label}: no allow-same-origin`,
  ).toBe(false);
  expect(headers['x-content-type-options'], `${label}: nosniff`).toBe('nosniff');
}

describe('/artifacts static responses are sandboxed (D1)', () => {
  let server: http.Server;
  let port: number;
  let appHost: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
    server = started.server;
    port = Number(new URL(started.url).port);
    appHost = `127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves HTML saved through /api/artifacts/save with an opaque-origin sandbox', async () => {
    const saved = await rawRequest(port, {
      method: 'POST',
      path: '/api/artifacts/save',
      headers: { host: appHost, 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'd1-probe',
        title: 'D1 probe',
        html: '<!doctype html><script>fetch("/api/health").then((r) => r.text()).then(console.log)</script>',
      }),
    });
    expect(saved.status).toBe(200);
    const { url } = JSON.parse(saved.body) as { url: string };
    expect(url).toMatch(/^\/artifacts\/.+\/index\.html$/u);

    // A same-origin, user-initiated navigation (the user opens the returned
    // url in the app's browser) — the case the cross-site middleware skips.
    for (const site of ['same-origin', 'none']) {
      const res = await rawRequest(port, {
        path: url,
        headers: {
          host: appHost,
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': site,
          'sec-fetch-dest': 'document',
        },
      });
      expect(res.status, site).toBe(200);
      expect(res.headers['content-type'], site).toMatch(/^text\/html/u);
      expectOpaqueScriptSandbox(res.headers, `navigate ${site}`);
    }

    // A non-browser client with no fetch metadata or Accept header.
    const plain = await rawRequest(port, { path: url, headers: { host: appHost } });
    expect(plain.status).toBe(200);
    expectOpaqueScriptSandbox(plain.headers, 'plain GET');
  });

  it('sandboxes other agent-written documents under /artifacts (SVG)', async () => {
    const dir = path.join(process.env.OD_DATA_DIR!, 'artifacts', 'd1-svg');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'evil.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/health")</script></svg>',
    );
    const res = await rawRequest(port, {
      path: '/artifacts/d1-svg/evil.svg',
      headers: { host: appHost, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expectOpaqueScriptSandbox(res.headers, 'svg');
  });
});
