/**
 * The design profile: request shape (`buildProfileQuestions`, against the real checked-in atlas,
 * registry, and taxonomy), the pure resolution (`resolveProfile`, reusing the router's own
 * `resolveRoute` policy), and `createJevProfiler`'s fetch/auth/error/splitting behavior (fake
 * fetch, as in `tests/route.test.ts` and `tests/jev.test.ts`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadAtlasData } from './routing-fixture.ts';
import {
  createJevProfiler,
  ProfileError,
  resolveProfile,
  type ProfileAnswer,
  type ScoreAnswer,
} from '../src/profile.ts';
import { buildProfileQuestions } from '../src/profile-questions.ts';
import { DEFAULT_MIN_TRANSFER } from '../src/route.ts';
import { loadDesignTaxonomy } from '../src/taxonomy.ts';
import type { JsonObject } from '../src/spine.ts';

const { atlas, registry } = await loadAtlasData();
const taxonomy = await loadDesignTaxonomy();

type Captured = { url: string; method: string; headers: Record<string, string>; body: JsonObject };

function fakeFetch(captured: Captured[], respond: (body: JsonObject) => JsonObject): typeof fetch {
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as typeof fetch;
}

/** Answers every question type plausibly: the first criteria option for Choice, a low probability
 * for Noul, and level 2 for Score — enough for `resolveRoute`'s policy and the profile shapes to
 * resolve deterministically without hand-crafting all ~105 answers per test. */
function fakeAnswerAll(body: JsonObject): JsonObject {
  const questions = body.questions as Record<string, JsonObject>;
  const answers: Record<string, JsonObject> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const criteria = question.criteria as Record<string, string>;
      const keys = Object.keys(criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((key, index) => (probabilities[key] = index === 0 ? 1 : 0));
      answers[id] = { type: 'choice', choice: keys[0], confidence: 1, probabilities };
    } else if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: 0.1 };
    } else if (question.type === 'score') {
      const levels = question.criteria as string[];
      const probabilities: Record<string, number> = {};
      const legend: Record<string, string> = {};
      levels.forEach((text, index) => {
        probabilities[String(index)] = index === 2 ? 1 : 0;
        legend[String(index)] = text;
      });
      answers[id] = { type: 'score', score: 2, probabilities, legend, confidence: 0.8 };
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } };
}

// ---------------------------------------------------------------------------
// buildProfileQuestions: request shape
// ---------------------------------------------------------------------------

test('buildProfileQuestions: one question per route/section/component/mechanic/depth/style/quality label, plus truth-risk', () => {
  const questions = buildProfileQuestions(atlas, registry, taxonomy);
  const expectedCount =
    1 /* spine */ +
    atlas.spines.length /* archetype_<CODE> */ +
    1 /* family */ +
    1 /* skin */ +
    1 /* format */ +
    1 /* action */ +
    taxonomy.sections.length +
    taxonomy.components.length +
    taxonomy.mechanics.length +
    taxonomy.depth.length +
    6 /* style axes */ +
    taxonomy.quality.length +
    1 /* truth-risk */;
  assert.equal(Object.keys(questions).length, expectedCount);

  assert.equal(questions.spine!.type, 'choice');
  for (const spine of atlas.spines) assert.ok(`archetype_${spine.code}` in questions, `archetype_${spine.code} present`);
  assert.equal(questions.family!.type, 'choice');
  assert.equal(questions.skin!.type, 'choice');
  assert.equal(questions.format!.type, 'choice');
  assert.equal(questions.action!.type, 'choice');

  for (const label of taxonomy.sections) assert.equal(questions[`section_${label.id}`]!.type, 'noul', `section_${label.id} is noul`);
  for (const label of taxonomy.components) assert.equal(questions[`component_${label.id}`]!.type, 'noul', `component_${label.id} is noul`);
  for (const label of taxonomy.mechanics) assert.equal(questions[`mechanic_${label.id}`]!.type, 'noul', `mechanic_${label.id} is noul`);
  for (const label of taxonomy.depth) assert.equal(questions[`depth_${label.id}`]!.type, 'noul', `depth_${label.id} is noul`);

  for (const axis of ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const) {
    assert.equal(questions[`style_${axis}`]!.type, 'choice', `style_${axis} is choice`);
  }
  for (const dim of taxonomy.quality) assert.equal(questions[`quality_${dim.id}`]!.type, 'score', `quality_${dim.id} is score`);
  assert.equal(questions.truth_risk!.type, 'noul');
});

