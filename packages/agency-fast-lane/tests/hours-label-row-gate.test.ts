/**
 * The hours gate, FAIL CLOSED, VERBATIM, MECHANICAL (PR #137 rulings; `hours-label.ts`). An hours
 * row passes only as an exact copy (ASCII case and whitespace folded) of ONE row of a sentence
 * that starts "Hours:" / "Opening hours:" / "Open:", and only when that whole clause is clean rows;
 * a group shows every row in order or none; halcyon's rail never shows hours.
 *
 * Must flag: every example from the G8 diagnosis (restaurant r1..r6), Opus rounds 1-3 and Sol
 * rounds 1-3, asserting the whole row set (every row) and the rail. Must pass: each reference
 * brief's verbatim rows, shown in full and in order.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { briefHoursClauseRows, briefHoursRowsForHint, deterministicHoursNullFlags, normalizeHoursRowSeparator } from '../src/hours-label.ts';
import { deterministicHoursLabelFlags } from '../src/jev.ts';
import { HOURS_LABEL_PLACEHOLDER, HOURS_LABEL_RULE, HOURS_ROW_PLACEHOLDER, isHoursPlaceholder } from '../src/prompt.ts';
import { hoursLabelRepairHint, hoursNullRepairHint } from '../src/repair-hints.ts';
import { faithfulnessRepairError, runFastLane, setTextAtPathLabel, type RunEvent } from '../src/run.ts';
import { editableTemplate, hoursGroupsFor, hoursLabelPathsFor, hoursNullPathsFor, hoursRowValuePathsFor, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { defaultFill, fakeJevChecker, fakeModel, fillTemplate, HALCYON_DIR, promptBlock, type Filler } from './fixtures.ts';

const EXAMPLES = path.join(import.meta.dirname, '../../../plugins/_official/examples');
const briefOf = (dir: string, family: string) => readFileSync(path.join(EXAMPLES, dir, 'compiler/scripts/families', family, 'reference.fixture.brief.txt'), 'utf8');
const RESTAURANT = briefOf('agency-restaurant', 'restaurant');
const HALCYON = briefOf('agency-halcyon', 'halcyon');
const WRENFIELD = briefOf('agency-wrenfield', 'wrenfield');
const PRACTICE = briefOf('agency-practice', 'practice');

/** One day label with its own value slot, alone (no group). */
function sep(brief: string, label: string, value: string | null): boolean {
  return deterministicHoursLabelFlags(brief, [{ path: 'l', text: label }], new Set(['l']), new Map([['l', 'v']]), () => value).length > 0;
}
/** One combined slot, alone. */
function comb(brief: string, text: string): boolean {
  return deterministicHoursLabelFlags(brief, [{ path: 'l', text }], new Set(['l'])).length > 0;
}
/** A group of label + value rows, shown in this order; returns the flagged row indexes. */
function table(brief: string, rows: Array<[string, string | null]>): number[] {
  const paths = rows.map((_, i) => `l${i}`);
  const slots = rows.map(([label], i) => ({ path: `l${i}`, text: label }));
  const values = new Map(rows.map(([, value], i) => [`v${i}`, value]));
  const flags = deterministicHoursLabelFlags(brief, slots, new Set(paths), new Map(paths.map((p, i) => [p, `v${i}`])), (p) => values.get(p), new Map([['g', paths]]));
  return flags.map((flag) => Number(flag.path.slice(1))).sort();
}
/** The rail (`x-verify: 'hours-null'`): any filled value flags. */
const railFlags = (value: string) => deterministicHoursNullFlags([{ path: 'r', text: value }], new Set(['r'])).length > 0;

/** Every row a brief states, as label + value pairs: each one alone must flag when the clause is dropped. */
function everyRowFlags(brief: string, rows: Array<[string, string]>): void {
  assert.deepEqual(briefHoursClauseRows(brief), [], `${brief}: the whole clause gives no rows`);
  for (const [label, value] of rows) {
    assert.equal(sep(brief, label, value), true, `${brief}: ${label} | ${value}`);
    assert.equal(comb(brief, `${label} ${value}`), true, `${brief}: combined ${label} ${value}`);
    assert.equal(railFlags(`${label} ${value}`), true, 'the rail never shows hours');
  }
}

// ---------------------------------------------------------------------------------------------
// The brief's rows
// ---------------------------------------------------------------------------------------------

test('each reference brief\'s hours clause parses into its verbatim rows', () => {
  assert.deepEqual(briefHoursRowsForHint(RESTAURANT), ['"Tuesday-Thursday" | "5-9:30pm"', '"Friday-Saturday" | "5-10pm"', '"Sunday and Monday" | "closed"']);
  assert.deepEqual(briefHoursRowsForHint(PRACTICE), ['"Monday-Thursday" | "8am-5pm"', '"Friday" | "8am-2pm"', '"Saturday and Sunday" | "closed"']);
  assert.deepEqual(briefHoursRowsForHint(HALCYON), ['"Wednesday-Friday" | "11:00-18:00"', '"Saturday" | "10:00-19:00"', '"Sunday" | "10:00-17:00"', '"Monday and Tuesday" | "closed"']);
  assert.deepEqual(briefHoursRowsForHint(WRENFIELD), ['"Monday-Friday" | "7am-5pm"', '"Saturday" | "by appointment"']);
});

