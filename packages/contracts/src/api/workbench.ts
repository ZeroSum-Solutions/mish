import { z } from 'zod';
import { componentTokenEvidenceSchema, componentAdmissionEvidenceSchema, componentFitSchema, componentPickerSchema, componentRankingSchema } from './components.js';
import { RESOURCE_SOURCE_IDS, resourceRefSchema as refSchema } from './workbench-resource-ref.js';
import { fontConstraintReportSchema, fontKitInventorySchema, fontProfileSchema } from './workbench-fonts.js';
import { refineSourceIdentity, resourceSourceIdentitySchema } from './workbench-reference-sources.js';
import { resourceContextStatusSchema, resourceSpineAffinitiesSchema, resourceSectionKindSchema, resourceMotionMetadataSchema, resourceExclusionsSchema } from './workbench-context.js';
export { RESOURCE_SOURCE_IDS, type ResourceRef } from './workbench-resource-ref.js';

export const RESOURCE_CATEGORIES = [
  'component', 'block', 'section', 'layout', 'cta-pattern', 'font', 'color-palette',
  'type-scale', 'spacing-scale', 'motion', 'image', 'video', 'audio', 'design-system',
  'skill', 'file', 'reference', 'icon', 'ui-kit', 'template',
] as const;
/** AC-R07 preamble: the preview adapter families whose readiness/error checks the Enlarge shell
 * runs. Every family is an HTML document in an opaque-origin sandbox with no network; the family
 * names the extra readiness check (compiled section bytes, styled-components style injection,
 * WebGL context availability) the host applies on top of the plain document's. */
