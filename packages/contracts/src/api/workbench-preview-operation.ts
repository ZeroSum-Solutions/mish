import { z } from 'zod';
import { resourceRefSchema } from './workbench-resource-ref.js';
import { API_ERROR_CODES } from '../errors.js';

/**
 * Q3 preview/operation transport proposal (F5/G21). Draft contract for
 * root review; not yet wired to any daemon route, web consumer or `od`
 * command. Parsing checks lexical shape and internal consistency only -
 * never filesystem bytes, credentials, principal/authority, host-preview
 * rights, lease renewal/revocation mechanics or session/transport wiring.
 * A lease or receipt here identifies state; it never carries or proves
 * authority, and no audience-bound credential is modeled as a public DTO
 * because the accepted v8 transport candidate keeps credentials
 * daemon-internal, delivered out-of-band of these shapes. Every public
 * projection below intentionally omits the server-only principal/authority
 * fields the accepted candidate binds server-side (see the F5 preview
 * transport candidate v8 document, lines 27-30); `.strict()` rejects any
 * attempt to smuggle them back in through client input.
 */

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
// Operation revisions are nonnegative and start at zero at the daemon's
// placement journal (apps/daemon/src/workbench/placement/journal.ts); they
// are a distinct counter from the one-based draft/plan/receipt revisions above.
const operationRevision = integer;
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const opaqueRefKey = z.string().min(1).max(20000).regex(/^[A-Za-z0-9_-]+$/u);
const timestamp = z.string().datetime({ precision: 3 });
const COLON_CODE_POINT = 58;
// A non-regex check on purpose: segment zero starting with one letter then
// a colon is an absolute foreign-root prefix, not a normalized relative path.
const startsWithLetterColon = (value: string) => {
  const code = value.codePointAt(0) ?? 0;
  const isAsciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return isAsciiLetter && value.codePointAt(1) === COLON_CODE_POINT;
};
const path = z.string().min(1).max(1000).refine(v => !/[\p{Cc}\p{Cf}\\]/u.test(v) && !v.startsWith('/') && !startsWithLetterColon(v)
  && v.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Expected normalized project-relative path');
const mime = z.string().max(100).regex(/^[a-z0-9]+\/[a-z0-9.+-]+$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
// Mirrors workbench-adoption-plan.ts's file-prefix check: the slash suffix keeps
// each path adjacent to its own descendants, including when a dotted sibling
// (e.g. 'App.tsx.bak') would otherwise sort before the directory separator.
const hasFilePrefixCollision = (paths: readonly string[]): boolean => {
  const withSlash = paths.map(p => `${p}/`).sort();
  for (let i = 1; i < withSlash.length; i++) if (withSlash[i]!.startsWith(withSlash[i - 1]!)) return true;
  return false;
};
// Pure JS UTF-8 byte-length estimate; no Buffer/TextEncoder/browser/Node API.
// A lone surrogate is counted as the 3-byte U+FFFD replacement would be, since
// `for...of` yields its raw code-unit value (0xd800-0xdfff), already <= 0xffff.
const exceedsUtf8ByteBudget = (parts: readonly string[], limitBytes: number): boolean => {
  let total = 0;
  for (const part of parts) {
    for (const scalar of part) {
      const cp = scalar.codePointAt(0) ?? 0xfffd;
      total += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (total > limitBytes) return true;
    }
  }
  return false;
};
const evidenceRefs = z.array(id).min(1).max(100).refine(unique, 'Duplicate evidence reference');
// Mirrors workbench-adoption-plan.ts's local sourceRef bound: resourceRefSchema
// itself leaves itemId/revisionOrDigest unbounded, which this public projection
// must not reintroduce.
const boundedResourceRef = resourceRefSchema.superRefine((v, ctx) => {
  for (const key of ['itemId', 'revisionOrDigest'] as const) {
    if (v[key].length > 1000 || /[\p{Cc}\p{Cf}]/u.test(v[key])) ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid bounded resource identity' });
  }
});

export const previewOperationStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'interrupted']);
export const previewOperationRecoverySchema = z.enum(['clear', 'blocked', 'conflict', 'unavailable']);
export const previewOperationInterruptReasonSchema = z.enum(['user-cancelled', 'daemon-restart', 'worker-lost', 'timeout', 'superseded']);
export const previewOperationKindSchema = z.enum(['prepare-preview', 'adoption-prepare', 'adoption-apply', 'adoption-undo']);
export const adoptionDraftStateSchema = z.enum(['selected', 'preparing', 'prepared', 'failed', 'interrupted', 'needs-preparation']);
export const previewLeaseStateSchema = z.enum(['active', 'expired', 'revoked']);

