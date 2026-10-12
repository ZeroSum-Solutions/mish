/**
 * guide's places-to-see `body` (round-5 fix, tightened again in round 4 of the r1 rebuild): free
 * descriptive prose that must not invent a COUNT, a DISTANCE or a TIME claim the brief never
 * states, but that no longer needs every word to trace verbatim (see `slots.ts`'s own doc on this
 * field for why whole-field `x-verify: 'traceable'` was removed from it, mirroring storefront's
 * own `body`).
 *
 * As of round 4, `guide` is in `run.ts`'s `SENTENCE_CLAIM_FAMILIES` allowlist alongside
 * `storefront` and `practice` — this is the live wiring, not a documented-gap test file anymore.
 * `jev.ts`'s claim-signal lexicon was also tightened in the same round: number words two through
 * twelve (plus dozen/couple/few/several) and a set of distance/proximity/duration signals now
 * make a sentence claim-bearing even with no digit and no commercial word at all. This file proves
 * each new signal individually (one assertion per signal, per the round-4 instruction), proves the
 * exact coordinator-supplied catch against the real committed Windward Point brief, and proves a
 * faithful, brief-worded sentence using the same words still passes — with an explicit positive-
 * catch/negative-non-catch pair for every signal narrowed to a PHRASE rather than a bare stem
 * (`close`, `walk`, `short`/`quick`, `step`/`block` — see `jev.ts`'s own `DISTANCE_STEM_WORDS`
 * docblock for why each of those bare words collided with an unrelated, non-distance sense in a
 * committed family fixture).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deterministicSentenceClaimFlags, deterministicTraceableFlags } from '../src/jev.ts';
import type { FaithfulnessSlot } from '../src/jev.ts';

/** A brief that supports no count, distance or time claim at all — any claim-bearing sentence
 * checked against it must fail to trace and so must flag, proving the signal fired. */
const UNSUPPORTED_BRIEF = 'Lowmoor Crossing is a small crossroads village. There is a stone '
  + "bridge, a green, and a single row of shops. The green hosts a small farmers' stall most "
  + 'weekends.';

function flagsForBrief(brief: string, text: string): boolean {
  const slots: FaithfulnessSlot[] = [{ path: 'sections[5].items[0].body', text }];
  const paths = new Set(['sections[5].items[0].body']);
  return deterministicSentenceClaimFlags(brief, slots, paths).length > 0;
}

const flagsFor = (text: string): boolean => flagsForBrief(UNSUPPORTED_BRIEF, text);

// ---------------------------------------------------------------------------
// The exact coordinator-supplied finding: the motivating example for this whole round, checked
// against the real committed Windward Point brief (not a synthetic one) — the brief lists its
// four places to see by name but never states a count, and never calls any of them "a short walk"
// from anywhere.
// ---------------------------------------------------------------------------

test('the exact coordinator finding: "Four must-see spots, a short walk from the harbor" is flagged against the real committed Windward Point brief', () => {
  const briefPath = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-guide/compiler/scripts/families/guide/reference.fixture.brief.txt');
  const brief = readFileSync(briefPath, 'utf8');
  assert.equal(flagsForBrief(brief, 'Four must-see spots, a short walk from the harbor.'), true);
});

// ---------------------------------------------------------------------------
// Baseline: a digit or a tens-or-above number word was already caught before round 4; an ordinary
// brief-supported sentence with no signal at all stays exempt.
// ---------------------------------------------------------------------------

test('deterministicSentenceClaimFlags catches a DIGIT count/proximity claim the brief does not state', () => {
  assert.equal(flagsFor('4 must-see spots within a short walk.'), true);
});

test('deterministicSentenceClaimFlags catches a spelled-out TENS-OR-ABOVE number word claim the brief does not state', () => {
  assert.equal(flagsFor('Twenty must-see spots within a short walk.'), true);
});

test('deterministicSentenceClaimFlags leaves an ordinary, brief-supported sentence alone (no claim signal at all)', () => {
  assert.equal(flagsFor('The stone bridge stands beside the green, in the heart of the village.'), false);
});

// ---------------------------------------------------------------------------
// Round 4: the ones-word count gap is now closed for two through twelve, dozen/couple/few/several
// — one assertion per signal, each unsupported by UNSUPPORTED_BRIEF so a catch proves the signal
// fired (not a trace failure on unrelated words).
// ---------------------------------------------------------------------------

for (const word of ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']) {
  test(`deterministicSentenceClaimFlags catches the ones-word count "${word}" as a claim signal (round-4 gap closed)`, () => {
    assert.equal(flagsFor(`There are ${word} boats tied up at the dock.`), true);
  });
}

