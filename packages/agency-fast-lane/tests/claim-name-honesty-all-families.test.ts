/**
 * G6 (claim and name honesty in every family): `deterministicSentenceClaimFlags` and
 * `deterministicProperNounFlags` (`src/jev.ts`) now run unconditionally for every registered
 * family, the same shape `deterministicClaimFlags` already had — `run.ts`'s old
 * `SENTENCE_CLAIM_FAMILIES` allowlist is gone.
 *
 * PLAIN STATEMENT: G6's own "false positives must be 0" bar is NOT met. As of this test (round
 * 11, g6-sol-r11 audit — GPT-6 Sol as the PRD's arbiter), 50 residual flags remain on committed
 * reference fixtures — 41 from `deterministicSentenceClaimFlags` (`KNOWN_RESIDUAL_FLAGS`) and 9
 * (G8 dry-run fix: 38 now — the 3 halcyon event dates moved to `x-verify: 'exact-date'`)
 * from `deterministicProperNounFlags` (`KNOWN_PROPER_NOUN_RESIDUAL_FLAGS`, both below) — in TWO
 * categories:
 * - 37 PARAPHRASE FPs — the fixture is faithful to its brief; the deterministic checker just
 *   cannot recognize the paraphrase/synonym/day-abbreviation as equivalent, or (round 10) cannot
 *   recognize a dummy grammatical subject ("there is") as carrying no content of its own now that
 *   the existential-"there" exemption is removed. Round 11 reopened 3 more in this category:
 *   halcyon's own "Thu 2 Oct"/"Sat 11 Oct"/"Wed 22 Oct" event dates, once `CALENDAR_CANONICAL`
 *   went page-side-only with no exception (see below).
 * - 13 FIXTURE-ONLY COPY findings — the fixture states a fact its own brief does not corroborate
 *   at all; a round-6 attempt to "complete" these briefs was reverted in round 8 because it
 *   copied the fixture's own fictional prose into the brief instead of stating the fact
 *   independently (Gemini g6-r2 + the watchdog both caught this as circular). These are open
 *   findings, not closed and not false positives — the checker is right to flag them; the honest
 *   fix is either an independently-worded brief completion or leaving the fixture's claim
 *   unsupported and accepting the flag.
 * Round 10 (g6-r3b-opus55 audit) REMOVED several shared-list loosenings entirely rather than
 * narrowing them further (existential "there", the brief-word-prefix clip exemption, `CALENDAR_
 * WORDS`' unconditional pass, the unconditional percent-suffix drop) — see each constant's own
 * removal note in `jev.ts`/`template-chrome.ts` and the ledger's Round 10 section for the full
 * before/after count and every reopened residual. Round 11 (g6-sol-r11 audit) then found round
 * 10's own replacement for two-way calendar canonicalization — an `isDateContext` gate that
 * allowed either side to canonicalize a calendar abbreviation when a digit sat nearby — was
 * itself unsafe (Sol's counterexample: "Sun deck: 4 seats" has a digit next to "Sun" for a reason
 * that has nothing to do with a date), so it was removed with no replacement: `CALENDAR_CANONICAL`
 * is page-side only, unconditionally, exactly like `UNIT_ABBREVIATION_CANONICAL`/
 * `ABBREVIATION_EXPANSIONS`. See the ledger's Round 11 section for the reopened residuals and the
 * `x-heading` chrome-exemption inventory audit (item 2) it also required.
 * Full reasoning, the before/after FP counts across every round, and the brief completions that
 * genuinely did close (wrenfield x2, halcyon x1) are all in
 * `~/.claude/goal-state/mishh-genui-finish/proof/G6-fixture-edits.md` (a ledger outside this
 * repo — see that file for the coordinator's own ruling on each one).
 *
 * This test does NOT loosen the gate to hide those 50: both allowlists below are EXACT sets,
 * checked for exact equality against what the checks actually flag, both directions —
 * a NEW flag anywhere (this family or any other) fails the test, and so does any of these 50
 * silently disappearing (paraphrase-detection getting narrower, a fixture/brief edit, whatever) —
 * either way the list must be updated by hand, never auto-widened. `run.ts`'s actual production
 * gate (`makeCheckOnce`/`withAdapterDeterministicGates`) is completely unaffected by this file: it
 * still flags all 50 of these on any live build that reproduces this exact fixture content,
 * exactly as before. This file only changes what CI treats as a known, tracked gap versus a new
 * bug.
 *
 * "Covered" means every family id the registry knows about was actually exercised here, not just
 * that a check exists in the abstract — the same registry-diff discipline
 * `link-honesty-all-families.test.ts` already established for G5.
 *
 * Brief resolution: every family's own brief lives at
 * `compiler/scripts/families/<family>/reference.fixture.brief.txt` — except `storefront`, whose
 * reference fixture is checked against `fixtures/briefs/rich.txt` instead (see
 * `storefront-family.test.ts`'s own fixture-drift tests); this file follows the same fallback.
 *
 * Scope: the same `properNounPaths` exclusion `run.ts`'s `makeCheckOnce` applies — a slot already
 * covered by its own dedicated, stricter deterministic check (`person-name`, `quote`, `traceable`,
 * `destination`, a contact atom) is not re-checked by the generic proper-noun heuristic here
 * either, for the same reason documented at that call site. G8 final: an `hours-label` slot IS
 * checked here now, as in `run.ts` (the hours-label marker only adds the row check). The row
 * check itself is swept over every fixture below too, and must flag nothing.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyRegistry } from '../src/atlas.ts';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';
import {
  collectFaithfulnessSlots, deterministicHoursLabelFlags, deterministicProperNounFlags, deterministicSentenceClaimFlags, type FlaggedSlot,
} from '../src/jev.ts';
import {
  altTextPathsFor, contactPathsFor, destinationPathsFor, editableTemplate, exactDatePathsFor, getAtPath, hoursLabelPathsFor,
  hoursGroupsFor, hoursNullPathsFor, hoursRowValuePathsFor, labelPathsFor, mockPathsFor, personNamePathsFor, quotePathsFor, traceablePathsFor,
} from '../src/spine.ts';
import { templateChromePaths } from '../src/template-chrome.ts';
import { deterministicExactDateFlags } from '../src/exact-date.ts';
import { deterministicHoursNullFlags } from '../src/hours-label.ts';

/** `storefront`'s reference recipe is checked against `fixtures/briefs/rich.txt`, not a
 * `reference.fixture.brief.txt` (it has none) — see this file's own docblock. Every other
 * registered family carries its own `reference.fixture.brief.txt` alongside its fixture. */