/** POST /api/workbench/resources/prepare-preview. `instruction` is bounded
 * untrusted text handed to the preparer; it is never executable policy. */
const preparePreviewRequestSchema = z.object({
  projectId: id, refKey: opaqueRefKey, targetProfileId: id, entryPath: path,
  instruction: boundedText(4000).optional(),
}).strict();

const adoptionDraftFileSchema = z.object({ path, sha256: hash, bytes: integer, editable: z.boolean() }).strict();
const adoptionDraftCapabilitySchema = z.object({ id, available: z.boolean(), reason: boundedText(500).nullable() }).strict();

/** Public AdoptionDraft projection. No absolute staging/native path,
 * principal, authority epoch or secret reaches this shape: the server
 * binds those separately and rechecks them on every read, including this
 * one (see v8 lines 27-29). `preview`/`plan` name the current lease/plan by
 * opaque id only. */
const adoptionDraftSchema = z.object({
  id, revision, parentRevision: revision.optional(), projectId: id, resourceRef: boundedResourceRef,
  sourceBindingDigest: hash, targetBindingDigest: hash,
  files: z.array(adoptionDraftFileSchema).max(2048),
  state: adoptionDraftStateSchema, capabilities: z.array(adoptionDraftCapabilitySchema).max(100),
  operationId: id.optional(),
  plan: z.object({ id, digest: hash, expiresAt: timestamp }).strict().optional(),
  preview: z.object({ leaseId: id, state: previewLeaseStateSchema }).strict().optional(),
  evidenceRefs,
}).strict().superRefine((v, ctx) => {
  if (!unique(v.files.map(f => f.path))) ctx.addIssue({ code: 'custom', path: ['files'], message: 'Duplicate draft file path' });
  if (!unique(v.capabilities.map(c => c.id))) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Duplicate capability id' });
  // A plan is only ever minted after measured preparation/incorporation gates
  // (v8 lines 27-34); neither the pre-preparation 'selected' state nor an edited-
  // back 'needs-preparation' state may carry one or an active preview. An
  // expired/revoked preview may remain as a historical pointer in either state.
  // 'preparing'/'prepared'/'failed'/'interrupted' are intentionally untouched: no
  // accepted evidence restricts them, and a historical plan on a failed draft is
  // an explicit non-finding, not an oversight.
  if (v.state === 'needs-preparation' || v.state === 'selected') {
    if (v.plan) ctx.addIssue({ code: 'custom', path: ['plan'], message: `${v.state} must not retain an Apply plan` });
    if (v.preview?.state === 'active') ctx.addIssue({ code: 'custom', path: ['preview'], message: `${v.state} must not retain an active preview lease` });
  }
  if (v.parentRevision !== undefined && v.parentRevision >= v.revision) ctx.addIssue({ code: 'custom', path: ['parentRevision'], message: 'parentRevision must be strictly older than the immutable draft revision' });
  if (hasFilePrefixCollision(v.files.map(f => f.path))) ctx.addIssue({ code: 'custom', path: ['files'], message: 'Declared files structurally cannot coexist' });
});

/** POST /adoptions/:id/edits. Bounded UTF-8 text edits only, to declared
 * editable paths; path/hash mismatch is the caller's 409, not this parser's
 * job. New file/dependency/delete edits are out of scope for this editor. */
// Per-edit ceiling is a generous sanity bound, not the authoritative cap: the
// aggregate UTF-8 byte check below (P3 freeze v3:23) is what actually enforces
// the accepted 32 MiB preflight limit, and a single large file edit must not be
// blocked below that by an arbitrary tighter per-item ceiling.
const editAdoptionDraftEntrySchema = z.object({ path, expectedSha256: hash, content: z.string().max(32 * 1024 * 1024) }).strict();
const editAdoptionDraftRequestSchema = z.object({
  expectedRevision: revision, edits: z.array(editAdoptionDraftEntrySchema).min(1).max(256),
}).strict().superRefine((v, ctx) => {
  if (!unique(v.edits.map(e => e.path))) ctx.addIssue({ code: 'custom', path: ['edits'], message: 'Duplicate edit path' });
  if (hasFilePrefixCollision(v.edits.map(e => e.path))) ctx.addIssue({ code: 'custom', path: ['edits'], message: 'Declared edits structurally cannot coexist' });
  if (exceedsUtf8ByteBudget(v.edits.map(e => e.content), 32 * 1024 * 1024)) ctx.addIssue({ code: 'custom', path: ['edits'], message: 'Aggregate edited content exceeds the 32 MiB UTF-8 preflight bound' });
});

