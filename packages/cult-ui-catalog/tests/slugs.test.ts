import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assignCultSlugs, CULT_PUBLIC_SLUG, isCultBrandFree } from '@mish/contracts';

import { SLUGS_SCHEMA, slugManifestText, type SlugManifest } from '../scripts/slugs.ts';
import type { CultCatalog } from '../src/types.ts';

const catalog = JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')) as CultCatalog;
const committedText = readFileSync(new URL('../generated/slugs.json', import.meta.url), 'utf8');
const committed = JSON.parse(committedText) as SlugManifest;

test('every row has exactly one public slug, and the committed file is current', () => {
  assert.equal(committed.schema, SLUGS_SCHEMA);
  assert.deepEqual(Object.keys(committed.items).sort(), catalog.rows.map((row) => row.id).sort());
  assert.equal(slugManifestText(catalog, committed.items), committedText);
});

test('slugs are unique, well-formed, brand-free, and never another row\'s internal name', () => {
  const slugs = Object.values(committed.items);
  assert.equal(new Set(slugs).size, slugs.length);
  const owners = new Map(catalog.rows.map((row) => [row.name, row.id]));
  for (const [id, slug] of Object.entries(committed.items)) {
    assert.match(slug, CULT_PUBLIC_SLUG, id);
    assert.ok(isCultBrandFree(slug), `${id} → ${slug}`);
    const owner = owners.get(slug);
    assert.ok(owner === undefined || owner === id, `${slug} is ${owner}'s internal name`);
  }
});

test('slugs are stable: regenerating from scratch or from the committed file gives the same result', () => {
  assert.deepEqual(assignCultSlugs(catalog.rows), committed.items);
  assert.deepEqual(assignCultSlugs([...catalog.rows].reverse(), committed.items), committed.items);
});

test('a row keeps its slug when another row with the same title base arrives', () => {
  const rows = [
    { id: 'cult:b-pricing', name: 'b-pricing', title: 'Marketing Pricing Vercel' },
  ];
  const first = assignCultSlugs(rows);
  assert.deepEqual(first, { 'cult:b-pricing': 'pricing-series-v' });
  const grown = assignCultSlugs([{ id: 'cult:a-pricing', name: 'a-pricing', title: 'Pricing Vercel' }, ...rows], first);
  assert.equal(grown['cult:b-pricing'], 'pricing-series-v');
  assert.equal(grown['cult:a-pricing'], 'pricing-series-v-2');
});

test('a slug never takes another row\'s internal name', () => {
  const slugs = assignCultSlugs([
    { id: 'cult:hero', name: 'hero', title: 'Split' },
    { id: 'cult:marketing-hero-x', name: 'marketing-hero-x', title: 'Marketing Hero' },
  ]);
  assert.equal(slugs['cult:marketing-hero-x'], 'hero-2');
  assert.equal(slugs['cult:hero'], 'split');
});
