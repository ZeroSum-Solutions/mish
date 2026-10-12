import { z } from 'zod';
import { resourceRefSchema } from './workbench-resource-ref.js';

/**
 * R15 Improve prompt: a natural-language description becomes a typed,
 * reviewable `DesignBrief`. The brief is user intent, never host authority:
 * the shared renderer (`prompts/design-brief.ts`) frames it as data under
 * the host's workspace, output, tool and security instructions.
 */
export const DESIGN_BRIEF_SCHEMA = 'design-brief/1';
export const DESIGN_BRIEF_RENDERER_VERSION = 'design-brief-renderer/1';
export const DESIGN_BRIEF_LIMITS = Object.freeze({
  originalText: 20_000, field: 2_000, listItems: 24, sections: 24, selectedReferences: 10,
  /** Proposed combined reviewed-excerpt budget across all selected references (≈4 chars per token). */
  referenceExcerptTokens: 8_000,
});

const text = (max: number) => z.string().trim().min(1).max(max);
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

/** Where a value came from. `assumed` is an inference to confirm, never a business fact. */
export const DESIGN_BRIEF_FIELD_BASES = ['stated', 'context', 'assumed', 'user', 'reference', 'unverified'] as const;
/** User edits, accepted references and verification labels belong to the host, never the transformer. */
export const DESIGN_BRIEF_MODEL_FIELD_BASES = ['stated', 'context', 'assumed'] as const;
export type DesignBriefFieldBasis = (typeof DESIGN_BRIEF_FIELD_BASES)[number];
const basisSchema = z.enum(DESIGN_BRIEF_FIELD_BASES);

const groundingReason = text(DESIGN_BRIEF_LIMITS.field).optional();
const fieldSchema = z.object({ value: z.string().trim().max(DESIGN_BRIEF_LIMITS.field).nullable(), basis: basisSchema, groundingReason }).strict()
  .superRefine((value, ctx) => {
    if (value.value === null || value.value === '') {
      if (value.basis !== 'assumed') ctx.addIssue({ code: 'custom', path: ['basis'], message: 'A missing value is an open assumption, never a stated fact' });
    }
  });
export type DesignBriefField = z.infer<typeof fieldSchema>;

const sectionSchema = z.object({ name: text(200), purpose: z.string().trim().max(DESIGN_BRIEF_LIMITS.field).nullable(), basis: basisSchema, groundingReason }).strict();
const designSchema = z.object({ typography: fieldSchema, color: fieldSchema, spacing: fieldSchema, layout: fieldSchema, motion: fieldSchema }).strict();
const listSchema = z.array(text(DESIGN_BRIEF_LIMITS.field)).max(DESIGN_BRIEF_LIMITS.listItems);
const intentSchema = z.object({
  /** Explicit style directions from the user's words (e.g. Windows 95). The transformer never drops or modernizes them. */
  styleDirections: z.array(text(120)).max(12),
  targetRuntime: text(120).nullable(),
}).strict();

/** Single-value text fields a user or an accepted reference change may set. */
export const DESIGN_BRIEF_TEXT_PATHS = [
  'audience', 'purpose', 'conversion', 'design.typography', 'design.color', 'design.spacing', 'design.layout', 'design.motion',
  'responsive', 'accessibility',
] as const;
/** Every path a user may edit through PATCH. List paths take string arrays. */
export const DESIGN_BRIEF_EDITABLE_PATHS = [...DESIGN_BRIEF_TEXT_PATHS, 'sections', 'implementationConstraints', 'assumptions', 'questions'] as const;
export type DesignBriefTextPath = (typeof DESIGN_BRIEF_TEXT_PATHS)[number];
export type DesignBriefEditablePath = (typeof DESIGN_BRIEF_EDITABLE_PATHS)[number];

const contrastPairSchema = z.object({ foreground: text(64), background: text(64), ratio: z.number().min(1).max(21), passesAA: z.boolean() }).strict();
const fontResolutionSchema = z.object({ family: text(200), resolvedRef: resourceRefSchema.nullable(), gap: z.boolean() }).strict()
  .refine(value => value.gap === (value.resolvedRef === null), 'A font is a gap exactly when it resolves to no admitted font');
