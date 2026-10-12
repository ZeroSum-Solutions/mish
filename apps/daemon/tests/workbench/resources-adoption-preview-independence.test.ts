import { describe, expect, it } from 'vitest';
import { parseResourceSearchResponse, type ResourceResult } from '@mish/contracts';
import { localInventorySources, searchEveryPage } from './resources-inventory-fixture.js';

describe('AC-R04.1 preview capability and adoption permission', () => {
  it('offers previews without granting adoption, across every local source that previews', async () => {
    const { results } = await searchEveryPage(localInventorySources());
    const previewable = results.filter(item => item.previewCapability.available);
    expect(new Set(previewable.map(item => item.ref.sourceId))).toEqual(new Set(['genui', 'design-systems', 'fonts']));
    for (const item of previewable) {
      expect(item.adoptionCapability.available).toBe(false);
      expect(item.adoptionCapability.reason).toBeTruthy();
    }
  });

  it('refuses adoption on an unverified item even when its rights are permitted and it previews', async () => {
    const { results } = await searchEveryPage(localInventorySources(), { facets: { sourceIds: ['design-systems'] } });
    const base = results.find(item => item.previewCapability.available && item.rightsStatus === 'permitted') as ResourceResult;
    expect(base).toBeTruthy();
    const claimed: ResourceResult = { ...base, adoptionCapability: { available: true, reason: null }, operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }] };
    const response = (results: ResourceResult[]) => ({ results, sourceStatuses: [], context: { requested: true, applied: false, reason: 'context-not-implemented' }, contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null });
    expect(() => parseResourceSearchResponse(response([base]))).not.toThrow();
    expect(() => parseResourceSearchResponse(response([claimed]))).toThrow(/adoption requires usable evidence/);
  });
});
