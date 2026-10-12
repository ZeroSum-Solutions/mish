// R07 round 3 (Sol r2 BLOCK): a preview can navigate its own frame (meta
// refresh, `location` assignment) to an /api route and replace its srcdoc
// with a document that lacks the preview floor policy. The daemon, which the
// preview cannot bypass, refuses a frame or document navigation to /api that
// another site started (Sec-Fetch-Site cross-site or same-site; sandboxed
// opaque-origin frames report cross-site), except the navigation routes
// that are meant to be framed or reached that way: OAuth callbacks, the
// scoped project preview base, raw and powered project documents, and the
// preview document routes. SEC-1's guards stay as they are.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findBrowserExecutable } from '../src/browser-sessions.js';
import { startServer } from '../src/server.js';
import { CdpPipe } from '../src/workbench/review/cdp-pipe.js';

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function rawRequest(port: number, options: { path: string; headers?: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: options.path, headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const projectId = 'proj-api-navigation-guard';
let server: http.Server;
let port: number;
let base: string;

beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
  server = started.server;
  base = started.url;
  port = Number(new URL(started.url).port);
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'API navigation guard fixture' }),
  });
  expect(created.status).toBe(200);
  const projectDir = path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'legit.html'), '<!doctype html><title>legit</title><p id="legit">legit preview page</p>');
  // Three sandboxed srcdoc previews (opaque origin, as the workbench renders them): two try to
  // replace themselves with /api JSON, one follows a link to another project page.
  await writeFile(path.join(projectDir, 'host.html'), [
    '<!doctype html><html><body>',
    `<iframe name="meta" sandbox="allow-scripts" srcdoc="<meta http-equiv='refresh' content='0;url=/api/projects'>"></iframe>`,
    `<iframe name="script" sandbox="allow-scripts" srcdoc="<script>location.href='/api/projects'</script>"></iframe>`,
    `<iframe name="page" sandbox="allow-scripts" srcdoc="<script>location.href='/api/projects/${projectId}/raw/legit.html'</script>"></iframe>`,
    '</body></html>',
  ].join(''));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const navigation = (site: string, dest = 'iframe') => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': dest });

describe('R07 round 3: frame and document navigations to /api started by another site', () => {
  it('refuses a cross-site or same-site navigation to an API route, in a frame or as a document, without its JSON', async () => {
    for (const target of ['/api/projects', `/api/projects/${projectId}`, '/api/app-config', `/api/projects/${projectId}/files`]) {
      for (const site of ['cross-site', 'same-site']) {
        for (const dest of ['iframe', 'frame', 'document']) {
          const res = await rawRequest(port, { path: target, headers: navigation(site, dest) });
          expect(res.status, `${target} ${site} ${dest}`).toBe(403);
          expect(res.body, `${target} ${site} ${dest}`).not.toContain(projectId);
          expect(res.headers['content-type'], `${target} ${site} ${dest}`).toMatch(/^text\/plain/u);
        }
      }
    }
  });

  it('keeps same-origin, user-initiated and non-browser requests, and cross-site fetches, as they were', async () => {
    for (const site of ['same-origin', 'none']) {
      const res = await rawRequest(port, { path: '/api/projects', headers: navigation(site, 'document') });
      expect(res.status, site).toBe(200);
      expect(res.body, site).toContain(projectId);
    }
    expect((await rawRequest(port, { path: '/api/projects', headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    // A cross-site fetch is not a navigation: the existing origin guard decides it, unchanged.
    const cors = await rawRequest(port, { path: '/api/projects', headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
    expect(cors.status).toBe(200);
  });

  it('still lets the preview and callback routes load when a frame navigates to them cross-site', async () => {
    const page = await rawRequest(port, { path: `/api/projects/${projectId}/raw/legit.html`, headers: navigation('cross-site') });
    expect(page.status).toBe(200);
    expect(page.body).toContain('legit preview page');
    // The OAuth callback answers (400 for a provider error) rather than being refused.
    const callback = await rawRequest(port, { path: '/api/mcp/oauth/callback?error=access_denied', headers: navigation('cross-site', 'document') });
    expect(callback.status).toBe(400);
    const connector = await rawRequest(port, { path: '/api/connectors/oauth/callback/example?error=access_denied', headers: navigation('cross-site', 'document') });
    expect(connector.status).not.toBe(403);
  });
});

const browserExecutable = findBrowserExecutable();
const browserOptedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1' && browserExecutable !== null;

describe.skipIf(!browserOptedIn)('R07 round 3 in a real headless browser', () => {
  it('a sandboxed preview that refreshes or assigns location to /api never shows the API JSON; a project page still loads', async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'od-nav-guard-'));
    const child = spawn(browserExecutable!, [
      ...(process.env.OD_REVIEW_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-gpu',
      // Keep the sandboxed frames in the page's process so Page.getFrameTree lists them; fetch metadata is unaffected.
      '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,IsolateSandboxedIframes', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url: `${base}/api/projects/${projectId}/raw/host.html` }, sessionId);
      await new Promise(resolve => setTimeout(resolve, 3000));
      const tree = await cdp.send('Page.getFrameTree', {}, sessionId) as { frameTree: { childFrames?: { frame: { id: string; name?: string; url: string } }[] } };
      const frames = new Map((tree.frameTree.childFrames ?? []).map(child => [child.frame.name ?? '', child.frame]));
      const textOf = async (frameId: string) => {
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'nav-guard' }, sessionId) as { executionContextId: number };
        const result = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement ? document.documentElement.innerText : ""', contextId: executionContextId, returnByValue: true }, sessionId) as { result: { value?: string } };
        return String(result.result.value ?? '');
      };
      for (const name of ['meta', 'script']) {
        const frame = frames.get(name);
        expect(frame, name).toBeDefined();
        const text = await textOf(frame!.id);
        expect(text, `${name} frame at ${frame!.url}`).not.toContain(projectId);
        expect(text, `${name} frame at ${frame!.url}`).not.toMatch(/"projects"\s*:/u);
      }
      const page = frames.get('page');
      expect(page?.url).toContain('/raw/legit.html');
      expect(await textOf(page!.id)).toContain('legit preview page');
    } finally {
      cdp.close();
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
});
