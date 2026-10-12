import { z } from 'zod';
import { RIGHTS_BASES, SOURCE_OPERATIONS } from './workbench-source-admission.js';

/**
 * AC-R18.6/AC-R18.7/AC-R18.8 source identity carried on a resource result: the exact
 * requested repository and pinned commit, how bytes would be acquired, any documented
 * connector and its true state, per-operation rights and the next gate. Pure shapes;
 * parsing proves a record is well formed, never that a grant or connector exists.
 */
const text = z.string().min(1).max(2000).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
const shortText = z.string().min(1).max(200).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
const httpsUrl = z.string().max(500).regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s?#\\@]*)?$/u, 'Expected an HTTPS URL without credentials or query');
const evidenceRef = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._/#:-]*$/u)
  .refine(value => !value.split('/').some(part => part === '..' || part === '.'), 'Evidence references are normalized repository paths');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const SOURCE_ACQUISITION_MODES = ['reference-link', 'licensed-mcp', 'project-fetch', 'bundled-catalogue'] as const;
/** First-release targets (G02). Anything else is an unsupported native format. */
export const SUPPORTED_ADOPTION_TARGETS = ['html', 'react'] as const;

const operationRightSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked', 'unknown']), reason: text.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.decision !== 'allowed' && value.reason === null) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Unknown or blocked rights state why' });
});

export const resourceSourceIdentitySchema = z.object({
  repositoryUrl: httpsUrl,
  /** Pinned Git commit; null only for a source whose identity is a registry document digest. */
  commit: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
  registryLocator: httpsUrl.nullable(),
  /** Exact bytes of the identifying file (entry source or collection registry). */
  contentSha256: sha256.nullable(),
  acquisitionMode: z.enum(SOURCE_ACQUISITION_MODES),
  /** A connector the source documents. Documentation is never an installed or executed connector. */
  documentedConnector: z.object({ name: shortText, state: z.enum(['documented-unexecuted']), evidenceRef }).strict().nullable(),
  /** Every operation for a fetched source; empty for a reference link that acquires nothing. */
  operationRights: z.array(operationRightSchema).max(SOURCE_OPERATIONS.length),
  nextGate: text,
  evidenceRefs: z.array(evidenceRef).min(1).max(20).refine(unique, 'Duplicate evidence references'),
  /**
   * The frozen RightsAssessment the operation decisions come from: who assessed, on what
   * basis, against which exact terms digest and clauses. A display summary of a stored
   * record, never a grant by itself.
   */
  rightsAssessment: z.object({
    id: shortText, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    evaluatorRole: z.enum(['source-curator', 'project-owner', 'rights-reviewer']),
    basis: z.enum(RIGHTS_BASES),
    termsUrl: httpsUrl.nullable(), termsSha256: sha256.nullable(),
    clauseRefs: z.array(shortText).min(1).max(100).refine(unique, 'Duplicate clause references'),
    evaluatedAt: z.string().datetime(),
    ownerDecision: z.object({ decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), decidedBy: shortText, citation: text }).strict().optional(),
  }).strict().superRefine((value, ctx) => {
    if ((value.basis === 'owner-accepted-private-use') !== (value.ownerDecision !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['ownerDecision'], message: 'An owner decision is cited exactly when the basis is owner-accepted private use' });
    }
  }).optional(),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.operationRights.map(right => right.operation))) ctx.addIssue({ code: 'custom', path: ['operationRights'], message: 'Duplicate operation' });
  if (value.operationRights.some(right => right.decision === 'allowed') && !value.rightsAssessment) {
    ctx.addIssue({ code: 'custom', path: ['rightsAssessment'], message: 'An allowed operation right cites the RightsAssessment it comes from' });
  }
  if (value.acquisitionMode !== 'reference-link' && value.operationRights.length !== SOURCE_OPERATIONS.length) {
    ctx.addIssue({ code: 'custom', path: ['operationRights'], message: 'An acquiring source records every operation decision' });
  }
  if (value.commit === null && value.contentSha256 === null) ctx.addIssue({ code: 'custom', path: ['commit'], message: 'Identity needs a pinned commit or a content digest' });
});
export type ResourceSourceIdentity = z.infer<typeof resourceSourceIdentitySchema>;
export const parseResourceSourceIdentity = (input: unknown): ResourceSourceIdentity => resourceSourceIdentitySchema.parse(input);

/** Minimal view of a resource result the cross-field rules below need. */
interface IdentityBearer {
  readiness: string; admissionStage: string;
  compatibility: { nativeFormat: string; targets: string[]; state: string };
  previewCapability: { available: boolean; kind: string };
  adoptionCapability: { available: boolean };
  sourceIdentity?: ResourceSourceIdentity | undefined;
}
/** Shared refinement for resource results (workbench.ts). */
export function refineSourceIdentity(value: IdentityBearer, ctx: z.RefinementCtx): void {
  if (value.compatibility.nativeFormat === 'svelte' && (value.compatibility.state !== 'unsupported' || value.compatibility.targets.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['compatibility'], message: 'Native svelte material has no supported HTML/React target' });
  }
  const identity = value.sourceIdentity;
  if (!identity) return;
  if (identity.acquisitionMode === 'reference-link' && (value.readiness !== 'reference-only' || value.admissionStage !== 'reference-only' || value.adoptionCapability.available || value.previewCapability.kind === 'html')) {
    ctx.addIssue({ code: 'custom', path: ['sourceIdentity'], message: 'A reference-link source stays reference-only: no admission, adoption or executable preview' });
  }
  const hostPreview = identity.operationRights.find(right => right.operation === 'host-preview');
  if (identity.acquisitionMode !== 'reference-link' && value.previewCapability.kind === 'html' && hostPreview?.decision !== 'allowed') {
    ctx.addIssue({ code: 'custom', path: ['previewCapability'], message: 'An executable preview requires an allowed host-preview grant' });
  }
}

/* ------------------------------ typed adoption refusals ------------------------------ */

const needDecision = z.enum(['not-assessed', 'required', 'justified', 'reference-only', 'not-established']);
const nativeFormatRefusalSchema = z.object({
  kind: z.literal('adoption'), reason: z.literal('unsupported-capability'),
  nativeFormat: shortText, supportedTargets: z.array(z.enum(SUPPORTED_ADOPTION_TARGETS)).min(1),
  needDecision, needReason: text, nextGate: text,
}).strict();
const operationRightsRefusalSchema = z.object({
  kind: z.literal('adoption'), reason: z.literal('operation-rights-unknown'),
  operations: z.array(z.object({ operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['blocked', 'unknown']), reason: text }).strict()).min(1).max(SOURCE_OPERATIONS.length),
  nextGate: text,
}).strict();
/** 422 details when a native format has no first-release target (checked before the optional need gate). */
export type NativeFormatRefusalDetails = z.infer<typeof nativeFormatRefusalSchema>;
/** 422 details when the operations an apply needs are not allowed for this source. */
export type OperationRightsRefusalDetails = z.infer<typeof operationRightsRefusalSchema>;
export const parseNativeFormatRefusalDetails = (input: unknown): NativeFormatRefusalDetails => nativeFormatRefusalSchema.parse(input);
export const parseOperationRightsRefusalDetails = (input: unknown): OperationRightsRefusalDetails => operationRightsRefusalSchema.parse(input);
