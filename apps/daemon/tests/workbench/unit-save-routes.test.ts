import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCaptureView, parseReusableUnitManifest, parseUnitList, parseUnitSavePlan, type UnitSaveRequest } from '@mish/contracts';
import { registerWorkbenchCaptureRoutes } from '../../src/routes/workbench-capture.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { createUnitService, type UnitServiceDeps } from '../../src/workbench/units/unit-service.js';
import { ProjectContextError } from '../../src/workbench/project-context.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { captureHeaders, fileCaptureBytes, pngBytes, sha } from './capture-fixture.js';
import { privatePng } from './capture-metadata-fixture.js';

// AC-R14.3: the user selects a root and saves a component/block/section/page
// with assets, declared dependencies, rights, editable files, thumbnail and
// source lineage. Saving never installs packages and never silently includes
// proprietary captured assets.

let server: Server | undefined; const dirs: string[] = [];
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; details: Record<string, unknown> } }).error;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const LOGO = pngBytes(8, 8, [200, 30, 30]);
const SHOT = pngBytes(12, 6, [9, 200, 9]);
const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Hero</title>
<link rel="stylesheet" href="styles.css">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
</head><body>
<header id="top">Top</header>
<section id="hero" class="hero"><h1>Hello</h1><img src="assets/logo.png" alt="Logo"><img src="assets/shot.png" alt=""><button class="cta" type="button">Book</button></section>
<script src="app.js"></script>
</body></html>`;
const STYLES = '.hero { color: var(--brand, #123456); padding: var(--space-4, 16px); }\n@keyframes rise { from { opacity: 0 } to { opacity: 1 } }\n.hero h1 { animation: rise 200ms; }\n';
const APP = "document.querySelector('.cta').addEventListener('click', () => { document.body.dataset.booked = 'yes'; });\n";

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'od-unit-project-')); dirs.push(root);
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), INDEX);
  await writeFile(path.join(root, 'styles.css'), STYLES);
  await writeFile(path.join(root, 'app.js'), APP);
  await writeFile(path.join(root, 'assets', 'logo.png'), LOGO);
  await writeFile(path.join(root, 'assets', 'shot.png'), SHOT);
  return root;
}

async function treeDigest(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(root, full)] = entry.isFile() ? sha(await readFile(full)) : entry.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}

async function boot(options: { renderThumbnail?: UnitServiceDeps['renderThumbnail']; clipped?: string[]; failLookupHash?: string } = {}) {
  const data = await mkdtemp(path.join(tmpdir(), 'od-unit-data-')); dirs.push(data);
  const root = await project();
  const captures = createCaptureService({ dataDir: data, bytes: fileCaptureBytes(path.join(data, 'library-standin')) });
  const renders: string[] = [];
  const units = createUnitService({
    dataDir: data,
    projectRoot: id => (id === 'p1' ? root : null),
    isCapturedBytes: async (projectId, hash) => {
      if (hash === options.failLookupHash) throw new Error('Capture identity lookup unavailable');
      return (options.clipped ?? []).includes(hash) || captures.hasContentHash(projectId, hash);
    },
    readCapture: (projectId, id) => captures.read(projectId, id),
    renderThumbnail: options.renderThumbnail ?? (async (_root, entry) => { renders.push(entry); return { png: pngBytes(64, 40) }; }),
  });
  const app = express(); app.use(express.json());
  registerWorkbenchCaptureRoutes(app, {
    http: { sendApiError: (res, status, code, message, extra) => res.status(status).json({ error: { code, message, ...(extra?.details ? { details: extra.details } : {}) } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'foreign') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'private' } }); return false; } return true; },
    assertProject: id => { if (id === 'missing') throw new ProjectContextError(403, 'project-forbidden', 'Project scope is not authorized'); },
    captures, units,
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output: unknown[] = [];
  const cli = (args: string[], stdin = '') => runWorkbenchCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value), readStdin: async () => stdin });
  // The project's shot.png is a saved capture of a third-party page.
  const capture = parseCaptureView(await (await fetch(`${url}/api/workbench/captures?projectId=p1`, { method: 'POST', headers: captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 12, height: 6 }, sourceUrl: 'https://thirdparty.example/' }, { 'idempotency-key': 'shot' }), body: SHOT })).json());
  return { url, data, root, output, cli, capture, renders };
}

function request(overrides: Partial<UnitSaveRequest> & { paths?: string[]; rootSelector?: string } = {}): UnitSaveRequest {
  const paths = overrides.paths ?? ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png'];
  const contents: Record<string, Buffer | string> = { 'index.html': INDEX, 'styles.css': STYLES, 'app.js': APP, 'assets/logo.png': LOGO, 'assets/shot.png': SHOT };
  const { paths: _p, rootSelector, ...rest } = overrides;
  return {
    source: { kind: 'project', projectId: 'p1', entry: 'index.html', paths, rootSelector: rootSelector ?? '#hero', expectedHashes: Object.fromEntries(paths.map(p => [p, sha(contents[p] ?? '')])) },
    kind: 'section', name: 'Pricing hero',
    rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['owner-statement:hero-2026-10'], notices: ['© Example Owner'] },
    excludePaths: ['assets/shot.png'],
    ...rest,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': 'p1', ...headers }, body: JSON.stringify(body) });

describe('AC-R14.3 reusable unit save', () => {
  it('fails closed when the authoritative normalized capture identity lookup fails', async () => {
    const { url, root } = await boot({ failLookupHash: sha(pngBytes(40, 30)) });
    const raw = privatePng(); await writeFile(path.join(root, 'assets/logo.png'), raw);
    const body = request();
    if (body.source.kind === 'project') body.source.expectedHashes!['assets/logo.png'] = sha(raw);
    expect((await fetch(`${url}/api/workbench/units/plan`, json(body))).status).toBe(500);
    expect((await fetch(`${url}/api/workbench/units`, json(body, { 'idempotency-key': 'failed-lookup' }))).status).toBe(500);
  });

  it('excludes the original metadata-bearing project image after a sanitized capture import', async () => {
    const { url, root } = await boot();
    const raw = privatePng();
    await writeFile(path.join(root, 'assets/shot.png'), raw);
    const capture = parseCaptureView(await (await fetch(`${url}/api/workbench/captures?projectId=p1`, { method: 'POST', headers: captureHeaders({ projectId: 'p1', captureMode: 'upload', frame: { width: 40, height: 30 } }, { 'idempotency-key': 'metadata-shot' }), body: raw })).json());
    expect(capture.capture.contentHash).not.toBe(sha(raw));
    const body = request({ excludePaths: [] });
    if (body.source.kind === 'project') body.source.expectedHashes!['assets/shot.png'] = sha(raw);
    const plan = parseUnitSavePlan(await (await fetch(`${url}/api/workbench/units/plan`, json(body))).json());
    expect(plan.excludedFiles).toContainEqual({ path: 'assets/shot.png', sha256: sha(raw), reason: 'captured-third-party' });
    expect((await fetch(`${url}/api/workbench/units`, json(body, { 'idempotency-key': 'metadata-unit' }))).status).toBe(422);
    const explicit = { ...body, rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['own'], notices: [], scope: { paths: body.source.kind === 'project' ? body.source.paths : [] } } };
    expect((await fetch(`${url}/api/workbench/units`, json(explicit, { 'idempotency-key': 'metadata-owned' }))).status).toBe(201);
  });

  it('plans first: suggests roots, lists files, dependencies and the captured asset it will exclude, writing nothing', async () => {
    const { url, data, root } = await boot();
    const before = await treeDigest(root);
    const { excludePaths: _drop, ...unacknowledged } = request();
    const response = await fetch(`${url}/api/workbench/units/plan`, json(unacknowledged));
    expect(response.status).toBe(200);
    const plan = parseUnitSavePlan(await response.json());
    expect(plan.rootFound).toBe(true);
    expect(plan.rootCandidates).toEqual(expect.arrayContaining(['#top', '#hero', 'body']));
    expect(plan.files.find(file => file.path === 'index.html')).toMatchObject({ role: 'entry', included: true });
    expect(plan.files.find(file => file.path === 'assets/shot.png')).toMatchObject({ role: 'asset', included: false });
    expect(plan.excludedFiles).toEqual([{ path: 'assets/shot.png', sha256: sha(SHOT), reason: 'captured-third-party' }]);
    expect(plan.blockers).toEqual([expect.objectContaining({ code: 'exclusion-unacknowledged', paths: ['assets/shot.png'] })]);
    expect(plan.dependencies).toEqual([expect.objectContaining({ name: 'gsap', version: '3.12.5', source: 'remote-url', required: true })]);
    expect(await treeDigest(root)).toEqual(before);
    expect(await readdir(data)).not.toContain('workbench-units');
  });

  it('saves a section with editable files, permitted assets, declared dependencies, rights, thumbnail and source lineage', async () => {
    const { url, root, capture, renders } = await boot();
    const before = await treeDigest(root);
    const response = await fetch(`${url}/api/workbench/units`, json({ ...request(), captureId: capture.capture.id, actions: [{ id: 'book', purpose: 'Book a call', selector: '.cta' }] }, { 'idempotency-key': 'save-1' }));
    expect(response.status).toBe(201);
    const unit = parseReusableUnitManifest(await response.json());
    expect(unit).toMatchObject({
      schema: 'reusable-unit/1', revision: 1, kind: 'section', name: 'Pricing hero', format: 'html-css-js', entry: 'index.html', rootSelector: '#hero',
      excludedFiles: [{ path: 'assets/shot.png', sha256: sha(SHOT), reason: 'captured-third-party' }],
      compatibility: { adapterVersion: 'html-artifact/v1', targetKinds: ['prototype', 'deck', 'template', 'other', 'brand', 'image', 'video', 'audio'], inlineAdapters: [] },
      actions: [{ id: 'book', purpose: 'Book a call', selector: '.cta', verificationProbeId: null }],
      provenance: { captureId: capture.capture.id, captureAssetId: capture.capture.assetId, projectId: 'p1' },
      rights: { status: 'redistributable', basis: 'user-owned', declaredBy: 'user-request', evidenceRefs: ['owner-statement:hero-2026-10'], notices: ['© Example Owner'] },
      thumbnail: { source: 'rendered', width: 64, height: 40 },
    });
    expect(unit.files.map(file => [file.path, file.role, file.sha256])).toEqual([
      ['index.html', 'entry', sha(INDEX)], ['styles.css', 'style', sha(STYLES)], ['app.js', 'script', sha(APP)],
    ]);
    expect(unit.assets.map(asset => [asset.path, asset.sha256])).toEqual([['assets/logo.png', sha(LOGO)]]);
    expect(unit.dependencies).toEqual([{ name: 'gsap', version: '3.12.5', license: 'unknown', required: true, source: 'remote-url', url: 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js', referencedFrom: 'index.html' }]);
    expect(unit.capabilities).toEqual(expect.arrayContaining(['script', 'animation']));
    expect(unit.tokens).toEqual([{ name: '--brand', fallback: '#123456' }, { name: '--space-4', fallback: '16px' }]);
    expect(unit.provenance.projectSourceHashes).toEqual({ 'index.html': sha(INDEX), 'styles.css': sha(STYLES), 'app.js': sha(APP), 'assets/logo.png': sha(LOGO) });
    expect(unit.operationRights.find(right => right.operation === 'save-private-unit')).toMatchObject({ decision: 'allowed' });
    expect(renders).toEqual(['index.html']);

    // Stored bytes read back; the thumbnail is an inert PNG.
    const thumb = await fetch(`${url}/api/workbench/units/${unit.unitId}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/png');
    expect(thumb.headers.get('content-security-policy')).toContain('sandbox');
    const file = await fetch(`${url}/api/workbench/units/${unit.unitId}/files/styles.css`);
    expect(await file.text()).toBe(STYLES);
    expect(file.headers.get('content-type')).toContain('text/plain');
    expect((await fetch(`${url}/api/workbench/units/${unit.unitId}/files/assets%2Fshot.png`)).status).toBe(404);

    // No install, no package manifest, no lockfile, no project write.
    expect(await treeDigest(root)).toEqual(before);
    const listed = parseUnitList(await (await fetch(`${url}/api/workbench/units`)).json());
    expect(listed.units.map(item => item.unitId)).toEqual([unit.unitId]);
  });

  it('refuses to silently include or drop a captured asset', async () => {
    const { url } = await boot();
    const { excludePaths: _drop, ...unacknowledged } = request();
    const refused = await fetch(`${url}/api/workbench/units`, json(unacknowledged, { 'idempotency-key': 'unack' }));
    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).details).toMatchObject({ reason: 'exclusion-unacknowledged', paths: ['assets/shot.png'] });
    // Declaring the captured bytes as independently owned for that exact path keeps them, with that basis.
    const owned = await fetch(`${url}/api/workbench/units`, json({ ...request(), excludePaths: [], rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['own'], notices: [], scope: { paths: ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png'] } } }, { 'idempotency-key': 'owned' }));
    expect(owned.status).toBe(201);
    const unit = parseReusableUnitManifest(await owned.json());
    expect(unit.assets.map(asset => asset.path)).toEqual(['assets/logo.png', 'assets/shot.png']);
    expect(unit.excludedFiles).toEqual([]);
  });

  it('treats markup clipped from a third-party page as captured, so it cannot become the unit', async () => {
    const { url } = await boot({ clipped: [sha(INDEX)] });
    const plan = parseUnitSavePlan(await (await fetch(`${url}/api/workbench/units/plan`, json(request()))).json());
    expect(plan.excludedFiles.map(file => [file.path, file.reason])).toEqual([['index.html', 'captured-third-party'], ['assets/shot.png', 'captured-third-party']]);
    expect(plan.blockers.map(blocker => blocker.code)).toContain('exclusion-unacknowledged');
    const saved = await fetch(`${url}/api/workbench/units`, json({ ...request(), excludePaths: ['index.html', 'assets/shot.png'] }, { 'idempotency-key': 'clip' }));
    expect(saved.status).toBe(422);
    expect((await errorOf(saved)).details.reason).toBe('entry-excluded');
  });

  it('requires a selected root that exists and a complete local file closure', async () => {
    const { url } = await boot();
    const missingRoot = await fetch(`${url}/api/workbench/units`, json(request({ rootSelector: '#nope' }), { 'idempotency-key': 'root' }));
    expect(missingRoot.status).toBe(422);
    expect((await errorOf(missingRoot)).details.reason).toBe('root-not-found');
    const badSelector = await fetch(`${url}/api/workbench/units`, json(request({ rootSelector: 'section[' }), { 'idempotency-key': 'sel' }));
    expect(badSelector.status).toBe(422);
    const partial = await fetch(`${url}/api/workbench/units`, json(request({ paths: ['index.html', 'app.js', 'assets/logo.png', 'assets/shot.png'] }), { 'idempotency-key': 'closure' }));
    expect(partial.status).toBe(422);
    expect((await errorOf(partial)).details).toMatchObject({ reason: 'closure-incomplete', paths: ['styles.css'] });
  });

  it('records dependencies but blocks unpinned remote code, and never installs anything', async () => {
    const { url, root } = await boot();
    const tailwind = INDEX.replace('</head>', '<script src="https://cdn.tailwindcss.com"></script></head>');
    await writeFile(path.join(root, 'index.html'), tailwind);
    const body = request();
    if (body.source.kind === 'project') body.source.expectedHashes!['index.html'] = sha(tailwind);
    const response = await fetch(`${url}/api/workbench/units`, json(body, { 'idempotency-key': 'tw' }));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'unpinned-dependency' });
  });

  it('computes rights on the server: unknown or reference-only rights block the save, a client cannot set a status', async () => {
    const { url } = await boot();
    const { rightsDeclaration: _r, ...undeclared } = request();
    const plan = parseUnitSavePlan(await (await fetch(`${url}/api/workbench/units/plan`, json(undeclared))).json());
    expect(plan.rights).toMatchObject({ status: 'unknown', declaredBy: 'none' });
    expect(plan.operationRights.find(right => right.operation === 'save-private-unit')).toMatchObject({ decision: 'unknown' });
    const blocked = await fetch(`${url}/api/workbench/units`, json(undeclared, { 'idempotency-key': 'unknown' }));
    expect(blocked.status).toBe(422);
    expect((await errorOf(blocked)).details.reason).toBe('rights-blocked');
    const reference = await fetch(`${url}/api/workbench/units`, json(request({ rightsDeclaration: { basis: 'captured-third-party', evidenceRefs: [], notices: [] } }), { 'idempotency-key': 'ref' }));
    expect(reference.status).toBe(422);
    const forged = await fetch(`${url}/api/workbench/units`, json({ ...request(), rights: { status: 'redistributable' } }, { 'idempotency-key': 'forged' }));
    expect(forged.status).toBe(400);
    // Private adaptation of newly authored code is private-use-only, never redistributable.
    const adapted = parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units`, json(request({ rightsDeclaration: { basis: 'model-authored', evidenceRefs: [], notices: [], privateUseAttestation: 'I may adapt this privately' } }), { 'idempotency-key': 'adapt' }))).json());
    expect(adapted.rights.status).toBe('private-use-only');
    expect(adapted.operationRights.find(right => right.operation === 'redistribute-unit')).toMatchObject({ decision: 'blocked' });
  });

  it('refuses symlinks, path escapes, changed sources, oversized files and embedded secrets', async () => {
    const { url, root } = await boot();
    const outside = await mkdtemp(path.join(tmpdir(), 'od-unit-outside-')); dirs.push(outside);
    await writeFile(path.join(outside, 'secret.css'), 'body{}');
    await symlink(path.join(outside, 'secret.css'), path.join(root, 'linked.css'));
    await symlink(outside, path.join(root, 'linkdir'));
    for (const [p, key] of [['linked.css', 'l1'], ['linkdir/secret.css', 'l2']] as const) {
      const body = request({ paths: ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png', p] });
      if (body.source.kind === 'project') body.source.expectedHashes![p] = sha('body{}');
      const response = await fetch(`${url}/api/workbench/units`, json(body, { 'idempotency-key': key }));
      expect(response.status, p).toBe(422);
      expect((await errorOf(response)).details.reason, p).toBe('unsafe-path');
    }
    const escape = request(); if (escape.source.kind === 'project') { escape.source.paths.push('../etc/passwd'); escape.source.expectedHashes!['../etc/passwd'] = sha('x'); }
    expect((await fetch(`${url}/api/workbench/units`, json(escape, { 'idempotency-key': 'esc' }))).status).toBe(400);

    await writeFile(path.join(root, 'styles.css'), `${STYLES}/* edited */`);
    const changed = await fetch(`${url}/api/workbench/units`, json(request(), { 'idempotency-key': 'changed' }));
    expect(changed.status).toBe(409);
    expect((await errorOf(changed)).details).toMatchObject({ reason: 'source-changed', paths: ['styles.css'] });
    await writeFile(path.join(root, 'styles.css'), STYLES);

    await writeFile(path.join(root, 'app.js'), `${APP}const key = "sk-ant-api03-${'A'.repeat(40)}";\n`);
    const secretBody = request(); if (secretBody.source.kind === 'project') secretBody.source.expectedHashes!['app.js'] = sha(`${APP}const key = "sk-ant-api03-${'A'.repeat(40)}";\n`);
    const secret = await fetch(`${url}/api/workbench/units`, json(secretBody, { 'idempotency-key': 'secret' }));
    expect(secret.status).toBe(422);
    const secretError = await secret.json() as { error: { details: Record<string, unknown> } };
    expect(secretError.error.details).toMatchObject({ reason: 'secret-detected', paths: ['app.js'] });
    expect(JSON.stringify(secretError)).not.toContain('sk-ant-api03');
    await writeFile(path.join(root, 'app.js'), APP);

    const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    await writeFile(path.join(root, 'assets', 'huge.bin'), huge);
    const bigBody = request({ paths: ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png', 'assets/huge.bin'] });
    if (bigBody.source.kind === 'project') bigBody.source.expectedHashes!['assets/huge.bin'] = sha(huge);
    expect((await fetch(`${url}/api/workbench/units`, json(bigBody, { 'idempotency-key': 'big' }))).status).toBe(413);
  });

  it('scans every text-like selected file for credentials and refuses secret-bearing file types outright', async () => {
    const { url, root } = await boot();
    const anthropic = `sk-ant-api03-${'B'.repeat(40)}`;
    const aws = `AKIA${'Q'.repeat(16)}`;
    await mkdir(path.join(root, 'config'), { recursive: true });
    const files: Record<string, Buffer | string> = {
      '.env': `# local\nANTHROPIC_API_KEY=${anthropic}\n`,
      'config/settings.json': `{\n  "region": "eu",\n  "awsKey": "${aws}"\n}\n`,
      'config/deploy.yml': `name: hero\ntoken: ${anthropic}\n`,
      'keys/server.pem': Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x00, 0x02, 0x82, 0x01, 0x01, 0x00, 0xff]),
      'keys/id_ed25519': Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe]),
      '.env.production': Buffer.from([0x00, 0x00, 0x7f]),
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), body);
    }
    const expected: Record<string, RegExp> = {
      '.env': /anthropic-key on line 2/u,
      'config/settings.json': /aws-access-key on line 3/u,
      'config/deploy.yml': /anthropic-key on line 2/u,
      'keys/server.pem': /secret-bearing file type/u,
      'keys/id_ed25519': /secret-bearing file type/u,
      '.env.production': /secret-bearing file type/u,
    };
    for (const [rel, message] of Object.entries(expected)) {
      const body = request({ paths: ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png', rel] });
      if (body.source.kind === 'project') body.source.expectedHashes![rel] = sha(files[rel]!);
      const plan = parseUnitSavePlan(await (await fetch(`${url}/api/workbench/units/plan`, json(body))).json());
      const blocker = plan.blockers.find(item => item.code === 'secret-detected');
      expect(blocker, rel).toBeDefined();
      expect(blocker!.paths, rel).toEqual([rel]);
      expect(blocker!.message, rel).toMatch(message);
      const save = await fetch(`${url}/api/workbench/units`, json(body, { 'idempotency-key': `secret-${rel.replace(/[^A-Za-z0-9._-]/gu, '_')}` }));
      const text = await save.text();
      expect(save.status, `${rel} ${text}`).toBe(422);
      expect(text, rel).not.toContain(anthropic);
      expect(text, rel).not.toContain(aws);
    }
    // A clean text config is still saved.
    await writeFile(path.join(root, 'config', 'clean.json'), '{ "region": "eu" }\n');
    const clean = request({ paths: ['index.html', 'styles.css', 'app.js', 'assets/logo.png', 'assets/shot.png', 'config/clean.json'] });
    if (clean.source.kind === 'project') clean.source.expectedHashes!['config/clean.json'] = sha('{ "region": "eu" }\n');
    const cleanPlan = parseUnitSavePlan(await (await fetch(`${url}/api/workbench/units/plan`, json(clean))).json());
    expect(cleanPlan.blockers.map(item => item.code)).not.toContain('secret-detected');
  });

  it('keeps authority and scope: foreign projects, unknown projects and unbuilt draft sources are typed refusals', async () => {
    const { url } = await boot();
    const foreign = request(); if (foreign.source.kind === 'project') foreign.source.projectId = 'foreign';
    expect((await fetch(`${url}/api/workbench/units`, json(foreign, { 'idempotency-key': 'f', 'x-od-project-id': 'foreign' }))).status).toBe(403);
    const unknown = request(); if (unknown.source.kind === 'project') unknown.source.projectId = 'p9';
    expect((await fetch(`${url}/api/workbench/units`, json(unknown, { 'idempotency-key': 'u', 'x-od-project-id': 'p9' }))).status).toBe(404);
    const draft = await fetch(`${url}/api/workbench/units`, json({ source: { kind: 'draft', draftId: 'd1', revision: 1, rootSelector: '#hero' }, kind: 'section', name: 'Draft hero' }, { 'idempotency-key': 'd' }));
    expect(draft.status).toBe(422);
    expect((await errorOf(draft)).details.reason).toBe('unsupported-capability');
    // Saving needs the hashes the user reviewed; a plan does not.
    const unreviewed = request(); if (unreviewed.source.kind === 'project') delete unreviewed.source.expectedHashes;
    expect((await fetch(`${url}/api/workbench/units/plan`, json(unreviewed))).status).toBe(200);
    const blind = await fetch(`${url}/api/workbench/units`, json(unreviewed, { 'idempotency-key': 'blind' }));
    expect(blind.status).toBe(422);
    expect((await errorOf(blind)).details.reason).toBe('expected-hashes-required');
  });

  it('falls back to the capture as thumbnail when no browser can render, and says so', async () => {
    const { url, capture } = await boot({ renderThumbnail: async () => ({ unavailable: 'No compatible browser' }) });
    const unit = parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units`, json({ ...request(), captureId: capture.capture.id }, { 'idempotency-key': 't' }))).json());
    expect(unit.thumbnail).toEqual({ source: 'capture', captureId: capture.capture.id, assetId: capture.capture.assetId });
    const none = parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units`, json(request(), { 'idempotency-key': 't2' }))).json());
    expect(none.thumbnail).toEqual({ source: 'unavailable', reason: 'No compatible browser' });
  });

  it('refuses unit saves that carry a declaration from an agent tool token, and records the declaring surface', async () => {
    const { url, output, cli } = await boot();
    const agent = await fetch(`${url}/api/workbench/units`, json(request(), { 'idempotency-key': 'agent', authorization: 'Bearer od-tool-token-abc' }));
    expect(agent.status).toBe(403);
    expect((await errorOf(agent)).details.reason).toBe('agent-declaration-refused');
    expect(parseUnitList(await (await fetch(`${url}/api/workbench/units`)).json()).units).toEqual([]);

    const http = parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units`, json(request(), { 'idempotency-key': 'raw' }))).json());
    expect(http.rights.declaredVia).toBe('http');
    const web = parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units`, json(request(), { 'idempotency-key': 'web', 'sec-fetch-site': 'same-origin' }))).json());
    expect(web.rights.declaredVia).toBe('web');
    expect(await cli(['unit', 'save', '--input-file', '-', '--idempotency-key', 'cli-surface', '--json'], JSON.stringify(request()))).toBe(0);
    expect(parseReusableUnitManifest(output.pop()).rights.declaredVia).toBe('cli');
    const agentCli = await runWorkbenchCli(['unit', 'save', '--input-file', '-', '--json'], { env: { OD_DAEMON_URL: url, OD_TOOL_TOKEN: 'od-tool-token-abc', OD_TOOL_TOKEN_ISSUER_ORIGIN: url }, write: value => output.push(value), readStdin: async () => JSON.stringify(request()) });
    expect(agentCli).toBe(3);
    expect(output.pop()).toMatchObject({ status: 403, error: { details: { reason: 'agent-declaration-refused' } } });
  });

  it('od workbench unit plan/save/list/show use the same endpoints with idempotent saves', async () => {
    const { url, data, output, cli } = await boot();
    const input = path.join(data, 'unit.json'); await writeFile(input, JSON.stringify(request()));
    expect(await cli(['unit', 'plan', '--input-file', input, '--json'])).toBe(0);
    expect(parseUnitSavePlan(output.pop()).blockers).toEqual([]);
    expect(await cli(['unit', 'save', '--input-file', '-', '--idempotency-key', 'cli-1', '--json'], JSON.stringify(request()))).toBe(0);
    const saved = parseReusableUnitManifest(output.pop());
    expect(await cli(['unit', 'save', '--input-file', input, '--idempotency-key', 'cli-1', '--json'])).toBe(0);
    expect(parseReusableUnitManifest(output.pop())).toEqual(saved);
    expect(await cli(['unit', 'save', '--input-file', '-', '--idempotency-key', 'cli-1', '--json'], JSON.stringify({ ...request(), name: 'Other' }))).toBe(3);
    expect(output.pop()).toMatchObject({ status: 409 });
    expect(await cli(['unit', 'show', '--id', saved.unitId, '--json'])).toBe(0);
    expect(parseReusableUnitManifest(output.pop())).toEqual(parseReusableUnitManifest(await (await fetch(`${url}/api/workbench/units/${saved.unitId}`)).json()));
    expect(await cli(['unit', 'list', '--json'])).toBe(0);
    expect(parseUnitList(output.pop()).units.map(unit => unit.unitId)).toEqual([saved.unitId]);
    expect(await cli(['unit', 'save', '--input-file', '-', '--json'], '{"source":')).toBe(2);
  });
});
