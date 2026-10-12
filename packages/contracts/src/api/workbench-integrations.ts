import { z } from 'zod';
import { RESOURCE_SOURCE_IDS } from './workbench-resource-ref.js';
import { SOURCE_OPERATIONS } from './workbench-source-admission.js';

/**
 * AC-R08.1 integration roster, AC-R12.1 named-website register and the R16
 * held-licence record. Pure shapes and pure derivations only: parsing proves a
 * record is well formed, never that a receipt exists or a grant applies.
 */
// Preserve local runtime identities, including uppercase letters and underscores.
const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const text = z.string().min(1).max(2000).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
const shortText = z.string().min(1).max(200).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
/** A repository-relative evidence path or receipt ID. A citation, never proof by itself. */
const evidenceRef = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._/#:-]*$/u)
  .refine(value => !value.split('/').some(part => part === '..' || part === '.'), 'Evidence references are normalized repository paths');
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const evidenceRefs = z.array(evidenceRef).max(50).refine(unique, 'Duplicate evidence references');
/** HTTPS citation locator without credentials, query or fragment. */
const httpsUrl = z.string().max(500).regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s?#\\@]*)?$/u, 'Expected an HTTPS URL without credentials or query');
const requirementId = z.string().regex(/^R(0[1-9]|1[0-8])$/u);
const gateId = z.string().regex(/^G[0-9]{2}$/u);
const timestamp = z.string().datetime();

export const INTEGRATION_READINESS = ['usable', 'unverified', 'reference-only', 'needs-repair', 'unavailable'] as const;
export const INTEGRATION_SITE_DECISIONS = ['use-existing', 'build-small-adapter', 'reference-only', 'unsupported'] as const;
export const INTEGRATION_KINDS = ['design-integration', 'website-connector', 'component-registry', 'font-source', 'reference-source', 'design-skill'] as const;

const operationSchema = z.object({
  operation: shortText,
  status: z.enum(['verified', 'unverified', 'blocked', 'deferred', 'not-offered']),
  evidenceRefs, reason: text.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'verified' && value.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'A verified operation cites its receipt' });
  if (value.status !== 'verified' && value.reason === null) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'An unverified operation states why' });
});

const lastVerifiedUseSchema = z.object({
  at: timestamp, operation: text,
  surfaces: z.array(z.enum(['canvas', 'od', 'agent-run', 'fixture'])).min(1).max(4).refine(unique),
  evidenceRef,
}).strict();

const siteEvaluationBase = z.object({
  /** Where the owner named this site: the accepted answer or gate record. */
  namedIn: text,
  existingMcp: z.object({
    result: z.enum(['official-mcp', 'generic-registry-mcp', 'no-mcp']),
    endpoint: httpsUrl.nullable(), summary: text, evidenceRefs,
  }).strict(),
  toolSchema: z.object({
    state: z.enum(['frozen', 'documented-unexecuted', 'not-frozen', 'not-applicable']),
    summary: text, evidenceRefs,
  }).strict(),
  terms: z.object({ summary: text, evidenceRefs }).strict(),
  auth: z.object({ kind: z.enum(['none', 'account', 'oauth-account', 'held-licence', 'api-key']), summary: text }).strict(),
  cost: z.object({ kind: z.enum(['free', 'included-in-held-licence', 'paid-plan', 'unknown']), summary: text }).strict(),
  decision: z.enum(INTEGRATION_SITE_DECISIONS),
  decisionReason: text,
  /** R12.2: a custom adapter is justified only by a concrete missing capability. */
  missingCapability: text.nullable(),
  lastProof: z.object({ at: timestamp, summary: text, evidenceRef }).strict().nullable(),
}).strict();
function refineSite(value: z.infer<typeof siteEvaluationBase>, ctx: z.RefinementCtx): void {
  if ((value.decision === 'build-small-adapter') !== (value.missingCapability !== null)) ctx.addIssue({ code: 'custom', path: ['missingCapability'], message: 'Only a small adapter decision names the concrete missing capability it fills' });
  if (value.existingMcp.result !== 'no-mcp' && value.existingMcp.endpoint === null && value.existingMcp.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['existingMcp'], message: 'A found MCP cites its endpoint or evidence' });
  if (value.toolSchema.state === 'frozen' && value.toolSchema.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['toolSchema'], message: 'A frozen tool schema cites its receipt' });
}
const siteEvaluationSchema = siteEvaluationBase.superRefine(refineSite);

