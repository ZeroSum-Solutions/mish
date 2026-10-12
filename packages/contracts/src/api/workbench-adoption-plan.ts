import { z } from 'zod';
import { resourceRefSchema } from './workbench-resource-ref.js';

/** Stored v1 plans for replacing one existing entry, with regular-file writes only.
 * Set/plan digests are declared here and must be recomputed by the trusted manager.
 * Parsing checks lexical paths and record consistency, never filesystem aliases,
 * source ownership, byte/evidence authenticity, current authority or a mutation permit.
 * The trusted preparer must qualify the whole read/write path set on the actual
 * supported filesystem, with existing parents and no-follow ancestry. It must
 * never create undeclared directories. Publication repeats those runtime guards.
 */
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
const text = z.string().min(1).max(200).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
const termsVersion = z.string().min(1).max(2000).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u).refine(v => BigInt(v) <= 18446744073709551615n);
const uuid = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).refine(v => v !== '00000000-0000-0000-0000-000000000000');
const path = z.string().min(1).max(1000).refine(v => !/[\p{Cc}\p{Cf}\\]/u.test(v) && !v.startsWith('/') && !/^[A-Za-z]:/u.test(v)
  && v.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Expected normalized project-relative path');
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const evidenceRefs = z.array(id).min(1).max(100).refine(unique, 'Duplicate evidence reference');
const fileIdentity = z.object({ device: decimal, inode: decimal, kind: z.literal('file') }).strict();
const expected = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('file'), sha256: hash, bytes: integer, identity: fileIdentity }).strict(),
]);
const read = z.object({ path, expected }).strict();
const write = z.object({ path, kind: z.enum(['create', 'replace']), after: z.object({
  sha256: hash, bytes: integer, blobId: id, role: z.enum(['source', 'entry', 'asset', 'style', 'notice', 'package', 'lock']),
}).strict() }).strict();
const sourceRef = resourceRefSchema.superRefine((v, ctx) => {
  for (const key of ['itemId', 'revisionOrDigest'] as const) if (v[key].length > 1000 || /[\p{Cc}\p{Cf}]/u.test(v[key])) ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid bounded resource identity' });
});
const assessedRevision = z.string().min(1).max(1000).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
/**
 * Where a catalogue plan's bytes came from. `source`: the catalogue item at the revision
 * its source assessed. `saved-unit`: a principal's saved unit, named by its record id and
 * whole-record digest (the store's id is that digest, so the two are equal), with the
 * original catalogue item and the revision assessed when it was applied. The apply-time
 * re-check reads this origin; a saved-unit origin with no matching record is refused.
 */