test('buildProfileQuestions: a custom minTransfer changes the family question — must agree with the resolveRoute(..., { minTransfer }) call resolveProfile makes for the same profile', () => {
  const permissive = buildProfileQuestions(atlas, registry, taxonomy, 1).family as { criteria: Record<string, string> };
  const strict = buildProfileQuestions(atlas, registry, taxonomy, 3).family as { criteria: Record<string, string> };
  const defaulted = buildProfileQuestions(atlas, registry, taxonomy).family as { criteria: Record<string, string> };
  const atDefault = buildProfileQuestions(atlas, registry, taxonomy, DEFAULT_MIN_TRANSFER).family as { criteria: Record<string, string> };
  assert.deepEqual(defaulted, atDefault, 'omitting minTransfer must build the same family question as passing DEFAULT_MIN_TRANSFER explicitly');
  assert.notEqual(permissive.criteria.ownedcinematic, strict.criteria.ownedcinematic, 'a permissive and a strict minTransfer must produce different legal-spine lists for ownedcinematic');
});

test('buildProfileQuestions: label definitions are used verbatim as criteria', () => {
  const questions = buildProfileQuestions(atlas, registry, taxonomy);
  const heroDef = taxonomy.sections.find((s) => s.id === 'hero')!.definition;
  assert.equal(questions.section_hero!.type, 'noul');
  const heroQuestion = questions.section_hero as { criteria?: { true: string; false: string } };
  assert.equal(heroQuestion.criteria?.true, heroDef);

  const groundQuestion = questions.style_ground as { type: 'choice'; criteria: Record<string, string> };
  for (const option of taxonomy.style.ground) assert.equal(groundQuestion.criteria[option.id], option.definition);
  assert.ok('unspecified' in groundQuestion.criteria, 'style axes get an unspecified option added at build time');

  const qualityQuestion = questions['quality_focal-discipline'];
  assert.ok(qualityQuestion, 'quality_focal-discipline question exists');
  assert.deepEqual((qualityQuestion as { criteria: string[] }).criteria, taxonomy.quality.find((d) => d.id === 'focal-discipline')!.levels);
});

test('buildProfileQuestions: style, format, and skin criteria stay data-driven from the atlas/taxonomy, not hardcoded', () => {
  const questions = buildProfileQuestions(atlas, registry, taxonomy);
  const formatQuestion = questions.format as { type: 'choice'; criteria: Record<string, string> };
  for (const format of atlas.formats) assert.equal(formatQuestion.criteria[format.name], format.summary);
  assert.ok('unspecified' in formatQuestion.criteria);

  const skinQuestion = questions.skin as { type: 'choice'; criteria: Record<string, string> };
  for (const skin of atlas.skins) assert.ok(skin in skinQuestion.criteria);
  assert.ok('unspecified' in skinQuestion.criteria);

  const actionQuestion = questions.action as { type: 'choice'; criteria: Record<string, string> };
  for (const action of taxonomy.action) assert.equal(actionQuestion.criteria[action.id], action.definition);
});

// ---------------------------------------------------------------------------
// createJevProfiler: request shape, auth, splitting, errors
// ---------------------------------------------------------------------------

test('createJevProfiler: request shape — endpoint, model, Authorization header, state is {text} for a prompt', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'test-key', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  await profiler.profile({
    text: 'A dentist office landing page.',
    atlas,
    registry,
    taxonomy,
    source: { kind: 'prompt', id: 'dentist-01' },
  });

  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body.model, 'jev-1.13.0');
  assert.deepEqual(request.body.state, { text: 'A dentist office landing page.' });
});

