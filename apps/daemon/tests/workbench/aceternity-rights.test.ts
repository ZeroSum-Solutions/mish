import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_OPERATIONS, parseRightsAssessment } from '@mish/contracts';
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
const BLOCKED = ['redistribute-unit'];
const OPERATION_CLAUSES: Record<string, string[]> = {
  'host-preview': ['licence#permitted.create-end-products', 'terms#you-must-not'],
  'incorporate-project': ['licence#permitted.create-end-products', 'licence#permitted.modification', 'pricing#faq.is-aceternity-ui-free'],
  'export-application': ['licence#permitted.distribution', 'licence#sample-end-products', 'pricing#faq.commercial-projects', 'licence#prohibited.template-creation'],
  'redistribute-unit': ['licence#prohibited.re-distribution', 'licence#prohibited.marketplace', 'pricing#faq.commercial-projects', 'terms#you-must-not'],
  'save-private-unit': ['licence#permitted.multi-use', 'terms#you-must-not'],
  'reuse-private-project': ['licence#permitted.multi-use', 'licence#permitted.create-end-products'],
  'private-backup': ['licence#license-grant', 'terms#you-must-not'],
  'cache-source-content': ['terms#you-must-not'],
  'derive-from-reference': ['licence#permitted.modification', 'pricing#paid.ai-ready-prompts'],
};

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

  it('retains pinned terms metadata without shipping private retrieval evidence', () => {
    expect(existsSync(`${root}${ACETERNITY_RIGHTS_EVIDENCE}`)).toBe(false);
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) {
      expect(record.terms).toMatchObject({ canonicalUrl: 'https://ui.aceternity.com/licence', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(record.terms!.clauseRefs).toContain(`component#${record.source.ref.itemId}.ld-json-license`);
      expect(record.evidenceRefs).toContain(OWNER_DECISION_EVIDENCE);
    }
  });

  it('admits every private operation under the owner decision and keeps public redistribution blocked', () => {
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) {
      expect(record.operationRights.map(right => right.operation).sort()).toEqual([...SOURCE_OPERATIONS].sort());
      for (const right of record.operationRights) {
        const expected = BLOCKED.includes(right.operation) ? 'blocked' : 'allowed';
        expect(right.decision, right.operation).toBe(expected);
        expect(right.reason).toMatch(/owner decision 2026-10-09/);
        // The published clause read for the same operation stays cited as metadata.
        for (const clause of OPERATION_CLAUSES[right.operation]!) expect(right.reason, right.operation).toContain(clause);
        expect(right.scope.principalId).toBe('local-owner');
        if (expected === 'allowed') {
          expect(right.scope.visibility).not.toBe('reusable-distribution');
          expect(right.evidenceRefs).toContain(OWNER_DECISION_EVIDENCE);
        }
      }
      expect(record.evidenceRefs).toContain(OWNER_DECISION_EVIDENCE);
    }
  });

  it('keeps internal owner gate records out of the public repository', () => {
    expect(existsSync(`${root}docs/plans/2026-10-02-design-workbench/owner-gate-decisions.md`)).toBe(false);
    expect(existsSync(`${root}docs/plans/2026-10-03-aceternity-evaluation.md`)).toBe(false);
  });
});
