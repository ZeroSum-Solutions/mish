/**
 * G6 (claim and name honesty in every family) — round-1 adversarial audit fixes
 * (`~/.claude/goal-state/mishh-genui-production/audits/g6-r1-gemini.md`, DO NOT SHIP verdict).
 * One test group per finding that changed behavior (B1, B3, F5, F6, F7). B2 and F4 changed
 * fixture/schema content, not a function's own behavior, and are covered by
 * `claim-name-honesty-all-families.test.ts` (which now calls the real `templateChromePaths`) and
 * the ledger's fixture diff, respectively.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicProperNounFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags, type FaithfulnessSlot } from '../src/jev.ts';

function properNounFlagsFor(brief: string, text: string): number {
  const slot: FaithfulnessSlot = { path: 'a', text };
  return deterministicProperNounFlags(brief, [slot], new Set(['a'])).length;
}

// ---------------------------------------------------------------------------
// B1: isKnownAbbreviation must require BRIEF support for every expanded word, never a bare
// dictionary fallback — "GC" must not be free-floating proof of a general contractor claim.
// ---------------------------------------------------------------------------

test('B1: "GC" is NOT exempt on a brief that never mentions being a contractor, even though "general"/"contractor" are ordinary dictionary words', () => {
  const brief = 'TestInstitution Hall is a contemporary art and design museum in Providence, Rhode Island.';
  assert.equal(properNounFlagsFor(brief, 'Every project is managed by a licensed GC.'), 1);
});

test('B1: "GC" IS exempt when the brief itself states the business is a general contractor', () => {
  const brief = 'TestContractor Remodeling is a general contractor in Raleigh, North Carolina.';
  assert.equal(properNounFlagsFor(brief, 'Every job is run by a licensed GC.'), 0);
});

// ---------------------------------------------------------------------------
// B3: PROPER_NOUN_RUN_RE must handle internal apostrophes and digit-adjacent camelCase, not just
// a trailing possessive.
// ---------------------------------------------------------------------------

const NAME_BRIEF = "Chef Siobhan O'Brien and pastry chef Marco D'Angelo run the kitchen at "
  + "McDonald's Fish House. The Smith-Jones family has owned the building since 1990.";

test('B3: an internal-apostrophe name stated in the brief traces as one unit ("O\'Brien")', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, "Chef O'Brien founded the restaurant."), 0);
});

test('B3: a second internal-apostrophe name stated in the brief traces as one unit ("D\'Angelo")', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, "Pastry by D'Angelo every morning."), 0);
});

test('B3: an internal-capital name with no apostrophe traces ("McDonald")', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, "Ask for the McDonald table."), 0);
});

test('B3: a hyphenated name traces as a phrase ("Smith-Jones")', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, 'The Smith-Jones family still owns it.'), 0);
});

test('B3: a possessive on a brief-stated internal-apostrophe name still traces ("O\'Brien\'s")', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, "O'Brien's own recipe never changes."), 0);
});

test('B3: an INVENTED internal-apostrophe name (no brief support) still flags', () => {
  assert.equal(properNounFlagsFor(NAME_BRIEF, "Chef O'Malley closes on Sundays."), 1);
});

// ---------------------------------------------------------------------------
// F5: isClippedPrefix must accept only a prefix of a BRIEF word, never any prefix of any of the
// ~61,700 dictionary words — a global dictionary-prefix search let common given names evade.
// ---------------------------------------------------------------------------

test('F5: an invented name that happens to be a dictionary-word prefix ("Dan" of "dance") still flags on a brief that never states it', () => {
  const brief = 'TestMaker Atelier is a two-person studio in Providence, Rhode Island.';
  assert.equal(properNounFlagsFor(brief, 'Founded by Dan Miller and Tim Brown.'), 1);
});

test('F5 -> N-b (g6-r3b-opus55 audit, whole-word matching only): a byte-budget clip of a BRIEF word now flags too — the clipped-prefix exemption is removed entirely, not narrowed', () => {
  // This exemption used to let a genuine byte-budget clip ("Portl" of the brief's own "Portland")
  // pass. The g6-r3b-opus55 audit's N-b finding showed the SAME brief-word-prefix mechanism also
  // let an unrelated INVENTED short name pass merely by sharing a longer brief word's prefix
  // ("Ask for Rob…" against a brief naming "Robertson") — prefix matching cannot tell the two
  // cases apart, so it is removed entirely, whole-word matching only. A genuine byte-budget clip
  // is a known, separate failure mode with its own dedicated repair path elsewhere in the build
  // pipeline; this check no longer tries to guess it, and now flags it like any other unsupported
  // candidate. Counted as an accepted, honestly-measured trade-off, not silently patched around.
  const brief = 'Tallow Row is a small fashion label based in Portland, Oregon.';
  assert.equal(properNounFlagsFor(brief, 'Cut and sewn in Portl.'), 1);
});

// ---------------------------------------------------------------------------
// F6: an unrecognized sentence-initial word must still be checked — only a word that is ALREADY
// known (brief or dictionary) is exempt for sitting at a sentence's start.
// ---------------------------------------------------------------------------

test('F6: a single-word invented name as an entire sentence still flags', () => {
  const brief = 'Riverkeepers Trust is a local charity that cleans the rivers of the Wye valley.';
  assert.equal(properNounFlagsFor(brief, 'Zendesk.'), 1);
});

test('F6: an invented name immediately before a real dictionary word at a sentence\'s start still flags', () => {
  const brief = 'Riverkeepers Trust is a local charity that cleans the rivers of the Wye valley.';
  assert.equal(properNounFlagsFor(brief, 'Zendesk Software powers our bookings.'), 1);
});

test('F6: a sentence-initial word that IS already known (dictionary) is still exempt regardless of brief support', () => {
  // Was "Volunteers meet every Saturday." — but "Saturday" is not itself an ordinary SCOWL
  // dictionary word (the wordlist's "hacker" variant excludes most calendar words as proper
  // nouns), and g6-r3b-opus55's NOTE N-a removed `CALENDAR_WORDS`'s unconditional pass for
  // exactly that reason. Swapped to a genuinely ordinary dictionary word ("Mornings") so this
  // test still proves what it originally set out to prove (sentence-initial dictionary-word
  // handling), not a calendar-word collision.
  const brief = 'Riverkeepers Trust is a local charity that cleans the rivers of the Wye valley.';
  assert.equal(properNounFlagsFor(brief, 'Volunteers meet regularly outdoors.'), 0);
});

// ---------------------------------------------------------------------------
// F7 REVERTED (g6-r3-opus55 audit, BLOCK B2): the original F7 fix added an `ALL_PASSIVE_BY_AFTER_
// RE` bypass so "all" immediately before a passive-voice verb ("all run by …") skipped tracing
// entirely. The audit proved that too broad with a live counter-example: a brief stating "Most of
// our programmes are run by volunteers." against a page reading "Our programmes are ALL run by
// volunteers." is an invented WIDENING from "most" to "all", and the bypass hid it (0 flags on
// HEAD, 1 on main). The bypass is removed; "all" now always needs its own brief support, whether
// it precedes a noun or a passive verb.
// ---------------------------------------------------------------------------

function sentenceFlagsFor(brief: string, text: string): number {
  const slot: FaithfulnessSlot = { path: 'a', text };
  return deterministicSentenceClaimFlags(brief, [slot], new Set(['a'])).length;
}

test('F7 reverted: "all run by" now requires its own brief support, even in the passive-attribution shape', () => {
  const brief = 'Riverkeepers Trust: three programmes run by volunteers with a small staff team behind them.';
  assert.equal(sentenceFlagsFor(brief, 'Three programmes, all run by volunteers with a small staff team behind them.'), 1, 'a brief with no "all"/"every" equivalent must not let "all run by" pass silently');
});

test('F7: "all" as a quantifier before a NOUN still requires its own brief support (the historical concern this stays narrow for)', () => {
  const brief = 'Free shipping on orders over $50.';
  assert.equal(sentenceFlagsFor(brief, 'Free shipping on all orders.'), 1);
});

test('F7 reverted: "all run by" traces normally when the brief itself says "all" (no bypass needed for the honest case)', () => {
  const brief = 'Riverkeepers Trust: all three programmes are run by volunteers with a small staff team behind them.';
  assert.equal(sentenceFlagsFor(brief, 'Three programmes, all run by volunteers with a small staff team behind them.'), 0, 'when the brief itself states "all", the word traces on its own merits — no special-case needed');
});

test('F7 reverted: deterministicTraceableFlags (shared `traceableContentWordsOf`) also requires "all" to trace, no passive-attribution bypass', () => {
  const brief = 'Three programmes run by volunteers with a small staff team behind them.';
  const slot: FaithfulnessSlot = { path: 'a', text: 'Three programmes, all run by volunteers with a small staff team behind them.' };
  assert.deepEqual(deterministicTraceableFlags(brief, [slot], new Set(['a'])), [{ path: 'a', probability: 1 }]);
});
