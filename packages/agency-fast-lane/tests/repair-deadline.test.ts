/**
 * The fill-and-repair phase's failure handling:
 *
 * - a faithfulness repair swallows only a spent technical budget (`UnitRefusedError`); a provider
 *   or transport failure, and anything unexpected, fails the run and still names its unit;
 * - `repaired` counts every path any round flagged and the final check cleared;
 * - the standing faithfulness rule is stated once per repair message, never stacked;
 * - a model that never answers is cut off by the per-call limit or the build deadline, and the
 *   run fails with `UnitDeadlineError` naming the unit;
 * - an illustrative sample-data (`x-mock`) slot left empty is not a refusal: the prompt names it in
 *   a SAMPLE block, and an empty answer keeps the spine's sample under the fixed caption, so a
 *   brief with no prices or metrics still builds (run-2 marketing-site / crm-dashboard regression).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { ModelCall } from '../src/deepseek.ts';
import { loadFamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import { FAITHFULNESS_RULE, failedUnitOf, runFastLane, UnitDeadlineError } from '../src/run.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, fillTemplate, loadTestSite, promptBlock } from './fixtures.ts';

const pkg = await loadTestSite();
const ENTRY = 'ownedsite-r1.html';
const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';
const EXAMPLES = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');

class FakeTransportError extends Error {
  constructor() {
    super('socket hang up');
    this.name = 'FakeTransportError';
  }
}

const plainFill = (key: string, _value: string, at: string, limit?: number) => {
  if (at.endsWith('text.statement')) return 'FABRICATED phone 555-0100';
  return typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`;
};

test('a transport failure during a faithfulness repair fails the run and names the unit', async () => {
  const inner = fakeModel({ fill: plainFill });
  const model: ModelCall = async (request) => {
    if (request.user.includes('states a fact the brief does not contain')) throw new FakeTransportError();
    return inner(request);
  };
  const failure = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify: fakeJevChecker() }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof FakeTransportError, 'the provider error propagates with its own class');
  assert.equal(failedUnitOf(failure), 'ownedsite-hero');
});

test('an unexpected error during a faithfulness repair is not swallowed', async () => {
  const inner = fakeModel({ fill: plainFill });
  const model: ModelCall = async (request) => {
    if (request.user.includes('states a fact the brief does not contain')) throw new TypeError('unexpected');
    return inner(request);
  };
  await assert.rejects(runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify: fakeJevChecker() }), TypeError);
});

test('a spent technical budget during a faithfulness repair is still advisory', async () => {
  let statementCalls = 0;
  const model = fakeModel({
    fill: (key, value, at, limit) => {
      if (at.endsWith('text.statement')) {
        statementCalls += 1;
        return statementCalls === 1 ? 'FABRICATED phone 555-0100' : 'FABRICATED <b>call now</b>';
      }
      return plainFill(key, value, at, limit);
    },
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify: fakeJevChecker() });
  assert.deepEqual(report.verify!.remaining, ['sections[2].text.statement']);
  // The standing rule is in every repair message exactly once, however many attempts stack up.
  const repairs = model.prompts.filter((prompt) => prompt.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n'));
  assert.ok(repairs.length >= 2);
  for (const prompt of repairs) {
    const error = prompt.slice(prompt.indexOf('\nVALIDATION ERROR\n'));
    const count = error.split(FAITHFULNESS_RULE).length - 1;
    assert.ok(count <= 1, `the rule appears ${count} times in one repair message`);
  }
});

test('repaired counts a path first flagged in a later round and cleared by the last check', async () => {
  // Check 1 flags the statement; check 2 (after round 1) flags a different slot; check 3 is clean.
  const rounds: Array<(slots: FaithfulnessSlot[]) => string[]> = [
    (slots) => slots.filter((slot) => slot.path.endsWith('text.statement')).map((slot) => slot.path),
    (slots) => slots.filter((slot) => slot.path === 'sections[2].text.eyebrow').map((slot) => slot.path),
    () => [],
  ];
  let call = 0;
  const verify: FaithfulnessChecker = {
    async checkFaithfulness({ slots }) {
      const flagged = (rounds[Math.min(call, rounds.length - 1)]!)(slots).map((slotPath) => ({ path: slotPath, probability: 0.9 }));
      call += 1;
      return { flagged, ms: 1, calls: 1 };
    },
  };
  const model = fakeModel({ fill: (key, _value, _at, limit) => (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`) });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });
  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement', 'sections[2].text.eyebrow']);
  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(report.verify!.repaired, 2, 'the round-2 path counts as repaired too');
});

/** A model that answers only when its signal aborts, by rejecting with the platform abort error. */
const neverAnswers: ModelCall = (request) => new Promise((_resolve, reject) => {
  const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (request.signal?.aborted) abort();
  request.signal?.addEventListener('abort', abort, { once: true });
});

