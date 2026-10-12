import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCatalog, buildCatalogWithReport, canonicalizeCatalog, catalogPath, checkInsertableIdsExist, checkOverrideEntryKeys,
  checkOverridesMatchEntries, CULT_TITLE_BRANDS, cultDisplayTitle, unreviewedTitleWords, isCatalogStale, packageRoot, projectCultEntries,
  serialiseCatalog, type CultCatalogFile,
} from '../scripts/build-catalog.ts';
import { sectionCatalogIssues, sectionCatalogPolicyIssues, validateSectionCatalog } from '../src/validate.ts';
import { INSERTABLE_V1 } from '../src/types.ts';
import taxonomy from '../../agency-fast-lane/src/taxonomy/design-taxonomy.json' with { type: 'json' };
import familyRegistry from '../../agency-fast-lane/src/atlas/family-registry.json' with { type: 'json' };
import hyperuiManifest from '../../../plugins/_official/shared/ui-kits/hyperui/manifest.json' with { type: 'json' };
import cultCatalogJson from '../../cult-ui-catalog/catalog.json' with { type: 'json' };

const cultCatalog = cultCatalogJson as unknown as CultCatalogFile;

describe('buildCatalog', () => {
  it('builds a catalog that validates clean, with no issues', () => {
    const catalog = buildCatalog();
    expect(sectionCatalogIssues(catalog)).toEqual([]);
  });

  it('matches the committed catalog.json exactly (fails the way --check does when stale)', () => {
    const committed = readFileSync(catalogPath, 'utf8');
    expect(committed).toBe(serialiseCatalog(buildCatalog()));
  });

  it('has exactly one entry per HyperUI block (80) and marks only the three v1 blocks insertable', () => {
    const catalog = buildCatalog();
    const hyperui = catalog.entries.filter((entry) => entry.sourceKind === 'hyperui');
    expect(hyperui).toHaveLength(80);
    const insertable = hyperui.filter((entry) => entry.availability === 'insertable');
    // Pinned to the literal count, not just "matches INSERTABLE_V1" — a future INSERTABLE_V1 edit
    // that accidentally drops to an empty (or padded) list would otherwise still make this
    // assertion self-consistent (delta audit #1).
    expect(INSERTABLE_V1.length).toBe(3);
    expect(insertable.length).toBe(3);
    expect(insertable.map((entry) => (entry.content as { blockId: string }).blockId).sort()).toEqual([...INSERTABLE_V1].sort());
    for (const entry of hyperui) {
      if (entry.availability !== 'insertable') expect(entry.availability).toBe('adapter-needed');
    }
  });

  it('checkInsertableIdsExist throws on an INSERTABLE_V1 id the pinned manifest does not vendor', () => {
    // Against the real manifest: a fabricated id alongside two real ones must still throw, naming
    // the unknown id — not silently drop it and let insertable shrink to whatever matched (BLOCK #1).
    expect(() => checkInsertableIdsExist(['marketing/sections/1', 'marketing/does-not-exist/999'], hyperuiManifest))
      .toThrow('INSERTABLE_V1: "marketing/does-not-exist/999" does not resolve to any block in the pinned HyperUI manifest');
  });

  it('checkInsertableIdsExist passes for the real INSERTABLE_V1 against the real manifest', () => {
    expect(() => checkInsertableIdsExist(INSERTABLE_V1, hyperuiManifest)).not.toThrow();
  });

  it('has one entry per family section, all sourceKind family-section / reference-only / same-family-only', () => {
    const catalog = buildCatalog();
    const familySections = catalog.entries.filter((entry) => entry.sourceKind === 'family-section');
    expect(familySections.length).toBeGreaterThan(0);
    for (const entry of familySections) {
      expect(entry.availability).toBe('reference-only');
      expect(entry.rights.decision).toBe('same-family-only');
      expect(entry.rights.license).toBe('project-specific');
      expect(entry.content.kind).toBe('family-section');
    }
    // Every one of the 13 registered families contributed at least one section.
    const families = new Set(familySections.map((entry) => (entry.content as { family: string }).family));
    expect(families.size).toBe(familyRegistry.families.length);
  });

  it('never emits a motionsites-prompt entry (those are federated at request time, not built here)', () => {
    const catalog = buildCatalog();
    expect(catalog.entries.some((entry) => entry.sourceKind === 'motionsites-prompt')).toBe(false);
  });

  it('emits ids that are unique and follow the sourceKind:… convention', () => {
    const catalog = buildCatalog();
    const ids = catalog.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A cult-pro entry keeps the canonical inventory's own `cult:<name>` id, so the id a built page
    // records (data-od-selected-section) is the same id the Cult inventory and rights record use.
    const prefix = (sourceKind: string): string => (sourceKind === 'cult-pro' ? 'cult:' : `${sourceKind}:`);
    for (const entry of catalog.entries) {
      expect(entry.id.startsWith(prefix(entry.sourceKind))).toBe(true);
    }
  });

  it('every sectionKind that is not page-composition/unclassified is a real design-taxonomy section id', () => {
    const taxonomyIds = new Set((taxonomy as { sections: Array<{ id: string }> }).sections.map((section) => section.id));
    const catalog = buildCatalog();
    for (const entry of catalog.entries) {
      if (entry.sectionKind === 'page-composition' || entry.sectionKind === 'unclassified') continue;
      expect(taxonomyIds.has(entry.sectionKind)).toBe(true);
    }
  });

  it('rejects an override that does not match any generated entry id', async () => {
    // buildCatalog() reads data/overrides.json from disk; this test also asserts the real
    // committed file's *shape* by re-running the policy/id logic the script uses.
    const overridesPath = path.join(packageRoot, 'data/overrides.json');
    const raw = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>;
    const catalog = buildCatalog();
    const ids = new Set(catalog.entries.map((entry) => entry.id));
    for (const key of Object.keys(raw)) {
      if (key === '_comment') continue;
      expect(ids.has(key)).toBe(true);
    }
  });

  it('checkOverridesMatchEntries throws on a synthetic override id that matches no generated entry (the guard itself, not a re-implementation of it)', () => {
    const usedOverrides = new Set<string>(); // as if no override in {bogus-key} was ever consumed while building entries
    expect(() => checkOverridesMatchEntries({ 'family-section:not-a-real-family:nope': {} }, usedOverrides))
      .toThrow('data/overrides.json: "family-section:not-a-real-family:nope" does not match any generated entry');
  });

  it('checkOverridesMatchEntries passes when every override id was consumed', () => {
    const usedOverrides = new Set(['family-section:emmpo:emmpo-career']);
    expect(() => checkOverridesMatchEntries({ 'family-section:emmpo:emmpo-career': { sectionKind: 'cta-band' } }, usedOverrides))
      .not.toThrow();
  });

  it('checkOverrideEntryKeys throws on a typo\'d key instead of silently dropping it', () => {
    expect(() => checkOverrideEntryKeys('family-section:emmpo:emmpo-career', { sectionkind: 'cta-band' }))
      .toThrow('data/overrides.json: "family-section:emmpo:emmpo-career" has unknown key "sectionkind"');
  });

  it('checkOverrideEntryKeys accepts sectionKind, spineAffinities, and _why', () => {
    expect(() => checkOverrideEntryKeys('x', { sectionKind: 'cta-band', spineAffinities: 'any', _why: 'because' })).not.toThrow();
  });
});

