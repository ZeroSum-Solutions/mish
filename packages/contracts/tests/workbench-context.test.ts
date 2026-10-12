import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  parseProjectDesignContextDraft, parseProjectDesignContextSnapshot,
  parseProjectRubricDraft, parseProjectRubricSnapshot, parseWorkbenchPreferencesSnapshot,
  parsePutProjectDesignContext, parsePutProjectRubric, parsePutWorkbenchPreferences,
  canonicalizeProjectDesignContextDraft, canonicalizeProjectRubricDraft,
  serializeProjectDesignContextDraft, serializeProjectRubricDraft,
  resourceContextStatusSchema, resourceMotionMetadataSchema,
} from '../src/api/workbench-context.js';

const scalarValues: Record<string, string> = { '/purpose': 'Dental appointment conversion', '/audience/0': 'Local patients', '/conversions/0/kind': 'booking', '/conversions/0/role': 'primary', '/conversions/0/label': 'Book appointment', '/conversions/0/target': 'Appointment form', '/styleDirection': 'windows95', '/constraints/0/value': 'none', '/spineCode': 'TL', '/designSystemRef/id': 'neutral', '/designSystemRef/revisionOrDigest': 'sha256:abc' };
const fact = (fieldPath: string, value = scalarValues[fieldPath]!) => ({ fieldPath, value, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Explicit project owner declaration' });
const draft = {
  purpose: 'Dental appointment conversion', audience: ['Local patients'],
  conversions: [{ id: 'book', kind: 'booking', role: 'primary', label: 'Book appointment', target: 'Appointment form' }],
  brandDirection: null, styleDirection: 'windows95',
  constraints: [{ id: 'motion', kind: 'motion', value: 'none' }], spineCode: 'TL',
  factSources: ['/purpose', '/audience/0', '/conversions/0/kind', '/conversions/0/role', '/conversions/0/label', '/conversions/0/target', '/styleDirection', '/constraints/0/value', '/spineCode'].map(path => fact(path)),
  assumptions: ['Brand direction is unknown'],
};
const unknownDraft = { purpose: null, audience: [], conversions: [], brandDirection: null, constraints: [], factSources: [], assumptions: ['Purpose, audience, conversions and brand direction are unknown'] };
const record = { ...draft, schema: 'workbench-context/1', projectId: 'project/opaque', revision: 2, updatedAt: '2026-10-03T12:00:00.000Z' };
const contextSnapshot = { projectId: 'project/opaque', revision: 2, context: record };
const check = {
  checkId: 'cta.main', kind: 'mechanical', required: true, severity: 'high',
  requiredBasis: { type: 'mandatory', criterionId: 'core.declared-actions' },
  provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Explicit project acceptance' },
  parameters: { type: 'cta', actionType: 'conversion', targets: [{ type: 'conversion', id: 'book' }] },
  evidenceTypes: ['probe', 'screenshot'], sourceCriteria: [],
};
const sourceCriterion = { sourceId: 'design-system-checklist', revisionOrDigest: 'v1', criterionId: 'cta-anchor', canonicalUrl: 'https://example.com/checklist' };
const rubricDraft = { contextRevision: 2, checks: [check] };
const rubricRecord = { ...rubricDraft, schema: 'workbench-rubric/1', projectId: 'project/opaque', revision: 1, updatedAt: '2026-10-03T12:00:00.000Z' };
const rubricSnapshot = { projectId: 'project/opaque', revision: 1, rubric: rubricRecord, linkage: { state: 'current', referencedContextRevision: 2, currentContextRevision: 2 } };
const validationIssues = (parse: () => unknown) => {
  try { parse(); } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    return (error as ZodError).issues.map(({ path, message }) => ({ path, message }));
  }
  throw new Error('Expected a validation failure');
};

describe('explicit project context boundaries', () => {
  it('preserves unknowns, multiline purpose, explicit retro and no-motion intent', () => {
    expect(parseProjectDesignContextDraft(unknownDraft)).toEqual(unknownDraft);
    const parsed = parseProjectDesignContextDraft({ ...draft, purpose: '  Line one\nLine two  ', factSources: draft.factSources.map(entry => entry.fieldPath === '/purpose' ? { ...entry, value: 'Line one\nLine two' } : entry) });
    expect(parsed.purpose).toBe('Line one\nLine two');
    expect(parsed.styleDirection).toBe('windows95');
    expect(parsed.constraints[0]).toEqual({ id: 'motion', kind: 'motion', value: 'none' });
    expect(parsed.brandDirection).toBeNull();
  });
  it.each(['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'])('accepts canonical spine %s with explicit provenance', spineCode => {
    expect(parseProjectDesignContextDraft({ ...draft, spineCode, factSources: draft.factSources.map(entry => entry.fieldPath === '/spineCode' ? { ...entry, value: spineCode } : entry) }).spineCode).toBe(spineCode);
  });
  it.each([
    { schema: 'workbench-context/1' }, { projectId: 'foreign' }, { revision: 1 },
    { updatedAt: '2026-10-03T12:00:00Z' }, { outcome: 'pass' }, { permissions: ['write'] },
    { spineCode: 'premium' }, { purpose: 'x'.repeat(2001) }, { assumptions: [] },
  ])('rejects forged metadata or invalid context %#', patch => {
    expect(() => parseProjectDesignContextDraft({ ...draft, ...patch })).toThrow();
  });
  it('requires exactly one annotation for each populated supported leaf', () => {
    for (const factSources of [draft.factSources.slice(1), [...draft.factSources, fact('/purpose')]]) {
      expect(() => parseProjectDesignContextDraft({ ...draft, factSources })).toThrow();
    }
    expect(() => parseProjectDesignContextDraft({ ...draft, designSystemRef: { id: 'neutral', revisionOrDigest: 'sha256:abc' } })).toThrow();
    expect(parseProjectDesignContextDraft({ ...draft, designSystemRef: { id: 'neutral', revisionOrDigest: 'sha256:abc' }, factSources: [...draft.factSources, fact('/designSystemRef/id'), fact('/designSystemRef/revisionOrDigest')] }).designSystemRef?.id).toBe('neutral');
  });
  it.each([
    ['/revision', '2'], ['/conversions/0/id', 'book'], ['/brandDirection', 'Bold'],
    ['/audience/01', 'Local patients'], ['/audience/10', 'Other audience'],
    ['/assumptions/0', 'Brand direction is unknown'],
  ])('rejects only the unsupported fact pointer %s with an otherwise valid draft', (fieldPath, value) => {
    expect(parseProjectDesignContextDraft(draft).factSources).toHaveLength(draft.factSources.length);
    expect(validationIssues(() => parseProjectDesignContextDraft({ ...draft, factSources: [...draft.factSources, fact(fieldPath, value)] }))).toEqual([
      { path: ['factSources', draft.factSources.length, 'fieldPath'], message: 'Expected a populated supported leaf of this draft' },
    ]);
  });
  it('requires imported sources and retains inferred uncertainty without inventing authority', () => {
    const source = { resourceRef: { sourceType: 'section', sourceId: 'sections', itemId: 'hero', revisionOrDigest: 'sha256:abc' } };
    const facts = draft.factSources.map((entry, index) => index === 0 ? { ...entry, origin: 'imported', source, confidence: 0.8 } : entry);
    expect(parseProjectDesignContextDraft({ ...draft, factSources: facts }).factSources[0]).toMatchObject({ origin: 'imported', confidence: 0.8, source });
    for (const patch of [{ origin: 'imported', source: null }, { origin: 'inferred', rationale: '' }, { confidence: 1.1 }, { confidence: Infinity }, { source: { assetId: 'asset', resourceRef: source.resourceRef } }, { source: { assetId: '' } }, { origin: 'confirmed-by-model' }]) {
      expect(() => parseProjectDesignContextDraft({ ...draft, factSources: [{ ...draft.factSources[0], ...patch }, ...draft.factSources.slice(1)] })).toThrow();
    }
    expect(parseProjectDesignContextDraft({ ...draft, factSources: [{ ...draft.factSources[0], origin: 'inferred', confidence: null }, ...draft.factSources.slice(1)] }).factSources[0]?.origin).toBe('inferred');
  });
  it('rejects duplicate conversion IDs independently from primary roles and provenance', () => {
    const valid = { ...draft, conversions: [...draft.conversions, { id: 'call', kind: 'call', role: 'secondary', label: 'Call us' }], factSources: [...draft.factSources, fact('/conversions/1/kind', 'call'), fact('/conversions/1/role', 'secondary'), fact('/conversions/1/label', 'Call us')] };
    expect(parseProjectDesignContextDraft(valid).conversions).toHaveLength(2);
    expect(validationIssues(() => parseProjectDesignContextDraft({ ...valid, conversions: valid.conversions.map(item => ({ ...item, id: 'book' })) }))).toEqual([
      { path: ['conversions'], message: 'Conversion IDs must be unique' },
    ]);
  });
  it('rejects duplicate constraint IDs independently from constraint kind and provenance', () => {
    const valid = { ...draft, constraints: [...draft.constraints, { id: 'runtime', kind: 'runtime', value: 'Browser only' }], factSources: [...draft.factSources, fact('/constraints/1/value', 'Browser only')] };
    expect(parseProjectDesignContextDraft(valid).constraints).toHaveLength(2);
    expect(validationIssues(() => parseProjectDesignContextDraft({ ...valid, constraints: valid.constraints.map(item => ({ ...item, id: 'motion' })) }))).toEqual([
      { path: ['constraints'], message: 'Constraint IDs must be unique' },
    ]);
  });
  it('rejects multiple motion constraints independently from IDs and provenance', () => {
    const valid = { ...draft, constraints: [...draft.constraints, { id: 'more', kind: 'other', value: 'allowed' }], factSources: [...draft.factSources, fact('/constraints/1/value', 'allowed')] };
    expect(parseProjectDesignContextDraft(valid).constraints).toHaveLength(2);
    expect(validationIssues(() => parseProjectDesignContextDraft({ ...valid, constraints: [valid.constraints[0], { id: 'more', kind: 'motion', value: 'allowed' }] }))).toEqual([
      { path: ['constraints'], message: 'Only one motion constraint is allowed' },
    ]);
  });
  it('rejects unsafe logical IDs', () => {
    for (const id of ['', '../book', 'book\nnow', 'x'.repeat(65)]) expect(() => parseProjectDesignContextDraft({ ...draft, conversions: [{ ...draft.conversions[0], id }] })).toThrow();
  });
  it('preserves null and empty draft unknowns as distinct canonical representations', () => {
    for (const text of ['', '   ']) {
      const empty = { ...unknownDraft, purpose: text, brandDirection: text };
      expect(parseProjectDesignContextDraft(empty)).toMatchObject({ purpose: '', brandDirection: '' });
      expect(serializeProjectDesignContextDraft(empty)).not.toBe(serializeProjectDesignContextDraft(unknownDraft));
    }
  });
  it('distinguishes absence from a saved unknown context and validates snapshot identity', () => {
    expect(parseProjectDesignContextSnapshot({ projectId: 'project/opaque', revision: 0, context: null }).context).toBeNull();
    expect(parseProjectDesignContextSnapshot(contextSnapshot).revision).toBe(2);
    for (const input of [{ ...contextSnapshot, revision: 0 }, { ...contextSnapshot, revision: 3 }, { ...contextSnapshot, projectId: 'foreign' }, { ...contextSnapshot, context: null }, { projectId: 'project', revision: 1, context: null }, { ...contextSnapshot, context: { ...record, updatedAt: '2026-02-30T12:00:00.000Z' } }, { ...contextSnapshot, context: { ...record, updatedAt: '2026-10-03T12:00:00+01:00' } }]) {
      expect(() => parseProjectDesignContextSnapshot(input)).toThrow();
    }
  });
  it('preserves expected revisions for service CAS without accepting server draft fields', () => {
    expect(parsePutProjectDesignContext({ expectedRevision: 0, draft }).expectedRevision).toBe(0);
    expect(parsePutProjectDesignContext({ expectedRevision: Number.MAX_SAFE_INTEGER, draft }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) expect(() => parsePutProjectDesignContext({ expectedRevision: revision, draft })).toThrow();
    expect(() => parsePutProjectDesignContext({ expectedRevision: 0, draft: record })).toThrow();
    expect(() => parsePutProjectDesignContext({ expectedRevision: 0, draft: null })).toThrow();
  });
});

describe('rubric declarations without execution outcomes', () => {
  it('normalizes mechanical defaults without claiming a check passed', () => {
    const parsed = parseProjectRubricDraft(rubricDraft);
    expect(parsed.checks[0]?.parameters).toEqual({ type: 'cta', actionType: 'conversion', targets: [{ type: 'conversion', id: 'book' }], viewports: [320, 375, 768, 1440] });
    expect(parsed.checks[0]).not.toHaveProperty('outcome');
  });
  it.each([
    ['contrast', { normalTextMinRatio: 4.5, largeTextMinRatio: 3 }],
    ['console-resources', { failOnConsoleError: true, failOnBrokenResource: true }],
    ['overflow', { toleranceCssPixels: 0, checkClippedContent: true }],
    ['keyboard-focus', { requireVisibleFocus: true, requireFocusReturn: true }],
    ['document-semantics', { requireNamedControls: true, requireHeadingStructure: true }],
  ])('retains bounded %s declaration defaults', (type, fields) => {
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, requiredBasis: null, required: false, parameters: { type } }] }).checks[0]?.parameters).toEqual({ type, ...fields, viewports: [320, 375, 768, 1440] });
  });
  it.each([
    ['judgment', { type: 'criterion', criterion: 'Match the explicit retro intent' }, 'judgment-rationale'],
    ['manual', { type: 'manual-procedure', procedure: 'Navigate with screen reader', environment: 'Target physical device' }, 'manual-observation'],
  ])('stores %s as a pending declaration', (kind, parameters, evidenceType) => {
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, kind, parameters, evidenceTypes: [evidenceType], requiredBasis: { type: 'project-acceptance', requirementId: 'retro', rationale: 'Owner accepted this project requirement' } }] }).checks[0]?.kind).toBe(kind);
  });
  it.each([
    { requiredBasis: null }, { requiredBasis: { type: 'mandatory', criterionId: 'invented.rule' } },
    { parameters: { type: 'criterion', criterion: 'Wrong kind' } }, { parameters: { type: 'cta', expression: 'eval(code)' } },
    { outcome: 'pass' }, { results: [] }, { evidenceTypes: ['probe', 'probe'] }, { evidenceTypes: ['model-says-pass'] },
    { severity: 'optional' }, { checkId: '../unsafe' },
  ])('rejects forged or mismatched checks %#', patch => {
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, ...patch }] })).toThrow();
  });
  it('does not let checklist anchors replace required basis or execution evidence', () => {
    const anchor = { sourceId: 'design-system-checklist', revisionOrDigest: 'v1', criterionId: 'anchor', canonicalUrl: 'https://example.com/checklist' };
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, requiredBasis: null, sourceCriteria: [anchor] }] })).toThrow();
    const optional = { ...check, required: false, requiredBasis: null, sourceCriteria: [anchor], applicability: { status: 'not-applicable', targetScope: 'page', rationale: 'Declared project has no dialog', evaluator: 'project-owner' } };
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [optional] }).checks[0]?.required).toBe(false);
    for (const canonicalUrl of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/\\escape', 'https://example.com/\ncontrol']) expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...optional, sourceCriteria: [{ ...anchor, canonicalUrl }] }] })).toThrow();
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...optional, sourceCriteria: [anchor, anchor] }] }).checks[0]?.sourceCriteria).toHaveLength(1);
  });
  it('requires versioned core viewports and explicit low-contrast exceptions', () => {
    for (const viewports of [[320, 375, 768], [320, 375, 768, 1440, 320], [320, 375, 768, 1440, 100]]) expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, parameters: { ...check.parameters, viewports } }] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, parameters: { type: 'contrast', normalTextMinRatio: 3 } }] })).toThrow();
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, requiredBasis: null, required: false, parameters: { type: 'contrast', normalTextMinRatio: 3, exceptionRationale: 'Qualifying large text only; declaration requires later evidence' } }] }).checks[0]?.parameters.type).toBe('contrast');
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [check, check] })).toThrow();
  });
  it('validates immutable rubric identity and derived stale linkage separately', () => {
    expect(parseProjectRubricSnapshot({ projectId: 'project', revision: 0, rubric: null, linkage: null }).linkage).toBeNull();
    expect(parseProjectRubricSnapshot(rubricSnapshot).linkage?.state).toBe('current');
    expect(parseProjectRubricSnapshot({ ...rubricSnapshot, linkage: { state: 'stale', referencedContextRevision: 2, currentContextRevision: 3 } }).rubric?.contextRevision).toBe(2);
    for (const linkage of [null, { state: 'stale', referencedContextRevision: 2, currentContextRevision: 2 }, { state: 'current', referencedContextRevision: 2, currentContextRevision: 3 }, { state: 'stale', referencedContextRevision: 1, currentContextRevision: 3 }, { state: 'stale', referencedContextRevision: 2, currentContextRevision: 1 }]) expect(() => parseProjectRubricSnapshot({ ...rubricSnapshot, linkage })).toThrow();
    expect(parsePutProjectRubric({ expectedRevision: 0, draft: rubricDraft }).draft.contextRevision).toBe(2);
    expect(() => parsePutProjectRubric({ expectedRevision: 0, draft: { ...rubricDraft, contextRevision: 0 } })).toThrow();
    expect(() => parseProjectRubricSnapshot({ ...rubricSnapshot, rubric: { ...rubricRecord, projectId: 'foreign' } })).toThrow();
  });
});

