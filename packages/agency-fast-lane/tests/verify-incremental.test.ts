/**
 * Move 5 eval: incremental Jev verification on re-target.
 *
 * A synthetic 40-slot family (not a bundled one, so the slot count is exact and the test does not
 * drift if a bundled family's fixture grows a field): `brand` carries 2 text slots, and 19
 * sections each carry a `content.heading` and `content.body` — 2 + 19 * 2 = 40. `previous` stands
 * in for the project's current, already-published recipe; `next` is the same recipe with exactly
 * 3 of those 40 slots edited. `runFastLane` is given both (`spine: next, previousRecipe:
 * previous`), so `unchangedTextPaths` (src/spine.ts) should fold the other 37 into `lockedPaths`
 * and the run should ask the fake Jev checker about the 3 changed slots only — never all 40.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovedAsset, FamilyPackage, RenderResult } from '../src/family.ts';
import { collectFaithfulnessSlots } from '../src/jev.ts';
import type { FaithfulnessSlot } from '../src/jev.ts';
import { runFastLane } from '../src/run.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, fillTemplate } from './fixtures.ts';

const SECTION_COUNT = 19; // 2 (brand) + 19 * 2 (content.heading, content.body) = 40 editable slots

function recipeWith(fill: (sectionIndex: number, field: 'heading' | 'body') => string, brandName: string, brandDescriptor: string): JsonObject {
  return {
    schemaVersion: 2,
    family: 'synthetic',
    revision: 1,
    brand: { name: brandName, descriptor: brandDescriptor },
    destinations: {},
    sections: Array.from({ length: SECTION_COUNT }, (_, index) => ({
      id: `section-${index}`,
      type: 'generic',
      assets: {},
      content: { heading: fill(index, 'heading'), body: fill(index, 'body') },
    })),
  };
}

/** A render that never validates or throws: this test is about which slots reach Jev, not about a
 * real family compiler. `readAsset` is never called — `approvedAssets` is always empty. */
function render(input: Json, entry: string): RenderResult {
  return {
    recipe: input,
    html: `<html data-entry="${entry}"></html>`,
    manifest: { entry, supportingFiles: [], metadata: { agencySite: { recipeDigest: 'digest', revision: 'r1', family: 'synthetic' } } },
    approvedAssets: [],
  };
}

function syntheticPackage(fixture: JsonObject): FamilyPackage {
  return {
    family: 'synthetic',
    packageDir: '',
    fixture,
    schema: {},
    manifest: {},
    assetsDir: '',
    render,
    readAsset: (_asset: ApprovedAsset) => Promise.resolve(Buffer.from('')),
  };
}

test('a re-target with 3 of 40 slots changed sends only those slots (plus dependents) to Jev, never all 40', async () => {
  const previous = recipeWith((index, field) => `Published ${field} ${index}`, 'Published Brand', 'Published descriptor');
  // Sanity check on the fixture itself, via the SAME production slot-collection function Jev's
  // full-recipe check would use — not a hand-rolled count that could drift from what the code
  // actually considers an editable text slot.
  assert.equal(collectFaithfulnessSlots(previous).length, 40, 'fixture sanity: 40 editable slots');

  const next = structuredClone(previous) as JsonObject;
  // Exactly 3 of the 40 editable slots change: the brand name, one section heading, another
  // section's body. Nothing else moves.
  (next.brand as JsonObject).name = 'New Brand Name';
  ((next.sections as JsonObject[])[3]!.content as JsonObject).heading = 'New heading for section 3';
  ((next.sections as JsonObject[])[11]!.content as JsonObject).body = 'New body for section 11';

  const pkg = syntheticPackage(previous);
  const model = fakeModel();
  // fakeJevChecker (tests/fixtures.ts) flags text containing 'FABRICATED' — nothing here does — and
  // records the slot COUNT of every call in `slotCounts`, which is what this eval measures.
  const verify = fakeJevChecker();
  // A second, path-recording checker alongside the counting one, so the test also proves WHICH
  // three paths were sent, not just how many.
  const sentPaths: string[][] = [];
  const pathRecorder = {
    async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
      sentPaths.push(slots.map((slot) => slot.path));
      return verify.checkFaithfulness({ brief: '', slots });
    },
  };

  const report = await runFastLane({
    pkg,
    brief: 'Riverbend Dental. Update the brand name and two section lines; leave everything else as published.',
    mode: 'sections',
    entry: 'synthetic-r1.html',
    revision: 1,
    model,
    modelName: 'fake',
    spine: next,
    previousRecipe: previous,
    verify: pathRecorder,
  });

  assert.ok(report.verify, 'the verify step ran');
  assert.equal(verify.calls, 1, 'nothing was flagged, so there is no repair recheck call');
  assert.equal(verify.slotCounts[0], 3, `expected exactly 3 slots sent to Jev (3 changed, 0 dependents in this fixture), got ${verify.slotCounts[0]}`);
  assert.ok(verify.slotCounts[0]! <= 3, 'never the whole 40-slot recipe');
  assert.equal(report.verify!.checked, 3);

  assert.deepEqual(new Set(sentPaths[0]), new Set(['brand.name', 'sections[3].content.heading', 'sections[11].content.body']));

  // The 37 untouched slots kept their published text exactly — the fill step skipped them too,
  // not just the faithfulness check (locked paths are dropped from the model's template and
  // `mergeIntoSpine` refuses to overwrite them even if the model answered anyway).
  const recipe = report.recipe as JsonObject;
  const sections = recipe.sections as JsonObject[];
  assert.equal((sections[0]!.content as JsonObject).heading, 'Published heading 0', 'an untouched slot keeps its published text verbatim');
  assert.equal((sections[3]!.content as JsonObject).body, 'Published body 3', "the untouched half of a partly-changed section's unit stays published text");
  // The 3 changed slots were actually re-filled by the model, not left at the `next` scaffold text.
  assert.notEqual((recipe.brand as JsonObject).name, 'Published Brand');
});