test('createJevProfiler: the request carries the family question built from the caller\'s own minTransfer, not always the default', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'test-key', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  await profiler.profile({
    text: 'A dentist office landing page.',
    atlas,
    registry,
    taxonomy,
    minTransfer: 1,
    source: { kind: 'prompt', id: 'dentist-01' },
  });
  const sentFamily = (captured[0]!.body.questions as JsonObject).family as { criteria: Record<string, string> };
  const expected = (buildProfileQuestions(atlas, registry, taxonomy, 1).family as { criteria: Record<string, string> }).criteria.ownedcinematic;
  assert.equal(sentFamily.criteria.ownedcinematic, expected, 'createJevProfiler must thread its own minTransfer into buildProfileQuestions, not silently use the default');
});

test('createJevProfiler: state carries {text, facts} when facts are given (an HTML input)', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  const facts = { title: 'Riverbend Dental', headings: ['Gentle care'], counts: { video: 0 } };
  await profiler.profile({
    text: 'Gentle care',
    facts,
    atlas,
    registry,
    taxonomy,
    source: { kind: 'html', ref: 'upload.html' },
  });
  assert.deepEqual(captured[0]!.body.state, { text: 'Gentle care', facts });
});

test('createJevProfiler: a resolved apiKey function is called and cached across calls', async () => {
  let calls = 0;
  const captured: Captured[] = [];
  const profiler = createJevProfiler({
    apiKey: async () => {
      calls += 1;
      return 'lazy-key';
    },
    fetchImpl: fakeFetch(captured, fakeAnswerAll),
  });
  await profiler.profile({ text: 'a', atlas, registry, taxonomy, source: { kind: 'prompt' } });
  await profiler.profile({ text: 'b', atlas, registry, taxonomy, source: { kind: 'prompt' } });
  assert.equal(calls, 1);
});

test('createJevProfiler: a non-2xx response throws ProfileError with the status only — never the body', async () => {
  const fetchImpl = (async () => new Response('bad request', { status: 422 })) as typeof fetch;
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    profiler.profile({ text: 'a', atlas, registry, taxonomy, source: { kind: 'prompt' } }),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.message, 'jev 422');
      assert.equal(error.status, 422);
      return true;
    },
  );
});

test('createJevProfiler: a 422 whose body echoes the request (e.g. licence-restricted state.text) never leaks that body into the thrown message', async () => {
  const sentinel = 'SENTINEL-LICENCE-RESTRICTED-ORIGINAL-TEXT-ABC123';
  const fetchImpl = (async (_input, init) => {
    // A real Jev 4xx can echo request content back in its error body; simulate that by echoing
    // the caller's own state.text (which carries `sentinel` below) into the response body.
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    const state = body.state as JsonObject;
    return new Response(`bad request: ${JSON.stringify(state)}`, { status: 422 });
  }) as typeof fetch;
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    profiler.profile({ text: sentinel, atlas, registry, taxonomy, source: { kind: 'prompt', id: 'catalog-entry' } }),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.ok(!error.message.includes(sentinel), `thrown message must not contain the sentinel: ${error.message}`);
      assert.equal(error.message, 'jev 422');
      return true;
    },
  );
});

test('createJevProfiler: a network failure throws, since profiling fails closed like routing', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch failed');
  }) as typeof fetch;
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    profiler.profile({ text: 'a', atlas, registry, taxonomy, source: { kind: 'prompt' } }),
    /fetch failed/,
  );
});

test('createJevProfiler: a very large input splits into two requests, with answers merged from both', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  // ~230,000 chars (~57,500 estimated tokens) comfortably exceeds the 56,000-token request
  // ceiling once the ~105 fixed questions' own criteria text is added on top.
  const hugeText = 'x'.repeat(230_000);
  const profile = await profiler.profile({ text: hugeText, atlas, registry, taxonomy, source: { kind: 'prompt' } });

  assert.equal(captured.length, 2, 'splits into exactly two requests');
  assert.equal(profile.calls, 2);
  const totalQuestionsSent = captured.reduce((sum, request) => sum + Object.keys(request.body.questions as JsonObject).length, 0);
  const expectedCount = Object.keys(buildProfileQuestions(atlas, registry, taxonomy)).length;
  assert.equal(totalQuestionsSent, expectedCount, 'every question is asked exactly once across both requests');
  // both requests carry the full state (text repeated, not split)
  for (const request of captured) assert.equal((request.body.state as JsonObject).text, hugeText);
  // usage is summed across both calls
  assert.deepEqual(profile.usage, { input_tokens: 200, output_tokens: 20 });
  // the merged answers resolved into a complete profile (sections has every taxonomy id)
  assert.equal(Object.keys(profile.sections).length, taxonomy.sections.length);
});

