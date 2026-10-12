// AC-R13.1 (docs/plans/2026-10-02-design-workbench/prd.md): P1 freezes an authoritative
// inventory across every exposed executable component source, assigns original reference,
// expected state set, dependencies, source version, rights and repair owner to every ID,
// and later additions enter the same gate. Owner scope (2026-10-08): MIT/permissive
// public-core items ship preloaded and are rows here; licensed pack items count once installed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESOURCE_SOURCE_IDS, parseComponentLedger, summarizeComponentLedger, type ComponentLedger } from '@mish/contracts';
import { checkComponentLedger, collectComponentInventory, refreshComponentLedger, validateComponentLedgerCitations } from '../../src/workbench/component-ledger.js';

const repo = path.resolve(import.meta.dirname, '../../../..');
const readJson = <T>(relative: string): T => JSON.parse(readFileSync(path.join(repo, relative), 'utf8')) as T;
const REMOVED_FAMILIES = new Set(['emmpo', 'watson', 'maben', 'halcyon', 'maren', 'wrenfield', 'fervor', 'velar']);
const committed = (): ComponentLedger => parseComponentLedger(readJson('apps/daemon/src/workbench/component-ledger.json'));

type Section = { id: string; sourceKind: string; content: { kind: string; blockId?: string; sha256?: string } };
const sections = readJson<{ entries: Section[] }>('packages/section-catalog/catalog.json').entries;
const genui = readJson<{ components: Array<{ id: string; status: string; licenceDecision: string }> }>('packages/genui-catalog/catalog.json').components;
const twentyFirst = readJson<{ rows: Array<{ id: string }> }>('packages/21st-catalog/generated/21st-items.json').rows;
const cultRows = readJson<{ rows: Array<{ id: string }> }>('packages/cult-ui-catalog/catalog.json').rows;

