import { z } from 'zod';
import { RESOURCE_SOURCE_IDS, resourceRefSchema } from './workbench-resource-ref.js';
import type { SectionCatalogSectionKind, SectionCatalogSpineCode } from './section-catalog.js';

const humanText = (max: number) => z.string().trim().min(1).max(max);
const identifier = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value), 'Identifiers cannot contain padding or controls');
const logicalId = identifier(64).pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u));
const projectId = identifier(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: false }).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}, 'Expected a real UTC ISO 8601 timestamp');
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
const issue = (ctx: z.RefinementCtx, path: Array<string | number>, message: string) => ctx.addIssue({ code: 'custom', path, message });

// Exhaustive maps stay checked against the existing section catalog's literal types.
const spines = { TL: true, PA: true, CO: true, SM: true, CS: true, LM: true, BA: true, TU: true, MI: true } satisfies Record<SectionCatalogSpineCode, true>;
const sectionKinds = {
  navigation: true, hero: true, features: true, services: true, benefits: true, 'process-steps': true,
  'proof-gallery': true, 'product-grid': true, pricing: true, 'plan-comparison': true, testimonials: true,
  'reviews-ratings': true, 'stats-metrics': true, 'logo-wall': true, team: true, 'about-story': true,
  'manifesto-statement': true, faq: true, 'blog-articles': true, 'newsletter-waitlist': true,
  'contact-form': true, 'booking-availability': true, 'location-map-hours': true, 'cta-band': true,
  footer: true, 'timeline-roadmap': true, integrations: true, specifications: true,
  'page-composition': true, unclassified: true,
} satisfies Record<SectionCatalogSectionKind, true>;
const spineSchema = z.custom<SectionCatalogSpineCode>(value => typeof value === 'string' && Object.hasOwn(spines, value));
export const resourceSectionKindSchema = z.custom<SectionCatalogSectionKind>(value => typeof value === 'string' && Object.hasOwn(sectionKinds, value));
export const resourceSpineAffinitiesSchema = z.union([
  z.array(spineSchema).min(1).max(9).refine(unique, 'Duplicate spine'), z.literal('any'), z.literal('unclassified'),
]);
export const resourceMotionMetadataSchema = z.object({
  state: z.enum(['static', 'animated', 'reduced-compatible', 'unknown']), basis: z.enum(['declared', 'observed']),
  sourceRevisionOrDigest: resourceRefSchema.shape.revisionOrDigest, field: humanText(200), evidenceRef: identifier(200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.basis === 'observed' && !value.evidenceRef) issue(ctx, ['evidenceRef'], 'Observed motion requires evidence');
});

