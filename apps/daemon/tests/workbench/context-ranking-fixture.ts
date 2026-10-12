import { parseProjectDesignContext, parseWorkbenchPreferencesSnapshot, type ProjectDesignContextDraft, type ResourceCandidate, type ProjectDesignContext } from '@open-design/contracts';
import type { ResourceSourceAdapter } from '../../src/workbench/resources.js';

export function savedContext(overrides: Partial<ProjectDesignContextDraft> = {}, revision = 1): ProjectDesignContext {
  const draft: ProjectDesignContextDraft = { purpose: null, audience: [], conversions: [], brandDirection: null, constraints: [], factSources: [], assumptions: ['Unknown purpose, audience and brand'], ...overrides };
  const annotate = (fieldPath: string, value: string) => draft.factSources.push({ fieldPath, value, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Explicit project declaration' });
  if (draft.purpose !== null) annotate('/purpose', draft.purpose);
  draft.audience.forEach((value, index) => annotate(`/audience/${index}`, value));
  draft.conversions.forEach((conversion, index) => { for (const field of ['kind', 'role', 'label', 'target'] as const) if (conversion[field] !== undefined) annotate(`/conversions/${index}/${field}`, conversion[field]); });
  if (draft.brandDirection !== null) annotate('/brandDirection', draft.brandDirection);
  if (draft.styleDirection !== undefined) annotate('/styleDirection', draft.styleDirection);
  draft.constraints.forEach((constraint, index) => annotate(`/constraints/${index}/value`, constraint.value));
  if (draft.spineCode) annotate('/spineCode', draft.spineCode);
  return parseProjectDesignContext({ ...draft, schema: 'workbench-context/1', projectId: 'p', revision, updatedAt: '2026-10-03T16:00:00.000Z' });
}
export const booking = { id: 'book', kind: 'booking', role: 'primary', label: 'Book a dental appointment' } as const;
export function candidate(id: string, overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return { ref: { sourceType: 'section', sourceId: 'sections', itemId: id, revisionOrDigest: 'v1' }, title: id, category: 'section', readiness: 'unverified', compatibility: { nativeFormat: 'html', targets: [], state: 'unverified', reason: 'Target proof pending' }, rightsStatus: 'restricted', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'Reference only' }, adoptionCapability: { available: false, reason: 'Restricted source' }, sourceAttribution: { title: 'Local source' }, operationGrants: [{ operation: 'incorporation', state: 'blocked', reason: 'No incorporation grant' }], admissionStage: 'reference-only', needDecision: 'not-assessed', needReason: 'Pending project decision', ...overrides };
}
export function adapter(items: ResourceCandidate[]): ResourceSourceAdapter {
  return { sourceId: 'sections', async list() { return { items, status: { sourceId: 'sections', state: 'searched', reason: null, itemCount: items.length, listingDigest: null } }; } };
}
export function projectState(context: ProjectDesignContext | null = savedContext(), enabled = true, preferenceRevision = 0) {
  return { context: { projectId: 'p', revision: context?.revision ?? 0, context }, preferences: parseWorkbenchPreferencesSnapshot({ projectId: 'p', revision: preferenceRevision, preferences: preferenceRevision ? { schema: 'workbench-preferences/1', projectId: 'p', revision: preferenceRevision, useProjectContext: enabled, updatedAt: '2026-10-03T16:00:00.000Z' } : null, effective: { useProjectContext: enabled } }) };
}
