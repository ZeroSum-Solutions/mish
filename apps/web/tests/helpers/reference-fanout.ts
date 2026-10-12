import { SOURCE_OPERATIONS, type ReferenceFanoutResponse } from '@mish/contracts';
export function referenceFanout(): ReferenceFanoutResponse {
  return {
    schema: 'reference-fanout/1', partial: false, spineCode: 'TL', sectionBasis: 'provided',
    sections: [{ id: 'hero', name: 'Hero', purpose: 'Build trust', query: 'dentistry hero' }],
    sources: [{ source: 'mobbin', sectionId: 'hero', status: 'unavailable', count: 0, code: 'connector-binding-missing', receipt: null, providerNotice: 'Usage notice\nCredit the original app.' }],
    ranking: { status: 'ranked', model: 'jev-latest', code: null }, degraded: true, candidateCount: 1,
    references: [{ id: 'refero:1', sectionIds: ['hero'], score: 92, sourceWeight: 1, reasons: ['Clear trust signals'], rightsLabel: 'reference-only',
      resource: { connectorId: 'refero', itemId: '1', title: 'Dental practice', canonicalUrl: 'https://refero.design/screens/1', capturedAt: '2026-10-09T10:00:00.000Z', category: 'Hero', access: 'unknown', attribution: { provider: 'Refero', url: 'https://refero.design' }, rights: { status: 'reference-only', summary: 'Inspect the original; reuse rights are not granted.', operations: SOURCE_OPERATIONS.map(operation => ({ operation, decision: 'blocked', reason: 'Reference viewing only' })) }, supportedOperations: ['open-source-link'], untrusted: true },
    }],
  };
}