describe('independent persisted preferences', () => {
  it('defaults absence on while retaining an explicitly saved off revision', () => {
    expect(parseWorkbenchPreferencesSnapshot({ projectId: 'project', revision: 0, preferences: null, effective: { useProjectContext: true } }).effective.useProjectContext).toBe(true);
    const preferences = { schema: 'workbench-preferences/1', projectId: 'project', revision: 1, useProjectContext: false, updatedAt: '2026-10-03T12:00:00.000Z' };
    expect(parseWorkbenchPreferencesSnapshot({ projectId: 'project', revision: 1, preferences, effective: { useProjectContext: false } }).preferences?.revision).toBe(1);
    expect(() => parseWorkbenchPreferencesSnapshot({ projectId: 'project', revision: 0, preferences: null, effective: { useProjectContext: false } })).toThrow();
    expect(() => parseWorkbenchPreferencesSnapshot({ projectId: 'project', revision: 1, preferences, effective: { useProjectContext: true } })).toThrow();
    expect(() => parseWorkbenchPreferencesSnapshot({ projectId: 'other', revision: 1, preferences, effective: { useProjectContext: false } })).toThrow();
    expect(parsePutWorkbenchPreferences({ expectedRevision: 0, useProjectContext: true })).toEqual({ expectedRevision: 0, useProjectContext: true });
    expect(() => parsePutWorkbenchPreferences({ expectedRevision: 0, useProjectContext: true, contextRevision: 1 })).toThrow();
  });
});


