import { describe, expect, it } from 'vitest';
import { componentFitSchema, componentTokenEvidenceSchema, componentAdmissionEvidenceSchema, parseResourceSearchRequest, parseResourceDetailResponse, parseComponentPicker } from '../src/index.js';
describe('V06 component HTTP contract', () => {
  it('defaults to fits view and rank mode, bounds IDs and rejects untrusted facts', () => {
    expect(parseComponentPicker({ kitId: 'clinic' })).toEqual({ kitId: 'clinic', showAll: false, mode: 'rank' });
    expect(() => parseComponentPicker({ kitId: 'clinic', allowed: true })).toThrow();
    expect(() => parseResourceSearchRequest({ componentPicker: { kitId: 'x'.repeat(1001) } })).toThrow();
  });
  it('allows an adapter profile tied to the absence of a saved rubric', () => {
    expect(componentAdmissionEvidenceSchema.parse({ profileId: 'default', projectId: 'p', sourceRevisionOrDigest: 'v1', contextRevision: 0, rubricRevision: 0 }).rubricRevision).toBe(0);
  });
  it('requires revision-bound token observations and consistent Apply gates', () => {
    expect(() => componentTokenEvidenceSchema.parse({ color: 'adaptable', radius: 'adaptable', type: 'adaptable' })).toThrow();
    const base = { version: 'kit-components/1', kitId: 'clinic', kitRevisionOrDigest: 'v1', status: 'unknown', score: 0, reasons: [] };
    expect(() => componentFitSchema.parse({ ...base, apply: { allowed: true, blockers: ['target-unverified'] } })).toThrow();
    expect(() => componentFitSchema.parse({ ...base, status: 'fits', apply: { allowed: false, blockers: ['admission-unverified'] } })).toThrow();
  });
});

it('keeps source+ID kit identity and unapproved-kit ranking separate from Apply', () => {
  expect(parseComponentPicker({ kitId: 'clinic', kitSourceId: 'plugins' })).toMatchObject({ kitId: 'clinic', kitSourceId: 'plugins' });
  expect(() => parseComponentPicker({ kitSourceId: 'plugins' })).toThrow();
  expect(componentFitSchema.parse({ version: 'kit-components/1', kitSourceId: 'design-systems', kitId: 'clinic', kitRevisionOrDigest: 'v1', status: 'fits', acceptance: 'failed', score: 30, reasons: [], apply: { allowed: false, blockers: ['kit-unapproved'] } }).status).toBe('fits');
});

it('reports failed acceptance informationally while keeping usable readiness reserved for passed receipts', () => {
  const resource = { ref: { sourceType: 'section', sourceId: 'sections', itemId: 'unit', revisionOrDigest: 'v1' }, refKey: 'key', title: 'Unit', category: 'component', readiness: 'unverified', compatibility: { nativeFormat: 'html', targets: ['html'], state: 'compatible', reason: null }, rightsStatus: 'permitted', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: null }, adoptionCapability: { available: false, reason: null }, sourceAttribution: { title: 'Fixture' }, operationGrants: [], admissionStage: 'admitted', needDecision: 'required', needReason: 'Fixture', acceptanceEvidence: { sourceDigest: 'v1', receiptId: 'receipt', passed: false } };
  const sourceStatus = { sourceId: 'sections', state: 'searched', reason: null, itemCount: 1, listingDigest: null };
  expect(parseResourceDetailResponse({ resource, sourceStatus }).resource.acceptanceEvidence?.passed).toBe(false);
  expect(() => parseResourceDetailResponse({ resource: { ...resource, readiness: 'usable' }, sourceStatus })).toThrow('usable requires current passed per-item evidence');
});
