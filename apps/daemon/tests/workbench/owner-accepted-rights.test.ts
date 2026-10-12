import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RightsAssessment } from '@open-design/contracts';
import { ACETERNITY_FREE_RIGHTS_ASSESSMENTS } from '../../src/workbench/aceternity-rights.js';
import { assertOwnerAcceptedPrincipal, parseStoredSourceRecord } from '../../src/workbench/source-records.js';

/**
 * G38 review round 2, WARN 1: an `owner-accepted-private-use` assessment binds to the
 * verified local owner principal. The contract accepts any principal ID string, so the
 * daemon refuses other principals at the stored-record boundary and for its frozen
 * records, and no externally reachable route can publish an assessment.
 */
const asPrincipal = (record: RightsAssessment, principalId: string): RightsAssessment => ({
  ...record,
  authorityScope: { kind: 'source-management', principalId },
  operationRights: record.operationRights.map(right => ({ ...right, scope: { ...right.scope, principalId } })),
});
const owned = ACETERNITY_FREE_RIGHTS_ASSESSMENTS[0]!;
const stored = (record: RightsAssessment) => ({ kind: 'assessment', admissionId: 'aceternity-bento-grid', record });

describe('owner-accepted private use binds to the local owner (G38)', () => {
  it('accepts the local owner and refuses any other principal at the stored-record boundary', () => {
    expect(parseStoredSourceRecord(stored(owned))).toMatchObject({ kind: 'assessment', record: { evaluator: { basis: 'owner-accepted-private-use' } } });
    for (const principal of ['member:alice', 'workspace:w1:alice', 'local-daemon', 'owner']) {
      expect(() => parseStoredSourceRecord(stored(asPrincipal(owned, principal))), principal).toThrow(/owner/);
    }
  });

  it('every frozen Aceternity assessment passes the same owner check', () => {
    for (const record of ACETERNITY_FREE_RIGHTS_ASSESSMENTS) expect(() => assertOwnerAcceptedPrincipal(record)).not.toThrow();
    expect(() => assertOwnerAcceptedPrincipal(asPrincipal(owned, 'member:alice'))).toThrow(/owner/);
  });

  it('no route, server or CLI module can publish a source assessment', () => {
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const routes = readdirSync(`${src}routes`).filter(name => name.endsWith('.ts')).map(name => `${src}routes/${name}`);
    for (const file of [...routes, `${src}server.ts`, `${src}cli.ts`, `${src}workbench-cli.ts`]) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/SourceRecordStore|workbench-source-store|parseStoredSourceRecord/);
    }
  });
});
