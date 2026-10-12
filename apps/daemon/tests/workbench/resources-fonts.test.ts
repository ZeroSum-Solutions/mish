import { describe, expect, it } from 'vitest';
import { FONT_SPINE_CODES, parseResourceSearchRequest, type ResourceCandidate } from '@mish/contracts';
import { searchResources } from '../../src/workbench/resources.js';
import { createFontsResourceSource } from '../fixtures/daemon-b/fonts.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectDesignContextDraft } from '@mish/contracts';
import { putProjectContext, readProjectContext, readWorkbenchPreferences } from '../../src/workbench/project-context.js';
import { savedContext, projectState } from './context-ranking-fixture.js';
import { database, references } from './project-context-fixture.js';
import { REPO_DESIGN_SYSTEMS_ROOT } from './resources-inventory-fixture.js';

/** A saved-context draft whose every leaf carries user-confirmed provenance. */
function contextDraftWith(fields: Pick<ProjectDesignContextDraft, 'brandDirection' | 'constraints' | 'spineCode' | 'designSystemRef'>): ProjectDesignContextDraft {
  const draft: ProjectDesignContextDraft = { purpose: 'Book first appointments', audience: ['New patients'], conversions: [{ id: 'book', kind: 'booking', role: 'primary', label: 'Book a visit' }], factSources: [], assumptions: [], ...fields };
  const leaves: Array<[string, string]> = [['/purpose', draft.purpose!], ['/audience/0', draft.audience[0]!], ['/conversions/0/kind', 'booking'], ['/conversions/0/role', 'primary'], ['/conversions/0/label', 'Book a visit'], ['/brandDirection', draft.brandDirection!],
    ...draft.constraints.map((constraint, index): [string, string] => [`/constraints/${index}/value`, constraint.value]), ['/spineCode', draft.spineCode!], ['/designSystemRef/id', draft.designSystemRef!.id], ['/designSystemRef/revisionOrDigest', draft.designSystemRef!.revisionOrDigest]];
  draft.factSources = leaves.map(([fieldPath, value]) => ({ fieldPath, value, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Project owner declaration' }));
  return draft;
}
import { REPO_BUNDLED_PLUGINS_ROOT, authority, catalogueCopy, projectAuthority } from '../fixtures/daemon-b/fonts.js';

// The curated Fontsource snapshot alone; the Google Fonts and Fontshare listings are covered in fonts-sources.test.ts.
const fonts = () => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, listings: [] });
const search = (query: string, extra: Record<string, unknown> = {}) => parseResourceSearchRequest({ query, facets: { sourceIds: ['fonts'] }, limit: 100, ...extra });
const ids = (items: readonly { ref: { itemId: string } }[]) => items.map(item => item.ref.itemId);
const byId = (items: readonly ResourceCandidate[], id: string) => items.find(item => item.ref.itemId === id)!;

describe('AC-R11 preamble: the fonts source federates the pinned Fontsource snapshot', () => {
  it('lists every curated family with pinned source, per-font rights and no minted usable readiness', async () => {
    const snapshot = await fonts().list(authority);
    expect(snapshot.status).toMatchObject({ sourceId: 'fonts', state: 'searched', reason: null, itemCount: snapshot.items.length });
    expect(snapshot.items.length).toBeGreaterThanOrEqual(18);
    for (const item of snapshot.items) {
      expect(item).toMatchObject({ ref: { sourceType: 'font', sourceId: 'fonts' }, category: 'font' });
      expect(item.readiness).not.toBe('usable');
      expect(item.adoptionCapability.available).toBe(false);
      expect(item.fontProfile?.source).toMatchObject({ metadata: 'fontsource/font-files', commit: 'c3f4e3e5a664d2c3002e800050ce809a790d7281' });
      const source = item.fontProfile!.source;
      expect(source.metadata === 'fontsource/font-files' ? source.packageName : null).toBe(`@fontsource/${item.ref.itemId}`);
      // Rights come from each family's own licence metadata, not from the source as a whole.
      expect(item.fontProfile?.licence.type).toBe('OFL-1.1');
      expect(item.rightsStatus).toBe('permitted');
    }
    // Reserved Font Names travel with the licence (Plex from the admitted notice, Lora from upstream).
    expect(byId(snapshot.items, 'ibm-plex-mono').fontProfile?.licence.reservedFontNames).toContain('Plex');
    expect(byId(snapshot.items, 'lora').fontProfile?.licence.reservedFontNames).toContain('Lora');
  });

  it('records a Reserved Font Name only for the family it names, even when families share an OFL notice', async () => {
    const items = (await fonts().list(authority)).items;
    // Archivo's admitted bytes share agency-halcyon's OFL.txt with IBM Plex Mono; "Plex" binds Plex only.
    expect(byId(items, 'archivo').fontProfile?.licence.reservedFontNames).toEqual([]);
    expect(byId(items, 'archivo').fontProfile?.licence.modification).not.toMatch(/Reserved Font Name/);
    for (const item of items) for (const name of item.fontProfile!.licence.reservedFontNames) expect(item.title, `${item.ref.itemId} reserves ${name}`).toContain(name);
  });

  it('reports weights, styles, subsets and variable axes from metadata', async () => {
    const inter = byId((await fonts().list(authority)).items, 'inter').fontProfile!;
    expect(inter.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(inter.styles.sort()).toEqual(['italic', 'normal']);
    expect(inter.subsets).toEqual(expect.arrayContaining(['latin', 'cyrillic', 'greek', 'vietnamese']));
    expect(inter.axes.map(axis => axis.tag)).toEqual(expect.arrayContaining(['wght', 'opsz']));
  });
});

describe('AC-R11.1 spine-suitable search', () => {
  it('every one of the nine spines has curated examples with fit and counter-fit reasons, and no font is exclusive to one spine', async () => {
    const items = (await fonts().list(authority)).items;
    for (const spine of FONT_SPINE_CODES) {
      const examples = items.filter(item => item.fontProfile?.spineFit.some(fit => fit.spine === spine));
      expect(examples.length, spine).toBeGreaterThanOrEqual(2);
      for (const item of examples) {
        const fit = item.fontProfile!.spineFit.find(entry => entry.spine === spine)!;
        expect(fit.fit.length).toBeGreaterThan(20);
        expect(fit.counterFit.length).toBeGreaterThan(20);
        expect(item.spineAffinities).toContain(spine);
      }
    }
    for (const item of items) expect(item.fontProfile!.spineFit.length, item.ref.itemId).toBeGreaterThanOrEqual(2);
  });

  it('searches by name, script coverage, weight and variable axis', async () => {
    const sources = [fonts()];
    expect(ids((await searchResources(search('Fraunces'), authority, sources)).results)).toEqual(['fraunces']);
    const cyrillic = ids((await searchResources(search('cyrillic'), authority, sources)).results);
    expect(cyrillic).toEqual(expect.arrayContaining(['inter', 'literata', 'noto-sans']));
    expect(cyrillic).not.toContain('dm-sans');
    const arabic = ids((await searchResources(search('arabic'), authority, sources)).results);
    expect(arabic).toEqual(['noto-sans-arabic']);
    const slant = ids((await searchResources(search('axis:wonk'), authority, sources)).results);
    expect(slant).toEqual(['fraunces']);
    const heavyMono = ids((await searchResources(search('monospace weight:800'), authority, sources)).results);
    expect(heavyMono).toEqual(['jetbrains-mono']);
  });

  it('a saved project spine ranks fitting fonts first and explains fit and counter-fit', async () => {
    const result = await searchResources(search('', { projectId: 'p' }), projectAuthority, [fonts()], { projectState: projectState(savedContext({ spineCode: 'LM' })) });
    expect(result.context).toMatchObject({ applied: true, resultMode: 'ranked' });
    const learning = result.results.filter(item => item.spineAffinities !== 'any' && item.spineAffinities !== 'unclassified' && item.spineAffinities?.includes('LM'));
    expect(learning.length).toBeGreaterThanOrEqual(2);
    expect(ids(result.results.slice(0, learning.length)).sort()).toEqual(ids(learning).sort());
    const lexend = result.results.find(item => item.ref.itemId === 'lexend')!;
    expect(lexend.fitReasons.some(reason => reason.startsWith('Font fit for LM:'))).toBe(true);
    expect(lexend.fitReasons.some(reason => reason.startsWith('Counter-fit:'))).toBe(true);
    // Non-fitting fonts stay visible (literal empty-query match); the fit is advisory, never a mandatory pick.
    expect(result.results.length).toBe((await fonts().list(authority)).items.length);
  });
});

describe('AC-R11.3 reranking and rights', () => {
  it('spine and brand-constraint changes rerank without touching the saved context or the selected DESIGN.md typography', async () => {
    const db = database();
    const designMd = path.join(REPO_DESIGN_SYSTEMS_ROOT, 'neutral-product', 'DESIGN.md');
    const persisted = () => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workbench_project_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const typography = () => readFileSync(designMd);
    const searchSaved = () => searchResources(search('', { projectId: 'p' }), projectAuthority, [fonts()], { projectState: { context: readProjectContext(db, 'p'), preferences: readWorkbenchPreferences(db, 'p') } });
    const save = (expectedRevision: number, spineCode: 'TL' | 'TU', brandDirection: string, constraints: ProjectDesignContextDraft['constraints']) => putProjectContext(db, 'p', { expectedRevision, draft: contextDraftWith({ spineCode, brandDirection, constraints, designSystemRef: { id: 'neutral', revisionOrDigest: 'v1' } }) }, references(db));
    save(0, 'TL', 'Calm, clinical and trustworthy', [{ id: 'a11y', kind: 'accessibility', value: 'Body text at least 16px' }]);
    const tables = persisted(); const designBytes = typography();
    const first = await searchSaved();
    expect(persisted()).toBe(tables);
    expect(typography().equals(designBytes)).toBe(true);
    // The user changes brand constraints and the spine; only that write changes stored state.
    save(1, 'TU', 'Dense, utilitarian operations console', [{ id: 'a11y', kind: 'accessibility', value: 'High contrast tables' }, { id: 'brand', kind: 'other', value: 'Monospace numerals for IDs' }]);
    const changed = persisted();
    expect(changed).not.toBe(tables);
    const second = await searchSaved();
    expect(persisted()).toBe(changed);
    expect(typography().equals(designBytes)).toBe(true);
    expect(first.context).toMatchObject({ applied: true, observedContextRevision: 1 });
    expect(second.context).toMatchObject({ applied: true, observedContextRevision: 2 });
    expect(first.results[0]!.spineAffinities).toContain('TL');
    expect(second.results[0]!.spineAffinities).toContain('TU');
    expect(ids(first.results.slice(0, 3))).not.toEqual(ids(second.results.slice(0, 3)));
    // The selected typography reference survives every revision; ranking never rewrites it.
    expect(readProjectContext(db, 'p').context?.designSystemRef).toEqual({ id: 'neutral', revisionOrDigest: 'v1' });
    db.close();
  });

  it('unknown rights allow reference-only viewing but block redistribution, export and incorporation', async () => {
    const catalogue = catalogueCopy();
    const family = catalogue.families.find(entry => entry.id === 'archivo')!;
    family.licence = { ...family.licence, type: 'unknown', attribution: null, url: null, upstreamLicenceSha256: null };
    const item = byId((await createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue }).list(authority)).items, 'archivo');
    expect(item).toMatchObject({ rightsStatus: 'unknown', readiness: 'reference-only', admissionStage: 'reference-only' });
    expect(item.fontProfile?.licence).toMatchObject({ recognised: false, redistribution: 'blocked', commercialUse: 'unknown' });
    const grants = Object.fromEntries(item.operationGrants.map(grant => [grant.operation, grant.state]));
    expect(grants).toMatchObject({ 'host-preview': 'permitted', redistribution: 'blocked', export: 'blocked', incorporation: 'blocked' });
    // Viewing stays possible: the local specimen is still offered.
    expect(item.previewCapability).toMatchObject({ available: true, kind: 'reference' });
  });

  it('a restricted licence (Fontshare FFL-style) offers no preview of its bytes', async () => {
    const catalogue = catalogueCopy();
    const family = catalogue.families.find(entry => entry.id === 'archivo')!;
    family.licence = { ...family.licence, type: 'ITF-FFL' };
    const item = byId((await createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue }).list(authority)).items, 'archivo');
    expect(item).toMatchObject({ rightsStatus: 'restricted', readiness: 'unavailable', availabilityReason: 'rights-blocked', previewCapability: { available: false, reason: 'rights-blocked' } });
    expect(item.fontProfile!.localFiles.every(file => file.state === 'unavailable' && file.reason === 'rights-blocked')).toBe(true);
  });

  it('metadata, font bytes and notices retain source and version', async () => {
    const fraunces = byId((await fonts().list(authority)).items, 'fraunces').fontProfile!;
    expect(fraunces.source).toMatchObject({ packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), upstreamVersion: expect.stringMatching(/^v\d+$/), metadataSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(fraunces.licence.upstreamLicenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fraunces.localFiles.length).toBeGreaterThan(0);
    for (const file of fraunces.localFiles) {
      expect(file).toMatchObject({ state: 'available', format: 'woff2', url: `/api/workbench/fonts/files/${file.sha256}` });
      expect(file.notice).toMatchObject({ state: 'available', url: `/api/workbench/fonts/notices/${file.notice.sha256}` });
      expect(file.provenance).toBe('Owned synthetic file with declared cmap test metadata; not measured font glyph evidence.');
    }
  });
});
