/**
 * Proof that a faithfulness repair unlocks a flagged array item's WHOLE set of sibling fields,
 * not just the one flagged leaf (round-3 Grok audit, `run.ts`'s repair-lock construction and
 * `itemContainerPrefix`). Before the fix, a provider whose `name` alone was flagged still had its
 * `credential` LOCKED at MERGE time during the repair round (`mergeIntoSpine`'s
 * `report.lockedPaths`) — so a repair that regenerated the item as a whole (a fresh name paired
 * with a fresh credential) had its credential silently discarded back to whatever the spine
 * already held, which can belong to a different identity than the repaired name. The repair
 * PROMPT's TEMPLATE always shows every field of the unit regardless (a repair answers the whole
 * unit's shape again, not a diff), so this checks the ACCEPTED result in `report.recipe`, not the
 * prompt: a stateful filler answers `credential` differently on the repair round than the first
 * round, and only the fix lets that second answer actually land.
 *
 * The fill strategy mirrors `practice-attribution-gate.test.ts`'s own `fillWith`: a real,
 * brief-supplied name/quote everywhere else, and every nullable atom this brief does not support
 * (contact, address, price) nulled — so the ONLY thing the deterministic gates or the fake Jev
 * checker ever flag is the one deliberately fabricated provider name.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, nullablePathsOf, type JsonObject } from '../src/spine.ts';
import { HOURS_LABEL_PLACEHOLDER } from '../src/prompt.ts';
import { fakeJevChecker, fakeModel, fillTemplate, type Filler } from './fixtures.ts';
import { clipWholeWords } from '../src/text-clip.ts';

const PRACTICE_DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-practice');
const ENTRY = 'practice-r1.html';
const REAL_NAME = 'Dr. Maria Chen';
const REAL_QUOTE = 'Dr. Maria Chen made my visit painless';
/** BRIEF's hours rows, verbatim, in order. */
const HOURS_ROWS: ReadonlyArray<readonly [string, string]> = [['Monday-Thursday', '8am-5pm'], ['Friday', '8am-2pm'], ['Saturday and Sunday', 'closed']];
const BRIEF = `Riverbend Dental, a family dental practice in Boise run by Dr. Maria Chen. Same-day crowns, sedation options. Hours: Monday-Thursday 8am-5pm, Friday 8am-2pm, closed Saturday and Sunday. Patients quote "Dr. Maria Chen made my visit painless" as a review.`;

const pkg = await loadFamilyPackage(PRACTICE_DIR, 'practice');
const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
const nullableKeys = new Set([...nullablePathsOf(atomKindsFor(pkg.schema, template))].map((p) => p.split('.').pop()!));
const FORMATTED_KEYS = new Set(['price', 'email', 'phone', 'destination']);