/** Live connection facts and a separate read-only test receipt. No provider output or credentials. */
export const integrationRuntimeSchema = z.object({
  installed: z.enum(['installed', 'missing', 'not-required']),
  connection: z.enum(['connected', 'missing', 'expired']),
  accountLabel: shortText.nullable(),
  version: shortText.nullable(),
  reason: text,
  fix: z.object({ label: shortText, url: httpsUrl.nullable(), command: shortText.nullable() }).strict(),
  workflow: z.object({
    lastSuccess: z.object({ at: timestamp, operation: shortText }).strict().nullable(),
    lastTest: z.object({ at: timestamp, outcome: z.enum(['passed', 'failed']), kind: z.enum(['connection', 'workflow']), code: shortText, message: text }).strict().nullable(),
  }).strict(),
}).strict();
export type IntegrationRuntime = z.infer<typeof integrationRuntimeSchema>;
export const parseIntegrationRuntime = (input: unknown): IntegrationRuntime => integrationRuntimeSchema.parse(input);

const entrySchema = z.object({
  runtime: integrationRuntimeSchema.optional(),
  id, name: shortText, kind: z.enum(INTEGRATION_KINDS),
  role: z.enum(['required', 'selected', 'conditional', 'reference', 'deferred']),
  requirementIds: z.array(requirementId).min(1).max(18).refine(unique),
  resourceSourceId: z.enum(RESOURCE_SOURCE_IDS).nullable(),
  purpose: text,
  urls: z.array(httpsUrl).max(5).refine(unique),
  version: z.object({ value: shortText.nullable(), basis: z.enum(['package', 'commit', 'terms-date', 'skill-version', 'unpinned']), note: text.nullable() }).strict(),
  rights: z.object({ status: z.enum(['held-licence', 'published-licence', 'reference-only', 'restricted', 'unknown']), summary: text, evidenceRefs }).strict(),
  inputs: z.array(shortText).min(1).max(20), outputs: z.array(shortText).min(1).max(20),
  account: z.object({ required: z.enum(['none', 'account', 'oauth-account', 'held-licence', 'paid-plan', 'api-key']), summary: text, principal: shortText.nullable() }).strict(),
  /** GSAP: a project-selected declared dependency, never a host engine for every project. */
  dependencyScope: z.enum(['project-selected', 'host-bundled', 'none']),
  installState: z.object({
    state: z.enum(['bundled', 'configured', 'not-installed', 'not-applicable']),
    basis: z.enum(['repository-source', 'owner-confirmed', 'agent-runtime-receipt', 'none']),
    reason: text,
  }).strict(),
  /** Live: whether the daemon's own MCP configuration carries a matching server. */
  daemonBinding: z.enum(['enabled', 'disabled', 'not-configured', 'not-applicable']),
  availability: z.object({ state: z.enum(['available', 'needs-sign-in', 'unverified', 'unavailable', 'deferred']), reason: text }).strict(),
  need: z.object({ decision: z.enum(['need-confirmed', 'selected', 'conditional', 'reference-only', 'deferred']), reason: text }).strict(),
  readiness: z.enum(INTEGRATION_READINESS),
  operations: z.array(operationSchema).min(1).max(30),
  lastVerifiedUse: lastVerifiedUseSchema.nullable(),
  /** Receipts still missing before this row can claim working adoption. */
  pendingReceipts: z.array(text).max(30),
  gateIds: z.array(gateId).max(20).refine(unique),
  /** Present exactly for a user-named website (AC-R12.1). */
  siteEvaluation: siteEvaluationSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.readiness === 'usable') {
    const surfaces = value.lastVerifiedUse?.surfaces ?? [];
    if (!value.lastVerifiedUse || !surfaces.includes('canvas') || !surfaces.includes('od') || value.pendingReceipts.length > 0
      || !['held-licence', 'published-licence'].includes(value.rights.status) || value.availability.state !== 'available'
      || !value.operations.some(operation => operation.status === 'verified')) {
      ctx.addIssue({ code: 'custom', path: ['readiness'], message: 'usable requires a verified operation, a current canvas and od use receipt, settled rights and no pending receipt' });
    }
  }
  if (value.lastVerifiedUse === null && value.pendingReceipts.length === 0) ctx.addIssue({ code: 'custom', path: ['pendingReceipts'], message: 'A row without a verified use names the missing receipt' });
  if ((value.rights.status === 'held-licence') !== (value.account.required === 'held-licence')) ctx.addIssue({ code: 'custom', path: ['account'], message: 'A held licence is the required account, and only for held-licence rights' });
  if (value.siteEvaluation?.decision === 'reference-only' && value.readiness !== 'reference-only') ctx.addIssue({ code: 'custom', path: ['readiness'], message: 'A reference-only site is reference-only' });
  if (value.siteEvaluation?.decision === 'unsupported' && value.readiness !== 'unavailable') ctx.addIssue({ code: 'custom', path: ['readiness'], message: 'An unsupported site is unavailable' });
  if (!unique(value.operations.map(operation => operation.operation))) ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Duplicate operation' });
});