describe('AC-R13.1 frozen component ledger', () => {
  it('the committed ledger passes the gate against what this checkout exposes', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    expect(checkComponentLedger(ledger, inventory)).toEqual([]);
    // Regenerating from the same exposure is a no-op: no derived field has drifted.
    expect(refreshComponentLedger(ledger, inventory, ledger.frozenAt)).toEqual(ledger);
  });

  it('has exactly one row for every exposed public-core executable ID', () => {
    const ids = committed().rows.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = [
      ...genui.map(entry => `genui:${entry.id}`),
      ...sections.filter(entry => entry.sourceKind === 'hyperui' || (entry.sourceKind === 'family-section' && !REMOVED_FAMILIES.has(entry.id.split(':')[1]!))).map(entry => `sections:${entry.id}`),
      ...twentyFirst.map(row => `21st-dev:${row.id}`),
      'shadcn:button',
      ...collectComponentInventory().items.filter(item => item.sourceId === 'react95' || item.sourceId === 'gsap').map(item => item.id),
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
    // The public catalogue excludes the six licensed GenUI ports.
    expect(genui).toHaveLength(71);
    expect(sections.filter(entry => entry.sourceKind === 'hyperui')).toHaveLength(80);
  });

  it('omits removed private study families from the shipped inventory', () => {
    const inventory = collectComponentInventory();
    const removed = sections.filter(entry => entry.sourceKind === 'family-section' && REMOVED_FAMILIES.has(entry.id.split(':')[1]!));
    expect(removed.length).toBeGreaterThan(0);
    for (const entry of removed) expect(inventory.items.map(item => item.id)).not.toContain(`sections:${entry.id}`);
    expect(inventory.items).toContainEqual(expect.objectContaining({ id: 'sections:hyperui:application/charts/1', built: true }));
  });

  it('assigns reference, states, dependencies, version, rights and owner to every row', () => {
    for (const row of committed().rows) {
      expect(row.originalReference.url ?? row.originalReference.note, row.id).toBeTruthy();
      expect(row.expectedStates.states, row.id).toContain('default');
      expect(row.expectedStates.primaryAction, row.id).toBeTruthy();
      expect(Array.isArray(row.dependencies), row.id).toBe(true);
      expect(row.sourceVersion.revision, row.id).toBeTruthy();
      expect(row.rights.license && row.rights.evidence, row.id).toBeTruthy();
      expect(row.repairOwner, row.id).toBeTruthy();
    }
  });

  it('starts every executable row unrepaired: nothing is claimed repaired at freeze', () => {
    const summary = summarizeComponentLedger(committed());
    expect(summary.repaired).toBe(0);
    expect(summary.closable).toBe(false);
  });

  it('quarantines the unported GenUI entry with its reason instead of dropping it', () => {
    const cut = genui.filter(entry => entry.status !== 'ported');
    expect(cut.length).toBeGreaterThan(0);
    for (const entry of cut) {
      const row = committed().rows.find(candidate => candidate.id === `genui:${entry.id}`)!;
      expect(row.disposition).toBe('quarantined');
      expect(row.dispositionReason).toBeTruthy();
    }
  });

  it('records same-family reconstructions as reference-only, never as repair-pending executables', () => {
    for (const row of committed().rows.filter(candidate => candidate.itemId.startsWith('family-section:'))) {
      expect(row.disposition).toBe('reference-only');
      expect(row.dispositionReason).toBeTruthy();
    }
  });

  it('counts licensed pack cohorts at source level, with no public-core rows', () => {
    const ledger = committed();
    const cultSections = ledger.cohorts.find(cohort => cohort.id === 'sections/cult-pro');
    const cult = ledger.cohorts.find(cohort => cohort.id === 'cult/cult-ui-pro');
    expect(cultSections).toMatchObject({ scope: 'licensed-pack', itemCount: sections.filter(entry => entry.sourceKind === 'cult-pro').length });
    expect(cult).toMatchObject({ scope: 'licensed-pack', itemCount: cultRows.length });
    expect(ledger.rows.some(row => row.itemId.startsWith('cult:') || row.sourceId === 'cult')).toBe(false);
  });

  it('declares a scope for every roster source, and every federated adapter is in scope', () => {
    const ledger = committed();
    expect(new Set(ledger.cohorts.map(cohort => cohort.sourceId))).toEqual(new Set(RESOURCE_SOURCE_IDS));
    for (const sourceId of ['plugins', 'genui', 'sections', 'design-systems', 'shadcn', '21st-dev', 'cult'] as const) {
      const scopes = ledger.cohorts.filter(cohort => cohort.sourceId === sourceId).map(cohort => cohort.scope);
      expect(scopes, sourceId).not.toContain('not-exposed');
    }
  });

  it('versions HyperUI rows by the actual vendored block bytes, not the upstream HEAD', () => {
    const manifest = readJson<{ blocks: Array<{ id: string; file: string }> }>('plugins/_official/shared/ui-kits/hyperui/manifest.json');
    for (const entry of sections.filter(candidate => candidate.sourceKind === 'hyperui')) {
      const block = manifest.blocks.find(candidate => candidate.id === entry.content.blockId)!;
      const bytes = readFileSync(path.join(repo, 'plugins/_official/shared/ui-kits/hyperui', block.file));
      const actual = createHash('sha256').update(bytes).digest('hex');
      const row = committed().rows.find(candidate => candidate.id === `sections:${entry.id}`)!;
      expect(row.sourceVersion, entry.id).toMatchObject({ digest: actual, pinned: true });
      expect(row.originalReference.upstreamRevision).toMatch(/^markmead\/hyperui@[a-f0-9]{40}$/);
    }
  });

  it('puts GenUI shader ports in the WebGL family from their actual source', () => {
    const shader = readFileSync(path.join(repo, 'packages/genui-catalog/components/atc-shader/index.ts'), 'utf8');
    expect(shader).toMatch(/getContext\(['"]webgl/);
    const row = committed().rows.find(candidate => candidate.id === 'genui:atc-shader')!;
    expect(row.family).toBe('genui-webgl');
    expect(row.expectedStates.states).toContain('no-webgl-fallback');
  });
});

describe('AC-R13.1 later additions enter the same gate', () => {
  it('reports a newly exposed ID that has no ledger row', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    const extra = { ...inventory.items.find(item => item.sourceId === 'genui')!, id: 'genui:new-item', itemId: 'new-item' };
    const findings = checkComponentLedger(ledger, { ...inventory, items: [...inventory.items, extra] });
    expect(findings).toContainEqual({ kind: 'missing-row', id: 'genui:new-item' });
  });

  it('reports a row whose item is no longer exposed', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    const findings = checkComponentLedger(ledger, { ...inventory, items: inventory.items.slice(1) });
    expect(findings).toContainEqual({ kind: 'orphan-row', id: inventory.items[0]!.id });
  });

  it('reports a row whose source bytes changed since the freeze', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    const [first, ...rest] = inventory.items;
    const changed = { ...first!, sourceVersion: { ...first!.sourceVersion, digest: 'f'.repeat(64), pinned: true } };
    expect(checkComponentLedger(ledger, { ...inventory, items: [changed, ...rest] })).toContainEqual({ kind: 'stale-version', id: first!.id });
  });

  it('reports a cohort whose count or listing changed', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    const cohorts = inventory.cohorts.map(cohort => cohort.id === 'cult/cult-ui-pro' ? { ...cohort, itemCount: (cohort.itemCount ?? 0) + 1 } : cohort);
    expect(checkComponentLedger(ledger, { ...inventory, cohorts })).toContainEqual({ kind: 'cohort-drift', id: 'cult/cult-ui-pro' });
  });

  it('refresh keeps curated fields, admits a new ID as repair-pending, and re-opens a repaired row whose bytes changed', () => {
    const ledger = committed();
    const inventory = collectComponentInventory();
    const [first, second] = ledger.rows.filter(row => row.disposition === 'repair-pending' && row.sourceVersion.pinned);
    const curated: ComponentLedger = parseComponentLedger({
      ...ledger,
      rows: ledger.rows.map(row => row.id === first!.id
        ? { ...row, repairOwner: 'C1-wave-2', expectedStates: { ...row.expectedStates, states: [...row.expectedStates.states, 'error'] } }
        : row.id === second!.id
          ? { ...row, disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'r13-run-1', sourceDigest: row.sourceVersion.digest! }] }
          : row),
    });
    const extra = { ...inventory.items.find(item => item.sourceId === 'genui')!, id: 'genui:new-item', itemId: 'new-item' };
    const items = inventory.items.map(item => item.id === second!.id ? { ...item, sourceVersion: { ...item.sourceVersion, digest: 'e'.repeat(64) } } : item);
    const refreshed = refreshComponentLedger(curated, { ...inventory, items: [...items, extra] }, '2026-10-09T00:00:00.000Z');
    const kept = refreshed.rows.find(row => row.id === first!.id)!;
    expect(kept.repairOwner).toBe('C1-wave-2');
    expect(kept.expectedStates.states).toContain('error');
    const reopened = refreshed.rows.find(row => row.id === second!.id)!;
    expect(reopened).toMatchObject({ disposition: 'repair-pending', evidence: [] });
    expect(reopened.sourceVersion.digest).toBe('e'.repeat(64));
    expect(refreshed.rows.find(row => row.id === 'genui:new-item')).toMatchObject({ disposition: 'repair-pending', repairOwner: 'C1' });
    expect(checkComponentLedger(refreshed, { ...inventory, items: [...items, extra] })).toEqual([]);
  });
});

// Round 2: provenance citations are real repository files, not materialized export paths.
describe('R13.1 rights citation gate', () => {
  it('checks every generated citation and fails if a cited file is missing', () => {
    const inventory = collectComponentInventory();
    expect(() => validateComponentLedgerCitations(repo, inventory.items)).not.toThrow();
    const row = inventory.items[0]!;
    expect(() => validateComponentLedgerCitations(repo, [{ ...row, rights: { ...row.rights, evidence: 'packages/absent/NOTICE.txt' } }])).toThrow('Missing cited file');
  });
  it('cites the actual embedded provenance for all 22 owned 21st alternatives', () => {
    const rows = committed().rows.filter(row => row.sourceId === '21st-dev');
    expect(rows).toHaveLength(22);
    for (const row of rows) expect(row.rights.evidence).toContain('packages/21st-catalog/generated/21st-originals.json');
  });
  it('root NOTICE acknowledges shipped React95 code, font terms and GSAP custom terms', () => {
    const notice = readFileSync(path.join(repo, 'NOTICE'), 'utf8');
    for (const claim of ['React95', 'Artur Bień', 'CC-BY-SA-3.0', 'GSAP', 'GreenSock', 'standard-license']) expect(notice).toContain(claim);
  });
});
