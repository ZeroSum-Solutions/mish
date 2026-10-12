import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorResponse, CreateProjectResponse, DeployPreflightResponse, ProjectFileResponse, ProjectFileVersionsResponse, UploadProjectFilesResponse } from '@open-design/contracts';
import { startServer } from '../src/server.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=', 'base64');
describe('native Agency Site image replacement', () => {
  let server: http.Server; let base: string;
  beforeAll(async () => { const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server }; base = started.url; server = started.server; });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function project(skillId: string | null = 'agency-site') {
    const result = await post('/api/projects', { id: randomUUID(), name: 'Image replacement proof', skillId });
    expect(result.ok).toBe(true);
    return (await result.json() as CreateProjectResponse).project.id;
  }
  async function upload(id: string, imageArtifact = 'site.html', bytes = png) {
    const form = new FormData(); form.append('imageArtifact', imageArtifact);
    form.append('files', new Blob([bytes], { type: 'image/png' }), 'My replacement.PNG');
    return fetch(`${base}/api/projects/${id}/upload`, { method: 'POST', body: form });
  }
  const manifest = { version: 1, kind: 'html', renderer: 'html', entry: 'site.html', sourceSkillId: 'agency-site', exports: ['html'], supportingFiles: [], metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', revision: 'r1', rendererVersion: '1.0.0', recipeDigest: 'a'.repeat(64) } } };
  it('uploads, saves, preserves manual edits and history, and preflights only declared public files', async () => {
    const id = await project(); const fileRoute = `/api/projects/${id}/files`;
    expect((await post(fileRoute, { name: 'site.html', content: '<h1>Manual copy stays</h1><img data-od-id="hero" src="old.png">', artifactManifest: manifest })).ok).toBe(true);
    expect((await post(fileRoute, { name: 'brief.md', content: 'Private client brief' })).ok).toBe(true);
    const uploaded = await upload(id); expect(uploaded.status).toBe(200);
    const image = (await uploaded.json() as UploadProjectFilesResponse).files[0]!.path!;
    expect(image).toMatch(/^assets\/agency-site\/r1\/image-[a-f0-9-]+\.png$/);
    const content = `<h1>Manual copy stays</h1><img data-od-id="hero" src="${image}">`;
    const saved = await post(fileRoute, { name: 'site.html', content, artifactManifest: manifest, versionSource: 'manual', agencyImagePath: image });
    expect(saved.status).toBe(200);
    expect((await saved.json() as ProjectFileResponse).file.artifactManifest?.supportingFiles).toEqual([image]);
    const later = await post(fileRoute, { name: 'site.html', content: content.replace('Manual copy stays', 'Later copy'), artifactManifest: manifest, versionSource: 'manual' });
    expect(later.status).toBe(200);
    expect((await later.json() as ProjectFileResponse).file.artifactManifest?.supportingFiles).toEqual([image]);
    expect(await (await fetch(`${base}/api/projects/${id}/raw/site.html`)).text()).toContain('Later copy');
    const versions = await (await fetch(`${base}/api/projects/${id}/files/site.html/versions`)).json() as ProjectFileVersionsResponse;
    expect(versions.versions.length).toBeGreaterThanOrEqual(3);
    const preflight = await post(`/api/projects/${id}/deploy/preflight`, { fileName: 'site.html' });
    expect(preflight.status).toBe(200);
    expect((await preflight.json() as DeployPreflightResponse).files.map((file) => file.path)).toEqual(['index.html', image]);
  });
  it('rejects missing manifest or invalid bytes without returning an uploaded asset', async () => {
    const id = await project();
    expect((await upload(id)).status).toBe(400);
    expect((await post(`/api/projects/${id}/files`, { name: 'site.html', content: '<h1>Agency</h1>', artifactManifest: manifest })).ok).toBe(true);
    const invalid = await upload(id, 'site.html', Buffer.from('<svg/>'));
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as ApiErrorResponse).error.code).toBe('AGENCY_IMAGE_INVALID');
    expect((await upload(id, '../site.html')).status).toBe(400);
  });
  it('keeps ordinary project uploads and image saves unchanged despite the owner hint', async () => {
    const id = await project(null); const uploaded = await upload(id);
    expect(uploaded.status).toBe(200);
    const image = (await uploaded.json() as UploadProjectFilesResponse).files[0]!.path!;
    expect(image).not.toContain('assets/agency-site');
    expect((await post(`/api/projects/${id}/files`, { name: 'site.html', content: `<img src="${image}">`, versionSource: 'manual', agencyImagePath: image })).ok).toBe(true);
  });
});
