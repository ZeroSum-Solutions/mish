/**
 * Effects through `runFastLane` and `buildSite` (`src/run.ts`, `src/build.ts`): the plan reaches
 * every render, the published page carries it, the selected section composes first, and the
 * report says what applied. The family compiler's own decoration is agent-independent here: a
 * wrapped watson package records each plan it is handed and returns a synthetic
 * `EffectRenderReport`, the shape the shared compiler's `renderFamily` returns.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSite, type BuildDeps, type BuildEvent, type BuildInput } from '../src/build.ts';
import { createJevEffectJudge, type EffectCatalog, type EffectPlan, type FamilyEffectDeclaration } from '../src/effects.ts';
import { loadFamilyPackage, type FamilyPackage, type RenderResult } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { runFastLane } from '../src/run.ts';
import { fakeJevChecker, fakeModel, WATSON_DIR, type Filler } from './fixtures.ts';

const ENTRY = 'watson-r1.html';
const BRIEF = 'Watson, a design and technology studio in Los Angeles. Brand, product and motion work for ambitious teams.';
const NULLABLE_ATOMS = ['awardCaption', 'businessEmail', 'jobsEmail', 'addressFirst', 'addressSecond', 'phone'];
const watsonFill: Filler = (key, _value, _at, limit) => (NULLABLE_ATOMS.includes(key) ? null : `New ${key} for Watson`.slice(0, limit ?? Infinity));

const DECLARATION: FamilyEffectDeclaration = {
  scriptPolicy: 'inline',
  maxEffects: 2,
  placements: {
    'hero-title': { host: { id: 'watson-hero' }, allow: ['shiny-text'] },
    'card-surface': { host: { id: 'watson-ui-home' }, allow: ['glass-surface'] },
  },
};

const CATALOG: EffectCatalog = {
  components: [
    { id: 'shiny-text', name: 'Shiny Text', category: 'text', kind: 'css-only', source: { description: 'A light sweep across text.' } },
    { id: 'glass-surface', name: 'Glass Surface', category: 'surface', kind: 'css-only', source: { description: 'Frosted glass panel.' } },
  ],
};

/** Watson with a declaration, whose render records every plan and marks the page for each item. */
async function effectsWatson(): Promise<{ pkg: FamilyPackage; plans: Array<EffectPlan | undefined> }> {
  const base = await loadFamilyPackage(WATSON_DIR, 'watson');
  const plans: Array<EffectPlan | undefined> = [];
  const render = (input: Parameters<FamilyPackage['render']>[0], entry: string, options?: { effects?: EffectPlan }): RenderResult => {
    plans.push(options?.effects);
    const result = base.render(input, entry);
    if (!options?.effects) return result;
    const applied = options.effects.effects.map((item) => ({ ...item, kind: 'css-only' as const }));
    const markers = applied.map((item) => `<i data-genui="${item.componentId}" data-effect-placement="${item.placement}"></i>`).join('');
    const at = result.html.lastIndexOf('</body>');
    const html = `${result.html.slice(0, at)}${markers}${result.html.slice(at)}`;
    return { ...result, html, effects: { applied, skipped: [], bytesAdded: Buffer.byteLength(markers) } };
  };
  return { pkg: { ...base, effects: DECLARATION, render }, plans };
}

function recordingPublisher(): ProjectPublisher & { pages: string[] } {
  const pages: string[] = [];
  return {
    projectId: 'p1',
    pages,
    async savePage(_entry, html) {
      pages.push(html);
    },
    async saveFile() {},
    async deleteProject() {
      return 'deleted' as const;
    },
  };
}

const HINT_PLAN: EffectPlan = { effects: [{ placement: 'hero-title', componentId: 'shiny-text', source: 'hint' }] };