/* ---------------------------- R16 held-licence record ---------------------------- */

export const LICENCE_RECORD_SOURCES = ['react-bits'] as const;
/** A usable row's last verified use may be at most this old when the roster is read. */
export const USABLE_RECEIPT_MAX_AGE_DAYS = 90;
type SourceOperation = (typeof SOURCE_OPERATIONS)[number];
/** Rejects licence keys and bearer tokens: long unbroken runs or common key prefixes. */
const keyPrefix = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/u;
const credentialLike = (value: string) => /[A-Za-z0-9+/=_-]{32,}/u.test(value) || keyPrefix.test(value);
/** URLs legitimately carry long hyphenated slugs; a long unbroken token segment is still refused. */
const urlCredentialLike = (value: string) => /[A-Za-z0-9_]{24,}/u.test(value.replace(/^https:\/\/[^/]+/u, '')) || keyPrefix.test(value);
const noCredential = (schema: z.ZodString) => schema.refine(value => !credentialLike(value), 'Licence records hold no keys or tokens; record a digest instead');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const clauseRef = noCredential(z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9 ._:§()-]*$/u))
  .refine(value => value === value.trim() && !/\s{2}/u.test(value), 'Clause references carry no padding');

const termsEvidenceSchema = z.object({
  kind: z.enum(['agreement', 'terms-version', 'vendor-account-record']),
  /** Digest of the held terms document or account record; its bytes never enter this record. */
  sha256,
  citationUrl: httpsUrl.refine(value => !urlCredentialLike(value), 'A citation URL carries no key or token').nullable(),
  clauseRefs: z.array(clauseRef).min(1).max(50).refine(unique, 'Duplicate clause reference'),
}).strict();

/** Draft row. `reassessed` is the owner's explicit re-assessment of a prior restriction or a newly added clause. */
const operationScopeSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked']),
  clauseRefs: z.array(clauseRef).min(1).max(20).refine(unique),
  reassessed: z.literal(true).optional(),
}).strict();
/** Stored row. `carriedFrom` is set only by the server when a prior restriction carries forward. */
const storedScopeSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked']),
  clauseRefs: z.array(clauseRef).min(1).max(20).refine(unique),
  reassessed: z.boolean(),
  carriedFrom: z.object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: sha256.nullable() }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.carriedFrom && value.decision !== 'blocked') ctx.addIssue({ code: 'custom', path: ['carriedFrom'], message: 'Only restrictions carry forward' });
});
const changeSchema = z.object({
  kind: z.enum(['terms-digest-changed', 'clauses-added', 'restriction-carried', 'restriction-reassessed']),
  operation: z.enum(SOURCE_OPERATIONS).nullable(), clauseRefs: z.array(clauseRef).max(50),
}).strict();

const draftFields = {
  /** The licence-holding principal the owner names in Settings (Oct6 owner decision, Q3 option B). */
  holder: noCredential(z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u)),
  termsVersion: noCredential(z.string().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u)).nullable(),
  termsEvidence: termsEvidenceSchema.nullable(),
};
type DraftShape = { termsVersion: string | null; termsEvidence: unknown; operationScope: { operation: string; decision: string }[] };
function refineDraft(value: DraftShape, ctx: z.RefinementCtx): void {
  if (!unique(value.operationScope.map(item => item.operation))) ctx.addIssue({ code: 'custom', path: ['operationScope'], message: 'Duplicate operation' });
  if (value.termsEvidence !== null && value.termsVersion === null) ctx.addIssue({ code: 'custom', path: ['termsVersion'], message: 'Terms evidence names the held terms version' });
}
const licenceDraftSchema = z.object({ ...draftFields, operationScope: z.array(operationScopeSchema).max(SOURCE_OPERATIONS.length) }).strict().superRefine(refineDraft);

const putLicenceSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  draft: licenceDraftSchema,
}).strict();

export const LICENCE_WRITE_SURFACES = ['settings', 'cli', 'http'] as const;
const licenceRecordSchema = z.object({
  ...draftFields,
  operationScope: z.array(storedScopeSchema).max(SOURCE_OPERATIONS.length),
  changes: z.array(changeSchema).max(50),
  schema: z.literal('licence-record/1'), sourceId: z.enum(LICENCE_RECORD_SOURCES),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** `surface` is a label from request metadata, not an authentication of who wrote it. */
  recordedBy: z.object({ role: z.literal('source-curator'), basis: z.literal('specific-grant'), surface: z.enum(LICENCE_WRITE_SURFACES) }).strict(),
  recordedAt: timestamp,
}).strict().superRefine((value, ctx) => {
  refineDraft(value, ctx);
  if (value.termsEvidence === null && value.operationScope.some(item => item.decision === 'allowed')) ctx.addIssue({ code: 'custom', path: ['operationScope'], message: 'An allowance needs recorded terms' });
});

const licenceOperationSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked', 'pending']),
  reason: z.enum(['held-terms-clause', 'held-terms-restriction', 'carried-restriction', 'licence-record-missing', 'licence-record-unreadable', 'terms-evidence-missing', 'not-assessed-from-terms']),
  clauseRefs: z.array(clauseRef).max(20),
}).strict();

const licenceSnapshotSchema = z.object({
  schema: z.literal('licence-record-snapshot/1'), sourceId: z.enum(LICENCE_RECORD_SOURCES),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** `unreadable`: a stored revision exists but no longer parses; reads degrade instead of failing. */
  recordState: z.enum(['none', 'current', 'unreadable']),
  /** Settled by the owner's confirmation (G07); no further proof of existence is required. */
  licenceExistence: z.literal('owner-confirmed'),
  record: licenceRecordSchema.nullable(),
  operations: z.array(licenceOperationSchema).length(SOURCE_OPERATIONS.length),
}).strict().superRefine((value, ctx) => {
  const ok = value.recordState === 'none' ? value.revision === 0 && value.record === null
    : value.recordState === 'unreadable' ? value.revision > 0 && value.record === null
      : value.record !== null && value.record.revision === value.revision && value.record.sourceId === value.sourceId;
  if (!ok) ctx.addIssue({ code: 'custom', path: ['record'], message: 'The record state, revision and source agree' });
});

const exclusionSchema = z.object({ name: shortText, reason: text }).strict();
const rosterSchema = z.object({
  schema: z.literal('integration-roster/1'),
  /** SHA-256 of the static roster rows, so a client sees when the curated roster changed. */
  rosterDigest: sha256,
  /** Read time; receipt freshness for usable rows is judged against it. */
  generatedAt: timestamp,
  entries: z.array(entrySchema).min(1).max(100),
  licences: z.array(licenceSnapshotSchema).max(LICENCE_RECORD_SOURCES.length),
  /** Named gaps the roster does not yet cover (for example per-operation notices). */
  knownGaps: z.array(text).max(20),
  /** Deliberately absent sources and why, so "none omitted" is checkable. */
  exclusions: z.array(exclusionSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.entries.map(entry => entry.id))) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Duplicate integration identity' });
  const limit = Date.parse(value.generatedAt) - USABLE_RECEIPT_MAX_AGE_DAYS * 86_400_000;
  for (const [index, entry] of value.entries.entries()) {
    if (entry.readiness === 'usable' && entry.lastVerifiedUse && Date.parse(entry.lastVerifiedUse.at) < limit) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'lastVerifiedUse'], message: `A usable row's verified-use receipt is older than ${USABLE_RECEIPT_MAX_AGE_DAYS} days` });
    }
  }
});

const inventorySiteSchema = siteEvaluationBase.extend({
  entryId: id, name: shortText, urls: z.array(httpsUrl).max(5), readiness: z.enum(INTEGRATION_READINESS),
  operations: z.array(operationSchema).min(1).max(30),
}).strict().superRefine(refineSite);
const connectorInventorySchema = z.object({
  schema: z.literal('connector-inventory/1'), rosterDigest: sha256,
  sites: z.array(inventorySiteSchema).min(1).max(100),
  exclusions: z.array(exclusionSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.sites.map(site => site.entryId))) ctx.addIssue({ code: 'custom', path: ['sites'], message: 'Duplicate site' });
});