describe('corrected frozen provenance and equality', () => {
  it('rejects annotations attached to a different reordered scalar', () => {
    const original = { ...draft, audience: ['Local patients', 'Parents'], factSources: [...draft.factSources, fact('/audience/1', 'Parents')] };
    expect(() => parseProjectDesignContextDraft({ ...original, audience: ['Parents', 'Local patients'] })).toThrow();
    const rewritten = original.factSources.map(entry => entry.fieldPath === '/audience/0' ? { ...entry, fieldPath: '/audience/1' } : entry.fieldPath === '/audience/1' ? { ...entry, fieldPath: '/audience/0' } : entry);
    expect(parseProjectDesignContextDraft({ ...original, audience: ['Parents', 'Local patients'], factSources: rewritten }).audience).toEqual(['Parents', 'Local patients']);
  });
  it('requires one primary conversion and explicit role provenance', () => {
    expect(() => parseProjectDesignContextDraft({ ...draft, conversions: [{ ...draft.conversions[0], role: 'secondary' }], factSources: draft.factSources.map(entry => entry.fieldPath === '/conversions/0/role' ? { ...entry, value: 'secondary' } : entry) })).toThrow();
    expect(() => parseProjectDesignContextDraft({ ...draft, conversions: [{ ...draft.conversions[0], role: undefined }] })).toThrow();
    const extra = { id: 'call', kind: 'call', role: 'primary', label: 'Call us' };
    expect(() => parseProjectDesignContextDraft({ ...draft, conversions: [...draft.conversions, extra], factSources: [...draft.factSources, fact('/conversions/1/kind', 'call'), fact('/conversions/1/role', 'primary'), fact('/conversions/1/label', 'Call us')] })).toThrow();
  });
  it('canonicalizes source ordering and trimmed values while preserving semantic array order', () => {
    expect(serializeProjectDesignContextDraft({ ...draft, factSources: [...draft.factSources].reverse() })).toBe(serializeProjectDesignContextDraft(draft));
    expect(canonicalizeProjectDesignContextDraft({ ...draft, purpose: '  Dental appointment conversion  ' }).purpose).toBe('Dental appointment conversion');
    const original = { ...draft, audience: ['Local patients', 'Parents'], factSources: [...draft.factSources, fact('/audience/1', 'Parents')] };
    const reversed = { ...original, audience: ['Parents', 'Local patients'], factSources: original.factSources.map(entry => entry.fieldPath === '/audience/0' ? { ...entry, value: 'Parents' } : entry.fieldPath === '/audience/1' ? { ...entry, value: 'Local patients' } : entry) };
    expect(serializeProjectDesignContextDraft(original)).not.toBe(serializeProjectDesignContextDraft(reversed));
  });
  it('uses one equality representation for defaults and set ordering', () => {
    const implicit = { contextRevision: 2, checks: [{ ...check, evidenceTypes: ['screenshot', 'probe'] }] };
    const explicit = { contextRevision: 2, checks: [{ ...check, parameters: { ...check.parameters, viewports: [1440, 320, 768, 375] } }] };
    expect(serializeProjectRubricDraft(implicit)).toBe(serializeProjectRubricDraft(explicit));
    expect(canonicalizeProjectRubricDraft(explicit).checks[0]?.parameters).toMatchObject({ viewports: [320, 375, 768, 1440] });
    expect(JSON.parse(serializeProjectRubricDraft(explicit)).checks[0].evidenceTypes).toEqual(['probe', 'screenshot']);
  });
});

