/**
 * G6 (claim and name honesty in every family) — matcher canonicalization and a multi-family
 * true-positive sweep, added after a watchdog-flagged drift review of the first pass at this
 * work found several fixture edits that gamed the checker instead of fixing it. This file covers
 * what that review asked for:
 *
 * 1. A unit test for each canonicalization `deterministicSentenceClaimFlags`/
 *    `deterministicTraceableFlags` (via `traceableContentWordsOf`, `src/jev.ts`) and
 *    `deterministicProperNounFlags` now apply — day/month abbreviations (`CALENDAR_CANONICAL`),
 *    duration-unit abbreviations (`UNIT_ABBREVIATION_CANONICAL`), a bound "percent"/"pct" unit
 *    suffix (`PERCENT_BEFORE_RE`), and the "GC" -> "general contractor" abbreviation expansion
 *    (`ABBREVIATION_EXPANSIONS`) — none of which are additions to `TRACEABLE_STOPWORDS` or any
 *    other shared exemption list (`FAMILY-BRIEF.md`'s "Shared gate rule"): every one of these is a
 *    same-word canonicalization applied to BOTH sides of a trace, not an exemption from tracing.
 *
 * 2. `deterministicSentenceClaimFlags`/`deterministicProperNounFlags` true-positive coverage: an
 *    invented person name, an invented place, an invented brand, and an invented claim sentence,
 *    each injected into a REAL family's own reference-fixture-shaped brief and asserted FLAGGED —
 *    so a gate that flags nothing could never pass this file the way it could the zero-flag
 *    registry sweep alone (`claim-name-honesty-all-families.test.ts`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicClaimFlags, deterministicProperNounFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags, type FaithfulnessSlot } from '../src/jev.ts';

// ---------------------------------------------------------------------------
// 1. Canonicalization unit tests
// ---------------------------------------------------------------------------

function traceableFlagsFor(brief: string, text: string): number {
  const slot: FaithfulnessSlot = { path: 'a', text };
  return deterministicTraceableFlags(brief, [slot], new Set(['a'])).length;
}

function sentenceFlagsFor(brief: string, text: string): number {
  const slot: FaithfulnessSlot = { path: 'a', text };
  return deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length;
}

test('canonicalization: a day-range written with abbreviations traces against a brief that spells the days out in full', () => {
  const brief = 'Hours: Monday-Friday 7am-5pm, Saturday by appointment.';
  assert.equal(traceableFlagsFor(brief, 'Mon–Fri, 7am–5pm.'), 0);
});

// g6-r3b-opus55 audit (BLOCK-2): CALENDAR_CANONICAL/UNIT_ABBREVIATION_CANONICAL/
// ABBREVIATION_EXPANSIONS are now PAGE-SIDE ONLY — the brief's own words are always read
// literally, never canonicalized. That closes the two-way-promotion flaw (an unrelated brief
// word silently becoming a day name) but means the OLD "brief abbreviates, page spells out in
// full" direction no longer traces: the brief's own "mon"/"hrs" now stay literal "mon"/"hrs",
// so a page that spells them out in full ("Monday", "hours") no longer finds a literal match.
// Only the page-abbreviates-brief-spells-out-in-full direction still works (tested above and in
// BLOCK-2's own "positive" test in g6-r3b-opus55's own test block below).
test('canonicalization: a day-range abbreviated on the page traces against a brief that spells the days out in full, but NOT the reverse (BLOCK-2: page-side only)', () => {
  const brief = 'Open Mon-Fri, closed weekends.';
  assert.equal(traceableFlagsFor(brief, 'Open Monday to Friday.'), 1, 'the brief only ever writes the abbreviation "mon"/"fri" literally; a page that spells them out in full no longer manufactures a match — this is the intended effect of making canonicalization page-side only');
});

test('canonicalization: "hrs" on the page traces against a brief that spells out "hours", but NOT the reverse (BLOCK-2: page-side only)', () => {
  const brief = 'A free 60-90 minute walkthrough, 6 hours of knotting on a single strand.';
  assert.equal(traceableFlagsFor(brief, '6 hrs of knotting.'), 0, 'the page abbreviates; the brief\'s own "hours" is still a real, literal match once "hrs" canonicalizes on the page side');
  const brief2 = 'A single strand takes 6 hrs to knot.';
  assert.equal(traceableFlagsFor(brief2, 'It takes 6 hours to knot a single strand.'), 1, 'the brief only ever writes "hrs" literally; a page that spells out "hours" no longer manufactures a match');
});

test('canonicalization: "min"/"mins" traces against a brief that spells out "minute(s)"', () => {
  const brief = 'A free 60-90 minute walkthrough with a fixed quote.';
  assert.equal(traceableFlagsFor(brief, 'A free 60-90 min walkthrough.'), 0);
});

test('canonicalization: a bare unit abbreviation with no brief support still fails to trace (the canonicalization is not an exemption)', () => {
  const brief = 'A free walkthrough with a fixed quote.';
  assert.equal(traceableFlagsFor(brief, 'A free 45 min walkthrough.'), 1);
});

test('canonicalization: "percent" bound to a preceding number traces against a brief that only ever writes the "%" symbol', () => {
  const brief = 'Individual membership: free entry all year, 10% off in the shop.';
  // The digit "10" is used on both sides deliberately, isolating the "percent"/"%" canonicalization
  // from the SEPARATE number-word-vs-digit gap ("ten" vs "10") `deterministicClaimFlags`'s own
  // claim-token comparison already covers elsewhere, not this word-trace path.
  assert.equal(sentenceFlagsFor(brief, '10 percent off in the shop.'), 0);
});

test('canonicalization: an UNBOUND "percent" (no adjacent number) still must trace as ordinary content', () => {
  const brief = 'Ask about our shop.';
  // "percent" here names a concept, not a bound suffix of a number right before it — it still
  // needs its own support (there is none), so this must flag exactly like any other stray word.
  assert.equal(sentenceFlagsFor(brief, 'Percent off is available in the shop, five percent to be precise.'), 1);
});

test('canonicalization: "GC" traces against a brief that spells out "general contractor"', () => {
  const brief = 'TestContractor Remodeling is a general contractor in Raleigh, licensed NC #78412.';
  assert.equal(traceableFlagsFor(brief, 'Licensed GC, NC #78412.'), 0);
});

test('canonicalization: "GC" against a brief that never mentions being a contractor at all still fails to trace', () => {
  const brief = 'TestContractor Remodeling is a home renovation studio in Raleigh, licensed NC #78412.';
  assert.equal(traceableFlagsFor(brief, 'Licensed GC, NC #78412.'), 1);
});

test('canonicalization: "GC" traces for deterministicProperNounFlags too, the same abbreviation table as the word-trace path', () => {
  const brief = 'TestContractor Remodeling is a general contractor in Raleigh.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Every job is run by a licensed GC.' };
  assert.deepEqual(deterministicProperNounFlags(brief, [slot], new Set(['a'])), []);
});

// ---------------------------------------------------------------------------
// 2. Multi-family true-positive sweep: an invented person, place, brand, and claim sentence
// ---------------------------------------------------------------------------

const TEST_CONTRACTOR_BRIEF = 'TestContractor Remodeling is a general contractor in Raleigh, North Carolina, in business '
  + 'since 2009. We are licensed (NC #78412), rated 4.9 stars with 212 five-star reviews, and we serve '
  + 'Raleigh, Cary and Wake Forest. Services: kitchens, bathrooms, decks and porches, siding, windows and '
  + 'doors, roofing. Contact: (919) 555-0142, hello@ownedcontractorremodeling.com.';

const TEST_INSTITUTION_BRIEF = 'TestInstitution Hall is a contemporary art and design museum on the east bank of the river in '
  + 'Providence, Rhode Island, open since 1961. Five collection rooms, three exhibitions a season. '
  + 'Admission: general $16, students $9, under 18 free, members free.';

const TEST_MAKER_BRIEF = 'TestMaker Atelier is a two-person studio in Providence, Rhode Island, making pearl and gold '
  + 'jewelry in runs of twelve, working since 2016. TestMaker cuts and solders, Ilse strings and finishes.';

test('true positive: an invented person name flags (ownedcontractor)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[9].content.owner', text: 'Founded and led by Marguerite Ashcombe.' };
  const flagged = deterministicProperNounFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented owner name with no brief support must flag');
});

test('true positive: an invented place name flags (ownedinstitution)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[6].content.lede', text: 'Just a short walk from Larkmoor Heights station.' };
  const flagged = deterministicProperNounFlags(TEST_INSTITUTION_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented station/place name with no brief support must flag');
});

test('true positive: an invented brand/business name flags (ownedmaker)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[1].content.credit', text: 'Findings sourced from Hallowgate Metals.' };
  const flagged = deterministicProperNounFlags(TEST_MAKER_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented supplier/brand name with no brief support must flag');
});

test('true positive: an invented claim-bearing sentence flags (ownedcontractor — an unsupported specific number)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[1].content.annotationRoofLabel', text: 'Standing-seam roof, replaced in 2025.' };
  const flagged = deterministicSentenceClaimFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented specific year with no brief support must flag as a claim-bearing sentence');
});

test('true positive: an invented claim-bearing sentence flags (ownedinstitution — an unsupported discount)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[7].content.tier1Benefit2', text: 'Twenty percent off in the shop.' };
  const flagged = deterministicSentenceClaimFlags(TEST_INSTITUTION_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented discount figure the brief never states must flag');
});

test('true positive: an invented claim-bearing sentence flags (ownedmaker — an unsupported price)', () => {
  const slot: FaithfulnessSlot = { path: 'sections[2].content.priceNote', text: 'Every piece starts at $95.' };
  const flagged = deterministicSentenceClaimFlags(TEST_MAKER_BRIEF, [slot], new Set([slot.path]));
  assert.equal(flagged.length, 1, 'an invented price with no brief support must flag');
});


// ---------------------------------------------------------------------------
// 3. g6-r3-opus55 audit (BLOCK B2): removing "about"/"everyone"/"anyone"/"everybody"/"anybody"
//    from TRACEABLE_STOPWORDS, the ALL_PASSIVE_BY_AFTER_RE bypass, and FRACTION_WORD_PERCENT
//    (NOTE N1 — tying a fraction word to a shared content noun was not a small change, so it was
//    removed outright rather than half-fixed) must restore the counter-examples the audit
//    demonstrated — a brief that RESTRICTS or QUANTIFIES differently from the page must still
//    flag, which the removed exemptions were silently hiding.
// ---------------------------------------------------------------------------

test('g6-r3-opus55 B2: a restricting brief ("members") against a widened page ("everyone") must flag (traceable check: the audit table shows this pair is not claim-bearing under the sentence check, 0/1 on main for sentence/traceable)', () => {
  const brief = 'Open to members on Thursdays.';
  assert.equal(traceableFlagsFor(brief, 'Open to everyone on Thursdays.'), 1, 'admitting "everyone" when the brief restricts to members is an invented widening of scope');
});

test('g6-r3-opus55 B2: a restricting brief ("with a referral") against a widened page ("anyone") must flag', () => {
  const brief = 'We treat patients with a referral from their doctor.';
  assert.equal(traceableFlagsFor(brief, 'We accept anyone with a referral.'), 1, 'admitting "anyone" when the brief restricts to referred patients is an invented widening of scope');
});

test('g6-r3-opus55 B2: a "most" brief against an "all run by" page must flag (traceable check; the ALL_PASSIVE_BY_AFTER_RE bypass removed)', () => {
  const brief = 'Most of our programmes are run by volunteers.';
  assert.equal(traceableFlagsFor(brief, 'Our programmes are all run by volunteers.'), 1, '"all" is a wider claim than "most" and must still trace');
});

test('g6-r3-opus55 B2: a "two hours" brief against an "about an hour" page must flag ("about" removed as a stopword)', () => {
  const brief = 'The walk takes two hours from the station.';
  assert.equal(sentenceFlagsFor(brief, 'About an hour from the station.'), 1, '"about an hour" against a brief stating two hours is an invented shortening, not a hedge on the same fact');
});

// ---------------------------------------------------------------------------
// 5. g6-r3-opus55 audit (FIX F2): award/credential/superlative signals in isClaimBearingSentence.
//    Opus's own four ownedcontractor strings — none carried a digit, currency, percent, star mark or
//    commercial-stem word, so isClaimBearingSentence returned false for all four before this fix,
//    on every family now that the sentence gate is unconditional.
// ---------------------------------------------------------------------------

test('g6-r3-opus55 F2: "Award-winning remodels across Raleigh." now flags (no brief support for the award)', () => {
  const slot: FaithfulnessSlot = { path: 'a', text: 'Award-winning remodels across Raleigh.' };
  assert.equal(deterministicSentenceClaimFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set(['a'])).length, 1);
});

test('g6-r3-opus55 F2: "Voted best remodeler in Raleigh." now flags (no brief support for the accolade)', () => {
  const slot: FaithfulnessSlot = { path: 'a', text: 'Voted best remodeler in Raleigh.' };
  assert.equal(deterministicSentenceClaimFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set(['a'])).length, 1);
});

test('g6-r3-opus55 F2: "Nationally recognized for kitchen design." now flags (no brief support for the recognition)', () => {
  const slot: FaithfulnessSlot = { path: 'a', text: 'Nationally recognized for kitchen design.' };
  assert.equal(deterministicSentenceClaimFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set(['a'])).length, 1);
});

test('g6-r3-opus55 F2: "The most trusted remodeler in Raleigh." now flags (no brief support for the superlative)', () => {
  const slot: FaithfulnessSlot = { path: 'a', text: 'The most trusted remodeler in Raleigh.' };
  assert.equal(deterministicSentenceClaimFlags(TEST_CONTRACTOR_BRIEF, [slot], new Set(['a'])).length, 1);
});

test('g6-r3-opus55 F2 negative: a superlative/certification word that IS brief-supported still traces (no over-flagging)', () => {
  const brief = 'Acme Roofing is licensed and is the best local roofer, voted and recognized by the city three years running.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Licensed, voted and recognized as the best local roofer.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 0, 'a genuinely brief-stated credential/award/superlative must still pass');
});

// ---------------------------------------------------------------------------
// 6. g6-r3b-opus55 audit — two more shared-list loosenings (BLOCK-1, BLOCK-2), removed. Every
//    pair Opus supplied is now a must-flag test.
// ---------------------------------------------------------------------------

test('g6-r3b-opus55 BLOCK-1 (existential "there" removed): a flipped accessibility claim now flags', () => {
  const brief = 'Wheelchair access is not available, sorry.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'There is wheelchair access.' };
  assert.equal(deterministicTraceableFlags(brief, [slot], new Set(['a'])).length, 1, 'the brief denies access; the page must not silently claim it via "there is"');
});

test('g6-r3b-opus55 BLOCK-1: a flipped refund-policy claim now flags', () => {
  const brief = 'We do not offer a refund on tickets.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'There is a refund on tickets.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 1);
  assert.equal(deterministicTraceableFlags(brief, [slot], new Set(['a'])).length, 1);
});

test('g6-r3b-opus55 BLOCK-1: a flipped free-parking claim now flags', () => {
  const brief = 'No free parking on site; paid parking is available nearby.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'There is free parking on site.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 1);
  assert.equal(deterministicTraceableFlags(brief, [slot], new Set(['a'])).length, 1);
});

test('g6-r3b-opus55 BLOCK-2 (CALENDAR_CANONICAL page-side-only): a brief\'s ordinary "sun" does not manufacture Sunday opening hours', () => {
  const brief = 'Our sun terrace is lovely. Open Saturday 9am to 5pm.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Open Saturday and Sunday, 9am to 5pm.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 1, 'the brief never states Sunday hours; "sun" the word must not promote to "Sunday"');
});

test('g6-r3b-opus55 BLOCK-2: a brief\'s ordinary "sat" (verb) does not manufacture Saturday opening hours', () => {
  // "Open Friday and Saturday." carries no digit/currency/commercial/number-word signal, so
  // `isClaimBearingSentence` never even looks at it — this pair is only visible to the
  // full-slot `deterministicTraceableFlags` check (the same asymmetry the BLOCK-1 "members"/
  // "everyone" pair already showed: main's own table records this class of pair as a
  // TRACEABLE-only finding, not a sentence-claim one).
  const brief = 'The mill sat empty for years. Open Friday.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Open Friday and Saturday.' };
  assert.equal(deterministicTraceableFlags(brief, [slot], new Set(['a'])).length, 1);
});

test('g6-r3b-opus55 BLOCK-2: a brief\'s "Sun-dried" does not manufacture Sunday opening hours', () => {
  const brief = 'Sun-dried tomatoes on the menu. Open Monday to Friday, 8am to 4pm.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Open Sundays too, 8am to 4pm.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 1);
});

test('g6-r3b-opus55 BLOCK-2 positive: CALENDAR_CANONICAL still works page-side (an abbreviation on the page still matches the brief\'s own full day name)', () => {
  const brief = 'Open Monday to Friday, 7am to 5pm, Saturday by appointment.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Mon-Fri, 7am-5pm. Sat by appointment.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 0, 'the brief itself names every one of these days; the page abbreviating them is a faithful paraphrase, not an invented day');
});

test('g6-sol-r11: Sol\'s own counterexample — "Sun" next to an unrelated digit ("Sun deck: 4 seats") must not manufacture Sunday opening hours (the round-10 "date context" gate was unsafe and is removed)', () => {
  const brief = 'Sun deck: 4 seats. Open Saturday at 4pm.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Open Saturday and Sunday at 4pm.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 1, 'main flags this 1/1: the brief never states Sunday hours, and a digit sitting near "Sun" for an unrelated reason (a four-seat deck) must not promote it to "Sunday"');
});

test('g6-r3b-opus55 F-a (percent-suffix drop replaced with a brief-side % equivalence): a genuinely different number/unit still flags', () => {
  // Opus's own two negative examples: deterministicClaimFlags's number-level check is untouched
  // by this fix and still catches a wrong number or a wrong unit.
  const brief = 'Members get 10% off.';
  const wrongNumber: FaithfulnessSlot = { path: 'a', text: 'Members get 15 percent off.' };
  assert.equal(deterministicClaimFlags(brief, [wrongNumber], new Set(['a'])).length, 1, '"15 percent" against a brief stating 10% is an invented number');
  const wrongUnitBrief = 'Ten dollars off tours.';
  const wrongUnit: FaithfulnessSlot = { path: 'a', text: 'Ten percent off tours.' };
  assert.equal(deterministicClaimFlags(wrongUnitBrief, [wrongUnit], new Set(['a'])).length, 1, '"percent" against a brief stating "dollars" is an invented unit');
});

test('g6-r3b-opus55 F-a positive: "%" in the brief licenses a spelled-out "percent" on the page, for the SAME number', () => {
  const brief = 'Admission covers 34% of what a year costs here.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Admission covers 34 percent of what a year costs here.' };
  assert.equal(deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length, 0, '"34%" and "34 percent" state the same fact');
});

// ---------------------------------------------------------------------------
// 7. g6-r3b-opus55 audit — NOTE items with test coverage requested.
// ---------------------------------------------------------------------------

test('g6-r3b-opus55 N-a (CALENDAR_WORDS removed from the proper-noun brief set): an invented "June" as a person no longer passes on any brief', () => {
  const brief = 'Riverbend Bakery is a small bakery. We open early and close by 3pm.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Ask for June at the counter.' };
  assert.equal(deterministicProperNounFlags(brief, [slot], new Set(['a'])).length, 1, 'the brief never mentions anyone named June; the month name must not pass unconditionally');
});

test('g6-r3b-opus55 N-b (whole-word matching only): a short invented name no longer clip-matches a longer brief name it happens to prefix', () => {
  // "Rob" is also an ordinary dictionary word (the verb "to rob"); "Aless" happens to STEM to
  // "ales" (plural of "ale"), which is also a dictionary word — both are poor tests of THIS
  // specific fix, since they'd still pass via `isKnownWord`'s dictionary check regardless of
  // prefix matching. "Vasq" has no dictionary standing at all (checked directly against
  // `isKnownWord`), so it isolates the prefix-removal behavior Opus's N-b finding is about.
  const brief = 'Riverbend Dental is run by Dr. Alessandra Vasquez.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Ask for Vasq at the front desk.' };
  assert.equal(deterministicProperNounFlags(brief, [slot], new Set(['a'])).length, 1, '"Vasq" is not a brief word on its own — it must not pass merely by being a prefix of "Vasquez"');
});

test('g6-r3b-opus55 N-c (Unicode-uppercase-aware proper-noun pattern): an accented-initial invented name is now a candidate and flags', () => {
  const brief = 'Riverbend Bakery is a small bakery in Boise.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Ólafur bakes every loaf by hand.' };
  assert.equal(deterministicProperNounFlags(brief, [slot], new Set(['a'])).length, 1, '"Ólafur" must now be a candidate at all, and fail with no brief support');
});

test('g6-r3b-opus55 N-c positive: a brief-stated accented name still traces', () => {
  const brief = 'Ólafur bakes every loaf by hand at Riverbend Bakery.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Ólafur bakes every loaf by hand.' };
  assert.equal(deterministicProperNounFlags(brief, [slot], new Set(['a'])).length, 0);
});
