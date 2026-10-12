import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest, type ProjectDesignContextDraft, type ResourceResult } from '@mish/contracts';
import { searchResources } from '../../src/workbench/resources.js';
import { createFontsResourceSource } from '../../src/workbench/resources-fonts.js';
import { putProjectContext, readProjectContext, readWorkbenchPreferences } from '../../src/workbench/project-context.js';
import { savedContext, projectState } from './context-ranking-fixture.js';
import { database, references } from './project-context-fixture.js';
import { REPO_BUNDLED_PLUGINS_ROOT, projectAuthority } from './fonts-fixture.js';
import { REPO_DESIGN_SYSTEMS_ROOT } from './resources-inventory-fixture.js';

// The curated Fontsource snapshot alone, so the reported counts are the curated cohort's.
const fonts = () => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, listings: [] });
const request = () => parseResourceSearchRequest({ query: '', projectId: 'p', facets: { sourceIds: ['fonts'] }, limit: 100 });
const run = (context: ReturnType<typeof savedContext>) => searchResources(request(), projectAuthority, [fonts()], { projectState: projectState(context) });
const ids = (items: readonly ResourceResult[]) => items.map(item => item.ref.itemId);
const accessibility = (value: string, id = 'a11y') => ({ id, kind: 'accessibility' as const, value });
/** Index of the first result failing `test` must come after every result passing it. */
function partitioned(results: readonly ResourceResult[], test: (item: ResourceResult) => boolean): boolean {
  const firstFail = results.findIndex(item => !test(item));
  return firstFail === -1 || results.slice(firstFail).every(item => !test(item));
}