// The reference fixture's own providers[0].name default — matched by VALUE, not path: `mode:
// 'sections'` fills one section at a time, so the fill-time path is unit-relative (`items[0].name`
// for both a provider and a reviewer) and cannot tell them apart on its own (see
// `practice-attribution-gate.test.ts`'s own `fillWith` doc for the same reasoning).
const PROVIDER_0_DEFAULT_NAME = 'Dr. Elena Marsh, DDS';
const PROVIDER_0_DEFAULT_CREDENTIAL = 'General and cosmetic dentistry, University of Washington School of Dentistry, practicing since 2008';
// `unit.template` is built once, before any fill, and stays the pristine reference default for
// every repair round (a repair round is asked to answer the WHOLE unit's shape again, not a diff
// of what changed) — so `fill` sees the SAME `(key, value)` pair on the first fill and on the
// repair round. A counter is the only way to tell them apart and prove the repair round's OWN
// answer is what lands, not the first round's identical-looking text landing twice.
let credentialCalls = 0;
let provider0NameCalls = 0;
const fill: Filler = (key, value, _at, limit) => {
  const itemIndex = Number(/items\[(\d+)\]/.exec(_at ?? '')?.[1] ?? 0);
  // The FIRST provider's name (index 0 only) is fabricated on the FIRST fill; the repair round
  // (any later call) answers with the real name instead, so the repair genuinely fixes it rather
  // than repeating the same fabrication forever.
  if (key === 'name' && value === PROVIDER_0_DEFAULT_NAME) {
    provider0NameCalls += 1;
    return provider0NameCalls === 1 ? 'FABRICATED Dr. Nobody' : REAL_NAME;
  }
  if (key === 'name' && typeof value === 'string') return REAL_NAME;
  if (key === 'quote' && typeof value === 'string') return [REAL_QUOTE, 'Dr. Maria Chen made my visit', 'Maria Chen made my visit painless'][itemIndex]!;
  // `credential` is `x-verify: 'traceable'` (`slots.ts`'s own `FieldSpec` doc): every stemmed
  // content word of the two round-distinguishing phrases below must itself trace to BRIEF, so
  // both are built only from BRIEF's own words ("sedation", "options", "same-day", "crowns",
  // "Saturday") rather than invented filler ("first fill"/"REPAIRED" would themselves
  // now be flagged as untraceable, on top of the deliberately fabricated name this test exists
  // to isolate).
  if (key === 'credential' && value === PROVIDER_0_DEFAULT_CREDENTIAL) {
    credentialCalls += 1;
    return credentialCalls === 1 ? 'Sedation options for same-day crowns' : 'Same-day crowns on Saturday';
  }
  // Every other traceable slot (`services.title`/`.body`, another provider's `credential`,
  // `insurance.detail`, `hours-location.value`) gets neutral text built only from BRIEF's own
  // words — see the identical fix in `unsupported-facts.test.ts`'s `TRACEABLE_NEUTRAL_TEXT`.
  // PR #137: the hours table copies every row of BRIEF's "Hours:" clause, verbatim and in order
  // (`hours-label.ts`); the fake model sees "Monday" where TEMPLATE shows the placeholder.
  if (key === 'label' && (value === 'Monday' || value === HOURS_LABEL_PLACEHOLDER)) return HOURS_ROWS[Number(/items\[(\d)\]/.exec(_at ?? '')?.[1] ?? 0)]![0];
  if (key === 'value' && ['8:00am - 5:00pm', '8:00am - 2:00pm', 'Closed'].includes(value)) return HOURS_ROWS[['8:00am - 5:00pm', '8:00am - 2:00pm', 'Closed'].indexOf(value)]![1];
  if (key === 'title' || key === 'body' || key === 'credential' || key === 'detail' || key === 'value') {
    // Distinct records trace to the brief instead of repeating identical filler.
    const text = ['Family dental practice in Boise', 'Same-day crowns', 'Sedation options'][itemIndex]!;
    return typeof limit === 'number' ? text.slice(0, limit) : text;
  }
  // BRIEF gives no phone, email, URL, address or price at all: every unoverridden nullable atom
  // this brief does not support drops to `null` rather than keeping the reference fixture's own
  // brief-absent value, so `deterministicClaimFlags` (wired unconditionally across every slot)
  // has no fabricated number or address to correctly flag besides the one deliberate name — see
  // `practice-attribution-gate.test.ts`'s own `fillWith` doc for the identical reasoning.
  if ((key === 'destination' || key === 'phone' || key === 'email' || key === 'price' || key === 'address') && typeof value === 'string') return null;
  if (nullableKeys.has(key) || FORMATTED_KEYS.has(key)) return typeof value === 'string' ? value : null;
  // g6-r3b-opus55 audit (NOTE N-b): whole-word-safe clip — see `practice-attribution-gate.test.ts`'s
  // own `fillWith` doc for why a raw `.slice()` here can produce a byte-budget clip through
  // "Riverbend" that no real model fill (`clipWholeWords`-based) would ever actually produce.
  const base = `${['Family', 'Dental', 'Boise'][itemIndex]} New ${key} for Riverbend Dental`;
  return typeof limit === 'number' ? (clipWholeWords(base, limit) ?? 'New') : base;
};