test('createJevProfiler: source chars and digest are computed from the input text (sha256, never the text itself)', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  const text = 'A short prompt body.';
  const profile = await profiler.profile({ text, atlas, registry, taxonomy, source: { kind: 'prompt', id: 'p1', title: 'Prompt One' } });
  assert.equal(profile.source.chars, text.length);
  assert.equal(profile.source.digest, createHash('sha256').update(text).digest('hex'));
  assert.equal(profile.source.id, 'p1');
  assert.equal(profile.source.title, 'Prompt One');
  assert.equal(profile.source.kind, 'prompt');
  assert.equal(profile.schema, 'design-profile/1');
  assert.equal(profile.taxonomy, taxonomy.version);
  assert.equal(profile.model, 'jev-1.13.0');
  assert.equal(typeof profile.ms, 'number');
  assert.equal(typeof profile.at, 'string');
});

test('createJevProfiler: meta is carried through unchanged when given', async () => {
  const captured: Captured[] = [];
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl: fakeFetch(captured, fakeAnswerAll) });
  const profile = await profiler.profile({
    text: 'a',
    atlas,
    registry,
    taxonomy,
    source: { kind: 'prompt' },
    meta: { total_likes: 305, use_case: 'marketing-site' },
  });
  assert.deepEqual(profile.meta, { total_likes: 305, use_case: 'marketing-site' });
});

// ---------------------------------------------------------------------------
// resolveProfile: pure resolution, Noul/Choice/Score shapes, route.resolved
// ---------------------------------------------------------------------------

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence = 1): ProfileAnswer {
  return { type: 'choice', choice, confidence, probabilities };
}
function noulAnswer(noul: number): ProfileAnswer {
  return { type: 'noul', noul };
}
function scoreAnswer(score: number, levels: string[], confidence = 0.9): ScoreAnswer {
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  levels.forEach((text, index) => {
    probabilities[String(index)] = index === Math.round(score) ? 1 : 0;
    legend[String(index)] = text;
  });
  return { type: 'score', score, probabilities, legend, confidence };
}

function buildFullAnswers(overrides: Record<string, ProfileAnswer> = {}): Record<string, ProfileAnswer> {
  const questions = buildProfileQuestions(atlas, registry, taxonomy);
  const answers: Record<string, ProfileAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((key, index) => (probabilities[key] = index === 0 ? 1 : 0));
      answers[id] = choiceAnswer(keys[0]!, probabilities);
    } else if (question.type === 'noul') {
      answers[id] = noulAnswer(0.1);
    } else if (question.type === 'score') {
      answers[id] = scoreAnswer(2, question.criteria);
    }
  }
  return { ...answers, ...overrides };
}

test('resolveProfile: sections/components/mechanics/depth become Record<id, number> from the Noul answers', () => {
  const answers = buildFullAnswers({ section_pricing: noulAnswer(0.93) });
  const source = { kind: 'prompt' as const, chars: 10, digest: 'x' };
  const profile = resolveProfile(answers, atlas, registry, taxonomy, source);
  assert.equal(profile.sections.pricing, 0.93);
  assert.equal(Object.keys(profile.sections).length, taxonomy.sections.length);
  assert.equal(Object.keys(profile.components).length, taxonomy.components.length);
  assert.equal(Object.keys(profile.mechanics).length, taxonomy.mechanics.length);
  assert.equal(Object.keys(profile.depth).length, taxonomy.depth.length);
});

test('resolveProfile: style axes become Judgment (choice/confidence/probabilities), quality dims become {score, legend, confidence}', () => {
  const answers = buildFullAnswers();
  const source = { kind: 'prompt' as const, chars: 10, digest: 'x' };
  const profile = resolveProfile(answers, atlas, registry, taxonomy, source);
  for (const axis of ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const) {
    const judgment = profile.style[axis];
    assert.equal(typeof judgment.choice, 'string');
    assert.equal(typeof judgment.confidence, 'number');
    assert.equal(typeof judgment.probabilities, 'object');
  }
  for (const dim of taxonomy.quality) {
    const q = profile.quality[dim.id]!;
    assert.equal(q.score, 2);
    assert.equal(q.legend, dim.levels[2]);
    assert.equal(q.confidence, 0.9);
  }
  assert.equal(profile.truthRisk, 0.1);
});

