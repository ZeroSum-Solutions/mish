/**
 * The committed catalog, schema and closed lists. These run without the private kit (CI); the
 * kit comparison itself is `pnpm --filter @open-design/cult-ui-catalog check`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { catalogFileText } from '../src/canonical.ts';
import { applyOverrides, parseOverrides } from '../src/overrides.ts';
import { renderSnapshotBlock } from '../src/rights-doc.ts';
import { COMPONENT_IDS, SECTION_KINDS, SPINE_CODES, STYLE_DENSITIES, TAXONOMY_SECTION_IDS } from '../src/taxonomy.ts';
import { ASSET_KINDS, CONVERSION_STATUSES, INTERACTIONS, PORT_QUEUES, RUNTIME_FEATURES, type CultCatalog } from '../src/types.ts';
import { catalogIssues, cultCatalogSchema } from '../src/validate.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const catalogText = read('../catalog.json');
const catalog = JSON.parse(catalogText) as CultCatalog;

test('committed catalog.json is valid, canonical and complete', () => {
  assert.deepEqual(catalogIssues(catalog), []);
  assert.equal(catalogFileText(catalog), catalogText, 'catalog.json must be canonical (sorted keys, one compact row per line)');
  const derived = catalog.rows.filter((r) => r.derivedFrom !== undefined);
  assert.equal(catalog.rows.length - derived.length, catalog.snapshot.expectedItems, 'one source row per registry index item');
  assert.equal(catalog.snapshot.expectedItems, 291, 'the pinned registry index has 291 items');
  assert.equal(derived.length, catalog.snapshot.derivedRows);
});

test('reviewed overrides parse and name existing rows', () => {
  assert.doesNotThrow(() => applyOverrides(catalog.rows, parseOverrides(JSON.parse(read('../reviewed-overrides.json')))));
});

test('the rights doc pins the committed snapshot', () => {
  assert.ok(read('../../../docs/legal/cult-ui-pro-rights.md').includes(renderSnapshotBlock(catalog.snapshot)));
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

test('every non-demo ui row has a reviewed port queue, and only primitive/app rows take one', () => {
  const ui = catalog.rows.filter((r) => r.original.type === 'registry:ui' && r.demoOf === undefined);
  assert.ok(ui.length > 0);
  for (const row of ui) assert.ok(row.portQueue !== undefined && row.review?.note, `${row.id} needs a reviewed portQueue`);
  const section = catalog.rows.find((r) => r.assetKind === 'section')!;
  const bad = { ...catalog, rows: catalog.rows.map((r) => (r.id === section.id ? { ...r, portQueue: 'css-surface' as const } : r)) };
  assert.ok(catalogIssues(bad).includes(`${section.id}: only primitive and app rows take a port queue`));
});
