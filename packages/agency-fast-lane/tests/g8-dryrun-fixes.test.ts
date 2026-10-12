/**
 * G8 dry-run fixes (live matrix on main 8e71aab644, proof/dryrun-G8.txt): two word-level
 * correctness fixes in `jev.ts`, each with its own guard that nothing flagged as an invented fact
 * before the fix now passes.
 *
 * 1. Page-side calendar/unit expansion stays unconditional (two exceptions were tried and Sol
 *    reverted both); institutional fixture's verbatim dates are checked in `x-verify: 'exact-date'` slots by
 *    whole-value equality to a brief date instead (`exact-date.ts`, group 5).
 * 2. Typographic apostrophes (U+2018, U+2019, U+02BC) between two letters fold to `'` on both
 *    sides before any word check (`normalizeForWords`).
 *
 * Owned inline briefs cover the generic boundaries without private provider recordings.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  claimTraceGaps,
  deterministicClaimFlags,
  deterministicCommercialWordFlags,
  deterministicProperNounFlags,
  deterministicSentenceClaimFlags,
  deterministicTraceableFlags,
  type FaithfulnessSlot,
} from '../src/jev.ts';
import { TEST_INSTITUTION_DIR } from './fixtures.ts';
import { deterministicExactDateFlags } from '../src/exact-date.ts';
import { loadFamilyPackage } from '../src/family.ts';
import { editableTemplate, exactDatePathsFor } from '../src/spine.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
const briefOf = (family: string, file = `compiler/scripts/families/${family}/reference.fixture.brief.txt`): string =>
  readFileSync(path.join(EXAMPLES, `agency-${family}`, file), 'utf8');

const INSTITUTION = "First event Thu 2 Oct. Second event Sat 11 Oct. Third event Wed 22 Oct. Fourth event Sun 2 Nov. We're a ten-minute walk from the station with step-free entry on the north side.";
const MAKER = 'A small workshop makes pieces to order.';
const BUILDER = 'A builder publishes project notes about warranty support after project handover.';
const STOREFRONT = briefOf('storefront', 'fixtures/briefs/rich.txt');

const one = (text: string): FaithfulnessSlot[] => [{ path: 'a', text }];
const paths = new Set(['a']);
const sentenceFlags = (brief: string, text: string) => deterministicSentenceClaimFlags(brief, one(text), paths).length;
const traceableFlags = (brief: string, text: string) => deterministicTraceableFlags(brief, one(text), paths).length;
const properNounFlags = (brief: string, text: string) => deterministicProperNounFlags(brief, one(text), paths).length;
/** Every deterministic check the base page runs on a free-prose slot, summed. */
const anyDeterministicFlag = (brief: string, text: string): number => (
  sentenceFlags(brief, text) + properNounFlags(brief, text) + deterministicClaimFlags(brief, one(text), paths).length
);

// ---------------------------------------------------------------------------
// 1. Page-side calendar/unit expansion is unconditional (Sol, g8fix-jev-sol-ruling.md and
//    -ruling2.md reverted both exceptions). Every case either ruling named must flag. Verbatim
//    dates go to `x-verify: 'exact-date'` slots instead (group 5).
// ---------------------------------------------------------------------------

test('prose gate: a verbatim abbreviated date still flags in prose, exactly as on main', () => {
  for (const date of ['Thu 2 Oct', 'Sat 11 Oct', 'Wed 22 Oct']) {
    assert.equal(sentenceFlags(INSTITUTION, date), 1, date);
    assert.equal(traceableFlags(INSTITUTION, date), 1, date);
  }
});

test('Sol counterexample (g6-sol-r11): "Sun deck" never licenses Sunday hours', () => {
  const brief = 'Sun deck: 4 seats. Open Saturday at 4pm.';
  assert.equal(sentenceFlags(brief, 'Open Saturday and Sunday at 4pm.'), 1);
  assert.equal(sentenceFlags(brief, 'Open Saturday and Sun at 4pm.'), 1);
  assert.equal(traceableFlags(brief, 'Open Sat and Sun'), 1);
});