export type IntegrationRosterEntry = z.infer<typeof entrySchema>;
export type IntegrationSiteEvaluation = z.infer<typeof siteEvaluationSchema>;
export type IntegrationRoster = z.infer<typeof rosterSchema>;
export type ConnectorInventory = z.infer<typeof connectorInventorySchema>;
export type LicenceDraft = z.infer<typeof licenceDraftSchema>;
export type PutLicenceRecord = z.infer<typeof putLicenceSchema>;
export type LicenceRecord = z.infer<typeof licenceRecordSchema>;
export type LicenceStoredScope = z.infer<typeof storedScopeSchema>;
export type LicenceChange = z.infer<typeof changeSchema>;
export type LicenceWriteSurface = (typeof LICENCE_WRITE_SURFACES)[number];
export type LicenceOperationStatus = z.infer<typeof licenceOperationSchema>;
export type LicenceRecordSnapshot = z.infer<typeof licenceSnapshotSchema>;
export type LicenceScopeViolation = {
  reason: 'licence-scope-widening' | 'licence-restriction-override' | 'licence-terms-digest-conflict' | 'licence-reassessment-required' | 'licence-history-unreadable';
  operation: SourceOperation | null;
};

export const parseIntegrationRosterEntry = (input: unknown): IntegrationRosterEntry => entrySchema.parse(input);
/** A catalogue/reference entry has no live probe unless it has an admitted binding or local lane. */
export function integrationTestability(entry: IntegrationRosterEntry): { testable: true } | { testable: false; reason: 'reference-only'; message: string } {
  if (entry.daemonBinding !== 'not-applicable' || entry.resourceSourceId === null || ['gsap', 'hallmark'].includes(entry.id)) return { testable: true };
  return { testable: false, reason: 'reference-only', message: 'Reference only: no live connection to test' };
}
export const parseIntegrationRoster = (input: unknown): IntegrationRoster => rosterSchema.parse(input);
export const parseConnectorInventory = (input: unknown): ConnectorInventory => connectorInventorySchema.parse(input);
export const parseLicenceDraft = (input: unknown): LicenceDraft => licenceDraftSchema.parse(input);
export const parsePutLicenceRecord = (input: unknown): PutLicenceRecord => putLicenceSchema.parse(input);
export const parseLicenceRecord = (input: unknown): LicenceRecord => licenceRecordSchema.parse(input);
export const parseLicenceRecordSnapshot = (input: unknown): LicenceRecordSnapshot => licenceSnapshotSchema.parse(input);

const byRevision = (history: readonly LicenceRecord[]) => [...history].sort((a, b) => a.revision - b.revision);
/** The latest recorded row for an operation across history, with the record that holds it. */
function latestRow(history: readonly LicenceRecord[], operation: SourceOperation): { record: LicenceRecord; row: LicenceStoredScope } | null {
  for (const record of byRevision(history).reverse()) {
    const row = record.operationScope.find(item => item.operation === operation);
    if (row) return { record, row };
  }
  return null;
}
/** Every clause ever recorded under one terms digest. */
function clausesUnder(history: readonly LicenceRecord[], digest: string): Set<string> | null {
  const records = history.filter(record => record.termsEvidence?.sha256 === digest);
  return records.length ? new Set(records.flatMap(record => record.termsEvidence!.clauseRefs)) : null;
}

/**
 * R16 preamble: scope comes only from the held licence's own terms, and a recorded
 * restriction cannot be lifted by assertion.
 * - widening: an allowance without terms evidence, or citing a clause outside them.
 * - restriction override: an allowance for an operation that ANY revision under the same
 *   terms digest recorded as blocked (including a carried restriction), however many steps away.
 * - terms digest conflict: a different digest under an unchanged terms version.
 * - re-assessment required: lifting a restriction carried from other terms, or allowing on a
 *   clause newly added under an existing digest, needs the owner's explicit `reassessed` mark.
 * History is every readable stored revision; the caller refuses allowances over unreadable history.
 */
