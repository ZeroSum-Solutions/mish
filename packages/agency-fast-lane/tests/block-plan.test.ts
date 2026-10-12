/**
 * Block composition planning (`src/block-plan.ts`): the catalog projection, the deterministic
 * shortlist, the one Jev `choice` request, the page rules its resolution enforces, and the fixed
 * fallback codes a failed request becomes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoCoverage,
  blockCatalogFrom,
  buildBlockPlanQuestions,
  checkBlockPlan,
  composableSpines,
  createJevBlockPlanner,
  loadBlockCatalogFromSource,
  MAX_BLOCKS,
  optionKey,
  resolveBlockPlan,
  shortlistBlocks,
  type BlockCatalog,
  type BlockCatalogEntry,
} from '../src/block-plan.ts';

const BRIEF = 'Ledgerline, accounting software for small agencies. Invoices, time tracking and payroll in one place. Start a free trial.';
const DIRECTIONS = [
  { id: 'modern-minimal', label: 'Modern minimal', mood: 'Calm, precise, lots of space.' },
  { id: 'tech-utility', label: 'Tech utility', mood: 'Dense, technical, monospaced accents.' },
];

const entry = (id: string, sectionKind: string, spineAffinities: BlockCatalogEntry['spineAffinities']): BlockCatalogEntry =>
  ({ id, title: id, sectionKind, spineAffinities, useCases: [], tags: [] });

/** A small catalog with known shape: one `any` hero, PA body/closing blocks, one unclassified. */
const CATALOG: BlockCatalog = {
  blocks: [
    entry('hyperui:hero', 'hero', 'any'),
    entry('hyperui:features', 'features', 'any'),
    entry('hyperui:cta', 'cta-band', 'any'),
    entry('cult:bento-a', 'features', ['PA']),
    entry('cult:bento-b', 'features', ['PA', 'TL']),
    entry('cult:faq', 'faq', ['PA']),
    entry('cult:pricing', 'pricing', ['PA']),
    entry('cult:cta', 'cta-band', ['PA']),
    entry('cult:footer', 'footer', ['PA']),
    entry('cult:unplaced', 'integrations', 'unclassified'),
    entry('cult:page', 'page-composition', ['PA']),
  ],
};

/** Answers every question with `pick(key, options)` (default: the first non-`none` option) at `confidence`. */
function answersFor(questions: Record<string, { criteria: Record<string, string> }>, pick: (key: string, options: string[]) => string | undefined = () => undefined, confidence = 0.9) {
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const options = Object.keys(question.criteria);
    const choice = pick(key, options) ?? options.find((option) => option !== 'none')!;
    answers[key] = { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } };
  }
  return answers;
}

function jevFetch(respond: (body: { questions: Record<string, { criteria: Record<string, string> }>; state: { brief: string } }) => Response | Promise<Response>): typeof fetch & { calls: number } {
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    impl.calls += 1;
    return respond(JSON.parse(String(init?.body)));
  }) as typeof fetch & { calls: number };
  impl.calls = 0;
  return impl;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------------------------
// Catalog and shortlist
// ---------------------------------------------------------------------------------------------

