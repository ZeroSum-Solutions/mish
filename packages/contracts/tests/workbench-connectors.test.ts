import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ERROR_CODES, CONNECTOR_IDS, CONNECTOR_PLATFORMS, CONNECTOR_SEARCH_KINDS, connectorResourceRef, parseConnectorDetailRequest, parseConnectorResource, parseConnectorSearchRequest, parseConnectorSearchResponse,
  type ConnectorResource, type ConnectorSearchResponse,
} from '../src/api/workbench-connectors.js';
import { SOURCE_OPERATIONS } from '../src/api/workbench-source-admission.js';

/** AC-R12.2: the typed read-only connector proxy. Parsing proves shape, never a live receipt. */
const operations = SOURCE_OPERATIONS.map(operation => ({ operation, decision: 'unknown' as const, reason: 'No RightsAssessment recorded (G30)' }));
const resource: ConnectorResource = {
  connectorId: 'motionsites', itemId: 'fixture-hero', title: 'Fixture Hero', canonicalUrl: 'https://motionsites.ai/?prompt=fixture-hero',
  capturedAt: '2026-10-08T12:00:00.000Z', category: 'Hero', access: 'free',
  attribution: { provider: 'MotionSites', url: 'https://motionsites.ai' },
  rights: { status: 'restricted', summary: 'All rights reserved; reference viewing only.', operations },
  supportedOperations: ['open-source-link'], untrusted: true,
};
const receipt = { binding: 'daemon-mcp-config' as const, toolName: 'search_prompts', schemaDigest: 'e'.repeat(64), attempts: 1, durationMs: 12, retrievedAt: '2026-10-08T12:00:00.000Z' };

describe('connector contract (AC-R12.2)', () => {
  it('names the read-only connectors', () => {
    expect(CONNECTOR_IDS).toEqual(expect.arrayContaining(['motionsites', 'refero', 'mobbin']));
  });
  it('bounds search and detail requests', () => {
    expect(parseConnectorSearchRequest({ query: 'hero' })).toEqual({ query: 'hero', limit: 10 });
    expect(() => parseConnectorSearchRequest({ query: '' })).toThrow();
    expect(() => parseConnectorSearchRequest({ query: 'x', limit: 50 })).toThrow();
    expect(() => parseConnectorSearchRequest({ query: 'x', token: 'secret' })).toThrow();
    expect(() => parseConnectorDetailRequest({ itemId: 'a\u0000b' })).toThrow();
  });
  it('requires attribution, every operation decision and the untrusted-data marker', () => {
    expect(parseConnectorResource(resource).untrusted).toBe(true);
    expect(() => parseConnectorResource({ ...resource, untrusted: false })).toThrow();
    expect(() => parseConnectorResource({ ...resource, canonicalUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => parseConnectorResource({ ...resource, canonicalUrl: 'https://user:pass@motionsites.ai/' })).toThrow();
    expect(() => parseConnectorResource({ ...resource, rights: { ...resource.rights, operations: operations.slice(1) } })).toThrow(/every operation/);
    expect(() => parseConnectorResource({ ...resource, rights: { ...resource.rights, operations: operations.map(item => ({ ...item, decision: 'allowed', reason: null })) } })).toThrow(/evidence/);
  });
  it('a search response carries its daemon-side receipt and never a credential', () => {
    const response: ConnectorSearchResponse = { schema: 'connector-search/1', connectorId: 'motionsites', results: [resource], receipt, excluded: 0 };
    expect(parseConnectorSearchResponse(response).receipt.binding).toBe('daemon-mcp-config');
    expect(() => parseConnectorSearchResponse({ ...response, receipt: { ...receipt, accessToken: 'x' } })).toThrow();
    expect(() => parseConnectorSearchResponse({ ...response, results: [{ ...resource, connectorId: 'refero' }] })).toThrow(/connector/);
  });
  it('a search may name a provider search kind and platform (G29 Mobbin screens, flows and sections)', () => {
    expect(CONNECTOR_SEARCH_KINDS).toEqual(['screens', 'flows', 'sections']);
    expect(CONNECTOR_PLATFORMS).toEqual(['ios', 'web']);
    expect(parseConnectorSearchRequest({ query: 'pricing page', kind: 'screens', platform: 'web', limit: 3 })).toEqual({ query: 'pricing page', kind: 'screens', platform: 'web', limit: 3 });
    expect(parseConnectorSearchRequest({ query: 'pricing section', kind: 'sections' })).toEqual({ query: 'pricing section', kind: 'sections', limit: 10 });
    expect(() => parseConnectorSearchRequest({ query: 'x', kind: 'apps' })).toThrow();
    expect(() => parseConnectorSearchRequest({ query: 'x', kind: 'screens', platform: 'android' })).toThrow();
  });
  it('names a missing daemon-side binding as its own typed refusal', () => {
    expect(CONNECTOR_ERROR_CODES).toContain('connector-binding-missing');
  });
  it('a provider usage notice is bounded plain text that keeps its line breaks', () => {
    const response: ConnectorSearchResponse = { schema: 'connector-search/1', connectorId: 'motionsites', results: [resource], receipt, excluded: 0 };
    expect(parseConnectorSearchResponse({ ...response, providerNotice: 'Line one\n\nLine two' }).providerNotice).toBe('Line one\n\nLine two');
    expect(parseConnectorSearchResponse(response).providerNotice).toBeUndefined();
    expect(() => parseConnectorSearchResponse({ ...response, providerNotice: 'a\u0000b' })).toThrow();
    expect(() => parseConnectorSearchResponse({ ...response, providerNotice: 'a\u202eb' })).toThrow();
    expect(() => parseConnectorSearchResponse({ ...response, providerNotice: 'x'.repeat(4001) })).toThrow();
  });
  it('a captured reference names one exact R15 brief reference revision', () => {
    expect(connectorResourceRef(resource)).toEqual({ sourceType: 'reference', sourceId: 'motionsites', itemId: 'fixture-hero', revisionOrDigest: 'captured:2026-10-08T12:00:00.000Z' });
  });
  it('records deep fallback and accepts only bounded private Mobbin image URLs', () => {
    const searchMode = { requested: 'deep', used: 'standard', fallbackReason: 'connector-timeout' };
    const response = { schema: 'connector-search/1', connectorId: 'motionsites', results: [resource], receipt: { ...receipt, searchMode }, excluded: 0 };
    expect(parseConnectorSearchResponse(response).receipt.searchMode).toEqual(searchMode);
    expect(() => parseConnectorSearchResponse({ ...response, receipt: { ...receipt, searchMode: { ...searchMode, fallbackReason: null } } })).toThrow();
    const image = { url: `/api/workbench/connectors/mobbin/images/${'a'.repeat(64)}`, fetchedAt: resource.capturedAt, sha256: 'b'.repeat(64), contentType: 'image/png', byteLength: 12 };
    expect(parseConnectorResource({ ...resource, connectorId: 'mobbin', cachedImage: image }).cachedImage).toEqual(image);
    for (const bad of [{ url: 'https://cdn.mobbin.com/a.png' }, { contentType: 'image/svg+xml' }, { byteLength: 10 * 1024 * 1024 + 1 }]) {
      expect(() => parseConnectorResource({ ...resource, connectorId: 'mobbin', cachedImage: { ...image, ...bad } })).toThrow();
    }
    expect(() => parseConnectorResource({ ...resource, cachedImage: image })).toThrow();
  });
});