function briefPathFor(family: string, packageDir: string): string {
  const own = path.join(packageDir, 'compiler', 'scripts', 'families', family, 'reference.fixture.brief.txt');
  if (existsSync(own)) return own;
  if (family === 'storefront') return path.join(packageDir, 'fixtures', 'briefs', 'rich.txt');
  throw new Error(`${family}: no reference.fixture.brief.txt found at ${own}`);
}

/**
 * The exact, hand-maintained set of residual false positives — see this file's own docblock.
 * Each entry is `${family}:${path}` for a `deterministicSentenceClaimFlags` flag. `deterministic
 * ProperNounFlags`'s own residuals (currently one, storefront's "Boxy") are tracked SEPARATELY in
 * `KNOWN_PROPER_NOUN_RESIDUAL_FLAGS` below (g6-r3b-opus55 audit NOTE N-e: this comment used to say
 * "no `properNoun` residuals" — stale as of round 9, which added the first one). Update this list
 * ONLY after re-reading the ledger's reasoning for the entry being added or removed — never to
 * silence a fresh, unexplained flag.
 *
 * Split into two categories per the coordinator's round-8 ruling (Gemini g6-r2 + the watchdog):
 * a PARAPHRASE FP is a checker-gap — the fixture text is faithful to the brief, just phrased in
 * words the deterministic word-tracer cannot recognize as equivalent. A FIXTURE-ONLY COPY is
 * different and more serious: the fixture states a specific fact or claim its own brief does not
 * corroborate at all — the checker is CORRECT to flag it, and the honest fix is a brief
 * completion (a genuinely independent statement of the missing fact), never a brief edit that
 * just copies the fixture's own prose back into the brief (which is circular — see the ledger's
 * "Correction" entry for exactly how 5 maren "completions" and 1 nonprofit "completion" did
 * that, and were reverted this round).
 */