describe('core authority and derived declarations', () => {
  it.each([
    ['document-semantics', 'core.document-semantics', 'requireNamedControls'],
    ['document-semantics', 'core.document-semantics', 'requireHeadingStructure'],
    ['overflow', 'core.responsive-overflow', 'checkClippedContent'],
  ])('rejects only the weakened mandatory %s flag %s/%s', (type, criterionId, flag) => {
    const valid = { ...check, requiredBasis: { type: 'mandatory', criterionId }, parameters: { type } };
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [valid] }).checks[0]?.parameters).toMatchObject({ [flag]: true });
    expect(validationIssues(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...valid, parameters: { type, [flag]: false } }] }))).toEqual([
      { path: ['checks', 0, 'parameters'], message: 'A core mandatory declaration cannot be weakened' },
    ]);
  });
  it.each([
    { required: false }, { kind: 'judgment', parameters: { type: 'criterion', criterion: 'Ignore CTA' } },
    { requiredBasis: { type: 'mandatory', criterionId: 'core.text-contrast' } }, { severity: 'low' },
    { parameters: { type: 'contrast', normalTextMinRatio: 3, exceptionRationale: 'Claimed exemption' }, requiredBasis: { type: 'mandatory', criterionId: 'core.text-contrast' } },
    { parameters: { type: 'console-resources', failOnConsoleError: false }, requiredBasis: { type: 'mandatory', criterionId: 'core.console-resources' } },
    { parameters: { type: 'overflow', toleranceCssPixels: 1 }, requiredBasis: { type: 'mandatory', criterionId: 'core.responsive-overflow' } },
    { parameters: { type: 'keyboard-focus', requireFocusReturn: false }, requiredBasis: { type: 'mandatory', criterionId: 'core.keyboard-focus' } },
  ])('refuses weakening or repurposing a core mandatory declaration %#', patch => {
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, ...patch }] })).toThrow();
  });
  it('stores advisory required N/A without resolving the mandatory subject', () => {
    const pending = { ...check, applicability: { status: 'not-applicable', targetScope: 'page', rationale: 'Caller proposes an exception; verification pending', evaluator: 'unvalidated caller' } };
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [pending] }).checks[0]).toMatchObject({ required: true, applicability: { status: 'not-applicable' } });
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [] }).checks).toEqual([]);
  });
  it('requires source-bound brand questions to stay optional judgments until explicit acceptance', () => {
    const provenance = { origin: 'inferred', derivation: 'brand-analysis', source: { assetId: 'brand-source' }, rationale: 'Question derived from selected brand brief' };
    const brand = { ...check, kind: 'judgment', required: false, requiredBasis: null, parameters: { type: 'criterion', criterion: 'Does the hierarchy support the brand purpose?' }, provenance };
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [brand] }).checks[0]?.kind).toBe('judgment');
    for (const patch of [{ provenance: { ...provenance, source: null } }, { kind: 'mechanical', parameters: check.parameters }, { required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'brand', rationale: 'Inferred acceptance' } }]) expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...brand, ...patch }] })).toThrow();
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...brand, required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'brand', rationale: 'Explicit owner acceptance' }, provenance: { ...provenance, origin: 'user-confirmed' } }] }).checks[0]?.required).toBe(true);
  });
  it('permits sourced imported mechanical checks only through their exact core mapping', () => {
    const provenance = { origin: 'imported', derivation: 'source-criterion', source: { assetId: 'checklist-source' }, rationale: 'Mapped to existing core CTA requirement' };
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, provenance, sourceCriteria: [sourceCriterion] }] }).checks[0]?.required).toBe(true);
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, required: false, requiredBasis: null, provenance }] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, provenance: { ...provenance, origin: 'inferred' } }] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, provenance: { ...provenance, source: null } }] })).toThrow();
  });
});


