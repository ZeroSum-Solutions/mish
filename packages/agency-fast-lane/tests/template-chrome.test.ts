import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';
import { collectFaithfulnessSlots, type FaithfulnessSlot } from '../src/jev.ts';
import { labelPathsFor, type Json, type JsonObject } from '../src/spine.ts';
import { copyrightMatchesReference, isCopyrightLine, isUnitToken, templateChromePaths } from '../src/template-chrome.ts';

/** The slots these tests' family schema would declare `x-label` (see spine.ts's `labelPathsFor`). */
const LABELS: ReadonlySet<string> = new Set(['sections[0].content.block3Key3', 'sections[0].content.block4Key1']);

/** The gate's candidates for `filled`, exactly as run.ts computes them. */
const candidates = (filled: Json, reference: Json, labels: ReadonlySet<string> = LABELS) => collectFaithfulnessSlots(filled, templateChromePaths(filled, reference, labels)).map((slot) => slot.path);

const reference: Json = {
  brand: { name: 'TestInstitution' },
  sections: [
    { id: 'visit', type: 'visit', content: { block3Key3: 'Postcode', block3Value3: 'EC1A 1BB', block4Key1: 'Bus', block4Value1: 'Routes 8, 25 and 242' } },
    { id: 'membership', type: 'membership', content: { price: '$120', period: 'per year', note: 'Free entry to every exhibition' } },
    { id: 'footer', type: 'footer', content: { copyright: '© 2026 TestInstitution. All rights reserved.' } },
  ],
};

test('a template label is not a fact; the fabricated number beside it is the only candidate', () => {
  const filled: Json = {
    brand: { name: 'Riverbend Studios' },
    sections: [
      { id: 'visit', type: 'visit', content: { block3Key3: 'Postcode', block3Value3: '28801' } },
    ],
  };
  const ref: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'visit', type: 'visit', content: { block3Key3: 'Postcode', block3Value3: 'EC1A 1BB' } }] };
  assert.deepEqual(candidates(filled, ref), ['brand.name', 'sections[0].content.block3Value3']);
});

test('an unchanged label and the re-branded copyright line are chrome; amounts, changed units and added claims are still checked', () => {
  const filled: Json = {
    brand: { name: 'Riverbend Studios' },
    sections: [
      { id: 'visit', type: 'visit', content: { block3Key3: 'Postcode', block3Value3: '28801', block4Key1: 'Bus', block4Value1: 'Routes 8, 25 and 242' } },
      { id: 'membership', type: 'membership', content: { price: '$600', period: 'per month', note: 'Free entry to every exhibition' } },
      { id: 'footer', type: 'footer', content: { copyright: '© 2026 Riverbend Studios. All rights reserved.' } },
    ],
  };
  assert.deepEqual(candidates(filled, reference), [
    'brand.name',
    'sections[0].content.block3Value3',
    // A reference fact copied verbatim carries digits, so it is still a fact.
    'sections[0].content.block4Value1',
    'sections[1].content.price',
    // A unit the fill changed ('per year' in the reference) is not left-as-written chrome.
    'sections[1].content.period',
    // Longer than a label: still checked, even though it equals the reference.
    'sections[1].content.note',
  ]);
});

test('a copyright line with an invented year or an altered brand is a candidate', () => {
  const at = (copyright: string, brand = 'Riverbend Studios') => candidates(
    { brand: { name: brand }, sections: [{ id: 'footer', type: 'footer', content: { copyright } }] },
    { brand: { name: 'TestInstitution' }, sections: [{ id: 'footer', type: 'footer', content: { copyright: '© 2026 TestInstitution. All rights reserved.' } }] },
  ).filter((path) => path !== 'brand.name');
  assert.deepEqual(at('© 2019 Riverbend Studios. All rights reserved.'), ['sections[0].content.copyright'], 'invented year');
  assert.deepEqual(at('© 2019–2026 Riverbend Studios. All rights reserved.'), ['sections[0].content.copyright'], 'invented founding year');
  assert.deepEqual(at('© 2026 Riverbend Studios Ltd. All rights reserved.'), ['sections[0].content.copyright'], 'altered brand');
  // Unchanged apart from the brand swap (and whitespace): chrome.
  assert.deepEqual(at('©  2026 Riverbend Studios.  All rights reserved.'), []);
});