test('blockCatalogFrom: insertable HyperUI/Cult rows whose adapter resolves, sorted by id, with Cult use cases', () => {
  const section = {
    entries: [
      { id: 'cult:b', title: 'B', sourceKind: 'cult-pro', sectionKind: 'faq', availability: 'insertable', spineAffinities: ['PA'], content: { adapterId: 'cult:b' } },
      { id: 'cult:a', title: 'A', sourceKind: 'cult-pro', sectionKind: 'features', availability: 'insertable', spineAffinities: 'any', content: { adapterId: 'cult:a' } },
      { id: 'cult:no-adapter', title: 'N', sourceKind: 'cult-pro', sectionKind: 'faq', availability: 'insertable', spineAffinities: ['PA'], content: { adapterId: 'cult:no-adapter' } },
      { id: 'cult:needs', title: 'X', sourceKind: 'cult-pro', sectionKind: 'faq', availability: 'adapter-needed', spineAffinities: ['PA'], content: { adapterId: 'cult:needs' } },
      { id: 'family:ownededitorial-hero', title: 'W', sourceKind: 'family', sectionKind: 'hero', availability: 'insertable', spineAffinities: ['TL'], content: { adapterId: 'family:ownededitorial-hero' } },
      { id: 'hyperui:h', title: 'H', sourceKind: 'hyperui', sectionKind: 'hero', availability: 'insertable', spineAffinities: 'any', content: { adapterId: 'hyperui:h' } },
    ],
  };
  const cult = { rows: [{ id: 'cult:b', original: { useCases: ['SaaS help centre'], tags: ['faq'] }, taxonomy: { style: { density: 'airy' } } }] };
  const catalog = blockCatalogFrom(section, cult, ['cult:a', 'cult:b', 'cult:needs', 'family:ownededitorial-hero', 'hyperui:h']);
  assert.deepEqual(catalog.blocks.map((block) => block.id), ['cult:a', 'cult:b', 'hyperui:h']);
  const b = catalog.blocks.find((block) => block.id === 'cult:b')!;
  assert.deepEqual([b.useCases, b.tags, b.density], [['SaaS help centre'], ['faq'], 'airy']);
  assert.ok(catalog.blocks.find((block) => block.id === 'hyperui:h')!.useCases.length > 0, 'HyperUI blocks carry fixed notes');
});

test('the real catalog: the public catalog has only the three supported HyperUI adapters and no automatic spine coverage', async () => {
  const catalog = await loadBlockCatalogFromSource();
  const ids = catalog.blocks.map((block) => block.id);
  for (const id of ['hyperui:marketing/sections/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/ctas/1']) assert.ok(ids.includes(id), id);
  assert.equal(ids.filter((id) => id.startsWith('cult:')).length, 0);
  assert.equal(ids.length, 3);
  assert.deepEqual([...ids].sort(), ids, 'sorted by id');
  assert.equal(autoCoverage(catalog, 'PA'), false);
  assert.equal(autoCoverage(catalog, 'BA'), false, 'HyperUI "any" blocks alone never qualify a spine for auto');
  assert.equal(composableSpines(catalog).length, 9);
  for (const spine of composableSpines(catalog)) assert.equal(autoCoverage(catalog, spine), false);
});

test('shortlistBlocks: deterministic roles in page order; explicit affinity first; unclassified and whole pages excluded', () => {
  const roles = shortlistBlocks(CATALOG, 'PA');
  assert.deepEqual(roles.map((role) => role.role), ['hero', 'features', 'features_2', 'pricing', 'faq', 'cta', 'footer']);
  assert.deepEqual(roles.find((role) => role.role === 'features')!.candidates, ['cult:bento-a', 'cult:bento-b', 'hyperui:features']);
  assert.deepEqual(roles.find((role) => role.role === 'cta')!.candidates, ['cult:cta', 'hyperui:cta']);
  assert.deepEqual(roles.filter((role) => role.required).map((role) => role.role), ['hero', 'footer']);
  const all = roles.flatMap((role) => role.candidates);
  assert.ok(!all.includes('cult:unplaced') && !all.includes('cult:page'));
  assert.deepEqual(shortlistBlocks(CATALOG, 'PA'), roles, 'same catalog and spine in, same roles out');
  const shuffled = { blocks: [...CATALOG.blocks].reverse() };
  assert.deepEqual(shortlistBlocks(shuffled, 'PA'), roles, 'catalog order does not change the shortlist');
  // TL: only the `any` blocks plus bento-b.
  assert.deepEqual(shortlistBlocks(CATALOG, 'TL').map((role) => role.role), ['hero', 'features', 'features_2', 'cta']);
});

