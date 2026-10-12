/**
 * `buildSite` with `composition` (`src/build.ts` + `block-plan.ts` + `block-compose.ts`): a fake
 * model, a fake Jev planner/router/checker and a fake daemon. Covers the three modes, the fixed
 * fallback to the family route, a replayed plan, and that `family` never reads the block catalog.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSite, CompositionVerifyError, kitDirection, type BuildDeps, type BuildEvent, type BuildInput, type PreparedBuild } from '../src/build.ts';
import { loadBlockCatalogFromSource, planShowsHours, type BlockCatalog, type BlockPlanner, type BlockPlanJudgement } from '../src/block-plan.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import type { RouteDecision } from '../src/route.ts';
import type { JsonObject } from '../src/spine.ts';
import { loadAtlasData } from '../src/atlas.ts';
import { fakeModel, loadTestSite, type Filler } from './fixtures.ts';
import { clipWholeWords } from '../src/text-clip.ts';
import { publicSectionEntryId as pub } from '../src/cult-public-ids.ts';
import type { BlockSupportReceipt } from '../src/block-support.ts';

/** Whole-word fake copy: a composed fill refuses sliced words ("lab" for "label"). */
const wholeWords: Filler = (key, _value, _at, limit) => {
  const text = `New ${key} for the studio`;
  return typeof limit === 'number' ? (clipWholeWords(text, limit) ?? 'New') : text;
};

const pkg = await loadTestSite();
const BRIEF = 'Ledgerline, accounting software for small agencies. Invoices, time tracking and payroll in one place. Start a free trial.';
const DAEMON = 'http://daemon.test';
const PLAN = {
  spine: 'PA',
  directionId: 'tech-utility',
  // No footer: every Product-adoption footer is refused for composition since the G9 dry run
  // (`section-overlay.ts`'s `composeRefusalFor`), so a PA page closes on its cta band.
  blocks: ['hyperui:marketing/sections/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/ctas/1'],
};

const checker: FaithfulnessChecker = {
  async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
    return { flagged: slots.filter((slot) => slot.text.includes('FABRICATED')).map((slot) => ({ path: slot.path, probability: 0.9 })), ms: 1, calls: 1 };
  },
};

const routed = (spine: string, family = 'ownedsite'): RouteDecision => ({
  decision: 'routed',
  spine: { code: spine, name: spine, confidence: 0.9, probabilities: { [spine]: 0.9 } },
  spines: [{ code: spine, probability: 0.9 }],
  archetype: { id: `${spine}.01`, name: 'Fake', confidence: 0.9 },
  skin: { choice: 'Minimal', confidence: 0.8 },
  family: { id: family, probability: 0.9, basis: 'exact', transfer: 3 },
  candidates: [],
  warnings: [],
  ms: 1,
  calls: 1,
  model: 'fake-router',
});

type Call = { method: string; url: string; body?: JsonObject };

function fakeDaemon(calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as JsonObject) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, ...(body ? { body } : {}) });
    return new Response(JSON.stringify(body?.id ? { id: body.id } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function planner(answer: () => BlockPlanJudgement, seen: Array<{ spine?: string }> = []): (options: unknown) => BlockPlanner {
  return () => ({ plan: async ({ spine }) => { seen.push({ ...(spine !== undefined ? { spine } : {}) }); return answer(); } });
}

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    brief: BRIEF,
    family: 'auto',
    mode: 'sections',
    revision: 1,
    verify: 'strict',
    provider: 'deepseek',
    prepare: async (family: string): Promise<PreparedBuild> => {
      assert.equal(family, 'ownedsite');
      return { pkg, entry: 'ownedsite-r1.html' };
    },
    loadAtlas: loadAtlasData,
    loadBlockCatalog: async () => ({blocks: PLAN.blocks.map((id,index) => ({id,title:id,sectionKind:['hero','features','cta-band'][index]!,spineAffinities:['PA'] as const,useCases:[],tags:[]}))}),
    project: { daemonUrl: DAEMON },
    ...overrides,
  };
}

