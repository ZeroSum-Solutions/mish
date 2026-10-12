import { describe, expect, it } from 'vitest';
import {
  USABLE_RECEIPT_MAX_AGE_DAYS, licenceOperationStatuses, licenceScopeViolations, materializeLicenceDraft, parseConnectorInventory,
  parseIntegrationRoster, parseIntegrationRosterEntry, parseLicenceDraft, parseLicenceRecord,
  parseLicenceRecordSnapshot, type IntegrationRosterEntry, type LicenceDraft, type LicenceRecord,
} from '../src/api/workbench-integrations.js';
import { SOURCE_OPERATIONS } from '../src/api/workbench-source-admission.js';

const entry: IntegrationRosterEntry = {
  id: 'example', name: 'Example', kind: 'design-integration', role: 'selected', requirementIds: ['R08'],
  resourceSourceId: null, purpose: 'Example integration.', urls: ['https://example.com'],
  version: { value: '1.0.0', basis: 'package', note: null },
  rights: { status: 'published-licence', summary: 'MIT.', evidenceRefs: ['docs/example.md'] },
  inputs: ['Query'], outputs: ['Result'],
  account: { required: 'none', summary: 'No account.', principal: null },
  dependencyScope: 'project-selected',
  installState: { state: 'not-installed', basis: 'none', reason: 'Not installed.' },
  daemonBinding: 'not-applicable',
  availability: { state: 'unverified', reason: 'No receipt.' },
  need: { decision: 'selected', reason: 'Selected.' },
  readiness: 'unverified',
  operations: [{ operation: 'apply', status: 'unverified', evidenceRefs: [], reason: 'No receipt.' }],
  lastVerifiedUse: null, pendingReceipts: ['Canvas and od use receipt'], gateIds: [], siteEvaluation: null,
};
const site = {
  namedIn: 'Batch1 Q5 A', existingMcp: { result: 'no-mcp', endpoint: null, summary: 'None.', evidenceRefs: [] },
  toolSchema: { state: 'not-applicable', summary: 'No MCP.', evidenceRefs: [] }, terms: { summary: 'MIT.', evidenceRefs: [] },
  auth: { kind: 'none', summary: 'None.' }, cost: { kind: 'free', summary: 'Free.' },
  decision: 'use-existing', decisionReason: 'Existing adapter.', missingCapability: null, lastProof: null,
} as const;
const use = { at: '2026-10-08T00:00:00.000Z', operation: 'apply and save', surfaces: ['canvas', 'od'], evidenceRef: 'docs/receipt.json' } as const;

describe('AC-R08.1 roster rows cannot claim working adoption without a receipt', () => {
  it('accepts an honest unverified row naming its missing receipt', () => {
    expect(parseIntegrationRosterEntry(entry)).toEqual(entry);
  });
  it('refuses usable without a canvas and od receipt, with pending receipts, or with unsettled rights', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, readiness: 'usable' })).toThrow(/usable/);
    expect(() => parseIntegrationRosterEntry({ ...entry, readiness: 'usable', lastVerifiedUse: { ...use, surfaces: ['canvas'] }, pendingReceipts: [], availability: { state: 'available', reason: 'Probed.' } })).toThrow(/usable/);
    expect(() => parseIntegrationRosterEntry({ ...entry, readiness: 'usable', lastVerifiedUse: use, availability: { state: 'available', reason: 'Probed.' } })).toThrow(/usable/);
    expect(() => parseIntegrationRosterEntry({ ...entry, readiness: 'usable', lastVerifiedUse: use, pendingReceipts: [], availability: { state: 'available', reason: 'Probed.' }, rights: { ...entry.rights, status: 'unknown' } })).toThrow(/usable/);
    expect(parseIntegrationRosterEntry({ ...entry, readiness: 'usable', lastVerifiedUse: use, pendingReceipts: [], availability: { state: 'available', reason: 'Probed.' }, operations: [{ operation: 'apply', status: 'verified', evidenceRefs: ['docs/receipt.json'], reason: null }] }).readiness).toBe('usable');
  });
  it('requires a missing-receipt name whenever no verified use exists', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, pendingReceipts: [] })).toThrow(/missing receipt/);
  });
  it('requires a receipt for a verified operation and a reason otherwise', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, operations: [{ operation: 'apply', status: 'verified', evidenceRefs: [], reason: null }] })).toThrow();
    expect(() => parseIntegrationRosterEntry({ ...entry, operations: [{ operation: 'apply', status: 'blocked', evidenceRefs: [], reason: null }] })).toThrow();
  });
  it('ties held-licence rights to a held-licence account', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, rights: { ...entry.rights, status: 'held-licence' } })).toThrow(/held licence/);
  });
  it.each(['https://user:secret@example.com/x', 'https://example.com/?token=abc', 'http://example.com'])('rejects a credential-bearing or insecure URL %s', url => {
    expect(() => parseIntegrationRosterEntry({ ...entry, urls: [url] })).toThrow();
  });
});