const referenceChangeSchema = z.object({
  id: identifier,
  path: z.enum(DESIGN_BRIEF_TEXT_PATHS),
  oldValue: z.string().max(DESIGN_BRIEF_LIMITS.field).nullable(),
  proposedValue: text(DESIGN_BRIEF_LIMITS.field),
  rationale: text(DESIGN_BRIEF_LIMITS.field),
  refs: z.array(resourceRefSchema).min(1).max(DESIGN_BRIEF_LIMITS.selectedReferences),
  /** The current value came from the user, the description or the project; it wins unless the user accepts this change. */
  conflict: z.boolean(),
  status: z.enum(['proposed', 'accepted', 'rejected']),
  /** Contrast evidence for proposed palette pairs; a failing pair stays flagged, never asserted accessible. */
  contrast: z.array(contrastPairSchema).max(24).optional(),
  /** Unresolved or invalid reference tokens, kept visible as gaps. */
  tokenGaps: z.array(text(300)).max(24).optional(),
  fonts: z.array(fontResolutionSchema).max(12).optional(),
}).strict();
export type DesignBriefReferenceChange = z.infer<typeof referenceChangeSchema>;

const referenceRecordSchema = z.object({
  ref: resourceRefSchema, title: text(200), attribution: text(500),
  /** True when the reviewed excerpt did not fit the shared input budget and was left out of the model input. */
  excerptOmitted: z.boolean(),
}).strict();
export type DesignBriefReference = z.infer<typeof referenceRecordSchema>;

const briefCore = {
  audience: fieldSchema, purpose: fieldSchema, conversion: fieldSchema,
  sections: z.array(sectionSchema).max(DESIGN_BRIEF_LIMITS.sections),
  design: designSchema, responsive: fieldSchema, accessibility: fieldSchema,
  implementationConstraints: listSchema,
  intent: intentSchema,
  assumptions: listSchema, questions: listSchema,
};

export const designBriefSchema = z.object({
  schema: z.literal(DESIGN_BRIEF_SCHEMA), id: identifier, revision, projectId: identifier,
  state: z.enum(['draft', 'accepted']),
  originalText: text(DESIGN_BRIEF_LIMITS.originalText),
  contextRevision: z.number().int().min(1).nullable(), rubricRevision: z.number().int().min(1).nullable(),
  ...briefCore,
  /** Admitted inventory entries only; the model cannot add refs. */
  resourceRefs: z.array(resourceRefSchema).max(DESIGN_BRIEF_LIMITS.listItems),
  references: z.array(referenceRecordSchema).max(DESIGN_BRIEF_LIMITS.selectedReferences),
  referenceChanges: z.array(referenceChangeSchema).max(40),
  userEditedPaths: z.array(z.enum(DESIGN_BRIEF_EDITABLE_PATHS)).max(DESIGN_BRIEF_EDITABLE_PATHS.length),
  renderedPrompt: z.string().min(1).max(200_000), rendererVersion: z.literal(DESIGN_BRIEF_RENDERER_VERSION),
  hash: sha256, createdAt: z.string().datetime(),
}).strict();
export type DesignBrief = z.infer<typeof designBriefSchema>;

const overridesSchema = z.object(Object.fromEntries(DESIGN_BRIEF_TEXT_PATHS.map(path => [path, text(DESIGN_BRIEF_LIMITS.field).optional()])) as Record<DesignBriefTextPath, z.ZodOptional<ReturnType<typeof text>>>).strict();

/** Home previews are portable intent, held only by the caller until an accepted Run. */
export const designBriefPreviewSchema = designBriefSchema.omit({
  id: true, revision: true, projectId: true, state: true, contextRevision: true, rubricRevision: true,
  renderedPrompt: true, hash: true, createdAt: true,
}).extend({
  // Project-less previews cannot claim admitted resources or reviewed references.
  resourceRefs: z.array(resourceRefSchema).max(0), references: z.array(referenceRecordSchema).max(0),
  referenceChanges: z.array(referenceChangeSchema).max(0),
}).strict();
export type DesignBriefPreview = z.infer<typeof designBriefPreviewSchema>;
export const previewDesignBriefRequestSchema = z.object({ originalText: text(DESIGN_BRIEF_LIMITS.originalText), overrides: overridesSchema.optional() }).strict();
export type PreviewDesignBriefRequest = z.infer<typeof previewDesignBriefRequestSchema>;
export const attachDesignBriefRequestSchema = z.object({ projectId: identifier, preview: designBriefPreviewSchema }).strict();
export type AttachDesignBriefRequest = z.infer<typeof attachDesignBriefRequestSchema>;
export function parseDesignBriefPreview(input: unknown): DesignBriefPreview { return designBriefPreviewSchema.parse(input); }
export function parsePreviewDesignBriefRequest(input: unknown): PreviewDesignBriefRequest { return previewDesignBriefRequestSchema.parse(input); }
export function parseAttachDesignBriefRequest(input: unknown): AttachDesignBriefRequest { return attachDesignBriefRequestSchema.parse(input); }