test('runFastLane: the plan reaches every render and the strict publish carries it', async () => {
  const { pkg, plans } = await effectsWatson();
  const publisher = recordingPublisher();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model: fakeModel({ fill: watsonFill }),
    modelName: 'fake',
    lockPaths: ['brand.name'],
    verify: fakeJevChecker(),
    strict: true,
    ensurePublisher: async () => ({ publisher, created: true }),
    effects: HINT_PLAN,
    effectsDecision: { mode: 'explicit', applied: [], skipped: [{ placement: 'card-surface', reason: 'none' }], bytesAdded: 0 },
  });
  assert.ok(plans.length > 1, 'the spine render and the fill renders all ran');
  assert.ok(plans.every((plan) => plan === HINT_PLAN), 'every render got the plan');
  assert.equal(publisher.pages.length, 1);
  assert.ok(publisher.pages[0]!.includes('data-genui="shiny-text"'));
  assert.ok(report.html.includes('data-genui="shiny-text"'));
  assert.deepEqual(report.effects, {
    mode: 'explicit',
    applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' }],
    skipped: [{ placement: 'card-surface', reason: 'none' }],
    bytesAdded: Buffer.byteLength('<i data-genui="shiny-text" data-effect-placement="hero-title"></i>'),
  });
});

test('runFastLane: progressive paints carry the plan too', async () => {
  const { pkg: watson } = await effectsWatson();
  // The save queue waits for the asset upload before its first paint and coalesces renders that
  // arrive meanwhile, so a disk read slower than the fake model's whole fill (seen on CI) left one
  // page. Assets from memory settle in microtasks, before the first fill lands: every paint the
  // run makes is then a separate save, whatever the disk speed.
  const pkg: FamilyPackage = { ...watson, readAsset: async () => Buffer.alloc(0) };
  const publisher = recordingPublisher();
  await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: fakeModel({ fill: watsonFill }), modelName: 'fake', lockPaths: ['brand.name'], publisher, effects: HINT_PLAN });
  assert.ok(publisher.pages.length > 1);
  assert.ok(publisher.pages.every((html) => html.includes('data-genui="shiny-text"')));
});

test('runFastLane: with a selected section, the section composes and the final render still carries the plan', async () => {
  const { pkg, plans } = await effectsWatson();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model: fakeModel({ fill: watsonFill }),
    modelName: 'fake',
    lockPaths: ['brand.name'],
    sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'watson-hero' }, directionId: 'modern-minimal' },
    effects: HINT_PLAN,
  });
  assert.ok(report.html.includes('data-od-selected-section="hyperui:marketing/ctas/1"'));
  assert.ok(report.html.includes('data-genui="shiny-text"'));
  assert.equal(plans.at(-1), HINT_PLAN, 'the composing render was handed the plan');
  assert.equal(report.effects?.applied.length, 1);
});

test('runFastLane: no plan, no effects on the page and no report field', async () => {
  const { pkg, plans } = await effectsWatson();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model: fakeModel({ fill: watsonFill }), modelName: 'fake', lockPaths: ['brand.name'] });
  assert.ok(plans.every((plan) => plan === undefined));
  assert.equal(report.html.includes('data-genui="shiny-text"'), false);
  assert.equal(report.effects, undefined);
});

// ---------------------------------------------------------------------------------------------
// buildSite
// ---------------------------------------------------------------------------------------------

function input(pkg: FamilyPackage, overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    brief: BRIEF,
    family: 'watson',
    mode: 'single',
    revision: 1,
    verify: 'off',
    provider: 'deepseek',
    fallbackProvider: null,
    effectCatalog: CATALOG,
    prepare: async () => ({ pkg, entry: ENTRY, lockPaths: ['brand.name'] }),
    ...overrides,
  };
}

