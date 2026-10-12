/**
 * End-to-end proof of the round-4 Grok audit's own failure walkthrough: an hours-row day label
 * ("Mon-Thu", "Fri", "Sat-Sun") left UNCHANGED from the reference recipe's own real schedule used
 * to skip the faithfulness gate entirely (it was `x-label` chrome), so a strict build could
 * publish the reference clinic's Monday-Thursday and Friday hours for a brief that only ever
 * states Saturday hours. `destinationPathsFor` + `deterministicDestinationFlags` and the other
 * deterministic gates never covered this at all; `hoursLabelPathsFor` +
 * `deterministicHoursLabelFlags` (both wired into `run.ts`'s `makeCheckOnce`) are what have to
 * catch it now. The fake Jev checker here is given no markers, so it flags nothing on its own.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { deterministicHoursLabelFlags } from '../src/jev.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, nullablePathsOf } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, type Filler } from './fixtures.ts';

const PRACTICE_DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-practice');
const ENTRY = 'practice-r1.html';
const REAL_NAME = 'Dr. Maria Chen';
const REAL_QUOTE = 'Dr. Maria Chen made my visit painless';
// States ONLY Saturday hours — no Monday, Tuesday, Wednesday, Thursday or Friday anywhere.
const BRIEF = `Riverbend Dental, a family dental practice in Boise run by Dr. Maria Chen. Same-day crowns, sedation options. Open Saturdays 9am to 1pm only. Patients quote "Dr. Maria Chen made my visit painless" as a review.`;

const pkg = await loadFamilyPackage(PRACTICE_DIR, 'practice');
const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
const nullableKeys = new Set([...nullablePathsOf(atomKindsFor(pkg.schema, template))].map((p) => p.split('.').pop()!));
const FORMATTED_KEYS = new Set(['price', 'email', 'phone', 'destination']);

/** `label` fields copy the reference recipe's original day labels, including when the prompt
 * substitutes Monday placeholders — simulating the round-4 audit's stale-chrome failure — while
 * `value` fields get a Saturday-shaped time, so the hours section otherwise reads as plausible. */
const fill: Filler = (key, value, _at, limit) => {
  const itemIndex = Number(/items\[(\d+)\]/.exec(_at ?? '')?.[1] ?? 0);
  // The prompt uses Monday placeholders; restore the reference labels this test isolates.
  if (key === 'label' && typeof value === 'string') return ['Mon-Thu', 'Fri', 'Sat-Sun'][itemIndex]!;
  if (key === 'value' && typeof value === 'string') return '9:00am - 1:00pm';
  if (key === 'name' && typeof value === 'string') return REAL_NAME;
  if (key === 'quote' && typeof value === 'string') return [REAL_QUOTE, 'Dr. Maria Chen made my visit', 'Maria Chen made my visit painless'][itemIndex]!;
  if ((key === 'destination' || key === 'phone' || key === 'email') && typeof value === 'string') return null;
  if (nullableKeys.has(key) || FORMATTED_KEYS.has(key)) return typeof value === 'string' ? value : null;
  const base = `${['Family', 'Dental', 'Boise'][itemIndex]} New ${key} for Riverbend Dental`;
  return typeof limit === 'number' ? base.slice(0, limit) : base;
};

test('strict verify keeps the reference recipe\'s own Mon-Thu/Fri/Sat-Sun hours labels off the page for a brief that states only Saturday hours', async () => {
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(); // no markers: flags nothing on its own
  let writes = 0;
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { writes += 1; throw new Error('this fixture leaves other slots unsupported; nothing may publish'); } });
  // This fixture's other slots stay unsupported, so the build as a whole is refused and nothing is written.
  assert.equal(report.strict?.passed, false);
  assert.equal(writes, 0);
  // Every unsupported day label is flagged, then the hours rows are dropped all together (an hours
  // list is all or none, R1 2026-10-10): the page never shows the reference schedule.
  assert.deepEqual(
    report.verify!.flagged.filter((flagPath) => /^sections\[9\]\.items\[\d\]\.label$/.test(flagPath)).sort(),
    ['sections[9].items[0].label', 'sections[9].items[1].label', 'sections[9].items[2].label'],
  );
  assert.deepEqual(report.verify!.remaining.filter((flagPath) => flagPath.startsWith('sections[9].items')), []);
  const hours = (((report.recipe as Record<string, unknown>).sections as Array<Record<string, unknown> | null>)[9]?.items ?? []) as unknown[];
  assert.equal(hours.length, 0);
  for (const label of ['Mon-Thu', 'Sat-Sun']) assert.ok(!report.html.includes(`>${label}<`), `${label} is not on the page`);
});

