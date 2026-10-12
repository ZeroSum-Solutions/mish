import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCatalog } from '../src/build.ts';
import { readKit } from '../src/kit.ts';
import { applyOverrides, parseOverrides } from '../src/overrides.ts';
import type { CultCatalog } from '../src/types.ts';
import { catalogIssues } from '../src/validate.ts';
import { writeFixtureKit } from './helpers/fixture-kit.ts';

function fresh(): CultCatalog {
  return structuredClone(buildCatalog(readKit(writeFixtureKit()), {}));
}

function row(catalog: CultCatalog, name: string) {
  const found = catalog.rows.find((r) => r.name === name);
  assert.ok(found, `row ${name}`);
  return found;
}

test('duplicate ids are rejected', () => {
  const catalog = fresh();
  catalog.rows.splice(1, 0, structuredClone(catalog.rows[0]!));
  catalog.snapshot.expectedItems += 1;
  assert.ok(catalogIssues(catalog).some((i) => i.includes('duplicate id')));
});

test('unknown classifications are rejected', () => {
  const mutations: Array<(c: CultCatalog) => void> = [
    (c) => { (row(c, 'hero-alpha').taxonomy as { sectionKind: string }).sectionKind = 'splash'; },
    (c) => { (row(c, 'hero-alpha') as { assetKind: string }).assetKind = 'widget'; },
    (c) => { (row(c, 'hero-alpha').spineAffinities as string[]).push('XX'); },
    (c) => { (row(c, 'hero-alpha').taxonomy.components as string[]).push('spinner'); },
    (c) => { (row(c, 'hero-alpha').conversion as { status: string }).status = 'done'; },
  ];
  for (const mutate of mutations) {
    const catalog = fresh();
    mutate(catalog);
    assert.ok(catalogIssues(catalog).some((i) => i.includes('closed values')), 'expected a closed-value issue');
  }
});

test('a fetched row with a missing file hash is rejected', () => {
  const catalog = fresh();
  row(catalog, 'hero-alpha').source.files[0]!.sha256 = null;
  assert.ok(catalogIssues(catalog).some((i) => i.includes('a fetched row needs')));
});

test('insertable requires an adapter; app-only requires assetKind app', () => {
  const a = fresh();
  row(a, 'hero-alpha').conversion = { status: 'insertable' };
  assert.ok(catalogIssues(a).some((i) => i.includes('insertable status and an adapter')));
  const b = fresh();
  row(b, 'hero-alpha').conversion = { status: 'app-only', reason: 'x' };
  assert.ok(catalogIssues(b).some((i) => i.includes('app-only status')));
});

test('snapshot counts must match the rows', () => {
  const catalog = fresh();
  catalog.snapshot.fetchedItems += 1;
  assert.ok(catalogIssues(catalog).length > 0);
});

test('overrides apply last, need a note, and must name an existing row', () => {
  const catalog = fresh();
  const overrides = parseOverrides({
    overrides: { 'cult:pricing-beta': { note: 'reviewed: a plain price table', sectionKind: 'pricing', components: [] } },
  });
  const rows = applyOverrides(catalog.rows, overrides);
  const pricing = rows.find((r) => r.name === 'pricing-beta')!;
  assert.equal(pricing.taxonomy.sectionKind, 'pricing');
  assert.deepEqual(pricing.review, { fields: ['components', 'sectionKind'], note: 'reviewed: a plain price table' });
  assert.deepEqual(catalogIssues({ ...catalog, rows }), []);

  assert.throws(() => applyOverrides(catalog.rows, parseOverrides({ overrides: { 'cult:nope': { note: 'x' } } })), /no catalog row/);
  assert.throws(() => parseOverrides({ overrides: { 'cult:hero-alpha': { sectionKind: 'hero' } } }), /note is required/);
  assert.throws(() => parseOverrides({ overrides: { 'cult:hero-alpha': { note: 'x', title: 'y' } } }), /unknown field/);
  assert.throws(
    () => parseOverrides({ overrides: { 'cult:hero-alpha': { note: 'x', conversion: { status: 'insertable' } } } }),
    /cannot be set/,
  );
});

test('an override with an unknown classification is refused when parsed, and caught by the validator if applied', () => {
  assert.throws(() => parseOverrides({ overrides: { 'cult:hero-alpha': { note: 'x', sectionKind: 'splash' } } }), /sectionKind "splash"/);
  const catalog = fresh();
  const rows = applyOverrides(catalog.rows, { 'cult:hero-alpha': { note: 'x', sectionKind: 'splash' as never } });
  assert.ok(catalogIssues({ ...catalog, rows }).length > 0);
});