export function licenceScopeViolations(draft: LicenceDraft, history: readonly LicenceRecord[]): LicenceScopeViolation[] {
  const violations: LicenceScopeViolation[] = [];
  const terms = draft.termsEvidence;
  if (terms && history.some(record => record.termsEvidence && record.termsVersion === draft.termsVersion && record.termsEvidence.sha256 !== terms.sha256)) {
    violations.push({ reason: 'licence-terms-digest-conflict', operation: null });
  }
  const cited = new Set(terms?.clauseRefs ?? []);
  const known = terms ? clausesUnder(history, terms.sha256) : null;
  for (const item of draft.operationScope) {
    if (item.decision !== 'allowed') continue;
    if (!terms || item.clauseRefs.some(clause => !cited.has(clause))) { violations.push({ reason: 'licence-scope-widening', operation: item.operation }); continue; }
    if (history.some(record => record.termsEvidence?.sha256 === terms.sha256
      && record.operationScope.some(row => row.operation === item.operation && row.decision === 'blocked'))) {
      violations.push({ reason: 'licence-restriction-override', operation: item.operation }); continue;
    }
    const carried = latestRow(history, item.operation)?.row.decision === 'blocked';
    const newClause = known !== null && item.clauseRefs.some(clause => !known.has(clause));
    if ((carried || newClause) && item.reassessed !== true) violations.push({ reason: 'licence-reassessment-required', operation: item.operation });
  }
  return violations;
}

/**
 * The stored form of an accepted draft: restrictions not explicitly re-stated carry forward
 * from history, and terms/clause/re-assessment changes are recorded, so history shows them.
 */
export function materializeLicenceDraft(draft: LicenceDraft, history: readonly LicenceRecord[]): { operationScope: LicenceStoredScope[]; changes: LicenceChange[] } {
  const operationScope: LicenceStoredScope[] = draft.operationScope.map(item => ({
    operation: item.operation, decision: item.decision, clauseRefs: item.clauseRefs, reassessed: item.reassessed === true, carriedFrom: null,
  }));
  const changes: LicenceChange[] = [];
  const terms = draft.termsEvidence;
  const priorTerms = byRevision(history).reverse().find(record => record.termsEvidence)?.termsEvidence ?? null;
  if (terms && priorTerms && priorTerms.sha256 !== terms.sha256) changes.push({ kind: 'terms-digest-changed', operation: null, clauseRefs: [] });
  const known = terms ? clausesUnder(history, terms.sha256) : null;
  const added = terms && known ? terms.clauseRefs.filter(clause => !known.has(clause)) : [];
  if (added.length) changes.push({ kind: 'clauses-added', operation: null, clauseRefs: added });
  for (const operation of SOURCE_OPERATIONS) {
    if (operationScope.some(item => item.operation === operation)) continue;
    const latest = latestRow(history, operation);
    if (latest?.row.decision !== 'blocked') continue;
    operationScope.push({
      operation, decision: 'blocked', clauseRefs: latest.row.clauseRefs, reassessed: false,
      carriedFrom: latest.row.carriedFrom ?? { revision: latest.record.revision, sha256: latest.record.termsEvidence?.sha256 ?? null },
    });
    changes.push({ kind: 'restriction-carried', operation, clauseRefs: latest.row.clauseRefs });
  }
  for (const item of draft.operationScope) {
    if (item.decision === 'allowed' && item.reassessed === true) changes.push({ kind: 'restriction-reassessed', operation: item.operation, clauseRefs: item.clauseRefs });
  }
  return { operationScope, changes };
}

/** Every operation gets a decision. Restrictions hold even without terms evidence; allowances need it. */
export function licenceOperationStatuses(record: LicenceRecord | null): LicenceOperationStatus[] {
  return SOURCE_OPERATIONS.map(operation => {
    if (!record) return { operation, decision: 'pending', reason: 'licence-record-missing', clauseRefs: [] };
    const scoped = record.operationScope.find(item => item.operation === operation);
    if (scoped?.decision === 'blocked') return { operation, decision: 'blocked', reason: scoped.carriedFrom ? 'carried-restriction' : 'held-terms-restriction', clauseRefs: scoped.clauseRefs };
    if (!record.termsEvidence) return { operation, decision: 'pending', reason: 'terms-evidence-missing', clauseRefs: [] };
    if (!scoped) return { operation, decision: 'pending', reason: 'not-assessed-from-terms', clauseRefs: [] };
    return { operation, decision: 'allowed', reason: 'held-terms-clause', clauseRefs: scoped.clauseRefs };
  });
}

/** Statuses for a stored record that no longer parses: nothing is granted. */
export const unreadableLicenceStatuses = (): LicenceOperationStatus[] =>
  SOURCE_OPERATIONS.map(operation => ({ operation, decision: 'pending', reason: 'licence-record-unreadable', clauseRefs: [] }));