test('Sol ruling 1 (g8fix): dates and units recombined from two brief facts flag', () => {
  assert.equal(sentenceFlags('Late opening on Thu 2 Oct. Late opening on Fri 9 Nov.', 'Late opening on Fri 2 Oct.'), 1);
  assert.equal(traceableFlags('Late opening on Thu 2 Oct. Late opening on Fri 9 Nov.', 'Late opening on Fri 2 Oct.'), 1);
  assert.equal(sentenceFlags('A 2 hr class and 9 min reset.', 'A 9 hr class.'), 1);
  assert.equal(traceableFlags('A 2 hr class and 9 min reset.', 'A 9 hr class.'), 1);
});

test('Sol ruling 2 (g8fix): a valid date or span attached to a different fact flags', () => {
  const cases: Array<[string, string]> = [
    ['Late opening on Thu 2 Oct 2025. The archive closes in 2026.', 'Late opening on Thu 2 Oct, 2026.'],
    ['A 2 hr class and a 9 min reset.', 'A 9 min class.'],
    ['Late opening on Thu 2 Oct. The workshop is on Fri 9 Nov.', 'The workshop is on Thu 2 Oct.'],
  ];
  for (const [brief, page] of cases) {
    assert.equal(sentenceFlags(brief, page), 1, page);
    assert.equal(traceableFlags(brief, page), 1, page);
  }
});

test('an expanded form must still match the brief', () => {
  const brief = 'Late opening on Thu 2 Oct.';
  // The page's full words are not the brief's words, and the brief is never promoted.
  assert.equal(traceableFlags(brief, 'Thursday 2 October'), 1);
  // A page abbreviation still matches a brief that spells the word out (unchanged behaviour).
  assert.equal(traceableFlags('Open Monday to Friday.', 'Open Mon to Fri'), 0);
  // "GC" still needs the brief's own "general contractor" when the brief never writes "GC".
  assert.equal(traceableFlags('We bake bread.', 'Licensed GC'), 1);
  assert.equal(traceableFlags('A licensed general contractor.', 'Licensed GC'), 0);
});

// ---------------------------------------------------------------------------
// 2. Typographic apostrophes
// ---------------------------------------------------------------------------

test('curly apostrophes: the same sentence passes with U+2019, U+2018 or U+02BC as with ASCII', () => {
  const ascii = "We're a ten-minute walk from the station with step-free entry on the north side.";
  assert.equal(anyDeterministicFlag(INSTITUTION, ascii), 0, 'ASCII baseline');
  for (const mark of ['’', '‘', 'ʼ']) {
    const text = ascii.replace("'", mark);
    assert.equal(sentenceFlags(INSTITUTION, text), 0, `sentence ${JSON.stringify(mark)}`);
    assert.equal(properNounFlags(INSTITUTION, text), 0, `proper noun ${JSON.stringify(mark)}`);
  }
});

test('curly apostrophes fold on the brief side too', () => {
  const brief = 'We’re open late on Fridays, with free entry for members.';
  assert.equal(sentenceFlags(brief, "We're open late on Fridays, with free entry for members."), 0);
});

test('curly apostrophes: a changed fact still flags, whatever apostrophe it is written with', () => {
  const brief = 'We refund any order within thirty days.';
  for (const text of ['We can’t refund an order after thirty days.', "We can't refund an order after thirty days."]) {
    assert.equal(sentenceFlags(brief, text), 1, text);
  }
  // "don't" is not "do": the folded word must itself be a brief word.
  assert.equal(sentenceFlags('We do ship abroad in five days.', 'We don’t ship abroad in five days.'), 1);
});

test('curly quotes around a quotation are not folded into the word', () => {
  const brief = 'Our late opening is called Slow Light, on Thursday 2 October.';
  assert.equal(sentenceFlags(brief, '‘Slow Light’ late opening on Thursday 2 October.'), 0);
});

// ---------------------------------------------------------------------------
// 3. Real invented facts from the dry run still flag
// ---------------------------------------------------------------------------

test('dry-run inventions: maker fixture "forty years" and its other invented claims still flag', () => {
  for (const text of [
    'How to keep them for forty years', // maker fixture-cerebras-1 care.title
    'We ship the finished piece insured; returns are accepted within thirty days at our cost.', // maker fixture-c1 step3Body
    'Handcrafted in small runs by two artisans, each piece is made to order and limited to twelve per design.', // maker fixture-c3 lede
  ]) {
    assert.equal(anyDeterministicFlag(MAKER, text) > 0, true, text);
  }
});