/** Immutable preparation attestation. The server-only record additionally
 * binds principalId, authorityEpoch and source-snapshot generation; this
 * public projection omits all three on purpose (v8 line 29) and `.strict()`
 * refuses any client attempt to assert them back in. */
const preparationReceiptSchema = z.object({
  id, draftId: id, revision, digest: hash, projectId: id,
  targetBindingDigest: hash, sourceBindingDigest: hash, outputDigest: hash,
  evidenceRefs, preparedAt: timestamp, expiresAt: timestamp,
}).strict().superRefine((v, ctx) => {
  const spanMs = Date.parse(v.expiresAt) - Date.parse(v.preparedAt);
  if (spanMs <= 0) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Receipt must expire strictly after preparation' });
  if (spanMs > 15 * 60 * 1000) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Receipt must expire at most fifteen minutes after preparation' });
});

const previewLeaseAssetSchema = z.object({ id, sha256: hash, bytes: integer, mime }).strict();

/** Public PreviewLease projection. An identifier, never a bearer credential
 * (v8 line 30): the server additionally binds authenticated principal,
 * project, authority epoch and actual root/source/dependency identity,
 * none of which appear here. */
const previewLeaseSchema = z.object({
  id, draftId: id, revision, preparationDigest: hash, outputDigest: hash, entryAssetId: id,
  assets: z.array(previewLeaseAssetSchema).min(1).max(512), expiresAt: timestamp, state: previewLeaseStateSchema,
}).strict().superRefine((v, ctx) => {
  if (!unique(v.assets.map(a => a.id))) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Duplicate asset id' });
  if (!v.assets.some(a => a.id === v.entryAssetId)) ctx.addIssue({ code: 'custom', path: ['entryAssetId'], message: 'Entry asset must be declared among lease assets' });
});

// Bounded and redacted on purpose: this never carries a credential, raw byte
// content, or a private root/path. Three variants cover the actual producers
// inspected for this freeze: the placement mapper's {kind:'placement',reason}
// (apps/daemon/src/workbench/placement/runtime-status.ts), the shared
// ApiValidationErrorDetails {kind:'validation',issues} (errors.ts), and an
// untagged action/refusal shape for callers with no kind at all. A generic
// gate/blockedGates field is deliberately absent: the recovery-gate producer
// contract remains unsealed until it is frozen and proven separately.
const detailsLinkage = { operationId: id.optional(), currentRevision: integer.optional(), nextSteps: z.array(boundedText(500)).max(10).optional() };
const placementDetailsSchema = z.object({
  kind: z.literal('placement'), reason: boundedText(500), capability: id.optional(), ...detailsLinkage,
}).strict();
// ApiValidationIssue permits the empty root path. Preserve field names and
// pointers verbatim; trimming changes the location reported by the producer.
const validationIssuePath = z.string().max(1000).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v), 'Invalid validation issue path');
const validationIssueSchema = z.object({ path: validationIssuePath, message: boundedText(2000), code: boundedText(200).optional() }).strict();
const validationDetailsSchema = z.object({
  kind: z.literal('validation'), issues: z.array(validationIssueSchema).min(1).max(50), ...detailsLinkage,
}).strict();
const actionDetailsSchema = z.object({
  reason: boundedText(500).optional(), capability: id.optional(), ...detailsLinkage,
}).strict().refine(v => v.reason !== undefined || v.capability !== undefined || v.operationId !== undefined
  || v.currentRevision !== undefined || (v.nextSteps !== undefined && v.nextSteps.length > 0), 'Action/refusal details require at least one meaningful field');
const workbenchOperationErrorDetailsSchema = z.union([placementDetailsSchema, validationDetailsSchema, actionDetailsSchema]);
const workbenchOperationErrorSchema = z.object({
  code: z.enum(API_ERROR_CODES), message: boundedText(2000), retryable: z.boolean().optional(),
  requestId: id.optional(), taskId: id.optional(), details: workbenchOperationErrorDetailsSchema.optional(),
}).strict();