const KNOWN_RESIDUAL_FLAGS: ReadonlySet<string> = new Set([
  // ---------------------------------------------------------------------
  // PARAPHRASE FPs — faithful to the brief, checker gap only.
  // ---------------------------------------------------------------------
  // "Doors open to everyone after five" — "everyone" traces (universal-pronoun stopword), but
  // "doors" is an ordinary word gap with no general fix pattern (not a fraction, hedge, or
  // determiner-vs-pronoun case).
  'halcyon:sections[4].content.event1Kind',
  // "Free entry every open day" — "every" is a genuine determiner-on-a-noun frequency claim,
  // deliberately left un-exempted (this file's own quantifier-removal history).
  'halcyon:sections[7].content.tier1Benefit1',
  // "Two adults and any children living at the same address." — "any" is the same genuine
  // determiner case as above; "living" is a separate, unrelated word gap.
  'halcyon:sections[7].content.tier2Note',
  // "There is no cart on this page on purpose...so an order starts..." — "purpose"/"starts"/"an"
  // paraphrase a faithful brief summary with no general synonym-detection pattern available.
  'maren:sections[5].content.lede',
  // "Anything that is not right comes back at our cost for thirty days." — "right"/"comes" are
  // synonym substitutions for the brief's "returns"/(defective), no general fix pattern.
  'maren:sections[5].content.step3Body',
  // "None of this is difficult. It is mostly about what you take off..." — vague filler with 6+
  // unmatched words ("none"/"difficult"/"take"/"off"/"do"/"something"/"else"); no single pattern
  // accounts for all of them.
  'maren:sections[6].content.lede',
  // Round 7 (watchdog-flagged x-heading hole, template-chrome.ts's `isClaimBearingHeading`): the
  // first version of x-heading exempted ANY unchanged heading with no length/claim limit at all.
  // Narrowing it (short + no sentence-final punctuation + no digit/quantifier + no proper noun
  // outside the brief) re-exposed these 5 — each investigated and judged a faithful paraphrase of
  // brief-stated content, not an invented fact, so none were brief-completed:
  // "Getting here, and what it costs." — only "getting" is unsupported; introductory section
  // framing, not a fact beyond what the visit section already states (walk time, admission).
  'halcyon:sections[6].content.title',
  // Round 10 (g6-r3b-opus55 audit, BLOCK-1): the existential-"there" exemption is removed
  // entirely (no replacement, no exception). "The Hall is a ten minute walk from the station and
  // there is step-free entry on the north side." — the brief's own words are "We're a ten-minute
  // walk from the station with step-free entry on the north side."; "there" itself is now the
  // only unsupported word (a faithful restatement using a dummy grammatical subject instead of
  // "with"), but with no exemption left, it must trace like any other word and does not.
  'halcyon:sections[6].content.lede',
  // G8 dry-run fix: halcyon's own "Thu 2 Oct"/"Sat 11 Oct"/"Wed 22 Oct" event dates (reopened
  // by round 11, when CALENDAR_CANONICAL went page-side only) are removed from this list: the
  // schema marks them `x-verify: 'exact-date'`, so they are checked by whole-value equality to a
  // brief date (`exact-date.ts`, asserted above) instead of the two prose checks. The prose gate
  // itself is unchanged (Sol reverted two gate exceptions for this; see g8-dryrun-fixes.test.ts).
  // "The building is old and the collection is not free to keep." — "old"/"not"/"keep"
  // unsupported. "old" is a low-risk inference from the brief's own "open since 1961", not an
  // invented fact the way wrenfield's fabricated year/model number were; "not"/"keep" are
  // negation/function words with no content of their own.
  'halcyon:sections[8].content.title',
  // maben's Round 9 and editorial-excerpt residuals were retired on 2026-10-10: the redesigned
  // reference fixture names real (fictional-client) projects and notes, every fact traced to the
  // rewritten reference.fixture.brief.txt, so no placeholder ordinals or self-describing excerpts
  // remain to flag.
  // maren's "care" section title, "How to keep them for forty years" — only "keep" is
  // unsupported (a synonym for "care for"/"look after"); "forty" and "years" already trace
  // (coincidentally present in the brief's "loses one pearl instead of forty").
  'maren:sections[6].content.title',
  // Round 9 (g6-r3-opus55 audit, FIX F2 — award/credential/superlative signals added to
  // isClaimBearingSentence): 5 sentences newly become "claim-bearing" and are checked for the
  // first time, purely because they contain "most" (as an ordinary quantifier, not a superlative
  // of standing — the audit explicitly said not to tune the signal narrower just to keep counts
  // low) or "certificate"/"award" (in an ordinary, faithful sense). Each was measured honestly:
  // none states an invented credential or superlative claim; each fails on an UNRELATED word gap.
  'emmpo:sections[1].content.career-box-text', // "would" unsupported — "You find the careers that you would most likely Enjoy and are good at."
  'maren:sections[3].content.fact3Note', // "takes" unsupported — "Knotting between beads takes most of a working day."
  'maren:sections[4].content.material1Note', // "certificate"/"folder" unsupported — "Graded by hand on this table, not by a certificate in a folder."
  'practice:sections[7].text.body', // "straightforward"/"cash"/"pay"/"option"/"routine" unsupported — "We work with most major PPO plans and offer a straightforward cash-pay option for routine care."
  'watson:sections[4].content.awardAlt', // "team" unsupported — "Watson team celebrating its Grand Clio Award"
  // (PR #136 round 1, Opus B1: an `x-alt-text` exemption here was reverted — this slot is where
  // a model writes award names, so it stays under both prose checks; the residual stays tracked.)
  // Round 9 (g6-r3-opus55 audit, BLOCK B2 removals) re-exposed these 2. Both are genuinely
  // faithful to their OWN real brief (unlike the audit's synthetic "most"/"all" counter-example
  // brief, used only to prove the removed bypass unsafe in general):
  // nonprofit's "Three programmes, all run by volunteers with a small staff team behind them." —
  // the brief's own words are "three programmes run by volunteers with a small staff team behind
  // them" (no literal "all"); the ALL_PASSIVE_BY_AFTER_RE bypass is gone, so "all" now needs its
  // own brief support even in this honest case, and doesn't have it.
  'nonprofit:sections[3].text.body',
  // Round 9 (g6-r3-opus55 audit, FIX F1): x-alt-text removed from halcyon's `caption` field
  // (kept on the `*Alt` fields — genuine stock-photo descriptions). Halcyon's captions name real
  // galleries and exhibitions ("A Slow Looking session in Gallery Two." — both "Slow Looking" and
  // "Gallery Two" are brief-stated), so they are not stock-photo alt text and must be checked like
  // any other prose. Only "session" is unsupported (an ordinary synonym-ish word) — faithful,
  // checker gap.
  'halcyon:sections[5].content.caption',
  // halcyon's "Admission covers about a third of what a year costs here." — the brief states
  // "34%" and "about a third" is an accurate, faithful rounding (33.3% ≈ 34%); FRACTION_WORD_
  // PERCENT (the ±2-point fraction-to-percent tolerance) was removed per NOTE N1 rather than
  // half-fixed (tying it to a shared content noun was not a small change), and "about" is no
  // longer a stopword either (BLOCK B2), so this sentence now fails on both "about" and "third".
  'halcyon:sections[8].content.lede',

  // ---------------------------------------------------------------------
  // FIXTURE-ONLY COPY — the fixture states a fact/claim its brief does not corroborate. Round 6's
  // "brief completions" for these were reverted this round (round 8) because they copied the
  // fixture's own fictional prose into the brief rather than stating the fact independently — see
  // the ledger's "Correction" entry. These are honestly counted as unresolved, NOT as false
  // positives and NOT as closed.
  // ---------------------------------------------------------------------
  // "The run size is set by what two people can finish between January and the end of summer.
  // When a run closes it opens again the following year, if it opens at all." — the brief states
  // 12 pieces/run, 2 pairs of hands, 4 weeks order-to-post, but never a January-to-end-of-summer
  // production WINDOW.
  'maren:sections[2].content.lede',
  // "What two people can finish in a day" (the "craft" section title) — the same invented
  // production-capacity claim as sections[2].lede above, in a different field.
  'maren:sections[3].content.title',
  // "...and sorted for the good ones." — the brief says only "never cast five hundred at a
  // time"; a post-cast sorting/rejection step is not stated.
  'maren:sections[3].content.para2',
  // "Pearls are chosen strand by strand... Knotting is slow..." — "chosen strand by strand" and
  // "slow" are added descriptive claims with no brief anchor.
  'maren:sections[3].content.para3',
  // "Set by the hours in a working year, not by what sells." — an invented positioning/rationale
  // claim; none of the brief's own "Facts" (12/run, 2 hands, 6 hours/strand, 2016 first bench)
  // says this.
  'maren:sections[3].content.fact1Note',
  // "We buy small and we buy the same thing every time, so a piece bought this year sits beside
  // one bought three years ago without looking like a different studio made it." — no brief
  // anchor at all for a buying-consistency-across-years claim.
  'maren:sections[4].content.lede',
  // "...Write to the studio and you will have a price before you decide anything." — the brief's
  // "write to the studio" sentence is about run-opening ANNOUNCEMENTS, not a pricing-before-
  // commitment promise for custom orders.
  'maren:sections[5].content.note',
  // "...There is one good chair and north light until about four." — entirely invented
  // physical/atmospheric studio detail (a chair, "north light", a closing time).
  'maren:sections[8].content.lede',
  // "A one-off gift pays for a clean-up day. A monthly gift keeps testing going all year." —
  // the brief states specific amounts and mechanisms ("a one-off gift of 25 buys grabbers and
  // bags for a clean-up team of ten"; "a monthly gift of 10 covers a year of test kits for one
  // volunteer tester") that this sentence drops and restates differently.
  'nonprofit:sections[8].text.body',
  // Round 9 (g6-r3-opus55 audit, FIX F3): the wrenfield (all 4 copies) and halcyon round-6 "brief
  // completions" are reverted — both were the same circular move that got maren/nonprofit
  // reverted in round 8. Wrenfield's brief now restates exactly the fixture's own "replaced 2025"/
  // "Andersen 400" facts (the ledger itself had already classed those as invented true positives
  // before the round-6 "completion" copied them into the brief); halcyon's now says "plus
  // everything above, plus a guided conservation walk" — "everything above" is fixture wording,
  // not a fact about the museum, and "guided" appears in neither the fixture nor a real brief
  // fact. Both briefs are reverted to byte-identical with `origin/main`.
  // "Standing-seam roof — replaced 2025" — the brief never states a roof replacement year.
  'wrenfield:sections[1].content.annotationRoofLabel',
  // "Andersen 400 casements" — the brief says only "Andersen windows", no "400" model number.
  'wrenfield:sections[1].content.annotationWindowsLabel',
  // "Everything above, plus the conservation walk twice a year." — the Patron tier's own brief
  // text is "free entry for four, visits to the conservation studio, named in the annual report"
  // — no conservation WALK and no frequency are ever stated.
  'halcyon:sections[7].content.tier3Note',
]);

