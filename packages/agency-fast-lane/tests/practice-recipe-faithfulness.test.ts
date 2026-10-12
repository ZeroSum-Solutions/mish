/**
 * Standing faithfulness check: run the SAME deterministic gates `run.ts`'s `makeCheckOnce` runs
 * at build time (`deterministicAttributionFlags`, `deterministicQuoteFlags`,
 * `deterministicDestinationFlags`, `deterministicHoursLabelFlags`) over every COMMITTED practice
 * recipe, against that recipe's own documented source brief — so a hand-edited or stale golden
 * fixture can reintroduce exactly the class of bug those gates exist to catch at build time (an
 * invented name, quote, phone, URL or hours day) without ever going through a live build to be
 * caught. The round-2 Grok audit prompted this: it reported the storefront family already needed
 * this same class of fix once, on a committed recipe no build-time run ever re-checked.
 *
 * A recipe here is only checked when a source-brief file for it exists (see `RECIPES` below);
 * one is added whenever a committed recipe's own brief can be documented.
 *
 * SCOPE, STATED PLAINLY: this runs the four original DETERMINISTIC gates — a name, an attributed
 * quote, a book/contact destination, and an hours day label — PLUS, since a final Grok audit
 * opted `practice` into `deterministicSentenceClaimFlags` (`run.ts`'s `SENTENCE_CLAIM_FAMILIES`,
 * the same wiring `storefront` already used), every CLAIM-BEARING sentence (one carrying a digit,
 * a number word, a currency/percent/star mark, or a commercial stem such as "free"/
 * "complimentary") across every slot. That closes the specific gap the round-3 Grok audit found
 * in this fixture (a false commercial or numeric claim in free prose) but not the wider one: a
 * NON-claim-bearing sentence ("orthodontic referrals", "licensed in Oregon") still has no
 * deterministic check at all, because honest descriptive prose is supposed to PARAPHRASE facts,
 * not quote them, and the only candidate mechanism for a full prose check
 * (`deterministicQuoteFlags`'s verbatim-word-run matching) would flag ordinary honest paraphrasing
 * as unfaithful as readily as real invention. This is the SAME class of gap the round-2 audit
 * response left open for live builds (the Cerebras "meet our hygienist, Sofia Reyes" case,
 * `proof/family-practice.txt` section 12) — non-claim free-prose fabrication with no deterministic
 * gate — and it is left open here for the same reason: a real fix needs either a genuinely new
 * deterministic technique or a stricter Jev question, not a hasty misapplication of the quote
 * gate, and it is a cross-cutting problem bigger than one committed fixture.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { collectFaithfulnessSlots, deterministicAttributionFlags, deterministicClaimFlags, deterministicDestinationFlags, deterministicHoursLabelFlags, deterministicQuoteFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags } from '../src/jev.ts';
import { destinationPathsFor, editableTemplate, getAtPath, hoursLabelPathsFor, hoursRowValuePathsFor, labelPathsFor, personNamePathsFor, quotePathsFor, traceablePathsFor } from '../src/spine.ts';

const PRACTICE_DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-practice');
const PRACTICE_SCRIPTS = path.join(PRACTICE_DIR, 'compiler/scripts/families/practice');

/** Every committed practice recipe with a documented source brief, as `[recipe label, brief file]`. */
const RECIPES: readonly [string, string][] = [
  ['reference.fixture.json (the package default spine)', 'reference.fixture.brief.txt'],
];

const pkg = await loadFamilyPackage(PRACTICE_DIR, 'practice');

