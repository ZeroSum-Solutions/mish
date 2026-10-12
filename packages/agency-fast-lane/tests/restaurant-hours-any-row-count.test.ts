/**
 * A restaurant brief whose hours are not exactly three clean rows must still publish (Devin,
 * 2026-10-10: Home "Build with Jev" published nothing for every bakery brief).
 *
 * The hours gate (`hours-label.ts`) shows the brief's rows verbatim, every row in order, or none.
 * The restaurant table used to require three non-null rows, so a brief with no hours clause, or a
 * clause with one or two rows, could never pass: strict verify left the three labels flagged and
 * the daemon refused the build (VERIFY_FAILED, `sections[3].items[0..2].label`). The fix lets an
 * hours row be dropped: its value is a nullable atom, and a row whose label is still flagged after
 * the faithfulness repairs has its value nulled, so the page shows no hours rather than wrong ones.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { runFastLane } from '../src/run.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, fillTemplate, type Filler } from './fixtures.ts';

const DIR = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-restaurant');
const REFERENCE = readFileSync(path.join(DIR, 'compiler/scripts/families/restaurant/reference.fixture.brief.txt'), 'utf8');
const HOURS_CLAUSE = /Hours: Tuesday-Thursday 5-9:30pm, Friday-Saturday 5-10pm, closed Sunday and Monday\. /;
const HOURS_LABELS = ['sections[3].items[0].label', 'sections[3].items[1].label', 'sections[3].items[2].label'];

/** A model that never stops inventing a three-row table, whatever the brief or the repair says. */
const stubborn: Filler = (key, value, at) => {
  if (key === 'label' && value === 'Monday') return ['Weekdays', 'Weekend', 'Closed'][Number(/items\[(\d)\]/.exec(at)![1])]!;
  return value;
};

/** Its first answer also writes invented hours into the (nullable) values TEMPLATE shows as null. */
const inventedValues = (template: Json, limits: Json | undefined): Json | undefined => {
  if (!isObject(template) || !Array.isArray(template.items) || template.items.length !== 3 || !template.items.every((item) => isObject(item) && 'label' in item && 'value' in item)) return undefined;
  const filled = fillTemplate(template, limits, stubborn) as JsonObject;
  (filled.items as JsonObject[]).forEach((item, index) => { item.value = ['8am-6pm', '9am-4pm', 'All day'][index]!; });
  return filled;
};

async function remainingHoursFlags(brief: string, maxFaithfulnessRounds?: number): Promise<string[]> {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const report = await runFastLane({ pkg, brief, mode: 'sections', entry: 'r.html', revision: 1, model: fakeModel({ fill: stubborn, firstAnswer: inventedValues }), modelName: 'fake', verify: fakeJevChecker(), strict: true, ...(maxFaithfulnessRounds === undefined ? {} : { maxFaithfulnessRounds }) });
  // The invented rows never reach the page: dropped, not published under a passing check.
  for (const text of ['Weekdays', 'Weekend', '8am-6pm', '9am-4pm', 'All day']) assert.ok(!report.html.includes(`>${text}<`), `${text} is not on the page`);
  assert.ok(report.verify!.flagged.some((flagPath) => HOURS_LABELS.includes(flagPath)), 'the invented rows were flagged first');
  return report.verify!.remaining.filter((flagPath) => HOURS_LABELS.includes(flagPath)).sort();
}

test('the reference brief still states its hours clause (the replacements below edit it)', () => {
  assert.match(REFERENCE, HOURS_CLAUSE);
});

test('a restaurant brief with no hours clause leaves no hours flag standing', async () => {
  assert.deepEqual(await remainingHoursFlags(REFERENCE.replace(HOURS_CLAUSE, '')), []);
});

test('a restaurant brief with a one-row hours clause leaves no hours flag standing', async () => {
  assert.deepEqual(await remainingHoursFlags(REFERENCE.replace(HOURS_CLAUSE, 'Hours: Tuesday-Sunday 5-10pm. ')), []);
});

test('with the repairs spent, a still-flagged hours row is dropped, not left to refuse the build', async () => {
  // No repair round: only the post-repair drop can clear the invented rows.
  assert.deepEqual(await remainingHoursFlags(REFERENCE.replace(HOURS_CLAUSE, ''), 0), []);
});