test('an unchanged copyright line is chrome', () => {
  const recipe: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'footer', type: 'footer', content: { copyright: '© 2026 TestInstitution. All rights reserved.' } }] };
  assert.deepEqual(candidates(recipe, recipe).filter((path) => path !== 'brand.name'), []);
});

test('a unit token that replaced a numeric reference value is a candidate; an unchanged unit is chrome', () => {
  const ref: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'membership', type: 'membership', content: { price: '$120', period: 'per year' } }] };
  const replaced: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'membership', type: 'membership', content: { price: 'per month', period: 'per year' } }] };
  assert.deepEqual(candidates(replaced, ref).filter((path) => path !== 'brand.name'), ['sections[0].content.price']);
  assert.deepEqual(candidates(ref, ref).filter((path) => path !== 'brand.name'), ['sections[0].content.price'], 'the unchanged period is chrome; the price is a fact');
});

test('the copyright rule only drops the plain line for this brand', () => {
  assert.equal(isCopyrightLine('© 2026 Riverbend Studios. All rights reserved.', 'Riverbend Studios'), true);
  assert.equal(isCopyrightLine('Copyright 2019–2026 Riverbend Studios', 'Riverbend Studios'), true);
  assert.equal(isCopyrightLine('© 2026 TestInstitution. All rights reserved.', 'Riverbend Studios'), false);
  assert.equal(isCopyrightLine('© 2026 Riverbend Studios, established 1998', 'Riverbend Studios'), false);
  assert.equal(isCopyrightLine('Riverbend Studios 2026', 'Riverbend Studios'), false);
});

test('unit tokens are whole-text only', () => {
  for (const unit of ['per month', 'Per Year', '/mo', 'a night', 'Monthly']) assert.equal(isUnitToken(unit), true, unit);
  for (const text of ['$5 per month', 'per month for students', 'Month of events']) assert.equal(isUnitToken(text), false, text);
});

test('an unchanged "Free" admission price is a fact candidate, not a label', () => {
  // TestInstitution's reference fixture: block2Value3 and block2Value4 are "Free" (reference.fixture.json).
  const recipe: Json = {
    brand: { name: 'TestInstitution' },
    sections: [{ id: 'visit', type: 'visit', content: { block2Key3: 'Students', block2Value3: 'Free', block2Title: 'Admission' } }],
  };
  const labels = new Set(['sections[0].content.block2Key3', 'sections[0].content.block2Title']);
  assert.deepEqual(candidates(recipe, recipe, labels).filter((path) => path !== 'brand.name'), ['sections[0].content.block2Value3']);
});

test('an unchanged declared label is chrome; the same text at an undeclared path is a candidate', () => {
  const recipe: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'visit', type: 'visit', content: { block3Key3: 'Postcode', block4Key1: 'Bus' } }] };
  assert.deepEqual(candidates(recipe, recipe).filter((path) => path !== 'brand.name'), []);
  assert.deepEqual(candidates(recipe, recipe, new Set()).filter((path) => path !== 'brand.name'), ['sections[0].content.block3Key3', 'sections[0].content.block4Key1']);
});

test('an unchanged reference city or person name is a fact candidate', () => {
  const recipe: Json = {
    brand: { name: 'TestContractor' },
    sections: [{ id: 'footer', type: 'footer', content: { area1: 'Raleigh', owner: 'Ana Ruiz', block3Key3: 'Postcode' } }],
  };
  assert.deepEqual(candidates(recipe, recipe).filter((path) => path !== 'brand.name'), ['sections[0].content.area1', 'sections[0].content.owner']);
});

test('a declared label the fill changed is a candidate', () => {
  const ref: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'visit', type: 'visit', content: { block3Key3: 'Postcode' } }] };
  const filled: Json = { brand: { name: 'TestInstitution' }, sections: [{ id: 'visit', type: 'visit', content: { block3Key3: 'Zip' } }] };
  assert.deepEqual(candidates(filled, ref).filter((path) => path !== 'brand.name'), ['sections[0].content.block3Key3']);
});

test('the reference brand is swapped case-insensitively in the copyright comparison', () => {
  assert.equal(copyrightMatchesReference('© 2026 Riverbend. All rights reserved.', '© 2026 TESTINSTITUTION. All rights reserved.', 'Riverbend', 'TestInstitution'), true);
  assert.equal(copyrightMatchesReference('© 2026 Price$1. All rights reserved.', '© 2026 TestInstitution. All rights reserved.', 'Price$1', 'TestInstitution'), true, 'a $ in the brand is literal');
});

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/_official/examples');
const familyFile = (family: string, file: string) => JSON.parse(readFileSync(path.join(EXAMPLES, `agency-${family}`, 'compiler/scripts/families', family, file), 'utf8')) as JsonObject;
const FAMILIES = ['app-shell', 'crm-dashboard', 'listings', 'marketing-site', 'nonprofit', 'publication', 'practice'];