test('dry-run inventions: builder fixture paraphrased excerpts with an untraced claim word still flag', () => {
  for (const text of [
    'Learn about our methodology for pricing complex commercial projects before tender.',
    'Find out how we manage defect and warranty support after project handover.',
  ]) {
    assert.equal(sentenceFlags(BUILDER, text), 1, text);
  }
});

test('dry-run inventions: storefront "Shipping" link and an invented thirty-day return still flag', () => {
  assert.equal(deterministicCommercialWordFlags(STOREFRONT, one('Free shipping'), paths).length, 1);
  assert.equal(sentenceFlags(STOREFRONT, 'Orders ship within three business days; returns accepted within ninety days.'), 1);
});

test('claimTraceGaps names the words a repair must change, and nothing for a traced sentence', () => {
  const gaps = claimTraceGaps(BUILDER, 'Find out how we manage defect and warranty support after project handover.');
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0]!.missing.includes('manage'), JSON.stringify(gaps));
  assert.deepEqual(claimTraceGaps(INSTITUTION, 'A quiet room for looking.'), [], 'no claim signal, no gap');
  assert.equal(claimTraceGaps('We bake bread.', 'Licensed GC', true)[0]?.missing.includes('general'), true);
});

// ---------------------------------------------------------------------------
// 5. `x-verify: 'exact-date'` (institutional fixture's event dates): whole-value equality to a brief date.
// ---------------------------------------------------------------------------

test('exact-date: the owned fixture\'s event dates copied from the brief pass; anything else flags', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  for (const date of ['Thu 2 Oct', 'Sat 11 Oct', 'Wed 22 Oct', 'Sun 2 Nov', 'thu  2 oct']) assert.equal(flags(INSTITUTION, date), 0, date);
  for (const date of ['Fri 2 Oct', 'Thu 9 Oct', 'Thursday 2 October', '2 Oct', 'Thu 2 Oct 2025', 'Thu 2 Oct, 17:00', 'Sun 2 Oct', 'Soon', 'Thu 2 Oct.']) {
    assert.equal(flags(INSTITUTION, date), 1, date);
  }
  // No recombination: each value must be ONE whole brief date.
  const two = 'Late opening on Thu 2 Oct. The workshop is on Fri 9 Nov.';
  assert.equal(flags(two, 'Fri 2 Oct'), 1);
  assert.equal(flags(two, 'Thu 9 Nov'), 1);
  // The brief's date is longer: the year cannot be dropped, or changed.
  const withYear = 'Late opening on Thu 2 Oct 2025. The archive closes in 2026.';
  assert.equal(flags(withYear, 'Thu 2 Oct'), 1);
  assert.equal(flags(withYear, 'Thu 2 Oct, 2026'), 1);
  assert.equal(flags(withYear, 'Thu 2 Oct 2025'), 0);
  // Word boundaries: "2 Oct" is not found inside "22 Oct".
  assert.equal(flags('On Wed 22 Oct.', '2 Oct'), 1);
});

test('exact-date (Sol ruling 3, Opus F1): a sentence-final period is not part of the brief date', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  assert.equal(flags('Late opening on Thu 2 Oct.', 'Thu 2 Oct'), 0, 'the pass case');
  const two = 'Workshop: Fri 9 Nov. Late opening on Thu 2 Oct.';
  assert.equal(flags(two, 'Fri 9 Nov'), 0);
  assert.equal(flags(two, 'Thu 2 Oct'), 0);
  // A month abbreviation's own period before a day or year stays part of the date.
  assert.equal(flags('Opening on Oct. 2, 2025.', 'Oct. 2, 2025'), 0);
  assert.equal(flags('Opening on Oct. 2, 2025.', 'Oct 2, 2025'), 1);
});