describe('AC-R11.3 saved project constraints rerank fonts', () => {
  it('a Cyrillic script requirement ranks Cyrillic-capable fonts first, with a reason and a counter-reason', async () => {
    const result = await run(savedContext({ spineCode: 'TL', constraints: [accessibility('Intake forms must render Russian and Ukrainian names')] }));
    const cyrillic = (item: ResourceResult) => item.fontProfile!.subsets.includes('cyrillic');
    expect(result.context).toMatchObject({ applied: true, resultMode: 'ranked' });
    expect(result.results.filter(cyrillic).length).toBeGreaterThanOrEqual(5);
    expect(partitioned(result.results, cyrillic)).toBe(true);
    const top = result.results[0]!;
    expect(top.fitReasons).toContain('Meets project constraint /constraints/0/value: cyrillic script support (declares the cyrillic subset)');
    const publicSans = result.results.find(item => item.ref.itemId === 'public-sans')!;
    expect(publicSans.fitReasons).toContain('Counter-fit for project constraint /constraints/0/value: cyrillic script support (no cyrillic subset in the Fontsource metadata)');
    expect(result.fontConstraints?.requirements).toEqual([expect.objectContaining({ kind: 'script', value: 'cyrillic', source: '/constraints/0/value', strength: 'required', satisfiedCount: result.results.filter(cyrillic).length })]);
  });

  it('high legibility at small sizes ranks curated legibility fonts first, explicit constraints above spine fit', async () => {
    const result = await run(savedContext({ spineCode: 'CO', constraints: [accessibility('High legibility at small sizes for older patients')] }));
    const legible = (item: ResourceResult) => !!item.fontProfile!.traits?.some(trait => trait.trait === 'small-size-legibility');
    expect(result.results.filter(legible).length).toBeGreaterThanOrEqual(3);
    expect(partitioned(result.results, legible)).toBe(true);
    // Bodoni Moda fits Commerce by spine but fails the explicit legibility need, so it ranks below every legible font.
    const bodoni = result.results.find(item => item.ref.itemId === 'bodoni-moda')!;
    expect(bodoni.fitReasons.some(reason => reason.startsWith('Font fit for CO:'))).toBe(true);
    expect(bodoni.fitReasons.some(reason => reason.startsWith('Counter-fit for project constraint /constraints/0/value: high legibility at small sizes'))).toBe(true);
    const atkinson = result.results.find(item => item.ref.itemId === 'atkinson-hyperlegible')!;
    expect(atkinson.fitReasons.find(reason => reason.startsWith('Meets project constraint /constraints/0/value: high legibility at small sizes'))).toMatch(/\(.+\)$/);
  });

  it('brand direction tone reranks fonts within the same spine as a preference', async () => {
    const warm = await run(savedContext({ spineCode: 'PA', brandDirection: 'Warm, friendly and welcoming' }));
    const technical = await run(savedContext({ spineCode: 'PA', brandDirection: 'Technical, dense and utilitarian' }));
    expect(ids(warm.results.slice(0, 3))).not.toEqual(ids(technical.results.slice(0, 3)));
    expect(warm.results[0]!.fontProfile!.tones).toContain('friendly');
    expect(warm.fontConstraints?.requirements).toEqual([expect.objectContaining({ kind: 'tone', value: 'friendly', source: '/brandDirection', strength: 'preferred' })]);
    expect(technical.results[0]!.fitReasons).toContain('Meets project constraint /brandDirection: technical tone (curated tone technical)');
  });

  it('a requirement no font satisfies is reported with zero matches, and unread constraints are named, never silently dropped', async () => {
    const result = await run(savedContext({ spineCode: 'MI', constraints: [accessibility('Signage must support the Georgian script'), accessibility('Body text at least 16px', 'size')] }));
    const georgian = result.fontConstraints!.requirements.find(requirement => requirement.value === 'georgian')!;
    expect(georgian).toMatchObject({ kind: 'script', satisfiedCount: 0, source: '/constraints/0/value' });
    expect(georgian.message).toMatch(/^No catalogued font meets georgian script support/);
    expect(result.fontConstraints).toMatchObject({ fontsMeetingAllRequired: 0, fontsConsidered: result.results.length });
    expect(result.fontConstraints!.uninterpreted).toEqual([{ source: '/constraints/1/value', message: expect.stringMatching(/not read as a font requirement/i) }]);
    for (const item of result.results) expect(item.fitReasons.some(reason => reason.startsWith('Counter-fit for project constraint /constraints/0/value: georgian script support'))).toBe(true);
  });

  it('ranking is deterministic: the same context gives the same order and reasons', async () => {
    const context = savedContext({ spineCode: 'LM', brandDirection: 'Friendly', constraints: [accessibility('Readable for dyslexic learners; Hindi lessons')] });
    const first = await run(context); const second = await run(context);
    expect(second.results.map(item => [item.ref.itemId, item.fitReasons])).toEqual(first.results.map(item => [item.ref.itemId, item.fitReasons]));
    expect(second.fontConstraints).toEqual(first.fontConstraints);
    expect(first.fontConstraints!.requirements.map(requirement => requirement.id)).toEqual(['script:devanagari', 'legibility:small-size-legibility', 'tone:friendly']);
  });

  it('changing brand constraints reranks without writing the saved context or DESIGN.md', async () => {
    const db = database();
    const designMd = path.join(REPO_DESIGN_SYSTEMS_ROOT, 'neutral-product', 'DESIGN.md');
    const persisted = () => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workbench_project_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const searchSaved = () => searchResources(request(), projectAuthority, [fonts()], { projectState: { context: readProjectContext(db, 'p'), preferences: readWorkbenchPreferences(db, 'p') } });
    const save = (expectedRevision: number, brandDirection: string, constraint: string) => {
      const draft: ProjectDesignContextDraft = { purpose: 'Clinic intake', audience: ['Patients'], conversions: [], brandDirection, constraints: [accessibility(constraint)], spineCode: 'TL', designSystemRef: { id: 'neutral', revisionOrDigest: 'v1' }, factSources: [], assumptions: ['Conversions are not decided yet'] };
      draft.factSources = ([['/purpose', 'Clinic intake'], ['/audience/0', 'Patients'], ['/brandDirection', brandDirection], ['/constraints/0/value', constraint], ['/spineCode', 'TL'], ['/designSystemRef/id', 'neutral'], ['/designSystemRef/revisionOrDigest', 'v1']] as const)
        .map(([fieldPath, value]) => ({ fieldPath, value, origin: 'user-confirmed' as const, source: null, confidence: null, rationale: 'Project owner declaration' }));
      return putProjectContext(db, 'p', { expectedRevision, draft }, references(db));
    };
    save(0, 'Calm and formal', 'Forms must show Greek names');
    const designBytes = readFileSync(designMd);
    let tables = persisted();
    const greek = await searchSaved();
    expect(persisted()).toBe(tables);
    save(1, 'Warm and friendly', 'High legibility at small sizes');
    tables = persisted();
    const legible = await searchSaved();
    expect(persisted()).toBe(tables);
    expect(readFileSync(designMd).equals(designBytes)).toBe(true);
    expect(greek.results[0]!.fontProfile!.subsets).toContain('greek');
    expect(legible.results[0]!.fontProfile!.traits?.map(trait => trait.trait)).toContain('small-size-legibility');
    expect(ids(greek.results.slice(0, 5))).not.toEqual(ids(legible.results.slice(0, 5)));
    expect(readProjectContext(db, 'p').context?.designSystemRef).toEqual({ id: 'neutral', revisionOrDigest: 'v1' });
    db.close();
  });
});