for (const word of ['dozen', 'couple', 'few', 'several']) {
  test(`deterministicSentenceClaimFlags catches "${word}" as a count claim signal`, () => {
    assert.equal(flagsFor(`A ${word} boats are tied up at the dock.`), true);
  });
}

test('"one" stays deliberately excluded from the number-word signal set — no finding requires it, and it would reopen a false-positive class ("a one-page site")', () => {
  assert.equal(flagsFor('There is one boat tied up at the dock.'), false);
});

// ---------------------------------------------------------------------------
// Round 4: bare distance/duration stems — one assertion per signal, each unsupported by
// UNSUPPORTED_BRIEF.
// ---------------------------------------------------------------------------

const BARE_DISTANCE_SENTENCES: readonly [string, string][] = [
  ['drive', 'You can drive to the village square.'],
  ['ride', 'You can ride to the village square.'],
  ['minute', 'It takes only a minute to reach the square.'],
  ['hour', 'It takes only an hour to reach the square.'],
  ['mile', 'The square is a mile from here.'],
  ['km', 'The square is a km from here.'],
  ['kilometer', 'The square is a kilometer from here.'],
  ['kilometre', 'The square is a kilometre from here.'],
  ['near', 'The square is near the harbor.'],
  ['away', 'The square is away from the harbor.'],
];

for (const [word, sentence] of BARE_DISTANCE_SENTENCES) {
  test(`deterministicSentenceClaimFlags catches the bare distance/duration stem "${word}"`, () => {
    assert.equal(flagsFor(sentence), true);
  });
}

// ---------------------------------------------------------------------------
// Round 4: signals narrowed to a PHRASE rather than a bare stem, because the bare word collided
// with an unrelated sense in a committed family fixture. Each gets a positive-catch AND a
// negative-non-catch test, proving the narrowing is precise rather than a broad weakening.
// ---------------------------------------------------------------------------

test('"close to" is caught as a proximity claim', () => {
  assert.equal(flagsFor('The square is close to the harbor.'), true);
});
test('"close" the VERB is NOT caught — narrowing "close" to the phrase "close to" avoids this false positive without weakening the phrase catch above', () => {
  assert.equal(flagsFor('Please close the door before leaving.'), false);
  assert.equal(flagsFor('The shop stays open until it closes for the season.'), false);
});

test('"walk to"/"walk from" is caught as a distance claim', () => {
  assert.equal(flagsFor('You can walk to the square from the dock.'), true);
});
test('"walks you through" (the explanatory idiom) is NOT caught — narrowing "walk" to a to/from direction avoids this false positive without weakening the direction catch above', () => {
  assert.equal(flagsFor('Our team walks you through every option before we start.'), false);
});

test('"a short drive"/"a quick ride" (no to/from, no number) is caught as a distance claim via the short/quick + distance-noun phrase', () => {
  assert.equal(flagsFor('A short drive gets you there.'), true);
  assert.equal(flagsFor('A quick ride brings you to the square.'), true);
});
test('"short"/"quick" with no distance noun at all is NOT caught — narrowing to the short/quick+noun phrase avoids this false positive without weakening the phrase catch above', () => {
  assert.equal(flagsFor('A short health history is all we need at check-in.'), false);
  assert.equal(flagsFor('Send us a quick question anytime.'), false);
});

test('"nearby the <place>"/"is nearby" is caught as a proximity claim', () => {
  assert.equal(flagsFor('The square is nearby the harbor.'), true);
  assert.equal(flagsFor('The old bridge sits nearby.'), true);
});
test('"nearby" as a generic locational modifier with no specific place named is NOT caught — narrowing avoids the exact false positive a live guide sparse-brief build produced ("run by nearby farms"), without weakening the phrase catch above', () => {
  assert.equal(flagsFor("A small farmers' stall is run by nearby farms."), false);
  assert.equal(flagsFor('Produce comes from nearby farms selling seasonal goods.'), false);
});

test('"steps away"/"a block away" (no number) is caught as a distance claim', () => {
  assert.equal(flagsFor('The square is steps away from the harbor.'), true);
  assert.equal(flagsFor('It is a block away from the square.'), true);
});
test('bare "step"/"block" with no from/away is NOT caught — narrowing avoids colliding with a literal process-step label or an unrelated "content block", without weakening the phrase catch above', () => {
  assert.equal(flagsFor('Step one: check in at the harbor office.'), false);
  assert.equal(flagsFor('We added a new content block to the page.'), false);
});