test('exact-date (Sol ruling 3): a date that runs into a mark, format character or longer number is no brief date', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  assert.equal(flags('Late opening on Thu 2 Oct\u200B 2025.', 'Thu 2 Oct'), 1, 'zero-width space before the year');
  assert.equal(flags('Late opening on Thu 2 Oct\u2060 2025.', 'Thu 2 Oct'), 1, 'word joiner');
  assert.equal(flags('Late opening on Thu 2 Oct\u0301 2025.', 'Thu 2 Oct'), 1, 'combining mark');
  assert.equal(flags('Late opening on Thu 2 Oct 20256.', 'Thu 2 Oct'), 1, 'a longer number is not dropped as a year');
});

test('exact-date (Sol ruling 3): only ASCII whitespace runs and ASCII case fold', () => {
  const flags = (text: string) => deterministicExactDateFlags(INSTITUTION, one(text), paths).length;
  assert.equal(flags('THU 2 OCT'), 0);
  assert.equal(flags('Thu \t 2\nOct'), 0);
  for (const text of ['\uFF34\uFF48\uFF55 \u2461 \uFF2F\uFF43\uFF54', 'Thu\uFEFF2 Oct', 'Thu\u00A02 Oct', 'Thu 2\u200B Oct', 'Thu \uFF12 Oct', '\u017Fat 11 Oct']) {
    assert.equal(flags(text), 1, JSON.stringify(text));
  }
});

test('exact-date: the owned fixture\'s schema marks exactly its four event dates', async () => {
  const pkg = await loadFamilyPackage(TEST_INSTITUTION_DIR, 'ownedinstitution');
  const marked = [...exactDatePathsFor(pkg.schema, editableTemplate(pkg.fixture)!)].sort();
  assert.deepEqual(marked, [1, 2, 3, 4].map((n) => `sections[4].content.event${n}Date`));
});

// PR #136 round 3: exact-date redesigned fail-closed (find the value in the brief, then refuse any
// occurrence the brief's date could extend on either side). Opus round 2 B1/F1, Sol ruling 4.
test('exact-date round 3 (Opus B1): no endpoint of a brief date range passes', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  const rows: Array<[string, string]> = [
    ['Festival 2\u20134 Oct.', '4 Oct'], ['Festival 2\u20134 Oct.', '2\u20134 Oct'],
    ['Exhibition 13 Sep \u2013 30 Nov.', '30 Nov'], ['Exhibition 13 Sep \u2013 30 Nov.', '13 Sep'],
    ['Print fair, Sat 4\u2013Sun 5 Oct.', 'Sun 5 Oct'], ['Print fair, Sat 4\u2013Sun 5 Oct.', 'Sat 4 Oct'],
    ['Fri 3 and Sat 4 Oct', 'Sat 4 Oct'], ['Oct 2 to 4', 'Oct 2'],
    ['Open 2 Oct through 4 Oct.', '2 Oct'], ['Open 2 Oct/4 Oct.', '4 Oct'], ['Open 2 Oct & 4 Oct.', '2 Oct'],
    ['Open days: Sat 11 Oct, Sun 2 Nov.', 'Sun 2 Nov'], ['Open days: Sat 11 Oct, Sun 2 Nov.', 'Sat 11 Oct'],
  ];
  for (const [brief, value] of rows) assert.equal(flags(brief, value), 1, `${brief} -> ${value}`);
});

test('exact-date round 3 (Sol ruling 4): a Unicode separator before the year does not end the date', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  for (const sep of ['\u00A0', '\u202F', '\u2028', '\u200B ', '\u2009']) {
    assert.equal(flags(`Opening Thu 2 Oct${sep}2025.`, 'Thu 2 Oct'), 1, JSON.stringify(sep));
  }
  assert.equal(flags('Thu 2 Oct. 2025 was a good year.', 'Thu 2 Oct'), 1, 'a period followed by a year extends');
  assert.equal(flags('Opening Thu 2 Oct, 2025.', 'Thu 2 Oct'), 1, 'a comma followed by a year extends');
  assert.equal(flags('Thu 2 Oct 7 people came.', 'Thu 2 Oct'), 1, 'a bare number after the date is ambiguous: rejects');
  assert.equal(flags('Thu 2 Oct 1900 doors.', 'Thu 2 Oct'), 1, 'a four-digit number is a year: strict side');
});

