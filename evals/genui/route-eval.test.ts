/**
 * The route eval's scoring rule (C8), offline: correct = routed to an acceptable family, or
 * unrouted when none is acceptable; illegal = routed to an illegal family; pass needs correct >=
 * 20, >= 5 distinct families and no illegal pick. Also checks the labels fixture carries the M4
 * family ids, not the labeller's aliases, that v2 differs from the frozen v1 labels only in the two
 * adjudicated fields, that incomplete answers score as missing, and that --out must be fresh.
 *
 *   node --experimental-strip-types --test evals/genui/route-eval.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error -- a plain ES module with no type declarations
import { answersFromProfile, assertFreshOutDir, incompleteAnswers, MODE, PASS, scoreRoutes } from './8-route-eval.mjs';

type Label = { id: string; acceptableFamilies: string[]; illegalFamilies: string[]; unroutedAcceptable?: boolean };
type LabelsFile = {
  version: number;
  provenance: {
    v2: { changed: { id: string; field: string }[] };
    v3: { items: string[] };
    v4: { addedItems: string[] };
    v5: { addedItems: string[] };
  };
  aliases: Record<string, string>;
  families: string[];
  items: Label[];
};
const readLabels = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const LABELS = readLabels('route-corpus-labels.json') as LabelsFile;
/** The original labelling output, byte-for-byte, with the labeller's placeholder family names. */
const LABELS_V1 = readLabels('route-corpus-labels.v1.json') as { version: number; items: Record<string, unknown>[] };

/** A fake `resolve` that routes each item to a family fixed per id (null = unrouted). */
const routeTo = (picks: Record<string, string | null>) => (answers: { id: string }) => {
  const family = picks[answers.id];
  return family ? { decision: 'routed', family: { id: family, probability: 0.9 }, spine: { choice: 'TL' } } : { decision: 'unrouted', reason: 'test', spine: { choice: 'none' } };
};
const answer = (choice: string) => ({ type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } });
const answersFor = (ids: string[]) => ({ models: ['fake'], items: Object.fromEntries(ids.map((id) => [id, { answers: { id, spine: answer('TL'), skin: answer('Editorial'), family: answer('watson') } }])) });

test('the labels fixture is the 25-item corpus plus the v3 docs-hub, v4 restaurant and v5 community appended items, under the M4 family ids', () => {
  assert.equal(LABELS.items.length, 31);
  for (const id of ['listings', 'publication', 'nonprofit', 'docs-hub', 'restaurant', 'community']) assert.ok(LABELS.families.includes(id), id);
  for (const alias of ['search-match', 'content-sub', 'mission']) {
    assert.ok(!LABELS.families.includes(alias), alias);
    for (const item of LABELS.items) assert.ok(![...item.acceptableFamilies, ...item.illegalFamilies].includes(alias), `${item.id}: ${alias}`);
  }
});

test('the 2 appended v3 items are docs-hub (CS.02), acceptable only for docs-hub', () => {
  const appendedIds = new Set(LABELS.provenance.v3.items);
  const appended = LABELS.items.filter((item) => appendedIds.has(item.id));
  assert.equal(appended.length, 2);
  assert.deepEqual(appended.map((item) => item.id).sort(), [...appendedIds].sort(), 'every provenance.v3 id is present, and only those');
  for (const item of appended) {
    assert.deepEqual(item.acceptableFamilies, ['docs-hub'], item.id);
    assert.ok(!item.illegalFamilies.includes('docs-hub'), item.id);
  }
});

test('the 2 appended v4 items are restaurant (BA.02) briefs, acceptable only for restaurant', () => {
  const appendedIds = new Set(LABELS.provenance.v4.addedItems);
  const appended = LABELS.items.filter((item) => appendedIds.has(item.id));
  assert.equal(appended.length, 2);
  assert.deepEqual(appended.map((item) => item.id).sort(), [...appendedIds].sort(), 'every provenance.v4 id is present, and only those');
  for (const item of appended) {
    assert.deepEqual(item.acceptableFamilies, ['restaurant'], item.id);
    assert.ok(!item.illegalFamilies.includes('restaurant'), item.id);
  }
});

test('the 2 appended v5 items are community (LM.03) briefs, acceptable only for community', () => {
  const appendedIds = new Set(LABELS.provenance.v5.addedItems);
  const appended = LABELS.items.filter((item) => appendedIds.has(item.id));
  assert.equal(appended.length, 2);
  assert.deepEqual(appended.map((item) => item.id).sort(), [...appendedIds].sort(), 'every provenance.v5 id is present, and only those');
  for (const item of appended) {
    assert.deepEqual(item.acceptableFamilies, ['community'], item.id);
    assert.ok(!item.illegalFamilies.includes('community'), item.id);
  }
});

