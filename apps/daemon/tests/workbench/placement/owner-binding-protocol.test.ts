import { describe, expect, it } from 'vitest';
import { acquireNativePlacementOwner } from '../../../src/workbench/placement/owner-binding.js';
describe('inactive owner boundary', () => {
  it('rejects invalid roots before attempting to load a native module', () => {
    for (const canonicalDataRoot of ['', 'relative', '/tmp/../tmp', '/tmp\0foreign', '/tmp\ud800']) {
      expect(acquireNativePlacementOwner({ canonicalDataRoot, binding: { path: '/missing-owned-fixture.node', sha256: '0'.repeat(64) } })).toMatchObject({ kind: 'conflict', reason: 'canonical-root' });
    }
  });
  it('fails closed with an explicit missing binding instead of auto-building or opening a root', () => {
    expect(acquireNativePlacementOwner({ canonicalDataRoot: '/missing-owned-root', binding: { path: '/missing-owned-fixture.node', sha256: '0'.repeat(64) } }).kind).toBe('unsupported');
  });
});