test('resolveProfile: route.resolved reuses resolveRoute\'s exact-archetype policy — same scenario as route.test.ts', () => {
  const answers = buildFullAnswers({
    spine: choiceAnswer('BA', { BA: 1 }),
    archetype_BA: choiceAnswer('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choiceAnswer('ownedinstitution', { ownedinstitution: 0.8, ownededitorial: 0.1, ownedcinematic: 0.02, ownedcontractor: 0.02, ownedsite: 0.02, ownedmaker: 0.02, ownedlearning: 0.02, none: 0 }),
    skin: choiceAnswer('unspecified', { unspecified: 1 }),
  });
  const source = { kind: 'prompt' as const, chars: 10, digest: 'x' };
  const profile = resolveProfile(answers, atlas, registry, taxonomy, source);
  assert.equal(profile.route.resolved.familyId, 'ownedinstitution');
  assert.equal(profile.route.resolved.archetypeId, 'BA.03');
  assert.equal(profile.route.resolved.basis, 'exact');
  assert.equal(profile.route.spine.choice, 'BA');
  assert.equal(profile.route.archetype?.choice, 'BA.03');
  assert.equal(profile.route.family.choice, 'ownedinstitution');
});

test('resolveProfile: route.archetypes keeps every archetype answer, runner-up spines included', () => {
  const answers = buildFullAnswers({
    spine: choiceAnswer('BA', { BA: 0.7, TL: 0.3 }),
    archetype_BA: choiceAnswer('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    archetype_TL: choiceAnswer('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0.9, 'TL.06': 0.1, none: 0 }),
    family: choiceAnswer('ownedinstitution', { ownedinstitution: 0.8, ownededitorial: 0.1, ownedcinematic: 0.02, ownedcontractor: 0.02, ownedsite: 0.02, ownedmaker: 0.02, ownedlearning: 0.02, none: 0 }),
    skin: choiceAnswer('unspecified', { unspecified: 1 }),
  });
  const profile = resolveProfile(answers, atlas, registry, taxonomy, { kind: 'prompt' as const, chars: 10, digest: 'x' });
  assert.equal(profile.route.archetype?.choice, 'BA.03', 'archetype stays the top spine\'s answer');
  assert.deepEqual(Object.keys(profile.route.archetypes ?? {}).sort(), atlas.spines.map((spine) => spine.code).sort(), 'one per spine asked');
  assert.equal(profile.route.archetypes?.TL?.choice, 'TL.05');
  assert.equal(profile.route.archetypes?.TL?.probabilities['TL.05'], 0.9);
});

test('resolveProfile: spine none leaves route.resolved empty, mirroring resolveRoute\'s unrouted path', () => {
  const answers = buildFullAnswers({
    spine: choiceAnswer('none', { none: 1 }),
    family: choiceAnswer('none', { none: 1 }),
    skin: choiceAnswer('unspecified', { unspecified: 1 }),
  });
  const source = { kind: 'prompt' as const, chars: 10, digest: 'x' };
  const profile = resolveProfile(answers, atlas, registry, taxonomy, source);
  assert.equal(profile.route.resolved.familyId, undefined);
  assert.equal(profile.route.resolved.archetypeId, undefined);
  assert.equal(profile.route.archetype, undefined);
});

test('resolveProfile: meta is passed through when given, absent when not', () => {
  const answers = buildFullAnswers();
  const source = { kind: 'prompt' as const, chars: 10, digest: 'x' };
  const withMeta = resolveProfile(answers, atlas, registry, taxonomy, source, {}, { total_likes: 42 });
  assert.deepEqual(withMeta.meta, { total_likes: 42 });
  const withoutMeta = resolveProfile(answers, atlas, registry, taxonomy, source);
  assert.equal(withoutMeta.meta, undefined);
});

// ---------------------------------------------------------------------------
// resolveProfile: answer validation — every malformed or missing answer throws ProfileError,
// fail closed, instead of silently producing a garbage field (NaN, undefined, an unoffered
// choice). Mirrors route.ts's validateChoiceAnswer checks, extended to Noul and Score.
// ---------------------------------------------------------------------------