test('correct, illegal and unrouted are scored by the C8 rule', () => {
  const labels = { items: [
    { id: 'a', acceptableFamilies: ['fervor'], illegalFamilies: ['emmpo'] },
    { id: 'b', acceptableFamilies: ['fervor'], illegalFamilies: ['emmpo'] },
    { id: 'c', acceptableFamilies: [], illegalFamilies: ['emmpo'] },
    { id: 'd', acceptableFamilies: [], illegalFamilies: [] },
    { id: 'e', acceptableFamilies: ['watson'], illegalFamilies: [] },
  ] };
  const score = scoreRoutes(labels, answersFor(['a', 'b', 'c', 'd']), routeTo({ a: 'fervor', b: 'emmpo', c: null, d: 'watson' }));
  assert.deepEqual(score.rows.map((row: { correct: boolean }) => row.correct), [true, false, true, false, false]);
  assert.deepEqual(score.rows.map((row: { illegal: boolean }) => row.illegal), [false, true, false, false, false]);
  assert.equal(score.rows[4].decision, 'missing', 'an item with no answers counts as wrong');
  assert.equal(score.correct, 2);
  assert.equal(score.illegal, 1);
  assert.deepEqual(score.families, ['emmpo', 'fervor', 'watson']);
  assert.equal(score.passed, false);
});

test('unroutedAcceptable makes unrouted correct without making other families correct', () => {
  const labels = { items: [
    { id: 'a', acceptableFamilies: ['publication'], unroutedAcceptable: true, illegalFamilies: ['fervor'] },
    { id: 'b', acceptableFamilies: ['publication'], unroutedAcceptable: true, illegalFamilies: ['fervor'] },
    { id: 'c', acceptableFamilies: ['publication'], unroutedAcceptable: true, illegalFamilies: ['fervor'] },
    { id: 'd', acceptableFamilies: ['publication'], illegalFamilies: ['fervor'] },
  ] };
  const score = scoreRoutes(labels, answersFor(['a', 'b', 'c', 'd']), routeTo({ a: null, b: 'publication', c: 'fervor', d: null }));
  assert.deepEqual(score.rows.map((row: { correct: boolean }) => row.correct), [true, true, false, false]);
  assert.equal(score.rows[2].illegal, true);
});

test('labels v5 keeps the v2 adjudication (two items) and adds the v3 docs-hub, v4 restaurant and v5 community items', () => {
  assert.equal(LABELS.version, 5);
  assert.deepEqual(LABELS.provenance.v2.changed.map((entry) => entry.id), ['dreamcore-landing', 'mostar-guide']);
  const byId = Object.fromEntries(LABELS.items.map((item) => [item.id, item]));
  assert.deepEqual(byId['dreamcore-landing']!.acceptableFamilies, []);
  assert.deepEqual(byId['mostar-guide']!.acceptableFamilies, ['publication']);
  assert.equal(byId['mostar-guide']!.unroutedAcceptable, true);
  assert.deepEqual(LABELS.items.filter((item) => item.unroutedAcceptable).map((item) => item.id), ['mostar-guide']);
  assert.deepEqual(LABELS.provenance.v3.items, ['loomwork-docs-hub', 'harborline-api-knowledge-base']);
  assert.deepEqual(LABELS.provenance.v4.addedItems, ['coastal-trattoria-brief', 'neighborhood-bistro-brief']);
  assert.deepEqual(LABELS.provenance.v5.addedItems, ['kiln-row-makers-membership', 'downtown-coworking-club']);
});

test('frozen v1 and v2 differ in exactly the two adjudicated item fields, over the original 25-item corpus', () => {
  assert.equal(LABELS_V1.version, 1);
  assert.equal(LABELS_V1.items.length, 25);
  // v1 names the three new families by the labeller's placeholders; map them the way v2 does.
  const mapped = JSON.parse(JSON.stringify(LABELS_V1.items, (_key, value) => (typeof value === 'string' && value in LABELS.aliases ? LABELS.aliases[value] : value))) as Record<string, unknown>[];
  // The v3 docs-hub, v4 restaurant and v5 community items have no v1 counterpart; the
  // frozen-diff comparison covers only the ids v1 actually has — matched by id, never by
  // position, so this stays correct however many more items are appended, and wherever in the
  // array they happen to sit.
  const v1Ids = new Set(mapped.map((item) => item.id as string));
  const v1Core = LABELS.items.filter((item) => v1Ids.has(item.id));
  assert.deepEqual(mapped.map((item) => item.id), v1Core.map((item) => item.id));
  const diffs: string[] = [];
  mapped.forEach((before) => {
    const after = v1Core.find((item) => item.id === before.id) as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) diffs.push(`${String(before.id)}.${key}`);
    }
  });
  assert.deepEqual(diffs, ['dreamcore-landing.acceptableFamilies', 'mostar-guide.unroutedAcceptable']);
  assert.deepEqual(diffs, LABELS.provenance.v2.changed.map((entry) => `${entry.id}.${entry.field}`), 'the provenance block lists the same changes');
});