describe('AC-R12.1 named-site evaluation shape', () => {
  it('records the existing-MCP result, schema evidence, terms/auth/cost and one of four decisions', () => {
    expect(parseIntegrationRosterEntry({ ...entry, siteEvaluation: site }).siteEvaluation?.decision).toBe('use-existing');
    expect(() => parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, decision: 'maybe' } })).toThrow();
  });
  it('justifies a small adapter only by a concrete missing capability', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, decision: 'build-small-adapter' } })).toThrow(/missing capability/);
    expect(() => parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, missingCapability: 'Search' } })).toThrow(/missing capability/);
    expect(parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, decision: 'build-small-adapter', missingCapability: 'No read-only search tool exists' } })).toBeTruthy();
  });
  it('keeps reference-only and unsupported sites out of working readiness', () => {
    expect(() => parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, decision: 'reference-only' } })).toThrow(/reference-only/);
    expect(() => parseIntegrationRosterEntry({ ...entry, siteEvaluation: { ...site, decision: 'unsupported' } })).toThrow(/unavailable/);
  });
});

const terms = { kind: 'terms-version' as const, sha256: 'a'.repeat(64), citationUrl: 'https://example.com/licence', clauseRefs: ['2.1', '2.4'] };
const draft = (patch: Partial<LicenceDraft> = {}): LicenceDraft => parseLicenceDraft({ holder: 'Example Owner', termsVersion: '2026-01', termsEvidence: terms, operationScope: [], ...patch });
/** A stored revision built the way the daemon builds it: draft plus carried restrictions and changes. */
const record = (value: LicenceDraft, history: LicenceRecord[] = [], surface: 'settings' | 'cli' | 'http' = 'settings') => parseLicenceRecord({
  ...value, ...materializeLicenceDraft(value, history), schema: 'licence-record/1', sourceId: 'react-bits', revision: history.length + 1,
  recordedBy: { role: 'source-curator', basis: 'specific-grant', surface }, recordedAt: '2026-10-08T00:00:00.000Z',
});
const blockRedistribute = { operationScope: [{ operation: 'redistribute-unit' as const, decision: 'blocked' as const, clauseRefs: ['2.4'] }] };
const allowRedistribute = { operationScope: [{ operation: 'redistribute-unit' as const, decision: 'allowed' as const, clauseRefs: ['2.1'] }] };

