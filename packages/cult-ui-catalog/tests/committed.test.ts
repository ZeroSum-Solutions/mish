/**
 * The committed catalog, schema and closed lists. These run without the private kit (CI); the
 * kit comparison itself is `pnpm --filter @mish/cult-ui-catalog check`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../src/build.ts';
import { catalogFileText } from '../src/canonical.ts';
import { readKit } from '../src/kit.ts';
import { applyOverrides, parseOverrides } from '../src/overrides.ts';
import { renderSnapshotBlock } from '../src/rights-doc.ts';
import { COMPONENT_IDS, SECTION_KINDS, SPINE_CODES, STYLE_DENSITIES, TAXONOMY_SECTION_IDS } from '../src/taxonomy.ts';
import { ASSET_KINDS, CONVERSION_STATUSES, INTERACTIONS, PORT_QUEUES, RUNTIME_FEATURES, type CultCatalog } from '../src/types.ts';
import { catalogIssues, catalogWithheld, cultCatalogSchema } from '../src/validate.ts';
import { writeFixtureKit } from './helpers/fixture-kit.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const catalogText = read('../catalog.json');
const catalog = JSON.parse(catalogText) as CultCatalog;

test('committed catalog.json is valid and canonical', () => {
  assert.deepEqual(catalogIssues(catalog), []);
  assert.equal(catalogFileText(catalog), catalogText, 'catalog.json must be canonical (sorted keys, one compact row per line)');
});

// The Cult UI Pro rows, adapters and rights record are licensed content that ships in a private
// pack, not in this public repository. The committed catalog pins the pack's snapshot and carries
// none of its rows, and every generated surface is the empty "not installed" state.
test('the public catalog withholds the licensed rows and generates nothing from them', async () => {
  assert.equal(catalogWithheld(catalog), true);
  assert.equal(catalog.rows.length, 0);
  assert.equal(catalog.snapshot.expectedItems, 291, 'the pinned registry index has 291 items');
  const { CULT_ADAPTER_IDS } = await import('../generated/index.ts');
  assert.deepEqual(CULT_ADAPTER_IDS, []);
  for (const file of ['slugs.json', 'public-names.json', 'thumbnails.json']) {
    assert.deepEqual(JSON.parse(read(`../generated/${file}`)).items, {}, file);
  }
});

test('reviewed overrides parse, and name existing rows whenever rows are present', () => {
  const overrides = parseOverrides(JSON.parse(read('../reviewed-overrides.json')));
  if (!catalogWithheld(catalog)) assert.doesNotThrow(() => applyOverrides(catalog.rows, overrides));
});

test('the rights doc pins the committed snapshot whenever the rows are present', () => {
  const docUrl = new URL('../../../docs/legal/cult-ui-pro-rights.md', import.meta.url);
  if (catalogWithheld(catalog) && !existsSync(docUrl)) return;
  assert.ok(readFileSync(docUrl, 'utf8').includes(renderSnapshotBlock(catalog.snapshot)));
});

const runScript = (script: string) => spawnSync(process.execPath, ['--experimental-strip-types', script, '--check'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
  env: { ...process.env, CULT_KIT_DIR: join(tmpdir(), 'cult-kit-not-installed'), CULT_REQUIRE_KIT: '' },
});

test('without the private pack, the catalog and adapter checks pass and say the kit is absent', () => {
  for (const script of ['scripts/import.ts', 'scripts/adapters.ts']) {
    const result = runScript(script);
    assert.equal(result.status, 0, `${script}: ${result.stderr}${result.stdout}`);
    assert.match(result.stdout, /source kit not found/, script);
  }
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
  for (const row of ui) assert.ok(row.portQueue !== undefined && row.review?.note, `${row.id} needs a reviewed portQueue`);
  // The negative rule runs on the owned synthetic kit, so it holds without the licensed rows.
  const fixture = buildCatalog(readKit(writeFixtureKit()), {});
  const section = fixture.rows.find((r) => r.assetKind === 'section')!;
  const bad = { ...fixture, rows: fixture.rows.map((r) => (r.id === section.id ? { ...r, portQueue: 'css-surface' as const } : r)) };
  assert.ok(catalogIssues(bad).includes(`${section.id}: only primitive and app rows take a port queue`));
});