const contextSelectionFields = {
  projectId: projectId.nullable(), preferenceRevision: expectedRevision, observedContextRevision: expectedRevision,
  selection: z.enum(['saved', 'request-override']), rankingVersion: z.literal('local-context/1'),
};
export const resourceContextStatusSchema = z.union([
  z.object({ ...contextSelectionFields, requested: z.literal(true), applied: z.literal(true), reason: z.null(), projectId, observedContextRevision: revision, resultMode: z.literal('ranked') }).strict(),
  z.object({ ...contextSelectionFields, requested: z.literal(false), applied: z.literal(false), reason: z.literal('context-disabled'), resultMode: z.literal('lexical') }).strict(),
  z.object({ ...contextSelectionFields, requested: z.literal(true), applied: z.literal(false), reason: z.enum(['no-project', 'context-absent', 'context-not-rankable']), resultMode: z.literal('lexical') }).strict(),
  z.object({ ...contextSelectionFields, requested: z.literal(true), applied: z.literal(false), reason: z.literal('ranking-timeout'), resultMode: z.literal('timeout-lexical') }).strict(),
  // Exact W1 read compatibility; completed P2 responses require the metadata above.
  z.object({ requested: z.literal(true), applied: z.literal(false), reason: z.literal('context-not-implemented') }).strict(),
]).superRefine((value, ctx) => {
  if (value.reason === 'context-not-implemented') return;
  if (value.reason === 'context-disabled' && value.selection === 'saved' && value.preferenceRevision === 0) issue(ctx, ['preferenceRevision'], 'Saved context-disabled selection requires a saved off preference');
  if (value.projectId === null && (value.preferenceRevision !== 0 || value.observedContextRevision !== 0)) issue(ctx, ['projectId'], 'Projectless selection has no project record revisions');
  if (value.reason === 'no-project' && value.projectId !== null) issue(ctx, ['reason'], 'No-project fallback cannot describe a project');
  if (value.projectId === null && value.reason !== 'context-disabled' && value.reason !== 'no-project') issue(ctx, ['projectId'], 'This context state requires a project');
  if (value.reason === 'context-absent' && value.observedContextRevision !== 0) issue(ctx, ['observedContextRevision'], 'Absent context has observed revision zero');
  if ((value.reason === 'context-not-rankable' || value.reason === 'ranking-timeout') && value.observedContextRevision === 0) issue(ctx, ['observedContextRevision'], 'Ranking fallback requires an observed saved context');
});
export const resourceExclusionsSchema = z.array(z.object({
  reason: z.literal('motion-constraint'), constraintId: logicalId, count: revision,
}).strict()).max(1);

const factSourceSchema = z.object({
  fieldPath: z.string().min(1).max(256), value: humanText(2048), origin: z.enum(['user-confirmed', 'imported', 'inferred']),
  source: z.union([z.object({ assetId: identifier(200) }).strict(), z.object({ resourceRef: resourceRefSchema }).strict()]).nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(), rationale: humanText(1000),
}).strict().superRefine((value, ctx) => {
  if (value.origin === 'imported' && !value.source) issue(ctx, ['source'], 'Imported facts require their source');
});
const conversionSchema = z.object({
  id: logicalId, kind: z.enum(['signup', 'call', 'purchase', 'booking', 'contact', 'download', 'subscribe', 'other']),
  role: z.enum(['primary', 'secondary']),
  label: humanText(300), target: humanText(2048).optional(),
}).strict();
const constraintSchema = z.discriminatedUnion('kind', [
  z.object({ id: logicalId, kind: z.literal('motion'), value: z.enum(['none', 'reduced', 'allowed']) }).strict(),
  z.object({ id: logicalId, kind: z.literal('runtime'), value: humanText(1000) }).strict(),
  z.object({ id: logicalId, kind: z.literal('accessibility'), value: humanText(1000) }).strict(),
  z.object({ id: logicalId, kind: z.literal('other'), value: humanText(1000) }).strict(),
]);
const contextFields = {
  purpose: z.string().trim().max(2000).nullable(), audience: z.array(humanText(500)).max(20),
  conversions: z.array(conversionSchema).max(20), brandDirection: z.string().trim().max(2000).nullable(),
  styleDirection: humanText(1000).optional(), constraints: z.array(constraintSchema).max(40), spineCode: spineSchema.optional(),
  designSystemRef: z.object({ sourceId: z.enum(RESOURCE_SOURCE_IDS).optional(), id: identifier(200), revisionOrDigest: identifier(256) }).strict().optional(),
  factSources: z.array(factSourceSchema).max(200), assumptions: z.array(humanText(1000)).max(40),
};
const contextObject = z.object(contextFields).strict();
function validateContext(value: z.infer<typeof contextObject>, ctx: z.RefinementCtx): void {
  if (!unique(value.conversions.map(item => item.id))) issue(ctx, ['conversions'], 'Conversion IDs must be unique');
  if (value.conversions.length && value.conversions.filter(item => item.role === 'primary').length !== 1) issue(ctx, ['conversions'], 'A nonempty conversion list needs exactly one primary');
  if (!unique(value.constraints.map(item => item.id))) issue(ctx, ['constraints'], 'Constraint IDs must be unique');
  if (value.constraints.filter(item => item.kind === 'motion').length > 1) issue(ctx, ['constraints'], 'Only one motion constraint is allowed');
  if ((!value.purpose || !value.brandDirection || !value.audience.length || !value.conversions.length) && !value.assumptions.length) issue(ctx, ['assumptions'], 'Explain unknown purpose, audience, conversions or brand');
  const leaves = new Map<string, string>();
  const add = (path: string, text: string | null | undefined) => { if (text) leaves.set(path, text); };
  add('/purpose', value.purpose); add('/brandDirection', value.brandDirection);
  add('/styleDirection', value.styleDirection); add('/spineCode', value.spineCode);
  value.audience.forEach((text, index) => add(`/audience/${index}`, text));
  value.conversions.forEach((item, index) => {
    add(`/conversions/${index}/kind`, item.kind); add(`/conversions/${index}/role`, item.role); add(`/conversions/${index}/label`, item.label); add(`/conversions/${index}/target`, item.target);
  });
  value.constraints.forEach((item, index) => add(`/constraints/${index}/value`, item.value));
  if (value.designSystemRef) { if (value.designSystemRef.sourceId) add('/designSystemRef/sourceId', value.designSystemRef.sourceId); add('/designSystemRef/id', value.designSystemRef.id); add('/designSystemRef/revisionOrDigest', value.designSystemRef.revisionOrDigest); }
  const annotated = new Set<string>();
  value.factSources.forEach((source, index) => {
    if (!leaves.has(source.fieldPath)) issue(ctx, ['factSources', index, 'fieldPath'], 'Expected a populated supported leaf of this draft');
    else if (leaves.get(source.fieldPath) !== source.value) issue(ctx, ['factSources', index, 'value'], 'Fact source must bind the normalized scalar at its pointer');
    if (annotated.has(source.fieldPath)) issue(ctx, ['factSources', index, 'fieldPath'], 'Duplicate fact source path');
    annotated.add(source.fieldPath);
  });
  for (const path of leaves.keys()) if (!annotated.has(path)) issue(ctx, ['factSources'], `Missing provenance for ${path}`);
}
const contextDraftSchema = contextObject.superRefine(validateContext);
const contextRecordSchema = contextObject.extend({ schema: z.literal('workbench-context/1'), projectId, revision, updatedAt: timestamp }).superRefine(validateContext);

