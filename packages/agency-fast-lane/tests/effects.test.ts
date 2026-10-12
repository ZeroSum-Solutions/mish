/**
 * `src/effects.ts`: the Jev effect questions, answer resolution, every guard, every Jev failure
 * code, hint precedence, the compiler-report merge, the composed-page budget and the family
 * placement response. The run wiring is `effects-run.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEffectFlags } from '../src/cli-args.ts';
import {
  buildEffectQuestions,
  createJevEffectJudge,
  decideEffects,
  effectQuestionKey,
  familyEffectsResponse,
  mergeEffectsResult,
  PAGE_BYTE_LIMIT,
  PageTooLargeError,
  renderWithEffects,
  resolveEffectChoices,
  skinEffectCap,
  type EffectCatalog,
  type EffectJudge,
  type EffectPick,
  type EffectPlan,
  type FamilyEffectDeclaration,
} from '../src/effects.ts';
import type { RenderResult } from '../src/family.ts';

const CATALOG: EffectCatalog = {
  components: [
    { id: 'shiny-text', name: 'Shiny Text', category: 'text', kind: 'css-only', source: { description: 'A light sweep across text. Props: speed, colour' }, bytes: { js: 900, css: 700 } },
    { id: 'blur-text', name: 'Blur Text', category: 'text', kind: 'js', source: { description: 'Words blur into focus.' }, bytes: { js: 2000, css: 400 } },
    { id: 'glass-surface', name: 'Glass Surface', category: 'surface', kind: 'css-only', source: { description: 'Frosted glass panel.' }, bytes: { js: 0, css: 1200 } },
    { id: 'silk', name: 'Silk', category: 'background', kind: 'js', source: { description: 'Flowing silk background.' }, bytes: { js: 5000, css: 300 } },
    { id: 'soft-aurora', name: 'Soft Aurora', category: 'background', kind: 'css-only', source: { description: 'Slow aurora gradient.' }, bytes: { js: 0, css: 900 } },
    { id: 'fade-content', name: 'Fade Content', category: 'scroll', kind: 'css-only', source: { description: 'Sections fade in.' }, bytes: { js: 0, css: 300 } },
  ],
};

const DECLARATION: FamilyEffectDeclaration = {
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: {
    'hero-title': { host: { id: 'hero-heading' }, allow: ['shiny-text', 'blur-text'] },
    'hero-background': { host: { odId: 'hero' }, allow: ['silk', 'soft-aurora'] },
    'card-surface': { host: { id: 'services' }, allow: ['glass-surface'] },
    'section-reveal': { host: { id: 'main' }, allow: ['fade-content'] },
  },
};

const BRIEF = 'Lumen, a lighting studio in Oslo. Bold, atmospheric, after-dark installations.';

/** A judge that answers with fixed picks and records what it was asked. */
function fixedJudge(picks: EffectPick[], extra: Partial<Awaited<ReturnType<EffectJudge['judge']>>> = {}): EffectJudge & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    judge: async ({ placements }) => {
      asked.push([...placements]);
      return { picks: picks.filter((pick) => placements.includes(pick.placement)), skipped: [], ms: 3, calls: 1, ...extra };
    },
  };
}

const answer = (choice: string, confidence: number) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });

// ---------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------

test('buildEffectQuestions: one choice question per declared placement, allowed ids plus none, described from the catalog', () => {
  const { state, questions, asked } = buildEffectQuestions(BRIEF, 'Cinematic and immersive', DECLARATION, CATALOG);
  assert.equal(state.brief, BRIEF);
  assert.match(state.skin, /^Cinematic and immersive: /);
  assert.deepEqual(asked.map((item) => item.placement), ['hero-background', 'hero-title', 'card-surface', 'section-reveal']);
  const title = questions[effectQuestionKey('hero-title')]!;
  assert.equal(title.type, 'choice');
  assert.deepEqual(Object.keys(title.criteria), ['shiny-text', 'blur-text', 'none']);
  assert.equal(title.criteria['shiny-text'], 'Shiny Text: A light sweep across text. (CSS only).');
  assert.equal(title.criteria['blur-text'], 'Blur Text: Words blur into focus. (script).');
  assert.deepEqual(asked.find((item) => item.placement === 'hero-title')!.options, ['shiny-text', 'blur-text', 'none']);
});