/** What the model may return. It proposes text; refs, ids, hashes and attribution stay daemon-owned. */
export const designBriefModelOutputSchema = z.object({
  ...briefCore,
  referenceChanges: z.array(z.object({
    path: z.enum(DESIGN_BRIEF_TEXT_PATHS), proposedValue: text(DESIGN_BRIEF_LIMITS.field), rationale: text(DESIGN_BRIEF_LIMITS.field),
    /** Indexes into the selected references, as numbered in the request. */
    referenceIndexes: z.array(z.number().int().min(0).max(DESIGN_BRIEF_LIMITS.selectedReferences - 1)).min(1).max(DESIGN_BRIEF_LIMITS.selectedReferences),
  }).strict()).max(40),
}).strict().superRefine((output, ctx) => {
  const fields = [
    ...DESIGN_BRIEF_TEXT_PATHS.map(path => ({ path: path.split('.'), field: path.startsWith('design.') ? output.design[path.slice(7) as keyof typeof output.design] : output[path as 'audience'] })),
    ...output.sections.map((field, index) => ({ path: ['sections', index], field })),
  ];
  for (const { path, field } of fields) {
    if (!(DESIGN_BRIEF_MODEL_FIELD_BASES as readonly string[]).includes(field.basis)) ctx.addIssue({ code: 'custom', path: [...path, 'basis'], message: 'This basis is assigned only by the host after a check or user decision' });
    if (field.groundingReason !== undefined) ctx.addIssue({ code: 'custom', path: [...path, 'groundingReason'], message: 'Grounding reasons are assigned only by the host checker' });
  }
});
export type DesignBriefModelOutput = z.infer<typeof designBriefModelOutputSchema>;



export const createDesignBriefRequestSchema = z.object({
  projectId: identifier,
  originalText: text(DESIGN_BRIEF_LIMITS.originalText),
  contextRevision: z.number().int().min(0).optional(),
  /** User-supplied values; they take precedence over inferred context. */
  overrides: overridesSchema.optional(),
  selectedReferenceRefs: z.array(resourceRefSchema).max(DESIGN_BRIEF_LIMITS.selectedReferences).optional(),
}).strict();
export type CreateDesignBriefRequest = z.infer<typeof createDesignBriefRequestSchema>;

const editValue = z.union([text(DESIGN_BRIEF_LIMITS.field), z.array(text(DESIGN_BRIEF_LIMITS.field)).max(DESIGN_BRIEF_LIMITS.listItems)]);
export const patchDesignBriefRequestSchema = z.object({
  expectedRevision: revision,
  edits: z.record(z.enum(DESIGN_BRIEF_EDITABLE_PATHS), editValue).optional(),
  referenceDecisions: z.array(z.object({ id: identifier, status: z.enum(['accepted', 'rejected']) }).strict()).max(40).optional(),
  /** Use prompt: freeze this revision as the accepted brief that generation binds to. */
  accept: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  for (const [path, edit] of Object.entries(value.edits ?? {})) {
    const isList = !(DESIGN_BRIEF_TEXT_PATHS as readonly string[]).includes(path);
    if (isList !== Array.isArray(edit)) ctx.addIssue({ code: 'custom', path: ['edits', path], message: isList ? 'This field takes a list of strings' : 'This field takes one string' });
  }
  if (!value.edits && !value.referenceDecisions && !value.accept) ctx.addIssue({ code: 'custom', message: 'Pass edits, reference decisions or accept' });
});
export type PatchDesignBriefRequest = z.infer<typeof patchDesignBriefRequestSchema>;