export const PREVIEW_ADAPTER_FAMILIES = ['html-document', 'compiled-html-section', 'styled-components', 'webgl'] as const;
export type PreviewAdapterFamily = typeof PREVIEW_ADAPTER_FAMILIES[number];
const text = z.string().min(1);
const resourceUrl = z.string().regex(/^(?:\/(?![\/\\])[^\s\\]*|https:\/\/[^\s/\\?#]+[^\s\\]*)$/u, 'Expected a same-origin path or HTTPS URL without backslashes');
const grantSchema = z.object({
  operation: z.enum(['host-preview', 'incorporation', 'private-save', 'private-reuse', 'export', 'redistribution', 'backup']),
  state: z.enum(['permitted', 'unknown', 'blocked']), reason: z.string().nullable(),
}).strict();
const sameOriginPath = /^\/(?![\/\\])[^\s\\]*$/u;
const previewCapabilitySchema = z.object({
  available: z.boolean(), kind: z.enum(['html', 'reference', 'video', 'none']), url: resourceUrl.optional(), reason: z.string().nullable(),
  adapter: z.enum(PREVIEW_ADAPTER_FAMILIES).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.adapter && p.kind !== 'html') ctx.addIssue({ code: 'custom', path: ['adapter'], message: 'Only an HTML document preview names an adapter family' });
  // A native player loads its bytes in the host page, so only this origin's daemon routes qualify.
  if (p.kind === 'video' && p.url !== undefined && !sameOriginPath.test(p.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'A video preview loads only a same-origin path' });
});
/** What a variant brings into the target project: `project` must be declared/installed by the
 * project, `bundled` ships as local files with the unit, `compiled` is already compiled into it. */
const targetDependencySchema = z.object({ name: text, range: text, scope: z.enum(['project', 'bundled', 'compiled']) }).strict();
const candidateSchema = z.object({
  ref: refSchema, title: text, category: z.enum(RESOURCE_CATEGORIES),
  readiness: z.enum(['usable', 'unverified', 'reference-only', 'needs-repair', 'unavailable']),
  compatibility: z.object({ nativeFormat: text, targets: z.array(text), state: z.enum(['compatible', 'unverified', 'unsupported']), reason: z.string().nullable() }).strict(),
  rightsStatus: z.enum(['permitted', 'unknown', 'restricted']), fitReasons: z.array(z.string()),
  previewCapability: previewCapabilitySchema,
  adoptionCapability: z.object({ available: z.boolean(), reason: z.string().nullable() }).strict(),
  sourceAttribution: z.object({ title: text, url: resourceUrl.optional() }).strict(),
  availabilityReason: z.enum(['connector-offline', 'needs-sign-in', 'rights-blocked', 'adapter-missing']).optional(),
  thumbnail: text.optional(), variantGroup: text.optional(), variantLabel: text.optional(), variants: z.array(refSchema).optional(),
  targetDependencies: z.array(targetDependencySchema).optional(),
  styleClass: text.optional(), styleTags: z.array(text).optional(), implementationOrigin: text.optional(),
  spineAffinities: resourceSpineAffinitiesSchema.optional(), sectionKind: resourceSectionKindSchema.optional(),
  motionMetadata: resourceMotionMetadataSchema.optional(),
  /** AC-R11: font metadata, rights, spine fit and admitted local files (fonts source only). */
  fontProfile: fontProfileSchema.optional(),
  componentAdmissionEvidence: componentAdmissionEvidenceSchema.optional(),
  componentTokenEvidence: componentTokenEvidenceSchema.optional(),
  componentFit: componentFitSchema.optional(),
  componentAdapter: z.enum(['html-artifact/v1', 'react-source/v1', 'catalogue-files']).optional(),
  kitTokenAxes: z.object({ color: z.boolean(), radius: z.boolean(), type: z.boolean() }).strict().optional(),
  kitTokenNames: z.array(text).max(4096).optional(),
  relatedRefs: z.array(z.object({ ref: refSchema, relation: text }).strict()).optional(),
  operationGrants: z.array(grantSchema), admissionStage: z.enum(['discovered', 'reference-only', 'needs-repair', 'admitted']),
  needDecision: z.enum(['not-assessed', 'required', 'justified', 'reference-only', 'not-established']), needReason: text,
  /** Usable is reserved for a current, passed, per-item ledger receipt. W1 mints none. */
  acceptanceEvidence: z.object({ sourceDigest: text, receiptId: text, passed: z.boolean() }).strict().optional(),
  /** AC-R18.6–R18.8: exact source identity, acquisition mode and operation rights (additive). */
  sourceIdentity: resourceSourceIdentitySchema.optional(),
}).strict();
const resultSchema = candidateSchema.extend({ refKey: text }).superRefine((r, ctx) => {
  if (r.motionMetadata && r.motionMetadata.sourceRevisionOrDigest !== r.ref.revisionOrDigest) ctx.addIssue({ code: 'custom', path: ['motionMetadata', 'sourceRevisionOrDigest'], message: 'Motion metadata must name the exact resource revision' });
  if (r.readiness === 'usable' && (r.rightsStatus !== 'permitted' || !r.acceptanceEvidence?.passed || r.acceptanceEvidence.sourceDigest !== r.ref.revisionOrDigest)) ctx.addIssue({ code: 'custom', message: 'usable requires current passed per-item evidence' });
  if (r.adoptionCapability.available && (r.readiness !== 'usable' || !r.operationGrants.some(g => g.operation === 'incorporation' && g.state === 'permitted'))) ctx.addIssue({ code: 'custom', message: 'adoption requires usable evidence and an incorporation grant' });
  if (r.previewCapability.available && (!r.previewCapability.url || r.previewCapability.kind === 'none')) ctx.addIssue({ code: 'custom', message: 'available preview requires its permitted URL and kind' });
  if (r.fontProfile && r.category !== 'font') ctx.addIssue({ code: 'custom', path: ['fontProfile'], message: 'Only font resources carry a font profile' });
  refineSourceIdentity(r, ctx);
});
const statusSchema = z.object({
  sourceId: z.enum(RESOURCE_SOURCE_IDS), state: z.enum(['searched', 'degraded', 'unavailable', 'not-federated']),
  reason: z.string().nullable(), itemCount: z.number().int().nonnegative().nullable(), listingDigest: text.nullable(),
}).strict();
const requestSchema = z.object({
  projectId: text.optional(), query: z.string().max(10000).default(''), useProjectContext: z.boolean().optional(),
  facets: z.object({ category: z.enum(RESOURCE_CATEGORIES).optional(), sourceIds: z.array(z.enum(RESOURCE_SOURCE_IDS)).max(RESOURCE_SOURCE_IDS.length).optional() }).strict().default({}),
  componentPicker: componentPickerSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20), cursor: text.max(20000).optional(),
}).strict();
const contextSchema = resourceContextStatusSchema;
const searchSchema = z.object({
  results: z.array(resultSchema), sourceStatuses: z.array(statusSchema), context: contextSchema,
  contextRevision: z.number().int().nonnegative().nullable(), nextCursor: text.nullable(), indexDigest: text, degradedReason: z.string().nullable(),
  excluded: resourceExclusionsSchema.optional(),
  componentRanking: componentRankingSchema.optional(),
  /** AC-R11.3: present when applied project context carries font requirements or unread constraints. */
  fontConstraints: fontConstraintReportSchema.optional(),
  /** AC-R11 preamble: on a first page that includes fonts, every kit/example-declared family and its mapping. */
  fontKits: fontKitInventorySchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.context.applied ? !(value.contextRevision !== null && Number.isSafeInteger(value.contextRevision) && value.contextRevision > 0) : value.contextRevision !== null) {
    ctx.addIssue({ code: 'custom', path: ['contextRevision'], message: 'Only applied saved context has a positive safe revision' });
  }
  if (value.context.applied && value.context.observedContextRevision !== value.contextRevision) ctx.addIssue({ code: 'custom', path: ['contextRevision'], message: 'Applied revision must match the observed context actually used' });
  if (value.context.reason !== 'context-not-implemented' && !value.excluded) ctx.addIssue({ code: 'custom', path: ['excluded'], message: 'Completed P2 responses declare their exclusion counts' });
  if (value.excluded?.length && !value.context.applied && value.context.reason !== 'ranking-timeout') ctx.addIssue({ code: 'custom', path: ['excluded'], message: 'Exclusions require applied context or its explicit timeout fallback' });
});
/** One sibling of the inspected resource's variant group, resolved by the same inspect call so
 * its key is current. Exactly one entry is the inspected resource. */