// ---------------------------------------------------------------------------
// The combination case: a distance word WITH a number was already caught before round 4 (via the
// digit/number-word path alone) — still true after the phrase-narrowing above.
// ---------------------------------------------------------------------------

test('a distance claim WITH a number is still caught', () => {
  assert.equal(flagsFor('A 10-minute walk from the crossing.'), true);
});

// ---------------------------------------------------------------------------
// Round-4 Grok audit (guide-r2): the distance-phrase regexes were too narrow (exact "short walk"
// only), 'dozens' did not match like 'dozen', 'over' hid a comparative/threshold sense, and a
// glued clock time ("6am") was invisible to claim tokenization. One positive-catch and one
// negative-non-catch test per new pattern, per the audit's own instruction.
// ---------------------------------------------------------------------------

test('"dozens" (plural) is caught as a count claim signal, the same as "dozen"', () => {
  assert.equal(flagsFor('Dozens of boats fill the harbor at dawn.'), true);
});

test('a modifier word or a comma between short/quick and the distance noun is still caught ("a short breakwater walk", "a short, easy walk")', () => {
  assert.equal(flagsFor('A short breakwater walk gives a view over the harbor.'), true);
  assert.equal(flagsFor('A short, easy walk leads to the headland.'), true);
});
test('short/quick with MORE than two intervening words, or no distance noun at all, is still NOT caught — the widened modifier window does not turn every "short" into a claim signal', () => {
  assert.equal(flagsFor('A short, well-loved, locally-run cafe sits on the square.'), false);
  assert.equal(flagsFor('A short introduction to the town follows.'), false);
});

test('"hike"/"stroll" are caught as bare distance stems, the same tier as "drive"/"ride"', () => {
  assert.equal(flagsFor('You can hike to the headland from the harbor.'), true);
  assert.equal(flagsFor('Take a stroll along the breakwater.'), true);
});

test('"within walking distance"/"within reach" are caught as proximity claims with no number at all', () => {
  assert.equal(flagsFor('The market is within walking distance of the dock.'), true);
  assert.equal(flagsFor('Every shop is within reach of the square.'), true);
});
test('"distance" or "reach" alone, with no qualifying phrase, is NOT caught', () => {
  assert.equal(flagsFor('The distance between these facts is telling.'), false);
  // g6-r3-opus55 audit (FIX F2, SUPERLATIVE_CLAIM_WORDS): the original example here used "most"
  // ("Out of reach for most visitors…"), which now makes the sentence claim-bearing on its own
  // (an unrelated signal, not the "reach" stem this test exists to prove doesn't fire alone) —
  // reworded to keep testing what it originally set out to test, per this round's own rule not to
  // narrow a new signal just to keep a count low.
  assert.equal(flagsFor('Out of reach for visitors, the trail stays quiet.'), false);
});

test('"over" as a numeric/duration THRESHOLD is caught (a comparative claim, not a spatial preposition)', () => {
  const brief = 'Returns are accepted within thirty days of purchase.';
  const slots = [{ path: 'a', text: 'Returns are accepted over thirty days of purchase.' }];
  assert.ok(deterministicTraceableFlags(brief, slots, new Set(['a'])).length > 0, 'a threshold "over" must still require its own word to trace');
});
test('"over" spatial (not a threshold) still passes, exactly as before this round\'s narrowing', () => {
  const brief = 'A still-active lighthouse beside the beach.';
  const slots = [{ path: 'a', text: 'A still-active lighthouse over the beach.' }];
  assert.deepEqual(deterministicTraceableFlags(brief, slots, new Set(['a'])), [], 'a spatial "over" must not force a full-field trace failure on its own');
});

test('a glued clock time ("5am") is flagged against a brief that states a different one ("6am")', () => {
  const brief = 'Boats unload their catch each morning around 6am at the public dock.';
  const slots = [{ path: 'a', text: 'Boats unload their catch each morning around 5am at the dock.' }];
  const flagged = deterministicSentenceClaimFlags(brief, slots, new Set(['a']));
  assert.ok(flagged.length > 0, 'an invented clock time must be caught, not silently traced as the brief\'s own hour');
});
test('the SAME stated clock time passes cleanly (no false positive from the new clock-time check)', () => {
  const brief = 'Boats unload their catch each morning around 6am at the public dock.';
  const slots = [{ path: 'a', text: 'Boats unload their catch each morning around 6am at the dock.' }];
  assert.deepEqual(deterministicSentenceClaimFlags(brief, slots, new Set(['a'])), []);
});
