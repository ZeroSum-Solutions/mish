import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCaptureMetadataHeader, parseCaptureList, parseCaptureView, WORKBENCH_CAPTURE_MAX_BYTES, type RightsDeclaration } from '@open-design/contracts';
import { registerWorkbenchCaptureRoutes } from '../../src/routes/workbench-capture.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { createUnitService } from '../../src/workbench/units/unit-service.js';
import { ProjectContextError } from '../../src/workbench/project-context.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { captureHeaders, fileCaptureBytes, nativePageMetadata, pngBytes, sha } from './capture-fixture.js';

// AC-R14.1: capture is saved as an immutable image with source URL (redacted),
// viewport and capture time before any generation; upload/paste and
// permission-granted screen capture are accepted; the daemon never fetches a
// URL; saved captures resume after a restart; HTTP and `od` agree.

let server: Server | undefined; const dirs: string[] = [];
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; details: Record<string, unknown> } }).error;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function boot(dataDir?: string, bytesDir?: string) {
  const data = dataDir ?? await mkdtemp(path.join(tmpdir(), 'od-capture-data-')); if (!dataDir) dirs.push(data);
  const bytes = fileCaptureBytes(bytesDir ?? path.join(data, 'library-standin'));
  const captures = createCaptureService({ dataDir: data, bytes });
  const app = express(); app.use(express.json());
  registerWorkbenchCaptureRoutes(app, {
    http: { sendApiError: (res, status, code, message, extra) => res.status(status).json({ error: { code, message, ...(extra?.details ? { details: extra.details } : {}) } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'foreign') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'private' } }); return false; } return true; },
    assertProject: id => { if (id === 'missing') throw new ProjectContextError(403, 'project-forbidden', 'Project scope is not authorized'); },
    captures,
    units: createUnitService({ dataDir: data, projectRoot: () => null, isCapturedBytes: async () => false, readCapture: async () => null, renderThumbnail: async () => ({ unavailable: 'test' }) }),
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output: unknown[] = [];
  const cli = (args: string[], stdin = '') => runWorkbenchCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value), readStdin: async () => stdin });
  return { url, data, bytes, output, cli };
}

const post = (url: string, body: Buffer, headers: Record<string, string>, query = '?projectId=p1') =>
  fetch(`${url}/api/workbench/captures${query}`, { method: 'POST', headers, body });