/**
 * The exact, hand-maintained set of residual `deterministicProperNounFlags` false positives.
 * Round 9 (g6-r3-opus55 audit, BLOCK B1): the SCOWL wordlist was reverted from size 60 back to
 * size 50 (the size `origin/main` ships — a shared wordlist may not grow just to clear one
 * fixture's false positive). That reopens "Boxy" (storefront's own "Boxy cut, single chest
 * pocket.") — the SAME false positive `a0bc307cbd` widened the wordlist to hide. This is a
 * PARAPHRASE FP (the fixture is faithful; "boxy" is an ordinary word absent from the size-50
 * list, not an invented name), fixed the honest way this round: in storefront's own contract, or
 * left as a residual — NOT by growing a shared list again.
 */
/** The reference fixtures' hours rows that are not a verbatim copy of their brief's hours row
 * (PR #137 verbatim ruling; see the sweep below). Every one is also masked in the fill prompt. */
const KNOWN_HOURS_RESIDUAL_FLAGS: ReadonlySet<string> = new Set([
  'restaurant:sections[3].items[0].label', 'restaurant:sections[3].items[1].label', 'restaurant:sections[3].items[2].label', // "Tue-Thu" / "Fri-Sat" / "Sun-Mon"
  'practice:sections[9].items[0].label', 'practice:sections[9].items[1].label', 'practice:sections[9].items[2].label', // "Mon-Thu | 8:00am - 5:00pm" ...
  'halcyon:sections[1].content.railValue1', // the hero rail never shows hours: "Wednesday to Sunday"
  'halcyon:sections[1].content.railValue2', // "11:00 to 18:00" (also wrong for Saturday and Sunday)
  'halcyon:sections[1].content.railValue3', // "Free after 17:00"
  // G8 final on 857a46b982 (halcyon x cerebras VERIFY_FAILED): block1Key1-4 and col2Row1-4 used
  // to be reworded ("Wed to Fri | 11:00 – 18:00", "Wednesday to Friday, 11:00 – 18:00 ...")
  // against the brief's own "Wednesday-Friday 11:00-18:00" style. Round 2/3 audit correction: the
  // model never actually saw that TEMPLATE example — `maskHoursLabels` (run.ts) replaces every
  // hours-row/hours-label slot with a neutral placeholder before the prompt is built — so this
  // fixture rewrite fixes only the REFERENCE recipe's own text against the gate it will be held
  // to; it is content hygiene, not the cause of or the fix for the generation-side failure. The
  // actual generation-side fix (what stops the MODEL from writing a comma-drop reorder) is the
  // `HOURS_LABEL_RULE`/`hoursLabelRepairHint` wording plus the narrow post-merge
  // `normalizeHoursRowSeparator` normalizer. Fixed at the fixture: these are now the brief's own
  // verbatim rows and no longer residuals.
  'wrenfield:sections[9].content.hours1', 'wrenfield:sections[9].content.hours2', // "Mon–Fri, 7am–5pm", "Saturday, by appointment"
]);

