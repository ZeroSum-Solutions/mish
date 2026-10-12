import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { licenceOperationStatuses, parseConnectorInventory, parseIntegrationRoster, type IntegrationRoster, type LicenceRecordSnapshot } from '@mish/contracts';
import { buildConnectorInventory, buildIntegrationRoster } from '../../src/workbench/integration-roster.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const noLicence: LicenceRecordSnapshot = { schema: 'licence-record-snapshot/1', sourceId: 'react-bits', revision: 0, recordState: 'none', licenceExistence: 'owner-confirmed', record: null, operations: licenceOperationStatuses(null) };
const roster = (servers: Parameters<typeof buildIntegrationRoster>[0]['mcpServers'] = [], licences = [noLicence]): IntegrationRoster => buildIntegrationRoster({ mcpServers: servers, licences });
const byId = (value: IntegrationRoster, id: string) => {
  const found = value.entries.find(entry => entry.id === id);
  if (!found) throw new Error(`Roster omits ${id}`);
  return found;
};

/**
 * Frozen from website-source-register.md (ten Batch1 families, the Oct3 Aceternity
 * addition, the font destinations and the Design System Checklist reference) and the
 * Batch2 Q6 Figma answer. AC-R12.1: no named site is quietly omitted.
 */
const NAMED_SITES = [
  'react-bits', 'refero', '21st-dev', 'fontsource', 'gsap', 'motionsites', 'canvas-ui', 'ai-sdk-agents', 'mobbin', 'magic-patterns',
  'aceternity', 'google-fonts', 'fontshare', 'adobe-fonts', 'design-system-checklist', 'figma',
];

