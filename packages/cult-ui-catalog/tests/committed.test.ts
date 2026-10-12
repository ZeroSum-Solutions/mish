/**
 * The committed catalog, schema and closed lists. These run without the private kit (CI); the
 * kit comparison itself is `pnpm --filter @mish/cult-ui-catalog check`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildCatalog } from '../src/build.ts';
import { catalogFileText } from '../src/canonical.ts';
import { readKit } from '../src/kit.ts';
import { applyOverrides, parseOverrides } from '../src/overrides.ts';
import { renderSnapshotBlock } from '../src/rights-doc.ts';
import { COMPONENT_IDS, SECTION_KINDS, SPINE_CODES, STYLE_DENSITIES, TAXONOMY_SECTION_IDS } from '../src/taxonomy.ts';
import { ASSET_KINDS, CONVERSION_STATUSES, INTERACTIONS, PORT_QUEUES, RUNTIME_FEATURES, type CultCatalog } from '../src/types.ts';
import { catalogIssues, cultCatalogSchema } from '../src/validate.ts';
import { FIXTURE_ITEMS, writeFixtureKit } from './helpers/fixture-kit.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const catalogText = read('../catalog.json');
const catalog = JSON.parse(catalogText) as CultCatalog;

test('committed catalog.json is the valid, canonical, empty public state', () => {
  // The licensed Cult UI Pro inventory ships in a private pack: this repository commits no rows.
  assert.deepEqual(catalogIssues(catalog), []);
  assert.equal(catalogFileText(catalog), catalogText, 'catalog.json must be canonical (sorted keys, one compact row per line)');
  assert.deepEqual(catalog.rows, []);
  assert.deepEqual(
    [catalog.snapshot.expectedItems, catalog.snapshot.fetchedItems, catalog.snapshot.pendingItems, catalog.snapshot.derivedRows],
    [0, 0, 0, 0],
  );
});

test('a catalog built from a synthetic kit is valid, canonical and complete', () => {
  const built = buildCatalog(readKit(writeFixtureKit()), {});
  assert.deepEqual(catalogIssues(built), []);
  assert.equal(catalogFileText(JSON.parse(catalogFileText(built))), catalogFileText(built), 'canonical text is a fixed point');
  const derived = built.rows.filter((r) => r.derivedFrom !== undefined);
  assert.equal(built.rows.length - derived.length, built.snapshot.expectedItems, 'one source row per registry index item');
  assert.equal(built.snapshot.expectedItems, FIXTURE_ITEMS.length);
  assert.equal(derived.length, built.snapshot.derivedRows);
  // The validator still rejects a snapshot that disagrees with the rows.
  const lying = { ...built, snapshot: { ...built.snapshot, expectedItems: built.snapshot.expectedItems + 1 } };
  assert.ok(catalogIssues(lying).some((i) => i.includes('source rows, expected')));
});

test('reviewed overrides parse, and name only existing rows', () => {
  const committed = parseOverrides(JSON.parse(read('../reviewed-overrides.json')));
  assert.doesNotThrow(() => applyOverrides(catalog.rows, committed));
  assert.deepEqual(Object.keys(committed), [], 'no override may name a row the public catalog does not have');
  assert.equal(JSON.parse(read('../catalog-curation.json')).relations.length, 0);
  assert.equal(JSON.parse(read('../catalog-copy-refinements.json')).replacements.length, 0);

  const rows = buildCatalog(readKit(writeFixtureKit()), {}).rows;
  const review = parseOverrides({ overrides: { 'cult:hero-alpha': { note: 'checked', sectionKind: 'hero' } } });
  assert.doesNotThrow(() => applyOverrides(rows, review));
  assert.throws(() => applyOverrides(rows, parseOverrides({ overrides: { 'cult:missing': { note: 'n' } } })), /no catalog row cult:missing/);
});

test('the rights doc pins the committed snapshot when there is a snapshot to pin', () => {
  const docUrl = new URL('../../../docs/legal/cult-ui-pro-rights.md', import.meta.url);
  if (existsSync(docUrl)) assert.ok(readFileSync(docUrl, 'utf8').includes(renderSnapshotBlock(catalog.snapshot)));
  else assert.equal(catalog.rows.length, 0, 'a catalog with rows needs the rights doc that pins its snapshot');
});

test('closed lists match the design taxonomy and shape atlas', () => {
  const taxonomy = JSON.parse(read('../../agency-fast-lane/src/taxonomy/design-taxonomy.json'));
  const atlas = JSON.parse(read('../../agency-fast-lane/src/atlas/shape-atlas.json'));
  const ids = (list: Array<{ id: string } | string>) => list.map((x) => (typeof x === 'string' ? x : x.id));
  assert.deepEqual([...TAXONOMY_SECTION_IDS], ids(taxonomy.sections));
  assert.deepEqual([...COMPONENT_IDS], ids(taxonomy.components));
  assert.deepEqual([...STYLE_DENSITIES], ids(taxonomy.style.density));
  assert.deepEqual([...SPINE_CODES], atlas.spines.map((s: { code: string }) => s.code));
});

test('schema enums match the TypeScript closed lists', () => {
  const defs = cultCatalogSchema.$defs as Record<string, { enum: string[] }>;
  assert.deepEqual(defs.sectionKind!.enum, [...SECTION_KINDS]);
  assert.deepEqual(defs.componentId!.enum, [...COMPONENT_IDS]);
  assert.deepEqual(defs.spineCode!.enum, [...SPINE_CODES]);
  assert.deepEqual(defs.assetKind!.enum, [...ASSET_KINDS]);
  assert.deepEqual(defs.conversionStatus!.enum, [...CONVERSION_STATUSES]);
  assert.deepEqual(defs.runtimeFeature!.enum, [...RUNTIME_FEATURES]);
  assert.deepEqual(defs.interaction!.enum, [...INTERACTIONS]);
  assert.deepEqual(defs.portQueue!.enum, [...PORT_QUEUES]);
});

test('port queues: only primitive/app rows take one, and a reviewed non-demo ui row needs it', () => {
  assert.equal(catalog.rows.filter((r) => r.original.type === 'registry:ui' && r.demoOf === undefined).length, 0);
  const built = buildCatalog(readKit(writeFixtureKit()), {});
  const section = built.rows.find((r) => r.assetKind === 'section')!;
  const bad = { ...built, rows: built.rows.map((r) => (r.id === section.id ? { ...r, portQueue: 'css-surface' as const } : r)) };
  assert.ok(catalogIssues(bad).includes(`${section.id}: only primitive and app rows take a port queue`));
  const ui = built.rows.filter((r) => r.original.type === 'registry:ui' && r.demoOf === undefined && r.conversion.status !== 'pending-fetch');
  for (const row of ui) assert.ok(row.portQueue !== undefined && row.review?.note, `${row.id} needs a reviewed portQueue`);
});