const planOrigin = z.union([
  z.object({ kind: z.literal('source'), resourceRef: sourceRef, assessedRevision }).strict(),
  z.object({ kind: z.literal('saved-unit'), savedUnitId: hash, recordDigest: hash, resourceRef: sourceRef, assessedRevision }).strict()
    .refine(v => v.recordDigest === v.savedUnitId, { message: 'A saved unit record id is its whole-record digest', path: ['recordDigest'] }),
]);
const byteLimit = 32 * 1024 * 1024;
const expiryMs = 15 * 60 * 1000;
const preparedPlanSchema = z.object({
  schema: z.literal('workbench-prepared-plan/1'), id, digest: hash, principalId: id, projectId: id,
  projectRoot: z.object({ device: decimal, inode: decimal, volumeUUID: uuid }).strict(),
  adapter: z.object({ id, version: text }).strict(),
  target: z.object({ profileId: id, entryPath: path, toolchainDigest: hash, dependencyDigest: hash, buildInputDigest: hash }).strict(),
  source: z.object({ resourceRef: sourceRef, implementationOrigin: z.enum(['official', 'owned', 'adapted', 'unknown']), admissionId: id, admissionRevision: revision,
    acquiredSha256: hash, closureDigest: hash, terms: z.object({ version: termsVersion, sha256: hash }).strict().nullable(),
    assessments: z.array(z.object({ id, revision }).strict()).min(1).max(100), rightsSnapshotDigest: hash,
    origin: planOrigin.optional(),
  }).strict(),
  projectState: z.object({ contextRevision: integer, rubricRevision: integer }).strict(),
  readSetDigest: hash, writeSetDigest: hash, reads: z.array(read).min(1).max(2048), writes: z.array(write).min(1).max(256),
  preparation: z.object({ preparedAt: z.string().datetime({ precision: 3 }), expiresAt: z.string().datetime({ precision: 3 }),
    outputDigest: hash, evidenceRefs, commandPolicyDigest: hash, relocationEvidenceRefs: evidenceRefs,
    pathQualification: z.object({ readSetDigest: hash, writeSetDigest: hash, evidenceRefs }).strict(),
  }).strict(), noticesDigest: hash,
}).strict().superRefine((v, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (!unique(v.reads.map(r => r.path))) issue(['reads'], 'Duplicate read path');
  if (!unique(v.writes.map(w => w.path))) issue(['writes'], 'Duplicate write path');
  if (!unique(v.source.assessments.map(a => a.id))) issue(['source', 'assessments'], 'Duplicate assessment identity');
  const paths = new Set(v.reads.map(r => r.path));
  // The slash suffix keeps each file adjacent to its descendants, including
  // when dotted siblings sort before the directory separator.
  const filePrefixes = [...paths].map(file => `${file}/`).sort();
  for (let i = 1; i < filePrefixes.length; i++) if (filePrefixes[i]!.startsWith(filePrefixes[i - 1]!)) issue(['reads'], 'File-prefix collision');
  const entries = v.writes.filter(w => w.after.role === 'entry');
  if (entries.length !== 1 || entries[0]?.kind !== 'replace' || entries[0]?.path !== v.target.entryPath) issue(['writes'], 'Plan requires one replacement of the actual existing entry');
  if (v.source.terms === null && v.source.implementationOrigin !== 'owned') issue(['source', 'terms'], 'Non-owned source requires exact terms');
  if (v.preparation.pathQualification.readSetDigest !== v.readSetDigest || v.preparation.pathQualification.writeSetDigest !== v.writeSetDigest) issue(['preparation', 'pathQualification'], 'Qualification must bind this exact read/write set');
  const blobs = new Map<string, { sha256: string; bytes: number }>();
  const reads = new Map(v.reads.map(r => [r.path, r.expected]));
  let output = 0, preimages = 0, priorOrder = -1;
  for (const [i, w] of v.writes.entries()) {
    if (w.path.split('/').some(segment => ['node_modules', '.git'].includes(segment.normalize('NFKC').toUpperCase().toLowerCase()))) issue(['writes', i, 'path'], 'Dependency and Git metadata writes require a separate capability');
    const blob = blobs.get(w.after.blobId);
    if (blob && (blob.sha256 !== w.after.sha256 || blob.bytes !== w.after.bytes)) issue(['writes', i, 'after'], 'Contradictory prepared blob descriptor');
    blobs.set(w.after.blobId, w.after);
    const before = reads.get(w.path);
    if (!before || (w.kind === 'create' ? before.kind !== 'absent' : before.kind !== 'file')) issue(['writes', i], 'Write requires matching declared absence or exact existing file');
    if (w.kind === 'replace' && before?.kind === 'file') preimages += before.bytes;
    output += w.after.bytes;
    const order = w.after.role === 'entry' ? 3 : ['package', 'lock'].includes(w.after.role) ? 2 : w.kind === 'create' ? 0 : 1;
    if (order < priorOrder) issue(['writes', i], 'Publish new closure, then source/style, package/lock, and entry last');
    priorOrder = order;
  }
  if (output > byteLimit) issue(['writes'], 'Planned output exceeds 32 MiB');
  if (preimages > byteLimit) issue(['reads'], 'Retained preimages exceed 32 MiB');
  if (Date.parse(v.preparation.expiresAt) - Date.parse(v.preparation.preparedAt) !== expiryMs) issue(['preparation', 'expiresAt'], 'Expiry must be fifteen minutes after preparation');
});
const applySchema = z.object({ planId: id, planDigest: hash }).strict();
export type PreparedAdoptionPlan = z.infer<typeof preparedPlanSchema>;
export type ApplyAdoptionRequest = z.infer<typeof applySchema>;
export const parsePreparedAdoptionPlan = (input: unknown): PreparedAdoptionPlan => preparedPlanSchema.parse(input);
export const parseApplyAdoptionRequest = (input: unknown): ApplyAdoptionRequest => applySchema.parse(input);
/** Temporal check only. The caller must also verify stored identity, bytes and current authority. */
export function isAdoptionPlanUnexpired(plan: PreparedAdoptionPlan, now: number): boolean {
  return Number.isSafeInteger(now) && now >= Date.parse(plan.preparation.preparedAt) && now < Date.parse(plan.preparation.expiresAt);
}

