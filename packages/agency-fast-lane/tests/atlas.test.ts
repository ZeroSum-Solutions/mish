/**
 * The checked-in atlas data: the real shape-atlas.json has the atlas's known shape (9 spines, 32
 * archetypes, a symmetric 9x9 matrix with diagonal 3, 12 skins, 8 formats, 9 transfer notes —
 * the ninth being the trailing-space MI entry the importer's regex recovers), every archetype's
 * spine resolves, and the family registry's entries resolve against the atlas and against the
 * bundled family packages actually on disk.
 */

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadAtlasData, loadFamilyRegistry, loadShapeAtlas, validateFamilyRegistry, validateShapeAtlas, type FamilyRegistry } from '../src/atlas.ts';

test('the checked-in shape atlas has 9 spines, 32 archetypes, a 9x9 symmetric matrix with diagonal 3, 12 skins, 8 formats, 9 transfer notes', async () => {
  const atlas = await loadShapeAtlas();
  assert.equal(atlas.spines.length, 9);
  assert.equal(atlas.archetypes.length, 32);
  assert.equal(Object.keys(atlas.compatibility).length, 9);
  for (const spine of atlas.spines) assert.equal(Object.keys(atlas.compatibility[spine.code]!).length, 9, `${spine.code} row is square`);
  assert.equal(atlas.skins.length, 12);
  assert.equal(atlas.formats.length, 8);
  assert.equal(Object.keys(atlas.transferNotes).length, 9, 'all nine spines have a transfer note, including MI (the trailing-space entry)');
});

test('every archetype references a spine that exists in the checked-in atlas', async () => {
  const atlas = await loadShapeAtlas();
  const codes = new Set(atlas.spines.map((spine) => spine.code));
  for (const archetype of atlas.archetypes) assert.ok(codes.has(archetype.spine), `${archetype.id} references spine ${archetype.spine}`);
});

test('validateShapeAtlas passes on the checked-in atlas and rejects a broken copy', async () => {
  const atlas = await loadShapeAtlas();
  assert.doesNotThrow(() => validateShapeAtlas(atlas));
  const broken = { ...atlas, compatibility: { ...atlas.compatibility, TL: { ...atlas.compatibility.TL, TL: 2 } } };
  assert.throws(() => validateShapeAtlas(broken), /diagonal/);
});

test('every family registry entry resolves against the atlas: archetype exists, its spine matches, its skin exists, its pageKind is valid', async () => {
  const { atlas, registry } = await loadAtlasData();
  assert.ok(registry.families.length > 0);
  assert.doesNotThrow(() => validateFamilyRegistry(registry, atlas));
});

test('validateFamilyRegistry rejects an entry pointing at an unknown archetype', async () => {
  const atlas = await loadShapeAtlas();
  const registry = await loadFamilyRegistry();
  const broken = { families: [...registry.families, { family: 'ghost', archetype: 'ZZ.99', spine: 'TL', skin: atlas.skins[0]!, skinInferred: true, summary: 'x', pageKind: 'site' as const }] };
  assert.throws(() => validateFamilyRegistry(broken, atlas), /unknown archetype/);
});

test('validateFamilyRegistry rejects an entry with a missing pageKind', async () => {
  const atlas = await loadShapeAtlas();
  const registry = await loadFamilyRegistry();
  const [first, ...rest] = registry.families;
  const { pageKind: _pageKind, ...withoutPageKind } = first!;
  // Cast once, at the boundary: `withoutPageKind` is deliberately shaped WRONG (that's the point
  // of the test), so it cannot satisfy `FamilyRegistry` field-by-field the way the other tests do.
  const broken = { families: [withoutPageKind, ...rest] } as unknown as FamilyRegistry;
  assert.throws(() => validateFamilyRegistry(broken, atlas), /unknown pageKind/);
});

test('validateFamilyRegistry rejects an entry with a misspelled pageKind', async () => {
  const atlas = await loadShapeAtlas();
  const registry = await loadFamilyRegistry();
  const [first, ...rest] = registry.families;
  const broken = { families: [{ ...first!, pageKind: 'sites' }, ...rest] } as unknown as FamilyRegistry;
  assert.throws(() => validateFamilyRegistry(broken, atlas), /unknown pageKind/);
});

