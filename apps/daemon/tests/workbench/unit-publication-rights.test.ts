import express from 'express';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseUnitSaveRequest, parseUnitInsertRequest } from '@open-design/contracts';
import * as deploy from '../../src/deploy.js';
import { registerDeployRoutes, type RegisterDeployRoutesDeps } from '../../src/routes/deploy.js';
import { createUnitService } from '../../src/workbench/units/unit-service.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(privateOnly: boolean, licensed = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-rights-publication-'));
  roots.push(root);
  const projectsRoot = path.join(root, 'projects');
  const sourceRoot = path.join(projectsRoot, 'source');
  const targetRoot = path.join(projectsRoot, 'target');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic rights witness</title><link rel="stylesheet" href="style.css"></head><body><main>Locally authored synthetic fixture</main></body></html>';
  const sourceFiles = { 'index.html': html, 'style.css': 'body { color: #123456; }' };
  for (const [name, bytes] of Object.entries(sourceFiles)) await writeFile(path.join(sourceRoot, name), bytes);
  const units = createUnitService({
    dataDir: path.join(root, 'unit-data'),
    projectRoot: id => id === 'source' ? sourceRoot : id === 'target' ? targetRoot : null,
    isCapturedBytes: async () => false,
    readCapture: async () => null,
    renderThumbnail: async () => ({ unavailable: 'synthetic-no-renderer' }),
  });
  // The real schema, service, content-addressed store and save policy compute
  // the grant. No fabricated project metadata or hand-written lineage marker.
  const saveUnit = (privateOnly: boolean, key: string, licensedBasis = false) => units.save(parseUnitSaveRequest({
    source: { kind: 'project', projectId: 'source', paths: Object.keys(sourceFiles), rootSelector: 'body',
      expectedHashes: Object.fromEntries(Object.entries(sourceFiles).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) },
    kind: 'page', name: 'Synthetic rights witness',
    rightsDeclaration: licensedBasis
      ? { basis: 'licensed', evidenceRefs: ['licence:synthetic-finished-application-fixture'], notices: [] }
      : privateOnly
      ? { basis: 'model-authored', evidenceRefs: [], notices: [], privateUseAttestation: 'I may adapt this synthetic fixture privately' }
      : { basis: 'user-owned', evidenceRefs: ['owner:synthetic-publication-fixture'], notices: [] },
  }), 'local-daemon', key, 'http');
  const saved = await saveUnit(privateOnly, 'synthetic-save', licensed);
  const inserted = await units.insert('local-daemon', saved.manifest.unitId,
    parseUnitInsertRequest({ projectId: 'target', mode: 'standalone-artifact' }), 'synthetic-insert');
  expect(inserted.receipt.status).toBe('inserted');
  const lineage = JSON.parse(await readFile(path.join(targetRoot, inserted.receipt.directory, 'unit-lineage.json'), 'utf8'));
  expect(lineage.rights.status).toBe(licensed ? 'incorporation-only' : privateOnly ? 'private-use-only' : 'redistributable');
  expect(lineage.rights).toEqual({
    status: saved.manifest.rights.status,
    basis: saved.manifest.rights.basis,
    notices: saved.manifest.rights.notices,
    evidenceDigests: saved.manifest.rights.evidenceRefs.map(ref => createHash('sha256').update(ref).digest('hex')),
  });
  expect(saved.manifest.operationRights.find(right => right.operation === 'reuse-private-project')?.decision).toBe('allowed');
  expect(saved.manifest.operationRights.find(right => right.operation === 'redistribute-unit')?.decision).toBe(privateOnly || licensed ? 'blocked' : 'allowed');

  const providerCalls: Array<{ files: string[] }> = [];
  const fakePublish = vi.fn(async (input: { files: Array<{ file: string }> }) => {
    providerCalls.push({ files: input.files.map(file => file.file) });
    return { url: 'https://synthetic-rights.example.invalid', deploymentId: 'synthetic-only',
      target: 'preview', status: 'ready', access: 'public', statusMessage: 'Synthetic provider response' };
  });
  const app = express();
  app.use(express.json());
  registerDeployRoutes(app, {
    db: {}, paths: { PROJECTS_DIR: projectsRoot }, ids: { randomUUID: () => 'synthetic-deployment' },
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ code, message }) },
    projectStore: { getProject: () => ({ id: 'target', name: 'Synthetic rights witness' }) },
    authorizeProjectRequest: async () => ({ mode: 'local' }),
    deploy: { ...deploy,
      getDeployment: () => null, listDeployments: () => [],
      readDeployConfig: async () => ({ token: 'synthetic-not-a-credential', accountId: 'synthetic', projectName: 'synthetic' }),
      upsertDeployment: (_db: unknown, value: unknown) => value,
      publicDeployment: (value: unknown) => value,
      deployToVercel: fakePublish, deployToCloudflarePages: fakePublish,
    },
  } as unknown as RegisterDeployRoutesDeps);
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server address missing');
  const origin = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  const unexpectedOutbound: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) {
      unexpectedOutbound.push(new URL(url).origin);
      throw new Error('Synthetic witness blocked unexpected outbound request');
    }
    return nativeFetch(input, init);
  });
  const request = (suffix: string, fileName = inserted.receipt.entryPath) => fetch(`${origin}/api/projects/target/deploy${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName, providerId: 'vercel-self', target: 'preview', publicAccess: true }),
  });
  return { request, providerCalls, unexpectedOutbound, entryPath: inserted.receipt.entryPath, receipt: inserted.receipt, targetRoot, units, saveUnit };
}

it('P3-07.5/P3-13.5 blocks authentic private-use unit publication before provider calls', async () => {
  const witness = await fixture(true);
  const preflight = await witness.request('/preflight');
  const preflightBody = await preflight.json();
  expect.soft(preflight.status, JSON.stringify({ gate: 'preflight', body: preflightBody })).toBe(403);
  expect.soft(preflightBody).toEqual({ code: 'PUBLICATION_RIGHTS_BLOCKED', message: 'Private-use content cannot be published. Use content with public-use permission.' });
  expect.soft(witness.providerCalls).toHaveLength(0);
  const publication = await witness.request('');
  const publicationBody = await publication.json();
  expect.soft(publication.status, JSON.stringify({ gate: 'publication', body: publicationBody })).toBe(403);
  expect.soft(publicationBody).toEqual({ code: 'PUBLICATION_RIGHTS_BLOCKED', message: 'Private-use content cannot be published. Use content with public-use permission.' });
  expect.soft(witness.providerCalls, 'Public-use denial must happen before mocked provider invocation').toHaveLength(0);
  expect(witness.unexpectedOutbound).toEqual([]);
});

it('blocks a private inserted stylesheet in the actual closure of an ordinary owned entry', async () => {
  const witness = await fixture(true);
  await writeFile(path.join(witness.targetRoot, 'public.html'), `<html><head><link rel="stylesheet" href="${witness.receipt.directory}/style.css"></head><body>Owned entry</body></html>`);
  for (const suffix of ['/preflight', '']) {
    const response = await witness.request(suffix, 'public.html');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'PUBLICATION_RIGHTS_BLOCKED', message: 'Private-use content cannot be published. Use content with public-use permission.' });
  }
  expect(witness.providerCalls).toHaveLength(0);
  expect(witness.unexpectedOutbound).toEqual([]);
});

it('checks resolved private-unit ancestry behind an innocent stylesheet alias', async () => {
  const witness = await fixture(true);
  await symlink(path.join(witness.targetRoot, witness.receipt.directory, 'style.css'), path.join(witness.targetRoot, 'public-style.css'));
  await writeFile(path.join(witness.targetRoot, 'public.html'), '<html><head><link rel="stylesheet" href="public-style.css"></head><body>Owned entry</body></html>');
  const response = await witness.request('', 'public.html');
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'PUBLICATION_RIGHTS_BLOCKED' });
  expect(witness.providerCalls).toHaveLength(0);
});

it('checks inner private lineage even when an enclosing inserted unit is owned', async () => {
  const witness = await fixture(false);
  const privateUnit = await witness.saveUnit(true, 'synthetic-inner-save');
  const inner = await witness.units.insert('local-daemon', privateUnit.manifest.unitId,
    parseUnitInsertRequest({ projectId: 'target', mode: 'standalone-artifact' }), 'synthetic-inner-insert');
  const nested = path.join(witness.targetRoot, witness.receipt.directory, 'nested');
  await mkdir(nested);
  await rename(path.join(witness.targetRoot, inner.receipt.directory), path.join(nested, inner.receipt.directory));
  await writeFile(path.join(witness.targetRoot, witness.entryPath), `<html><head><link rel="stylesheet" href="nested/${inner.receipt.directory}/style.css"></head><body>Owned outer entry</body></html>`);
  const response = await witness.request('');
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'PUBLICATION_RIGHTS_BLOCKED' });
  expect(witness.providerCalls).toHaveLength(0);
});

it('does not block an owned publication because an unused private insertion exists elsewhere', async () => {
  const witness = await fixture(true);
  await writeFile(path.join(witness.targetRoot, 'public.html'), '<html><body>Independent owned content</body></html>');
  expect((await witness.request('/preflight', 'public.html')).status).toBe(200);
  expect((await witness.request('', 'public.html')).status).toBe(200);
  expect(witness.providerCalls).toHaveLength(1);
});

it('fails closed with a safe typed error for malformed carried insertion provenance', async () => {
  const witness = await fixture(false);
  await writeFile(path.join(witness.targetRoot, witness.receipt.directory, 'unit-lineage.json'), '{"syntheticCanary":"PRIVATE_LINEAGE_TEST_CANARY"');
  for (const suffix of ['/preflight', '']) {
    const response = await witness.request(suffix);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'PUBLICATION_RIGHTS_UNVERIFIED', message: 'Publication rights could not be verified. Restore valid insertion provenance before publishing.' });
  }
  expect(witness.providerCalls).toHaveLength(0);
});

it('does not infer restricted rights from an ordinary user directory name', async () => {
  const witness = await fixture(false);
  const directory = 'unit-insert-my-owned-page';
  await mkdir(path.join(witness.targetRoot, directory));
  await writeFile(path.join(witness.targetRoot, directory, 'index.html'), '<html><body>Ordinary owned page</body></html>');
  expect((await witness.request('', `${directory}/index.html`)).status).toBe(200);
  expect(witness.providerCalls).toHaveLength(1);
});

it('allows an owned Unicode format filename through HTTP preflight and publication', async () => {
  const witness = await fixture(false);
  const fileName = 'owned\u200d.html';
  await writeFile(path.join(witness.targetRoot, fileName), '<html><body>Ordinary owned Unicode page</body></html>');
  expect.soft((await witness.request('/preflight', fileName)).status).toBe(200);
  expect.soft(witness.providerCalls).toHaveLength(0);
  expect.soft((await witness.request('', fileName)).status).toBe(200);
  expect.soft(witness.providerCalls).toHaveLength(1);
  expect(witness.unexpectedOutbound).toEqual([]);
});

it('preserves traversal and resolved containment rejection before deployment transport', async () => {
  const witness = await fixture(false);
  const outsideFile = path.join(path.dirname(witness.targetRoot), 'escape.html');
  await writeFile(outsideFile, '<html><body>SYNTHETIC_OUTSIDE_PROJECT_CANARY</body></html>');
  await symlink(outsideFile, path.join(witness.targetRoot, 'escape-alias.html'));
  for (const fileName of ['../escape.html', 'escape-alias.html']) {
    for (const suffix of ['/preflight', '']) {
      const response = await witness.request(suffix, fileName);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain('SYNTHETIC_OUTSIDE_PROJECT_CANARY');
    }
  }
  expect(witness.providerCalls).toHaveLength(0);
  expect(witness.unexpectedOutbound).toEqual([]);
});

it('refuses invalid evidence digests without exposing the carried provenance', async () => {
  const witness = await fixture(false);
  const marker = path.join(witness.targetRoot, witness.receipt.directory, 'unit-lineage.json');
  const lineage = JSON.parse(await readFile(marker, 'utf8'));
  lineage.rights.evidenceDigests = ['INVALID_EVIDENCE_DIGEST_CANARY'];
  await writeFile(marker, JSON.stringify(lineage));
  const response = await witness.request('');
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: 'PUBLICATION_RIGHTS_UNVERIFIED', message: 'Publication rights could not be verified. Restore valid insertion provenance before publishing.' });
  expect(witness.providerCalls).toHaveLength(0);
});

it.each([
  { label: 'owned', licensed: false },
  { label: 'licensed incorporation-only', licensed: true },
])('allows the equivalent $label unit through mocked finished-application publication', async ({ licensed }) => {
  const witness = await fixture(false, licensed);
  expect((await witness.request('/preflight')).status).toBe(200);
  expect(witness.providerCalls).toHaveLength(0);
  expect((await witness.request('')).status).toBe(200);
  expect(witness.providerCalls).toHaveLength(1);
  expect(witness.providerCalls[0]?.files).toContain('index.html');
  expect(witness.unexpectedOutbound).toEqual([]);
});
