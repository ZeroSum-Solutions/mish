// Live preview: GET /api/cult/preview/:id and GET /api/cult/preview/:id/frame.
//
// Mounted on a bare Express app with a throwaway kit (a converted section) and a throwaway preview
// harness (a tiny server.mjs speaking the real harness protocol), started through the real
// `CultPreviewHarness` launcher. The local-only rule is checked with raw requests (spoofed Host,
// sidecar-shaped forwarding headers) and from a real LAN peer when this machine has one. A last
// pass checks every section and page row of the shipped inventory against the real kit, when this
// machine has it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseCultPreviewInfoResponse } from '@mish/contracts';
import { COMPOSED_PAGE_CSP } from '@mish/agency-fast-lane/block-compose';
import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import { convertedDir, convertedPreviewHtml, convertedPreviewMockNote, CultHarnessUnavailable, CultPreviewHarness, fillConvertedTemplate, harnessEnv } from '../src/cult-live-preview.js';
import { resolveCultKitDir } from '../src/cult-registry.js';
import { cultSlugs } from '../src/routes/cult-registry.js';
import { CULT_CONVERTED_DOCUMENT_CSP, CULT_CONVERTED_FRAME_CSP, CULT_HARNESS_FRAME_CSP, registerCultLivePreviewRoutes, type CultPreviewRow } from '../src/routes/cult-live-preview.js';

const LAN = Object.values(networkInterfaces()).flat().find((entry) => entry != null && entry.family === 'IPv4' && !entry.internal)?.address;

const ROWS: CultPreviewRow[] = [
  { id: 'cult:hero-glow', name: 'hero-glow', assetKind: 'section' },
  { id: 'cult:no-convert', name: 'no-convert', assetKind: 'page' },
  { id: 'cult:glow-badge', name: 'glow-badge', assetKind: 'primitive' },
  { id: 'cult:chat-app', name: 'chat-app', assetKind: 'app' },
  { id: 'cult:brand-app', name: 'brand-app', assetKind: 'app' },
];

/** Public slugs: the web and CLI address rows by these; internal names stay aliases. */
const SLUGS = new Map([
  ['cult:hero-glow', 'hero-series-g'],
  ['cult:no-convert', 'no-convert'],
  ['cult:glow-badge', 'glow-badge'],
  ['cult:chat-app', 'chat-app'],
]);

// A stand-in harness speaking the real protocol: healthz, token-gated info and page.
const FAKE_HARNESS = `
import { createServer } from "node:http";
const token = process.env.CULT_PREVIEW_TOKEN;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (url.pathname === "/healthz") return send(200, "application/json", JSON.stringify({ ok: true, app: "cult-ui-pro-preview", version: "t", pid: process.pid }));
  if (req.headers["x-cult-preview-token"] !== token) return send(401, "application/json", '{"error":"token required"}');
  if (url.pathname === "/info/glow-badge") return send(200, "application/json", '{"live":true,"supportsDark":true,"via":"demo"}');
  if (url.pathname === "/info/chat-app") return send(200, "application/json", '{"live":false,"reason":"it needs server keys (2 key-bound server SDKs) and a running API"}');
  if (url.pathname === "/info/brand-app") return send(200, "application/json", '{"live":false,"reason":"threw: Vercel AI SDK needs a key"}');
  if (url.pathname === "/p/glow-badge") return send(200, "text/html", "<!doctype html><html><body><div id='root'><p>HARNESS-DEMO pid=" + process.pid + " theme=" + url.searchParams.get("theme") + "</p></div></body></html>");
  if (url.pathname === "/p/chat-app") return send(422, "application/json", '{"live":false,"reason":"it needs server keys"}');
  send(404, "application/json", '{"error":"not found"}');
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("listening " + server.address().port));
`;

