/**
 * Derived rows (sections cut from a fetched page), plus the boundary hardening from the Cult
 * inventory audit: closed-list override values, stated reasons, nameless item files and file
 * target/type drift. Synthetic fixture data only.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCatalog, derivedBlockNames } from '../src/build.ts';
import { type ConvertedBlock } from '../src/converted.ts';
import { sectionKindForName, sectionTitle } from '../src/derived.ts';
import { catalogDrift } from '../src/drift.ts';
import { readKit } from '../src/kit.ts';
import { parseOverrides } from '../src/overrides.ts';
import type { CultCatalog } from '../src/types.ts';
import { catalogIssues } from '../src/validate.ts';
import { writeFixtureKit } from './helpers/fixture-kit.ts';

const PAGE_FILES = {
  'registry/pages/page-zeta/page.tsx': 'export default function P() { return null; }\n',
  'registry/pages/page-zeta/components/sections/hero.tsx': 'export function Hero() { return <h1>x</h1>; }\n',
  'registry/pages/page-zeta/components/sections/faq.tsx': "import { Accordion } from '@/components/ui/accordion';\nexport function Faq() { return null; }\n",
  'registry/pages/page-zeta/components/sections/shader-settings.tsx': 'export function S() { return null; }\n',
};

/** The fixture kit with `page-zeta` fetched and made of three section files. */
function kitWithPage(): string {
  const dir = writeFixtureKit();
  const indexPath = join(dir, 'registry', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { items: Array<{ name: string; files: unknown[] }> };
  const page = index.items.find((i) => i.name === 'page-zeta')!;
  page.files = Object.keys(PAGE_FILES).map((path) => ({ path, type: 'registry:component', target: path }));
  writeFileSync(indexPath, JSON.stringify(index));
  const files = Object.entries(PAGE_FILES).map(([path, content]) => ({ path, type: 'registry:component', target: path, content }));
  writeFileSync(join(dir, 'registry', 'page-zeta.json'), JSON.stringify({ ...page, files }));
  return dir;
}

const insertable = (name: string): ConvertedBlock => ({
  name,
  status: 'insertable',
  reasons: [],
  htmlMin: 100,
  cssMin: 200,
  sourceSha256: 'a'.repeat(64),
  adapterSource: 'export const ADAPTER = {\n  version: "1.0.0",\n};\n',
});

test('a fetched page yields one derived section row per section file', () => {
  const kit = readKit(kitWithPage());
  assert.deepEqual(derivedBlockNames(kit), ['page-zeta--faq', 'page-zeta--hero', 'page-zeta--shader-settings']);
  const converted = new Map([['page-zeta--hero', insertable('page-zeta--hero')]]);
  const catalog = buildCatalog(kit, {}, converted);
  assert.deepEqual(catalogIssues(catalog), []);
  assert.equal(catalog.snapshot.expectedItems, 7, 'derived rows are not registry items');
  assert.equal(catalog.snapshot.derivedRows, 3);

  const page = catalog.rows.find((r) => r.id === 'cult:page-zeta')!;
  const hero = catalog.rows.find((r) => r.id === 'cult:page-zeta--hero')!;
  assert.equal(hero.derivedFrom, 'cult:page-zeta');
  assert.equal(hero.assetKind, 'section');
  assert.equal(hero.taxonomy.sectionKind, 'hero');
  assert.equal(hero.title, 'Hero (page: page zeta)');
  assert.deepEqual(hero.source, page.source);
  assert.deepEqual(hero.rights, page.rights);
  assert.equal(hero.conversion.status, 'insertable');
  assert.deepEqual(hero.adapter, { id: 'cult:page-zeta--hero', version: '1.0.0', sourceSha256: 'a'.repeat(64) });
  assert.equal(hero.previewId, 'page-zeta--hero.webp');

  const faq = catalog.rows.find((r) => r.id === 'cult:page-zeta--faq')!;
  assert.equal(faq.taxonomy.sectionKind, 'faq');
  assert.deepEqual(faq.taxonomy.components, ['accordion'], 'components read the section file only');
  assert.equal(faq.conversion.status, 'unconverted');
  assert.equal(catalog.rows.find((r) => r.id === 'cult:page-zeta--shader-settings')!.taxonomy.sectionKind, 'unclassified');
});

test('the validator rejects a derived row that drifts from its page', () => {
  const base = buildCatalog(readKit(kitWithPage()), {});
  const mutate = (edit: (c: CultCatalog) => void): string[] => {
    const c = structuredClone(base);
    edit(c);
    return catalogIssues(c);
  };
  const hero = (c: CultCatalog) => c.rows.find((r) => r.id === 'cult:page-zeta--hero')!;
  assert.ok(mutate((c) => { hero(c).derivedFrom = 'cult:hero-alpha'; }).some((i) => i.includes('must name a page row')));
  assert.ok(mutate((c) => { hero(c).source.registrySha256 = 'b'.repeat(64); }).some((i) => i.includes("page's source")));
  assert.ok(mutate((c) => { c.snapshot.derivedRows = 2; }).some((i) => i.includes('derived rows')));
  assert.ok(mutate((c) => { delete hero(c).derivedFrom; }).some((i) => i.includes('source rows, expected')));
});

test('section names map onto the closed section kinds', () => {
  assert.equal(sectionKindForName('site-footer'), 'footer');
  assert.equal(sectionKindForName('primary-cta'), 'cta-band');
  assert.equal(sectionKindForName('how-it-works'), 'process-steps');
  assert.equal(sectionKindForName('social-proof'), 'logo-wall');
  assert.equal(sectionKindForName('pricing-table'), 'pricing');
  assert.equal(sectionKindForName('pattern-guide'), 'unclassified');
  assert.equal(sectionTitle('how-it-works'), 'How it works');
  assert.equal(sectionTitle('faq'), 'FAQ');
});

test('override values outside the closed lists are refused when the file is parsed', () => {
  const parse = (entry: Record<string, unknown>) => () => parseOverrides({ overrides: { 'cult:x': { note: 'n', ...entry } } });
  assert.throws(parse({ portQueue: 'banana' }), /portQueue "banana"/);
  assert.throws(parse({ assetKind: 'widget' }), /assetKind/);
  assert.throws(parse({ sectionKind: 'splash' }), /sectionKind/);
  assert.throws(parse({ conversion: { status: 'done' } }), /conversion.status/);
  assert.throws(parse({ conversion: { status: 'adapter-needed' } }), /needs a reason/);
  assert.doesNotThrow(parse({ portQueue: 'genui-port', conversion: { status: 'adapter-needed', reason: 'why' } }));
});

test('an adapter-needed or app-only row without a reason is invalid', () => {
  const catalog = structuredClone(buildCatalog(readKit(writeFixtureKit()), {}));
  const cta = catalog.rows.find((r) => r.name === 'cta-gamma')!;
  delete cta.conversion.reason;
  assert.ok(catalogIssues(catalog).includes('cult:cta-gamma: adapter-needed needs a stated reason'));
});

test('an item file with no item name is pending-fetch, not fatal', () => {
  const dir = writeFixtureKit();
  writeFileSync(join(dir, 'registry', 'hero-alpha.json'), '{}');
  const kit = readKit(dir);
  assert.equal(kit.issues.length, 0);
  assert.equal(kit.pending.get('hero-alpha'), 'registry item file is incomplete (no item name)');
  writeFileSync(join(dir, 'registry', 'hero-alpha.json'), JSON.stringify({ name: 'other', files: [] }));
  assert.ok(readKit(dir).issues.some((i) => i.includes('does not match')), 'a file naming another item stays fatal');
});

test('a changed file target or type is reported as drift', () => {
  const dir = writeFixtureKit();
  const committed = buildCatalog(readKit(dir), {});
  const fresh = structuredClone(committed);
  const file = fresh.rows.find((r) => r.name === 'hero-alpha')!.source.files[0]!;
  file.target = 'elsewhere.tsx';
  file.type = 'registry:page';
  const drift = catalogDrift(committed, fresh);
  assert.ok(drift.includes(`cult:hero-alpha: changed target for ${file.path}`), drift.join('\n'));
  assert.ok(drift.includes(`cult:hero-alpha: changed type for ${file.path}`));
});