test('exact-date round 3: a time after the date is not an extension; a sentence period is not part of it', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  assert.equal(flags('Late opening on Thu 2 Oct.', 'Thu 2 Oct'), 0);
  assert.equal(flags('Opening night Thu 2 Oct. 7pm start.', 'Thu 2 Oct'), 0);
  assert.equal(flags('Opening night Thu 2 Oct, 17:00-21:00.', 'Thu 2 Oct'), 0);
  // Round 4 allowlist: a time must itself end the clause; a word after it rejects.
  assert.equal(flags('Opening night Thu 2 Oct 7 p.m. start.', 'Thu 2 Oct'), 1);
  assert.equal(flags('Workshop: Fri 9 Nov. Late opening on Thu 2 Oct.', 'Fri 9 Nov'), 0);
  // The value must be the WHOLE date the brief writes: a shorter piece never passes.
  assert.equal(flags('Late opening on Thu 2 Oct.', '2 Oct'), 1);
  assert.equal(flags('Late opening on Thu 2 Oct.', 'Thu 2'), 1);
  // The owned inline brief: all four fixture dates pass.
  for (const date of ['Thu 2 Oct', 'Sat 11 Oct', 'Wed 22 Oct', 'Sun 2 Nov']) assert.equal(flags(INSTITUTION, date), 0, date);
});

// PR #136 round 4: both edges are an ALLOWLIST (Opus r3 B1/B2/F1, Sol ruling 5).
test('exact-date round 4: every range, connector and year form Opus r3 and Sol ruling 5 found flags', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  const rows: Array<[string, string]> = [
    // Opus r3 B1: a time between the date and a range connector.
    ['Print fair: Sat 4 Oct 10:00 \u2013 Sun 5 Oct 18:00.', 'Sat 4 Oct'], ['Print fair: Sat 4 Oct 10:00 \u2013 Sun 5 Oct 18:00.', 'Sun 5 Oct'],
    ['Sat 4 Oct, 10am\u2013Sun 5 Oct, 6pm', 'Sat 4 Oct'], ['Sat 4 Oct, 10am\u2013Sun 5 Oct, 6pm', 'Sun 5 Oct'],
    ['Sat 4 Oct 10am to Sun 5 Oct 6pm', 'Sat 4 Oct'], ['Sat 4 Oct 10am to Sun 5 Oct 6pm', 'Sun 5 Oct'],
    ['Festival 2 Oct 7pm to 4 Oct.', '2 Oct'], ['Festival 2 Oct 7pm to 4 Oct.', '4 Oct'],
    ['Exhibition 13 Sep 10.00 \u2013 30 Nov 17.00', '13 Sep'], ['Exhibition 13 Sep 10.00 \u2013 30 Nov 17.00', '30 Nov'],
    ['Workshops 2 Oct 7pm, 9 Oct 7pm', '2 Oct'], ['Workshops 2 Oct 7pm, 9 Oct 7pm', '9 Oct'],
    ['Late show Thu 2 Oct 7pm \u2013 Fri 3 Oct 1am', 'Thu 2 Oct'], ['Sat 4 Oct 10am until Sun 5 Oct', 'Sat 4 Oct'],
    // Opus r3 B2: connectors a denylist missed.
    ['Fair 2~4 Oct', '4 Oct'], ['Thu 2 Oct~Sat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct~Sat 4 Oct', 'Sat 4 Oct'],
    ['Thu 2 Oct \u2192 Sat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct \u2192 Sat 4 Oct', 'Sat 4 Oct'],
    ['Thu 2 Oct\uFF0DSat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct\uFF0DSat 4 Oct', 'Sat 4 Oct'],
    ['Thu 2 Oct\u301CSat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct\u2E3ASat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct\uFE58Sat 4 Oct', 'Thu 2 Oct'],
    ['Thu 2 Oct+Sat 4 Oct', 'Thu 2 Oct'], ['Thu 2 Oct plus Fri 3 Oct', 'Thu 2 Oct'],
    ['Thu 2 Oct or Fri 3 Oct (TBC)', 'Thu 2 Oct'], ['Thu 2 Oct or Fri 3 Oct (TBC)', 'Fri 3 Oct'], ['Thu 2 Oct, or Fri 3 Oct', 'Thu 2 Oct'],
    // Opus r3 F1 and Sol ruling 5: bracketed or apostrophe year, sentence period, tilde.
    ["Opening Thu 2 Oct '25.", 'Thu 2 Oct'], ['Opening Thu 2 Oct (2025).', 'Thu 2 Oct'], ['Opening Thu 2 Oct [2025].', 'Thu 2 Oct'],
    ['Opening Thu 2 Oct.', 'Thu 2 Oct.'], ['Open 2 Oct ~ 4 Oct.', '4 Oct'], ['Open 2 Oct ~ 4 Oct.', '2 Oct'],
    // Open-ended qualifiers now reject (accepted cost of the allowlist).
    ['Opening Thu 2 Oct onwards', 'Thu 2 Oct'], ['Opening Thu 2 Oct (provisional)', 'Thu 2 Oct'],
    // A time before the date on the left, and a dotted number that may be a date.
    ['7pm, Thu 2 Oct.', 'Thu 2 Oct'], ['Sat 4 Oct 10.11.', 'Sat 4 Oct'],
  ];
  for (const [brief, value] of rows) assert.equal(flags(brief, value), 1, `${brief} -> ${value}`);
});