test('the family registry ids equal the bundled agency-* package directories, so a family can never go unregistered', async () => {
  const registry = await loadFamilyRegistry();
  const examplesDir = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
  const entries = await readdir(examplesDir, { withFileTypes: true });
  const packageFamilies = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agency-'))
    .map((entry) => entry.name.slice('agency-'.length))
    .sort();
  const registryFamilies = registry.families.map((entry) => entry.family).sort();
  assert.deepEqual(registryFamilies, packageFamilies);
});

test('every one of the nine atlas spines has at least one registered family', async () => {
  const { atlas, registry } = await loadAtlasData();
  assert.equal(atlas.spines.length, 9);
  const covered = new Set(registry.families.map((entry) => entry.spine));
  const uncovered = atlas.spines.map((spine) => spine.code).filter((code) => !covered.has(code));
  assert.deepEqual(uncovered, [], 'spines with no family');
});

test('the SM, CS and MI families name the businesses they fit, so routing can reach them', async () => {
  const registry = await loadFamilyRegistry();
  const summaryOf = (family: string) => registry.families.find((entry) => entry.family === family)?.summary.toLowerCase() ?? '';
  const expected: Record<string, { spine: string; archetype: string; words: string[] }> = {
    listings: { spine: 'SM', archetype: 'SM.02', words: ['real estate', 'rentals', 'marketplaces', 'directories'] },
    publication: { spine: 'CS', archetype: 'CS.01', words: ['magazines', 'newsletters', 'media', 'blogs'] },
    nonprofit: { spine: 'MI', archetype: 'MI.01', words: ['charities', 'foundations', 'causes'] },
    'docs-hub': { spine: 'CS', archetype: 'CS.02', words: ['documentation', 'knowledge base', 'developer', 'help centers'] },
  };
  for (const [family, { spine, archetype, words }] of Object.entries(expected)) {
    const entry = registry.families.find((candidate) => candidate.family === family);
    assert.ok(entry, `${family} is registered`);
    assert.equal(entry.spine, spine);
    assert.equal(entry.archetype, archetype);
    for (const word of words) assert.ok(summaryOf(family).includes(word), `${family} summary names ${word}`);
  }
});

test('publication (CS.01) and docs-hub (CS.02) summaries stay mutually distinguishable, so a router reading only these words keeps routing each to itself', async () => {
  const registry = await loadFamilyRegistry();
  const summaryOf = (family: string) => registry.families.find((entry) => entry.family === family)?.summary.toLowerCase() ?? '';
  const publicationOnly = ['magazine', 'newsletter', 'blog'];
  const docsHubOnly = ['documentation', 'knowledge base', 'developer'];
  for (const word of publicationOnly) {
    assert.ok(summaryOf('publication').includes(word), `publication summary names ${word}`);
    assert.ok(!summaryOf('docs-hub').includes(word), `docs-hub summary does not borrow publication's ${word}`);
  }
  for (const word of docsHubOnly) {
    assert.ok(summaryOf('docs-hub').includes(word), `docs-hub summary names ${word}`);
    assert.ok(!summaryOf('publication').includes(word), `publication summary does not borrow docs-hub's ${word}`);
  }
});

test('community (LM.03) names its own membership words and disclaims course/cohort language, so it never steals emmpo\'s LM.01 briefs', async () => {
  const registry = await loadFamilyRegistry();
  const summaryOf = (family: string) => registry.families.find((entry) => entry.family === family)?.summary.toLowerCase() ?? '';
  const community = registry.families.find((entry) => entry.family === 'community');
  assert.ok(community, 'community is registered');
  assert.equal(community!.spine, 'LM');
  assert.equal(community!.archetype, 'LM.03');
  for (const word of ['studio', 'coworking', 'club', 'membership']) assert.ok(summaryOf('community').includes(word), `community summary names ${word}`);
  // The router asks Jev to choose between LM.01 (emmpo) and LM.03 (community) on the same LM
  // spine; a summary that only lists positive keywords risks bleeding into emmpo's course/cohort
  // briefs, so it must also say in words what it is not.
  for (const word of ['course', 'cohort', 'curriculum']) assert.ok(summaryOf('community').includes(word), `community summary disclaims ${word}`);
  // emmpo's own summary is unchanged by adding community: still names courses/cohorts/enrol, and
  // still does not use community's own vocabulary (studio, coworking, club membership).
  const emmpo = summaryOf('emmpo');
  for (const word of ['course', 'cohort', 'enrol']) assert.ok(emmpo.includes(word), `emmpo summary still names ${word}`);
  for (const word of ['coworking', 'studio and community', 'shared studio']) assert.ok(!emmpo.includes(word), `emmpo summary does not borrow community's own words (${word})`);
});