it('rejects a source-criterion declaration without its attribution tuple', () => {
  const sourced = { ...check, provenance: { ...check.provenance, derivation: 'source-criterion' } };
  expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [sourced] })).toThrow();
  expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...sourced, sourceCriteria: [sourceCriterion] }] }).checks[0]?.sourceCriteria).toHaveLength(1);
});

it('rejects mandatory exception text even when default thresholds are retained', () => {
  const contrast = { ...check, requiredBasis: { type: 'mandatory', criterionId: 'core.text-contrast' }, parameters: { type: 'contrast', exceptionRationale: 'Claimed waiver' } };
  expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [contrast] })).toThrow();
});

it('keeps explicitly confirmed brand-derived requirements in judgment kind', () => {
  const provenance = { ...check.provenance, derivation: 'brand-analysis', source: { assetId: 'brand-source' } };
  expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, provenance }] })).toThrow();
  expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, kind: 'manual', provenance, parameters: { type: 'manual-procedure', procedure: 'Use a device', environment: 'Physical device' }, requiredBasis: { type: 'project-acceptance', requirementId: 'brand', rationale: 'Owner confirmation' } }] })).toThrow();
});

it('normalizes anchor tuples and optional absence without changing ordered targets/checks', () => {
  const second = { ...sourceCriterion, criterionId: 'z-last' };
  const normalized = { contextRevision: 2, checks: [{ ...check, intent: undefined, sourceCriteria: [second, sourceCriterion, second] }] };
  const canonical = canonicalizeProjectRubricDraft(normalized);
  expect(canonical.checks[0]).not.toHaveProperty('intent');
  expect(canonical.checks[0]?.sourceCriteria.map(anchor => anchor.criterionId)).toEqual(['cta-anchor', 'z-last']);
  expect(serializeProjectRubricDraft(normalized)).toBe(serializeProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [sourceCriterion, second] }] }));
  const a = { ...check, checkId: 'first' }, b = { ...check, checkId: 'second' };
  expect(serializeProjectRubricDraft({ contextRevision: 2, checks: [a, b] })).not.toBe(serializeProjectRubricDraft({ contextRevision: 2, checks: [b, a] }));
});