test('a model call that never answers is cut off by its own time limit and names the unit', async () => {
  const started = Date.now();
  const failure = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: neverAnswers, modelName: 'fake', callTimeoutMs: 40, deadlineMs: 10_000 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof UnitDeadlineError, `expected UnitDeadlineError, got ${String(failure)}`);
  assert.equal(failure.scope, 'call');
  assert.ok(failure.unit.length > 0);
  assert.equal(failedUnitOf(failure), failure.unit);
  assert.ok(Date.now() - started < 5_000, 'fails fast, not at a transport timeout');
});

test('the build deadline cuts off the fill even when each call is within its own limit', async () => {
  const failure = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model: neverAnswers, modelName: 'fake', callTimeoutMs: 10_000, deadlineMs: 40 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof UnitDeadlineError);
  assert.equal(failure.scope, 'build');
  assert.equal(failure.unit, 'page');
});

test('a caller cancellation stays a cancellation, not a deadline', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const failure = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model: neverAnswers, modelName: 'fake', signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(failure instanceof UnitDeadlineError, false);
});

/** The SAMPLE block of a fill prompt, when it has one. */
function sampleBlock(prompt: string): Json | undefined {
  const start = prompt.indexOf('\nSAMPLE\n');
  if (start < 0) return undefined;
  const body = prompt.slice(start + '\nSAMPLE\n'.length);
  return JSON.parse(body.slice(0, body.indexOf('\n\n'))) as Json;
}

/** `answer` with '' wherever `sample` marks a slot: a model that refuses to invent sample values. */
function emptyWhereSample(answer: Json, sample: Json | undefined): Json {
  if (typeof sample === 'string') return '';
  if (Array.isArray(answer) && Array.isArray(sample)) return answer.map((item, index) => emptyWhereSample(item, sample[index]));
  if (isObject(answer) && isObject(sample)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(answer)) out[key] = emptyWhereSample(value, sample[key]);
    return out;
  }
  return answer;
}

for (const [family, captionExport] of [['marketing-site', 'ILLUSTRATIVE_PRICING_CAPTION'], ['crm-dashboard', 'SAMPLE_DATA_CAPTION']] as const) {
  test(`${family}: a brief with no prices or metrics builds, and the sample section keeps its fixed caption`, async () => {
    const familyPkg = await loadFamilyPackage(path.join(EXAMPLES, `agency-${family}`), family);
    const slots = await import(path.join(EXAMPLES, `agency-${family}`, 'compiler/scripts/families', family, 'slots.ts')) as Record<string, string>;
    const caption = slots[captionExport]!;
    const prompts: string[] = [];
    // Every text slot gets a short plain answer that fits any limit, every SAMPLE slot comes back
    // empty — the run-2 failure mode ("required text came back empty").
    const model: ModelCall = async ({ user }) => {
      prompts.push(user);
      const template = promptBlock(user, 'TEMPLATE');
      const filled = fillTemplate(template, promptBlock(user, 'LIMITS'), (key, value, _at, limit) => {
        if (key === 'id') return value;
        return typeof limit === 'number' ? 'Riverbend'.slice(0, Math.max(1, Math.min(limit, 9))) : value;
      });
      const text = JSON.stringify(emptyWhereSample(filled, sampleBlock(user)));
      return { text, ms: 1, retries: 0 };
    };
    const report = await runFastLane({ pkg: familyPkg, brief: 'Riverbend Dental, a family dental practice in Boise.', mode: 'sections', entry: `${family}-r1.html`, revision: 1, model, modelName: 'fake' });
    assert.ok(prompts.some((prompt) => sampleBlock(prompt) !== undefined), 'the prompt names the sample slots');
    assert.ok(prompts.some((prompt) => prompt.includes('Never return null or an empty string for a SAMPLE value.')));
    assert.ok(report.html.includes(caption), `the fixed caption "${caption}" is on the page`);
    assert.equal(report.missing.length, 0, 'an empty sample slot is not reported missing');
  });
}
