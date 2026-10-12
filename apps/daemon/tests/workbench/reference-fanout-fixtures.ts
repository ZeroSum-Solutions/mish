import { SOURCE_OPERATIONS, parseConnectorSearchResponse, type ConnectorResource } from '@open-design/contracts';
export function resource(source: 'refero' | 'mobbin', id: string, url?: string): ConnectorResource {
  return {
    connectorId: source, itemId: id, title: `${source} dental ${id}`, category: 'screen', access: 'unknown',
    canonicalUrl: url ?? `https://${source === 'refero' ? 'refero.design' : 'mobbin.com'}/screens/${id}`,
    capturedAt: '2026-10-09T00:00:00.000Z', attribution: { provider: source, url: `https://${source === 'refero' ? 'refero.design' : 'mobbin.com'}` },
    rights: { status: 'reference-only', summary: 'Reference only', operations: SOURCE_OPERATIONS.map(operation => ({ operation, decision: operation === 'derive-from-reference' ? 'allowed' : 'unknown', reason: 'Synthetic test grant only', evidenceRefs: ['fixture-rights-grant'] })) },
    supportedOperations: ['open-source-link'], untrusted: true,
  };
}
export function searchResult(source: 'refero' | 'mobbin', results: ConnectorResource[]) {
  return parseConnectorSearchResponse({ schema: 'connector-search/1', connectorId: source, results,
    receipt: { binding: 'daemon-mcp-config', toolName: 'search_screens', schemaDigest: 'a'.repeat(64), attempts: 1, durationMs: 1, retrievedAt: '2026-10-09T00:00:00.000Z' }, excluded: 0 });
}
