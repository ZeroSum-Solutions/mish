import { describe, expect, it } from 'vitest';
import { PlacementCapabilityError } from '../../../src/workbench/placement/project-registry.js';
import { mapPlacementFailure, PlacementBootstrapError } from '../../../src/workbench/placement/runtime-status.js';
import { PlacementCoordinationError } from '../../../src/workbench/placement/write-coordinator.js';

describe('placement HTTP-boundary mapping', () => {
  it.each([
    ['OWNER_UNQUALIFIED', 503], ['OWNER_RECOVERING', 503], ['PROJECT_RECOVERING', 503], ['ADMISSION_CLOSED', 503],
    ['RUN_SCOPE_CHANGED', 409], ['COORDINATOR_BUSY', 409],
  ] as const)('%s maps to %i with the reason in details', (code, status) => {
    expect(mapPlacementFailure(new PlacementCoordinationError(code, 'x'))).toMatchObject({ status, details: { kind: 'placement', reason: code } });
  });
  it('busy owner is 409, other refusals 503, unsupported adoption 422, unrelated errors unmapped', () => {
    expect(mapPlacementFailure(new PlacementBootstrapError('owner-busy', 409))).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(mapPlacementFailure(new PlacementBootstrapError('binding-digest'))).toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE' });
    expect(mapPlacementFailure(new PlacementCapabilityError('imported'))).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', retryable: false, details: { reason: 'unsupported-capability' } });
    expect(mapPlacementFailure(new PlacementCoordinationError('INVALID_PERMIT', 'x'))).toBeNull();
    expect(mapPlacementFailure(new Error('other'))).toBeNull();
  });
});
