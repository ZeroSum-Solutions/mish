/**
 * End-to-end proof that the deterministic attribution/quote/destination gates (`personNamePathsFor`
 * + `deterministicAttributionFlags`, `quotePathsFor` + `deterministicQuoteFlags`, and
 * `destinationPathsFor` + `deterministicDestinationFlags`, all wired into `run.ts`'s
 * `makeCheckOnce`) actually block a strict-verify build whose reviewer name, quote, or book
 * destination Jev's own check misses — the exact class of bug a live storefront build exposed
 * (strict verify passed a page with invented reviewer names and quotes, 0 flagged). Here the fake
 * Jev checker is given no markers at all, so it flags nothing on its own; these gates are what
 * have to catch the fabrication.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, nullablePathsOf } from '../src/spine.ts';
import { HOURS_LABEL_PLACEHOLDER } from '../src/prompt.ts';
import { fakeJevChecker, fakeModel, type Filler } from './fixtures.ts';
import { clipWholeWords } from '../src/text-clip.ts';

const PRACTICE_DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-practice');
const ENTRY = 'practice-r1.html';
// Names a real, brief-supplied provider and reviewer word for word, so a filler that copies them
// verbatim produces person-name slots the attribution gate can verify cleanly.
const REAL_NAME = 'Dr. Maria Chen';
// Traces back to the brief's own words (well past the 6-consecutive-word threshold), so a filler
// that copies it verbatim produces a quote slot the quote gate can verify cleanly.
const REAL_QUOTE = 'Dr. Maria Chen made my visit painless';
/** BRIEF's hours rows, verbatim, in order. */
const HOURS_ROWS: ReadonlyArray<readonly [string, string]> = [['Monday-Thursday', '8am-5pm'], ['Friday', '8am-2pm'], ['Saturday and Sunday', 'closed']];
const BRIEF = `Riverbend Dental, a family dental practice in Boise run by Dr. Maria Chen. Same-day crowns, sedation options. Hours: Monday-Thursday 8am-5pm, Friday 8am-2pm, closed Saturday and Sunday. Patients quote "Dr. Maria Chen made my visit painless" as a review.`;

const pkg = await loadFamilyPackage(PRACTICE_DIR, 'practice');
const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
const nullableKeys = new Set([...nullablePathsOf(atomKindsFor(pkg.schema, template))].map((p) => p.split('.').pop()!));
const FORMATTED_KEYS = new Set(['price', 'email', 'phone', 'destination']);

/**
 * Fills every slot generically ("New <key> for Riverbend Dental"), except: every `name` field (a
 * provider or reviewer attribution) gets the one real, brief-supplied name, and `quote`
 * fields get that real quote or distinct six-word excerpts — so the attribution/quote gates have
 * something truthful to verify by default — unless its TEMPLATE default value (the reference
 * fixture's own text, e.g. "Katie R." or the reviews[0] quote) matches a key in `overrides`, in
 * which case the fabricated replacement is used instead. Matched by the template's own default
 * value rather than by path: `mode: 'sections'` fills one section at a time, so the fill-time
 * path is unit-relative (`items[0].name` for both a provider and a reviewer) and cannot tell the
 * two apart on its own; the reference fixture's distinct default text can. Every nullable/
 * formatted atom keeps the reference fixture's own valid value (a generic filler cannot invent a
 * format-valid phone/email either).
 */