// DRAFT (F5/U5, additive; captain approval pending): the prepare/apply/undo wire.
// The daemon preparer turns a draft into the stored plan above. Clients never
// submit digests, identities, evidence or rights. Undo names a completed apply.
const base64 = z.string().max(Math.ceil(byteLimit / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'Expected base64 content');
const writeRole = z.enum(['source', 'entry', 'asset', 'style', 'notice', 'package', 'lock']);
/** Same segment rule the stored plan enforces; checked at the draft boundary so a preparer refuses before reading anything. */
export const isRestrictedAdoptionPath = (value: string): boolean =>
  value.split('/').some(segment => ['node_modules', '.git'].includes(segment.normalize('NFKC').toUpperCase().toLowerCase()));
const prepareSchema = z.object({
  projectId: id, entryPath: path,
  adapter: z.object({ id, version: text }).strict().optional(),
  source: z.object({ implementationOrigin: z.enum(['official', 'owned', 'adapted', 'unknown']), resourceRef: sourceRef.optional() }).strict(),
  writes: z.array(z.object({ path, role: writeRole, contentBase64: base64 }).strict()).min(1).max(256),
}).strict().superRefine((v, ctx) => {
  if (!unique(v.writes.map(w => w.path))) ctx.addIssue({ code: 'custom', path: ['writes'], message: 'Duplicate write path' });
  v.writes.forEach((w, i) => { if (isRestrictedAdoptionPath(w.path)) ctx.addIssue({ code: 'custom', path: ['writes', i, 'path'], message: 'Dependency and Git metadata writes require a separate capability' }); });
  const entries = v.writes.filter(w => w.role === 'entry');
  if (entries.length !== 1 || entries[0]!.path !== v.entryPath) ctx.addIssue({ code: 'custom', path: ['writes'], message: 'Draft requires exactly one entry write at entryPath' });
});
const operationSchema = z.object({
  operationId: id, kind: z.enum(['apply', 'undo']), planId: id, projectId: id,
  state: z.enum(['queued', 'running', 'done', 'failed', 'interrupted']),
  stage: z.enum(['queued', 'running', 'movement-intent', 'movement-verified', 'complete', 'failed', 'recovery-required']),
  undoOf: id.nullable(), undoneBy: id.nullable(), reason: id.nullable(),
  writes: z.array(z.object({ path, kind: z.enum(['create', 'replace']), sha256: hash, bytes: integer }).strict()).min(1).max(256),
}).strict();
export type PrepareAdoptionRequest = z.infer<typeof prepareSchema>;
export type AdoptionOperationView = z.infer<typeof operationSchema>;
export interface PrepareAdoptionResponse { plan: PreparedAdoptionPlan }
export interface AdoptionOperationResponse { operation: AdoptionOperationView }
export const parsePrepareAdoptionRequest = (input: unknown): PrepareAdoptionRequest => prepareSchema.parse(input);
export const parseAdoptionOperationView = (input: unknown): AdoptionOperationView => operationSchema.parse(input);
export const parsePrepareAdoptionResponse = (input: unknown): PrepareAdoptionResponse => z.object({ plan: preparedPlanSchema }).strict().parse(input);
export const parseAdoptionOperationResponse = (input: unknown): AdoptionOperationResponse => z.object({ operation: operationSchema }).strict().parse(input);