describe('Cult UI Pro projection', () => {
  const { catalog, cultSkipped } = buildCatalogWithReport();
  const cultEntries = catalog.entries.filter((entry) => entry.sourceKind === 'cult-pro');
  const sectionOrPageRows = cultCatalog.rows.filter((row) => row.assetKind === 'section' || row.assetKind === 'page');

  it('projects every Cult section/page row exactly once, except the counted skips', () => {
    const skippedIds = Object.values(cultSkipped).flat();
    expect(cultEntries.length + skippedIds.length).toBe(sectionOrPageRows.length);
    const projected = new Set(cultEntries.map((entry) => entry.id));
    for (const row of sectionOrPageRows) expect(projected.has(row.id) !== skippedIds.includes(row.id)).toBe(true);
  });

  it('skips only section rows the inventory left unclassified, and never a primitive or app row', () => {
    const rowsById = new Map(cultCatalog.rows.map((row) => [row.id, row]));
    for (const id of Object.values(cultSkipped).flat()) {
      expect(rowsById.get(id)?.assetKind).toBe('section');
      expect(rowsById.get(id)?.taxonomy.sectionKind).toBe('unclassified');
    }
    for (const entry of cultEntries) expect(['section', 'page']).toContain(rowsById.get(entry.id)?.assetKind);
    expect(cultEntries.some((entry) => entry.sectionKind === 'unclassified')).toBe(false);
  });

  it('maps section rows to their taxonomy id and page rows to page-composition', () => {
    const rowsById = new Map(cultCatalog.rows.map((row) => [row.id, row]));
    for (const entry of cultEntries) {
      const row = rowsById.get(entry.id)!;
      expect(entry.sectionKind).toBe(row.assetKind === 'page' ? 'page-composition' : row.taxonomy.sectionKind);
      expect(entry.sourceType).toBe(row.original.category);
      expect(entry.spineAffinities).toEqual(row.spineAffinities.length > 0 ? row.spineAffinities : 'unclassified');
    }
  });

  it('labels every Cult entry licensed, with provenance to the pinned snapshot, and insertable only with its checked adapter', () => {
    expect(cultEntries.length).toBeGreaterThan(0);
    const rowsById = new Map(cultCatalog.rows.map((row) => [row.id, row]));
    for (const entry of cultEntries) {
      const row = rowsById.get(entry.id)!;
      const insertable = row.conversion.status === 'insertable';
      expect(entry.availability).toBe(insertable ? 'insertable' : 'adapter-needed');
      if (entry.content.kind === 'cult-item') expect(entry.content.adapterId).toBe(insertable ? entry.id : undefined);
      if (insertable) {
        expect(row.adapter?.id).toBe(entry.id);
        expect(existsSync(new URL(`../../cult-ui-catalog/generated/adapters/${row.name}.ts`, import.meta.url))).toBe(true);
      }
      expect(entry.access).toBe('local');
      expect(entry.preview).toEqual({ kind: 'none' });
      expect(entry.rights).toEqual({ license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' });
      expect(entry.content.kind).toBe('cult-item');
      if (entry.content.kind !== 'cult-item') continue;
      expect(entry.content.provenance).toEqual({ cultId: entry.id, snapshotId: cultCatalog.snapshot.id });
      expect(entry.content.summary.length).toBeGreaterThan(0);
    }
  });

  it('keeps INSERTABLE_V1 the three HyperUI blocks and adds only checked Cult adapters', () => {
    const insertable = catalog.entries.filter((entry) => entry.availability === 'insertable');
    expect(insertable.filter((entry) => entry.sourceKind === 'hyperui').map((entry) => entry.id).sort())
      .toEqual(INSERTABLE_V1.map((id) => `hyperui:${id}`).sort());
    const cult = insertable.filter((entry) => entry.sourceKind === 'cult-pro');
    expect(insertable.length).toBe(INSERTABLE_V1.length + cult.length);
    expect(cult.length).toBeGreaterThanOrEqual(3);
    expect(cult.map((entry) => entry.id)).toContain('cult:marketing-cta-cosmic');
    for (const entry of cult) expect(entry.sectionKind).not.toBe('page-composition');
  });

  it('projectCultEntries makes a row insertable only when its adapter id is the row id and its adapter file exists', () => {
    const base = cultCatalog.rows.find((row) => row.id === 'cult:marketing-cta-cosmic')!;
    const project = (rows: CultCatalogFile['rows']) => projectCultEntries({ schema: 'cult-ui-catalog/1', snapshot: cultCatalog.snapshot, rows });
    const [entry] = project([base]).entries;
    expect(entry?.availability).toBe('insertable');
    expect(() => project([{ ...base, adapter: { id: 'cult:other', version: '1.0.0' } }])).toThrow('is not the row id');
    expect(() => project([{ ...base, id: 'cult:no-such-block', name: 'no-such-block', adapter: { id: 'cult:no-such-block', version: '1.0.0' } }])).toThrow('is missing');
    const [unconverted] = project([{ ...base, conversion: { status: 'adapter-needed' }, adapter: null }]).entries;
    expect(unconverted?.availability).toBe('adapter-needed');
  });

  it('never names another company in a display title, and keeps the raw title in content.sourceTitle', () => {
    const rowsById = new Map(cultCatalog.rows.map((row) => [row.id, row]));
    for (const entry of cultEntries) {
      for (const [pattern] of CULT_TITLE_BRANDS) expect(entry.title).not.toMatch(pattern);
      if (entry.content.kind === 'cult-item') expect(entry.content.sourceTitle).toBe(rowsById.get(entry.id)!.title);
    }
  });

  it('cultDisplayTitle swaps brand names for a series letter and drops the "Marketing" prefix', () => {
    expect(cultDisplayTitle('Marketing Pricing Vercel')).toBe('Pricing (series V)');
    expect(cultDisplayTitle('Pricing Vercel')).toBe('Pricing (series V)');
    expect(cultDisplayTitle('Marketing CTA — Heerich')).toBe('CTA (series H)');
    expect(cultDisplayTitle('Marketing Features Apple Style')).toBe('Features (series A)');
    expect(cultDisplayTitle('Marketing Features — Scroll Accordion')).toBe('Features Scroll Accordion');
    expect(cultDisplayTitle('Marketing Hero Simple')).toBe('Hero Simple');
    expect(cultDisplayTitle('Shadcn Vite Grid')).toBe('Grid (series S, VT)');
    expect(() => cultDisplayTitle('Vercel')).toThrow('nothing left');
    expect(cultDisplayTitle('Vercel Pricing Vercel')).toBe('Pricing (series V)');
  });

  it('cultDisplayTitle fails closed on a word nobody reviewed, so an unknown brand cannot reach a title', () => {
    expect(() => cultDisplayTitle('Marketing Pricing Linear')).toThrow('unreviewed word(s) linear');
    expect(cultDisplayTitle('Hero (page: SaaS Colorful)')).toBe('Hero (page: SaaS Colorful)');
    for (const entry of cultEntries) expect(unreviewedTitleWords(entry.title, ['A', 'H', 'S', 'V', 'VT'])).toEqual([]);
  });

  it('projects the sections cut from the whole pages, with their own adapters', () => {
    const derived = cultCatalog.rows.filter((row) => row.derivedFrom !== undefined);
    expect(derived.length).toBeGreaterThanOrEqual(14);
    const hero = cultEntries.find((entry) => entry.id === 'cult:sass-colorful--hero');
    expect(hero?.title).toBe('Hero (page: SaaS Colorful)');
    expect(hero?.sectionKind).toBe('hero');
    expect(hero?.availability).toBe('insertable');
    if (hero?.content.kind === 'cult-item') expect(hero.content.adapterId).toBe('cult:sass-colorful--hero');
    for (const row of derived) {
      const entry = cultEntries.find((candidate) => candidate.id === row.id);
      if (row.taxonomy.sectionKind === 'unclassified') expect(entry).toBeUndefined();
      else expect(entry?.availability).toBe(row.conversion.status === 'insertable' ? 'insertable' : 'adapter-needed');
    }
  });

  it('projectCultEntries refuses a row whose rights or adapter reference disagree with the inventory contract', () => {
    const base = cultCatalog.rows.find((row) => row.id === 'cult:marketing-cta-cosmic')!;
    const project = (rows: CultCatalogFile['rows']) => projectCultEntries({ schema: 'cult-ui-catalog/1', snapshot: cultCatalog.snapshot, rows });
    expect(() => project([{ ...base, rights: { ...base.rights, license: 'mit' } }])).toThrow('recorded Cult UI Pro rights');
    expect(() => project([{ ...base, adapter: null }])).toThrow('disagrees with its adapter reference');
    expect(() => project([{ ...base, conversion: { status: 'adapter-needed' } }])).toThrow('disagrees with its adapter reference');
  });

  it('projectCultEntries skips an unclassified section row and ignores primitive/app rows', () => {
    // A row whose adapter is null (adapter-needed): the synthetic rows below rename it without also
    // renaming its adapter reference, so this must not be an insertable row (cultAdapterIdOf's
    // adapter-id-matches-row-id invariant would otherwise throw on the renamed copy).
    const base = cultCatalog.rows.find((row) => row.assetKind === 'section' && row.taxonomy.sectionKind === 'hero' && row.adapter === null)!;
    const synthetic: CultCatalogFile = {
      schema: 'cult-ui-catalog/1',
      snapshot: cultCatalog.snapshot,
      rows: [
        { ...base, id: 'cult:x-hero', name: 'x-hero' },
        { ...base, id: 'cult:x-unknown', name: 'x-unknown', taxonomy: { sectionKind: 'unclassified' } },
        { ...base, id: 'cult:x-button', name: 'x-button', assetKind: 'primitive' },
        { ...base, id: 'cult:x-page', name: 'x-page', assetKind: 'page', taxonomy: { sectionKind: 'unclassified' } },
      ],
    };
    const { entries, skipped } = projectCultEntries(synthetic);
    expect(entries.map((entry) => [entry.id, entry.sectionKind])).toEqual([['cult:x-hero', 'hero'], ['cult:x-page', 'page-composition']]);
    expect(Object.values(skipped).flat()).toEqual(['cult:x-unknown']);
  });

  it('projectCultEntries refuses a row from a different snapshot than the catalog pins', () => {
    const base = cultCatalog.rows.find((row) => row.assetKind === 'section')!;
    const synthetic: CultCatalogFile = {
      schema: 'cult-ui-catalog/1',
      snapshot: cultCatalog.snapshot,
      rows: [{ ...base, source: { snapshotId: 'cult-ui-pro@0000000000000000' } }],
    };
    expect(() => projectCultEntries(synthetic)).toThrow('is not the catalog snapshot');
  });
});

describe('isCatalogStale: canonical serialization (delta audit #2)', () => {
  it('is false for the real built catalog serialized against itself', () => {
    const built = buildCatalog();
    expect(isCatalogStale(serialiseCatalog(built), built)).toBe(false);
  });

  it('is true when the entries array is shuffled (reordered, content otherwise unchanged)', () => {
    const built = buildCatalog();
    const shuffled = { schema: built.schema, entries: [...built.entries].reverse() };
    expect(isCatalogStale(serialiseCatalog(shuffled), built)).toBe(true);
  });

  it('is true when a single entry field has gone stale (e.g. a hand-edited title)', () => {
    const built = buildCatalog();
    const stale = {
      schema: built.schema,
      entries: built.entries.map((entry, index) => (index === 0 ? { ...entry, title: `${entry.title} (edited)` } : entry)),
    };
    expect(isCatalogStale(serialiseCatalog(stale), built)).toBe(true);
  });

  it('is false when only an entry\'s own key order differs on disk (canonical key order absorbs it)', () => {
    const built = buildCatalog();
    const first = built.entries[0]!;
    // Same fields, reversed insertion order — valid JSON a hand-edit could plausibly produce.
    const reorderedFirst = {
      content: first.content, preview: first.preview, availability: first.availability, access: first.access,
      rights: { evidence: first.rights.evidence, decision: first.rights.decision, license: first.rights.license },
      spineAffinities: first.spineAffinities, sourceType: first.sourceType, sectionKind: first.sectionKind,
      sourceKind: first.sourceKind, title: first.title, id: first.id,
    };
    const diskText = `${JSON.stringify({ schema: built.schema, entries: [reorderedFirst, ...built.entries.slice(1)] }, null, 2)}\n`;
    expect(isCatalogStale(diskText, built)).toBe(false);
  });

  it('is true for unparsable disk content', () => {
    const built = buildCatalog();
    expect(isCatalogStale('not json', built)).toBe(true);
  });

  it('canonicalizeCatalog fixes entry key order without touching entries array order', () => {
    const built = buildCatalog();
    const shuffled = { schema: built.schema, entries: [...built.entries].reverse() };
    const canonical = canonicalizeCatalog(shuffled);
    expect(canonical.entries.map((entry) => entry.id)).toEqual(shuffled.entries.map((entry) => entry.id));
    expect(canonical.entries.map((entry) => entry.id)).not.toEqual(built.entries.map((entry) => entry.id));
  });
});

describe('validateSectionCatalog / sectionCatalogPolicyIssues', () => {
  const base = buildCatalog();

  it('flags a duplicate id', () => {
    const catalog = { ...base, entries: [base.entries[0]!, base.entries[0]!] };
    const issues = sectionCatalogPolicyIssues(catalog);
    expect(issues.some((issue) => issue.message.includes('duplicate id'))).toBe(true);
  });

  it('flags sourceKind "hyperui" with a non-vendored-block content', () => {
    const hyperuiEntry = base.entries.find((entry) => entry.sourceKind === 'hyperui')!;
    const bad = { ...hyperuiEntry, content: { kind: 'family-section' as const, family: 'watson', sectionId: 'watson-hero' } };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.content.kind'))).toBe(true);
  });

  it('flags a family-section entry that is not reference-only', () => {
    const familyEntry = base.entries.find((entry) => entry.sourceKind === 'family-section')!;
    const bad = { ...familyEntry, availability: 'insertable' as const };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.message.includes('reference-only'))).toBe(true);
  });

  it('flags "insertable" content that is not a vendored-block', () => {
    const familyEntry = base.entries.find((entry) => entry.sourceKind === 'family-section')!;
    const bad = { ...familyEntry, availability: 'insertable' as const };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.availability'))).toBe(true);
  });

  it('flags a family-section entry that carries spineAffinities "any"', () => {
    const familyEntry = base.entries.find((entry) => entry.sourceKind === 'family-section')!;
    const bad = { ...familyEntry, spineAffinities: 'any' as const };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.spineAffinities') && issue.message.includes('may not carry spineAffinities "any"'))).toBe(true);
  });

  it('never emits a family-section entry with spineAffinities "any" (the build script never should, and the policy check would catch it if it did)', () => {
    const familySections = base.entries.filter((entry) => entry.sourceKind === 'family-section');
    expect(familySections.length).toBeGreaterThan(0);
    for (const entry of familySections) expect(entry.spineAffinities).not.toBe('any');
  });

  it('flags "page-composition" on a non-motionsites entry', () => {
    const hyperuiEntry = base.entries.find((entry) => entry.sourceKind === 'hyperui')!;
    const bad = { ...hyperuiEntry, sectionKind: 'page-composition' as const };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.message.includes('page-composition'))).toBe(true);
  });

  it('flags a cult-pro entry whose rights differ from the recorded Cult licence', () => {
    const cultEntry = base.entries.find((entry) => entry.sourceKind === 'cult-pro')!;
    const bad = { ...cultEntry, rights: { ...cultEntry.rights, decision: 'metadata-only' as const } };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.rights') && issue.message.includes('cult-pro'))).toBe(true);
  });

  it('flags rights.license "licensed" on anything but a cult-pro entry', () => {
    const hyperuiEntry = base.entries.find((entry) => entry.sourceKind === 'hyperui')!;
    const bad = { ...hyperuiEntry, rights: { license: 'licensed' as const, decision: 'bundle' as const, evidence: 'docs/legal/cult-ui-pro-rights.md' } };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.rights.license') && issue.message.includes('reserved for sourceKind "cult-pro"'))).toBe(true);
  });

  it('flags a cult-pro entry marked insertable without a reviewed Cult adapter', () => {
    const cultEntry = base.entries.find((entry) => entry.sourceKind === 'cult-pro' && entry.availability === 'adapter-needed')!;
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [{ ...cultEntry, availability: 'insertable' as const }] });
    expect(issues.some((issue) => issue.path.endsWith('.availability'))).toBe(true);
  });

  it('flags a cult-pro entry with non-cult content, and cult-item content on another source', () => {
    const cultEntry = base.entries.find((entry) => entry.sourceKind === 'cult-pro')!;
    const hyperuiEntry = base.entries.find((entry) => entry.sourceKind === 'hyperui')!;
    const issues = sectionCatalogPolicyIssues({
      ...base,
      entries: [{ ...cultEntry, content: hyperuiEntry.content }, { ...hyperuiEntry, content: cultEntry.content }],
    });
    expect(issues.filter((issue) => issue.path.endsWith('.content.kind')).length).toBeGreaterThanOrEqual(2);
  });

  it('flags a cult-pro entry whose provenance names a different id', () => {
    const cultEntry = base.entries.find((entry) => entry.sourceKind === 'cult-pro')!;
    if (cultEntry.content.kind !== 'cult-item') throw new Error('expected cult-item content');
    const bad = { ...cultEntry, content: { ...cultEntry.content, provenance: { ...cultEntry.content.provenance, cultId: 'cult:other' } } };
    const issues = sectionCatalogPolicyIssues({ ...base, entries: [bad] });
    expect(issues.some((issue) => issue.path.endsWith('.provenance.cultId'))).toBe(true);
  });

  it('accepts a cult-pro page-composition entry', () => {
    const page = base.entries.find((entry) => entry.sourceKind === 'cult-pro' && entry.sectionKind === 'page-composition')!;
    expect(page).toBeDefined();
    expect(sectionCatalogPolicyIssues({ ...base, entries: [page] })).toEqual([]);
  });

  it('accepts the real catalog as-is', () => {
    expect(() => validateSectionCatalog(base)).not.toThrow();
  });
});