describe('AC-R14.1 capture save', () => {
  it('saves a desktop page capture as an immutable record with redacted source URL, viewport, frame and capture time', async () => {
    const { url, data, bytes } = await boot();
    const png = pngBytes(80, 60);
    const before = Date.now();
    const response = await post(url, png, captureHeaders(nativePageMetadata(), { 'idempotency-key': 'k-1' }));
    expect(response.status).toBe(201);
    const view = parseCaptureView(await response.json());
    const record = view.capture;
    expect(record).toMatchObject({
      schema: 'workbench-capture/1', projectId: 'p1', captureMode: 'native-page',
      // Credentials, query and fragment are never stored.
      sourceUrl: 'https://example.com/pricing', sourceUrlRedacted: true, sourceTitle: 'Pricing',
      viewport: { width: 40, height: 30, deviceScaleFactor: 2 }, frame: { width: 80, height: 60 }, region: null,
      image: { mediaType: 'image/png', width: 80, height: 60, bytes: png.length },
      contentHash: sha(png), capturePermission: 'desktop-host-user-action', rightsDeclaration: null, parentCaptureId: null,
    });
    expect(Date.parse(record.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(view.bytesAvailable).toBe(true);
    // Bytes went to the asset port once, and the record lives under the data root.
    expect(bytes.puts).toBe(1);
    const files = (await readdir(path.join(data, 'workbench-capture'), { recursive: true })).map(String);
    const recordFile = files.find(file => file.endsWith(`${record.id}.json`));
    expect(recordFile).toBeDefined();
    const stored = await readFile(path.join(data, 'workbench-capture', recordFile!), 'utf8');
    expect(stored).not.toContain('user:pass');
    expect(stored).not.toContain('session=abc123');

    // The image reads back byte-identical as an inert raster.
    const image = await fetch(`${url}${view.imageUrl}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
  });

  it('is immutable: a replayed key returns the same record, a changed body under it conflicts, and no update route exists', async () => {
    const { url } = await boot();
    const png = pngBytes(80, 60);
    const first = parseCaptureView(await (await post(url, png, captureHeaders(nativePageMetadata(), { 'idempotency-key': 'same' }))).json());
    const replay = await post(url, png, captureHeaders(nativePageMetadata(), { 'idempotency-key': 'same' }));
    expect(replay.status).toBe(200);
    expect(parseCaptureView(await replay.json()).capture).toEqual(first.capture);
    const conflict = await post(url, pngBytes(80, 60, [1, 2, 3]), captureHeaders(nativePageMetadata(), { 'idempotency-key': 'same' }));
    expect(conflict.status).toBe(409);
    for (const method of ['PUT', 'PATCH']) {
      const mutate = await fetch(`${url}/api/workbench/captures/${first.capture.id}?projectId=p1`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(mutate.status).toBe(404);
    }
    const missingKey = await post(url, png, captureHeaders(nativePageMetadata()));
    expect(missingKey.status).toBe(400);
  });

  it('records a desktop region capture and validates region bounds and device scale', async () => {
    const { url } = await boot();
    const region = { x: 10, y: 6, width: 20, height: 12 };
    const ok = await post(url, pngBytes(20, 12), captureHeaders(nativePageMetadata({ captureMode: 'native-region', region }), { 'idempotency-key': 'r-ok' }));
    expect(ok.status).toBe(201);
    expect(parseCaptureView(await ok.json()).capture).toMatchObject({ captureMode: 'native-region', region, image: { width: 20, height: 12 } });

    const outside = await post(url, pngBytes(20, 12), captureHeaders(nativePageMetadata({ captureMode: 'native-region', region: { x: 70, y: 0, width: 20, height: 12 } }), { 'idempotency-key': 'r-out' }));
    expect(outside.status).toBe(422);
    // Image pixels must equal the declared region; a mismatched crop is refused.
    const wrongScale = await post(url, pngBytes(40, 24), captureHeaders(nativePageMetadata({ captureMode: 'native-region', region }), { 'idempotency-key': 'r-scale' }));
    expect(wrongScale.status).toBe(422);
    expect((await errorOf(wrongScale)).details.reason).toBe('region-scale-mismatch');
    // A page frame must equal viewport × device scale.
    const wrongFrame = await post(url, pngBytes(80, 60), captureHeaders(nativePageMetadata({ viewport: { width: 80, height: 60, deviceScaleFactor: 2 } }), { 'idempotency-key': 'r-frame' }));
    expect(wrongFrame.status).toBe(422);
    expect((await errorOf(wrongFrame)).details.reason).toBe('viewport-scale-mismatch');
  });

  it('accepts uploaded, pasted and permission-granted screen captures with their own capture authority', async () => {
    const { url } = await boot();
    const cases = [
      ['upload', 'user-supplied-file'], ['paste', 'user-supplied-file'], ['screen-share', 'browser-display-media'],
    ] as const;
    for (const [captureMode, capturePermission] of cases) {
      const response = await post(url, pngBytes(30, 20, [captureMode.length, 9, 9]), captureHeaders({ projectId: 'p1', captureMode, frame: { width: 30, height: 20 }, ...(captureMode === 'screen-share' ? { viewport: { width: 30, height: 20, deviceScaleFactor: 1 } } : {}) }, { 'idempotency-key': `m-${captureMode}` }));
      expect(response.status, captureMode).toBe(201);
      expect(parseCaptureView(await response.json()).capture, captureMode).toMatchObject({ captureMode, capturePermission, viewport: captureMode === 'screen-share' ? { width: 30, height: 20, deviceScaleFactor: 1 } : null, sourceUrl: null });
    }
  });

  it('never fetches a URL and refuses scriptable or oversized bytes', async () => {
    const { url, bytes } = await boot();
    // There is no URL-to-fetch field: an unknown key fails validation before any I/O.
    const fetchAttempt = await post(url, pngBytes(30, 20), { ...captureHeaders(nativePageMetadata()), 'x-od-capture-metadata': encodeCaptureMetadataHeader({ ...nativePageMetadata(), url: 'http://169.254.169.254/latest' } as never), 'idempotency-key': 'u' });
    expect(fetchAttempt.status).toBe(400);
    const svg = await post(url, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { ...captureHeaders(nativePageMetadata()), 'content-type': 'image/svg+xml', 'idempotency-key': 's' });
    expect(svg.status).toBe(415);
    const disguised = await post(url, Buffer.from('<html><script>fetch("/api/projects")</script></html>'), captureHeaders(nativePageMetadata(), { 'idempotency-key': 'h' }));
    expect(disguised.status).toBe(422);
    expect((await errorOf(disguised)).details.reason).toBe('not-a-raster-image');
    const big = await post(url, Buffer.alloc(WORKBENCH_CAPTURE_MAX_BYTES + 1, 1), captureHeaders(nativePageMetadata(), { 'idempotency-key': 'b' }));
    expect(big.status).toBe(413);
    expect(bytes.puts).toBe(0);
  });

  it('keeps project authority: a foreign or mismatched project scope stores nothing', async () => {
    const { url, bytes } = await boot();
    const foreign = await post(url, pngBytes(80, 60), captureHeaders(nativePageMetadata({ projectId: 'foreign' }), { 'idempotency-key': 'f' }), '?projectId=foreign');
    expect(foreign.status).toBe(403);
    const mismatch = await post(url, pngBytes(80, 60), captureHeaders(nativePageMetadata(), { 'idempotency-key': 'mm' }), '?projectId=other');
    expect(mismatch.status).toBe(400);
    expect(bytes.puts).toBe(0);
  });

  it('resumes saved captures after a daemon restart and reports bytes removed later without changing the record', async () => {
    const first = await boot();
    const png = pngBytes(80, 60);
    const saved = parseCaptureView(await (await post(first.url, png, captureHeaders(nativePageMetadata(), { 'idempotency-key': 'resume' }))).json());
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;

    // A fresh service over the same data root is a restart.
    const second = await boot(first.data, path.join(first.data, 'library-standin'));
    const list = parseCaptureList(await (await fetch(`${second.url}/api/workbench/captures?projectId=p1`)).json());
    expect(list.captures.map(view => view.capture)).toEqual([saved.capture]);
    const image = await fetch(`${second.url}${saved.imageUrl}`);
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);

    await second.bytes.remove(saved.capture.assetId);
    const after = parseCaptureView(await (await fetch(`${second.url}/api/workbench/captures/${saved.capture.id}?projectId=p1`)).json());
    expect(after).toMatchObject({ capture: saved.capture, bytesAvailable: false });
    expect((await fetch(`${second.url}${saved.imageUrl}`)).status).toBe(410);
  });

  it('refuses a rights declaration sent with an agent tool token and records the write surface of a user declaration', async () => {
    const { url, data, bytes, output, cli } = await boot();
    const declaration: RightsDeclaration = { basis: 'user-owned', evidenceRefs: ['my site'], notices: [] };
    const agent = await post(url, pngBytes(30, 20), captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 20 }, rightsDeclaration: declaration }, { 'idempotency-key': 'agent', authorization: 'Bearer od-tool-token-abc' }));
    expect(agent.status).toBe(403);
    expect((await errorOf(agent)).details.reason).toBe('agent-declaration-refused');
    expect(bytes.puts).toBe(0);
    // Without a declaration the same token may still save evidence.
    const plain = await post(url, pngBytes(30, 20), captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 20 } }, { 'idempotency-key': 'agent-plain', authorization: 'Bearer od-tool-token-abc' }));
    expect(plain.status).toBe(201);
    expect(parseCaptureView(await plain.json()).capture.rightsDeclaredVia).toBeNull();

    const http = parseCaptureView(await (await post(url, pngBytes(30, 21), captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 21 }, rightsDeclaration: declaration }, { 'idempotency-key': 'raw' }))).json());
    expect(http.capture.rightsDeclaredVia).toBe('http');
    const web = parseCaptureView(await (await post(url, pngBytes(30, 22), captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 22 }, rightsDeclaration: declaration }, { 'idempotency-key': 'web', 'sec-fetch-site': 'same-origin' }))).json());
    expect(web.capture.rightsDeclaredVia).toBe('web');

    const file = path.join(data, 'declared.png'); await writeFile(file, pngBytes(30, 23));
    const metadata = JSON.stringify({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 23 }, rightsDeclaration: declaration });
    expect(await cli(['capture', 'import', '--file', file, '--metadata-file', '-', '--json'], metadata)).toBe(0);
    expect(parseCaptureView(output.pop()).capture.rightsDeclaredVia).toBe('cli');
    // od run inside an agent carries OD_TOOL_TOKEN, so the same import is refused.
    const agentCli = await runWorkbenchCli(['capture', 'import', '--file', file, '--metadata-file', '-', '--json'], { env: { OD_DAEMON_URL: url, OD_TOOL_TOKEN: 'od-tool-token-abc', OD_TOOL_TOKEN_ISSUER_ORIGIN: url }, write: value => output.push(value), readStdin: async () => metadata });
    expect(agentCli).toBe(3);
    expect(output.pop()).toMatchObject({ status: 403, error: { details: { reason: 'agent-declaration-refused' } } });
  });

  it('od workbench capture import/list/show use the same endpoints, and capture take is explicitly unsupported', async () => {
    const { url, data, output, cli } = await boot();
    const file = path.join(data, 'shot.png'); await writeFile(file, pngBytes(30, 20));
    const meta = path.join(data, 'meta.json'); await writeFile(meta, JSON.stringify({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 20 }, sourceUrl: 'https://example.com/a?token=x' }));
    expect(await cli(['capture', 'import', '--file', file, '--metadata-file', meta, '--json'])).toBe(0);
    const imported = parseCaptureView(output.pop());
    expect(imported.capture).toMatchObject({ captureMode: 'upload', sourceUrl: 'https://example.com/a', sourceUrlRedacted: true });

    expect(await cli(['capture', 'show', '--project', 'p1', '--id', imported.capture.id, '--json'])).toBe(0);
    expect(parseCaptureView(output.pop())).toEqual(parseCaptureView(await (await fetch(`${url}/api/workbench/captures/${imported.capture.id}?projectId=p1`)).json()));
    expect(await cli(['capture', 'list', '--project', 'p1', '--json'])).toBe(0);
    expect(parseCaptureList(output.pop()).captures.map(view => view.capture.id)).toEqual([imported.capture.id]);

    // Metadata may come from stdin; a bad region is a typed refusal (exit 3).
    expect(await cli(['capture', 'import', '--file', file, '--metadata-file', '-', '--json'], JSON.stringify({ projectId: 'p1', captureMode: 'native-region', viewport: { width: 30, height: 20, deviceScaleFactor: 1 }, frame: { width: 30, height: 20 }, region: { x: 0, y: 0, width: 10, height: 10 } }))).toBe(3);
    expect(output.pop()).toMatchObject({ status: 422, error: { details: { reason: 'region-scale-mismatch' } } });

    expect(await cli(['capture', 'take', '--project', 'p1', '--json'])).toBe(3);
    expect(output.pop()).toMatchObject({ error: { code: 'unsupported-capability' } });
    expect(await cli(['capture', 'import', '--file', file, '--json'])).toBe(2);
    expect((await stat(file)).size).toBeGreaterThan(0);
  });
});