function fillWith(overrides: Record<string, string>): Filler {
  return (key, value, _at, limit) => {
    const itemIndex = Number(/items\[(\d+)\]/.exec(_at ?? '')?.[1] ?? 0);
    if ((key === 'name' || key === 'quote' || key === 'destination' || key === 'phone' || key === 'email') && typeof value === 'string' && overrides[value] !== undefined) return overrides[value];
    if (key === 'name' && typeof value === 'string') return REAL_NAME;
    if (key === 'quote' && typeof value === 'string') return [REAL_QUOTE, 'Dr. Maria Chen made my visit', 'Maria Chen made my visit painless'][itemIndex]!;
    // BRIEF gives no phone, email, booking URL, address or price at all (round-2 Grok audit: an
    // earlier version of this comment wrongly claimed it gave a phone — it does not; a later pass
    // found `price`/`address` were still being kept at the reference fixture's own brief-absent
    // value, which `deterministicClaimFlags` — wired unconditionally across every slot — now
    // correctly flags as a fabricated number no brief supports). Every unoverridden nullable atom
    // this brief does not support drops to `null` rather than keeping the reference fixture's own
    // brief-absent value, so nothing on the page states a fact the destination/claim gates would
    // correctly flag as fabricated — the honest path, and the one these gates must let pass
    // cleanly.
    if ((key === 'destination' || key === 'phone' || key === 'email' || key === 'price' || key === 'address') && typeof value === 'string') return null;
    if (nullableKeys.has(key) || FORMATTED_KEYS.has(key)) return typeof value === 'string' ? value : null;
    // `services.title`/`.body`, `providers.credential`, `insurance.detail` and
    // `hours-location.value` are `x-verify: 'traceable'` (`slots.ts`'s own `FieldSpec` doc): a
    // fabricated `New ${key} for Riverbend Dental` would itself now be flagged as untraceable, on
    // top of the deliberately fabricated name this test exists to isolate — so these get neutral
    // text built only from BRIEF's own words instead (see the identical fix in
    // `unsupported-facts.test.ts`'s `TRACEABLE_NEUTRAL_TEXT`).
    // PR #137: the hours table copies every row of BRIEF's "Hours:" clause, verbatim and in order
    // (`hours-label.ts`); the fake model sees "Monday" where TEMPLATE shows the placeholder.
    if (key === 'label' && (value === 'Monday' || value === HOURS_LABEL_PLACEHOLDER)) return HOURS_ROWS[Number(/items\[(\d)\]/.exec(_at ?? '')?.[1] ?? 0)]![0];
    if (key === 'value' && ['8:00am - 5:00pm', '8:00am - 2:00pm', 'Closed'].includes(value)) return HOURS_ROWS[['8:00am - 5:00pm', '8:00am - 2:00pm', 'Closed'].indexOf(value)]![1];
    if (key === 'title' || key === 'body' || key === 'credential' || key === 'detail' || key === 'value') {
      // Distinct records trace to the brief instead of repeating identical filler.
      const text = ['Family dental practice in Boise', 'Same-day crowns', 'Sedation options'][itemIndex]!;
      return typeof limit === 'number' ? text.slice(0, limit) : text;
    }
    // g6-r3b-opus55 audit (NOTE N-b): a raw `.slice()` here can cut mid-word through "Riverbend",
    // a genuine byte-budget clip that now fails `deterministicProperNounFlags` (the brief-word-
    // prefix exemption is removed). No real model fill goes through a raw slice in production
    // either — `clipWholeWords` (`text-clip.ts`) is the real pipeline's own whole-word-safe cut.
    const base = `${['Family', 'Dental', 'Boise'][itemIndex]} New ${key} for Riverbend Dental`;
    return typeof limit === 'number' ? (clipWholeWords(base, limit) ?? 'New') : base;
  };
}

test('strict verify rejects a fabricated reviewer name even when the (fake) Jev checker flags nothing at all', async () => {
  const invented = 'R. Achebe';
  // "Katie R." is the reference fixture's own reviews[0].name default.
  const model = fakeModel({ fill: fillWith({ 'Katie R.': invented }) });
  // No markers: this fake Jev checker never flags anything on its own — it stands in for the
  // real bug (Jev's LLM judgment missing a plausible invented name).
  const verify = fakeJevChecker([]);
  let created = false;
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'sections',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
    ensurePublisher: async () => {
      created = true;
      throw new Error('must never be called once the attribution gate has failed the build');
    },
  });

  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.projectId, undefined, 'no project id on the report');
  assert.ok(report.strict, 'a strict verdict is reported');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.remaining.includes('sections[6].items[0].name'),
    `the invented reviewer name's own path is reported as a remaining flag; got: ${JSON.stringify(report.verify!.remaining)}`,
  );
});

test('strict verify rejects a fabricated review quote that shares no real run of words with the brief, even when the (fake) Jev checker flags nothing at all', async () => {
  const invented = 'Absolutely the best dental visit of my entire life, hands down, ten out of ten.';
  // The reference fixture's own reviews[0].quote default is overridden with the fabrication;
  // reviews[0].name ("Katie R.") is left real via fillWith's own default.
  const REFERENCE_QUOTE = "Dr. Marsh explained every step before she started. First dentist visit in years that didn't feel rushed.";
  const model = fakeModel({ fill: fillWith({ [REFERENCE_QUOTE]: invented }) });
  const verify = fakeJevChecker([]);
  let created = false;
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'sections',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
    ensurePublisher: async () => {
      created = true;
      throw new Error('must never be called once the quote gate has failed the build');
    },
  });

  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.projectId, undefined, 'no project id on the report');
  assert.ok(report.strict, 'a strict verdict is reported');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.remaining.includes('sections[6].items[0].quote'),
    `the invented quote's own path is reported as a remaining flag; got: ${JSON.stringify(report.verify!.remaining)}`,
  );
});

