import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { parseOwnedImportRecord } from '@mish/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchOwnedImportRoutes } from '../../src/routes/workbench-owned-imports.js';
import { searchResources } from '../../src/workbench/resources.js';
import { OwnedImportStore, createOwnedImportMaterials, createOwnedImportResourceSource, migrateOwnedImports } from '../../src/workbench/owned-imports/owned-imports.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { adoptionFixture, adoptionServer, closeAll, post } from './adoption-route-fixture.js';

/**
 * AC-R12.4 (Q7 A): an owner-provided Magic Patterns export imports with no provider
 * account, MCP or generation. The import keeps exact file and artifact hashes, labels
 * placeholder data and actions, previews in an isolated document, reopens after a
 * restart, applies into a project, survives an edit, is reused in a second project
 * and undone there without touching the first. Same routes through UI and od.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => closeAll(servers, roots));

const HTML = '<!doctype html>\n<html><head><link rel="stylesheet" href="styles.css"></head>\n<body>\n<h1>Lorem ipsum dolor</h1>\n<a href="#">Get started</a>\n<button onclick="alert(\'TODO\')">Book a demo</button>\n<img src="https://via.placeholder.com/640x480" alt="">\n<script src="app.js"></script>\n</body></html>\n';
const CSS = 'h1 { font: 600 2rem/1.1 system-ui; }\n';
const JS = 'document.querySelector("button")?.addEventListener("click", () => console.log("clicked"));\n';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const request = {
  provider: 'magic-patterns', name: 'Booking landing export', entryPath: 'index.html',
  ownership: { declaration: 'owner-provided-export', exportedFrom: null },
  files: [{ path: 'index.html', contentBase64: b64(HTML) }, { path: 'styles.css', contentBase64: b64(CSS) }, { path: 'app.js', contentBase64: b64(JS) }],
};

async function setup() {
  const f = adoptionFixture(roots);
  migrateOwnedImports(f.db);
  const store = new OwnedImportStore(f.db);
  const resourceSource = createOwnedImportResourceSource(store);
  const url = await adoptionServer(servers, f, { materials: [createOwnedImportMaterials(store)], sources: [resourceSource] });
  const app = express(); app.use(express.json({ limit: '8mb' }));
  registerWorkbenchOwnedImportRoutes(app, { store, http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(done => server.once('listening', done));
  const importsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { f, store, url, importsUrl, resourceSource };
}

describe('owner-provided Magic Patterns import (AC-R12.4)', () => {
  it('records exact file and artifact hashes, labels placeholders and needs no provider account', async () => {
    const { importsUrl } = await setup();
    const created = await post(`${importsUrl}/api/workbench/imports`, request);
    expect(created.status).toBe(201);
    const record = parseOwnedImportRecord(created.body);
    expect(record.files.map(file => [file.path, file.sha256, file.bytes])).toEqual([
      ['app.js', sha(JS), Buffer.byteLength(JS)], ['index.html', sha(HTML), Buffer.byteLength(HTML)], ['styles.css', sha(CSS), Buffer.byteLength(CSS)],
    ]);
    expect(record.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.provenance).toMatchObject({ origin: 'owned', acquisition: 'owner-provided-local-file', providerAccountUsed: false, providerMcpUsed: false });
    const kinds = record.placeholders.map(item => `${item.path}:${item.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(['index.html:placeholder-text', 'index.html:placeholder-link', 'index.html:placeholder-action', 'index.html:placeholder-media', 'app.js:placeholder-action']));
    for (const item of record.placeholders) expect(item.line).toBeGreaterThan(0);
  });

  it('refuses an entry outside the files, a traversal path and an unknown provider', async () => {
    const { importsUrl } = await setup();
    expect((await post(`${importsUrl}/api/workbench/imports`, { ...request, entryPath: 'missing.html' })).status).toBe(400);
    expect((await post(`${importsUrl}/api/workbench/imports`, { ...request, files: [...request.files, { path: '../escape.js', contentBase64: b64('x') }] })).status).toBe(400);
    expect((await post(`${importsUrl}/api/workbench/imports`, { ...request, provider: 'figma' })).status).toBe(400);
  });

  it('reopens after a restart with the same provenance and previews in an isolated document', async () => {
    const { f, importsUrl } = await setup();
    const record = parseOwnedImportRecord((await post(`${importsUrl}/api/workbench/imports`, request)).body);
    const reopened = new OwnedImportStore(f.db).read('local-owner', record.id);
    expect(reopened).toEqual(record);
    const shown = await (await fetch(`${importsUrl}/api/workbench/imports/${record.id}`)).json();
    expect(shown).toEqual(record);
    const list = await (await fetch(`${importsUrl}/api/workbench/imports`)).json() as { imports: { id: string }[] };
    expect(list.imports.map((item: { id: string }) => item.id)).toEqual([record.id]);
    const preview = await fetch(`${importsUrl}/api/workbench/imports/${record.id}/files/index.html`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await preview.text()).toBe(HTML);
    expect((await fetch(`${importsUrl}/api/workbench/imports/${record.id}/files/..%2Fapp.sqlite`)).status).toBe(404);
  });

  it('serves a stored file whose name holds a literal escape or a space from the advertised preview URL', async () => {
    const { importsUrl, resourceSource } = await setup();
    const literal = 'page%20v1.html';
    const spaced = 'pages/a b.html';
    const created = await post(`${importsUrl}/api/workbench/imports`, { ...request, entryPath: literal, files: [
      { path: literal, contentBase64: b64('<p>literal</p>') }, { path: spaced, contentBase64: b64('<p>spaced</p>') },
      { path: 'page v1.html', contentBase64: b64('<p>decoded twice</p>') },
    ] });
    expect(created.status).toBe(201);
    const record = parseOwnedImportRecord(created.body);
    const item = (await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'local-daemon' }, [resourceSource])).results.find(result => result.ref.itemId === record.id)!;
    const advertised = item.previewCapability.url!;
    expect(advertised).toBe(`/api/workbench/imports/${record.id}/files/page%2520v1.html`);
    const entry = await fetch(`${importsUrl}${advertised}`);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe('<p>literal</p>');
    const nested = await fetch(`${importsUrl}/api/workbench/imports/${record.id}/files/${spaced.split('/').map(encodeURIComponent).join('/')}`);
    expect(await nested.text()).toBe('<p>spaced</p>');
  });

  it('appears in workbench search as an owned, previewable resource with incorporation and private reuse permitted', async () => {
    const { importsUrl, resourceSource } = await setup();
    const record = parseOwnedImportRecord((await post(`${importsUrl}/api/workbench/imports`, request)).body);
    const found = await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'local-daemon' }, [resourceSource]);
    const item = found.results.find(result => result.ref.itemId === record.id)!;
    expect(item).toMatchObject({ rightsStatus: 'permitted', implementationOrigin: 'owned', readiness: 'unverified', previewCapability: { available: true, kind: 'html' } });
    expect(item.ref.revisionOrDigest).toBe(`sha256:${record.artifactSha256}`);
    expect(item.operationGrants.filter(grant => grant.state === 'permitted').map(grant => grant.operation).sort()).toEqual(['incorporation', 'private-reuse', 'private-save']);
    expect(item.fitReasons.join(' ')).toMatch(/placeholder/i);
    const other = await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'workspace:w1:m2' }, [resourceSource]);
    expect(other.results).toHaveLength(0);
  });

  it('applies, keeps an edit, reuses in a second project and undoes there without touching the first', async () => {
    const { f, url, importsUrl, resourceSource } = await setup();
    const record = parseOwnedImportRecord((await post(`${importsUrl}/api/workbench/imports`, request)).body);
    const item = (await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'local-daemon' }, [resourceSource])).results[0]!;
    const apply = async (projectId: string) => {
      const prepared = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId, refKey: item.refKey, entryPath: 'src/App.tsx' });
      expect(prepared.status).toBe(201);
      expect(prepared.body.plan.source.implementationOrigin).toBe('owned');
      const applied = await post(`${url}/api/workbench/adoption/apply`, { planId: prepared.body.plan.id, planDigest: prepared.body.plan.digest });
      expect(applied.body.operation.state).toBe('done');
      return applied.body.operation.operationId as string;
    };
    const original = f.tree('p1');
    const first = await apply('p1');
    expect(f.tree('p1')['src/index.html']).toBe(HTML);
    const notice = f.tree('p1')[`src/NOTICE.magic-patterns-${record.id}.md`]!;
    expect(notice).toContain(record.artifactSha256);
    expect(notice).toMatch(/placeholder-action/);
    expect((await post(`${url}/api/workbench/adoption/operations/${first}/undo`, {})).body.operation.state).toBe('done');
    expect(f.tree('p1')).toEqual(original);

    await apply('p1');
    writeFileSync(join(f.projects.p1!, 'src', 'index.html'), HTML.replace('Lorem ipsum dolor', 'Book your visit'));
    const edited = f.tree('p1');
    const beforeSecond = f.tree('p2');
    const second = await apply('p2');
    expect(f.tree('p2')['src/index.html']).toBe(HTML);
    expect((await post(`${url}/api/workbench/adoption/operations/${second}/undo`, {})).body.operation.state).toBe('done');
    expect(f.tree('p2')).toEqual(beforeSecond);
    expect(f.tree('p1')).toEqual(edited);
  });

  it('a hand-written plan cannot claim Magic Patterns provenance without a recorded import', async () => {
    const { f, url } = await setup();
    const forged = await post(`${url}/api/workbench/adoption/prepare`, {
      projectId: 'p1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned', resourceRef: { sourceType: 'library', sourceId: 'magic-patterns', itemId: 'forged', revisionOrDigest: `sha256:${'a'.repeat(64)}` } },
      writes: [{ path: 'src/App.tsx', role: 'entry', contentBase64: b64('export default 1;\n') }],
    });
    expect(forged.status).toBe(422);
    expect(forged.body.error.details.reason).toBe('owned-import-required');
    expect(f.storedPlans()).toBe(0);
  });

  it("a team member's import, made over HTTP or od, is that member's in search and apply", async () => {
    const { f, url, importsUrl, resourceSource } = await setup();
    const member = { 'x-od-workspace-id': 'w1', 'x-od-workspace-type': 'team', 'x-od-workspace-member-id': 'm2' };
    const viaHttp = parseOwnedImportRecord((await post(`${importsUrl}/api/workbench/imports`, request, member)).body);
    expect(viaHttp.principalId).toBe('member:m2');
    const dir = join(f.root, 'member-export'); mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), HTML); writeFileSync(join(dir, 'styles.css'), CSS); writeFileSync(join(dir, 'app.js'), JS);
    let body: any;
    const code = await runWorkbenchCli(['import', 'create', '--provider', 'magic-patterns', '--name', 'Member export', '--entry', 'index.html', '--dir', dir, '--workspace', 'w1', '--workspace-member', 'm2', '--json'], { baseUrl: importsUrl, write: value => { body = value; } });
    expect(code).toBe(0);
    expect(parseOwnedImportRecord(body).principalId).toBe('member:m2');
    let listed: any;
    expect(await runWorkbenchCli(['import', 'list', '--workspace', 'w1', '--workspace-member', 'm2', '--json'], { baseUrl: importsUrl, write: value => { listed = value; } })).toBe(0);
    expect(listed.imports.map((item: { id: string }) => item.id).sort()).toEqual([viaHttp.id, parseOwnedImportRecord(body).id].sort());
    expect(await runWorkbenchCli(['import', 'list', '--workspace', 'w1', '--json'], { baseUrl: importsUrl, write: () => undefined })).toBe(2);

    const forMember = await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'workspace:w1:m2' }, [resourceSource]);
    expect(forMember.results.map(result => result.ref.itemId).sort()).toEqual(listed.imports.map((item: { id: string }) => item.id).sort());
    expect((await searchResources({ query: '', facets: { sourceIds: ['magic-patterns'] }, limit: 20 }, { principalId: 'local-daemon' }, [resourceSource])).results).toHaveLength(0);
    const item = forMember.results.find(result => result.ref.itemId === viaHttp.id)!;
    const prepared = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey: item.refKey, entryPath: 'src/App.tsx' }, member);
    expect(prepared.status).toBe(201);
    expect(prepared.body.plan.source.implementationOrigin).toBe('owned');
  });

  it('od creates, lists and shows the same records through the same routes', async () => {
    const { f, importsUrl } = await setup();
    const dir = join(f.root, 'export'); mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), HTML); writeFileSync(join(dir, 'styles.css'), CSS); writeFileSync(join(dir, 'app.js'), JS);
    const od = async (args: string[]) => { let body: any; const code = await runWorkbenchCli(['import', ...args, '--json'], { baseUrl: importsUrl, write: value => { body = value; } }); return { code, body }; };
    const created = await od(['create', '--provider', 'magic-patterns', '--name', 'Booking landing export', '--entry', 'index.html', '--dir', dir]);
    expect(created.code).toBe(0);
    const record = parseOwnedImportRecord(created.body);
    expect(record.files.map(file => file.sha256)).toEqual([sha(JS), sha(HTML), sha(CSS)]);
    const shown = await od(['show', '--id', record.id]);
    expect(shown.body).toEqual(await (await fetch(`${importsUrl}/api/workbench/imports/${record.id}`)).json());
    expect((await od(['list'])).body.imports).toHaveLength(1);
    expect((await od(['show', '--id', 'missing-import'])).code).toBe(3);
  });
});