export const WORKBENCH_MANDATORY_CRITERION_IDS = ['core.declared-actions', 'core.text-contrast', 'core.console-resources', 'core.responsive-overflow', 'core.keyboard-focus', 'core.document-semantics'] as const;
const mandatoryIds = WORKBENCH_MANDATORY_CRITERION_IDS;
const mandatoryTypes = {
  'core.declared-actions': 'cta', 'core.text-contrast': 'contrast', 'core.console-resources': 'console-resources',
  'core.responsive-overflow': 'overflow', 'core.keyboard-focus': 'keyboard-focus', 'core.document-semantics': 'document-semantics',
} as const;
const basisSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mandatory'), criterionId: z.enum(mandatoryIds) }).strict(),
  z.object({ type: z.literal('project-acceptance'), requirementId: logicalId, rationale: humanText(1000) }).strict(),
]).nullable();
const viewports = z.array(z.number().int().min(160).max(7680)).max(12).refine(values => unique(values) && [320, 375, 768, 1440].every(width => values.includes(width)), 'Include every core viewport once').default([320, 375, 768, 1440]);
/** Motion sampling costs seconds per width, so a motion check defaults to one narrow and one wide width; a rubric may list more. */
export const WORKBENCH_MOTION_DEFAULT_VIEWPORTS = [375, 1440] as const;
const motionViewports = z.array(z.number().int().min(160).max(7680)).max(12).refine(values => unique(values) && WORKBENCH_MOTION_DEFAULT_VIEWPORTS.every(width => values.includes(width)), 'Include 375 and 1440 once').default([...WORKBENCH_MOTION_DEFAULT_VIEWPORTS]);
const targets = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversion'), id: logicalId }).strict(),
  z.object({ type: z.literal('selector'), selector: humanText(500) }).strict(),
])).min(1).max(20);
const mechanicalParameters = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cta'), actionType: z.enum(['conversion', 'form', 'navigation']), targets, viewports }).strict(),
  z.object({ type: z.literal('contrast'), normalTextMinRatio: z.number().finite().min(1).max(21).default(4.5), largeTextMinRatio: z.number().finite().min(1).max(21).default(3), targets: targets.optional(), viewports, exceptionRationale: humanText(1000).optional() }).strict(),
  z.object({ type: z.literal('console-resources'), failOnConsoleError: z.boolean().default(true), failOnBrokenResource: z.boolean().default(true), viewports }).strict(),
  z.object({ type: z.literal('overflow'), toleranceCssPixels: z.number().finite().min(0).max(20).default(0), checkClippedContent: z.boolean().default(true), targets: targets.optional(), viewports }).strict(),
  z.object({ type: z.literal('keyboard-focus'), requireVisibleFocus: z.boolean().default(true), requireFocusReturn: z.boolean().default(true), targets: targets.optional(), viewports }).strict(),
  z.object({ type: z.literal('document-semantics'), requireNamedControls: z.boolean().default(true), requireHeadingStructure: z.boolean().default(true), targets: targets.optional(), viewports }).strict(),
  /**
   * Opt-in (AC-R06 preamble, B4-2b), never a mandatory criterion: content that
   * keeps moving past five seconds offers a keyboard-reachable pause/stop/hide
   * control, prefers-reduced-motion: reduce shows a static or reduced page, and
   * a live switch to reduce mid-session is honoured. Whole-page scope; runs at
   * 375 and 1440 CSS px by default, not at every core width.
   */
  z.object({ type: z.literal('motion'), requirePauseControl: z.boolean().default(true), requireReducedMotionFallback: z.boolean().default(true), requireLivePreferenceChange: z.boolean().default(true), viewports: motionViewports }).strict(),
]);
const canonicalUrl = humanText(2048).refine(value => {
  try {
    const url = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]*)/iu)?.[1];
    return url.protocol === 'https:' && !!authority && !authority.includes('@') && !!url.hostname && !url.username && !url.password && !/[\\\x00-\x20\x7f]/u.test(value);
  } catch { return false; }
}, 'Expected credential-free HTTPS source attribution');
const sourceCriterionSchema = z.object({ sourceId: z.enum(RESOURCE_SOURCE_IDS), revisionOrDigest: identifier(256), criterionId: identifier(200), canonicalUrl }).strict();
const checkProvenanceSchema = z.object({
  origin: z.enum(['user-confirmed', 'imported', 'inferred']), derivation: z.enum(['project-input', 'source-criterion', 'brand-analysis']),
  source: z.union([z.object({ assetId: identifier(200) }).strict(), z.object({ resourceRef: resourceRefSchema }).strict()]).nullable(),
  rationale: humanText(1000),
}).strict().superRefine((value, ctx) => {
  if ((value.origin === 'imported' || value.derivation === 'brand-analysis') && !value.source) issue(ctx, ['source'], 'Imported and brand-derived checks require their exact source');
});
const checkFields = {
  checkId: logicalId, required: z.boolean(), severity: z.enum(['critical', 'high', 'medium', 'low']), requiredBasis: basisSchema,
  provenance: checkProvenanceSchema,
  evidenceTypes: z.array(z.enum(['probe', 'screenshot', 'console', 'network', 'computed-style', 'accessibility-tree', 'keyboard-trace', 'manual-observation', 'judgment-rationale'])).min(1).max(9).refine(unique, 'Duplicate evidence type'),
  intent: humanText(2000).optional(), sourceCriteria: z.array(sourceCriterionSchema).max(12).transform(values => {
    const seen = new Set<string>();
    return values.filter(value => { const key = sourceCriterionKey(value); if (seen.has(key)) return false; seen.add(key); return true; });
  }),
  applicability: z.object({ status: z.enum(['applicable', 'not-applicable', 'undetermined']), targetScope: humanText(1000), rationale: humanText(2000), evaluator: humanText(200) }).strict().optional(),
};
const checkSchema = z.discriminatedUnion('kind', [
  z.object({ ...checkFields, kind: z.literal('mechanical'), parameters: mechanicalParameters }).strict(),
  z.object({ ...checkFields, kind: z.literal('judgment'), parameters: z.object({ type: z.literal('criterion'), criterion: humanText(2000), targetScope: humanText(1000).optional() }).strict() }).strict(),
  z.object({ ...checkFields, kind: z.literal('manual'), parameters: z.object({ type: z.literal('manual-procedure'), procedure: humanText(2000), environment: humanText(1000), targetScope: humanText(1000).optional() }).strict() }).strict(),
]).superRefine((value, ctx) => {
  if (value.required && !value.requiredBasis) issue(ctx, ['requiredBasis'], 'Required checks need mandatory or explicit project acceptance basis');
  if (value.requiredBasis && !value.required) issue(ctx, ['required'], 'A declared basis requires a required check');
  const basis = value.requiredBasis;
  const parameters = value.parameters;
  if (basis?.type === 'mandatory') {
    if (value.kind !== 'mechanical' || parameters.type !== mandatoryTypes[basis.criterionId]) issue(ctx, ['requiredBasis'], 'Core basis requires its corresponding mechanical parameter type');
    if (!['high', 'critical'].includes(value.severity)) issue(ctx, ['severity'], 'Core declarations must have high or critical severity');
    if ((parameters.type === 'contrast' && (parameters.normalTextMinRatio < 4.5 || parameters.largeTextMinRatio < 3 || parameters.exceptionRationale !== undefined)) ||
        (parameters.type === 'console-resources' && (!parameters.failOnConsoleError || !parameters.failOnBrokenResource)) ||
        (parameters.type === 'overflow' && (parameters.toleranceCssPixels !== 0 || !parameters.checkClippedContent)) ||
        (parameters.type === 'keyboard-focus' && (!parameters.requireVisibleFocus || !parameters.requireFocusReturn)) ||
        (parameters.type === 'document-semantics' && (!parameters.requireNamedControls || !parameters.requireHeadingStructure))) issue(ctx, ['parameters'], 'A core mandatory declaration cannot be weakened');
  }
  const provenance = value.provenance;
  if (provenance.derivation === 'source-criterion' && !value.sourceCriteria.length) issue(ctx, ['sourceCriteria'], 'Source-derived criteria require an attribution tuple');
  if (basis?.type === 'project-acceptance' && provenance.origin !== 'user-confirmed') issue(ctx, ['provenance'], 'Project acceptance requires explicit user confirmation');
  if (provenance.derivation === 'brand-analysis') {
    if (value.kind !== 'judgment' || (value.required && !(provenance.origin === 'user-confirmed' && basis?.type === 'project-acceptance'))) issue(ctx, ['provenance'], 'Brand-derived checks begin as optional judgments unless explicitly accepted');
  } else if (provenance.origin !== 'user-confirmed') {
    const mappedMandatory = provenance.origin === 'imported' && provenance.derivation === 'source-criterion' && basis?.type === 'mandatory' && value.kind === 'mechanical' && parameters.type === mandatoryTypes[basis.criterionId];
    if (!mappedMandatory && (value.kind === 'mechanical' || value.required)) issue(ctx, ['provenance'], 'Unconfirmed derived checks remain optional judgment or manual declarations');
  }
  if (value.parameters.type === 'motion' && !value.parameters.requirePauseControl && !value.parameters.requireReducedMotionFallback && !value.parameters.requireLivePreferenceChange) issue(ctx, ['parameters'], 'Enable at least one motion requirement');
  if (value.parameters.type === 'contrast' && (value.parameters.normalTextMinRatio < 4.5 || value.parameters.largeTextMinRatio < 3) && !value.parameters.exceptionRationale) issue(ctx, ['parameters', 'exceptionRationale'], 'Declare the lower contrast threshold exception');
});
const rubricObject = z.object({ contextRevision: revision, checks: z.array(checkSchema).max(100) }).strict();
function validateRubric(value: z.infer<typeof rubricObject>, ctx: z.RefinementCtx): void {
  if (!unique(value.checks.map(check => check.checkId))) issue(ctx, ['checks'], 'Check IDs must be unique');
}
const rubricDraftSchema = rubricObject.superRefine(validateRubric);
const rubricRecordSchema = rubricObject.extend({ schema: z.literal('workbench-rubric/1'), projectId, revision, updatedAt: timestamp }).superRefine(validateRubric);
const preferencesRecordSchema = z.object({ schema: z.literal('workbench-preferences/1'), projectId, revision, useProjectContext: z.boolean(), updatedAt: timestamp }).strict();

