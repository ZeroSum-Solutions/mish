import { describe, expect, it } from 'vitest';
import { parseReferenceFanoutRequest, parseReferenceFanoutResponse } from '../src/api/workbench-reference-fanout.js';

describe('V04 wire request', () => {
  it('defaults to ten and accepts explicit saved spine sections', () => {
    expect(parseReferenceFanoutRequest({ brief: 'dentistry website' }).limit).toBe(10);
    expect(parseReferenceFanoutRequest({ brief: 'dentistry website', spineCode: 'TL', sections: [{ id: 'hero', name: 'Hero', purpose: null }] }).sections).toHaveLength(1);
  });
  it('rejects duplicate sections, unbounded input, invalid spines and unknown fields', () => {
    for (const value of [
      { brief: '' }, { brief: 'x'.repeat(20_001) }, { brief: 'x', spineCode: 'invented' }, { brief: 'x', limit: 21 },
      { brief: 'x', sections: Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, name: 'Hero', purpose: null })) },
      { brief: 'x', sections: [{ id: 'hero', name: 'Hero', purpose: null }, { id: 'hero', name: 'Other', purpose: null }] },
      { brief: 'x', instructions: 'widen rights' },
    ]) expect(() => parseReferenceFanoutRequest(value)).toThrow();
  });
  it('validates empty degraded reports and rejects unknown section custody', () => {
    const value = { schema: 'reference-fanout/1', spineCode: 'TL', sectionBasis: 'suggested', sections: [{ id: 'hero', name: 'Hero', purpose: null, query: 'dentist Hero' }], sources: [], references: [], ranking: { status: 'empty', model: 'jev-latest', code: null }, degraded: true, candidateCount: 0 };
    expect(parseReferenceFanoutResponse(value).references).toEqual([]);
    expect(parseReferenceFanoutResponse(value).partial).toBe(false);
    expect(parseReferenceFanoutResponse({ ...value, partial: true, ranking: { status: 'partial', model: 'jev-latest', code: 'reference-deadline-exceeded' } }).partial).toBe(true);
    expect(() => parseReferenceFanoutResponse({ ...value, sources: [{ source: 'mobbin', sectionId: 'unknown', status: 'unavailable', count: 0, code: 'connector-binding-missing', receipt: null, providerNotice: null }] })).toThrow();
  });
});