test('buildBlockPlanQuestions: one spine, one direction and one question per role; required roles offer no none', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS)!;
  assert.deepEqual(built.state, { brief: BRIEF });
  assert.ok(built.questions.spine && built.questions.direction);
  assert.ok(built.questions.spine.criteria.none);
  assert.deepEqual(Object.keys(built.questions.direction.criteria), ['modern_minimal', 'tech_utility']);
  assert.equal(built.questions.block_hero!.criteria.none, undefined, 'the hero is required');
  assert.ok(built.questions.block_pricing!.criteria.none, 'an optional role can be left out');
  assert.match(built.questions.block_pricing!.instructions, /states prices/);
  assert.equal(built.questions.block_footer!.criteria.none !== undefined, true, 'a footer absent from some spine stays optional');
  // With the spine fixed (auto), no spine question and the footer is required.
  const fixed = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS, { spine: 'PA' })!;
  assert.equal(fixed.questions.spine, undefined);
  assert.equal(fixed.questions.block_footer!.criteria.none, undefined);
  assert.equal(JSON.stringify(buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS)), JSON.stringify(built), 'deterministic');
});

// ---------------------------------------------------------------------------------------------
// Resolution: the page rules
// ---------------------------------------------------------------------------------------------

test('resolveBlockPlan: hero first, footer last, features at most twice, no duplicate id or kind', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS, { spine: 'PA' })!;
  const picks: Record<string, string> = {
    direction: 'tech_utility', block_hero: optionKey('hyperui:hero'), block_features: optionKey('cult:bento-a'),
    block_features_2: optionKey('cult:bento-a'), block_pricing: 'none', block_faq: optionKey('cult:faq'), block_cta: optionKey('cult:cta'), block_footer: optionKey('cult:footer'),
  };
  const resolved = resolveBlockPlan(answersFor(built.questions, (key) => picks[key]), built.asked, CATALOG, { spine: 'PA' });
  assert.ok('plan' in resolved);
  assert.deepEqual(resolved.plan, { spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:hero', 'cult:bento-a', 'cult:faq', 'cult:cta', 'cult:footer'] });
});

test('resolveBlockPlan: a low-confidence optional pick is left out; too few blocks falls back', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS, { spine: 'PA' })!;
  const low = resolveBlockPlan(answersFor(built.questions, undefined, 0.2), built.asked, CATALOG, { spine: 'PA' });
  assert.deepEqual(low, { fallback: 'too-few-blocks' }, 'only the required hero and footer survive: no body block');
  const noneBody = resolveBlockPlan(answersFor(built.questions, (key, options) => (key.startsWith('block_') && options.includes('none') ? 'none' : undefined)), built.asked, CATALOG, { spine: 'PA' });
  assert.deepEqual(noneBody, { fallback: 'too-few-blocks' });
});

test('resolveBlockPlan: an optional role is judged by P(none), then filled with its most probable compatible block', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS, { spine: 'PA' })!;
  const answers = answersFor(built.questions, (key) => ({ block_features_2: 'none', block_pricing: 'none' } as Record<string, string>)[key]);
  // Two bento blocks and a HyperUI grid share the features vote; none is unlikely. Before, the
  // chosen block's own confidence (0.3) sat under the threshold and the role was dropped.
  answers.block_features = { type: 'choice', choice: optionKey('cult:bento-a'), confidence: 0.3, probabilities: { [optionKey('cult:bento-a')]: 0.34, [optionKey('cult:bento-b')]: 0.36, [optionKey('hyperui:features')]: 0.2, none: 0.1 } };
  // Jev chose none by a hair, yet a CTA is more likely than not: the best CTA fills it.
  answers.block_cta = { type: 'choice', choice: 'none', confidence: 0.1, probabilities: { none: 0.4, [optionKey('cult:cta')]: 0.35, [optionKey('hyperui:cta')]: 0.25 } };
  // The FAQ is unlikely: left out, whatever its block's own confidence.
  answers.block_faq = { type: 'choice', choice: optionKey('cult:faq'), confidence: 0.9, probabilities: { [optionKey('cult:faq')]: 0.45, none: 0.55 } };
  const resolved = resolveBlockPlan(answers, built.asked, CATALOG, { spine: 'PA' });
  assert.ok('plan' in resolved);
  assert.deepEqual(resolved.plan.blocks, ['hyperui:hero', 'cult:bento-b', 'cult:cta', 'cult:footer']);
});