test('buildEffectQuestions: only the given placements, js ids dropped on a none script policy, undescribed ids not offered', () => {
  const declaration: FamilyEffectDeclaration = { ...DECLARATION, scriptPolicy: 'none', placements: { ...DECLARATION.placements, cta: { host: { id: 'contact' }, allow: ['no-such-component'] } } };
  const { questions, asked } = buildEffectQuestions(BRIEF, undefined, declaration, CATALOG, ['hero-title', 'hero-background', 'cta']);
  assert.deepEqual(asked.map((item) => item.placement), ['hero-background', 'hero-title']);
  assert.deepEqual(Object.keys(questions[effectQuestionKey('hero-title')]!.criteria), ['shiny-text', 'none']);
  assert.deepEqual(Object.keys(questions[effectQuestionKey('hero-background')]!.criteria), ['soft-aurora', 'none']);
});

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

const ASKED = [
  { placement: 'hero-title' as const, key: effectQuestionKey('hero-title'), options: ['shiny-text', 'blur-text', 'none'] },
  { placement: 'card-surface' as const, key: effectQuestionKey('card-surface'), options: ['glass-surface', 'none'] },
];

test('resolveEffectChoices: a pick at 0.75 counts, below it is skipped, none is skipped as none', () => {
  const out = resolveEffectChoices({ [ASKED[0]!.key]: answer('shiny-text', 0.75), [ASKED[1]!.key]: answer('glass-surface', 0.74) }, ASKED);
  assert.ok(!('jevSkipped' in out));
  assert.deepEqual(out.picks, [{ placement: 'hero-title', componentId: 'shiny-text', confidence: 0.75 }]);
  assert.deepEqual(out.skipped, [{ placement: 'card-surface', componentId: 'glass-surface', reason: 'below-threshold' }]);
  const none = resolveEffectChoices({ [ASKED[0]!.key]: answer('none', 0.99), [ASKED[1]!.key]: answer('none', 0.5) }, ASKED);
  assert.ok(!('jevSkipped' in none));
  assert.deepEqual(none.skipped.map((item) => item.reason), ['none', 'none']);
});

test('resolveEffectChoices: any wrong type, unoffered choice, bad confidence or missing answer rejects the whole set', () => {
  const good = answer('glass-surface', 0.9);
  for (const bad of [
    { type: 'noul', noul: 0.9 },
    answer('silk', 0.9),
    { ...answer('shiny-text', 0.9), confidence: 1.2 },
    { ...answer('shiny-text', 0.9), confidence: Number.NaN },
    undefined,
  ]) {
    assert.deepEqual(resolveEffectChoices({ [ASKED[0]!.key]: bad, [ASKED[1]!.key]: good }, ASKED), { jevSkipped: 'jev-bad-answer' });
  }
  assert.deepEqual(resolveEffectChoices('not an object', ASKED), { jevSkipped: 'jev-bad-answer' });
});

// ---------------------------------------------------------------------------------------------
// The Jev judge: every failure is a fixed code and zero picks
// ---------------------------------------------------------------------------------------------

const judgeInput = { brief: BRIEF, declaration: DECLARATION, catalog: CATALOG, placements: ['hero-title', 'card-surface'] as const };

function respond(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

test('createJevEffectJudge: a good answer yields picks from one request, never the prose', async () => {
  let sent: { state: unknown; questions: Record<string, unknown> } | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: { [effectQuestionKey('hero-title')]: answer('shiny-text', 0.9), [effectQuestionKey('card-surface')]: answer('none', 0.8) } }), { status: 200 });
  }) as typeof fetch;
  const verdict = await createJevEffectJudge({ apiKey: 'k', fetchImpl }).judge({ ...judgeInput, placements: [...judgeInput.placements] });
  assert.equal(verdict.calls, 1);
  assert.equal(verdict.jevSkipped, undefined);
  assert.deepEqual(verdict.picks, [{ placement: 'hero-title', componentId: 'shiny-text', confidence: 0.9 }]);
  assert.deepEqual(verdict.skipped, [{ placement: 'card-surface', reason: 'none' }]);
  assert.deepEqual(Object.keys(sent!.questions).sort(), [effectQuestionKey('card-surface'), effectQuestionKey('hero-title')].sort());
});