/** Keeps the reference text everywhere a test does not set it. */
const keep: Filler = (_key, value) => value;
/** A first answer that writes these exact rows into the hours table. */
const rowsAnswer = (rows: Array<[string, string]>) => (template: Json, limits: Json | undefined): Json | undefined => {
  if (!isObject(template) || !Array.isArray(template.items) || template.items.length !== 3 || !template.items.every((item) => isObject(item) && 'label' in item && 'value' in item)) return undefined;
  const filled = fillTemplate(template, limits, keep) as JsonObject;
  (filled.items as JsonObject[]).forEach((item, index) => { item.label = rows[index]![0]; item.value = rows[index]![1]; });
  return filled;
};
const HOURS_VALUES = ['sections[3].items[0].value', 'sections[3].items[1].value', 'sections[3].items[2].value'];
const valueAt = (recipe: Json, index: number) => (((recipe as JsonObject).sections as JsonObject[])[3]!.items as JsonObject[])[index]!.value ?? null;

test('a table with two of the brief\'s rows and one invented row is dropped whole, never published as a subset', async () => {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const model = fakeModel({ fill: keep, firstAnswer: rowsAnswer([['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'Open late']]) });
  const report = await runFastLane({ pkg, brief: REFERENCE, mode: 'sections', entry: 'r.html', revision: 1, model, modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0 });
  assert.deepEqual(report.verify!.remaining.filter((flagPath) => HOURS_LABELS.includes(flagPath)), []);
  for (const index of [0, 1, 2]) {
    assert.equal(valueAt(report.recipe, index), null, `row ${index} value is null`);
    assert.ok(!report.html.includes(`restaurant-hours-location--items-${index}--label`), `row ${index} is not on the page`);
  }
  assert.deepEqual([...report.nulled].filter((path) => HOURS_VALUES.includes(path)).sort(), HOURS_VALUES);
});

test('the brief\'s three rows, copied verbatim, are kept', async () => {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const model = fakeModel({ fill: keep, firstAnswer: rowsAnswer([['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'Closed']]) });
  const report = await runFastLane({ pkg, brief: REFERENCE, mode: 'sections', entry: 'r.html', revision: 1, model, modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0 });
  assert.deepEqual(report.verify!.flagged.filter((flagPath) => HOURS_LABELS.includes(flagPath)), []);
  for (const index of [0, 1, 2]) assert.notEqual(valueAt(report.recipe, index), null);
  for (const text of ['Tuesday-Thursday', '5-9:30pm', 'Friday-Saturday', '5-10pm', 'Sunday and Monday']) assert.ok(report.html.includes(`>${text}<`), `${text} is on the page`);
});

test('an advisory run saves the page with the dropped rows gone, the same page the report returns', async () => {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const pages: string[] = [];
  const publisher: ProjectPublisher = {
    projectId: 'p1',
    async savePage(_entry, html) { pages.push(html); },
    async saveFile() {},
    async deleteProject() { return 'deleted' as const; },
  };
  const report = await runFastLane({ pkg, brief: REFERENCE.replace(HOURS_CLAUSE, ''), mode: 'sections', entry: 'r.html', revision: 1, model: fakeModel({ fill: stubborn, firstAnswer: inventedValues }), modelName: 'fake', verify: fakeJevChecker(), maxFaithfulnessRounds: 0, publisher });
  const saved = pages.at(-1)!;
  assert.equal(saved, report.html);
  for (const text of ['8am-6pm', '9am-4pm', 'All day']) assert.ok(!saved.includes(`>${text}<`), `${text} is not on the saved page`);
});

test('when only one row of a verbatim table is flagged (by Jev), the whole table is dropped, not left half-shown or refused', async () => {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const model = fakeModel({ fill: keep, firstAnswer: rowsAnswer([['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'Closed']]) });
  // Jev doubts the last label only; the deterministic gate passes the table.
  const verify = { async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) {
    return { flagged: slots.filter((slot) => slot.path === 'sections[3].items[2].label').map((slot) => ({ path: slot.path, probability: 0.95 })), ms: 1, calls: 1 };
  } };
  const report = await runFastLane({ pkg, brief: REFERENCE, mode: 'sections', entry: 'r.html', revision: 1, model, modelName: 'fake', verify, strict: true, maxFaithfulnessRounds: 0 });
  assert.deepEqual(report.verify!.remaining.filter((flagPath) => HOURS_LABELS.includes(flagPath)), []);
  for (const index of [0, 1, 2]) assert.equal(valueAt(report.recipe, index), null, `row ${index} value is null`);
});


test('a re-run that changes one row of a correct table keeps all three rows (the table is judged whole, not on its unlocked rows)', async () => {
  const pkg = await loadFamilyPackage(DIR, 'restaurant');
  const rows: Array<[string, string]> = [['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'Closed']];
  const first = await runFastLane({ pkg, brief: REFERENCE, mode: 'sections', entry: 'r.html', revision: 1, model: fakeModel({ fill: keep, firstAnswer: rowsAnswer(rows) }), modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0 });
  for (const index of [0, 1, 2]) assert.notEqual(valueAt(first.recipe, index), null);
  // The owner renames one row's days; rows 0 and 2 are unchanged, so the re-run locks them.
  const brief = REFERENCE.replace('Friday-Saturday 5-10pm', 'Friday and Saturday 5-10pm');
  assert.notEqual(brief, REFERENCE);
  const spine = structuredClone(first.recipe) as JsonObject;
  ((spine.sections as JsonObject[])[3]!.items as JsonObject[])[1]!.label = 'Friday and Saturday';
  const rename: Filler = (key, value) => (key === 'label' && value === 'Monday' ? 'Friday and Saturday' : value);
  for (const rounds of [0, 2]) {
    const report = await runFastLane({ pkg, brief, mode: 'sections', entry: 'r.html', revision: 2, model: fakeModel({ fill: rename }), modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: rounds, spine, previousRecipe: first.recipe as JsonObject });
    assert.deepEqual(report.verify!.remaining.filter((flagPath) => HOURS_LABELS.includes(flagPath)), [], `rounds ${rounds}`);
    for (const index of [0, 1, 2]) assert.notEqual(valueAt(report.recipe, index), null, `rounds ${rounds}: row ${index} is kept`);
    assert.ok(report.html.includes('>Friday and Saturday<'), `rounds ${rounds}: the renamed row is on the page`);
  }
});

for (const [count, clause, rows] of [
  [1, 'Hours: Tuesday-Sunday 5-10pm. ', [['Tuesday-Sunday', '5-10pm']]],
  [2, 'Hours: Tuesday-Saturday 5-10pm, closed Sunday and Monday. ', [['Tuesday-Saturday', '5-10pm'], ['Sunday and Monday', 'Closed']]],
] as const) {
  test(`a correct ${count}-row table is kept when Jev doubts the hidden spare row's label`, async () => {
    const pkg = await loadFamilyPackage(DIR, 'restaurant');
    const brief = REFERENCE.replace(HOURS_CLAUSE, clause);
    // The model copies the brief's rows and leaves the spare rows' values null, with a day label Jev doubts.
    const answer = (template: Json, limits: Json | undefined): Json | undefined => {
      const filled = rowsAnswer([...rows.map(([days, status]) => [days, status] as [string, string]), ['Holidays', ''], ['Holidays', '']])(template, limits) as JsonObject | undefined;
      if (filled) (filled.items as JsonObject[]).forEach((item, index) => { if (index >= count) item.value = null; });
      return filled;
    };
    const verify = { async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) {
      return { flagged: slots.filter((slot) => slot.text === 'Holidays').map((slot) => ({ path: slot.path, probability: 0.95 })), ms: 1, calls: 1 };
    } };
    for (const rounds of [0, 2]) {
      const report = await runFastLane({ pkg, brief, mode: 'sections', entry: 'r.html', revision: 1, model: fakeModel({ fill: keep, firstAnswer: answer }), modelName: 'fake', verify, strict: true, maxFaithfulnessRounds: rounds });
      assert.deepEqual(report.verify!.remaining.filter((flagPath) => HOURS_LABELS.includes(flagPath)), [], `rounds ${rounds}`);
      for (const [index, [days, status]] of rows.entries()) {
        assert.notEqual(valueAt(report.recipe, index), null, `rounds ${rounds}: row ${index} is kept`);
        assert.ok(report.html.includes(`>${days}<`) && report.html.includes(`>${status}<`), `rounds ${rounds}: ${days} ${status} is on the page`);
      }
    }
  });
}