test('an admission fixture keeps free prices as facts and declared row labels as chrome', () => {
 const fixture: JsonObject = {brand:{name:'Fixture'},sections:[{id:'visit',type:'visit',content:{price:'Free',label:'Postcode'}}]};
 const schema: JsonObject = {properties:{sections:{prefixItems:[{properties:{content:{properties:{price:{type:'string'},label:{type:'string','x-label':true}}}}}]}}};
 const labels=labelPathsFor(schema,fixture);const got=candidates(fixture,fixture,labels);
 assert(got.includes('sections[0].content.price'));assert(!got.includes('sections[0].content.label'));
});

test('every family declares its template labels with x-label, and only on label-shaped reference text', () => {
  for (const family of FAMILIES) {
    const fixture = familyFile(family, 'reference.fixture.json');
    const labels = labelPathsFor(familyFile(family, 'recipe.schema.json'), fixture);
    assert.ok(labels.size > 0, `${family} declares no x-label slot`);
    // A declared label never sits under brand.* (the client's own identity).
    for (const label of labels) assert.equal(label.startsWith('brand'), false, `${family}: ${label}`);
  }
});

// ---------------------------------------------------------------------------
// g6-sol-r12: the x-heading chrome category (isClaimBearingHeading, headingPathsFor, the
// "x-heading" schema markers) is REMOVED entirely — see template-chrome.ts's own module
// docblock for why. Sol's own closure review of the g6-sol-r11 audit found the mechanism
// COULD bypass a main-flagged claim: an in-memory "Ships nationwide" at ownedinstitution's declared
// title path (sections[6].content.title, the "visit" section) satisfied every one of
// isClaimBearingHeading's tests and so was exempted from the faithfulness gate entirely,
// while main (which has never had this mechanism) flags it as an unsupported claim. This
// replaces the old tripwire (which only re-checked 16 hardcoded strings against
// isClaimBearingHeading directly and never read live fixture text through the real,
// production templateChromePaths call) with a must-flag test that proves the REMOVAL: with
// no heading exemption left at all, "Ships nationwide" at that exact declared path is a
// faithfulness candidate on the branch, and deterministicSentenceClaimFlags flags it — the
// SAME result main's own (unmodified) deterministicSentenceClaimFlags produces on the
// identical brief/slot (1 flag, checked against origin/main in the Sol closure review)
// .
// ---------------------------------------------------------------------------

test('g6-sol-r12: "Ships nationwide" at a public practice heading path is no longer chrome, and flags exactly as on main', async () => {
  const pkg = await loadFamilyPackage(defaultPackageDir('practice'), 'practice');
  const brief = 'Riverbend Dental, a local dental practice.';
  const fixture = structuredClone(pkg.fixture) as JsonObject;
  const sections = fixture.sections as JsonObject[];
  const visitIndex = 1;
  const visitContent = sections[visitIndex]!.text as JsonObject;
  visitContent.heading = 'Ships nationwide';
  const slotPath = `sections[${visitIndex}].text.heading`;

  const labelPaths = labelPathsFor(pkg.schema, fixture);
  const chromePaths = templateChromePaths(fixture, fixture, labelPaths);
  assert.equal(chromePaths.has(slotPath), false, '"Ships nationwide" must be a faithfulness candidate now — no heading exemption exists to hide it');

  const slot: FaithfulnessSlot = { path: slotPath, text: 'Ships nationwide' };
  const paths = new Set([slotPath]);

  // main's own deterministicSentenceClaimFlags flags this exact brief/slot once (verified by the
  // g6-sol closure review against origin/main). CI checkouts have no origin/main ref, so assert
  // that count directly rather than loading main's source.
  const { deterministicSentenceClaimFlags } = await import('../src/jev.ts');
  const branchFlags = deterministicSentenceClaimFlags(brief, [slot], paths);
  assert.equal(branchFlags.length, 1, 'the branch must flag "Ships nationwide" exactly as main does (1 flag), with no heading exemption left to diverge on');
});