test("a faithfulness repair unlocks a flagged provider's WHOLE item — the sibling `credential` field, not just the flagged `name` — so a repair cannot glue a fresh name onto a stale, possibly mismatched credential", async () => {
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(); // default marker: 'FABRICATED'
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.ok(report.verify, 'a verify verdict is reported');
  assert.deepEqual(report.verify!.flagged, ['sections[3].items[0].name'], `only the one deliberately fabricated name was ever flagged; got: ${JSON.stringify(report.verify!.flagged)}`);
  assert.ok(model.prompts.some((prompt) => prompt.includes('YOUR PREVIOUS ANSWER WAS REJECTED') && prompt.includes('sections[3].items[0].name')), 'a repair prompt naming the flagged path was sent');
  assert.ok(credentialCalls >= 2, 'the filler answered `credential` again on at least one repair round, not just the first fill');

  assert.equal(getAtPath(report.recipe, ['sections', 3, 'items', 0, 'name']), REAL_NAME, 'the repaired name lands');
  // The final page never mixes the repaired name with an untouched original credential: the
  // repair round's OWN answer ("...REPAIRED") is what lands, not the first round's answer held
  // over by a stale lock.
  assert.equal(getAtPath(report.recipe, ['sections', 3, 'items', 0, 'credential']), 'Same-day crowns on Saturday', "the credential the REPAIR round answered lands — it is not held locked to the first round's text");
});

test('docs quickstart repair permits a coherent title and description pair while keeping the other steps fixed', async () => {
  const docsDir = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-docs-hub');
  const docs = await loadFamilyPackage(docsDir, 'docs-hub');
  const brief = readFileSync(path.join(docsDir, 'compiler/scripts/families/docs-hub/reference.fixture.brief.txt'), 'utf8');
  const referenceItems = getAtPath(docs.fixture, ['sections', 2, 'items']);
  assert.ok(Array.isArray(referenceItems));
  const calls: Array<{ label: string; attempt: number; prompt: string }> = [];
  const model = fakeModel({
    firstAnswer: (value, limits) => {
      if (!isObject(value) || value.id !== 'docs-hub-quickstart') return undefined;
      const answer = fillTemplate(value, limits, (_key, text) => text) as JsonObject;
      const items = answer.items as JsonObject[];
      items[0]!.title = 'FABRICATED quickstart';
      // This brief-supported description belongs to a different step. Repairing the title
      // must be allowed to replace its paired description, even though only the title flags.
      items[0]!.description = 'Authenticate the CLI against your Loomwork workspace.';
      return answer;
    },
    fill: (_key, value, at) => at === 'items[1].description' && value === 'Authenticate the CLI against your Loomwork workspace.'
      ? 'Push the workflow to your Loomwork environment.' // A repair must not change another step.
      : value,
  });
  const report = await runFastLane({
    pkg: docs, brief, mode: 'sections', entry: 'docs-hub-r1.html', revision: 1,
    model, modelName: 'fake', verify: fakeJevChecker(), strict: true,
    onCall: (call) => { calls.push(call); },
  });

  assert.deepEqual(report.verify?.flagged, ['sections[2].items[0].title']);
  assert.deepEqual(report.verify?.remaining, []);
  assert.equal(report.strict?.passed, true);
  const repairedItems = getAtPath(report.recipe, ['sections', 2, 'items']);
  assert.ok(Array.isArray(repairedItems));
  assert.deepEqual(repairedItems[0], {
    title: '1. Install the CLI',
    description: 'Install the Loomwork command-line tool for your platform.',
  }, 'both fields of the flagged step are repaired together');
  assert.deepEqual(repairedItems.slice(1), referenceItems.slice(1), 'every other step stays fixed despite the model trying to rewrite one');

  const repair = calls.find((call) => call.label === 'docs-hub-quickstart' && call.attempt > 0);
  assert.ok(repair, 'the actual model call includes a faithfulness repair prompt');
  const scope = repair.prompt.match(/REPAIR SCOPE[^\n]*/)?.[0];
  assert.ok(scope, 'the model must be told the whole-item repair permission, not just the merge layer');
  assert.match(scope, /editable fields.*together.*sections\[2\]\.items\[0\]/);
  assert.match(scope, /[Kk]eep every other item.*unchanged/);
  assert.match(scope, /every unflagged value outside these items unchanged/, 'the scope must not forbid repairing separately flagged section fields');
  assert.doesNotMatch(scope, /sections\[2\]\.items\[[1-4]\]/, 'only the flagged item is granted repair permission');
});