test('an item whose answers lack spine, skin or family is missing, not unrouted', () => {
  const labels = { items: [
    { id: 'empty', acceptableFamilies: [], illegalFamilies: [] },
    { id: 'no-family', acceptableFamilies: [], unroutedAcceptable: true, illegalFamilies: [] },
    { id: 'whole', acceptableFamilies: [], illegalFamilies: [] },
  ] };
  const answersFile = answersFor(['whole']) as { items: Record<string, { answers: unknown }> };
  answersFile.items.empty = { answers: {} };
  answersFile.items['no-family'] = { answers: { spine: answer('TL'), skin: answer('Editorial') } };
  let resolved = 0;
  const resolve = (answers: { id?: string }) => { resolved += 1; return routeTo({})(answers as { id: string }); };
  const score = scoreRoutes(labels, answersFile, resolve);
  assert.deepEqual(score.rows.map((row: { decision: string }) => row.decision), ['missing', 'missing', 'unrouted']);
  assert.deepEqual(score.rows.map((row: { correct: boolean }) => row.correct), [false, false, true]);
  assert.equal(score.rows[0].reason, 'answers lack spine, skin, family');
  assert.equal(score.rows[1].reason, 'answers lack family');
  assert.equal(resolved, 1, 'resolveRoute is never called on an incomplete item');
  assert.equal(incompleteAnswers({ spine: answer('TL'), skin: answer('Editorial'), family: { choice: 'watson' } }), 'answers lack family');
  assert.equal(incompleteAnswers(null), 'answers are not an object');
});

test('--out must be new or empty so no earlier run is read', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'route-eval-out-'));
  try {
    assert.doesNotThrow(() => assertFreshOutDir(path.join(root, 'new')));
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    assert.doesNotThrow(() => assertFreshOutDir(empty));
    const used = path.join(root, 'used');
    mkdirSync(path.join(used, 'catalog', 'profiles'), { recursive: true });
    writeFileSync(path.join(used, 'catalog', 'profiles', 'bl.json'), '{}');
    assert.throws(() => assertFreshOutDir(used), /is not empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pass needs >= 20 correct, >= 5 families and no illegal pick', () => {
  assert.deepEqual(PASS, { correct: 20, families: 5, illegal: 0 });
  assert.equal(MODE, 'profiler-proxy', 'the eval says it is a proxy of the production router');
  const families = ['fervor', 'watson', 'maren', 'listings', 'publication'];
  const items = Array.from({ length: 25 }, (_, index) => ({ id: `i${index}`, acceptableFamilies: [families[index % 5]!], illegalFamilies: ['emmpo'] }));
  const picks = Object.fromEntries(items.map((item, index) => [item.id, index < 20 ? item.acceptableFamilies[0]! : null]));
  assert.equal(scoreRoutes({ items }, answersFor(items.map((item) => item.id)), routeTo(picks)).passed, true);
  const nineteen = { ...picks, i0: null };
  assert.equal(scoreRoutes({ items }, answersFor(items.map((item) => item.id)), routeTo(nineteen)).passed, false);
  const withIllegal = { ...picks, i24: 'emmpo' };
  assert.equal(scoreRoutes({ items }, answersFor(items.map((item) => item.id)), routeTo(withIllegal)).passed, false);
});

test('a saved profile becomes resolveRoute answers, with every archetype answer it kept', () => {
  const judgment = (choice: string) => ({ choice, confidence: 1, probabilities: { [choice]: 1 } });
  const profile = { route: { spine: judgment('TL'), skin: judgment('Editorial'), family: judgment('watson'), archetype: judgment('TL.05'), archetypes: { TL: judgment('TL.05'), CS: judgment('CS.01') } } };
  const answers = answersFromProfile(profile);
  assert.deepEqual(Object.keys(answers).sort(), ['archetype_CS', 'archetype_TL', 'family', 'skin', 'spine']);
  assert.equal(answers.spine.type, 'choice');
  const legacy = answersFromProfile({ route: { ...profile.route, archetypes: undefined } });
  assert.deepEqual(Object.keys(legacy).sort(), ['archetype_TL', 'family', 'skin', 'spine'], 'an older profile falls back to the top spine');
});