const SOURCE = { kind: 'prompt' as const, chars: 10, digest: 'x' };

function rejectsMalformed(answers: Record<string, ProfileAnswer>, idPattern: RegExp, reasonPattern: RegExp): void {
  assert.throws(
    () => resolveProfile(answers, atlas, registry, taxonomy, SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError, 'throws ProfileError');
      assert.match(error.message, idPattern, `message names the malformed answer id: ${error.message}`);
      assert.match(error.message, reasonPattern, `message states the reason: ${error.message}`);
      return true;
    },
  );
}

test('resolveProfile: a Score answer with a non-numeric score (the reported repro) throws instead of producing NaN/undefined', () => {
  const dimension = taxonomy.quality[0]!;
  const answers = buildFullAnswers({
    [`quality_${dimension.id}`]: { type: 'score', score: undefined as unknown as number, probabilities: {}, legend: {}, confidence: 1 },
  });
  rejectsMalformed(answers, new RegExp(`quality_${dimension.id}`), /score is not a finite number/);
});

test('resolveProfile: a Score answer whose score is out of the level range throws', () => {
  const dimension = taxonomy.quality[0]!;
  const answers = buildFullAnswers({
    [`quality_${dimension.id}`]: scoreAnswer(99, dimension.levels),
  });
  rejectsMalformed(answers, new RegExp(`quality_${dimension.id}`), /score is not a finite number within/);
});

test('resolveProfile: a Score answer whose legend at the answered level is not one of the question\'s own levels throws', () => {
  const dimension = taxonomy.quality[0]!;
  const bad = scoreAnswer(2, dimension.levels);
  bad.legend['2'] = 'not one of the offered level descriptions';
  const answers = buildFullAnswers({ [`quality_${dimension.id}`]: bad });
  rejectsMalformed(answers, new RegExp(`quality_${dimension.id}`), /legend\.2 is not one of/);
});

test('resolveProfile: a Score answer with a confidence outside [0, 1] throws', () => {
  const dimension = taxonomy.quality[0]!;
  const bad = scoreAnswer(2, dimension.levels, 1.5);
  const answers = buildFullAnswers({ [`quality_${dimension.id}`]: bad });
  rejectsMalformed(answers, new RegExp(`quality_${dimension.id}`), /confidence is not a finite number/);
});

test('resolveProfile: a Noul answer with a non-numeric noul throws instead of being stored verbatim', () => {
  const answers = buildFullAnswers({ section_hero: { type: 'noul', noul: 'high' as unknown as number } });
  rejectsMalformed(answers, /section_hero/, /noul is not a finite number/);
});

test('resolveProfile: a Noul answer with noul outside [0, 1] throws', () => {
  const answers = buildFullAnswers({ truth_risk: noulAnswer(1.2) });
  rejectsMalformed(answers, /truth_risk/, /noul is not a finite number/);
});

test('resolveProfile: a Choice answer whose choice is not one of the offered options throws instead of being trusted', () => {
  const answers = buildFullAnswers({ skin: choiceAnswer('Not A Real Skin', { 'Not A Real Skin': 1 }) });
  rejectsMalformed(answers, /^malformed answer skin/, /choice is not one of the offered options/);
});

test('resolveProfile: a Choice answer with a probability outside [0, 1] throws', () => {
  const answers = buildFullAnswers({ family: choiceAnswer('ownedsite', { ownedsite: 1.5 }) });
  rejectsMalformed(answers, /family/, /probabilities\.ownedsite is not a finite number/);
});

test('resolveProfile: a missing answer (key absent entirely) throws, naming the missing id', () => {
  const answers = buildFullAnswers();
  delete answers.truth_risk;
  rejectsMalformed(answers, /truth_risk/, /missing or not an object/);
});

test('resolveProfile: a malformed answer of the wrong primitive type (choice payload under a noul question) throws', () => {
  const answers = buildFullAnswers({ truth_risk: { type: 'choice', choice: 'x', confidence: 1, probabilities: { x: 1 } } as unknown as ProfileAnswer });
  rejectsMalformed(answers, /truth_risk/, /type is not "noul"/);
});