test('only a sentence that STARTS with "Hours:" / "Opening hours:" / "Open:" is a clause', () => {
  for (const brief of ['We are open Tuesday-Sunday 5-10pm.', 'Holiday hours: Monday-Friday 10am-2pm.', 'Reservations: Tuesday-Thursday 6-8pm.', 'Reservations open Tuesday-Thursday 6-8pm.', 'In winter, hours: Monday-Friday 10-4.', 'Contact us (hours: Monday 9-5).'])
    assert.deepEqual(briefHoursClauseRows(brief), [], brief);
  assert.equal(briefHoursClauseRows('Opening hours: Monday 9-5.').length, 1);
  assert.equal(briefHoursClauseRows('Open: Monday 9-5.').length, 1);
});

// ---------------------------------------------------------------------------------------------
// Must pass: the verbatim rows, all of them, in order
// ---------------------------------------------------------------------------------------------

test('restaurant and practice: the whole table of verbatim rows passes', () => {
  assert.deepEqual(table(RESTAURANT, [['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'Closed']]), []);
  assert.deepEqual(table(RESTAURANT, [['tuesday-thursday', '5-9:30pm'], ['Friday-Saturday', ' 5-10pm '], ['sunday  and monday', 'closed']]), [], 'ASCII case and whitespace fold');
  assert.deepEqual(table(PRACTICE, [['Monday-Thursday', '8am-5pm'], ['Friday', '8am-2pm'], ['Saturday and Sunday', 'closed']]), []);
  assert.deepEqual(table(PRACTICE, [['Monday-Thursday', null], ['Friday', null], ['Saturday and Sunday', null]]), [], 'none shown');
});

test('halcyon and wrenfield: combined rows pass as the row text, or days + ", " / " | " + status', () => {
  assert.equal(comb(HALCYON, 'Wednesday-Friday 11:00-18:00'), false);
  assert.equal(comb(HALCYON, 'Saturday, 10:00-19:00'), false);
  assert.equal(comb(HALCYON, 'Sunday | 10:00-17:00'), false);
  assert.equal(comb(HALCYON, 'closed Monday and Tuesday'), false);
  assert.equal(comb(HALCYON, 'Monday and Tuesday, closed'), false);
  assert.equal(comb(WRENFIELD, 'Monday-Friday 7am-5pm'), false);
  assert.equal(comb(WRENFIELD, 'Saturday by appointment'), false);
});

// ---------------------------------------------------------------------------------------------
// G8 final on 857a46b982: halcyon x cerebras VERIFY_FAILED, footer col2Row1-4 (the "Open" hours
// column) unfaithful after two repair rounds. The reference recipe's own TEMPLATE seed for those
// rows (and the visit block's own hours row) used "Wednesday to Friday, 11:00 – 18:00" style
// punctuation (a comma, "to", an en dash) the brief never uses ("Wednesday-Friday 11:00-18:00") —
// but `maskHoursLabels` (run.ts) replaces every hours-row slot in the TEMPLATE with a placeholder
// before the prompt is built, so this fixture's own example text is never what the model sees.
// Rewriting it here is content hygiene, not the generation fix: it keeps the reference recipe's
// OWN hours text honest against the gate it will be held to, on both the footer and the visit
// block. The actual generation-side fix — what stops the MODEL from writing the comma-drop this
// bug class turned out to be — is in `HOURS_LABEL_RULE` (prompt.ts) and `hoursLabelRepairHint`
// (repair-hints.ts), plus the deterministic `normalizeHoursRowSeparator` post-merge normalizer
// (hours-label.ts) that catches what the wording alone did not. This test only guards against the
// fixture's own example text regressing back to the reworded style.
// ---------------------------------------------------------------------------------------------

test('the reference recipe\'s own footer and visit hours text passes the gate it will be held to', async () => {
  const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
  const sections = (pkg.fixture as { sections?: Array<{ type?: string; content?: Record<string, unknown> }> }).sections ?? [];
  const footer = sections.find((section) => section.type === 'footer')?.content;
  const visit = sections.find((section) => section.type === 'visit')?.content;
  assert.ok(footer, 'halcyon recipe.json has a footer section');
  assert.ok(visit, 'halcyon recipe.json has a visit section');
  for (const key of ['col2Row1', 'col2Row2', 'col2Row3', 'col2Row4'] as const) {
    const rowText: unknown = footer![key];
    assert.equal(typeof rowText, 'string', key);
    assert.equal(comb(HALCYON, rowText as string), false, `footer.${key}: ${String(rowText)}`);
  }
  assert.deepEqual(
    table(HALCYON, [
      [visit!.block1Key1 as string, visit!.block1Value1 as string],
      [visit!.block1Key2 as string, visit!.block1Value2 as string],
      [visit!.block1Key3 as string, visit!.block1Value3 as string],
      [visit!.block1Key4 as string, visit!.block1Value4 as string],
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------------------------
// Must flag: the G8 diagnosis and rounds 1-2 (single rows)
// ---------------------------------------------------------------------------------------------

test('G8 diagnosis and rounds 1-2: wrong, reworded or partial rows flag', () => {
  for (const [label, value] of [
    ['Tue-Thu', '5-9:30pm'], ['Fri-Sat', '5-10pm'], ['Sun-Mon', 'Closed'], ['Weekdays', '5-9:30pm'], ['Weekend', '5-10pm'],
    ['Closed', 'Closed'], ['Weekday', '5-9:30pm'], ['Closed days', 'Closed'], ['Hours', '5-9:30pm'], ['Friday-Saturday', '5-9:30pm'],
    ['Tuesday-Saturday', '5-10pm'], ['Tuesday', '5-9:30pm'], ['Tuesday–Thursday', '5-9:30pm'], ['Tuesday-Thursday', '5–9:30 pm'],
  ] as const) assert.equal(sep(RESTAURANT, label, value), true, `${label} | ${value}`);
  for (const text of ['Monday-Tuesday', 'Monday and Tuesday', 'Wednesday-Friday', 'Monday-Tuesday open', 'Monday and Tuesday closed', 'Wednesday-Friday: 11:00-18:00', 'Wed to Fri, 11:00 – 18:00'])
    assert.equal(comb(HALCYON, text), true, text);
  for (const text of ['Monday-Friday', 'Saturday', 'Mon–Fri, 7am–5pm', 'Saturday, no appointment needed', 'Every other Saturday by appointment', 'Monday-Friday 7am-5pm by appointment', 'Saturday by appointment or walk-ins'])
    assert.equal(comb(WRENFIELD, text), true, text);
  assert.equal(sep('Hours: Saturday 9pm-5am.', 'Saturday', '9am-5pm'), true);
  assert.equal(sep('Hours: Tuesday 5-9pm.', 'Tuesday not open', '5-9pm'), true);
  assert.equal(sep('Hours: Tuesday-Thursday 5-9pm.', 'Tuesday-Thursday except Tuesday', '5-9pm'), true);
  assert.equal(sep('Hours: Tuesday-Thursday 5-9pm.', 'Closed Tuesday-Thursday', '5-9pm'), true);
  assert.equal(sep('Hours: Tuesday-Thursday 5-9pm. Reservations: Tuesday-Thursday 6-8pm.', 'Tuesday-Thursday', '6-8pm'), true);
  assert.equal(sep(HALCYON, 'Late Thursdays', 'Free after 17:00'), true);
});

test('rounds 1-2: briefs with no clean clause flag every row', () => {
  everyRowFlags('Hours: Monday-Saturday 9am-5pm but Thursday until 8pm.', [['Monday-Saturday', '9am-5pm'], ['Thursday', 'until 8pm'], ['Thursday', 'Closed']]);
  everyRowFlags('Open every day except Monday, 10am-6pm.', [['Tuesday-Sunday', '10am-6pm'], ['Every day', '10am-6pm'], ['Monday', 'Closed']]);
  everyRowFlags('Hours: every day except Monday, 10am-6pm.', [['Every day', '10am-6pm'], ['Monday', '10am-6pm'], ['Monday', 'Closed']]);
  everyRowFlags('Hours: every other Saturday 9-1.', [['Saturday', '9-1']]);
  everyRowFlags('We are open Tuesday-Sunday 5-10pm, with brunch Saturday and Sunday 10am-2pm.', [['Tuesday-Sunday', '5-10pm'], ['Saturday and Sunday', '10am-2pm']]);
  everyRowFlags('Opening hours. Summer: Monday-Friday 8-6. Winter: Monday-Friday 9-5.', [['Monday-Friday', '8-6'], ['Monday-Friday', '9-5']]);
});

// ---------------------------------------------------------------------------------------------
// Must flag: Opus round 3 (B1-B3, F4, F5) and Sol round 3, every row and the rail
// ---------------------------------------------------------------------------------------------

test('Opus r3 B1: a clause with any unclean piece gives no rows at all (every row and the rail flag)', () => {
  everyRowFlags('Hours: Monday-Saturday 9am-5pm, but Thursday until 8pm.', [['Monday-Saturday', '9am-5pm'], ['Thursday', 'until 8pm'], ['Thursday', 'Closed']]);
  everyRowFlags('Open: daily 9am-5pm, but Sunday 12-5pm.', [['daily', '9am-5pm'], ['Sunday', '12-5pm'], ['Sunday', 'Closed']]);
  everyRowFlags('Hours: daily 10am-6pm, except Mondays.', [['daily', '10am-6pm'], ['Mondays', 'Closed']]);
  everyRowFlags('Hours: Tuesday-Saturday 5-9:30pm, not Thursdays.', [['Tuesday-Saturday', '5-9:30pm'], ['Thursdays', 'Closed']]);
  everyRowFlags('Hours: Monday-Friday 9-5, every other Saturday 9-1.', [['Monday-Friday', '9-5'], ['Saturday', '9-1']]);
  everyRowFlags('In winter, hours: Monday-Friday 10-4.', [['Monday-Friday', '10-4']]);
});

test('Opus r3 B2: a closed row and an open row are one table (all or none); the rail never shows them', () => {
  const B2a = 'Hours: Daily 11-10, closed Monday.';
  assert.deepEqual(table(B2a, [['Daily', '11-10'], ['Monday', 'closed']]), [], 'the brief\'s own two rows, in order');
  assert.deepEqual(table(B2a, [['Daily', '11-10'], ['Monday', null]]), [0], 'the open row without the closed one');
  assert.equal(railFlags('Daily'), true);
  assert.equal(railFlags('11-10'), true);
  const B2b = 'Hours: Tuesday-Saturday 5-9:30pm, Thursday closed.';
  assert.deepEqual(table(B2b, [['Tuesday-Saturday', '5-9:30pm'], ['Thursday', null]]), [0]);
  assert.equal(railFlags('Tuesday-Saturday'), true);
});

test('Opus r3 B3: "a.m." / "p.m." never end the clause; the rows keep their whole times', () => {
  const B3 = 'Hours: Monday-Friday 9 a.m. to 5 p.m., Saturday 10 a.m. to 2 p.m., closed Sunday.';
  assert.deepEqual(briefHoursRowsForHint(B3), ['"Monday-Friday" | "9 a.m. to 5 p.m."', '"Saturday" | "10 a.m. to 2 p.m."', '"Sunday" | "closed"']);
  assert.equal(sep(B3, 'Monday-Friday', '9 a.m'), true, 'a cut time never passes');
  assert.deepEqual(table(B3, [['Monday-Friday', '9 a.m. to 5 p.m.'], ['Saturday', '10 a.m. to 2 p.m.'], ['Sunday', 'closed']]), []);
  assert.equal(railFlags('Monday-Friday'), true);
  // A clause that may be cut short is dropped.
  assert.deepEqual(briefHoursClauseRows('Hours: Monday-Friday 9-5 approx. then by appointment.'), []);
  assert.deepEqual(briefHoursClauseRows('Hours: Monday-Friday 9-5 St. 12 closed.'), []);
});

test('Opus r3 F4: a group shows every row in the brief\'s order, once, or none', () => {
  const full: Array<[string, string]> = [['Tuesday-Thursday', '5-9:30pm'], ['Friday-Saturday', '5-10pm'], ['Sunday and Monday', 'closed']];
  assert.deepEqual(table(RESTAURANT, [full[0]!, full[1]!, ['Sunday and Monday', null]]), [0, 1], 'a missing closed row flags every shown row');
  assert.deepEqual(table(RESTAURANT, [full[0]!, full[0]!, full[2]!]), [0, 1, 2], 'a repeated row');
  assert.deepEqual(table(RESTAURANT, [full[1]!, full[0]!, full[2]!]), [0, 1, 2], 'reordered rows');
  assert.deepEqual(table(RESTAURANT, [full[0]!]), [0], 'one row of three');
  assert.deepEqual(table(PRACTICE, [['Monday-Thursday', '8am-5pm'], ['Friday', '8am-2pm']]), [0, 1], 'practice dropped its closed row');
  assert.equal(railFlags('Free after 17:00'), true, 'railValue3 is always null');
});

test('Opus r3 F5: B1/B2 briefs flag the "obvious" row next to the one tested before', () => {
  assert.equal(sep('Open: daily 9am-5pm, but Sunday 12-5pm.', 'daily', '9am-5pm'), true);
  assert.equal(sep('Hours: Monday-Saturday 9am-5pm, but Thursday until 8pm.', 'Monday-Saturday', '9am-5pm'), true);
});

test('Sol r3: a clause with an unclean part gives no rows; the rail flags; combined rows must be exact', () => {
  everyRowFlags('Hours: Tuesday-Thursday 5-9pm; except Tuesday.', [['Tuesday-Thursday', '5-9pm'], ['Tuesday', 'Closed']]);
  everyRowFlags('Hours: Tuesday-Thursday 5-9pm, except Tuesday.', [['Tuesday-Thursday', '5-9pm'], ['Tuesday', 'Closed']]);
  everyRowFlags('Hours: Monday-Friday 9-5, but Saturday 10-2.', [['Monday-Friday', '9-5'], ['Saturday', '10-2']]);
  assert.equal(railFlags('Tuesday'), true, 'Hours: Tuesday not open. — the rail never shows it');
  assert.equal(comb('Hours: closed Tuesday.', 'Tuesday closed'), true);
  assert.equal(comb('Hours: closed Tuesday.', 'closed Tuesday'), false);
  assert.equal(comb('Hours: Tuesday 5-9pm.', 'Tuesday: 5-9pm'), true);
  assert.equal(comb('Hours: Tuesday 5-9pm.', 'Tuesday 5-9pm'), false);
});

test('a null value drops its row; a declared value slot that is missing flags', () => {
  assert.equal(sep(RESTAURANT, 'Weekdays', null), false);
  assert.equal(deterministicHoursLabelFlags(RESTAURANT, [{ path: 'l', text: 'Tuesday-Thursday' }], new Set(['l']), new Map([['l', 'v']]), () => undefined).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Contract, prompt and repair wiring
// ---------------------------------------------------------------------------------------------

const FAMILIES: Array<[string, string, string[], Record<string, string>, Record<string, string[]>, string[]]> = [
  ['agency-restaurant', 'restaurant',
    ['sections[3].items[0].label', 'sections[3].items[1].label', 'sections[3].items[2].label'],
    { 'sections[3].items[0].label': 'sections[3].items[0].value', 'sections[3].items[1].label': 'sections[3].items[1].value', 'sections[3].items[2].label': 'sections[3].items[2].value' },
    { table: ['sections[3].items[0].label', 'sections[3].items[1].label', 'sections[3].items[2].label'] }, []],
  ['agency-practice', 'practice',
    ['sections[9].items[0].label', 'sections[9].items[1].label', 'sections[9].items[2].label'],
    { 'sections[9].items[0].label': 'sections[9].items[0].value', 'sections[9].items[1].label': 'sections[9].items[1].value', 'sections[9].items[2].label': 'sections[9].items[2].value' },
    { table: ['sections[9].items[0].label', 'sections[9].items[1].label', 'sections[9].items[2].label'] }, []],
  ['agency-halcyon', 'halcyon',
    [...[1, 2, 3, 4].map((n) => `sections[6].content.block1Key${n}`), ...[1, 2, 3, 4].map((n) => `sections[9].content.col2Row${n}`)],
    Object.fromEntries([1, 2, 3, 4].map((n) => [`sections[6].content.block1Key${n}`, `sections[6].content.block1Value${n}`])),
    { visit: [1, 2, 3, 4].map((n) => `sections[6].content.block1Key${n}`), footer: [1, 2, 3, 4].map((n) => `sections[9].content.col2Row${n}`) },
    ['sections[1].content.railValue1', 'sections[1].content.railValue2', 'sections[1].content.railValue3']],
  ['agency-wrenfield', 'wrenfield', ['sections[9].content.hours1', 'sections[9].content.hours2'], {}, { footer: ['sections[9].content.hours1', 'sections[9].content.hours2'] }, []],
];

for (const [dir, family, labels, values, groups, nulls] of FAMILIES) {
  test(`${family}: every hours slot carries its marker, group and value`, async () => {
    const pkg = await loadFamilyPackage(path.join(EXAMPLES, dir), family);
    const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
    assert.deepEqual([...hoursLabelPathsFor(pkg.schema, template)].sort(), [...labels].sort());
    assert.deepEqual(Object.fromEntries(hoursRowValuePathsFor(pkg.schema, template)), values);
    assert.deepEqual(Object.fromEntries(hoursGroupsFor(pkg.schema, template)), groups);
    assert.deepEqual([...hoursNullPathsFor(pkg.schema, template)].sort(), nulls);
  });
}

test('halcyon railValue2 stays limited to 16 characters', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-halcyon'), 'halcyon');
  const node = ((pkg.schema as any).properties.sections.prefixItems[1].properties.content.properties.railValue2) as { maxLength: number };
  assert.equal(node.maxLength, 16);
});

test('the fill prompt hides the reference hours labels and quotes the brief\'s rows verbatim', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-restaurant'), 'restaurant');
  const model = fakeModel({ fill: (_key, value) => value });
  await runFastLane({ pkg, brief: RESTAURANT, mode: 'sections', entry: 'r.html', revision: 1, model, modelName: 'fake' });
  const prompt = model.prompts.find((user) => user.includes('HOURS LABELS'));
  assert.ok(prompt, 'the hours section prompt carries an HOURS LABELS block');
  const template = promptBlock(prompt!, 'TEMPLATE') as { items: Array<{ label: string }> };
  assert.deepEqual(template.items.map((item) => item.label), [HOURS_LABEL_PLACEHOLDER, HOURS_LABEL_PLACEHOLDER, HOURS_LABEL_PLACEHOLDER]);
  for (const reference of ['Tue-Thu', 'Fri-Sat', 'Sun-Mon']) assert.ok(!model.prompts.some((user) => user.includes(`"${reference}"`)), `${reference} never reaches the model`);
  assert.ok(prompt!.includes(HOURS_LABEL_RULE));
  assert.ok(prompt!.includes('"Tuesday-Thursday" | "5-9:30pm"; "Friday-Saturday" | "5-10pm"; "Sunday and Monday" | "closed"'));
});

test('the halcyon hero rail rows 1-3 never reach the model and stay null', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-halcyon'), 'halcyon');
  const model = fakeModel({ fill: (_key, value) => value });
  const report = await runFastLane({ pkg, brief: HALCYON, mode: 'sections', entry: 'h.html', revision: 1, model, modelName: 'fake' }).catch(() => undefined);
  const hero = model.prompts.find((user) => user.includes('"railKey4"'));
  assert.ok(hero, 'the hero prompt');
  const template = promptBlock(hero!, 'TEMPLATE') as { content: Record<string, unknown> };
  for (const key of ['railKey1', 'railValue1', 'railKey2', 'railValue2', 'railKey3', 'railValue3']) assert.ok(!(key in template.content), `${key} is locked`);
  if (report) {
    const content = (report.recipe as { sections: Array<{ content: Record<string, unknown> }> }).sections[1]!.content;
    for (const key of ['railValue1', 'railValue2', 'railValue3']) assert.equal(content[key], null, key);
    assert.equal((report.html.match(/class="rail-row"/g) ?? []).length, 1, 'only the fourth rail row renders');
  }
});

test('the neutral placeholders appear in no eval or reference brief', () => {
  const roots = [path.join(import.meta.dirname, '../../../evals'), EXAMPLES];
  for (const placeholder of [HOURS_LABEL_PLACEHOLDER, HOURS_ROW_PLACEHOLDER]) {
    const result = spawnSync('grep', ['-rIli', '--include=*.txt', '--include=*.json', '--include=*.md', placeholder, ...roots], { encoding: 'utf8' });
    assert.equal(result.status, 1, `grep finds nothing (exit 1); got ${result.status}: ${result.stdout}${result.stderr}`);
  }
});

test('the repair hints quote the brief\'s rows verbatim, and say null when no row fits', () => {
  assert.match(hoursLabelRepairHint(RESTAURANT), /"Tuesday-Thursday" \| "5-9:30pm"/);
  assert.match(hoursLabelRepairHint('Open every day except Monday.'), /no "Hours:" clause/);
  assert.match(hoursNullRepairHint(), /return null/);
  const error = faithfulnessRepairError([{ path: 'sections[3].items[0].label', text: 'Weekdays' }], RESTAURANT, new Set(['sections[3].items[0].label']));
  assert.match(error, /exact copy of ONE row/);
});

/**
 * A first answer that also fills the restaurant hours values (nullable, so TEMPLATE shows null and
 * a `Filler` never reaches them) with the reference brief's own statuses, in its row order — what a
 * real model copying the brief's rows writes there.
 */
function restaurantHoursValues(fill: Filler) {
  const statuses = ['5-9:30pm', '5-10pm', 'Closed'];
  return (template: Json, limits: Json | undefined): Json | undefined => {
    if (!isObject(template) || !Array.isArray(template.items) || template.items.length !== 3 || !template.items.every((item) => isObject(item) && 'label' in item && 'value' in item)) return undefined;
    const filled = fillTemplate(template, limits, fill) as JsonObject;
    (filled.items as JsonObject[]).forEach((item, index) => { if (item.value === null) item.value = statuses[index] ?? null; });
    return filled;
  };
}

test('strict verify fails closed on "Weekdays / Weekend / Closed" and passes the brief\'s verbatim rows', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-restaurant'), 'restaurant');
  const hoursPaths = ['sections[3].items[0].label', 'sections[3].items[1].label', 'sections[3].items[2].label'];
  const run = async (labels: string[]) => {
    // The fake model sees "Monday" where TEMPLATE shows the placeholder (tests/fixtures.ts), and
    // writes the brief's own statuses into the (nullable) values a real model fills from the brief.
    const fill: Filler = (key, value, at) => (key === 'label' && value === 'Monday' ? labels[Number(/items\[(\d)\]/.exec(at)![1])]! : value);
    const report = await runFastLane({ pkg, brief: RESTAURANT, mode: 'sections', entry: 'r.html', revision: 1, model: fakeModel({ fill, firstAnswer: restaurantHoursValues(fill) }), modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0 });
    const pick = (paths: string[]) => paths.filter((flagPath) => hoursPaths.includes(flagPath)).sort();
    return { flagged: pick(report.verify!.flagged), remaining: pick(report.verify!.remaining), html: report.html };
  };
  // Wrong rows are flagged, and once the repairs are spent their rows are dropped (2026-10-10):
  // the page shows no hours rather than wrong ones, and no flag is left to refuse the build on.
  const wrong = await run(['Weekdays', 'Weekend', 'Closed']);
  assert.deepEqual(wrong.flagged, hoursPaths);
  assert.deepEqual(wrong.remaining, []);
  for (const index of [0, 1, 2]) assert.ok(!wrong.html.includes(`restaurant-hours-location--items-${index}--label`), `row ${index} is not on the page`);
  const right = await run(['Tuesday-Thursday', 'Friday-Saturday', 'Sunday and Monday']);
  assert.deepEqual(right.flagged, []);
  for (const label of ['Tuesday-Thursday', 'Friday-Saturday', 'Sunday and Monday']) assert.ok(right.html.includes(`>${label}<`), `${label} is on the page`);
});

test('F3: an hours placeholder left in place is a refused answer, in every verify mode, and never published', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-restaurant'), 'restaurant');
  // A model that answers every prompt (fill and every retry) with TEMPLATE verbatim, placeholders included.
  const echo = (async ({ user }: { user: string }) => {
    const text = JSON.stringify(promptBlock(user, 'TEMPLATE'));
    return { text, usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  }) as never;
  for (const mode of ['strict', 'advisory', 'off'] as const) {
    let registered = false;
    await assert.rejects(runFastLane({
      pkg, brief: RESTAURANT, mode: 'sections', entry: 'r.html', revision: 1, model: echo, modelName: 'fake',
      ...(mode === 'off' ? {} : { verify: fakeJevChecker(), strict: mode === 'strict' }),
      ensurePublisher: async () => { registered = true; throw new Error('must not publish'); },
    }), (error: Error) => /restaurant-hours-location/.test(error.message), mode);
    assert.equal(registered, false, mode);
  }
  assert.equal(isHoursPlaceholder(`  ${HOURS_ROW_PLACEHOLDER} `), true);
  assert.equal(isHoursPlaceholder('Tuesday-Thursday'), false);
});

test('a faithfulness repair shows the rejected hours labels in TEMPLATE, never the placeholder or the reference labels', async () => {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-restaurant'), 'restaurant');
  const labels = ['Weekdays', 'Weekend', 'Closed'];
  const fill: Filler = (key, value, at) => (key === 'label' && value === 'Monday' ? labels[Number(/items\[(\d)\]/.exec(at)![1])]! : value);
  const model = fakeModel({ fill, firstAnswer: restaurantHoursValues(fill) });
  await runFastLane({ pkg, brief: RESTAURANT, mode: 'sections', entry: 'r.html', revision: 1, model, modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 1 });
  const repairs = model.prompts.filter((user) => user.includes('YOUR PREVIOUS ANSWER WAS REJECTED') && user.includes('This is an hours row'));
  assert.ok(repairs.length > 0, 'the hours section was repaired');
  for (const user of repairs) {
    const template = promptBlock(user, 'TEMPLATE') as { items: Array<{ label: string }> };
    assert.deepEqual(template.items.map((item) => item.label), labels);
    assert.ok(!isHoursPlaceholder(JSON.stringify(template)));
  }
});

// ---------------------------------------------------------------------------------------------
// Round 2 audit (Opus F1, owner ruling): `normalizeHoursRowSeparator` only maps text to a form
// the unchanged gate already accepts for the SAME brief row. These are the adversarial probes the
// ruling required: a changed time, a changed day, a changed status, extra words, a different
// row's days, and trailing punctuation must all come back UNCHANGED — never rewritten into a
// passing form — because none of them is the row's own exact days-plus-status, just reordered.
// ---------------------------------------------------------------------------------------------

test('normalizeHoursRowSeparator: a correct day-first, bare-space reorder gets the missing comma', () => {
  assert.equal(normalizeHoursRowSeparator(HALCYON, 'Monday and Tuesday closed'), 'Monday and Tuesday, closed');
});

test('normalizeHoursRowSeparator: already-accepted forms pass through unchanged', () => {
  for (const text of ['closed Monday and Tuesday', 'Monday and Tuesday, closed', 'Monday and Tuesday | closed', 'Wednesday-Friday 11:00-18:00'])
    assert.equal(normalizeHoursRowSeparator(HALCYON, text), text);
});

test('normalizeHoursRowSeparator: adversarial probes never rewrite a wrong answer into a passing one', () => {
  const cases: Array<[string, string]> = [
    ['a changed time', 'Monday and Tuesday 11:00-18:00'],
    ['a changed status', 'Monday and Tuesday open'],
    ['extra words in the status', 'Monday and Tuesday closed early'],
    ['a different row\'s days with this row\'s status', 'Wednesday-Friday closed'],
    ['this row\'s days with a different row\'s status', 'Monday and Tuesday 10:00-19:00'],
    ['trailing punctuation', 'Monday and Tuesday closed.'],
    ['a single day instead of the row\'s two', 'Monday closed'],
    ['the days reordered within the phrase', 'Tuesday and Monday closed'],
  ];
  for (const [label, text] of cases) assert.equal(normalizeHoursRowSeparator(HALCYON, text), text, label);
});

// ---------------------------------------------------------------------------------------------
// Round 2 audit (Opus F1): `setTextAtPathLabel` used to mutate a node in place — possibly one
// `mergeAtPath` left shared with `working`'s pre-merge state. It is copy-on-write now: the return
// value has the new text, but nothing the caller still holds a reference to (the original root,
// or an untouched sibling) may change.
// ---------------------------------------------------------------------------------------------

test('setTextAtPathLabel: copy-on-write — the original tree and its untouched siblings are never mutated', () => {
  const original: JsonObject = { sections: [{ label: 'Monday and Tuesday closed', other: 'unchanged' }, { label: 'kept', nested: { deep: 'kept-too' } }] };
  const sections = original.sections as JsonObject[];
  const originalSection0 = sections[0]!;
  const originalSection1 = sections[1]!;
  const rewritten = setTextAtPathLabel(original, 'sections[0].label', 'Monday and Tuesday, closed') as JsonObject;
  // The original root and its untouched branch are byte-for-byte the same objects afterward.
  assert.equal(sections[0]!.label, 'Monday and Tuesday closed', 'the original leaf is untouched');
  assert.equal(sections[1], originalSection1, 'an untouched sibling is the SAME reference, not even copied');
  // The new tree has the new text, and only the path down to it was copied.
  const rewrittenSections = rewritten.sections as JsonObject[];
  assert.equal(rewrittenSections[0]!.label, 'Monday and Tuesday, closed');
  assert.equal(rewrittenSections[0]!.other, 'unchanged');
  assert.notEqual(rewrittenSections[0], originalSection0, 'the rewritten leaf\'s own parent is a fresh copy');
  assert.equal(rewrittenSections[1], originalSection1, 'an untouched sibling is reused by reference in the new tree too');
});

test('setTextAtPathLabel: a missing path, or a non-string leaf, is a no-op that returns the SAME reference', () => {
  const original: JsonObject = { a: { b: 'text' }, c: 5 };
  assert.equal(setTextAtPathLabel(original, 'a.missing', 'x'), original);
  assert.equal(setTextAtPathLabel(original, 'c', 'x'), original, 'c is a number, not a string leaf');
});

// ---------------------------------------------------------------------------------------------
// Round 2 audit (Opus F1, owner ruling, requirement 3a/3b): every normalization emits its own
// `hours-normalized` event, naming the exact path and the exact before/after text — never silent.
// ---------------------------------------------------------------------------------------------

test('a day-first, bare-space hours answer is normalized in place and emits hours-normalized with the exact path, before and after', async () => {
  const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
  const fill: Filler = (key, value, at, limit) => (at.endsWith('col2Row4') ? 'Monday and Tuesday closed' : defaultFill(key, value, at, limit));
  const model = fakeModel({ fill });
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: HALCYON, mode: 'sections', entry: 'h.html', revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  const normalized = events.filter((event) => event.type === 'hours-normalized');
  assert.equal(normalized.length, 1, 'exactly one rewrite, for the one slot that needed it');
  const event = normalized[0]!;
  assert.equal(event.type === 'hours-normalized' && event.path.endsWith('col2Row4'), true);
  assert.equal(event.type === 'hours-normalized' && event.before, 'Monday and Tuesday closed');
  assert.equal(event.type === 'hours-normalized' && event.after, 'Monday and Tuesday, closed');
  // The published page carries the normalized text, not the model's original bare-space answer.
  assert.equal(report.html.includes('Monday and Tuesday, closed'), true);
  assert.equal(report.html.includes('Monday and Tuesday closed<'), false, 'the un-normalized form never reaches the page');
});

test('an hours answer that already matches an accepted form emits no hours-normalized event', async () => {
  const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
  const fill: Filler = (key, value, at, limit) => (at.endsWith('col2Row4') ? 'Monday and Tuesday, closed' : defaultFill(key, value, at, limit));
  const model = fakeModel({ fill });
  const events: RunEvent[] = [];
  await runFastLane({ pkg, brief: HALCYON, mode: 'sections', entry: 'h.html', revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(events.filter((event) => event.type === 'hours-normalized').length, 0);
});

// ---------------------------------------------------------------------------------------------
// Round 3 audit (Opus F2): the label/value prefix-strip (`run.ts`'s `applyUnit`, the separate
// label+value slot pair's own version of the hours normalizer) had no test at all — no unit test,
// no adversarial probe, no event assertion — even though it fired in live evidence (fix4-cerebras-
// r8 rewrote `block1Value2`/`block1Value3`). Opus's own probe (`/tmp/hg8r3/strip.test.ts`) found
// the logic safe: wrong hours, an extra row, a wrong status and an extra claim all stay flagged
// after whatever the strip does to them; only a text that is genuinely its own label's day text
// plus the row's real status becomes a pass. These are those probes, run through the REAL
// `applyUnit` path (via `runFastLane`, strict verify, the unchanged deterministic gate), not a
// reimplementation of the strip logic.
// ---------------------------------------------------------------------------------------------

test('the label/value prefix-strip: only a correct duplicate becomes a pass; wrong hours, an extra row, a wrong status and an extra claim all stay flagged', async () => {
  const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
  // The deterministic hours gate flags a bad label/value pair by the LABEL's own path (it "names
  // its value slot" — see hours-label.ts's module doc) — never the value's own path, so that is
  // what `remaining` is checked against; `VALUE_PATH` is only where `hours-normalized` fires.
  const LABEL_PATH = 'sections[6].content.block1Key2';
  const VALUE_PATH = 'sections[6].content.block1Value2';
  const run = async (value: string) => {
    // `block1Value2` shows `null` in TEMPLATE (a nullable hours value — see `maskHoursLabels`), so
    // a `Filler` never reaches it: the fake model would leave it null, same as every other nullable
    // slot it is never told to fill. `firstAnswer` overrides the whole unit's answer instead, the
    // way a real model choosing to write a value there (as live evidence shows it does) would.
    const model = fakeModel({
      firstAnswer: (template, limits) => {
        if (!isObject(template) || !isObject(template.content) || !('block1Key1' in template.content)) return undefined; // not the visit unit
        const filled = fillTemplate(template, limits) as JsonObject;
        const content = filled.content as JsonObject;
        // Every OTHER row of this hours group stays the brief's own verbatim text: the group-
        // consistency rule flags every row of a group when even one is wrong, which would
        // otherwise mask what THIS test is isolating. Only block1Value2 (paired with "Saturday")
        // varies, under `value`.
        content.block1Key1 = 'Wednesday-Friday';
        content.block1Value1 = '11:00-18:00';
        content.block1Key2 = 'Saturday';
        content.block1Value2 = value;
        content.block1Key3 = 'Sunday';
        content.block1Value3 = '10:00-17:00';
        content.block1Key4 = 'Monday and Tuesday';
        content.block1Value4 = 'Closed';
        return filled;
      },
    });
    const events: RunEvent[] = [];
    const report = await runFastLane({ pkg, brief: HALCYON, mode: 'sections', entry: 'h.html', revision: 1, model, modelName: 'fake', verify: fakeJevChecker(), maxFaithfulnessRounds: 0, onEvent: (event) => events.push(event) });
    // A row still flagged once the repairs are spent is dropped, not refused (2026-10-10), so
    // "stays flagged" means: flagged by the check, and its text is not on the published page.
    return {
      flagged: report.verify!.flagged.includes(LABEL_PATH),
      published: report.html.includes(value),
      // The row's value in the final recipe: null means the whole row is off the page.
      kept: ((((report.recipe as JsonObject).sections as JsonObject[])[6]!.content as JsonObject).block1Value2 ?? null) !== null,
      normalized: events.filter((event) => event.type === 'hours-normalized' && event.path === VALUE_PATH),
    };
  };
  const legit = await run('Saturday 10:00-19:00');
  assert.equal(legit.kept, true, 'a correct duplicate keeps its row');
  assert.equal(legit.flagged, false, 'a correct duplicate ("Saturday" + its own row\'s hours) passes once the duplicate day prefix is stripped');
  assert.equal(legit.normalized.length, 1);
  assert.equal(legit.normalized[0]!.type === 'hours-normalized' && legit.normalized[0]!.before, 'Saturday 10:00-19:00');
  assert.equal(legit.normalized[0]!.type === 'hours-normalized' && legit.normalized[0]!.after, '10:00-19:00');
  for (const [label, value] of [
    ['wrong hours', 'Saturday 11:00-18:00'],
    ['an extra row', 'Saturday 10:00-19:00 and Sunday 10:00-17:00'],
    ['a wrong status', 'Saturday closed'],
    ['an extra claim', 'Saturday 10:00-19:00, free entry'],
  ] as const) {
    const result = await run(value);
    assert.equal(result.flagged, true, `${label}: ${JSON.stringify(value)} must stay flagged`);
    assert.equal(result.published, false, `${label}: ${JSON.stringify(value)} is not published`);
    assert.equal(result.kept, false, `${label}: the row is dropped (its value is null in the recipe)`);
  }
});

// ---------------------------------------------------------------------------------------------
// Round 3 audit (Sol FIX): a checker spy — proves every hours-label slot actually reaches Jev,
// carrying the neutral context (round 2's owner-ruled addition), so a reintroduced Jev-skip for
// these slots (the mechanism reverted earlier in this PR's history) would fail this test, not just
// the deterministic-gate tests above.
// ---------------------------------------------------------------------------------------------

test('every hours-label slot reaches Jev, carrying the neutral context — none are skipped', async () => {
  const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
  const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
  const expectedHoursPaths = hoursLabelPathsFor(pkg.schema, template);
  assert.ok(expectedHoursPaths.size > 0, 'halcyon has hours-label slots to check');
  const seenSlots = new Map<string, string | undefined>();
  const checker = {
    calls: 0,
    async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string; context?: string }> }) {
      checker.calls += 1;
      for (const slot of slots) seenSlots.set(slot.path, slot.context);
      return { flagged: [], ms: 1, calls: 1 };
    },
  };
  await runFastLane({ pkg, brief: HALCYON, mode: 'sections', entry: 'h.html', revision: 1, model: fakeModel(), modelName: 'fake', verify: checker, maxFaithfulnessRounds: 0 });
  assert.ok(checker.calls > 0, 'the checker was actually invoked');
  for (const path of expectedHoursPaths) {
    assert.ok(seenSlots.has(path), `${path} reached Jev as its own slot — never skipped`);
    const context = seenSlots.get(path);
    assert.equal(typeof context, 'string', `${path} carries the neutral hours context`);
    assert.ok(context!.includes('opening-hours'), `${path}: context names the brief's opening-hours clause`);
    // Round 2 audit (Sol FIX): the context must not pre-assert what the candidate is NOT, and must
    // not name a shape the rule itself rejects (a bare "<days> <status>" reorder).
    assert.equal(context!.includes('never a contact detail'), false, `${path}: context stays neutral, no pre-assertion`);
    assert.equal(context!.includes('<days> <status>'), false, `${path}: context never names the rejected bare-space shape`);
  }
});
