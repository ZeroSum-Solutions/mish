/**
 * G6 (claim and name honesty in every family): two groups of tests.
 *
 * 1. `deterministicProperNounFlags` (`src/jev.ts`) — positive and negative phrasing cases: an
 *    invented person name flags, an invented place name flags, a brand name the brief states
 *    passes, a sentence-initial word is never itself evidence of a name, an acronym the brief
 *    states passes and one it does not flags, and a few multi-word/possessive/hyphenation shapes.
 *    Registry coverage (every family's own reference fixture, zero flags) lives in
 *    `claim-name-honesty-all-families.test.ts`.
 *
 * 2. `~/.claude/goal-state/mishh-genui-finish/f6-phrasing-cases.md`: every case that file records,
 *    turned into a test. That file documents ONE known, NOT-YET-FIXED gap in
 *    `deterministicTraceableFlags` — a practical-fact VALUE can be a legitimate bag of real brief
 *    words while answering the WRONG fixed category (a "Getting there" row filled with a Language
 *    fact, and the reverse) — found by a round-4 Grok audit and explicitly marked "DO NOT fix now"
 *    for a separate future task (direction 1 or 2 in that file's own "Suggested fix direction").
 *    G6's task list (1–5) does not include implementing either direction, so these two tests
 *    document the CURRENT behavior (both cases currently pass `deterministicTraceableFlags` with
 *    zero flags) as a locked-in regression guard, not a fix — a future pass that closes this gap
 *    should find these two tests here and update them, not discover the gap from scratch again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicProperNounFlags, deterministicTraceableFlags, type FaithfulnessSlot } from '../src/jev.ts';

// ---------------------------------------------------------------------------
// 1. deterministicProperNounFlags
// ---------------------------------------------------------------------------

const BRIEF = 'Tallow Row is a small fashion label based in Portland, Oregon, founded by Priya Raman. '
  + 'We ship with FedEx and sell through our shop, Willow & Co. Our brand is TRS.';

function flagsFor(text: string, brief = BRIEF): ReadonlyArray<{ path: string; probability: number }> {
  const slots: FaithfulnessSlot[] = [{ path: 'a', text }];
  return deterministicProperNounFlags(brief, slots, new Set(['a']));
}

test('deterministicProperNounFlags: an invented person name (no brief support) flags', () => {
  assert.equal(flagsFor('Our lead stylist is Marguerite Ashcombe.').length, 1);
});

test('deterministicProperNounFlags: an invented place name (no brief support) flags', () => {
  assert.equal(flagsFor('We also have a showroom in Larkmoor Heights.').length, 1);
});

test('deterministicProperNounFlags: a brand name the brief states passes, whole-phrase, not split and double-penalized', () => {
  assert.deepEqual(flagsFor('Shop the new collection from Tallow Row.'), []);
});

test('deterministicProperNounFlags: a sentence-initial word that is itself already known (brief or dictionary) is exempt', () => {
  // "Tallow" is capitalized only because it starts the sentence, AND it is brief-stated (part of
  // "Tallow Row") — exempt on either ground.
  assert.deepEqual(flagsFor('Tallow opens a new line every autumn.'), []);
});

test('deterministicProperNounFlags: an UNRECOGNIZED sentence-initial word is still checked, and flags (audit finding F6)', () => {
  // "Fabuloso" is capitalized only because it starts the sentence, but it has no brief or
  // dictionary support at all — sentence-initial capitalization is ordinary English ONLY when the
  // word itself is ordinary; an invented name at a sentence's start must not evade this check by
  // starting position alone (a round-1 adversarial audit finding: an unconditional sentence-
  // initial drop let exactly this evade detection).
  assert.equal(flagsFor('Fabuloso pieces, cut and sewn by hand.').length, 1);
});

test('deterministicProperNounFlags: a later word in the SAME leading run is still checked — sentence-initial exemption covers only the first word', () => {
  // "Portland" is brief-supported (passes); an invented second capitalized word right after it in
  // the same leading run must still flag.
  assert.equal(flagsFor('Portland Larkbury is where we cut every pattern.').length, 1);
});

test('deterministicProperNounFlags: an acronym the brief states passes', () => {
  assert.deepEqual(flagsFor('Every piece carries the TRS mark.'), []);
});

test('deterministicProperNounFlags: an acronym the brief does not state flags', () => {
  assert.equal(flagsFor('Every piece carries the QVX mark.').length, 1);
});

test('deterministicProperNounFlags: ordinary title-case styling (every word a common dictionary word) never flags — no name is being claimed', () => {
  assert.deepEqual(flagsFor('Shop New Arrivals Today.'), []);
});

test('deterministicProperNounFlags: a possessive on a brief-stated name still traces ("Tallow Row\'s")', () => {
  assert.deepEqual(flagsFor("Tallow Row's new autumn run is live."), []);
});

test('deterministicProperNounFlags: a hyphenated brief-stated name traces as a phrase ("Willow & Co" via its own words)', () => {
  assert.deepEqual(flagsFor('Find us at Willow & Co this season.'), []);
});

test('deterministicProperNounFlags -> N-b (g6-r3b-opus55 audit, whole-word matching only): a byte-budget clip mid-word now flags too — the brief-word-prefix exemption is removed entirely, an accepted trade-off', () => {
  // This used to pass on the theory that a byte-budget clip is a separate, already-handled
  // failure mode belonging to the lexical-completion gate (`text-clip.ts`), not this check. The
  // g6-r3b-opus55 audit's N-b finding showed the SAME brief-word-prefix mechanism also let an
  // unrelated INVENTED short name pass merely by sharing a longer brief word's prefix — prefix
  // matching cannot tell the two cases apart, so it is removed entirely. A genuine clip now flags
  // here too; the real production pipeline avoids ever generating one in the first place via
  // `clipWholeWords` (whole-word-safe truncation), so this scenario should not reach a live build.
  assert.deepEqual(flagsFor('Cut and sewn in Portl.'), [{ path: 'a', probability: 1 }]);
});

test('deterministicProperNounFlags: only the marked paths are checked at all', () => {
  const slots: FaithfulnessSlot[] = [{ path: 'unchecked', text: 'A page by Nobody Invented.' }];
  assert.deepEqual(deterministicProperNounFlags(BRIEF, slots, new Set(['other'])), []);
});

// ---------------------------------------------------------------------------
// 2. f6-phrasing-cases.md: the category/value swap gap, both worked examples
// ---------------------------------------------------------------------------

const GUIDE_PRACTICAL_FACTS_BRIEF = 'Getting there — the nearest airport is Amberlee Regional, forty minutes by taxi. '
  + 'Best time to visit — late spring, before the tour buses arrive. '
  + 'Currency — the local currency is the Amberlee crown; cards are widely accepted. '
  + 'Language — English is spoken throughout the town, alongside the local dialect.';

test('f6-phrasing-cases.md case 1: a "Getting there" row filled with the brief\'s own Language sentence currently passes deterministicTraceableFlags (known gap, not fixed by G6)', () => {
  const slot: FaithfulnessSlot = { path: 'practical-facts.items[0].value', text: 'English is spoken throughout the town.' };
  const flagged = deterministicTraceableFlags(GUIDE_PRACTICAL_FACTS_BRIEF, [slot], new Set([slot.path]));
  assert.deepEqual(flagged, [], 'every word traces to the brief; the row/category mismatch is invisible to a whole-field word-trace check (see f6-phrasing-cases.md)');
});

test('f6-phrasing-cases.md case 2 (reversed): a "Language" row filled with the brief\'s own Getting-there sentence currently passes deterministicTraceableFlags (known gap, not fixed by G6)', () => {
  const slot: FaithfulnessSlot = { path: 'practical-facts.items[3].value', text: 'The nearest airport is Amberlee Regional, forty minutes by taxi.' };
  const flagged = deterministicTraceableFlags(GUIDE_PRACTICAL_FACTS_BRIEF, [slot], new Set([slot.path]));
  assert.deepEqual(flagged, [], 'same category/value swap, reversed — still invisible to the whole-field word-trace check (see f6-phrasing-cases.md)');
});
