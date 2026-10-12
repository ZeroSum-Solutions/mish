import { z } from 'zod';
import { RESOURCE_SOURCE_IDS } from './workbench-resource-ref.js';

/**
 * AC-R13.1 every-ID component ledger (`component-ledger/1`).
 *
 * One row per exposed executable component ID in the ledger's scope. Each row names its
 * original reference, expected state set, dependencies, exact source version, rights and
 * repair owner. Parsing proves shape only; whether the rows match what a checkout actually
 * exposes is the daemon's gate (`apps/daemon/src/workbench/component-ledger.ts`).
 *
 * Every resource source in the roster carries at least one cohort declaration, so a source
 * that starts exposing items cannot do so outside this gate. Licensed pack cohorts are
 * counted at source level and gain rows only in the ledger of an installed pack.
 */
export const COMPONENT_STATES = [
  'default', 'hover', 'focus-visible', 'active', 'disabled', 'loading', 'empty', 'error',
  'open', 'selected', 'reduced-motion', 'no-webgl-fallback',
] as const;
export const COMPONENT_DISPOSITIONS = ['repair-pending', 'quarantined', 'reference-only', 'repaired'] as const;
export const COMPONENT_COHORT_SCOPES = ['public-core', 'licensed-pack', 'not-component', 'not-exposed'] as const;

const text = z.string().min(1).max(2000).refine(value => !/[\p{Cc}]/u.test(value), 'Control character');
const token = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const httpsUrl = z.string().max(2000).regex(/^https:\/\/[^\s\\]+$/u, 'Expected an HTTPS URL');
const unique = (values: readonly unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;

const originalReferenceSchema = z.object({
  url: httpsUrl.nullable(),
  /** Upstream repository/snapshot revision the vendored or ported copy came from, when known. */
  upstreamRevision: text.nullable(),
  /** Repository-relative reference capture, attached by AC-R13.2 comparison work. */
  referenceImage: z.object({ path: text, sha256 }).strict().nullable(),
  note: text.nullable(),
}).strict().refine(value => value.url !== null || value.note !== null, 'A reference without a URL needs a note');

const expectedStatesSchema = z.object({
  primaryAction: text,
  states: z.array(z.enum(COMPONENT_STATES)).min(1).max(COMPONENT_STATES.length)
    .refine(unique, 'Duplicate state').refine(states => states.includes('default'), 'Every state set includes default'),
  viewports: z.array(z.number().int().min(240).max(3840)).min(1).max(8).refine(unique, 'Duplicate viewport'),
  reducedMotion: z.enum(['required', 'not-applicable']),
}).strict();

const dependencySchema = z.object({
  name: text,
  kind: z.enum(['package', 'runtime', 'stylesheet', 'capability', 'upstream-declared']),
  version: text.nullable(),
}).strict();

const sourceVersionSchema = z.object({
  revision: text,
  digest: sha256.nullable(),
  /** Pinned rows are versioned by the exact bytes this checkout exposes. Unpinned rows are
   * fetched per project; their bytes are only known at acquisition. */
  pinned: z.boolean(),
}).strict().refine(value => value.pinned === (value.digest !== null), 'Only a pinned version carries a digest');

const rightsSchema = z.object({
  license: text,
  decision: text,
  implementationOrigin: z.enum(['owned-original', 'clean-room', 'vendored', 'licensed', 'fetched', 'not-implemented']),
  evidence: text,
}).strict();

const evidenceSchema = z.object({ kind: token, ref: token, sourceDigest: sha256, recordedAt: z.string().datetime().optional() }).strict();

const rowSchema = z.object({
  id: z.string().min(1).max(500),
  sourceId: z.enum(RESOURCE_SOURCE_IDS),
  itemId: z.string().min(1).max(400).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid item identity'),
  title: text,
  /** Executable implementation bytes are present; this never certifies repair or verification. */
  built: z.boolean().optional(),
  /** Dependency family: one cold/warm browser batch for AC-R13.2/R13.3 verification. */
  family: token,
  nativeFormat: z.enum(['html', 'react', 'family-section']),
  originalReference: originalReferenceSchema,
  expectedStates: expectedStatesSchema,
  dependencies: z.array(dependencySchema).max(64).refine(values => unique(values.map(value => [value.kind, value.name])), 'Duplicate dependency'),
  sourceVersion: sourceVersionSchema,
  rights: rightsSchema,
  repairOwner: token,
  disposition: z.enum(COMPONENT_DISPOSITIONS),
  dispositionReason: text.nullable(),
  evidence: z.array(evidenceSchema).max(100),
}).strict().superRefine((row, ctx) => {
  if (row.id !== `${row.sourceId}:${row.itemId}`) ctx.addIssue({ code: 'custom', path: ['id'], message: 'Row id must be <sourceId>:<itemId>' });
  if ((row.disposition === 'quarantined' || row.disposition === 'reference-only') && row.dispositionReason === null) {
    ctx.addIssue({ code: 'custom', path: ['dispositionReason'], message: 'Quarantine and reference-only rows state their reason' });
  }
  if (row.disposition === 'repaired') {
    if (!row.sourceVersion.pinned || row.evidence.length === 0 || row.evidence.some(item => item.sourceDigest !== row.sourceVersion.digest)) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Repaired requires evidence bound to the current pinned source digest' });
    }
  }
});

const cohortSchema = z.object({
  id: token,
  sourceId: z.enum(RESOURCE_SOURCE_IDS),
  scope: z.enum(COMPONENT_COHORT_SCOPES),
  itemCount: z.number().int().nonnegative().nullable(),
  listingDigest: sha256.nullable(),
  reason: text,
}).strict();