function deps(overrides: Partial<BuildDeps> = {}): BuildDeps {
  return {
    createModelCaller: () => fakeModel({ fill: wholeWords }),
    createJevChecker: () => checker,
    createJevRouter: () => ({ route: async () => routed('TL') }),
    createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 })),
    resolveJevCredential: async () => 'jev-key',
    resolveModelKey: async () => 'model-key',
    daemonFetch: fakeDaemon([]),
    ...overrides,
  };
}

const selected = (html: string) => [...html.matchAll(/data-od-selected-section="([^"]+)"/g)].map((match) => match[1]);

test('support gate receipt reaches the composition event and the published report with public ids', async () => {
  const supportGate: BlockSupportReceipt = { threshold: 0.8, added: [{ kind: 'faq', id: PLAN.blocks[2], reason: 'faq-brief-signal' }], removed: [], decisions: [] };
  const events: BuildEvent[] = [];
  const result = await buildSite(input({ composition: 'blocks', onEvent: (event) => events.push(event) }),
    deps({ createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 37, calls: 2, supportGate })) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  const event = events.find((event) => event.type === 'composition');
  assert.ok(event?.type === 'composition');
  assert.deepEqual(event.result.supportGate, supportGate);
  assert.deepEqual(event.result.planner, { calls: 2, ms: 37 });
  assert.deepEqual(result.report.composition?.planner, { calls: 2, ms: 37 });
  assert.deepEqual(result.report.composition?.supportGate?.added, [{ ...supportGate.added[0], id: pub(PLAN.blocks[2]) }]);
});