const variantOptionSchema = z.object({
  refKey: text, title: text, label: text, current: z.boolean(), previewAvailable: z.boolean(),
  targetDependencies: z.array(targetDependencySchema),
}).strict();
const detailSchema = z.object({ resource: resultSchema, sourceStatus: statusSchema, variants: z.array(variantOptionSchema).optional() }).strict().superRefine((value, ctx) => {
  if (!value.variants) return;
  const current = value.variants.filter(v => v.current);
  if (current.length !== 1 || current[0]!.refKey !== value.resource.refKey) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Exactly one variant is the inspected resource' });
  if (new Set(value.variants.map(v => v.refKey)).size !== value.variants.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys are unique' });
});
export type ResourceResult = z.infer<typeof resultSchema>;
export type ResourceCandidate = Omit<ResourceResult, 'refKey'>;
export type ResourceSourceStatus = z.infer<typeof statusSchema>;
export type ResourceContextStatus = z.infer<typeof contextSchema>;
export type ResourceSearchRequest = z.infer<typeof requestSchema>;
export type ResourceSearchResponse = z.infer<typeof searchSchema>;
export type ResourceDetailResponse = z.infer<typeof detailSchema>;
export type ResourcePreviewCapability = z.infer<typeof previewCapabilitySchema>;
export type ResourceTargetDependency = z.infer<typeof targetDependencySchema>;
export type ResourceVariantOption = z.infer<typeof variantOptionSchema>;
export type ResourceRequestContext = { principalId: string; projectId?: string };
export type ResourceSourceSnapshot = { items: readonly ResourceCandidate[]; status: ResourceSourceStatus };
export function parseResourceSearchRequest(input: unknown): ResourceSearchRequest { return requestSchema.parse(input); }
export function parseResourceSearchResponse(input: unknown): ResourceSearchResponse { return searchSchema.parse(input); }
export function parseResourceDetailResponse(input: unknown): ResourceDetailResponse { return detailSchema.parse(input); }