function validateSnapshot(value: { projectId: string; revision: number }, record: { projectId: string; revision: number } | null, ctx: z.RefinementCtx): void {
  if (record === null ? value.revision !== 0 : value.revision !== record.revision || value.projectId !== record.projectId) issue(ctx, [], 'Snapshot identity/revision must match its record; absence is revision zero');
}
const contextSnapshotSchema = z.object({ projectId, revision: expectedRevision, context: contextRecordSchema.nullable() }).strict().superRefine((value, ctx) => validateSnapshot(value, value.context, ctx));
const rubricSnapshotSchema = z.object({
  projectId, revision: expectedRevision, rubric: rubricRecordSchema.nullable(),
  linkage: z.object({ state: z.enum(['current', 'stale']), referencedContextRevision: revision, currentContextRevision: revision }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  validateSnapshot(value, value.rubric, ctx);
  if (!value.rubric) { if (value.linkage !== null) issue(ctx, ['linkage'], 'Absent rubric has no linkage'); return; }
  const link = value.linkage;
  if (!link || link.referencedContextRevision !== value.rubric.contextRevision || link.currentContextRevision < link.referencedContextRevision || (link.state === 'current') !== (link.currentContextRevision === link.referencedContextRevision)) issue(ctx, ['linkage'], 'Linkage must describe the referenced and current context accurately');
});
const preferencesSnapshotSchema = z.object({ projectId, revision: expectedRevision, preferences: preferencesRecordSchema.nullable(), effective: z.object({ useProjectContext: z.boolean() }).strict() }).strict().superRefine((value, ctx) => {
  validateSnapshot(value, value.preferences, ctx);
  if (value.effective.useProjectContext !== (value.preferences?.useProjectContext ?? true)) issue(ctx, ['effective'], 'Effective preference must match the saved value or default on');
});
const putContextSchema = z.object({ expectedRevision, draft: contextDraftSchema }).strict();
const putRubricSchema = z.object({ expectedRevision, draft: rubricDraftSchema }).strict();
const putPreferencesSchema = z.object({ expectedRevision, useProjectContext: z.boolean() }).strict();

function sourceCriterionKey(value: z.infer<typeof sourceCriterionSchema>): string {
  return JSON.stringify([value.sourceId, value.revisionOrDigest, value.criterionId, value.canonicalUrl]);
}
function compareSourceCriteria(a: z.infer<typeof sourceCriterionSchema>, b: z.infer<typeof sourceCriterionSchema>): number {
  for (const key of ['sourceId', 'revisionOrDigest', 'criterionId', 'canonicalUrl'] as const) {
    const comparison = compareBytes(a[key], b[key]);
    if (comparison) return comparison;
  }
  return 0;
}
// Unicode scalar order agrees with UTF-8 byte order, including non-ASCII attribution.
function compareBytes(a: string, b: string): number {
  const left = Array.from(a, char => char.codePointAt(0)!);
  const right = Array.from(b, char => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareBytes(a, b)).map(([key, entry]) => [key, sortObjectKeys(entry)]));
  return value;
}

