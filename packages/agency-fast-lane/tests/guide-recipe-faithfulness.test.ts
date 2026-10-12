/**
 * Standing faithfulness check: run the SAME deterministic gates `run.ts`'s `makeCheckOnce` runs at
 * build time (`deterministicContactFlags` for the plan-a-visit `url`, `deterministicTraceableFlags`
 * for every free-prose fact row, and — since round 4 — `deterministicSentenceClaimFlags` for the
 * places-to-see `body` slots, now that `guide` is in `run.ts`'s `SENTENCE_CLAIM_FAMILIES`) over
 * every COMMITTED guide recipe, against that recipe's own documented source brief — so a hand-
 * edited or stale golden fixture can reintroduce exactly the class of bug those gates exist to
 * catch at build time (an invented plan-a-visit URL, practical fact, place, descriptor, count or
 * distance claim) without ever going through a live build to be caught. Mirrors
 * `practice-recipe-faithfulness.test.ts` and `storefront`'s own faithfulness test; see those
 * tests' own docblocks for the full rationale (the round-2 Grok audit finding it responds to, for
 * guide) and for the scope note below.
 *
 * This family has no person-name or quote slots (`slots.ts` declares none), so
 * `personNamePathsFor`/`quotePathsFor` would both return empty sets for this recipe's schema and
 * are omitted rather than called for their own sake.
 *
 * A recipe here is only checked when a source-brief file for it exists (see `RECIPES` below); one
 * is added whenever a committed recipe's own brief can be documented.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { collectFaithfulnessSlots, deterministicClaimFlags, deterministicContactFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags } from '../src/jev.ts';
import { contactPathsFor, editableTemplate, labelPathsFor, traceablePathsFor } from '../src/spine.ts';

const GUIDE_DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-guide');
const GUIDE_SCRIPTS = path.join(GUIDE_DIR, 'compiler/scripts/families/guide');

/** Every committed guide recipe with a documented source brief, as `[recipe label, brief file]`. */
const RECIPES: readonly [string, string][] = [
  ['reference.fixture.json (the package default spine)', 'reference.fixture.brief.txt'],
];

const pkg = await loadFamilyPackage(GUIDE_DIR, 'guide');

for (const [label, briefFile] of RECIPES) {
  test(`guide's committed recipe ${label} is faithful to its own documented source brief: no contact-atom, traceable or sentence-claim gate flags anything`, () => {
    const brief = readFileSync(path.join(GUIDE_SCRIPTS, briefFile), 'utf8');
    // The reference fixture IS the package's own default spine (`pkg.fixture`), so its own shape
    // doubles as the template `contactPathsFor`/`traceablePathsFor` need.
    const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
    const contactPaths = contactPathsFor(pkg.schema, template);
    const traceablePaths = traceablePathsFor(pkg.schema, template);
    const slots = collectFaithfulnessSlots(pkg.fixture);
    // `run.ts`'s real `checkSlots` excludes template CHROME (an `x-label` field whose value is
    // still the template's own unchanged default) before running any deterministic gate — this
    // fixture IS the package's own default template, so practical-facts' own fixed category
    // labels ("Getting there", "Best time to visit", …) are template chrome here, the same way
    // `practice-recipe-faithfulness.test.ts` excludes its process-step numbering. Excluded here so
    // this test measures the same bar a live build does.
    const labelPaths = labelPathsFor(pkg.schema, template);
    const allSlotPaths = new Set(slots.map((slot) => slot.path).filter((path) => !labelPaths.has(path)));

    const contactFlagged = deterministicContactFlags(brief, slots, contactPaths);
    assert.deepEqual(contactFlagged, [], `${label} carries a plan-a-visit URL its own documented brief does not: ${JSON.stringify(contactFlagged)}`);

    const traceableFlagged = deterministicTraceableFlags(brief, slots, traceablePaths);
    assert.deepEqual(traceableFlagged, [], `${label} carries a practical fact, place, gallery label or descriptor its own documented brief does not support: ${JSON.stringify(traceableFlagged)}`);

    // Round-4 Grok audit (guide-r2): `deterministicClaimFlags` (the unconditional, family-wide
    // numeric/currency/rating gate `run.ts` always runs, not gated by SENTENCE_CLAIM_FAMILIES)
    // was never called here before — added so the "false-positive = 0" claim covers it too.
    const claimFlagged = deterministicClaimFlags(brief, slots, allSlotPaths);
    assert.deepEqual(claimFlagged, [], `${label} carries a price, number, percent or rating its own documented brief does not support: ${JSON.stringify(claimFlagged)}`);

    // guide is in `run.ts`'s `SENTENCE_CLAIM_FAMILIES` as of round 4: places-to-see `body` is free
    // prose (not whole-field traceable), so this is the deterministic gate standing between an
    // invented count/distance/time claim and a published page — checked here the same way run.ts
    // checks it at build time (every slot path, not just the traceable ones).
    const sentenceFlagged = deterministicSentenceClaimFlags(brief, slots, allSlotPaths);
    assert.deepEqual(sentenceFlagged, [], `${label} carries a claim-bearing sentence (a count, distance or time claim) its own documented brief does not support: ${JSON.stringify(sentenceFlagged)}`);
  });
}

/**
 * Round 4 (coordinator review): `brand.descriptor` stays `x-verify: 'traceable'` when PRESENT
 * (only nullability was added, per `BRAND_SLOTS`'s own doc in slots.ts — the coordinator
 * explicitly rejected dropping the trace requirement, since the round-1 finding this field's
 * traceable marker exists to catch, an invented "amber-coast" claim, carries no count/distance/
 * time signal `deterministicSentenceClaimFlags` could ever reach). This proves the SAME gate this
 * file's own sweep above runs (0 flags on the real, faithful fixture) still catches a genuinely
 * invented descriptor when one is substituted in.
 */
test("an invented brand.descriptor (a plausible-sounding place claim the brief never states) is flagged by the traceable gate, not published", async () => {
  const brief = readFileSync(path.join(GUIDE_SCRIPTS, 'reference.fixture.brief.txt'), 'utf8');
  const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
  const traceablePaths = traceablePathsFor(pkg.schema, template);
  assert.ok(traceablePaths.has('brand.descriptor'), 'brand.descriptor is still traced when present');

  const invented = structuredClone(pkg.fixture) as { brand: { descriptor: string } };
  invented.brand.descriptor = 'A small fishing town on the amber-coast, famous for its lighthouse festival.';
  const slots = collectFaithfulnessSlots(invented);
  const flagged = deterministicTraceableFlags(brief, slots, traceablePaths);
  assert.ok(flagged.some((flag) => flag.path === 'brand.descriptor'), `an invented descriptor must flag; got ${JSON.stringify(flagged)}`);
});
