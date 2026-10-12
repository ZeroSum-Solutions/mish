import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_OPERATIONS, parseRightsAssessment } from '@open-design/contracts';
import { ACETERNITY_FREE_RIGHTS_ASSESSMENTS, ACETERNITY_RIGHTS_EVIDENCE, OWNER_DECISION_EVIDENCE } from '../../src/workbench/aceternity-rights.js';
import { ACETERNITY_ITEMS } from '../../src/workbench/reference-sources.js';

/**
 * AC-R18.6 / G38: the Aceternity RightsAssessment. Owner decision 2026-10-09: the
 * repository is private and licences are ignored for now, so every private operation is
 * admitted under the `owner-accepted-private-use` basis with that dated citation. The
 * retrieved licence, terms and pricing-FAQ clauses stay attached as metadata. Public
 * redistribution is outside private use and stays blocked. Nothing is purchased.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const evidence = JSON.parse(readFileSync(`${root}${ACETERNITY_RIGHTS_EVIDENCE}`, 'utf8')) as {
  retrievals: { id: string; url: string; retrievedAt: string; sha256: string; bytes: number }[];
  clauses: { id: string; retrievalId: string; quote: string; quoteSha256: string }[];
  operations: Record<string, { decision: string; clauseRefs: string[] }>;
  ownerDecision: { id: string; decidedAt: string; decidedBy: string; relayedBy: string; citation: string };
};
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const BLOCKED = ['redistribute-unit'];

describe('Aceternity free-tier RightsAssessment (AC-R18.6, G38)', () => {
  it('records one parsed source-curator assessment per evaluated item, bound to its exact registry bytes', () => {
    expect(ACETERNITY_FREE_RIGHTS_ASSESSMENTS.map(record => record.source.ref.itemId).sort()).toEqual(ACETERNITY_ITEMS.map(item => item.itemId).sort());
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) {
      expect(parseRightsAssessment(record)).toEqual(record);
      const item = ACETERNITY_ITEMS.find(entry => entry.itemId === record.source.ref.itemId)!;
      expect(record.source).toMatchObject({
        ref: { sourceType: 'reference', sourceId: 'aceternity', itemId: item.itemId, revisionOrDigest: `sha256:${item.registrySha256}` },
        contentSha256: item.componentSha256, closureDigest: item.registrySha256, fileScope: 'all',
      });
      expect(record.acquisitionMode).toBe('project-fetch');
      expect(record.evaluator).toMatchObject({ role: 'source-curator', basis: 'owner-accepted-private-use' });
      expect(record.ownerDecision).toMatchObject({ decidedAt: '2026-10-09', decidedBy: 'owner' });
      expect(record.ownerDecision!.citation).toMatch(/licences are ignored/);
      // Provenance: Devin's decision, relayed by the Mishh Orchestrator session to the captain.
      expect(record.ownerDecision!.citation).toMatch(/Devin/);
      expect(record.ownerDecision!.citation).toMatch(/Mishh Orchestrator session/);
      expect(record.authorityScope).toEqual({ kind: 'source-management', principalId: 'local-owner' });
    }
  });

  it('keeps the retrieved licence as metadata: exact licence digest and only retrieved clauses', () => {
    const licence = evidence.retrievals.find(entry => entry.url === 'https://ui.aceternity.com/licence')!;
    expect(licence.sha256).toMatch(/^[a-f0-9]{64}$/);
    const clauseIds = new Set(evidence.clauses.map(clause => clause.id));
    for (const clause of evidence.clauses) {
      expect(sha256(clause.quote)).toBe(clause.quoteSha256);
      expect(evidence.retrievals.some(entry => entry.id === clause.retrievalId)).toBe(true);
    }
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) {
      expect(record.terms).toMatchObject({ sha256: licence.sha256, canonicalUrl: 'https://ui.aceternity.com/licence' });
      for (const ref of record.terms!.clauseRefs) expect(clauseIds.has(ref), ref).toBe(true);
      // The item's own page names the licence that governs it.
      expect(record.terms!.clauseRefs).toContain(`component#${record.source.ref.itemId}.ld-json-license`);
      for (const ref of record.evidenceRefs.filter(entry => entry !== OWNER_DECISION_EVIDENCE)) expect(evidence.retrievals.some(entry => entry.id === ref), ref).toBe(true);
      expect(evidence.ownerDecision).toMatchObject({ id: OWNER_DECISION_EVIDENCE, decidedAt: '2026-10-09', decidedBy: 'Devin' });
      expect(evidence.ownerDecision.relayedBy).toMatch(/Mishh Orchestrator session/);
    }
  });

  it('admits every private operation under the owner decision and keeps public redistribution blocked', () => {
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) {
      expect(record.operationRights.map(right => right.operation).sort()).toEqual([...SOURCE_OPERATIONS].sort());
      for (const right of record.operationRights) {
        const expected = BLOCKED.includes(right.operation) ? 'blocked' : 'allowed';
        expect(right.decision, right.operation).toBe(expected);
        expect(evidence.operations[right.operation]?.decision, right.operation).toBe(expected);
        expect(right.reason).toMatch(/owner decision 2026-10-09/);
        // The published clause read for the same operation stays cited as metadata.
        for (const ref of evidence.operations[right.operation]!.clauseRefs) expect(right.reason!, right.operation).toContain(ref);
        expect(right.scope.principalId).toBe('local-owner');
        if (expected === 'allowed') {
          expect(right.scope.visibility).not.toBe('reusable-distribution');
          expect(right.evidenceRefs).toContain(OWNER_DECISION_EVIDENCE);
        }
      }
      expect(record.evidenceRefs).toContain(OWNER_DECISION_EVIDENCE);
    }
  });

  it('records the same dated provenance in the owner gate register and the evaluation', () => {
    const gates = readFileSync(`${root}docs/plans/2026-10-02-design-workbench/owner-gate-decisions.md`, 'utf8');
    const evaluation = readFileSync(`${root}docs/plans/2026-10-03-aceternity-evaluation.md`, 'utf8');
    for (const text of [gates, evaluation]) {
      expect(text).toMatch(/Oct9 owner decision/);
      expect(text).toMatch(/Mishh Orchestrator session/);
      expect(text).not.toMatch(/Oct8 owner decision/);
    }
  });
});