/** A CSP header split into directives, each as its tokens. */
function directives(header: string | string[] | undefined): string[][] {
  return String(header ?? '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0] !== '');
}

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let root: string;
let kitDir: string;
let harnessDir: string;
let harness: CultPreviewHarness;
let server: http.Server | undefined;
let port: number;

function writeKit(): void {
  kitDir = path.join(root, 'kits', 'cult-ui-pro');
  const dir = path.join(kitDir, 'converted', 'hero-glow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'template.html'),
    '<section class="cult-hero-glow"><h1 class="c1">{{headline}}</h1>{{#if label1}}<span>{{label1}}</span>{{/if}}{{#if label2}}<em>{{label2}}</em>{{/if}}</section>');
  writeFileSync(path.join(dir, 'styles.css'), '.cult-hero-glow{color:var(--role-foreground);background:var(--role-background)}');
  writeFileSync(path.join(dir, 'slots.json'), JSON.stringify({
    block: 'hero-glow',
    text: [{ name: 'headline', text: 'Ship <faster> & "safer"' }, { name: 'label1', text: 'New' }, { name: 'label2', text: '' }],
    links: [],
  }));
  harnessDir = path.join(root, 'kits', 'cult-ui-pro-preview');
  mkdirSync(path.join(harnessDir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(harnessDir, 'server.mjs'), FAKE_HARNESS);
}

async function mount(options: { kitDir?: string | null; harness?: CultPreviewHarness; host?: string } = {}) {
  const app = express();
  registerCultLivePreviewRoutes(app, { http: { sendApiError } } as never, {
    rows: ROWS,
    slugs: SLUGS,
    kitDir: options.kitDir === undefined ? kitDir : options.kitDir,
    harness: options.harness ?? harness,
  });
  const listening = app.listen(0, options.host ?? '127.0.0.1');
  server = listening;
  await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
  port = (server!.address() as AddressInfo).port;
}

/** A raw request, so the test controls Host and forwarding headers exactly. */
function rawGet(pathname: string, headers: Record<string, string> = {}, via: { host: string; localAddress?: string } = { host: '127.0.0.1' }):
  Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: via.host, port, path: pathname, method: 'GET', headers, localAddress: via.localAddress }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cult-live-preview-'));
  writeKit();
  harness = new CultPreviewHarness({ dir: harnessDir, kitDir, startTimeoutMs: 10_000 });
});

afterAll(() => {
  harness.stop();
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  const open = server;
  server = undefined;
  if (!open) return;
  open.closeAllConnections();
  await new Promise<void>((resolve) => open.close(() => resolve()));
});