test('resolveBlockPlan: probability on a block the chosen spine cannot take is no support for the role', () => {
  // No fixed spine; PA chosen. The FAQ vote goes to a TL-only block: support for PA is the
  // compatible FAQ's 0.04 against none's 0.06, so the role stays out.
  const catalog: BlockCatalog = { blocks: [...CATALOG.blocks, entry('cult:faq-tl', 'faq', ['TL'])] };
  const built = buildBlockPlanQuestions(BRIEF, catalog, DIRECTIONS)!;
  const answers = answersFor(built.questions, (key) => (key === 'spine' ? 'PA' : ({ block_features_2: 'none', block_pricing: 'none' } as Record<string, string>)[key]));
  answers.block_faq = { type: 'choice', choice: optionKey('cult:faq-tl'), confidence: 0.9, probabilities: { [optionKey('cult:faq-tl')]: 0.9, [optionKey('cult:faq')]: 0.04, none: 0.06 } };
  const resolved = resolveBlockPlan(answers, built.asked, catalog);
  assert.ok('plan' in resolved);
  assert.ok(!resolved.plan.blocks.includes('cult:faq') && !resolved.plan.blocks.includes('cult:faq-tl'), resolved.plan.blocks.join(', '));
  // The same vote on the compatible block keeps the role.
  answers.block_faq = { type: 'choice', choice: optionKey('cult:faq'), confidence: 0.9, probabilities: { [optionKey('cult:faq')]: 0.9, none: 0.1 } };
  const kept = resolveBlockPlan(answers, built.asked, catalog);
  assert.ok('plan' in kept && kept.plan.blocks.includes('cult:faq'));
});

test('resolveBlockPlan: 0.92 incompatible, 0.04 compatible, 0.04 none — the role stays out (no renormalising)', () => {
  const catalog: BlockCatalog = { blocks: [...CATALOG.blocks, entry('cult:faq-tl', 'faq', ['TL'])] };
  const built = buildBlockPlanQuestions(BRIEF, catalog, DIRECTIONS)!;
  const answers = answersFor(built.questions, (key) => (key === 'spine' ? 'PA' : ({ block_features_2: 'none', block_pricing: 'none' } as Record<string, string>)[key]));
  answers.block_faq = { type: 'choice', choice: optionKey('cult:faq-tl'), confidence: 0.92, probabilities: { [optionKey('cult:faq-tl')]: 0.92, [optionKey('cult:faq')]: 0.04, none: 0.04 } };
  const resolved = resolveBlockPlan(answers, built.asked, catalog);
  assert.ok('plan' in resolved);
  assert.ok(!resolved.plan.blocks.includes('cult:faq'), resolved.plan.blocks.join(', '));
});

test('resolveBlockPlan: at most MAX_BLOCKS, the least confident body picks go first, page order kept', () => {
  const many: BlockCatalog = { blocks: [
    entry('h', 'hero', ['PA']), entry('f1', 'features', ['PA']), entry('f2', 'features', ['PA']), entry('p', 'pricing', ['PA']),
    entry('q', 'faq', ['PA']), entry('t', 'team', ['PA']), entry('r', 'timeline-roadmap', ['PA']), entry('c', 'cta-band', ['PA']), entry('z', 'footer', ['PA']),
  ] };
  const built = buildBlockPlanQuestions(BRIEF, many, DIRECTIONS, { spine: 'PA' })!;
  const answers = answersFor(built.questions, (key) => (key === 'block_features_2' ? 'f2' : undefined));
  (answers.block_team as { confidence: number }).confidence = 0.6;
  (answers.block_timeline_roadmap as { confidence: number }).confidence = 0.55;
  const resolved = resolveBlockPlan(answers, built.asked, many, { spine: 'PA' });
  assert.ok('plan' in resolved);
  assert.equal(resolved.plan.blocks.length, MAX_BLOCKS);
  assert.deepEqual(resolved.plan.blocks, ['h', 'f1', 'f2', 'p', 'q', 'c', 'z']);
});

