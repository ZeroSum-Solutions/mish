// AC-R13.1 (docs/plans/2026-10-02-design-workbench/prd.md): the every-ID component ledger.
// Each row carries original reference, expected state set, dependencies, source version,
// rights and repair owner. Quarantine is never counted as repaired, and repaired evidence
// is bound to the exact source version it proved.
import { describe, expect, it } from 'vitest';
import { RESOURCE_SOURCE_IDS } from '../src/api/workbench-resource-ref.js';
import { parseComponentLedger, summarizeComponentLedger } from '../src/api/workbench-component-ledger.js';

const digest = 'a'.repeat(64);
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'genui:glare-hover', sourceId: 'genui', itemId: 'glare-hover', title: 'Glare Hover',
  family: 'genui-css', nativeFormat: 'html',
  originalReference: { url: 'https://reactbits.dev/animations/glare-hover', upstreamRevision: null, referenceImage: null, note: null },
  expectedStates: { primaryAction: 'Pointer hover or keyboard focus plays the sweep', states: ['default', 'hover', 'focus-visible', 'reduced-motion'], viewports: [390, 1280], reducedMotion: 'required' },
  dependencies: [{ name: 'genui-runtime', kind: 'runtime', version: null }],
  sourceVersion: { revision: 'genui-catalog/1', digest, pinned: true },
  rights: { license: 'MIT + Commons Clause', decision: 'clean-room', implementationOrigin: 'clean-room', evidence: 'packages/genui-catalog/NOTICE' },
  repairOwner: 'C1', disposition: 'repair-pending', dispositionReason: null, evidence: [],
  ...overrides,
});
const cohorts = () => RESOURCE_SOURCE_IDS.map(sourceId => sourceId === 'genui'
  ? { id: 'genui', sourceId, scope: 'public-core', itemCount: 1, listingDigest: digest, reason: 'Owned GenUI ports' }
  : { id: sourceId, sourceId, scope: 'not-exposed', itemCount: null, listingDigest: null, reason: 'No executable items exposed' });
const ledger = (rows: unknown[] = [row()], overrides: Record<string, unknown> = {}) => ({
  schema: 'component-ledger/1', scope: 'public-core', frozenAt: '2026-10-08T00:00:00.000Z',
  scopeDecision: { text: 'Public-core items; licensed pack items count once installed', decidedBy: 'owner', decidedOn: '2026-10-08' },
  cohorts: cohorts(), rows, ...overrides,
});

describe('AC-R13.1 component ledger contract', () => {
  it('accepts a row that names every required field', () => {
    expect(parseComponentLedger(ledger()).rows).toHaveLength(1);
  });

  it.each([
    ['original reference', { originalReference: undefined }],
    ['expected state set', { expectedStates: undefined }],
    ['dependencies', { dependencies: undefined }],
    ['source version', { sourceVersion: undefined }],
    ['rights', { rights: undefined }],
    ['repair owner', { repairOwner: '' }],
  ])('rejects a row without its %s', (_label, overrides) => {
    expect(() => parseComponentLedger(ledger([row(overrides)]))).toThrow();
  });

  it('requires the default state and a documented primary action', () => {
    expect(() => parseComponentLedger(ledger([row({ expectedStates: { ...row().expectedStates, states: ['hover'] } })]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ expectedStates: { ...row().expectedStates, primaryAction: '' } })]))).toThrow();
  });

  it('requires an explanation when no original reference URL exists', () => {
    expect(() => parseComponentLedger(ledger([row({ originalReference: { url: null, upstreamRevision: null, referenceImage: null, note: null } })]))).toThrow();
  });

  it('rejects an unpinned source version that claims a digest, and a pinned one without one', () => {
    expect(() => parseComponentLedger(ledger([row({ sourceVersion: { revision: 'x', digest: null, pinned: true } })]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ sourceVersion: { revision: 'x', digest, pinned: false } })]))).toThrow();
  });

  it('requires a reason for quarantine and reference-only rows', () => {
    expect(() => parseComponentLedger(ledger([row({ disposition: 'quarantined', dispositionReason: null })]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ disposition: 'reference-only', dispositionReason: null })]))).toThrow();
    expect(parseComponentLedger(ledger([row({ disposition: 'quarantined', dispositionReason: 'Not ported' })])).rows[0]!.disposition).toBe('quarantined');
  });

  it('accepts a repaired row only with evidence bound to its current pinned source digest', () => {
    expect(() => parseComponentLedger(ledger([row({ disposition: 'repaired', evidence: [] })]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'r13-run-1', sourceDigest: 'b'.repeat(64) }] })]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ disposition: 'repaired', sourceVersion: { revision: 'x', digest: null, pinned: false }, evidence: [{ kind: 'state-matrix', ref: 'r13-run-1', sourceDigest: digest }] })]))).toThrow();
    expect(parseComponentLedger(ledger([row({ disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'r13-run-1', sourceDigest: digest }] })])).rows[0]!.disposition).toBe('repaired');
  });

  it('rejects duplicate IDs and an ID that does not match its source and item', () => {
    expect(() => parseComponentLedger(ledger([row(), row()]))).toThrow();
    expect(() => parseComponentLedger(ledger([row({ id: 'genui:other' })]))).toThrow();
  });

  it('declares a scope for every resource source, so a later source enters the same gate', () => {
    expect(() => parseComponentLedger(ledger([row()], { cohorts: cohorts().filter(cohort => cohort.sourceId !== 'react95') }))).toThrow();
  });

  it('rejects a row whose source has no public-core cohort', () => {
    expect(() => parseComponentLedger(ledger([row({ id: 'react95:window', sourceId: 'react95', itemId: 'window' })]))).toThrow();
  });

  it('never counts quarantined or reference-only rows as repaired', () => {
    const repaired = row({ id: 'genui:a', itemId: 'a', disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'run', sourceDigest: digest }] });
    const quarantined = row({ id: 'genui:b', itemId: 'b', disposition: 'quarantined', dispositionReason: 'Missing preview' });
    const reference = row({ id: 'genui:c', itemId: 'c', disposition: 'reference-only', dispositionReason: 'Reference only' });
    const pending = row({ id: 'genui:d', itemId: 'd' });
    const summary = summarizeComponentLedger(parseComponentLedger(ledger([repaired, quarantined, reference, pending])));
    expect(summary).toMatchObject({ total: 4, repaired: 1, quarantined: 1, referenceOnly: 1, repairPending: 1, unresolved: 2, closable: false });
  });

  it('is closable only when no requested repair or quarantine remains', () => {
    const repaired = row({ disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'run', sourceDigest: digest }] });
    expect(summarizeComponentLedger(parseComponentLedger(ledger([repaired]))).closable).toBe(true);
    expect(summarizeComponentLedger(parseComponentLedger(ledger([row({ disposition: 'quarantined', dispositionReason: 'x' })]))).closable).toBe(false);
  });
});