test('createJevEffectJudge: every failure maps to its fixed code with zero picks', async () => {
  const cases: Array<[string, Parameters<typeof createJevEffectJudge>[0]]> = [
    ['jev-key-missing', { apiKey: async () => { throw new Error('no key in the vault'); } }],
    ['jev-key-missing', { apiKey: '' }],
    ['jev-unreachable', { apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }],
    ['jev-timeout', { apiKey: 'k', fetchImpl: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as typeof fetch }],
    ['jev-unauthorized', { apiKey: 'k', fetchImpl: respond(401, 'nope') }],
    ['jev-unauthorized', { apiKey: 'k', fetchImpl: respond(403, 'nope') }],
    ['jev-rate-limited', { apiKey: 'k', fetchImpl: respond(429, 'slow down') }],
    ['jev-http-error', { apiKey: 'k', fetchImpl: respond(500, 'boom') }],
    ['jev-bad-answer', { apiKey: 'k', fetchImpl: respond(200, '{not json') }],
    ['jev-bad-answer', { apiKey: 'k', fetchImpl: respond(200, JSON.stringify({ answers: { [effectQuestionKey('hero-title')]: answer('shiny-text', 0.9) } })) }],
  ];
  for (const [code, options] of cases) {
    const verdict = await createJevEffectJudge(options).judge({ ...judgeInput, placements: [...judgeInput.placements] });
    assert.equal(verdict.jevSkipped, code, code);
    assert.deepEqual(verdict.picks, []);
    assert.deepEqual(verdict.skipped, []);
  }
});

test('createJevEffectJudge: the caller cancelling is rethrown, not folded into a skip', async () => {
  const controller = new AbortController();
  const fetchImpl = (async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }) as typeof fetch;
  await assert.rejects(createJevEffectJudge({ apiKey: 'k', fetchImpl, signal: controller.signal }).judge({ ...judgeInput, placements: [...judgeInput.placements] }), { name: 'AbortError' });
});

// ---------------------------------------------------------------------------------------------
// The decision and its guards
// ---------------------------------------------------------------------------------------------

const cinematic = { choice: 'Cinematic and immersive', confidence: 0.9 };