test('resolveBlockPlan: malformed answers, none and a low spine are fixed fallback codes', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS)!;
  assert.deepEqual(resolveBlockPlan(undefined, built.asked, CATALOG), { fallback: 'jev-bad-answer' });
  const bad = answersFor(built.questions);
  bad.direction = { type: 'choice', choice: 'cyberpunk', confidence: 0.9, probabilities: {} };
  assert.deepEqual(resolveBlockPlan(bad, built.asked, CATALOG), { fallback: 'jev-bad-answer' });
  assert.deepEqual(resolveBlockPlan(answersFor(built.questions, (key) => (key === 'spine' ? 'none' : undefined)), built.asked, CATALOG), { fallback: 'no-spine' });
  const low = answersFor(built.questions, (key) => (key === 'spine' ? 'PA' : undefined));
  (low.spine as { confidence: number }).confidence = 0.3;
  assert.deepEqual(resolveBlockPlan(low, built.asked, CATALOG), { fallback: 'spine-below-threshold' });
});

test('resolveBlockPlan: a pick the chosen spine cannot take is dropped', () => {
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS)!;
  // TL chosen: cult:faq and cult:footer are PA-only and are dropped; hyperui cta still closes.
  const resolved = resolveBlockPlan(answersFor(built.questions, (key) => (key === 'spine' ? 'TL' : key === 'block_cta' ? optionKey('hyperui:cta') : key === 'block_features' ? optionKey('cult:bento-b') : undefined)), built.asked, CATALOG);
  assert.ok('plan' in resolved);
  assert.equal(resolved.plan.spine, 'TL');
  assert.ok(!resolved.plan.blocks.includes('cult:faq') && !resolved.plan.blocks.includes('cult:footer'));
  assert.deepEqual(resolved.plan.blocks, ['hyperui:hero', 'cult:bento-b', 'hyperui:cta']);
});

test('resolveBlockPlan: a chosen spine that has a footer ends with one, even when Jev answered none', () => {
  // No fixed spine: TL has no footer, so the merged footer question offers none.
  const built = buildBlockPlanQuestions(BRIEF, CATALOG, DIRECTIONS)!;
  const footerRole = built.asked.roles.find((role) => role.kind === 'footer')!;
  assert.equal(footerRole.required, false, 'optional across spines');
  const answers = answersFor(built.questions, (key) => (key === 'spine' ? 'PA' : undefined));
  answers.block_footer = { type: 'choice', choice: 'none', confidence: 0.8, probabilities: { none: 0.8, [optionKey('cult:footer')]: 0.2 } };
  const resolved = resolveBlockPlan(answers, built.asked, CATALOG);
  assert.ok('plan' in resolved);
  assert.equal(resolved.plan.spine, 'PA');
  assert.equal(resolved.plan.blocks.at(-1), 'cult:footer', 'PA takes a footer, last');
  assert.equal(checkBlockPlan(resolved.plan, CATALOG, DIRECTIONS.map((direction) => direction.id)), undefined);
});

test('checkBlockPlan: a replayed plan is re-checked against today\'s catalog', () => {
  const directions = DIRECTIONS.map((direction) => direction.id);
  const plan = { spine: 'PA', directionId: 'modern-minimal', blocks: ['hyperui:hero', 'cult:bento-a', 'cult:cta', 'cult:footer'] };
  assert.equal(checkBlockPlan(plan, CATALOG, directions), undefined);
  assert.match(checkBlockPlan({ ...plan, directionId: 'nope' }, CATALOG, directions)!, /unknown direction/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['cult:bento-a', 'hyperui:hero', 'cult:cta'] }, CATALOG, directions)!, /starts with its one hero/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['hyperui:hero', 'cult:footer', 'cult:cta'] }, CATALOG, directions)!, /footer comes last/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['hyperui:hero', 'cult:cta', 'hyperui:cta'] }, CATALOG, directions)!, /cta-band appears twice/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['hyperui:hero', 'cult:gone', 'cult:cta'] }, CATALOG, directions)!, /not an insertable/);
  assert.match(checkBlockPlan({ ...plan, spine: 'TL' }, CATALOG, directions)!, /does not fit spine TL/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['hyperui:hero', 'cult:cta'] }, CATALOG, directions)!, /3 to 7/);
  assert.match(checkBlockPlan({ ...plan, blocks: ['hyperui:hero', 'cult:bento-a', 'cult:cta'] }, CATALOG, directions)!, /spine PA takes a footer/);
});

