// Security regression suite for the powered-preview origin (SEC-1).
//
// Powered previews run agent-generated HTML in an iframe sandboxed with
// `allow-scripts allow-same-origin`, loaded from the host-swapped loopback
// origin (127.0.0.1 <-> localhost) on the daemon port. That origin is
// untrusted. These tests drive the real daemon over HTTP and assert:
//
// 1. A browser request carrying the powered Origin is refused (403, no
//    Access-Control-Allow-Origin echo) on every Host, for CORS-simple writes
//    (multipart / text/plain POST), private GET reads, preflights, and the
//    routes that run their own loopback CORS (live-artifact preview,
//    workbench intake).
// 2. The powered file route keeps serving the powered origin on the powered
//    host, the app origin, CLI callers (no Origin) and paired browser
//    extensions are unchanged.
// 3. A cross-site browser navigation that lands on daemon-served content on
//    the app host (a nested frame, popup or self-navigation started by a
//    powered document), including OAuth callback pages, or that lands on
//    agent content with no fetch metadata, is forced into an opaque-origin
//    CSP sandbox, so the powered iframe's `allow-same-origin` cannot carry
//    agent HTML onto the app origin. OAuth result pages escape inline JSON.
// 4. An opaque-origin document (for example a srcdoc frame nested inside a
//    powered preview) cannot read raw project files with a script fetch.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isCrossSiteBrowserNavigation,
  isPoweredPreviewOrigin,
  poweredPreviewAuthority,
} from '../src/http/powered-preview-origin.js';
import { serializeJsonForInlineScript } from '../src/http/oauth-result-page.js';
import { startServer } from '../src/server.js';

describe('serializeJsonForInlineScript', () => {
  it('escapes every character that can end the script or break the string', () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const value = { message: `</script><!--&>${lineSeparator}${paragraphSeparator}` };
    const serialized = serializeJsonForInlineScript(value);
    expect(serialized).not.toMatch(/[<>&]/u);
    expect(serialized).not.toContain(lineSeparator);
    expect(serialized).not.toContain(paragraphSeparator);
    expect(JSON.parse(serialized)).toEqual(value);
  });
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers ?? {},
      },
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

