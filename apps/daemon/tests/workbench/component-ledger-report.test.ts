import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseComponentLedger } from '@mish/contracts';
import { readComponentLedger, collectComponentInventory, collectReact95ComponentRows } from '../../src/workbench/component-ledger.js';
import { buildComponentLedgerReport } from '../../src/workbench/component-ledger-report.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { REACT95_KIT } from '../../src/workbench/kits/react95/kit.generated.js';
import { packManifestDigest } from '../../src/packs/manifest.js';
import { createPackService } from '../../src/packs/service.js';
import { writeFixturePack } from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const core = () => readComponentLedger()!;
/** A shipped GenUI row labelled licensed solely to exercise overlay conflict semantics. */
const licensedCore = () => {
  const ledger = core();
  const row = ledger.rows.find(row => row.sourceId === 'genui' && row.built)!;
  return parseComponentLedger({ ...ledger, rows: ledger.rows.map(item => item.id === row.id ? { ...item, rights: { ...item.rights, implementationOrigin: 'licensed' } } : item) });
};

describe('R13.1 generated per-ID report', () => {
  it('includes shipped React95 components and GSAP recipe variants in the authoritative inventory', () => {
    const ids = collectComponentInventory().items.map(row => row.id);
    expect(ids).toContain('react95:component-window');
    expect(ids).toContain('react95:template-window-app');
    expect(ids).toContain('gsap:section-entrance-html');
    expect(ids).toContain('gsap:section-entrance-react');
  });

  it('invalidates React95 versions when emitted text changes without a metadata SHA update', () => {
    const changed = structuredClone(REACT95_KIT);
    changed.templates[0]!.text += '\n// modified template';
    const before = collectReact95ComponentRows();
    const after = collectReact95ComponentRows(changed);
    const id = `react95:template-${changed.templates[0]!.id}`;
    expect(after.find(row => row.id === id)!.sourceVersion.digest).not.toBe(before.find(row => row.id === id)!.sourceVersion.digest);
  });

  it('keys every core row by ID and keeps licensed, built, and verified independent', () => {
    const ledger = core();
    const report = buildComponentLedgerReport(ledger);
    expect(Object.keys(report.components).sort()).toEqual(ledger.rows.map(row => row.id).sort());
    expect(report.components['genui:atc-shader']).toMatchObject({ source: 'public-core', built: true, tracked: true, installed: null, verified: false, evidenceDate: null });
    expect(ledger.rows.filter(row => row.rights.implementationOrigin === 'licensed')).toEqual([]);
    const licensed = licensedCore().rows.find(row => row.rights.implementationOrigin === 'licensed')!;
    expect(buildComponentLedgerReport(licensedCore()).components[licensed.id]).toMatchObject({ licensed: true, verified: false });
    expect(report.components['shadcn:button']?.built).toBe(false);
  });

  it('only dated evidence bound to current bytes establishes verification', () => {
    const ledger = core();
    const row = ledger.rows.find(row => row.disposition === 'repair-pending' && row.sourceVersion.digest)!;
    const withEvidence = (recordedAt?: string) => parseComponentLedger({ ...ledger, rows: ledger.rows.map(item => item.id === row.id ? {
      ...item, disposition: 'repaired', evidence: [{ kind: 'state-matrix', ref: 'r13/run', sourceDigest: item.sourceVersion.digest, ...(recordedAt ? { recordedAt } : {}) }],
    } : item) });
    expect(buildComponentLedgerReport(withEvidence()).components[row.id]?.verified).toBe(false);
    expect(buildComponentLedgerReport(withEvidence('2026-10-09T12:00:00.000Z')).components[row.id]).toMatchObject({ verified: true, evidenceDate: '2026-10-09T12:00:00.000Z' });
  });

  it('adds actual installed kit component IDs, detects drift, and removes them when uninstalled', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'r13-ledger-'));
    cleanup.push(data);
    const fixture = writeFixturePack();
    cleanup.push(fixture.dir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    const service = createPackService({ registry });
    await service.install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    const report = buildComponentLedgerReport(core(), registry);
    const items = Object.values(report.components).filter(row => row.source === 'pack');
    expect(items.length).toBeGreaterThan(1);
    for (const row of items) expect(row).toMatchObject({ installed: true, licensed: true, rights: { license: 'licensed (pack-declared)' }, built: true, verified: false, evidenceDate: null });
    await service.remove(fixture.manifest.id);
    expect(Object.values(buildComponentLedgerReport(core(), registry).components).some(row => row.source === 'pack')).toBe(false);
  });

  it('enumerates catalog-only packs and checks overlay implementation bytes without claiming verification', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'r13-overlay-'));
    cleanup.push(data);
    const fixture = writeFixturePack({
      files: [
        { path: 'overlay/catalog.json', content: JSON.stringify({ components: [{ id: 'new-licensed', name: 'Licensed item', status: 'ported', entry: 'item.js' }] }) },
        { path: 'overlay/item.js', content: 'export function mount() {}' },
        { path: 'cult/catalog.json', content: JSON.stringify({ rows: [{ id: 'cult:catalog-only', title: 'Catalog only', source: { files: [{ path: 'absent.tsx' }] } }] }) },
      ],
      contents: [{ kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'overlay/catalog.json' }, { kind: 'cult-catalog', schema: 'od-cult-pack/1', id: 'test-catalog', snapshotId: 'synthetic-1', path: 'cult/catalog.json' }],
    });
    cleanup.push(fixture.dir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    await createPackService({ registry }).install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    const report = buildComponentLedgerReport(core(), registry);
    expect(report.components['cult:catalog-only']).toMatchObject({ source: 'pack', installed: true, built: false, verified: false });
    expect(report.components['genui:new-licensed']).toMatchObject({ installed: true, built: true, verified: false });
    writeFileSync(path.join(registry.packsDir, fixture.manifest.id, 'overlay/item.js'), 'changed bytes');
    expect(buildComponentLedgerReport(core(), registry).components['genui:new-licensed']).toMatchObject({ built: false, verified: false });
  });

  it('rejects conflicting component IDs instead of overwriting core inventory', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'r13-duplicate-'));
    cleanup.push(data);
    const fixture = writeFixturePack({
      files: [{ path: 'overlay/catalog.json', content: JSON.stringify({ components: [{ id: 'atc-shader', name: 'Conflict' }] }) }],
      contents: [{ kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'overlay' }],
    });
    cleanup.push(fixture.dir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    await createPackService({ registry }).install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    const report = buildComponentLedgerReport(core(), registry);
    expect(report.components['genui:atc-shader']?.errors).toContainEqual({ code: 'duplicate-id', packId: fixture.manifest.id });
    expect(report.components['shadcn:button']).toBeDefined();
  });

  it('rejects different bytes even when the colliding core ID is licensed', async () => {
    const ledger = licensedCore();
    const licensed = ledger.rows.find(row => row.rights.implementationOrigin === 'licensed')!;
    const data = mkdtempSync(path.join(tmpdir(), 'r13-licensed-duplicate-'));
    cleanup.push(data);
    const fixture = writeFixturePack({
      files: [{ path: 'overlay/catalog.json', content: JSON.stringify({ components: [{ id: licensed.itemId, name: 'Different licensed implementation' }] }) }],
      contents: [{ kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'overlay' }],
    });
    cleanup.push(fixture.dir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    await createPackService({ registry }).install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    expect(buildComponentLedgerReport(ledger, registry).components[licensed.id]?.errors).toContainEqual({ code: 'duplicate-id', packId: fixture.manifest.id });
  });
});