const ledgerSchema = z.object({
  schema: z.literal('component-ledger/1'),
  scope: z.literal('public-core'),
  frozenAt: z.string().datetime(),
  scopeDecision: z.object({ text, decidedBy: token, decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict(),
  cohorts: z.array(cohortSchema).max(200),
  rows: z.array(rowSchema).max(5000),
}).strict().superRefine((ledger, ctx) => {
  if (!unique(ledger.cohorts.map(cohort => cohort.id))) ctx.addIssue({ code: 'custom', path: ['cohorts'], message: 'Duplicate cohort' });
  const covered = new Set(ledger.cohorts.map(cohort => cohort.sourceId));
  for (const sourceId of RESOURCE_SOURCE_IDS) {
    if (!covered.has(sourceId)) ctx.addIssue({ code: 'custom', path: ['cohorts'], message: `No scope declared for source ${sourceId}` });
  }
  const publicCore = new Set(ledger.cohorts.filter(cohort => cohort.scope === 'public-core').map(cohort => cohort.sourceId));
  if (!unique(ledger.rows.map(row => row.id))) ctx.addIssue({ code: 'custom', path: ['rows'], message: 'Duplicate row id' });
  for (const [index, row] of ledger.rows.entries()) {
    if (!publicCore.has(row.sourceId)) ctx.addIssue({ code: 'custom', path: ['rows', index, 'sourceId'], message: 'Row source has no public-core cohort' });
  }
});

export type ComponentState = (typeof COMPONENT_STATES)[number];
export type ComponentDisposition = (typeof COMPONENT_DISPOSITIONS)[number];
export type ComponentLedgerRow = z.infer<typeof rowSchema>;
export type ComponentLedgerCohort = z.infer<typeof cohortSchema>;
export type ComponentLedger = z.infer<typeof ledgerSchema>;
export interface ComponentLedgerSummary {
  total: number;
  repaired: number;
  repairPending: number;
  quarantined: number;
  referenceOnly: number;
  /** Requested repairs still open. Quarantine is unresolved, never repaired. */
  unresolved: number;
  /** AC-R13.4 closure precondition: no unresolved requested repair remains. */
  closable: boolean;
}

export function parseComponentLedger(input: unknown): ComponentLedger { return ledgerSchema.parse(input); }
export function parseComponentLedgerRow(input: unknown): ComponentLedgerRow { return rowSchema.parse(input); }

const reportEntrySchema = z.object({
  id: text, sourceId: z.enum(RESOURCE_SOURCE_IDS), itemId: text, title: text,
  source: z.enum(['public-core', 'pack']),
  rights: rightsSchema,
  licensed: z.boolean(), built: z.boolean(), tracked: z.literal(true),
  installed: z.boolean().nullable(), packId: token.nullable(),
  sourceVersion: sourceVersionSchema,
  disposition: z.enum(COMPONENT_DISPOSITIONS),
  verified: z.boolean(), evidenceDate: z.string().datetime().nullable(),
  evidence: z.array(evidenceSchema),
  errors: z.array(z.object({ code: z.literal('duplicate-id'), packId: token }).strict()).default([]),
}).strict().superRefine((entry, ctx) => {
  if (entry.id !== `${entry.sourceId}:${entry.itemId}`) ctx.addIssue({ code: 'custom', message: 'Component ID must match source and item' });
  if (entry.verified && (entry.errors.length > 0 || !entry.built || entry.disposition !== 'repaired' || entry.evidenceDate === null || !entry.sourceVersion.pinned ||
    entry.evidence.length === 0 || entry.evidence.some(item => !item.recordedAt || item.sourceDigest !== entry.sourceVersion.digest))) {
    ctx.addIssue({ code: 'custom', message: 'Verified requires dated current-version repair evidence' });
  }
  if ((entry.source === 'pack') !== (entry.packId !== null && entry.installed === true)) {
    ctx.addIssue({ code: 'custom', message: 'Pack rows require an installed pack identity' });
  }
  if (entry.source === 'public-core' && (entry.packId !== null || entry.installed !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Core entries have no pack installation state' });
  }
  if (entry.verified && entry.evidenceDate !== entry.evidence.map(item => item.recordedAt!).sort().at(-1)) {
    ctx.addIssue({ code: 'custom', message: 'Verification date must match its evidence' });
  }
});
const reportSchema = z.object({
  schema: z.literal('component-ledger-report/1'), frozenAt: z.string().datetime(),
  components: z.record(z.string(), reportEntrySchema),
}).strict().superRefine((report, ctx) => {
  for (const [id, entry] of Object.entries(report.components)) {
    if (id !== entry.id) ctx.addIssue({ code: 'custom', message: 'Component key must match its ID' });
  }
});
export type ComponentLedgerReportEntry = z.infer<typeof reportEntrySchema>;
export type ComponentLedgerReport = z.infer<typeof reportSchema>;
export function parseComponentLedgerReport(input: unknown): ComponentLedgerReport { return reportSchema.parse(input); }

/** Counts are computed from rows on every call; a stored percentage cannot hide a failure. */
export function summarizeComponentLedger(ledger: ComponentLedger): ComponentLedgerSummary {
  const count = (disposition: ComponentDisposition) => ledger.rows.filter(row => row.disposition === disposition).length;
  const repairPending = count('repair-pending');
  const quarantined = count('quarantined');
  const unresolved = repairPending + quarantined;
  return { total: ledger.rows.length, repaired: count('repaired'), repairPending, quarantined, referenceOnly: count('reference-only'), unresolved, closable: unresolved === 0 };
}
