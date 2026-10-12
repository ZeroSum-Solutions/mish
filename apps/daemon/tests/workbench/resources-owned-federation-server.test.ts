import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseResourceDetailResponse, parseResourceSearchResponse, type ResourceDetailResponse, type ResourceSearchResponse } from '@mish/contracts';
import { startServer } from '../../src/server.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { eligibleTokenKind } from '../../src/workbench/context-ranking.js';
import { booking, savedContext } from './context-ranking-fixture.js';

const dentistryQuery = 'Build a calm premium dentistry landing page where new patients book their first appointment and fill out an intake form';
function draft() {
  const { schema: _schema, projectId: _projectId, revision: _revision, updatedAt: _updatedAt, ...rest } = savedContext({
    purpose: 'Convert new dental patients into first appointments', audience: ['Adults looking for a new dentist'],
    brandDirection: 'Calm, premium dental care', spineCode: 'SM', conversions: [booking],
  });
  return rest;
}

describe('B5-2 owned-resource federation on a real daemon', () => {
  let started: { url: string; server: Server; shutdown?: () => Promise<void> | void };
  let projectId: string; let otherProjectId: string;
  const post = (url: string, body: unknown, method = 'POST') => fetch(`${started.url}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const search = async (body: Record<string, unknown>) => {
    const response = await post('/api/workbench/resources/search', body);
    expect(response.status).toBe(200);
    return parseResourceSearchResponse(await response.json());
  };
  beforeAll(async () => {
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    for (const name of ['Owned federation', 'Other project']) {
      const created = await post('/api/projects', { id: randomUUID(), name, skillId: null });
      expect(created.ok).toBe(true);
      const id = (await created.json() as { project: { id: string } }).project.id;
      if (name === 'Owned federation') projectId = id; else otherProjectId = id;
    }
    // W3: both projects carry the SAME stylesheet and brief, so equal revisions cannot mask a cross-project leak.
    for (const id of [projectId, otherProjectId]) {
      expect((await post(`/api/projects/${id}/files`, { name: 'styles/tokens.css', content: ':root { --color-bg: #ffffff; --color-text: #14213d; --text-base: 1rem; --space-4: 16px; }' })).ok).toBe(true);
      const saved = await post(`/api/workbench/projects/${id}/context`, { expectedRevision: 0, draft: draft() }, 'PUT');
      expect(saved.status).toBe(200);
    }
  });
  afterAll(async () => {
    await Promise.resolve(started.shutdown?.());
    if (started.server.listening) await new Promise<void>(resolve => started.server.close(() => resolve()));
  });

  it('AC-R04.1: project-tokens, brief-derived-tokens and design-md leave not-federated with counts and digests', async () => {
    const response = await search({ projectId, useProjectContext: false, facets: { sourceIds: ['project-tokens', 'brief-derived-tokens', 'design-md'] }, limit: 100 });
    for (const sourceId of ['project-tokens', 'brief-derived-tokens', 'design-md'] as const) {
      const status = response.sourceStatuses.find(entry => entry.sourceId === sourceId)!;
      expect(status.state, sourceId).toBe('searched');
      expect(status.itemCount, sourceId).toBeGreaterThan(0);
      expect(status.listingDigest, sourceId).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(response.results.every(item => item.readiness !== 'usable' && !item.adoptionCapability.available)).toBe(true);
    expect(response.results.filter(item => item.ref.sourceId === 'design-md').every(item => item.readiness === 'reference-only')).toBe(true);
  });

  it('AC-R05.2: the dentistry contextual query returns CTA/layout plus an eligible colour and sizing resource grounded in the saved brief', async () => {
    const response = await search({ projectId, query: dentistryQuery, limit: 20 });
    expect(response.context).toMatchObject({ applied: true, resultMode: 'ranked' });
    expect(response.results.some(item => ['cta-band', 'booking-availability'].includes(item.sectionKind ?? ''))).toBe(true);
    const colour = response.results.find(item => eligibleTokenKind(item) === 'color');
    const sizing = response.results.find(item => eligibleTokenKind(item) === 'sizing');
    expect(colour?.ref.sourceId).toMatch(/^(brief-derived-tokens|project-tokens)$/);
    expect(sizing).toBeTruthy();
    expect(colour!.fitReasons.join('\n')).toMatch(/saved brief|this project/);
  });

  it('AC-R07.3: owned token cohorts preview through the static specimen route; another project cannot read them', async () => {
    const response = await search({ projectId, useProjectContext: false, facets: { sourceIds: ['brief-derived-tokens', 'project-tokens'] }, limit: 100 });
    expect(response.results.length).toBeGreaterThanOrEqual(4);
    for (const item of response.results) {
      // The web harness fetches headerless and refuses redirects; do the same.
      const preview = await fetch(`${started.url}${item.previewCapability.url}`, { redirect: 'manual' });
      expect(preview.status, item.ref.itemId).toBe(200);
      expect(preview.headers.get('content-type')).toContain('text/html');
      expect(preview.headers.get('content-security-policy')).toContain("default-src 'none'");
      // Direct navigation to the document stays sandboxed; the web harness drops this directive and applies its own iframe sandbox.
      expect(preview.headers.get('content-security-policy')).toMatch(/(^|;)\s*sandbox\s*(;|$)/);
    }
    // W3: the other project lists its own owned items, yet none of the first project's refs resolve there.
    const other = await search({ projectId: otherProjectId, useProjectContext: false, facets: { sourceIds: ['brief-derived-tokens', 'project-tokens'] }, limit: 100 });
    expect(other.results.length).toBe(response.results.length);
    expect(other.results.map(item => item.ref.revisionOrDigest).sort()).toEqual(response.results.map(item => item.ref.revisionOrDigest).sort());
    for (const item of response.results) {
      expect((await fetch(`${started.url}/api/workbench/resources/${item.refKey}?projectId=${otherProjectId}`)).status, item.ref.itemId).toBe(404);
      expect((await fetch(`${started.url}/api/workbench/resources/${item.refKey}/preview?projectId=${otherProjectId}`)).status, item.ref.itemId).toBe(404);
    }
    const noPreviewDoc = response.results.length ? await fetch(`${started.url}/api/workbench/resources/${(await search({ facets: { sourceIds: ['sections'] }, limit: 1 })).results[0]!.refKey}/preview`) : null;
    expect(noPreviewDoc?.status).toBe(404);
  });

  it('UI/CLI parity: od workbench search and inspect return the same owned resources through the same endpoints', async () => {
    const promptFile = path.join(mkdtempSync(path.join(tmpdir(), 'od-b52-cli-')), 'query.txt');
    writeFileSync(promptFile, dentistryQuery);
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--project', projectId, '--prompt-file', promptFile, '--limit', '20', '--json'], { baseUrl: started.url, write: value => output.push(value) })).toBe(0);
    const cli = output[0] as ResourceSearchResponse;
    const http = await search({ projectId, query: dentistryQuery, limit: 20 });
    expect(cli.results.map(item => item.refKey)).toEqual(http.results.map(item => item.refKey));
    const owned = cli.results.find(item => eligibleTokenKind(item) !== null)!;
    expect(await runWorkbenchCli(['inspect', '--ref', owned.refKey, '--project', projectId, '--json'], { baseUrl: started.url, write: value => output.push(value) })).toBe(0);
    const inspected = output[1] as ResourceDetailResponse;
    const viaHttp = parseResourceDetailResponse(await (await fetch(`${started.url}/api/workbench/resources/${owned.refKey}?projectId=${projectId}`)).json());
    expect(inspected).toEqual(viaHttp);
    expect(inspected.resource.ref).toEqual(owned.ref);
  });

  it('UI/CLI parity W2: od workbench preview reads the same specimen endpoint as the Enlarge view, in JSON and text', async () => {
    const response = await search({ projectId, useProjectContext: false, facets: { sourceIds: ['project-tokens'], category: 'color-palette' }, limit: 1 });
    const palette = response.results[0]!;
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['preview', '--ref', palette.refKey, '--project', projectId, '--json'], { baseUrl: started.url, write: value => output.push(value) })).toBe(0);
    expect(output[0]).toMatchObject({ ref: palette.ref, title: expect.any(String), category: 'color-palette', tokens: [{ name: '--color-bg', value: '#ffffff' }, { name: '--color-text', value: '#14213d' }] });
    const html = await (await fetch(`${started.url}${palette.previewCapability.url}`)).text();
    for (const token of (output[0] as { tokens: Array<{ name: string; value: string }> }).tokens) expect(html).toContain(token.name);
    expect(await runWorkbenchCli(['preview', '--ref', palette.refKey, '--project', projectId], { baseUrl: started.url, write: value => output.push(value) })).toBe(0);
    expect(typeof output[1]).toBe('string');
    expect(output[1]).toMatch(/--color-text\s+#14213d/);
    // Same refusals as the endpoint: another project's scope cannot read it.
    expect(await runWorkbenchCli(['preview', '--ref', palette.refKey, '--project', otherProjectId, '--json'], { baseUrl: started.url, write: value => output.push(value) })).toBe(3);
    expect(output[2]).toMatchObject({ status: 404 });
  });
});