describe('R13.1 identical licensed overlay digest', () => {
  it('uses the same digest shape for core and overlay, including optional files', async () => {
    const ledger = licensedCore();
    const licensed = ledger.rows.find(row => row.sourceId === 'genui' && row.rights.implementationOrigin === 'licensed' && row.built)!;
    const root = path.resolve(import.meta.dirname, '../../../..');
    const catalog = JSON.parse(readFileSync(path.join(root, 'packages/genui-catalog/catalog.json'), 'utf8'));
    const entry = catalog.components.find((item: { id: string }) => item.id === licensed.itemId);
    const fixture = writeFixturePack({
      files: [
        { path: 'overlay/catalog.json', content: JSON.stringify({ components: [entry] }) },
        ...[entry.entry, entry.css, entry.demo].filter(Boolean).map((file: string) => ({ path: `overlay/${file}`, content: readFileSync(path.join(root, 'packages/genui-catalog', file), 'utf8') })),
      ],
      contents: [{ kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'overlay/catalog.json' }],
    });
    const data = mkdtempSync(path.join(tmpdir(), 'r13-identical-'));
    cleanup.push(data, fixture.dir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    await createPackService({ registry }).install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    const row = buildComponentLedgerReport(ledger, registry).components[licensed.id]!;
    expect(row).toMatchObject({ source: 'pack', built: true, installed: true, errors: [], verified: false, rights: { license: 'licensed (pack-declared)' } });
    expect(row.sourceVersion.digest).toBe(licensed.sourceVersion.digest);
  });
});