describe('fillConvertedTemplate', () => {
  it('keeps an #if body only when its slot has text, and escapes every slot', () => {
    const text = new Map([['a', '<b>'], ['b', '']]);
    expect(fillConvertedTemplate('{{#if a}}[{{a}}]{{/if}}{{#if b}}[{{b}}]{{/if}}{{missing}}', text)).toBe('[&lt;b&gt;]');
  });
  it('fills empty preview image boxes with original labelled artwork without changing the kit', () => {
    const dir = path.join(kitDir, 'converted', 'picture-gallery');
    mkdirSync(dir, { recursive: true });
    const template = '<section><h1>Gallery</h1><span class="picture cult-img-box" aria-hidden="true"></span><span class="picture cult-img-box" aria-hidden="true"></span></section>';
    writeFileSync(path.join(dir, 'template.html'), template);
    writeFileSync(path.join(dir, 'styles.css'), '.picture{width:450px;height:300px}');
    const html = convertedPreviewHtml(kitDir, 'picture-gallery', 'light', COMPOSED_PAGE_CSP)!;
    expect(html.match(/data-preview-artwork=/g)).toHaveLength(2);
    expect(html).toContain('Original Higgsfield imagery');
    expect(html).toContain('src="data:image/webp;base64,');
    expect(html).not.toMatch(/<script|https?:\/\//i);
    expect(readFileSync(path.join(dir, 'template.html'), 'utf8')).toBe(template);
  });
  it('fills only the empty organic demo with static original content and a responsive preview layout', () => {
    const dir = path.join(kitDir, 'converted', 'organic--tabs-showcase');
    mkdirSync(dir, { recursive: true });
    const template = '<section class="cult-organic--tabs-showcase"><div class="hs2"><div class="hs3">Dither experiments</div><div class="hsk"><p class="hss"><span class="hst"></span></p><span class="hsi">Live</span></div></div></section>';
    const css = '.cult-organic--tabs-showcase .hs2.hs2{display:flex}.cult-organic--tabs-showcase .hss.hss{mask-image:linear-gradient(black,transparent)}';
    writeFileSync(path.join(dir, 'template.html'), template);
    writeFileSync(path.join(dir, 'styles.css'), css);
    for (const theme of ['light', 'dark'] as const) {
      const html = convertedPreviewHtml(kitDir, 'organic--tabs-showcase', theme, COMPOSED_PAGE_CSP)!;
      expect(html).toContain('data-preview-tabs-message');
      expect(html).toContain('Space for the idea.');
      expect(html).toContain('<span class="hsi">Static</span>');
      expect(html).toContain('Animated typing and tab changes are not available here.');
      expect(html).toContain('@media(max-width:640px)');
      expect(html).toContain('grid-template-columns:minmax(0,1fr)');
      expect(html).toContain('mask-image:none');
      expect(html).not.toMatch(/<script|https?:\/\//i);
    }
    expect(convertedPreviewMockNote(kitDir, 'organic--tabs-showcase')).toContain('Static illustrative layout preview');
    expect(readFileSync(path.join(dir, 'template.html'), 'utf8')).toBe(template);
    expect(readFileSync(path.join(dir, 'styles.css'), 'utf8')).toBe(css);
    writeFileSync(path.join(dir, 'template.html'), template + '<span class="cult-img-box"></span>');
    const combinedNote = convertedPreviewMockNote(kitDir, 'organic--tabs-showcase')!;
    expect(combinedNote).toContain('Original Higgsfield imagery');
    expect(combinedNote).toContain('Static illustrative layout preview');
    expect(convertedPreviewHtml(kitDir, 'organic--tabs-showcase', 'light', COMPOSED_PAGE_CSP)).toContain(combinedNote);
    const populated = template.replace('<span class="hst"></span>', 'Existing illustration text');
    writeFileSync(path.join(dir, 'template.html'), populated);
    const html = convertedPreviewHtml(kitDir, 'organic--tabs-showcase', 'light', COMPOSED_PAGE_CSP)!;
    expect(html).toContain('Existing illustration text');
    expect(html).not.toContain('data-preview-tabs-message');
    expect(convertedPreviewMockNote(kitDir, 'organic--tabs-showcase')).toBeNull();
  });
  it('gives the SaaS feature micro-labels readable opaque chips only in that preview', () => {
    const dir = path.join(kitDir, 'converted', 'sass-colorful--features');
    mkdirSync(dir, { recursive: true });
    const template = '<section class="cult-sass-colorful--features"><div class="hs5"><span>THE DESIGN</span><span>ZEPXEN</span></div><div class="hsm"><span>OPS</span><span>BASELINE</span></div><span>Other text</span></section>';
    const css = '.cult-sass-colorful--features .hs5.hs5{font-size:6px}';
    writeFileSync(path.join(dir, 'template.html'), template);
    writeFileSync(path.join(dir, 'styles.css'), css);
    for (const theme of ['light', 'dark'] as const) {
      const html = convertedPreviewHtml(kitDir, 'sass-colorful--features', theme, COMPOSED_PAGE_CSP)!;
      expect(html.match(/<span data-preview-feature-label>/g)).toHaveLength(4);
      expect(html).toContain('font-size:11px');
      expect(html).toContain('color:var(--role-foreground);background:var(--role-background)');
      expect(html).toContain('<span>Other text</span>');
    }
    expect(readFileSync(path.join(dir, 'template.html'), 'utf8')).toBe(template);
    expect(readFileSync(path.join(dir, 'styles.css'), 'utf8')).toBe(css);
    const otherDir = path.join(kitDir, 'converted', 'another-features');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, 'template.html'), template);
    writeFileSync(path.join(otherDir, 'styles.css'), css);
    expect(convertedPreviewHtml(kitDir, 'another-features', 'light', COMPOSED_PAGE_CSP)).not.toContain('data-preview-feature-label');
  });
});

