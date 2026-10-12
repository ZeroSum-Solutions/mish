import { describe, expect, it } from 'vitest';
import { RESOURCE_SOURCE_IDS, parseResourceSearchRequest } from '@mish/contracts';
import { searchResources } from '../../src/workbench/resources.js';
import { authority, localInventorySources } from './resources-inventory-fixture.js';

describe('AC-R04.1 roster coverage', () => {
  it('every RESOURCE_SOURCE_IDS row reports a truthful state, not silently absent', async () => {
    const response = await searchResources(parseResourceSearchRequest({ limit: 1 }), authority, localInventorySources());
    expect(response.sourceStatuses.map(status => status.sourceId)).toEqual([...RESOURCE_SOURCE_IDS]);
    for (const status of response.sourceStatuses) {
      if (status.state === 'not-federated') {
        // A gap is named as a gap: no count, no digest, and a reason.
        expect(status).toMatchObject({ itemCount: null, listingDigest: null });
        expect(status.reason).toBeTruthy();
      } else {
        expect(status.state).toBe('searched');
        expect(Number.isInteger(status.itemCount)).toBe(true);
        expect(status.listingDigest).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    // The local, network-free federation (statuses in contract source order): the three W1 cohorts, the bundled design systems and
    // their DESIGN.md references (B5-2), the AC-R11 fonts snapshot (B6-1), and the frozen B7-3 reference-link/project-fetch
    // entries (AC-R18.6–R18.8). Project-scoped owned rows need a project; see resources-owned-federation-roster.test.ts.
    expect(response.sourceStatuses.filter(status => status.state === 'searched').map(status => status.sourceId)).toEqual(['plugins', 'genui', 'sections', 'design-systems', 'fonts', 'design-md', 'aceternity', 'svelte-animations', 'cnblocks', 'animations']);
    const designSystems = response.sourceStatuses.find(status => status.sourceId === 'design-systems');
    expect(designSystems).toMatchObject({ state: 'searched', reason: null });
    expect(designSystems!.itemCount).toBeGreaterThan(0);
  });
});