for (const [label, briefFile] of RECIPES) {
  test(`practice's committed recipe ${label} is faithful to its own documented source brief: no name, quote, destination, or hours-label gate flags anything`, () => {
    const brief = readFileSync(path.join(PRACTICE_SCRIPTS, briefFile), 'utf8');
    // The reference fixture IS the package's own default spine (`pkg.fixture`), so its own shape
    // doubles as the template `*PathsFor` needs; a future second committed recipe with a
    // DIFFERENT shape (a dropped optional section, a shorter array) would instead build its own
    // template from its own recipe JSON the same way.
    const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
    const personNamePaths = personNamePathsFor(pkg.schema, template);
    const quotePaths = quotePathsFor(pkg.schema, template);
    const destinationPaths = destinationPathsFor(pkg.schema, template);
    const hoursLabelPaths = hoursLabelPathsFor(pkg.schema, template);
    const traceablePaths = traceablePathsFor(pkg.schema, template);
    const slots = collectFaithfulnessSlots(pkg.fixture);
    // `run.ts`'s real `checkSlots` excludes template CHROME (an `x-label` field whose value is
    // still the template's own unchanged default — see `templateChromePaths`) from every
    // deterministic gate before it runs, not just the narrow ones with their own path set. This
    // reference fixture IS the package's own default template, so every label field's value here
    // is, by definition, still that template default (practice's process-step "Step 1"/"Step
    // 2"/"Step 3": fixed UI numbering, never a brief-stated fact) — excluded the same way here so
    // this test measures the SAME thing a live build would, not a stricter, unreachable bar.
    const labelPaths = labelPathsFor(pkg.schema, template);
    const allSlotPaths = new Set(slots.map((slot) => slot.path).filter((path) => !labelPaths.has(path)));

    // Round-4 Grok audit (guide-r2): this test previously never called `deterministicTraceableFlags`
    // or `deterministicClaimFlags` at all, so the fixture's own "Including Delta Dental, Cigna and
    // MetLife; our front desk verifies your benefits before you're billed." insurance detail
    // (traceable, `slots.ts`) stayed green here while it false-flagged the LIVE build gate — the
    // exact class of drift this whole file exists to catch. Both are now called, turning the
    // "false-positive = 0" claim into something CI actually enforces rather than only claims.
    const flagged = [
      ...deterministicAttributionFlags(brief, slots, personNamePaths),
      ...deterministicQuoteFlags(brief, slots, quotePaths),
      ...deterministicDestinationFlags(brief, slots, destinationPaths),
      // Each hours label with its row value (`x-hours-value`), as run.ts reads it.
      ...deterministicHoursLabelFlags(brief, slots, hoursLabelPaths, hoursRowValuePathsFor(pkg.schema, template), (label) => {
        const value = getAtPath(pkg.fixture, [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]!)));
        return typeof value === 'string' || value === null ? value : undefined;
      }),
      ...deterministicTraceableFlags(brief, slots, traceablePaths),
      ...deterministicClaimFlags(brief, slots, allSlotPaths),
      ...deterministicSentenceClaimFlags(brief, slots, allSlotPaths),
    ];
    // g6-r3-opus55 audit (FIX F2 — "most" added to isClaimBearingSentence as a superlative
    // signal): "We work with most major PPO plans and offer a straightforward cash-pay option for
    // routine care." (sections[7].text.body) is now claim-bearing for the first time, purely on
    // "most" used as an ordinary quantifier — not a superlative of standing the fix was aimed at —
    // and fails to trace on unrelated words ("straightforward"/"cash"/"pay"/"option"/"routine").
    // This is the SAME residual `claim-name-honesty-all-families.test.ts`'s `KNOWN_RESIDUAL_FLAGS`
    // tracks as `practice:sections[7].text.body` (a paraphrase FP — measured honestly, per the
    // audit's own instruction not to narrow the new signal just to keep this count low).
    const KNOWN_RESIDUAL = 'sections[7].text.body';
    // PR #137 (verbatim ruling): the fixture's hours rows ("Mon-Thu | 8:00am - 5:00pm", "Fri |
    // 8:00am - 2:00pm", "Sat-Sun | Closed") are true, but not verbatim copies of the brief's
    // "Monday-Thursday 8am-5pm, Friday 8am-2pm, closed Saturday and Sunday". The fill prompt masks
    // them; claim-name-honesty-all-families.test.ts lists them in KNOWN_HOURS_RESIDUAL_FLAGS.
    const HOURS_RESIDUAL = new Set(['sections[9].items[0].label', 'sections[9].items[1].label', 'sections[9].items[2].label']);
    const unexpected = flagged.filter((f) => f.path !== KNOWN_RESIDUAL && !HOURS_RESIDUAL.has(f.path));
    assert.deepEqual(unexpected, [], `${label} carries a name, quote, destination, hours day, traceable-row, claim token, or claim-bearing sentence its own documented brief does not: ${JSON.stringify(unexpected)}`);
    assert.ok(flagged.some((f) => f.path === KNOWN_RESIDUAL), `the known residual at ${KNOWN_RESIDUAL} no longer flags — remove this exemption and record the fix in the ledger`);
  });
}