test('strict verify rejects an invented but well-formed https booking URL the brief never gave, even when the (fake) Jev checker flags nothing at all', async () => {
  const invented = 'https://booknow.invented-clinic-domain.example/appointment';
  // The reference fixture's own book.destination default (a different, brief-absent booking URL)
  // is overridden with the fabrication, so this exercises a destination that is well-formed
  // (contract.ts's format check would accept it) but absent from BRIEF, which gives no phone,
  // email or URL at all.
  const REFERENCE_DESTINATION = 'https://booking.willowcreekdental.example/appointments';
  const model = fakeModel({ fill: fillWith({ [REFERENCE_DESTINATION]: invented }) });
  const verify = fakeJevChecker([]);
  let created = false;
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'sections',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
    ensurePublisher: async () => {
      created = true;
      throw new Error('must never be called once the destination gate has failed the build');
    },
  });

  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.projectId, undefined, 'no project id on the report');
  assert.ok(report.strict, 'a strict verdict is reported');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.remaining.includes('sections[5].text.destination'),
    `the invented destination's own path is reported as a remaining flag; got: ${JSON.stringify(report.verify!.remaining)}`,
  );
});

test('strict verify rejects a fabricated fallback phone — hours-location\'s own phone, which book.destination silently falls back to — that the brief never gave', async () => {
  // book.destination is left null (fillWith's default), so `effectiveBookDestination` falls back
  // to hours-location's phone. That phone is overridden away from the reference fixture's own
  // brief-absent "(503) 555-0142" to a DIFFERENT invented number — round-2 Grok audit's finding:
  // only book.destination carried `x-verify: 'destination'`, so this fallback atom went straight
  // to a live `tel:` link unchecked.
  const REFERENCE_HOURS_PHONE = '(503) 555-0142';
  const invented = '(212) 555-9876';
  const model = fakeModel({ fill: fillWith({ [REFERENCE_HOURS_PHONE]: invented }) });
  const verify = fakeJevChecker([]);
  let created = false;
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'sections',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
    ensurePublisher: async () => {
      created = true;
      throw new Error('must never be called once the destination gate has failed the build');
    },
  });

  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.projectId, undefined, 'no project id on the report');
  assert.ok(report.strict, 'a strict verdict is reported');
  assert.equal(report.strict!.passed, false, 'the gate failed on the fallback phone, not just the book section\'s own field');
  assert.ok(
    report.verify!.remaining.some((path) => path.endsWith('.text.phone')),
    `an invented phone's own path is reported as a remaining flag; got: ${JSON.stringify(report.verify!.remaining)}`,
  );
});

test('the same build with a real, brief-supplied reviewer name passes the attribution gate cleanly, and no phone or URL renders as a live link since the brief gives none', async () => {
  // "Katie R." is one of the reference fixture's own review names — already in the reviews
  // section's own quote/name pair, so leaving it unoverridden exercises the real path. BRIEF
  // gives no phone, email or booking URL at all, so `fillWith` nulls every one of those atoms
  // (destination, hours-location's phone, footer's phone/email) rather than keeping the
  // reference fixture's own brief-absent contact info.
  const model = fakeModel({ fill: fillWith({}) });
  const verify = fakeJevChecker([]);
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'sections',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
  });
  assert.ok(report.strict, 'a strict verdict is reported');
  assert.equal(report.strict!.passed, true, 'a generically-filled build with no person-name slot renders nothing that fails the attribution check');
  // round-2 Grok audit: the earlier version of this test asserted only `strict.passed`, and
  // missed that the page still rendered a live `tel:` link to the reference fixture's own
  // brief-absent phone number. Assert directly against the rendered page.
  assert.ok(!/href="tel:/i.test(report.html), 'no tel: link renders anywhere on the page when the brief gives no phone');
  assert.ok(!/href="mailto:/i.test(report.html), 'no mailto: link renders anywhere on the page when the brief gives no email');
});