export const designBriefFailureSchema = z.object({ code: text(80), message: text(500), recovery: text(500) }).strict();
/**
 * The transformer turn's model: what the daemon requested and what the lane
 * itself reported (for the Claude CLI, its stream-json init frame). A lane that
 * reports nothing records null rather than echoing the requested id.
 */
export const designBriefTransformerSchema = z.object({ requestedModel: text(120), reportedModel: text(120).nullable() }).strict();
export type DesignBriefTransformer = z.infer<typeof designBriefTransformerSchema>;
export const designBriefRecordViewSchema = z.object({
  id: identifier, projectId: identifier,
  /** `failed` and `cancelled` keep `originalText`: the composer falls back to it unchanged. */
  status: z.enum(['pending', 'ready', 'failed', 'cancelled']),
  originalText: text(DESIGN_BRIEF_LIMITS.originalText),
  brief: designBriefSchema.nullable(),
  failure: designBriefFailureSchema.nullable(),
  revisions: z.array(revision),
  /** Null until a model answered; absent on records written before it was recorded. */
  transformer: designBriefTransformerSchema.nullable().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'ready') !== (value.brief !== null)) ctx.addIssue({ code: 'custom', path: ['brief'], message: 'Only a ready record carries a brief' });
  if ((value.status === 'failed') !== (value.failure !== null)) ctx.addIssue({ code: 'custom', path: ['failure'], message: 'Only a failed record carries a failure' });
  if (value.brief && (value.brief.id !== value.id || value.brief.projectId !== value.projectId)) ctx.addIssue({ code: 'custom', path: ['brief'], message: 'Brief identity must match its record' });
});
export type DesignBriefRecordView = z.infer<typeof designBriefRecordViewSchema>;

/** Optional `brief` on `POST /api/runs`: the exact accepted revision generation consumes. */
export const runDesignBriefBindingSchema = z.object({ id: identifier, revision, hash: sha256 }).strict();
export type RunDesignBriefBinding = z.infer<typeof runDesignBriefBindingSchema>;

export function parseDesignBrief(input: unknown): DesignBrief { return designBriefSchema.parse(input); }
export function parseDesignBriefModelOutput(input: unknown): DesignBriefModelOutput { return designBriefModelOutputSchema.parse(input); }
export function parseCreateDesignBriefRequest(input: unknown): CreateDesignBriefRequest { return createDesignBriefRequestSchema.parse(input); }
export function parsePatchDesignBriefRequest(input: unknown): PatchDesignBriefRequest { return patchDesignBriefRequestSchema.parse(input); }
export function parseDesignBriefRecordView(input: unknown): DesignBriefRecordView { return designBriefRecordViewSchema.parse(input); }
export function parseRunDesignBriefBinding(input: unknown): RunDesignBriefBinding { return runDesignBriefBindingSchema.parse(input); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical bytes a brief's sha256 is computed over (everything except `hash`). Hashing itself is host-side. */
export function canonicalDesignBriefJson(brief: DesignBrief | Omit<DesignBrief, 'hash'>): string {
  const { hash: _hash, ...rest } = brief as DesignBrief;
  return canonical(rest);
}

/**
 * Which model writes Improve prompt briefs. `terra`, GPT Terra through OpenRouter,
 * is the default (D28.4) and falls back to `claude` (the Max-subscription turn) on
 * any failure; Settings → Labs can pick `claude` alone.
 */
export const BRIEF_TRANSFORMER_LANES = ['claude', 'terra'] as const;
export type BriefTransformerLane = (typeof BRIEF_TRANSFORMER_LANES)[number];
export function isBriefTransformerLane(value: unknown): value is BriefTransformerLane {
  return typeof value === 'string' && (BRIEF_TRANSFORMER_LANES as readonly string[]).includes(value);
}
export interface BriefTransformerStatus {
  /** The saved choice. */
  lane: BriefTransformerLane;
  /** The OpenRouter model the `terra` lane requests. */
  terraModel: string;
  /** Whether an OpenRouter key resolves; without one the `terra` lane runs `claude`. */
  terraKeyAvailable: boolean;
  /** The model every failure falls back to. */
  fallbackModel: string;
}
export interface BriefTransformerStatusResponse { status: BriefTransformerStatus }