/**
 * `deterministicHoursLabelFlags`'s group-word grounding (round-5 Grok audit): a label group word
 * render.ts's own `HOURS_ROW_LABEL` prints as a real schedule row — "Weekend", "Weekday", "Daily",
 * "Holiday" — must not be silently skipped just because it carries no single Mon-Sun day token.
 * One focused unit test per label, straight against `deterministicHoursLabelFlags` rather than a
 * full `runFastLane` round trip, since the fact being proven is entirely inside that function's
 * own grounding rule.
 */
const PATH = 'sections[9].items[0].label';
const PATHS = new Set([PATH]);
// PR #137: practice labels have a row value (`x-hours-value`); a label with no value at all is read
// as a combined slot, which flags when the brief row states a time or "closed" it does not repeat.
const flagged = (brief: string, label: string, value?: string) => (value === undefined
  ? deterministicHoursLabelFlags(brief, [{ path: PATH, text: label }], PATHS)
  : deterministicHoursLabelFlags(brief, [{ path: PATH, text: label }], PATHS, new Map([[PATH, 'v']]), () => value)).map((flag) => flag.path);

// PR #137 verbatim ruling: a group word is never "grounded" by reading the brief any more. It
// passes only as a verbatim copy of a row of an explicit "Hours:" clause; every case main used to
// ground by interpretation now flags (a refusal, never a published guess).
test('hours-label gate: group words pass only as a verbatim row of an explicit hours clause', () => {
  assert.deepEqual(flagged('Hours: Weekends 9am-1pm.', 'Weekends', '9am-1pm'), []);
  assert.deepEqual(flagged('Hours: daily 9am-5pm.', 'daily', '9am-5pm'), []);
  assert.deepEqual(flagged('Hours: weekdays 9am-5pm, closed weekends.', 'weekends', 'closed'), []);
});
for (const [brief, label, value] of [
  ['Open weekends by appointment.', 'Weekend', 'by appointment'],
  ['Open Saturday and Sunday, 9am to 1pm.', 'Weekend', '9am to 1pm'],
  ['Open Saturdays 9am to 1pm only.', 'Weekend', '9am to 1pm'],
  ['Open weekdays, closed weekends.', 'Weekday', 'Open'],
  ['Open Monday, Tuesday, Wednesday, Thursday and Friday, 9am to 5pm.', 'Weekday', '9am to 5pm'],
  ['Open Monday, Tuesday, Wednesday and Thursday, 9am to 5pm.', 'Weekday', '9am to 5pm'],
  ['Open daily, 9am to 5pm.', 'Daily', '9am to 5pm'],
  ['Open Monday, Tuesday, Wednesday, Thursday, Friday, Saturday and Sunday, 9am to 5pm.', 'Daily', '9am to 5pm'],
  ['Closed on holidays.', 'Holiday', 'Closed'],
  ['Hours: Monday-Friday 9am-5pm.', 'Weekdays', '9am-5pm'],
  ['Hours: Saturday and Sunday 9am-1pm.', 'Weekend', '9am-1pm'],
] as const) {
  test(`hours-label gate: "${label}" | "${value}" flags against "${brief}" (not a verbatim hours row)`, () => {
    assert.deepEqual(flagged(brief, label, value), [PATH]);
  });
}