test('the post-repair recheck also sends only the changed slots, not all 40', async () => {
  // Same 3-of-40 re-target as above, but the model fabricates the brand name, so Jev flags it,
  // `repairUnit` re-asks for the brand unit, and `runFastLane` rechecks with a second
  // `checkFaithfulness` call (see run.ts's `recheck`). That recheck recomputes
  // `collectFaithfulnessSlots(working, lockedPaths)` from scratch — the same `lockedPaths` as the
  // initial check — so it must stay at 3, not fall back to all 40.
  const previous = recipeWith((index, field) => `Published ${field} ${index}`, 'Published Brand', 'Published descriptor');
  const next = structuredClone(previous) as JsonObject;
  (next.brand as JsonObject).name = 'New Brand Name';
  ((next.sections as JsonObject[])[3]!.content as JsonObject).heading = 'New heading for section 3';
  ((next.sections as JsonObject[])[11]!.content as JsonObject).body = 'New body for section 11';

  const pkg = syntheticPackage(previous);
  const model = fakeModel({
    // `firstAnswer` only runs on the FIRST (non-repair) call for a unit, exactly like
    // run.test.ts's own fabricated-slot test: the repair call falls through to the default fill,
    // so the model actually corrects itself on repair rather than fabricating forever. The brand
    // unit's own template root is `{ name, descriptor }` (see `unitsOf`: its `template` is
    // `template.brand` directly, not nested under a `brand` key) — that shape is how this finds
    // "this is the brand unit's call" without depending on call order across the 20 units.
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      if (isObject(template) && 'name' in template) filled.name = 'FABRICATED brand name';
      return filled;
    },
  });
  const verify = fakeJevChecker();

  const report = await runFastLane({
    pkg,
    brief: 'Riverbend Dental. Update the brand name and two section lines; leave everything else as published.',
    mode: 'sections',
    entry: 'synthetic-r1.html',
    revision: 1,
    model,
    modelName: 'fake',
    spine: next,
    previousRecipe: previous,
    verify,
  });

  assert.equal(verify.calls, 2, 'one check after fill, one recheck after the repair — same as the non-incremental case');
  assert.deepEqual(verify.slotCounts, [3, 3], 'both the initial check and the post-repair recheck stay at 3 slots, never falling back to 40');
  assert.equal(report.verify!.repaired, 1);
  assert.deepEqual(report.verify!.remaining, []);
  assert.ok(!((report.recipe as JsonObject).brand as JsonObject).name?.toString().includes('FABRICATED'));
});

test('a nullable slot still null on both sides of the diff is still filled by the model, not locked away', async () => {
  // Regression guard for the critical review finding on `unchangedTextPaths` (src/spine.ts):
  // reading `null === null` as "unchanged" and folding a still-empty nullable slot into
  // `lockedPaths`. `editableTemplate` drops a locked path entirely (not kept-as-null the way an
  // unlocked null is), so that lock would silently and permanently hide the slot from the model
  // on every future re-target, even once the new brief supplies the missing value. Unlike the
  // `unchangedTextPaths`-only unit test in spine.test.ts, this drives the real pipeline
  // (`unchangedTextPaths` -> `lockedPaths` -> `editableTemplate` -> the prompt -> `mergeIntoSpine`
  // -> the final recipe), mirroring the finding's own end-to-end repro, so a regression
  // reintroduced anywhere in that chain is still caught, not just in `unchangedTextPaths` itself.
  const previous = recipeWith((index, field) => `Published ${field} ${index}`, 'Published Brand', 'Published descriptor');
  // Section 0 carries a nullable `phone` slot an earlier run left empty (no phone number was in
  // the original brief). The spine itself is structural — only the model ever writes text — so
  // this stays a literal `null` in both `previous` and `next` below.
  ((previous.sections as JsonObject[])[0]!.content as JsonObject).phone = null;

  const next = structuredClone(previous) as JsonObject;
  // Some OTHER slot in the same section changes too, exactly as the finding's own scenario
  // requires, so section 0's unit is still built and sent to the model.
  ((next.sections as JsonObject[])[0]!.content as JsonObject).heading = 'New heading for section 0';

  const pkg = syntheticPackage(previous);
  // `fillTemplate`'s default fill never even calls back for a `null` leaf (it passes `null`
  // through untouched, same as a real model choosing not to answer), so a fake model that WOULD
  // fill the phone slot if offered it needs `firstAnswer` to write it explicitly — this stands in
  // for "the model read the brief's phone number and answered the slot it was shown."
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      const content = isObject(template) ? (template.content as JsonObject | undefined) : undefined;
      if (content && 'phone' in content) (filled.content as JsonObject).phone = '555-1234';
      return filled;
    },
  });
  const verify = fakeJevChecker();

  const report = await runFastLane({
    pkg,
    brief: 'Update section 0 and add the phone number for Section Zero: 555-1234.',
    mode: 'sections',
    entry: 'synthetic-r1.html',
    revision: 1,
    model,
    modelName: 'fake',
    spine: next,
    previousRecipe: previous,
    verify,
  });

  const recipe = report.recipe as JsonObject;
  const sectionZero = (recipe.sections as JsonObject[])[0]!.content as JsonObject;
  assert.equal(sectionZero.phone, '555-1234', 'a still-null nullable slot must still reach the model and accept the new brief\'s answer, not stay locked at null forever');
});