test('exact-date round 4: the allowlist still passes a whole date followed by a time or a sentence end', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  const rows: Array<[string, string]> = [
    ['Late opening on Thu 2 Oct.', 'Thu 2 Oct'],
    ['Thu 2 Oct, 17:00-21:00;', 'Thu 2 Oct'],
    ['Sat 4 Oct 10am\u20136pm', 'Sat 4 Oct'],
    ['Opening night Thu 2 Oct. 7pm start.', 'Thu 2 Oct'],
    ['Opening Thu 2 Oct.', 'Thu 2 Oct'],
    ['Workshop: Fri 9 Nov. Late opening on Thu 2 Oct.', 'Fri 9 Nov'],
    ['Opening on Oct. 2, 2025.', 'Oct. 2, 2025'],
  ];
  for (const [brief, value] of rows) assert.equal(flags(brief, value), 0, `${brief} -> ${value}`);
  for (const date of ['Thu 2 Oct', 'Sat 11 Oct', 'Wed 22 Oct', 'Sun 2 Nov']) assert.equal(flags(INSTITUTION, date), 0, date);
});

// Sol ruling 6: a dropped year written in non-ASCII numerals is still a year.
test('exact-date: a year in fullwidth, Persian or Arabic-Indic digits continues the date on either edge', () => {
  const flags = (brief: string, text: string) => deterministicExactDateFlags(brief, one(text), paths).length;
  for (const year of ['\uFF12\uFF10\uFF12\uFF15', '\u06F2\u06F0\u06F2\u06F5', '\u0662\u0660\u0662\u0665']) {
    assert.equal(flags(`Opening Thu 2 Oct, ${year}.`, 'Thu 2 Oct'), 1, `right, comma: ${year}`);
    assert.equal(flags(`Opening Thu 2 Oct ${year}.`, 'Thu 2 Oct'), 1, `right, space: ${year}`);
    assert.equal(flags(`Opening Thu 2 Oct. ${year} was a good year.`, 'Thu 2 Oct'), 1, `right, after period: ${year}`);
    assert.equal(flags(`Opening Thu 2 Oct (${year}).`, 'Thu 2 Oct'), 1, `right, bracketed: ${year}`);
    assert.equal(flags(`In ${year}, opening Thu 2 Oct.`, 'Thu 2 Oct'), 1, `left: ${year}`);
  }
  assert.equal(flags('Fair \u0662 Oct \u2013 Thu 4 Oct.', 'Thu 4 Oct'), 1, 'left: an Arabic-Indic day');
  assert.equal(flags('Opening Thu 2 Oct, \uFF11\uFF17:\uFF10\uFF10.', 'Thu 2 Oct'), 1, 'a fullwidth time is not recognized: rejects');
  assert.equal(flags('Opening Thu 2 Oct, TBC.', 'Thu 2 Oct'), 0, 'qualifier loss is left to Jev (documented)');
});