const KNOWN_PROPER_NOUN_RESIDUAL_FLAGS: ReadonlySet<string> = new Set([
  // "Boxy cut, single chest pocket." — "boxy" is not in the size-50 SCOWL wordlist and is not a
  // brief word; the size-60 list this project briefly shipped covered it, but that was reverted
  // per the audit's B1 finding (a shared list may not grow to clear a fixture).
  'storefront:sections[3].items[1].blurb',

  // ---------------------------------------------------------------------
  // Round 10 (g6-r3b-opus55 audit, NOTE N-a — CALENDAR_WORDS removed from the proper-noun
  // brief set). These are all bare day-abbreviation hours-row fields with no other content —
  // "Wed to Fri", "Mon to Tue", "Tue-Thu", "Fri-Sat", "Sun-Mon", "Mon–Fri, 7am–5pm". A day
  // abbreviation is not in the size-50 SCOWL wordlist (excluded as a proper noun) and, with
  // `CALENDAR_WORDS`' unconditional pass removed, now needs its own brief support like any other
  // candidate — none of these families' schemas mark these specific fields `x-verify:
  // 'hours-label'` (the dedicated, narrower check that already exists for exactly this shape,
  // used elsewhere), and adding that marker to more fields is a NEW exemption this round's "only
  // ADD checks" rule does not permit. PARAPHRASE FP: every one of these day ranges is faithful,
  // ordinary hours-row content, not an invented day.
  // ---------------------------------------------------------------------
  // halcyon block1Key1/block1Key4 used to be here too ("Wed to Fri" / "Mon to Tue"); the G8 final
  // fix rewrote them to the brief's own "Wednesday-Friday" / "Monday and Tuesday" full day names,
  // which are brief words, not abbreviations, so they no longer flag as an invented proper noun.
  'restaurant:sections[3].items[0].label', // "Tue-Thu"
  'restaurant:sections[3].items[1].label', // "Fri-Sat"
  'restaurant:sections[3].items[2].label', // "Sun-Mon"
  'wrenfield:sections[9].content.hours1', // "Mon–Fri, 7am–5pm"
  // G8 final: practice's hours labels are no longer excluded from this gate (the hours-label
  // marker only ADDS the row check; see run.ts). The same day-abbreviation class as the rows
  // above: "Mon-Thu" and "Fri" name the brief's own Monday-Thursday and Friday rows (the row gate
  // passes them), but "Mon"/"Thu"/"Fri" are neither brief nor wordlist words. "Sat-Sun" passes
  // ("sat"/"sun" are wordlist words). PARAPHRASE FP. The fill prompt no longer shows these
  // reference labels to the model (prompt.ts HOURS_LABEL_PLACEHOLDER).
  'practice:sections[9].items[0].label', // "Mon-Thu"
  'practice:sections[9].items[1].label', // "Fri"

  // maben's mediaNote residual ("Authored QA image...") was retired on 2026-10-10 with the
  // redesigned fixture; its caption now traces to the brief's massing-study line.

  // Round 10: the SAME underlying finding `KNOWN_RESIDUAL_FLAGS` already tracks as
  // `maren:sections[2].content.lede` (FIXTURE-ONLY COPY — an invented January-to-end-of-summer
  // production window the brief does not state), now ALSO caught by the proper-noun check
  // specifically on "January" (no longer unconditionally known per N-a). Same category, same
  // underlying invented fact, a second check catching it.
  'maren:sections[2].content.lede',
]);