it('rejects whitespace around RFC 6901 pointers instead of repairing a different path', () => {
  for (const fieldPath of [' /purpose', '/purpose ', '\t/purpose']) {
    expect(() => parseProjectDesignContextDraft({ ...draft, factSources: [{ ...draft.factSources[0], fieldPath }, ...draft.factSources.slice(1)] })).toThrow();
  }
});

it('sorts source criteria by actual tuple values rather than JSON escapes', () => {
  const a = { ...sourceCriterion, criterionId: 'A' }, quote = { ...sourceCriterion, criterionId: '"' };
  const canonical = canonicalizeProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [a, quote] }] });
  expect(canonical.checks[0]?.sourceCriteria.map(anchor => anchor.criterionId)).toEqual(['"', 'A']);
  expect(serializeProjectDesignContextDraft(unknownDraft)).toBe('{"assumptions":["Purpose, audience, conversions and brand direction are unknown"],"audience":[],"brandDirection":null,"constraints":[],"conversions":[],"factSources":[],"purpose":null}');
});

it('distinguishes query attribution from forbidden URL userinfo', () => {
  const anchor = { ...sourceCriterion, canonicalUrl: 'https://example.com?contact=person@example.net' };
  expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [anchor] }] }).checks[0]?.sourceCriteria[0]?.canonicalUrl).toBe(anchor.canonicalUrl);
  expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [{ ...anchor, canonicalUrl: 'https://@example.com' }] }] })).toThrow();
});