/** GET /api/workbench/operations/:id projection. `id` is the public
 * operation id; it is distinct from the daemon's internal placement-journal
 * launch id, which this projection never exposes (next-batch Q3 note on
 * durable preparation linkage). */
const workbenchOperationSchema = z.object({
  id, kind: previewOperationKindSchema, projectId: id, draftId: id.optional(), draftRevision: revision.optional(),
  revision: operationRevision, inputDigest: hash, status: previewOperationStatusSchema, stage: boundedText(100),
  attempt: integer.min(1), parentOperationId: id.optional(), resultRefs: z.array(id).max(256),
  error: workbenchOperationErrorSchema.nullish(), interruptReason: previewOperationInterruptReasonSchema.nullish(),
  createdAt: timestamp, updatedAt: timestamp, cancellationRequested: z.boolean(), recovery: previewOperationRecoverySchema,
}).strict().superRefine((v, ctx) => {
  if (v.status === 'interrupted' && v.interruptReason == null) ctx.addIssue({ code: 'custom', path: ['interruptReason'], message: 'Interrupted operation requires a reason' });
  if (v.status !== 'interrupted' && v.interruptReason != null) ctx.addIssue({ code: 'custom', path: ['interruptReason'], message: 'Only an interrupted operation carries an interrupt reason' });
  if (v.status === 'failed' && v.error == null) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed operation requires an error' });
  if (v.status !== 'failed' && v.error != null) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Only a failed operation carries an error' });
  if (Date.parse(v.updatedAt) < Date.parse(v.createdAt)) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Operation cannot update before creation' });
});

/** POST /api/workbench/operations/:id/undo. Identifies the applied
 * operation/receipt only; the daemon derives the exact restore set from its
 * own retained preimages, never from a client-supplied path or byte. */
const undoAdoptionRequestSchema = z.object({
  appliedOperationId: id, expectedOperationRevision: operationRevision, expectedReceiptDigest: hash,
}).strict();

export type PreparePreviewRequest = z.infer<typeof preparePreviewRequestSchema>;
export type AdoptionDraft = z.infer<typeof adoptionDraftSchema>;
export type EditAdoptionDraftRequest = z.infer<typeof editAdoptionDraftRequestSchema>;
export type PreparationReceipt = z.infer<typeof preparationReceiptSchema>;
export type PreviewLease = z.infer<typeof previewLeaseSchema>;
export type WorkbenchPreviewOperation = z.infer<typeof workbenchOperationSchema>;
export type UndoAdoptionRequest = z.infer<typeof undoAdoptionRequestSchema>;

export const parsePreparePreviewRequest = (input: unknown): PreparePreviewRequest => preparePreviewRequestSchema.parse(input);
export const parseAdoptionDraft = (input: unknown): AdoptionDraft => adoptionDraftSchema.parse(input);
export const parseEditAdoptionDraftRequest = (input: unknown): EditAdoptionDraftRequest => editAdoptionDraftRequestSchema.parse(input);
export const parsePreparationReceipt = (input: unknown): PreparationReceipt => preparationReceiptSchema.parse(input);
export const parsePreviewLease = (input: unknown): PreviewLease => previewLeaseSchema.parse(input);
export const parseWorkbenchPreviewOperation = (input: unknown): WorkbenchPreviewOperation => workbenchOperationSchema.parse(input);
export const parseUndoAdoptionRequest = (input: unknown): UndoAdoptionRequest => undoAdoptionRequestSchema.parse(input);

/** Temporal check only; the caller must still verify current authority. */
export function isPreviewLeaseActive(lease: PreviewLease, now: number): boolean {
  return Number.isSafeInteger(now) && lease.state === 'active' && now < Date.parse(lease.expiresAt);
}
/** Pure binding check: a lease must name the exact receipt it was minted
 * from and must not outlive it (v8 line 115). This never substitutes for a
 * server-side authority recheck. */
export function isPreviewLeaseBoundToReceipt(lease: PreviewLease, receipt: PreparationReceipt): boolean {
  return lease.draftId === receipt.draftId && lease.preparationDigest === receipt.digest
    && lease.revision === receipt.revision && lease.outputDigest === receipt.outputDigest
    && Date.parse(lease.expiresAt) <= Date.parse(receipt.expiresAt);
}