describe('a section row: the converted static page', () => {
  it('says it previews live, with a dark theme', async () => {
    await mount();
    const res = await rawGet('/api/cult/preview/cult:hero-series-g', { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(parseCultPreviewInfoResponse(JSON.parse(res.body))).toEqual({ preview: { live: true, mode: 'converted', supportsDark: true, mockNote: null } });
  });

  it('serves the filled page under the build CSP, as a header and in the page itself', async () => {
    await mount();
    const res = await rawGet('/api/cult/preview/cult:hero-series-g/frame?theme=light', { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    // The build CSP, plus a sandbox with no permission, so the page gets an opaque origin and runs
    // no script even when it is opened outside the modal (a printed frame URL, a bookmark).
    expect(res.headers['content-security-policy']).toBe(CULT_CONVERTED_FRAME_CSP);
    expect(CULT_CONVERTED_FRAME_CSP).toBe(`${CULT_CONVERTED_DOCUMENT_CSP}; sandbox`);
    expect(CULT_CONVERTED_DOCUMENT_CSP).toBe(COMPOSED_PAGE_CSP.replace("img-src 'none'", 'img-src data:'));
    expect(COMPOSED_PAGE_CSP).toContain("script-src 'none'");
    expect(directives(res.headers['content-security-policy'])).toContainEqual(['sandbox']);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.body).toContain(`<meta http-equiv="Content-Security-Policy" content="${CULT_CONVERTED_DOCUMENT_CSP.replace(/'/g, '&#39;')}">`);
    expect(res.body).toContain('<h1 class="c1">Ship &lt;faster&gt; &amp; &quot;safer&quot;</h1>');
    expect(res.body).toContain('<span>New</span>');
    expect(res.body).not.toContain('<em>');
    expect(res.body).not.toContain('{{');
    expect(res.body).toContain('--role-background:#ffffff');
    expect(res.body).not.toMatch(/<script/i);
  });

  it('resolves a row by its public slug, and by its internal name or old id as an alias', async () => {
    await mount();
    for (const id of ['cult:hero-series-g', 'hero-series-g', 'cult:hero-glow', 'hero-glow']) {
      const res = await rawGet(`/api/cult/preview/${encodeURIComponent(id)}/frame`, { host: `127.0.0.1:${port}` });
      expect(res.status, id).toBe(200);
      expect(res.body, id).toContain('Ship &lt;faster&gt;');
    }
  });

  it('switches the role palette for the dark theme', async () => {
    await mount();
    const res = await rawGet('/api/cult/preview/cult:hero-series-g/frame?theme=dark', { host: `127.0.0.1:${port}` });
    expect(res.body).toContain('--role-background:#09090b');
    expect(res.body).toContain('color-scheme:dark');
  });

  it('says why when the kit has no converted page, and 404s the frame', async () => {
    await mount();
    const info = parseCultPreviewInfoResponse(JSON.parse((await rawGet('/api/cult/preview/cult:no-convert', { host: `127.0.0.1:${port}` })).body));
    expect(info.preview).toEqual({ live: false, mode: 'converted', reason: 'the converter has no static page for it' });
    expect((await rawGet('/api/cult/preview/cult:no-convert/frame', { host: `127.0.0.1:${port}` })).status).toBe(404);
  });

  it('answers 404 for an id the catalog does not have', async () => {
    await mount();
    expect((await rawGet('/api/cult/preview/cult:..%2F..%2Fetc', { host: `127.0.0.1:${port}` })).status).toBe(404);
    expect((await rawGet('/api/cult/preview/cult:stray/frame', { host: `127.0.0.1:${port}` })).status).toBe(404);
  });
});

describe('a primitive or app row: the preview harness', () => {
  it('starts the harness on demand and proxies the item demo under the harness CSP', async () => {
    await mount();
    const info = parseCultPreviewInfoResponse(JSON.parse((await rawGet('/api/cult/preview/cult:glow-badge', { host: `127.0.0.1:${port}` })).body));
    expect(info.preview).toEqual({ live: true, mode: 'harness', supportsDark: true, mockNote: null });
    const res = await rawGet('/api/cult/preview/cult:glow-badge/frame?theme=dark', { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/HARNESS-DEMO pid=\d+ theme=dark/);
    expect(res.body).toContain('<script data-cult-readiness>');
    expect(res.body).not.toContain('requestAnimationFrame');
    expect(res.headers['content-security-policy']).toBe(CULT_HARNESS_FRAME_CSP);
    expect(CULT_HARNESS_FRAME_CSP).toContain("connect-src 'none'");
    // Scripts only, in an opaque origin, however the page is opened: no allow-same-origin.
    expect(directives(res.headers['content-security-policy'])).toContainEqual(['sandbox', 'allow-scripts']);
    const state = JSON.parse(readFileSync(path.join(harnessDir, '.run', 'harness.json'), 'utf8')) as { port: number; token: string };
    // The harness itself refuses a request without the daemon's token.
    expect((await fetch(`http://127.0.0.1:${state.port}/p/glow-badge`)).status).toBe(401);
  });

  it('reuses a running harness instead of starting a second one', async () => {
    const first = await harness.ensure();
    const again = new CultPreviewHarness({ dir: harnessDir, kitDir });
    const second = await again.ensure();
    expect(second.pid).toBe(first.pid);
    expect(second.port).toBe(first.port);
  });

  it('passes on the reason an item cannot preview live, and the frame posts it to the modal', async () => {
    await mount();
    const info = parseCultPreviewInfoResponse(JSON.parse((await rawGet('/api/cult/preview/cult:chat-app', { host: `127.0.0.1:${port}` })).body));
    expect(info.preview).toEqual({ live: false, mode: 'harness', reason: 'it needs server keys (2 key-bound server SDKs) and a running API' });
    const frame = await rawGet('/api/cult/preview/cult:chat-app/frame', { host: `127.0.0.1:${port}` });
    expect(frame.status).toBe(422);
    expect(frame.body).toContain('"source":"cult-live-preview","type":"error","reason":"it needs server keys"');
    expect(directives(frame.headers['content-security-policy'])).toContainEqual(['sandbox', 'allow-scripts']);
  });

  it('kills a harness that starts but fails its health check, every time, leaving no orphan', async () => {
    // Prints "listening", then answers /healthz as some other app: the launcher must not keep it.
    const dir = path.join(root, 'kits', 'bad-harness');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'server.mjs'), `
      import { appendFileSync } from "node:fs";
      import { createServer } from "node:http";
      appendFileSync("pids.txt", process.pid + "\\n");
      const s = createServer((req, res) => res.end(JSON.stringify({ ok: true, app: "something-else", pid: process.pid })));
      s.listen(0, "127.0.0.1", () => console.log("listening " + s.address().port));
    `);
    const bad = new CultPreviewHarness({ dir, kitDir, startTimeoutMs: 10_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(bad.ensure()).rejects.toThrow(CultHarnessUnavailable);
    }
    const pids = readFileSync(path.join(dir, 'pids.txt'), 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(() => pids.filter(alive), { timeout: 5000 }).toEqual([]);
    expect((bad as unknown as { child: unknown }).child).toBeNull();
  });

  it('kills and forgets a harness that exits before it listens', async () => {
    const dir = path.join(root, 'kits', 'dying-harness');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'server.mjs'), 'console.error("no kit here"); process.exit(3);');
    const dying = new CultPreviewHarness({ dir, kitDir, startTimeoutMs: 10_000 });
    await expect(dying.ensure()).rejects.toThrow(/exited \(3\): no kit here/);
    expect((dying as unknown as { child: unknown }).child).toBeNull();
  });

  it('starts the harness with a minimal environment, never the daemon secrets', () => {
    const env = harnessEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-secret', OD_API_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1' }, { token: 'x'.repeat(24), kitDir: '/kit', parentPid: 42 });
    expect(env).toEqual({
      PORT: '0', CULT_PREVIEW_TOKEN: 'x'.repeat(24), CULT_KIT_DIR: '/kit', CULT_PREVIEW_PARENT_PID: '42',
      PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('scrubs vendor names out of a reason the harness passes on', async () => {
    await mount();
    const info = parseCultPreviewInfoResponse(JSON.parse((await rawGet('/api/cult/preview/cult:brand-app', { host: `127.0.0.1:${port}` })).body));
    expect(info.preview.live).toBe(false);
    expect(JSON.stringify(info)).not.toMatch(/vercel/i);
  });

  it('says the harness is not installed when it is not', async () => {
    await mount({ harness: new CultPreviewHarness({ dir: null, kitDir }) });
    const info = parseCultPreviewInfoResponse(JSON.parse((await rawGet('/api/cult/preview/cult:glow-badge', { host: `127.0.0.1:${port}` })).body));
    expect(info.preview).toEqual({ live: false, mode: 'harness', reason: 'the local preview harness is not installed on this machine' });
    expect((await rawGet('/api/cult/preview/cult:glow-badge/frame', { host: `127.0.0.1:${port}` })).status).toBe(503);
  });
});

describe('the local-only guard on both preview routes', () => {
  const paths = ['/api/cult/preview/cult:hero-series-g', '/api/cult/preview/cult:hero-series-g/frame', '/api/cult/preview/cult:glow-badge/frame'];
  const refused: Array<[string, Record<string, string>]> = [
    ['a LAN Host', { host: '192.168.1.20:3000' }],
    ['a LAN client named by the sidecar', { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1, 192.168.1.20' }],
    ['a relayed Host (Next rewrite)', { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000' }],
    ['a LAN Origin', { host: 'localhost:3000', origin: 'http://192.168.1.20:3000' }],
    ['Forwarded for= a LAN client', { host: 'localhost:3000', forwarded: 'for=192.168.1.20' }],
    ['a rebinding page the sidecar relayed (a foreign Host from a loopback browser)', { host: '127.0.0.1:7456', 'x-forwarded-for': '127.0.0.1', 'x-od-client-host': 'evil.example:3000' }],
  ];

  for (const [label, headers] of refused) {
    it(`refuses ${label}`, async () => {
      await mount();
      for (const pathname of paths) {
        const res = await rawGet(pathname, headers);
        expect(res.status, pathname).toBe(403);
        expect(res.body, pathname).not.toContain('Ship');
        expect(res.body, pathname).not.toContain('HARNESS-DEMO');
        expect(res.body, pathname).toContain('licensed source is served to this machine only');
      }
    });
  }

  it('serves this machine through the sidecar (a loopback client named in X-Forwarded-For)', async () => {
    await mount();
    const res = await rawGet('/api/cult/preview/cult:hero-series-g/frame', { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1' });
    expect(res.status).toBe(200);
  });

  it.skipIf(LAN === undefined)('refuses a real LAN peer', async () => {
    await mount({ host: LAN! });
    for (const pathname of paths) {
      const res = await rawGet(pathname, { host: `localhost:${port}` }, { host: LAN!, localAddress: LAN! });
      expect(res.status, pathname).toBe(403);
      expect(res.body, pathname).toContain('the request peer is not loopback');
    }
  });
});

const realKit = resolveCultKitDir() ?? path.join(process.env.HOME ?? '', 'projects', 'mm-source-kits', 'cult-ui-pro');
describe.skipIf(!existsSync(path.join(realKit, 'converted')))('the shipped inventory against this machine\'s kit', () => {
  it('has a converted static page for every section and page row', () => {
    const rows = (cultInventoryJson as unknown as { rows: CultPreviewRow[] }).rows.filter((row) => row.assetKind === 'section' || row.assetKind === 'page');
    expect(rows.length).toBeGreaterThan(100);
    const missing = rows.filter((row) => convertedDir(realKit, row.name) === null).map((row) => row.id);
    expect(missing).toEqual([]);
  });

  it('previews every section and page row live by the public slug id the catalog DTO carries', async () => {
    const app = express();
    registerCultLivePreviewRoutes(app, { http: { sendApiError } } as never, { kitDir: realKit, harness });
    const listening = app.listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    port = (listening.address() as AddressInfo).port;
    const slugs = cultSlugs();
    const rows = (cultInventoryJson as unknown as { rows: CultPreviewRow[] }).rows.filter((row) => row.assetKind === 'section' || row.assetKind === 'page');
    const failed: string[] = [];
    for (const row of rows) {
      const id = `cult:${slugs.get(row.id) ?? row.name}`;
      const res = await rawGet(`/api/cult/preview/${encodeURIComponent(id)}`, { host: `127.0.0.1:${port}` });
      const info = res.status === 200 ? parseCultPreviewInfoResponse(JSON.parse(res.body)).preview : null;
      if (!info?.live) failed.push(id);
    }
    expect(failed).toEqual([]);
  });
});