describe('exact identifiers and absent-preference response provenance', () => {
  it.each([' book', 'book ', 'book\u0085', 'book\u009f', 'book\n'])('rejects padded or controlled identifier %j without repairing it', id => {
    expect(() => parseProjectDesignContextDraft({ ...draft, conversions: [{ ...draft.conversions[0], id }] })).toThrow();
    expect(() => parseProjectDesignContextDraft({ ...draft, constraints: [{ ...draft.constraints[0], id }] })).toThrow();
    expect(() => parseProjectDesignContextSnapshot({ projectId: id, revision: 0, context: null })).toThrow();
    expect(() => parseProjectDesignContextDraft({ ...draft, factSources: [{ ...draft.factSources[0], source: { assetId: id } }, ...draft.factSources.slice(1)] })).toThrow();
    expect(() => parseProjectDesignContextDraft({ ...draft, designSystemRef: { id, revisionOrDigest: 'sha256:abc' }, factSources: [...draft.factSources, fact('/designSystemRef/id', id), fact('/designSystemRef/revisionOrDigest')] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [{ ...sourceCriterion, criterionId: id }] }] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [{ ...sourceCriterion, revisionOrDigest: id }] }] })).toThrow();
    expect(() => resourceMotionMetadataSchema.parse({ state: 'animated', basis: 'observed', sourceRevisionOrDigest: 'v1', field: 'motion', evidenceRef: id })).toThrow();
  });
  it('preserves valid opaque project and reference identity exactly', () => {
    const id = 'project/opaque:é';
    expect(parseProjectDesignContextSnapshot({ projectId: id, revision: 0, context: null }).projectId).toBe(id);
    const reference = { id: 'brand/opaque:é', revisionOrDigest: 'sha256:abc/é' };
    expect(parseProjectDesignContextDraft({ ...draft, designSystemRef: reference, factSources: [...draft.factSources, fact('/designSystemRef/id', reference.id), fact('/designSystemRef/revisionOrDigest', reference.revisionOrDigest)] }).designSystemRef).toEqual(reference);
  });
  it('retains declared text trimming for source URL attribution', () => {
    expect(parseProjectRubricDraft({ contextRevision: 2, checks: [{ ...check, sourceCriteria: [{ ...sourceCriterion, canonicalUrl: `  ${sourceCriterion.canonicalUrl}\n` }] }] }).checks[0]?.sourceCriteria[0]?.canonicalUrl).toBe(sourceCriterion.canonicalUrl);
  });
  it.each(['project', null])('requires a saved off preference to exist for %s', projectId => {
    const disabled = { requested: false, applied: false, reason: 'context-disabled', projectId, preferenceRevision: 0, observedContextRevision: projectId ? 3 : 0, selection: 'saved', rankingVersion: 'local-context/1', resultMode: 'lexical' };
    expect(validationIssues(() => resourceContextStatusSchema.parse(disabled))).toEqual([
      { path: ['preferenceRevision'], message: 'Saved context-disabled selection requires a saved off preference' },
    ]);
    expect(resourceContextStatusSchema.parse({ ...disabled, selection: 'request-override' })).toMatchObject({ preferenceRevision: 0, selection: 'request-override' });
    if (projectId) expect(resourceContextStatusSchema.parse({ ...disabled, preferenceRevision: 1 })).toMatchObject({ preferenceRevision: 1, selection: 'saved' });
  });
});
