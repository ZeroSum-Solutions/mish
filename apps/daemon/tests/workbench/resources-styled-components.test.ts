import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseResourceDetailResponse, parseResourceSearchRequest, type ResourceCandidate } from '@open-design/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { inspectResource, searchResources, type ResourceSourceAdapter } from '../../src/workbench/resources.js';

/**
 * Sol r07 BLOCK: the styled-components readiness check must run for a real kit preview, not
 * only when a caller happens to pass the adapter. Classification happens once, where every
 * source's items enter the workbench: a preview whose resource declares a styled-components
 * target dependency is a `styled-components` preview, so its Enlarge view is ready only after
 * the runtime has injected styles. React95 (batch 7+8) flows through the same rule.
 */
const context = { principalId: 'local-daemon' };
function kitItem(itemId: string, overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return {
    ref: { sourceType: 'library', sourceId: 'react95', itemId, revisionOrDigest: `sha256:${itemId}` },
    title: `Kit ${itemId}`, category: 'component', readiness: 'unverified',
    compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'unverified', reason: null },
    rightsStatus: 'permitted', fitReasons: [],
    previewCapability: { available: true, kind: 'html', url: `/api/workbench/resources/${itemId}/preview`, reason: null },
    adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
    sourceAttribution: { title: 'Fixture styled-components kit' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Fixture',
    targetDependencies: [{ name: 'react', range: '^18', scope: 'project' }, { name: 'styled-components', range: '^6.1.0', scope: 'project' }],
    ...overrides,
  };
}
const fixtureKit: ResourceSourceAdapter = {
  sourceId: 'react95',
  async list() {
    const items = [
      kitItem('window'),
      kitItem('button', { previewCapability: { available: true, kind: 'html', url: '/api/workbench/resources/button/preview', reason: null, adapter: 'html-document' } }),
      kitItem('plain', { targetDependencies: [{ name: 'react', range: '^18', scope: 'project' }] }),
      kitItem('no-preview', { previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' } }),
    ];
    return { items, status: { sourceId: 'react95', state: 'searched', reason: null, itemCount: items.length, listingDigest: 'fixture' } };
  },
};

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done())))); });

describe('styled-components preview classification at the resource source', () => {
  it('classifies every previewable kit item that depends on styled-components, and nothing else', async () => {
    const page = await searchResources(parseResourceSearchRequest({ limit: 20 }), context, [fixtureKit]);
    const adapter = (itemId: string) => page.results.find(r => r.ref.itemId === itemId)!.previewCapability.adapter;
    expect(adapter('window')).toBe('styled-components');
    expect(adapter('button')).toBe('styled-components');
    expect(adapter('plain')).toBeUndefined();
    expect(page.results.find(r => r.ref.itemId === 'no-preview')!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'adapter-missing' });
    const window = page.results.find(r => r.ref.itemId === 'window')!;
    expect((await inspectResource(window.refKey, context, [fixtureKit])).resource.previewCapability.adapter).toBe('styled-components');
  });

  it('reaches od workbench inspect through the same HTTP route the Enlarge view reads', async () => {
    const app = express(); app.use(express.json());
    registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [fixtureKit] } as never);
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await searchResources(parseResourceSearchRequest({ limit: 20 }), context, [fixtureKit]);
    const refKey = page.results.find(r => r.ref.itemId === 'window')!.refKey;
    let body: unknown;
    expect(await runWorkbenchCli(['inspect', '--ref', refKey, '--json'], { baseUrl: url, write: value => { body = value; } })).toBe(0);
    expect(parseResourceDetailResponse(body).resource.previewCapability.adapter).toBe('styled-components');
  });
});