function deps(overrides: Partial<BuildDeps> = {}): BuildDeps {
  return {
    createModelCaller: () => fakeModel({ fill: watsonFill }),
    createJevChecker: () => fakeJevChecker(),
    createJevRouter: () => { throw new Error('not routed in these tests'); },
    resolveJevCredential: async () => 'fake-jev-key',
    resolveModelKey: async () => 'fake-model-key',
    daemonFetch: (async () => { throw new Error('dry run: no daemon'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
    ...overrides,
  };
}

const effectsEvents = (events: BuildEvent[]) => events.filter((event): event is Extract<BuildEvent, { type: 'effects' }> => event.type === 'effects');

test('buildSite: auto asks Jev once, applies its pick, and reports it', async () => {
  const { pkg } = await effectsWatson();
  const events: BuildEvent[] = [];
  let sent: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)).questions;
    return new Response(JSON.stringify({ answers: {
      effect_hero_title: { type: 'choice', choice: 'shiny-text', confidence: 0.92, probabilities: { 'shiny-text': 0.92 } },
      effect_card_surface: { type: 'choice', choice: 'none', confidence: 0.8, probabilities: { none: 0.8 } },
    } }), { status: 200 });
  }) as typeof fetch;
  const result = await buildSite(input(pkg, { onEvent: (event) => events.push(event) }), deps({ createEffectJudge: (options) => createJevEffectJudge({ ...options, fetchImpl }) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(Object.keys(sent!).sort(), ['effect_card_surface', 'effect_hero_title']);
  assert.ok(result.report.html.includes('data-genui="shiny-text"'));
  assert.equal(result.report.effects?.mode, 'auto');
  assert.deepEqual(result.report.effects?.applied.map((item) => `${item.placement}:${item.componentId}:${item.source}`), ['hero-title:shiny-text:jev']);
  assert.deepEqual(result.report.effects?.skipped, [{ placement: 'card-surface', reason: 'none' }]);
  const [event] = effectsEvents(events);
  assert.equal(effectsEvents(events).length, 1);
  assert.equal(event!.applied, 1);
  assert.equal(event!.skipped, 1);
  // Ids, counts and codes only: no criteria prose, no brief, no answer body.
  const surfaced = JSON.stringify([result.report.effects, effectsEvents(events)]);
  for (const text of ['Shiny Text', 'light sweep', 'Watson, a design', 'probabilities', 'confidence']) assert.equal(surfaced.includes(text), false, text);
});

test('buildSite: Jev down yields zero effects, the fixed code, and a built page', async () => {
  const { pkg, plans } = await effectsWatson();
  const fetchImpl = (async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND secret-host'); }) as typeof fetch;
  const events: BuildEvent[] = [];
  const result = await buildSite(input(pkg, { onEvent: (event) => events.push(event) }), deps({ createEffectJudge: (options) => createJevEffectJudge({ ...options, fetchImpl }) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(result.report.effects, { mode: 'auto', applied: [], skipped: [], jevSkipped: 'jev-unreachable', bytesAdded: 0 });
  assert.equal(result.report.html.includes('data-effect-placement='), false);
  assert.ok(plans.every((plan) => plan === undefined || plan.effects.length === 0));
  assert.equal(JSON.stringify(events).includes('secret-host'), false);
  assert.deepEqual(effectsEvents(events).map((event) => [event.applied, event.skipped]), [[0, 0]]);
});

test('buildSite: a missing Jev key under verify off is jev-key-missing, not a failed build', async () => {
  const { pkg } = await effectsWatson();
  const result = await buildSite(input(pkg), deps({ resolveJevCredential: async () => { throw new Error('no credential'); }, createEffectJudge: createJevEffectJudge }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.effects?.jevSkipped, 'jev-key-missing');
  assert.deepEqual(result.report.effects?.applied, []);
});

test('buildSite: off yields mode off, never asks, and hands no plan to the compiler', async () => {
  const { pkg, plans } = await effectsWatson();
  let asked = 0;
  const result = await buildSite(input(pkg, { effects: 'off' }), deps({ createEffectJudge: () => ({ judge: async () => { asked += 1; return { picks: [], skipped: [], ms: 0, calls: 1 }; } }) }));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(asked, 0);
  assert.deepEqual(result.report.effects, { mode: 'off', applied: [], skipped: [], bytesAdded: 0 });
  assert.ok(plans.every((plan) => plan === undefined));
});

test('buildSite: a family with no placements defaults to off and emits no effects event', async () => {
  const { pkg } = await effectsWatson();
  const events: BuildEvent[] = [];
  const result = await buildSite(input({ ...pkg, effects: null }, { onEvent: (event) => events.push(event) }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.effects?.mode, 'off');
  assert.equal(effectsEvents(events).length, 0);
});

test('buildSite: explicit ids apply without Jev and unlisted placements stay auto', async () => {
  const { pkg } = await effectsWatson();
  const asked: string[][] = [];
  const result = await buildSite(
    input(pkg, { effects: { 'card-surface': 'glass-surface' } }),
    deps({ createEffectJudge: () => ({ judge: async ({ placements }) => { asked.push([...placements]); return { picks: [], skipped: [], ms: 0, calls: 1 }; } }) }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  // One effect already fills an unknown skin's cap, so the rest is never asked.
  assert.deepEqual(asked, []);
  assert.equal(result.report.effects?.mode, 'explicit');
  assert.deepEqual(result.report.effects?.applied.map((item) => item.componentId), ['glass-surface']);
  assert.ok(result.report.html.includes('data-genui="glass-surface"'));
});

test('buildSite: under verify strict, a failed effect judge leaves the faithfulness check running and passing', async () => {
  const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const run = async (effects: BuildInput['effects']) => {
    const { pkg } = await effectsWatson();
    const checker = fakeJevChecker();
    const result = await buildSite(
      input(pkg, { verify: 'strict', ...(effects ? { effects } : {}) }),
      deps({ createJevChecker: () => checker, createEffectJudge: (options) => createJevEffectJudge({ ...options, fetchImpl: unreachable }) }),
    );
    assert.equal(result.outcome, 'built');
    if (result.outcome !== 'built') throw new Error('not built');
    return { report: result.report, checks: checker.calls };
  };
  const failed = await run(undefined);
  assert.equal(failed.report.effects?.jevSkipped, 'jev-unreachable');
  assert.deepEqual(failed.report.effects?.applied, []);
  assert.ok(failed.checks > 0, 'the faithfulness check ran');
  assert.deepEqual(failed.report.strict, { passed: true, checked: failed.report.verify!.checked });
  assert.deepEqual(failed.report.verify?.remaining, []);
  // The same build with effects off: an identical faithfulness result.
  const off = await run('off');
  assert.deepEqual(
    { checked: failed.report.verify?.checked, flagged: failed.report.verify?.flagged, remaining: failed.report.verify?.remaining, strict: failed.report.strict },
    { checked: off.report.verify?.checked, flagged: off.report.verify?.flagged, remaining: off.report.verify?.remaining, strict: off.report.strict },
  );
});

test('buildSite: when every placement is hinted, the effect judge is never called', async () => {
  const { pkg } = await effectsWatson();
  let created = 0;
  let judged = 0;
  const result = await buildSite(
    input(pkg, { effects: { 'hero-title': 'shiny-text', 'card-surface': 'none' } }),
    deps({ createEffectJudge: () => { created += 1; return { judge: async () => { judged += 1; return { picks: [], skipped: [], ms: 0, calls: 1 }; } }; } }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(judged, 0, 'no Jev effect request');
  assert.ok(created <= 1);
  assert.equal(result.report.effects?.mode, 'explicit');
  assert.deepEqual(result.report.effects?.applied.map((item) => `${item.placement}:${item.source}`), ['hero-title:hint']);
});

test('buildSite: effectsReplay reports the replayed ids with source repair', async () => {
  const { pkg } = await effectsWatson();
  const result = await buildSite(input(pkg, { effects: { 'hero-title': 'shiny-text', 'card-surface': 'none' }, effectsReplay: true }), deps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.deepEqual(result.report.effects?.applied.map((item) => `${item.placement}:${item.source}`), ['hero-title:repair']);
});