describe('AC-R08.1 published integration roster', () => {
  it('D5 admits every named lane and keeps connection separate from workflow proof', () => {
    const value = roster();
    for (const id of ['mobbin', 'refero', '21st-dev', 'motionsites', 'hallmark', 'gsap', 'higgsfield', 'vercel', 'github', 'jev', 'deepseek', 'claude', 'codex']) {
      const entry = byId(value, id);
      expect(entry.runtime, id).toMatchObject({ connection: expect.stringMatching(/^(connected|missing|expired)$/), workflow: { lastSuccess: null, lastTest: null } });
    }
  });
  it('validates against the shared contract and publishes every required field per row', () => {
    const value = parseIntegrationRoster(roster());
    for (const entry of value.entries) {
      expect(entry.version, entry.id).toBeTruthy();
      expect(entry.rights.summary.length, entry.id).toBeGreaterThan(0);
      expect(entry.inputs.length && entry.outputs.length, entry.id).toBeTruthy();
      expect(entry.account.required, entry.id).toBeTruthy();
      expect(entry.installState.state, entry.id).toBeTruthy();
      expect(entry.availability.state, entry.id).toBeTruthy();
      expect(entry.lastVerifiedUse !== null || entry.pendingReceipts.length > 0, entry.id).toBe(true);
    }
  });
  it('claims no usable integration: no row has a canvas and od adoption receipt yet', () => {
    expect(roster().entries.filter(entry => entry.readiness === 'usable').map(entry => entry.id)).toEqual([]);
  });
  it('Hallmark guides the project rubric and Refero supplies attributed references', () => {
    const value = roster();
    expect(byId(value, 'hallmark')).toMatchObject({ kind: 'design-skill', requirementIds: expect.arrayContaining(['R06', 'R08']) });
    expect(byId(value, 'hallmark').purpose).toMatch(/rubric/i);
    expect(byId(value, 'refero').purpose).toMatch(/attributed/i);
    expect(byId(value, 'refero').outputs.join(' ')).toMatch(/attributed/i);
  });
  it('GSAP is required, project-selected, need-confirmed and implementation-unverified', () => {
    const gsap = byId(roster(), 'gsap');
    expect(gsap).toMatchObject({ role: 'required', dependencyScope: 'project-selected', readiness: 'unverified', need: { decision: 'need-confirmed' }, rights: { status: 'published-licence' } });
    const operations = Object.fromEntries(gsap.operations.map(item => [item.operation, item]));
    expect(operations['code-generation-in-commercial-project']).toMatchObject({ status: 'unverified' });
    expect(operations['code-generation-in-commercial-project']?.reason).toMatch(/retained/i);
    expect(operations['visual-animation-editor']).toMatchObject({ status: 'deferred' });
    expect(operations['visual-animation-editor']?.reason).toMatch(/separately/i);
  });
  it('React Bits carries the held licence and names the licence record until the owner enters it', () => {
    const before = byId(roster(), 'react-bits');
    expect(before).toMatchObject({ rights: { status: 'held-licence' }, account: { required: 'held-licence', principal: null } });
    expect(before.pendingReceipts.join(' ')).toMatch(/licence record/i);
    const record = { schema: 'licence-record/1' as const, sourceId: 'react-bits' as const, revision: 1, holder: 'Example Owner', termsVersion: '2026-01',
      termsEvidence: { kind: 'terms-version' as const, sha256: 'a'.repeat(64), citationUrl: null, clauseRefs: ['2.1'] }, operationScope: [], changes: [],
      recordedBy: { role: 'source-curator' as const, basis: 'specific-grant' as const, surface: 'settings' as const }, recordedAt: '2026-10-08T00:00:00.000Z' };
    const after = byId(roster([], [{ ...noLicence, revision: 1, recordState: 'current', record, operations: licenceOperationStatuses(record) }]), 'react-bits');
    expect(after.account.principal).toBe('Example Owner');
    expect(after.pendingReceipts.join(' ')).not.toMatch(/licence record/i);
    expect(after.readiness).toBe('unverified');
  });
  it('keeps private evidence references separate from shipped public evidence', () => {
    const refs = roster().entries.flatMap(entry => [
      ...entry.rights.evidenceRefs, ...entry.operations.flatMap(item => item.evidenceRefs),
      ...(entry.lastVerifiedUse ? [entry.lastVerifiedUse.evidenceRef] : []),
      ...(entry.siteEvaluation ? [...entry.siteEvaluation.existingMcp.evidenceRefs, ...entry.siteEvaluation.toolSchema.evidenceRefs, ...entry.siteEvaluation.terms.evidenceRefs, ...(entry.siteEvaluation.lastProof ? [entry.siteEvaluation.lastProof.evidenceRef] : [])] : []),
    ]);
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of new Set(refs)) {
      expect(existsSync(resolve(repoRoot, ref)), ref).toBe(!ref.startsWith('docs/plans/') && ref !== 'docs/proofs/2026-10-01-21st-source-fidelity.md');
    }
  });
  it('reports the live daemon MCP binding without exposing server configuration', () => {
    const value = roster([
      { id: 'shadcn-ui', templateId: 'shadcn-ui', enabled: true, command: 'npx', args: ['secret-arg'] },
      { id: 'my-refero', url: 'https://api.refero.design/mcp', enabled: false, headers: { authorization: 'Bearer abc' } },
    ]);
    expect(byId(value, 'shadcn').daemonBinding).toBe('enabled');
    expect(byId(value, 'refero').daemonBinding).toBe('disabled');
    expect(byId(value, 'mobbin').daemonBinding).toBe('not-configured');
    expect(byId(value, 'gsap').daemonBinding).toBe('not-applicable');
    expect(JSON.stringify(value)).not.toMatch(/secret-arg|Bearer abc|api\.refero\.design\/mcp/);
  });
  it('matches daemon MCP bindings narrowly: a generic shadcn server is not Canvas UI or Aceternity; a React Bits registry on it is React Bits', () => {
    const generic = roster([{ id: 'shadcn-ui', templateId: 'shadcn-ui', enabled: true, command: 'npx', args: ['-y', '@jpisnice/shadcn-ui-mcp-server'] }]);
    expect(byId(generic, 'shadcn').daemonBinding).toBe('enabled');
    expect(byId(generic, 'canvas-ui').daemonBinding).toBe('not-configured');
    expect(byId(generic, 'aceternity').daemonBinding).toBe('not-configured');
    expect(byId(generic, 'react-bits').daemonBinding).toBe('not-configured');
    const registry = roster([{ id: 'shadcn', enabled: true, command: 'npx', args: ['shadcn@latest', 'mcp', '--registry', '@reactbits-pro'] }]);
    expect(byId(registry, 'react-bits').daemonBinding).toBe('enabled');
  });
  it('names the per-operation notices gap and the deliberate exclusions instead of implying completeness', () => {
    const value = roster();
    expect(value.knownGaps.join(' ')).toMatch(/notices/i);
    expect(value.exclusions.map(item => item.name)).toEqual(expect.arrayContaining(['Material UI', 'cnblocks']));
    for (const item of value.exclusions) expect(item.reason.length).toBeGreaterThan(0);
    expect(value.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('says no Mishh Mashh product retrieval has run for React Bits, distinct from earlier agent-run fetches', () => {
    expect(byId(roster(), 'react-bits').availability.reason).toMatch(/no Mishh Mashh product retrieval/i);
  });
  it('digests the curated rows so a client can tell when the roster changed', () => {
    expect(roster().rosterDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(roster([{ id: 'shadcn-ui', templateId: 'shadcn-ui', enabled: true }]).rosterDigest).toBe(roster().rosterDigest);
  });
});

describe('AC-R12.1 every user-named website has a recorded decision', () => {
  it('omits no named site from the roster or the connector inventory', () => {
    const value = roster();
    for (const id of NAMED_SITES) expect(byId(value, id).siteEvaluation, id).not.toBeNull();
    const inventory = parseConnectorInventory(buildConnectorInventory(value));
    expect(inventory.sites.map(site => site.entryId).sort()).toEqual([...new Set([...NAMED_SITES, ...value.entries.filter(entry => entry.siteEvaluation).map(entry => entry.id)])].sort());
  });
  it('records the existing-MCP result, schema evidence, terms, auth, cost, operations and decision for each', () => {
    for (const id of NAMED_SITES) {
      const entry = byId(roster(), id);
      const site = entry.siteEvaluation!;
      expect(['official-mcp', 'generic-registry-mcp', 'no-mcp'], id).toContain(site.existingMcp.result);
      expect(site.toolSchema.summary.length, id).toBeGreaterThan(0);
      expect(site.terms.summary.length && site.auth.summary.length && site.cost.summary.length, id).toBeTruthy();
      expect(['use-existing', 'build-small-adapter', 'reference-only', 'unsupported'], id).toContain(site.decision);
      expect(entry.operations.length, id).toBeGreaterThan(0);
    }
  });
  it('keeps the documented decisions: Figma unsupported (Q6 A), AI SDK Agents and Adobe Fonts reference-only, the rest reuse existing routes', () => {
    const decisions = Object.fromEntries(NAMED_SITES.map(id => [id, byId(roster(), id).siteEvaluation!.decision]));
    expect(decisions).toMatchObject({ figma: 'unsupported', 'ai-sdk-agents': 'reference-only', 'adobe-fonts': 'reference-only', 'design-system-checklist': 'reference-only', 'react-bits': 'use-existing', refero: 'use-existing', mobbin: 'use-existing' });
    expect(Object.values(decisions)).not.toContain('build-small-adapter');
  });
  it('claims no operation proof for a named site without a cited receipt', () => {
    for (const id of NAMED_SITES) {
      for (const operation of byId(roster(), id).operations) {
        if (operation.status === 'verified') expect(operation.evidenceRefs.length, `${id}:${operation.operation}`).toBeGreaterThan(0);
      }
    }
  });
});