// ---------------------------------------------------------------------------------------------
// The planner: one request, fixed fallback codes
// ---------------------------------------------------------------------------------------------

test('createJevBlockPlanner: one request with the brief as state; a good answer is a plan', async () => {
  const fetchImpl = jevFetch((body) => {
    assert.equal(body.state.brief, BRIEF);
    return ok({ answers: answersFor(body.questions, (key) => (key === 'spine' ? 'PA' : undefined)) });
  });
  const planner = createJevBlockPlanner({ apiKey: 'k', fetchImpl, directions: DIRECTIONS });
  const judged = await planner.plan({ brief: BRIEF, catalog: CATALOG });
  assert.equal(fetchImpl.calls, 1);
  assert.ok('plan' in judged);
  assert.equal(judged.plan.blocks[0], 'hyperui:hero');
  assert.equal(judged.plan.blocks.at(-1), 'cult:footer');
  assert.equal(judged.calls, 1);
});

test('createJevBlockPlanner: every Jev failure is a fixed fallback code, never a throw', async () => {
  const cases: Array<[string, Partial<Parameters<typeof createJevBlockPlanner>[0]>, string]> = [
    ['missing key', { apiKey: async () => { throw new Error('no key'); } }, 'jev-key-missing'],
    ['empty key', { apiKey: '' }, 'jev-key-missing'],
    ['401', { fetchImpl: jevFetch(() => new Response('no', { status: 401 })) }, 'jev-unauthorized'],
    ['429', { fetchImpl: jevFetch(() => new Response('slow', { status: 429 })) }, 'jev-rate-limited'],
    ['500', { fetchImpl: jevFetch(() => new Response('oops', { status: 500 })) }, 'jev-http-error'],
    ['not json', { fetchImpl: jevFetch(() => new Response('<html>', { status: 200 })) }, 'jev-bad-answer'],
    ['network', { fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }, 'jev-unreachable'],
    ['timeout', { fetchImpl: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch }, 'jev-timeout'],
  ];
  for (const [label, overrides, code] of cases) {
    const planner = createJevBlockPlanner({ apiKey: 'k', directions: DIRECTIONS, fetchImpl: jevFetch(() => ok({})), ...overrides });
    const judged = await planner.plan({ brief: BRIEF, catalog: CATALOG });
    assert.deepEqual('fallback' in judged ? judged.fallback : judged, code, label);
  }
});

test('createJevBlockPlanner: a fixed spine the catalog cannot compose is no-coverage without a request', async () => {
  const fetchImpl = jevFetch(() => ok({}));
  const planner = createJevBlockPlanner({ apiKey: 'k', fetchImpl, directions: DIRECTIONS });
  const judged = await planner.plan({ brief: BRIEF, catalog: { blocks: [entry('h', 'hero', 'any')] }, spine: 'PA' });
  assert.deepEqual('fallback' in judged ? judged.fallback : judged, 'no-coverage');
  assert.equal(fetchImpl.calls, 0);
});

test('createJevBlockPlanner: a cancellation is rethrown, not folded into a fallback', async () => {
  const controller = new AbortController();
  const fetchImpl = (async () => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  }) as typeof fetch;
  const planner = createJevBlockPlanner({ apiKey: 'k', fetchImpl, directions: DIRECTIONS, signal: controller.signal });
  await assert.rejects(planner.plan({ brief: BRIEF, catalog: CATALOG }), /aborted/);
});