test('blocks: Jev\'s plan composes one page, published once under strict; no family route runs', async () => {
  const calls: Call[] = [];
  const events: BuildEvent[] = [];
  let routedCalls = 0;
  const result = await buildSite(
    input({ composition: 'blocks', onEvent: (event) => events.push(event) }),
    deps({ daemonFetch: fakeDaemon(calls), createJevRouter: () => ({ route: async () => { routedCalls += 1; return routed('TL'); } }) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(routedCalls, 0, 'a composed page asks no family route question');
  assert.equal(result.family, 'composed');
  assert.equal(result.report.entry, 'composed-r1.html');
  assert.deepEqual(selected(result.report.html), PLAN.blocks.map(pub));
  assert.equal(result.report.strict?.passed, true);
  assert.deepEqual(result.report.composition?.blocks, PLAN.blocks);
  assert.equal(result.report.composition?.used, 'blocks');
  assert.equal(events[0]!.type, 'composition', 'the composition decision is the first event');
  assert.deepEqual(result.report.composition?.effects, { mode: 'off', reason: 'no-placements' });
  assert.deepEqual(result.report.effects, { mode: 'off', applied: [], skipped: [], bytesAdded: 0 }, 'a composed page plans no effects');
  assert.ok(!events.some((event) => event.type === 'effects'), 'no effect decision is announced');
  const pages = calls.filter((call) => call.url.endsWith('/files') && call.body?.name === 'composed-r1.html');
  assert.equal(pages.length, 1, 'strict: one page save');
  assert.ok(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/projects')), 'the project is created');
});

test('blocks: a Jev failure falls back to the family route with its fixed code', async () => {
  const events: BuildEvent[] = [];
  const result = await buildSite(
    input({ composition: 'blocks', onEvent: (event) => events.push(event) }),
    deps({ createBlockPlanner: planner(() => ({ fallback: 'jev-timeout', ms: 1, calls: 0 })) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.family, 'ownedsite');
  assert.deepEqual(result.report.composition, { requested: 'blocks', used: 'family', fallback: 'jev-timeout', planner: { calls: 0, ms: 1 } });
  const composition = events.find((event) => event.type === 'composition');
  assert.deepEqual(composition && composition.type === 'composition' ? composition.result : undefined, { requested: 'blocks', used: 'family', fallback: 'jev-timeout', planner: { calls: 0, ms: 1 } });
});

test('blocks without a planner dependency: planner-unavailable, the family route runs', async () => {
  const result = await buildSite(input({ composition: 'blocks' }), deps({ createBlockPlanner: undefined }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.composition?.fallback, 'planner-unavailable');
});

test('auto: composes when the routed spine is covered, with the spine fixed for the planner', async () => {
  const seen: Array<{ spine?: string }> = [];
  const result = await buildSite(
    input({ composition: 'auto' }),
    deps({ createJevRouter: () => ({ route: async () => routed('PA') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(seen, [{ spine: 'PA' }]);
  assert.equal(result.report.composition?.requested, 'auto');
  assert.equal(result.report.composition?.used, 'blocks');
});

test('auto: an uncovered spine runs the family route and records no-coverage, without asking the planner', async () => {
  const seen: Array<{ spine?: string }> = [];
  // CO: no reviewed block names it explicitly (TL gained Cult coverage with the catalog merge).
  const result = await buildSite(input({ composition: 'auto' }), deps({ createJevRouter: () => ({ route: async () => routed('CO') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(seen.length, 0);
  assert.equal(result.family, 'ownedsite');
  assert.deepEqual(result.report.composition, { requested: 'auto', used: 'family', fallback: 'no-coverage' });
});

test('auto: a covered spine below the threshold never composes — spine-below-threshold, no planner call', async () => {
  const weak = (decision: 'routed' | 'unrouted'): RouteDecision => {
    const base = routed('PA');
    return { ...base, decision, ...(decision === 'unrouted' ? { family: undefined, reason: 'no family above the threshold' } : {}), spine: { ...base.spine, confidence: 0.4, probabilities: { PA: 0.4 } } } as RouteDecision;
  };
  const seen: Array<{ spine?: string }> = [];
  const routedWeak = await buildSite(input({ composition: 'auto' }), deps({ createJevRouter: () => ({ route: async () => weak('routed') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }));
  assert.equal(routedWeak.outcome, 'built');
  if (routedWeak.outcome !== 'built') return;
  assert.equal(routedWeak.family, 'ownedsite');
  assert.deepEqual(routedWeak.report.composition, { requested: 'auto', used: 'family', fallback: 'spine-below-threshold' });
  const unrouted = await buildSite(input({ composition: 'auto' }), deps({ createJevRouter: () => ({ route: async () => weak('unrouted') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }));
  assert.equal(unrouted.outcome, 'unrouted');
  if (unrouted.outcome !== 'unrouted') return;
  assert.deepEqual(unrouted.composition, { requested: 'auto', used: 'family', fallback: 'spine-below-threshold' });
  assert.equal(seen.length, 0, 'the planner is never asked');
});

// ---------------------------------------------------------------------------
// R1 (mishh-genui-production families-design task t25c): `composition: 'auto'` must never rescue
// a genuinely unrouted brief (no spine Jev is confident of at all — the family router's own `spine
// none` decision) into a built page. The already-covered `spine-below-threshold` and `no-coverage`
// fallbacks (above) prove a covered-but-weak spine still refuses; this proves the "no spine
// placement whatsoever" case (`RoutePolicy.spine.code === 'none'`) refuses the same way — the
// planner is never even asked, and the build outcome stays `unrouted`, not `built`.
// ---------------------------------------------------------------------------

test('auto: a brief with no spine placement at all (route decision unrouted, spine.code "none") never composes — no-spine, no planner call, outcome stays unrouted', async () => {
  const noSpine: RouteDecision = {
    decision: 'unrouted',
    reason: 'no spine',
    spine: { code: 'none', name: 'none', confidence: 0, probabilities: {} },
    spines: [],
    skin: { choice: 'unspecified', confidence: 0 },
    candidates: [],
    warnings: [],
    ms: 1,
    calls: 1,
    model: 'fake-router',
  };
  const seen: Array<{ spine?: string }> = [];
  const result = await buildSite(
    input({ composition: 'auto' }),
    deps({ createJevRouter: () => ({ route: async () => noSpine }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }),
  );
  assert.equal(result.outcome, 'unrouted');
  if (result.outcome !== 'unrouted') return;
  assert.deepEqual(result.composition, { requested: 'auto', used: 'family', fallback: 'no-spine' });
  assert.equal(seen.length, 0, 'the planner is never asked when there is no spine to plan from');
});

// ---------------------------------------------------------------------------
// Grok audit follow-up (t25c-grok.md, DO NOT SHIP): `resolveRoute` rejecting the model's own
// `family` answer as malformed (an unregistered id, e.g. a family still being built on another
// branch) still reports a real, confident `route.spine` — that spine came from the very same
// untrusted answer set. `auto` must not compose from it even though the spine alone looks
// confident and covered: 'route-invalid', no planner call, outcome stays 'unrouted', no project
// write. Contrast with the next test: a VALID `family: 'none'` answer (Jev honestly says no
// family fits) with the same confident, covered spine still composes — that is `auto`'s intended
// rescue path (Sol review round 4, PR #109), and this fix must not close it.
// ---------------------------------------------------------------------------

const malformedFamilyUnrouted: RouteDecision = {
  decision: 'unrouted',
  reason: 'malformed answer family: choice is not one of the offered options',
  spine: { code: 'PA', name: 'PA', confidence: 0.9, probabilities: { PA: 0.9 } },
  spines: [{ code: 'PA', probability: 0.9 }],
  skin: { choice: 'Minimal', confidence: 0.8 },
  candidates: [],
  warnings: [],
  ms: 1,
  calls: 1,
  model: 'fake-router',
};

test('auto: an unknown family id from the model (route unrouted, "malformed answer family") never composes even though the spine it also reports is confident and covered — route-invalid, no planner call, no project', async () => {
  const seen: Array<{ spine?: string }> = [];
  const calls: Call[] = [];
  const result = await buildSite(
    input({ composition: 'auto' }),
    deps({
      daemonFetch: fakeDaemon(calls),
      createJevRouter: () => ({ route: async () => malformedFamilyUnrouted }),
      createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen),
    }),
  );
  assert.equal(result.outcome, 'unrouted');
  if (result.outcome !== 'unrouted') return;
  assert.deepEqual(result.composition, { requested: 'auto', used: 'family', fallback: 'route-invalid' });
  assert.equal(seen.length, 0, 'the planner is never asked when the route answer that named the spine was itself malformed');
  assert.equal(calls.length, 0, 'nothing reaches the daemon; no project is created');
});

test('auto: a VALID family "none" answer (Jev honestly says no family fits) with a confident, covered spine still composes — the intended auto rescue path, unchanged', async () => {
  const validNoFamily: RouteDecision = {
    ...malformedFamilyUnrouted,
    reason: 'family none at p=0.00 below 0.5',
  };
  const seen: Array<{ spine?: string }> = [];
  const result = await buildSite(
    input({ composition: 'auto' }),
    deps({ createJevRouter: () => ({ route: async () => validNoFamily }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(seen, [{ spine: 'PA' }]);
  assert.equal(result.report.composition?.requested, 'auto');
  assert.equal(result.report.composition?.used, 'blocks');
});

test('auto with a named family: family-named, the family route runs', async () => {
  const result = await buildSite(input({ composition: 'auto', family: 'ownedsite' }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.composition?.fallback, 'family-named');
});

test('family (the default): the block catalog is never read and the report has no composition', async () => {
  let reads = 0;
  const result = await buildSite(input({ loadBlockCatalog: async () => { reads += 1; return { blocks: [] }; } }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(reads, 0);
  assert.equal(result.report.composition, undefined);
});

test('a replayed plan composes without asking Jev; a plan that no longer applies fails the build', async () => {
  let asked = 0;
  const result = await buildSite(
    input({ composition: 'blocks', blockPlan: PLAN }),
    deps({ createBlockPlanner: () => ({ plan: async () => { asked += 1; return { fallback: 'jev-timeout', ms: 0, calls: 0 }; } }) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(asked, 0);
  assert.equal(result.report.composition?.source, 'replay');
  assert.deepEqual(selected(result.report.html), PLAN.blocks.map(pub));
  // A plan saved from a build's report names Cult blocks by public id; it replays the same way.
  const byPublic = await buildSite(input({ composition: 'blocks', blockPlan: { ...PLAN, blocks: PLAN.blocks.map(pub) } }), deps());
  assert.equal(byPublic.outcome, 'built');
  if (byPublic.outcome === 'built') assert.deepEqual(selected(byPublic.report.html), PLAN.blocks.map(pub));
  await assert.rejects(
    buildSite(input({ composition: 'blocks', blockPlan: { ...PLAN, blocks: ['cult:gone', ...PLAN.blocks.slice(1)] } }), deps()),
    /saved block plan no longer applies/,
  );
});

test('blocks and auto publish only after a strict check: any other verify mode is refused before any call', async () => {
  for (const composition of ['blocks', 'auto'] as const) {
    for (const verify of ['advisory', 'after', 'off'] as const) {
      let called = 0;
      await assert.rejects(
        buildSite(input({ composition, verify }), deps({ createModelCaller: () => { called += 1; return fakeModel(); }, createBlockPlanner: () => { called += 1; return { plan: async () => ({ fallback: 'jev-timeout', ms: 0, calls: 0 }) }; } })),
        CompositionVerifyError,
      );
      assert.equal(called, 0, `${composition}/${verify}: no model or planner call`);
    }
  }
  // `family` keeps every verify mode.
  const family = await buildSite(input({ verify: 'off' }), deps());
  assert.equal(family.outcome, 'built');
});

// Devin, 2026-10-10: a dental brief that stated its opening hours routed to `practice` (which has an
// hours-and-location section) but `auto` composed four generic blocks, none of which can show hours,
// so the brief's hours never got their own section. A routed brief that states an hours clause keeps
// its routed family (here the fixture's `ownedsite`) when the composed plan has no block that shows hours.
test('auto: a routed brief that states its hours keeps its family when no planned block shows hours', async () => {
  const seen: Array<{ spine?: string }> = [];
  const brief = `${BRIEF} Hours: Monday-Friday 9am-5pm.`;
  const result = await buildSite(
    input({ composition: 'auto', brief }),
    deps({ createJevRouter: () => ({ route: async () => routed('PA') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 }), seen) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.family, 'ownedsite');
  assert.equal(result.report.composition?.used, 'family');
  assert.equal(result.report.composition?.fallback, 'hours-not-covered');
});

test('auto: a brief with no hours clause still composes as before', async () => {
  const result = await buildSite(
    input({ composition: 'auto' }),
    deps({ createJevRouter: () => ({ route: async () => routed('PA') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 })) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.composition?.used, 'blocks');
});

test('planShowsHours matches whole kind words only', () => {
  const catalog = (kind: string): BlockCatalog => ({ blocks: [{ id: 'b', title: 'B', sectionKind: kind } as BlockCatalog['blocks'][number]] });
  const plan = { spine: 'PA', directionId: 'tech-utility', blocks: ['b'] };
  for (const kind of ['hours', 'Hours', 'visit', 'location', 'hours-location', 'visit_block']) assert.equal(planShowsHours(catalog(kind), plan), true, kind);
  for (const kind of ['visitor', 'relocation', 'hero', 'site-visitors', '']) assert.equal(planShowsHours(catalog(kind), plan), false, kind);
});

test('auto: a plan whose block shows hours still composes for a brief that states its hours', async () => {
  const brief = `${BRIEF} Hours: Monday-Friday 9am-5pm.`;
  const real = await input().loadBlockCatalog!();
  // Re-kind the plan's last block as an hours section: the gate must let this plan compose.
  const loadBlockCatalog = async () => ({ blocks: [...real.blocks.map((entry) => (entry.id === PLAN.blocks[2] ? { ...entry, sectionKind: 'hours-location' } : entry)), { ...real.blocks[2]!, id: 'test:closing-coverage', sectionKind: 'cta-band' }] });
  const result = await buildSite(
    input({ composition: 'auto', brief, loadBlockCatalog }),
    deps({ createJevRouter: () => ({ route: async () => routed('PA') }), createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 })) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.composition?.used, 'blocks');
});

test('blocks: an explicit blocks build is never turned into hours-not-covered', async () => {
  const brief = `${BRIEF} Hours: Monday-Friday 9am-5pm.`;
  const result = await buildSite(input({ composition: 'blocks', brief }), deps({ createBlockPlanner: planner(() => ({ plan: PLAN, confidence: 0.9, ms: 1, calls: 1 })) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.composition?.used, 'blocks');
  assert.notEqual(result.report.composition?.fallback, 'hours-not-covered');
});

const KIT_TOKENS = ':root { --bg: #edf0ed; --surface: #f6f7f6; --fg: #171d1d; --muted: #4a5050; --border: rgba(23, 29, 29, .10); --accent: #eb461f; --font-display: "Newsreader", Georgia, serif; --font-body: "Instrument Sans", Arial, sans-serif; }';
const designKit = () => ({ id: 'user:atlas-test', title: 'Atlas test', revision: 'a'.repeat(64), direction: kitDirection(KIT_TOKENS, { id: 'user:atlas-test', title: 'Atlas test' }) });

test('a picked design kit styles the composed page instead of the planner\'s direction, and says so', async () => {
  const events: BuildEvent[] = [];
  const kit = designKit();
  const result = await buildSite(input({ composition: 'blocks', designKit: kit, onEvent: (event) => events.push(event) }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  const html = result.report.html;
  assert.match(html, /data-od-direction="kit:user:atlas-test"/u);
  assert.ok(html.includes(`--role-background:${kit.direction.palette.bg}`), 'the page background is the kit\'s');
  assert.ok(html.includes('--role-font-display:"Newsreader", Georgia, serif'), 'the display face is the kit\'s');
  assert.ok(!html.includes('data-od-direction="tech-utility"'), 'the planner\'s built-in direction is not used');
  // The plan keeps the planner's direction id, so a fork replays the same plan.
  assert.equal(result.report.composition?.directionId, PLAN.directionId);
  assert.deepEqual(result.report.composition?.designKit, { id: 'user:atlas-test', title: 'Atlas test', applied: true });
  const event = events.find((candidate) => candidate.type === 'composition');
  assert.ok(event?.type === 'composition');
  assert.deepEqual(event.result.designKit, { id: 'user:atlas-test', title: 'Atlas test', applied: true });
});

test('a picked design kit on a build that ends on the family route is reported as not applied', async () => {
  const result = await buildSite(input({ composition: 'auto', designKit: designKit() }), deps({ createJevRouter: () => ({ route: async () => routed('CO') }) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.family, 'ownedsite');
  assert.deepEqual(result.report.composition, { requested: 'auto', used: 'family', fallback: 'no-coverage', designKit: { id: 'user:atlas-test', title: 'Atlas test', applied: false } });
});

// R4 (Devin, 2026-10-10): every SaaS brief composed a plan with the modern bento block and failed
// RENDER_QUALITY_FAILED (form-labels): the block carries a decorative, unlabelled range slider.
test('an explicit plan naming a removed vendor block is refused before publication', async () => {
  const plan = { spine: 'PA', directionId: 'modern-minimal', blocks: ['hyperui:marketing/sections/1', 'cult:bento-modern', 'hyperui:marketing/ctas/1'] };
  const calls: Call[] = [];
  await assert.rejects(buildSite(input({ composition: 'blocks', blockPlan: plan }), deps({ createBlockPlanner: planner(() => ({ plan, confidence: 0.9, ms: 1, calls: 1 })), daemonFetch: fakeDaemon(calls) })), /plan-no-longer-applies:.*cult:bento-modern is not an insertable catalog block/);
  assert.equal(calls.length, 0);
});

test('only the modern bento block\'s known slider is marked decorative; other controls are untouched', async () => {
  const { markDecorativeBentoSlider } = await import('../src/block-compose.ts');
  // Not the bento block: nothing changes, even for disabled-looking text inside attributes.
  assert.equal(markDecorativeBentoSlider('cult:marketing-hero-input', '<input placeholder="temporarily disabled field">'), '<input placeholder="temporarily disabled field">');
  assert.equal(markDecorativeBentoSlider('cult:marketing-hero-input', '<input type="range" disabled>'), '<input type="range" disabled>');
});

test('the real public catalog composes a HyperUI page that passes render quality', async () => {
  const result = await buildSite(input({ composition: 'blocks', blockPlan: PLAN, loadBlockCatalog: loadBlockCatalogFromSource }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(selected(result.report.html), PLAN.blocks);
  assert.equal(result.report.composition?.used, 'blocks');
  assert.equal(result.report.renderQuality?.passed, true);
});