describe('R16 licence record: holder from the owner, scope only from held terms', () => {
  it('treats a bare allowance without terms evidence as widening', () => {
    expect(licenceScopeViolations(draft({ termsVersion: null, termsEvidence: null, operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['owner says so'] }] }), []))
      .toEqual([{ reason: 'licence-scope-widening', operation: 'host-preview' }]);
  });
  it('treats an allowance citing a clause outside the held terms as widening', () => {
    expect(licenceScopeViolations(draft({ operationScope: [{ operation: 'incorporate-project', decision: 'allowed', clauseRefs: ['9.9'] }] }), []))
      .toEqual([{ reason: 'licence-scope-widening', operation: 'incorporate-project' }]);
    expect(licenceScopeViolations(draft({ operationScope: [{ operation: 'incorporate-project', decision: 'allowed', clauseRefs: ['2.1'] }] }), [])).toEqual([]);
  });
  it('refuses to lift a restriction recorded under the same terms digest in one step', () => {
    const restricted = record(draft(blockRedistribute));
    expect(licenceScopeViolations(draft(allowRedistribute), [restricted])).toEqual([{ reason: 'licence-restriction-override', operation: 'redistribute-unit' }]);
  });
  it('refuses the two-step lift: dropping the restriction row, then allowing, under the same digest', () => {
    const first = record(draft(blockRedistribute));
    const dropped = record(draft(), [first]);
    expect(licenceScopeViolations(draft(allowRedistribute), [first, dropped])).toEqual([{ reason: 'licence-restriction-override', operation: 'redistribute-unit' }]);
  });
  it('refuses the two-step lift through a revision with no terms evidence', () => {
    const first = record(draft(blockRedistribute));
    const nulled = record(draft({ termsVersion: null, termsEvidence: null }), [first]);
    expect(licenceScopeViolations(draft(allowRedistribute), [first, nulled])).toEqual([{ reason: 'licence-restriction-override', operation: 'redistribute-unit' }]);
  });
  it('carries a restriction forward into later revisions until it is explicitly re-assessed', () => {
    const first = record(draft(blockRedistribute));
    const dropped = record(draft(), [first]);
    expect(dropped.operationScope).toContainEqual({ operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'], reassessed: false, carriedFrom: { revision: 1, sha256: terms.sha256 } });
    expect(dropped.changes).toContainEqual({ kind: 'restriction-carried', operation: 'redistribute-unit', clauseRefs: ['2.4'] });
    expect(licenceOperationStatuses(dropped).find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'blocked', reason: 'carried-restriction' });
    const nulled = record(draft({ termsVersion: null, termsEvidence: null }), [first]);
    expect(licenceOperationStatuses(nulled).find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'blocked', reason: 'carried-restriction' });
  });
  it('refuses a digest change while the terms version stays the same', () => {
    const first = record(draft(blockRedistribute));
    const swapped = draft({ termsEvidence: { ...terms, sha256: `${'a'.repeat(63)}b` }, ...allowRedistribute });
    expect(licenceScopeViolations(swapped, [first])).toContainEqual({ reason: 'licence-terms-digest-conflict', operation: null });
  });
  it('requires an explicit re-assessment to lift a prior restriction under new terms, and records it', () => {
    const first = record(draft(blockRedistribute));
    const renewed = { termsVersion: '2026-09', termsEvidence: { ...terms, sha256: 'b'.repeat(64) } };
    expect(licenceScopeViolations(draft({ ...renewed, ...allowRedistribute }), [first])).toEqual([{ reason: 'licence-reassessment-required', operation: 'redistribute-unit' }]);
    const reassessed = draft({ ...renewed, operationScope: [{ ...allowRedistribute.operationScope[0]!, reassessed: true }] });
    expect(licenceScopeViolations(reassessed, [first])).toEqual([]);
    const stored = record(reassessed, [first]);
    expect(stored.changes).toEqual(expect.arrayContaining([{ kind: 'terms-digest-changed', operation: null, clauseRefs: [] }, { kind: 'restriction-reassessed', operation: 'redistribute-unit', clauseRefs: ['2.1'] }]));
    expect(licenceOperationStatuses(stored).find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'allowed' });
  });
  it('treats a clause newly added under an existing digest as a recorded change, not a silent allowance', () => {
    const first = record(draft());
    const added = { termsEvidence: { ...terms, clauseRefs: ['2.1', '2.4', '99'] } };
    const silent = draft({ ...added, operationScope: [{ operation: 'save-private-unit', decision: 'allowed', clauseRefs: ['99'] }] });
    expect(licenceScopeViolations(silent, [first])).toEqual([{ reason: 'licence-reassessment-required', operation: 'save-private-unit' }]);
    const explicit = draft({ ...added, operationScope: [{ operation: 'save-private-unit', decision: 'allowed', clauseRefs: ['99'], reassessed: true }] });
    expect(licenceScopeViolations(explicit, [first])).toEqual([]);
    expect(record(explicit, [first]).changes).toContainEqual({ kind: 'clauses-added', operation: null, clauseRefs: ['99'] });
  });
  it('leaves only the affected operations pending when terms evidence is missing', () => {
    expect(licenceOperationStatuses(null).every(item => item.decision === 'pending' && item.reason === 'licence-record-missing')).toBe(true);
    const noTerms = record(draft({ termsVersion: null, termsEvidence: null }));
    expect(licenceOperationStatuses(noTerms).map(item => item.reason)).toEqual(SOURCE_OPERATIONS.map(() => 'terms-evidence-missing'));
    const scoped = record(draft({ operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }, { operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'] }] }));
    const statuses = Object.fromEntries(licenceOperationStatuses(scoped).map(item => [item.operation, item]));
    expect(statuses['host-preview']).toMatchObject({ decision: 'allowed', reason: 'held-terms-clause', clauseRefs: ['2.1'] });
    expect(statuses['redistribute-unit']).toMatchObject({ decision: 'blocked', reason: 'held-terms-restriction' });
    expect(statuses['save-private-unit']).toMatchObject({ decision: 'pending', reason: 'not-assessed-from-terms' });
  });
  it.each([
    { holder: 'sk-live-0123456789abcdef' }, { holder: 'a'.repeat(40) }, { termsVersion: 'ghp_abcdefghijklmnop' },
    { licenceKey: 'not-allowed' }, { termsEvidence: { ...terms, citationUrl: 'https://example.com/terms?key=abc' } },
    { termsEvidence: { ...terms, citationUrl: `https://example.com/licence/${'k'.repeat(40)}` } },
    { termsEvidence: { ...terms, clauseRefs: ['2.1 '] } },
    { operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'], carriedFrom: { revision: 1, sha256: null } }] },
  ])('holds no keys, tokens, padded clauses, server-only or extra fields: %j', patch => {
    expect(() => parseLicenceDraft({ holder: 'Example Owner', termsVersion: '2026-01', termsEvidence: terms, operationScope: [], ...patch })).toThrow();
  });
  it('requires a terms version with terms evidence and unique operations', () => {
    expect(() => parseLicenceDraft({ holder: 'Devin', termsVersion: null, termsEvidence: terms, operationScope: [] })).toThrow();
    expect(() => parseLicenceDraft({ holder: 'Devin', termsVersion: '1', termsEvidence: terms, operationScope: [
      { operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }, { operation: 'host-preview', decision: 'blocked', clauseRefs: ['2.4'] }] })).toThrow();
  });
  it('fixes the recording role and basis and records the write surface label', () => {
    expect(record(draft(), [], 'cli').recordedBy.surface).toBe('cli');
    expect(() => parseLicenceRecord({ ...record(draft()), recordedBy: { role: 'project-owner', basis: 'specific-grant', surface: 'settings' } })).toThrow();
    expect(() => parseLicenceRecord({ ...record(draft()), recordedBy: { role: 'source-curator', basis: 'specific-grant', authority: 'local-owner-settings' } })).toThrow();
  });
  it('binds a snapshot revision to its record and represents an unreadable stored record', () => {
    const snapshot = { schema: 'licence-record-snapshot/1', sourceId: 'react-bits', revision: 0, recordState: 'none', licenceExistence: 'owner-confirmed', record: null, operations: licenceOperationStatuses(null) };
    expect(parseLicenceRecordSnapshot(snapshot).licenceExistence).toBe('owner-confirmed');
    expect(() => parseLicenceRecordSnapshot({ ...snapshot, revision: 1 })).toThrow();
    const unreadable = { ...snapshot, revision: 3, recordState: 'unreadable', operations: licenceOperationStatuses(null).map(item => ({ ...item, reason: 'licence-record-unreadable' })) };
    expect(parseLicenceRecordSnapshot(unreadable).recordState).toBe('unreadable');
    expect(() => parseLicenceRecordSnapshot({ ...unreadable, revision: 0 })).toThrow();
  });
});

describe('usable gate needs a verified operation and a fresh receipt', () => {
  const verified = { operation: 'apply', status: 'verified' as const, evidenceRefs: ['docs/receipt.json'], reason: null };
  const usable = { ...entry, readiness: 'usable' as const, lastVerifiedUse: use, pendingReceipts: [], availability: { state: 'available' as const, reason: 'Probed.' } };
  it('refuses usable when no operation is verified', () => {
    expect(() => parseIntegrationRosterEntry(usable)).toThrow(/verified operation/);
    expect(parseIntegrationRosterEntry({ ...usable, operations: [verified] }).readiness).toBe('usable');
  });
  it('refuses a usable row whose last verified use is older than the receipt age limit at roster time', () => {
    const roster = (generatedAt: string) => ({ schema: 'integration-roster/1', rosterDigest: 'd'.repeat(64), generatedAt, entries: [{ ...usable, operations: [verified] }], licences: [], knownGaps: ['Per-operation notices are not recorded'], exclusions: [] });
    expect(parseIntegrationRoster(roster('2026-10-10T00:00:00.000Z')).entries).toHaveLength(1);
    const late = new Date(Date.parse(use.at) + (USABLE_RECEIPT_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
    expect(() => parseIntegrationRoster(roster(late))).toThrow(/receipt/);
  });
});

describe('AC-R12.1 inventory sites carry their operations', () => {
  it('requires operations on every inventory site', () => {
    const site0 = { entryId: 'example', name: 'Example', urls: [], readiness: 'unverified', ...site, operations: entry.operations };
    const inventory = { schema: 'connector-inventory/1', rosterDigest: 'd'.repeat(64), sites: [site0], exclusions: [{ name: 'Material UI', reason: 'Repository candidate, not a named website.' }] };
    expect(parseConnectorInventory(inventory).sites[0]!.operations).toHaveLength(1);
    const { operations: _dropped, ...withoutOperations } = site0;
    expect(() => parseConnectorInventory({ ...inventory, sites: [withoutOperations] })).toThrow();
  });
});
