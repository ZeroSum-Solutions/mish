import { z } from 'zod';
import { RESOURCE_SOURCE_IDS } from './workbench-resource-ref.js';

const text = z.string().trim().min(1).max(1000);
export const COMPONENT_TOKEN_AXES = ['color', 'radius', 'type'] as const;
const adaptation = z.enum(['adaptable', 'fixed', 'unknown']);
/** Source-owned, revision-bound observations. A listing or model guess is not evidence. */
export const componentTokenEvidenceSchema = z.object({
  sourceRevisionOrDigest: text, evidenceRef: text,
  color: adaptation, radius: adaptation, type: adaptation,
  bindings: z.object({ color: z.array(text).max(256), radius: z.array(text).max(256), type: z.array(text).max(256) }).strict().optional(),
}).strict();
export const COMPONENT_APPLY_BLOCKERS = [
  'target-unverified', 'target-incompatible', 'adapter-unverified', 'admission-unverified',
  'rights-unverified', 'rubric-unverified', 'dependencies-unverified', 'motion-constraint', 'motion-unverified', 'constraint-unverified', 'kit-unapproved',
] as const;
export const COMPONENT_FIT_REASONS = [
  'primary-conversion', 'secondary-conversion', 'spine', 'token-adaptable', 'token-fixed',
  'token-unknown', 'kit-unknown', 'apply-blocked', 'constraint-met',
] as const;
/** A trusted adapter's named, passed admission profile at the actual project revisions. */
export const componentAdmissionEvidenceSchema = z.object({
  profileId: text, projectId: text, sourceRevisionOrDigest: text,
  contextRevision: z.number().int().nonnegative(), rubricRevision: z.number().int().nonnegative(),
}).strict();
export const componentFitSchema = z.object({
  version: z.literal('kit-components/1'), kitId: text.nullable(), kitSourceId: z.enum(RESOURCE_SOURCE_IDS).nullable().default(null), kitRevisionOrDigest: text.nullable(),
  acceptance: z.enum(['passed', 'failed', 'pending', 'stale']).default('pending'),
  status: z.enum(['fits', 'mismatch', 'unknown']), score: z.number().int().nonnegative(),
  reasons: z.array(z.object({ code: z.enum(COMPONENT_FIT_REASONS), fact: text }).strict()),
  apply: z.object({ allowed: z.boolean(), blockers: z.array(z.enum(COMPONENT_APPLY_BLOCKERS)) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.apply.allowed !== (value.apply.blockers.length === 0)) ctx.addIssue({ code: 'custom', path: ['apply'], message: 'Apply must agree with every gate' });
  if (value.status === 'fits' && (!value.kitId || !value.kitSourceId || !value.kitRevisionOrDigest || value.apply.blockers.some(blocker => blocker !== 'kit-unapproved'))) ctx.addIssue({ code: 'custom', message: 'Fits requires an observed source+ID kit and passing compatibility/admission gates' });
});
export const componentPickerSchema = z.object({ kitId: text.optional(), kitSourceId: z.enum(RESOURCE_SOURCE_IDS).optional(), showAll: z.boolean().default(false), mode: z.enum(['rank', 'list']).default('rank') }).strict().refine(value => !value.kitSourceId || !!value.kitId, 'Kit source requires a kit ID');
export const componentRankingSchema = z.object({
  version: z.literal('kit-components/1'), kitId: text.nullable(), kitSourceId: z.enum(RESOURCE_SOURCE_IDS).nullable().default(null), kitRevisionOrDigest: text.nullable(),
  showAll: z.boolean(), hidden: z.number().int().nonnegative(),
  reason: z.enum(['kit-absent', 'kit-unavailable', 'target-unverified', 'no-kit-fits']).nullable(),
}).strict();
export type ComponentFit = z.infer<typeof componentFitSchema>;
export type ComponentTokenEvidence = z.infer<typeof componentTokenEvidenceSchema>;
export type ComponentPicker = z.infer<typeof componentPickerSchema>;
export type ComponentApplyBlocker = typeof COMPONENT_APPLY_BLOCKERS[number];
export type ComponentRanking = z.infer<typeof componentRankingSchema>;
export const parseComponentPicker = (input: unknown): ComponentPicker => componentPickerSchema.parse(input);