test('decideEffects: off plans nothing and never asks', async () => {
  const judge = fixedJudge([{ placement: 'hero-title', componentId: 'shiny-text', confidence: 0.9 }]);
  const decision = await decideEffects({ input: 'off', declaration: DECLARATION, catalog: CATALOG, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects, []);
  assert.equal(decision.result.mode, 'off');
  assert.equal(judge.asked.length, 0);
});

test('decideEffects: a family with no declaration plans nothing, and a named id there is not-allowed', async () => {
  assert.deepEqual((await decideEffects({ input: 'auto', declaration: null, brief: BRIEF })).plan.effects, []);
  const named = await decideEffects({ input: { 'hero-title': 'shiny-text' }, declaration: null, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(named.plan.effects, []);
  assert.deepEqual(named.result.skipped, [{ placement: 'hero-title', componentId: 'shiny-text', reason: 'not-allowed' }]);
  assert.equal(named.result.mode, 'explicit');
});

test('decideEffects: hints win and their placements are never sent to Jev', async () => {
  const judge = fixedJudge([
    { placement: 'hero-title', componentId: 'blur-text', confidence: 0.99 },
    { placement: 'card-surface', componentId: 'glass-surface', confidence: 0.9 },
  ]);
  const decision = await decideEffects({ input: { 'hero-title': 'shiny-text', 'hero-background': 'none' }, declaration: DECLARATION, catalog: CATALOG, skin: cinematic, brief: BRIEF, judge });
  assert.deepEqual(judge.asked, [['card-surface', 'section-reveal']]);
  assert.deepEqual(decision.plan.effects, [
    { placement: 'hero-title', componentId: 'shiny-text', source: 'hint' },
    { placement: 'card-surface', componentId: 'glass-surface', source: 'jev' },
  ]);
  assert.deepEqual(decision.result.skipped, [{ placement: 'hero-background', reason: 'none' }]);
  assert.equal(decision.result.mode, 'mixed');
});

test('decideEffects: when every placement is hinted, the judge is never called', async () => {
  const judge = fixedJudge([{ placement: 'card-surface', componentId: 'glass-surface', confidence: 0.99 }]);
  const decision = await decideEffects({
    input: { 'hero-title': 'shiny-text', 'hero-background': 'none', 'card-surface': 'none', 'section-reveal': 'none' },
    declaration: DECLARATION, catalog: CATALOG, skin: cinematic, brief: BRIEF, judge,
  });
  assert.deepEqual(judge.asked, [], 'no Jev request at all');
  assert.equal(decision.ms, 0);
  assert.deepEqual(decision.plan.effects, [{ placement: 'hero-title', componentId: 'shiny-text', source: 'hint' }]);
  assert.equal(decision.result.mode, 'explicit');
});

test('decideEffects: a replayed saved plan reports source repair, with the same guards and mode', async () => {
  const decision = await decideEffects({ input: { 'hero-title': 'shiny-text', 'card-surface': 'none' }, declaration: DECLARATION, catalog: CATALOG, brief: BRIEF, hintSource: 'repair' });
  assert.deepEqual(decision.plan.effects, [{ placement: 'hero-title', componentId: 'shiny-text', source: 'repair' }]);
  assert.deepEqual(decision.result.applied.map((item) => item.source), ['repair']);
  assert.equal(decision.result.mode, 'explicit');
});

test('decideEffects: a hint the family does not allow there is skipped not-allowed; a js hint on a none policy is script-policy', async () => {
  const decision = await decideEffects({ input: { 'hero-title': 'silk', nav: 'shiny-text' }, declaration: DECLARATION, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(decision.plan.effects, []);
  assert.deepEqual(decision.result.skipped, [
    { placement: 'hero-title', componentId: 'silk', reason: 'not-allowed' },
    { placement: 'nav', componentId: 'shiny-text', reason: 'not-allowed' },
  ]);
  const none = await decideEffects({ input: { 'hero-title': 'blur-text' }, declaration: { ...DECLARATION, scriptPolicy: 'none' }, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(none.result.skipped, [{ placement: 'hero-title', componentId: 'blur-text', reason: 'script-policy' }]);
});

test('decideEffects: at most two effects per page, even from hints', async () => {
  const declaration: FamilyEffectDeclaration = { ...DECLARATION, maxEffects: 5 };
  const decision = await decideEffects({ input: { 'hero-title': 'shiny-text', 'card-surface': 'glass-surface', 'section-reveal': 'fade-content' }, declaration, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(decision.plan.effects.map((item) => item.placement), ['hero-title', 'card-surface']);
  assert.deepEqual(decision.result.skipped, [{ placement: 'section-reveal', componentId: 'fade-content', reason: 'max-effects' }]);
});

test('decideEffects: at most one js or background effect', async () => {
  const decision = await decideEffects({ input: { 'hero-title': 'blur-text', 'hero-background': 'soft-aurora' }, declaration: DECLARATION, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(decision.plan.effects, [{ placement: 'hero-title', componentId: 'blur-text', source: 'hint' }]);
  assert.deepEqual(decision.result.skipped, [{ placement: 'hero-background', componentId: 'soft-aurora', reason: 'max-effects' }]);
});

test('decideEffects: the family maxEffects caps further', async () => {
  const decision = await decideEffects({ input: { 'hero-title': 'shiny-text', 'card-surface': 'glass-surface' }, declaration: { ...DECLARATION, maxEffects: 1 }, catalog: CATALOG, brief: BRIEF });
  assert.deepEqual(decision.plan.effects.map((item) => item.placement), ['hero-title']);
  assert.deepEqual(decision.result.skipped.map((item) => item.reason), ['max-effects']);
});

test('skinEffectCap: quiet and institutional one text or surface; cinematic and experimental two; other, unspecified and low-confidence one', () => {
  assert.deepEqual(skinEffectCap({ choice: 'Minimal and quiet', confidence: 0.9 }), { max: 1, textOrSurfaceOnly: true });
  assert.deepEqual(skinEffectCap({ choice: 'Corporate and institutional', confidence: 0.9 }), { max: 1, textOrSurfaceOnly: true });
  assert.deepEqual(skinEffectCap(cinematic), { max: 2, textOrSurfaceOnly: false });
  assert.deepEqual(skinEffectCap({ choice: 'Experimental', confidence: 0.9 }), { max: 2, textOrSurfaceOnly: false });
  assert.deepEqual(skinEffectCap({ choice: 'Editorial', confidence: 0.9 }), { max: 1, textOrSurfaceOnly: false });
  assert.deepEqual(skinEffectCap({ choice: 'Experimental', confidence: 0.3 }), { max: 1, textOrSurfaceOnly: false });
  assert.deepEqual(skinEffectCap({ choice: 'unspecified', confidence: 0.9 }), { max: 1, textOrSurfaceOnly: false });
  assert.deepEqual(skinEffectCap(undefined), { max: 1, textOrSurfaceOnly: false });
});

test('decideEffects: a cinematic skin takes two auto effects, highest priority first', async () => {
  const judge = fixedJudge([
    { placement: 'section-reveal', componentId: 'fade-content', confidence: 0.95 },
    { placement: 'hero-title', componentId: 'shiny-text', confidence: 0.8 },
    { placement: 'card-surface', componentId: 'glass-surface', confidence: 0.9 },
  ]);
  const decision = await decideEffects({ input: 'auto', declaration: DECLARATION, catalog: CATALOG, skin: cinematic, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects.map((item) => item.placement), ['hero-title', 'card-surface']);
  assert.deepEqual(decision.result.skipped, [{ placement: 'section-reveal', componentId: 'fade-content', reason: 'max-effects' }]);
  assert.equal(decision.result.mode, 'auto');
  assert.equal(decision.ms, 3);
});

test('decideEffects: an unknown skin takes one auto effect', async () => {
  const judge = fixedJudge([
    { placement: 'hero-title', componentId: 'shiny-text', confidence: 0.8 },
    { placement: 'card-surface', componentId: 'glass-surface', confidence: 0.9 },
  ]);
  const decision = await decideEffects({ input: 'auto', declaration: DECLARATION, catalog: CATALOG, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects.map((item) => item.componentId), ['shiny-text']);
});

test('decideEffects: a quiet skin takes only a text or surface effect', async () => {
  const judge = fixedJudge([
    { placement: 'hero-background', componentId: 'soft-aurora', confidence: 0.95 },
    { placement: 'section-reveal', componentId: 'fade-content', confidence: 0.95 },
    { placement: 'card-surface', componentId: 'glass-surface', confidence: 0.8 },
  ]);
  const decision = await decideEffects({ input: 'auto', declaration: DECLARATION, catalog: CATALOG, skin: { choice: 'Minimal and quiet', confidence: 0.9 }, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects, [{ placement: 'card-surface', componentId: 'glass-surface', source: 'jev' }]);
  assert.deepEqual(decision.result.skipped.map((item) => `${item.placement}:${item.reason}`).sort(), ['hero-background:max-effects', 'section-reveal:max-effects']);
});

test('decideEffects: a pick outside the allowlist is skipped not-allowed', async () => {
  const judge = fixedJudge([{ placement: 'hero-title', componentId: 'silk', confidence: 0.99 }]);
  const decision = await decideEffects({ input: 'auto', declaration: DECLARATION, catalog: CATALOG, skin: cinematic, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects, []);
  assert.deepEqual(decision.result.skipped, [{ placement: 'hero-title', componentId: 'silk', reason: 'not-allowed' }]);
});

test('decideEffects: a Jev failure yields zero auto effects and the code; hints still apply', async () => {
  const judge = fixedJudge([{ placement: 'card-surface', componentId: 'glass-surface', confidence: 0.99 }], { jevSkipped: 'jev-timeout', picks: [] });
  const decision = await decideEffects({ input: { 'hero-title': 'shiny-text' }, declaration: DECLARATION, catalog: CATALOG, skin: cinematic, brief: BRIEF, judge });
  assert.deepEqual(decision.plan.effects, [{ placement: 'hero-title', componentId: 'shiny-text', source: 'hint' }]);
  assert.equal(decision.result.jevSkipped, 'jev-timeout');
  assert.equal(decision.result.mode, 'explicit');
});

test('decideEffects: Jev is not asked when the hints already fill the skin cap', async () => {
  const judge = fixedJudge([]);
  await decideEffects({ input: { 'hero-title': 'shiny-text' }, declaration: DECLARATION, catalog: CATALOG, brief: BRIEF, judge });
  assert.equal(judge.asked.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The compiler report, the composed-page budget, the family response, the CLI flags
// ---------------------------------------------------------------------------------------------

test('mergeEffectsResult: applied and bytes from the render, skips added, unaccounted plan items incompatible', () => {
  const plan: EffectPlan = { effects: [
    { placement: 'hero-title', componentId: 'shiny-text', source: 'hint' },
    { placement: 'card-surface', componentId: 'glass-surface', source: 'jev' },
  ] };
  const decision = { mode: 'mixed' as const, applied: [], skipped: [{ placement: 'nav' as const, reason: 'none' as const }], bytesAdded: 0 };
  const merged = mergeEffectsResult(decision, plan, { applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' }], skipped: [], bytesAdded: 812 });
  assert.equal(merged.mode, 'mixed', "the decision's mode stands when the render drops the Jev effect");
  assert.equal(merged.bytesAdded, 812);
  assert.deepEqual(merged.skipped, [{ placement: 'nav', reason: 'none' }, { placement: 'card-surface', componentId: 'glass-surface', reason: 'incompatible' }]);
  const noReport = mergeEffectsResult({ ...decision, mode: 'auto' }, plan, undefined);
  assert.deepEqual(noReport.applied, []);
  assert.equal(noReport.skipped.filter((item) => item.reason === 'incompatible').length, 2);
});

test('renderWithEffects: one render, the compiler\'s report passed through, and the zero-effect limit enforced', () => {
  const calls: Array<EffectPlan | undefined> = [];
  const page = (bytes: number) => `<p>${'x'.repeat(bytes - 7)}</p>`;
  const fake = (bytes: number, report?: RenderResult['effects']) => (_input: unknown, _entry: string, options?: { effects?: EffectPlan }): RenderResult => {
    calls.push(options?.effects);
    return { recipe: {}, html: page(bytes), manifest: {} as RenderResult['manifest'], approvedAssets: [], ...(report ? { effects: report } : {}) };
  };
  const plan: EffectPlan = { effects: [{ placement: 'hero-title', componentId: 'shiny-text', source: 'jev' }] };
  const report = { applied: [], skipped: [{ placement: 'hero-title' as const, componentId: 'shiny-text', reason: 'byte-budget' as const }], bytesAdded: 0 };
  const out = renderWithEffects(fake(PAGE_BYTE_LIMIT - 1, report), {}, 'a.html', plan);
  assert.deepEqual(calls, [plan], 'rendered once, with the plan: no re-render loop here');
  assert.deepEqual(out.effects, report, "the compiler's byte-budget skips pass through untouched");
  // No plan, at the limit: refused with the fixed code.
  assert.throws(() => renderWithEffects(fake(PAGE_BYTE_LIMIT), {}, 'a.html', undefined), (error) => error instanceof PageTooLargeError && error.code === 'page-too-large' && error.bytes === PAGE_BYTE_LIMIT);
  // The compiler's own refusal (another module copy, so matched by code) becomes the same error.
  const refusing = () => { throw Object.assign(new Error('effects: the base page is 204801 bytes'), { code: 'page-too-large', bytes: 204_801 }); };
  assert.throws(() => renderWithEffects(refusing, {}, 'a.html', plan), (error) => error instanceof PageTooLargeError && error.bytes === 204_801);
});

test('familyEffectsResponse: placements in vocabulary order, host as an id, allow labelled from the catalog', () => {
  const response = familyEffectsResponse({ family: 'lumen', effects: DECLARATION }, CATALOG);
  assert.equal(response.family, 'lumen');
  assert.equal(response.scriptPolicy, 'hash');
  assert.equal(response.maxEffects, 2);
  assert.deepEqual(response.placements.map((item) => item.placement), ['hero-background', 'hero-title', 'card-surface', 'section-reveal']);
  assert.equal(response.placements[0]!.host, 'hero');
  assert.deepEqual(response.placements[1], {
    placement: 'hero-title',
    host: 'hero-heading',
    allow: [
      { id: 'shiny-text', name: 'Shiny Text', kind: 'css-only', bytes: { js: 900, css: 700 } },
      { id: 'blur-text', name: 'Blur Text', kind: 'js', bytes: { js: 2000, css: 400 } },
    ],
  });
  assert.deepEqual(familyEffectsResponse({ family: 'app-shell', effects: null }, CATALOG), { family: 'app-shell', scriptPolicy: 'none', maxEffects: 0, placements: [] });
});

test('parseEffectFlags: --effects auto|off, --effect placement=id repeatable, usage errors', () => {
  assert.equal(parseEffectFlags(undefined, []), undefined);
  assert.equal(parseEffectFlags('off', []), 'off');
  assert.deepEqual(parseEffectFlags(undefined, ['hero-title=shiny-text', 'nav=none']), { 'hero-title': 'shiny-text', nav: 'none' });
  assert.throws(() => parseEffectFlags('sometimes', []), /--effects must be auto or off/);
  assert.throws(() => parseEffectFlags('off', ['hero-title=shiny-text']), /cannot be combined/);
  assert.throws(() => parseEffectFlags(undefined, ['footer=shiny-text']), /not a placement/);
  assert.throws(() => parseEffectFlags(undefined, ['hero-title=Shiny Text']), /not a component id/);
  // `none` is only ever the sentinel: a placement id is never a component id.
  assert.throws(() => parseEffectFlags(undefined, ['hero-title=cta']), /not a component id/);
  assert.throws(() => parseEffectFlags(undefined, ['hero-title=a', 'hero-title=b']), /twice/);
  assert.throws(() => parseEffectFlags(undefined, ['hero-title']), /expects/);
});
