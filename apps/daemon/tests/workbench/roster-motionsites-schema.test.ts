import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { licenceOperationStatuses, type LicenceRecordSnapshot } from '@mish/contracts';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { CONNECTOR_DEFINITIONS } from '../../src/workbench/connectors/connector-proxy.js';

/**
 * AC-R12.1/AC-R12.2: the MotionSites tool schema was frozen by the 2026-10-03 live
 * read-only handshake. The named-site register cites that receipt and the same digest
 * the connector proxy dispatches against, so the two cannot drift apart.
 */
const repoRoot = resolve(import.meta.dirname, '../../../..');
const PROOF = 'docs/plans/2026-10-03-motionsites-native-routing-proof.md';
const DIGEST = 'e860ed5577971f1c95c13c60ccf91b153402b07942ad18be9421348207253292';
const noLicence: LicenceRecordSnapshot = { schema: 'licence-record-snapshot/1', sourceId: 'react-bits', revision: 0, recordState: 'none', licenceExistence: 'owner-confirmed', record: null, operations: licenceOperationStatuses(null) };

describe('MotionSites frozen tool schema in the named-site register', () => {
  const site = buildIntegrationRoster({ mcpServers: [], licences: [noLicence] }).entries.find(entry => entry.id === 'motionsites')!.siteEvaluation!;

  it('records the schema as frozen and cites the routing proof that holds the digest', () => {
    expect(site.toolSchema.state).toBe('frozen');
    expect(site.toolSchema.evidenceRefs).toContain(PROOF);
    expect(existsSync(resolve(repoRoot, PROOF))).toBe(false);
    expect(site.toolSchema.summary).toContain(DIGEST);
  });

  it('matches the digest the connector proxy dispatches against', () => {
    expect(CONNECTOR_DEFINITIONS.motionsites.tools).toEqual([{ name: 'search_prompts', schemaDigest: DIGEST, evidenceRef: PROOF }]);
  });
});