test('deterministicSentenceClaimFlags and deterministicProperNounFlags: every registered family\'s own reference fixture, against its own brief, flags exactly the known residual set (see ledger) and nothing new', async () => {
  const registry = await loadFamilyRegistry();
  const registryIds = new Set(registry.families.map((entry) => entry.family));
  assert.ok(registryIds.size > 0, 'the registry names at least one family');

  const tested = new Set<string>();
  const failures: string[] = [];
  // family -> { sentenceFlags, properNounFlags } — the FP table the goal's report requires.
  const table: Record<string, { sentence: number; properNoun: number }> = {};
  // Every `${family}:${path}` `deterministicSentenceClaimFlags` actually flags this run, compared
  // for EXACT equality against `KNOWN_RESIDUAL_FLAGS` below (both directions).
  const actualFlags = new Set<string>();
  // Every `${family}:${path}` `deterministicProperNounFlags` actually flags this run, compared
  // for exact equality against `KNOWN_PROPER_NOUN_RESIDUAL_FLAGS` the same way.
  const actualProperNounFlags = new Set<string>();
  const hoursValueFlags = new Set<string>();

  for (const family of registryIds) {
    const packageDir = defaultPackageDir(family);
    const pkg = await loadFamilyPackage(packageDir, family);
    tested.add(pkg.family);

    const brief = readFileSync(briefPathFor(family, packageDir), 'utf8');
    const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set());
    if (!template) { failures.push(`${family}: fixture has no editable text at all`); continue; }

    const labelPaths = labelPathsFor(pkg.schema, template);
    const personNamePaths = personNamePathsFor(pkg.schema, template);
    const quotePaths = quotePathsFor(pkg.schema, template);
    const traceablePaths = traceablePathsFor(pkg.schema, template);
    const destinationPaths = destinationPathsFor(pkg.schema, template);
    const hoursLabelPaths = hoursLabelPathsFor(pkg.schema, template);
    const contactPaths = contactPathsFor(pkg.schema, template);
    // Slots the family schema marks `x-mock`: illustrative sample data under a visible caption —
    // `run.ts`'s real `gateSlots` passes these to `collectFaithfulnessSlots` as `illustrativePaths`
    // and they never reach the faithfulness gate at all, same as a locked path.
    const illustrativePaths = mockPathsFor(pkg.schema, template);
    // Slots the family schema marks `x-alt-text`: image alt text and photo captions — exempt only
    // from the two checks below, never from Jev or `x-mock`'s stronger exclusion. See
    // `spine.ts`'s `altTextPathsFor` and `run.ts`'s matching call-site doc.
    const altTextPaths = altTextPathsFor(pkg.schema, template);
    // `x-verify: 'exact-date'` slots (halcyon's event dates): checked by whole-value equality to a
    // brief date instead of these two prose checks — mirrors `run.ts`'s `makeCheckOnce`. The
    // fixture's own dates must pass that stricter check.
    const exactDatePaths = exactDatePathsFor(pkg.schema, template);
    assert.deepEqual(deterministicExactDateFlags(brief, collectFaithfulnessSlots(pkg.fixture, new Set()), exactDatePaths), [], `${family}: exact-date slots`);

    const slots = collectFaithfulnessSlots(pkg.fixture, new Set(), illustrativePaths);
    // Audit finding B2 (g6-r1-gemini, BLOCK): a naive `!labelPaths.has(slotPath)` filter here
    // previously diverged from what a LIVE `runFastLane` build actually does — `run.ts`'s real
    // `gateSlots` excludes chrome via `templateChromePaths(recipe, base, labelPaths)`, which
    // additionally requires the slot's own text to still look like a label (`template-chrome.ts`'s
    // `isLabel`: no digit, at most three words, 24 characters) AND to be unchanged from the
    // reference. A slot merely DECLARED `x-label` in the schema is not exempt on that declaration
    // alone if its own text fails `isLabel` — exactly the gap that let maben's card titles pass
    // this sweep while failing a real build. Calling the actual `templateChromePaths` (with the
    // reference fixture as both the "filled" and "base" recipe, since this sweep checks the
    // fixture's own unmodified content) measures precisely what a live build would exempt.
    const chromePaths = templateChromePaths(pkg.fixture, pkg.fixture, labelPaths);
    const checkPaths = new Set(slots.map((slot) => slot.path).filter((slotPath) => !chromePaths.has(slotPath)));
    const properNounPaths = new Set([...checkPaths].filter((slotPath) => (
      !personNamePaths.has(slotPath) && !quotePaths.has(slotPath) && !traceablePaths.has(slotPath)
      && !destinationPaths.has(slotPath) && !contactPaths.has(slotPath)
      && !altTextPaths.has(slotPath) && !exactDatePaths.has(slotPath)
    )));
    const sentenceClaimPaths = new Set([...checkPaths].filter((slotPath) => !altTextPaths.has(slotPath) && !exactDatePaths.has(slotPath)));

    // PR #137 (verbatim ruling): the hours gate on the fixture's own hours rows, each read with its
    // row value from the fixture. The reference fixtures were written before the gate required a
    // verbatim copy of the brief's hours row, so most of their rows ("Tue-Thu", "Wed to Fri",
    // "Mon–Fri, 7am–5pm") are not one; they are listed exactly in KNOWN_HOURS_RESIDUAL_FLAGS and
    // never shown to the model (the fill prompt masks them).
    const rowValuePaths = hoursRowValuePathsFor(pkg.schema, template);
    const valueAt = (label: string) => {
      const segments = [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
      const value = getAtPath(pkg.fixture, segments);
      return typeof value === 'string' || value === null ? value : undefined;
    };
    for (const flag of deterministicHoursLabelFlags(brief, slots, hoursLabelPaths, rowValuePaths, valueAt, hoursGroupsFor(pkg.schema, template))) hoursValueFlags.add(`${family}:${flag.path}`);
    // PR #137 final ruling: halcyon's hero rail never shows hours (`x-verify: 'hours-null'`); the
    // reference fixture's own rail values (days, a time wrong for Saturday and Sunday, "Free after
    // 17:00") are tracked here, and the fill TEMPLATE shows null there instead.
    for (const flag of deterministicHoursNullFlags(slots, hoursNullPathsFor(pkg.schema, template))) hoursValueFlags.add(`${family}:${flag.path}`);

    const sentenceFlagged: FlaggedSlot[] = deterministicSentenceClaimFlags(brief, slots, sentenceClaimPaths);
    const properNounFlagged: FlaggedSlot[] = deterministicProperNounFlags(brief, slots, properNounPaths);
    table[family] = { sentence: sentenceFlagged.length, properNoun: properNounFlagged.length };

    for (const flag of sentenceFlagged) actualFlags.add(`${family}:${flag.path}`);
    for (const flag of properNounFlagged) actualProperNounFlags.add(`${family}:${flag.path}`);
  }

  assert.deepEqual([...tested].sort(), [...registryIds].sort(), 'every family in the registry was checked');
  assert.deepEqual([...hoursValueFlags].sort(), [...KNOWN_HOURS_RESIDUAL_FLAGS].sort(), 'hours gate fixture residuals');
  assert.deepEqual(failures, [], `unexpected failures (table: ${JSON.stringify(table)}):\n${failures.join('\n')}`);

  const newFlags = [...actualFlags].filter((key) => !KNOWN_RESIDUAL_FLAGS.has(key)).sort();
  const goneResiduals = [...KNOWN_RESIDUAL_FLAGS].filter((key) => !actualFlags.has(key)).sort();
  assert.deepEqual(newFlags, [], `NEW claim-bearing-sentence false positive(s) not in the known-residual ledger — investigate per the ledger's own process (never silently add to KNOWN_RESIDUAL_FLAGS without re-reading ~/.claude/goal-state/mishh-genui-finish/proof/G6-fixture-edits.md first):\n${newFlags.join('\n')}\n(table: ${JSON.stringify(table)})`);
  assert.deepEqual(goneResiduals, [], `a KNOWN_RESIDUAL_FLAGS entry no longer flags — remove it from the list and record the fix in the ledger:\n${goneResiduals.join('\n')}`);

  const newProperNounFlags = [...actualProperNounFlags].filter((key) => !KNOWN_PROPER_NOUN_RESIDUAL_FLAGS.has(key)).sort();
  const goneProperNounResiduals = [...KNOWN_PROPER_NOUN_RESIDUAL_FLAGS].filter((key) => !actualProperNounFlags.has(key)).sort();
  assert.deepEqual(newProperNounFlags, [], `NEW proper-noun false positive(s) not in the known-residual ledger:\n${newProperNounFlags.join('\n')}\n(table: ${JSON.stringify(table)})`);
  assert.deepEqual(goneProperNounResiduals, [], `a KNOWN_PROPER_NOUN_RESIDUAL_FLAGS entry no longer flags — remove it from the list and record the fix in the ledger:\n${goneProperNounResiduals.join('\n')}`);
});