function multipartBody(boundary: string, fieldName: string, fileName: string, content: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`
      + 'Content-Type: text/html\r\n\r\n'
      + `${content}\r\n`
      + `--${boundary}--\r\n`,
  );
}

function cspValues(headers: http.IncomingHttpHeaders): string[] {
  const value = headers['content-security-policy'];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(/,(?=\s*[a-z-]+\s)/u));
}

function hasOpaqueSandbox(headers: http.IncomingHttpHeaders): boolean {
  const policies = cspValues(headers);
  return policies.some((policy) => /(?:^|;)\s*sandbox(?:\s|;|$)/u.test(policy))
    && !policies.some((policy) => /(?:^|;)\s*sandbox\b[^;]*allow-same-origin/u.test(policy));
}

describe('isPoweredPreviewOrigin', () => {
  it('derives the swapped loopback authority and nothing else', () => {
    expect(poweredPreviewAuthority('127.0.0.1', 7456)).toEqual({ hostname: 'localhost', port: '7456' });
    expect(poweredPreviewAuthority('localhost', 7456)).toEqual({ hostname: '127.0.0.1', port: '7456' });
    expect(poweredPreviewAuthority('192.168.1.20', 7456)).toBeNull();
    expect(poweredPreviewAuthority('127.0.0.1', 0)).toBeNull();
  });

  it('matches every spelling of the powered origin and only it', () => {
    const authority = poweredPreviewAuthority('127.0.0.1', 7456);
    for (const origin of [
      'http://localhost:7456',
      'https://localhost:7456',
      'http://LOCALHOST:7456',
      'http://localhost.:7456',
      ['http://localhost:7456'],
    ]) {
      expect(isPoweredPreviewOrigin(origin, authority), JSON.stringify(origin)).toBe(true);
    }
    for (const origin of [
      'http://127.0.0.1:7456',
      'http://localhost:17573',
      'null',
      '',
      undefined,
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'not a url',
    ]) {
      expect(isPoweredPreviewOrigin(origin, authority), String(origin)).toBe(false);
    }
    expect(isPoweredPreviewOrigin('http://localhost:7456', null)).toBe(false);
  });

  it('recognizes cross-site and same-site navigations only', () => {
    expect(isCrossSiteBrowserNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(isCrossSiteBrowserNavigation({ 'sec-fetch-mode': 'nested-navigate', 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(isCrossSiteBrowserNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(isCrossSiteBrowserNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' })).toBe(false);
    expect(isCrossSiteBrowserNavigation({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isCrossSiteBrowserNavigation({})).toBe(false);
  });
});

describe('powered preview origin guard (SEC-1)', () => {
  let server: http.Server;
  let port: number;
  let appHost: string;
  let poweredHost: string;
  let appOrigin: string;
  let poweredOrigin: string;
  let projectDir: string;
  const projectId = 'proj-powered-origin-guard';
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
    server = started.server;
    const url = new URL(started.url);
    port = Number(url.port);
    expect(url.hostname).toBe('127.0.0.1');
    appHost = `127.0.0.1:${port}`;
    poweredHost = `localhost:${port}`;
    appOrigin = `http://${appHost}`;
    poweredOrigin = `http://${poweredHost}`;

    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Powered origin guard fixture' }),
    });
    expect(created.status).toBe(200);
    projectDir = path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'page.html'), '<html/>');
    await writeFile(path.join(projectDir, 'evil.html'), '<script>fetch("/api/projects")</script>');

    // Pair a browser extension the way the clipper does (CLI-style calls).
    const pair = await rawRequest(port, { method: 'POST', path: '/api/library/pair', headers: { host: appHost } });
    expect(pair.status).toBe(200);
    const { code } = JSON.parse(pair.body) as { code: string };
    const confirm = await rawRequest(port, {
      method: 'POST',
      path: '/api/library/pair/confirm',
      headers: { host: appHost, 'content-type': 'application/json' },
      body: JSON.stringify({ code, extensionOrigin }),
    });
    expect(confirm.status).toBe(200);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const poweredBrowserHeaders = (extra: Record<string, string> = {}) => ({
    origin: poweredOrigin,
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra,
  });

  describe('requests carrying the powered origin', () => {
    it('refuses a multipart upload to the app host without writing the file', async () => {
      const boundary = '----odpoweredguard';
      const res = await rawRequest(port, {
        method: 'POST',
        path: `/api/projects/${projectId}/upload`,
        headers: poweredBrowserHeaders({
          host: appHost,
          'sec-fetch-mode': 'no-cors',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        }),
        body: multipartBody(boundary, 'files', 'dropped-by-preview.html', '<p>owned</p>'),
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(existsSync(path.join(projectDir, 'dropped-by-preview.html'))).toBe(false);
    });

    it('refuses a text/plain POST to a loopback-CORS route and does not echo the origin', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        path: '/api/library/pair',
        headers: poweredBrowserHeaders({ host: appHost, 'content-type': 'text/plain' }),
        body: 'x',
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.body).not.toContain('"code"');
    });

    it('refuses private GET reads on the app host', async () => {
      for (const route of ['/api/library/connection', '/api/projects']) {
        const res = await rawRequest(port, { path: route, headers: poweredBrowserHeaders({ host: appHost }) });
        expect(res.status, route).toBe(403);
        expect(res.headers['access-control-allow-origin'], route).toBeUndefined();
      }
    });

    it('refuses routes that bypass the shared origin check and run their own loopback CORS', async () => {
      const live = await rawRequest(port, {
        path: `/api/live-artifacts/missing/preview?projectId=${projectId}`,
        headers: poweredBrowserHeaders({ host: appHost }),
      });
      expect(live.status).toBe(403);
      expect(live.headers['access-control-allow-origin']).toBeUndefined();

      const intakePreflight = await rawRequest(port, {
        method: 'OPTIONS',
        path: '/api/workbench/intake/sessions',
        headers: poweredBrowserHeaders({
          host: appHost,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        }),
      });
      expect(intakePreflight.status).toBe(403);
      expect(intakePreflight.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses the powered origin on every Host and loopback spelling', async () => {
      const variants: Array<{ host: string; origin: string }> = [
        { host: poweredHost, origin: poweredOrigin },
        { host: appHost, origin: `https://${poweredHost}` },
        { host: appHost, origin: `http://localhost.:${port}` },
        { host: appHost, origin: `http://LOCALHOST:${port}` },
        { host: `localhost.:${port}`, origin: `http://localhost.:${port}` },
      ];
      for (const variant of variants) {
        const res = await rawRequest(port, {
          method: 'POST',
          path: '/api/library/pair',
          headers: { host: variant.host, origin: variant.origin, 'content-type': 'text/plain' },
          body: 'x',
        });
        expect(res.status, JSON.stringify(variant)).toBe(403);
        expect(res.headers['access-control-allow-origin'], JSON.stringify(variant)).toBeUndefined();
      }
    });

    it('refuses the powered origin reading the powered file route through the app host', async () => {
      const res = await rawRequest(port, {
        path: `/api/projects/${projectId}/powered/page.html`,
        headers: poweredBrowserHeaders({ host: appHost }),
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves powered file bytes to the powered origin on the powered host', async () => {
      const res = await rawRequest(port, {
        path: `/api/projects/${projectId}/powered/page.html`,
        headers: {
          host: poweredHost,
          origin: poweredOrigin,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'script',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe('<html/>');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('legitimate callers are unchanged', () => {
    it('lets the app origin use loopback-CORS and project routes', async () => {
      const pair = await rawRequest(port, {
        method: 'POST',
        path: '/api/library/pair',
        headers: {
          host: appHost,
          origin: appOrigin,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'content-type': 'text/plain',
        },
        body: 'x',
      });
      expect(pair.status).toBe(200);
      expect(pair.headers['access-control-allow-origin']).toBe(appOrigin);

      const list = await rawRequest(port, {
        path: '/api/projects',
        headers: { host: appHost, origin: appOrigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      });
      expect(list.status).toBe(200);
    });

    it('lets CLI callers without an Origin header upload and read', async () => {
      const boundary = '----odcliupload';
      const upload = await rawRequest(port, {
        method: 'POST',
        path: `/api/projects/${projectId}/upload`,
        headers: { host: appHost, 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody(boundary, 'files', 'cli-upload.html', '<p>cli</p>'),
      });
      expect(upload.status).toBe(200);
      expect(existsSync(path.join(projectDir, 'cli-upload.html'))).toBe(true);

      const list = await rawRequest(port, { path: '/api/projects', headers: { host: appHost } });
      expect(list.status).toBe(200);
    });

    it('lets a paired browser extension read its library routes', async () => {
      const paired = await rawRequest(port, {
        path: '/api/library/assets',
        headers: { host: appHost, origin: extensionOrigin, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' },
      });
      expect(paired.status).toBe(200);
      expect(JSON.parse(paired.body)).toHaveProperty('assets');

      const unpaired = await rawRequest(port, {
        path: '/api/library/assets',
        headers: {
          host: appHost,
          origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba',
          'sec-fetch-site': 'none',
          'sec-fetch-mode': 'cors',
        },
      });
      expect(unpaired.status).toBe(403);
    });
  });

  describe('cross-site navigations onto daemon content', () => {
    const navigationHeaders = (host: string, site: string, dest = 'iframe') => ({
      host,
      'sec-fetch-site': site,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': dest,
    });

    it('forces an opaque-origin sandbox on agent HTML reached by a cross-site navigation', async () => {
      const targets = [
        `/api/projects/${projectId}/raw/evil.html`,
        `/api/projects/${projectId}/powered/evil.html`,
      ];
      for (const target of targets) {
        for (const site of ['cross-site', 'same-site']) {
          for (const dest of ['iframe', 'document']) {
            const res = await rawRequest(port, { path: target, headers: navigationHeaders(appHost, site, dest) });
            expect(res.status, `${target} ${site} ${dest}`).toBe(200);
            expect(hasOpaqueSandbox(res.headers), `${target} ${site} ${dest}`).toBe(true);
          }
        }
      }
    });

    it('forces the sandbox on daemon static artifacts reached cross-site', async () => {
      const artifactsDir = path.join(process.env.OD_DATA_DIR!, 'artifacts', 'sec1-guard');
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(path.join(artifactsDir, 'evil.html'), '<script>fetch("/api/projects")</script>');
      const res = await rawRequest(port, {
        path: '/artifacts/sec1-guard/evil.html',
        headers: navigationHeaders(appHost, 'cross-site'),
      });
      expect(res.status).toBe(200);
      expect(hasOpaqueSandbox(res.headers)).toBe(true);
    });

    it('leaves same-origin and user-initiated navigations untouched', async () => {
      for (const site of ['same-origin', 'none']) {
        const res = await rawRequest(port, {
          path: `/api/projects/${projectId}/raw/evil.html`,
          headers: navigationHeaders(appHost, site),
        });
        expect(res.status, site).toBe(200);
        expect(res.headers['content-security-policy'], site).toBeUndefined();
      }
    });

    it('keeps the powered document on the powered host same-origin capable', async () => {
      const res = await rawRequest(port, {
        path: `/api/projects/${projectId}/powered/page.html`,
        headers: navigationHeaders(poweredHost, 'cross-site'),
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['document-isolation-policy']).toBe('isolate-and-credentialless');
    });

    it('sandboxes the OAuth callback page when a preview navigates to it', async () => {
      // A powered preview can aim a nested frame at the callback with an
      // attacker-chosen error. The page must not run that text as script,
      // and it must not render with the app origin either.
      const payload = '</script><script>parent.__owned=1</script>\u2028\u2029&<!--';
      const res = await rawRequest(port, {
        path: `/api/mcp/oauth/callback?error=${encodeURIComponent(payload)}`,
        headers: navigationHeaders(appHost, 'cross-site', 'iframe'),
      });
      expect(res.status).toBe(400);
      expect(hasOpaqueSandbox(res.headers)).toBe(true);
    });

    it('keeps an attacker-chosen OAuth error inside the inline JSON', async () => {
      const payload = '</script><script>parent.__owned=1</script>\u2028\u2029&<!--';
      const res = await rawRequest(port, {
        path: `/api/mcp/oauth/callback?error=${encodeURIComponent(payload)}`,
        headers: { host: appHost },
      });
      expect(res.status).toBe(400);
      const scripts = res.body.match(/<script\b[^>]*>[\s\S]*?<\/script>/giu) ?? [];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).not.toContain('__owned=1</script>');
      expect(scripts[0]).not.toMatch(/[\u2028\u2029]/u);
      expect(res.body).not.toContain('<script>parent.__owned');
    });

    it('fails closed when fetch metadata is absent on agent HTML navigations', async () => {
      const browserNavigation = { host: appHost, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
      for (const target of [
        `/api/projects/${projectId}/raw/evil.html`,
        `/api/projects/${projectId}/powered/evil.html`,
        '/artifacts/sec1-guard/evil.html',
      ]) {
        const res = await rawRequest(port, { path: target, headers: browserNavigation });
        expect(res.status, target).toBe(200);
        expect(hasOpaqueSandbox(res.headers), target).toBe(true);
      }

      // The powered document on its own host keeps its origin.
      const powered = await rawRequest(port, {
        path: `/api/projects/${projectId}/powered/page.html`,
        headers: { ...browserNavigation, host: poweredHost },
      });
      expect(powered.status).toBe(200);
      expect(powered.headers['content-security-policy']).toBeUndefined();

      // Non-browser reads (CLI, API clients) stay byte-for-byte unchanged.
      const cli = await rawRequest(port, {
        path: `/api/projects/${projectId}/raw/evil.html`,
        headers: { host: appHost },
      });
      expect(cli.status).toBe(200);
      expect(cli.headers['content-security-policy']).toBeUndefined();
    });
  });

  describe('opaque-origin (Origin: null) documents', () => {
    const otherProjectId = 'proj-powered-origin-guard-other';

    beforeAll(async () => {
      const created = await rawRequest(port, {
        method: 'POST',
        path: '/api/projects',
        headers: { host: appHost, 'content-type': 'application/json' },
        body: JSON.stringify({ id: otherProjectId, name: 'Other project' }),
      });
      expect(created.status).toBe(200);
      const dir = path.join(process.env.OD_DATA_DIR!, 'projects', otherProjectId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'secret.json'), '{"secret":true}');
    });

    it('cannot read raw project files with a script fetch', async () => {
      for (const dest of ['empty', undefined]) {
        const headers: Record<string, string> = {
          host: appHost,
          origin: 'null',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'cors',
        };
        if (dest) headers['sec-fetch-dest'] = dest;
        const res = await rawRequest(port, { path: `/api/projects/${otherProjectId}/raw/secret.json`, headers });
        expect(res.headers['access-control-allow-origin'], String(dest)).toBeUndefined();
      }
    });

    it('gets no CORS grant from a raw-file preflight', async () => {
      const res = await rawRequest(port, {
        method: 'OPTIONS',
        path: `/api/projects/${otherProjectId}/raw/secret.json`,
        headers: {
          host: appHost,
          origin: 'null',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-anything',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('is refused on non-preview API paths', async () => {
      const res = await rawRequest(port, {
        path: '/api/projects',
        headers: { host: appHost, origin: 'null', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it("cannot load another project's JS module or CSS through raw", async () => {
      const dir = path.join(process.env.OD_DATA_DIR!, 'projects', otherProjectId);
      await writeFile(path.join(dir, 'data.js'), 'export const secret = 42;');
      await writeFile(path.join(dir, 'theme.css'), '.secret { color: red; }');
      for (const [file, dest] of [['data.js', 'script'], ['theme.css', 'style'], ['data.js', 'font']] as const) {
        const res = await rawRequest(port, {
          path: `/api/projects/${otherProjectId}/raw/${file}`,
          headers: {
            host: appHost,
            origin: 'null',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': dest,
          },
        });
        expect(res.headers['access-control-allow-origin'], `${file} ${dest}`).toBeUndefined();
      }
    });

    it('loads preview subresources through the scoped preview capability', async () => {
      const urlRes = await rawRequest(port, {
        path: `/api/projects/${projectId}/preview-url?file=page.html`,
        headers: { host: appHost },
      });
      expect(urlRes.status).toBe(200);
      const { url } = JSON.parse(urlRes.body) as { url: string };
      const scopeDir = url.slice(0, url.lastIndexOf('/') + 1);
      await writeFile(path.join(projectDir, 'module.js'), 'export const ok = true;');
      const res = await rawRequest(port, {
        path: `${scopeDir}module.js`,
        headers: {
          host: appHost,
          origin: 'null',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'script',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('gives embedded raw frames the scoped base so their assets avoid raw', async () => {
      const res = await rawRequest(port, {
        path: `/api/projects/${projectId}/raw/page.html`,
        headers: {
          host: appHost,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'iframe',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatch(
        new RegExp(`<base href="/api/projects/${projectId}/preview/[A-Za-z0-9_-]+/" data-od-project-preview-base>`, 'u'),
      );

      // A plain raw read (download, code view, API client) keeps its bytes.
      const plain = await rawRequest(port, {
        path: `/api/projects/${projectId}/raw/page.html`,
        headers: { host: appHost },
      });
      expect(plain.body).toBe('<html/>');
    });
  });
});
