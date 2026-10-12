import { describe, expect, it } from 'vitest';
import { localInventorySources, searchEveryPage } from './resources-inventory-fixture.js';

describe('AC-R04.1 unverified readiness semantics', () => {
  it('unverified readiness does not deny an already-authorized working preview', async () => {
    const { results } = await searchEveryPage(localInventorySources());
    for (const sourceId of ['genui', 'design-systems'] as const) {
      const previewable = results.filter(item => item.ref.sourceId === sourceId && item.readiness === 'unverified' && item.previewCapability.available && item.previewCapability.kind === 'html');
      expect(previewable.length, `${sourceId} has no unverified item with a working preview`).toBeGreaterThan(0);
      // Unverified means item-level evidence is missing, not that the item is defective.
      expect(previewable.every(item => item.acceptanceEvidence === undefined && item.availabilityReason === undefined)).toBe(true);
    }
  });
});