export type FactSource = z.infer<typeof factSourceSchema>;
export type ProjectDesignContextDraft = z.infer<typeof contextDraftSchema>;
export type ProjectDesignContext = z.infer<typeof contextRecordSchema>;
export type ProjectDesignContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export type ProjectRubricDraft = z.infer<typeof rubricDraftSchema>;
export type ProjectRubric = z.infer<typeof rubricRecordSchema>;
export type ProjectRubricSnapshot = z.infer<typeof rubricSnapshotSchema>;
export type WorkbenchPreferences = z.infer<typeof preferencesRecordSchema>;
export type WorkbenchPreferencesSnapshot = z.infer<typeof preferencesSnapshotSchema>;
export type PutProjectDesignContext = z.infer<typeof putContextSchema>;
export type PutProjectRubric = z.infer<typeof putRubricSchema>;
export type PutWorkbenchPreferences = z.infer<typeof putPreferencesSchema>;
export const parseProjectDesignContextDraft = (input: unknown): ProjectDesignContextDraft => contextDraftSchema.parse(input);
export const parseProjectDesignContext = (input: unknown): ProjectDesignContext => contextRecordSchema.parse(input);
export const parseProjectDesignContextSnapshot = (input: unknown): ProjectDesignContextSnapshot => contextSnapshotSchema.parse(input);
export const parseProjectRubricDraft = (input: unknown): ProjectRubricDraft => rubricDraftSchema.parse(input);
export const parseProjectRubric = (input: unknown): ProjectRubric => rubricRecordSchema.parse(input);
export const parseProjectRubricSnapshot = (input: unknown): ProjectRubricSnapshot => rubricSnapshotSchema.parse(input);
export const parseWorkbenchPreferences = (input: unknown): WorkbenchPreferences => preferencesRecordSchema.parse(input);
export const parseWorkbenchPreferencesSnapshot = (input: unknown): WorkbenchPreferencesSnapshot => preferencesSnapshotSchema.parse(input);
export const parsePutProjectDesignContext = (input: unknown): PutProjectDesignContext => putContextSchema.parse(input);
export const parsePutProjectRubric = (input: unknown): PutProjectRubric => putRubricSchema.parse(input);
export const parsePutWorkbenchPreferences = (input: unknown): PutWorkbenchPreferences => putPreferencesSchema.parse(input);
export function canonicalizeProjectDesignContextDraft(input: unknown): ProjectDesignContextDraft {
  const value = parseProjectDesignContextDraft(input);
  value.factSources.sort((a, b) => compareBytes(a.fieldPath, b.fieldPath));
  return sortObjectKeys(value) as ProjectDesignContextDraft;
}
export function canonicalizeProjectRubricDraft(input: unknown): ProjectRubricDraft {
  const value = parseProjectRubricDraft(input);
  for (const check of value.checks) {
    check.evidenceTypes.sort(compareBytes);
    check.sourceCriteria.sort(compareSourceCriteria);
    if (check.kind === 'mechanical') check.parameters.viewports.sort((a, b) => a - b);
  }
  return sortObjectKeys(value) as ProjectRubricDraft;
}
export const serializeProjectDesignContextDraft = (input: unknown): string => JSON.stringify(canonicalizeProjectDesignContextDraft(input));
export const serializeProjectRubricDraft = (input: unknown): string => JSON.stringify(canonicalizeProjectRubricDraft(input));
