/**
 * `runFastLane`'s `sectionSelection`/`designReference` options end to end (`src/run.ts`,
 * `src/section-overlay.ts`) — design decision §2/§3
 * (<private-notes>/mishh-genui-production/motionsites/sol-design.md).
 * The family fill itself is exercised by `run.test.ts`; this file is about the overlay only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCall } from '../src/deepseek.ts';
import { loadFamilyPackage } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { runFastLane } from '../src/run.ts';
import { SectionSelectionRefusedError } from '../src/section-overlay.ts';
import { fakeJevChecker, fakeModel, promptBlock, TEST_EDITORIAL_DIR, type Filler } from './fixtures.ts';

const loadTestEditorial = () => loadFamilyPackage(TEST_EDITORIAL_DIR, 'ownededitorial');
const ENTRY = 'ownededitorial-r1.html';
const BRIEF = 'TestEditorial, a design and technology studio in Los Angeles. Brand, product and motion work for ambitious teams.';

type Save = { kind: 'page' | 'file'; name: string };

/** Records every write, so a "strict blocks publish" assertion has something concrete to prove
 * empty rather than being vacuous on the no-publish axis (delta re-audit, tests packet #12). */
function recordingPublisher(): ProjectPublisher & { saves: Save[] } {
  const saves: Save[] = [];
  return {
    projectId: 'p1',
    saves,
    async savePage(entry) {
      saves.push({ kind: 'page', name: entry });
    },
    async saveFile(name) {
      saves.push({ kind: 'file', name });
    },
    async deleteProject() {
      return 'deleted' as const;
    },
  };
}

// ownededitorial's nullable contact/award atoms (`TEST_EDITORIAL_NULLABLE_ATOMS` in slots.ts): a plain honest
// fill would invent an email/phone/address the brief does not state, which the family compiler's
// own format checks correctly refuse. Answer them null instead — exactly what a real model does
// for a fact the brief does not carry. Every other ownededitorial content key is a required plain string.
const NULLABLE_ATOMS = ['awardCaption', 'businessEmail', 'jobsEmail', 'addressFirst', 'addressSecond', 'phone'];
const ownededitorialFill: Filler = (key, _value, _at, limit) => (NULLABLE_ATOMS.includes(key) ? null : `New ${key} for TestEditorial`.slice(0, limit ?? Infinity));
const ownededitorialModel = () => fakeModel({ fill: ownededitorialFill });

/** Delegates to a ownededitorial-safe fill for every unit except section-fill calls (labeled
 * `section:<adapterId>`), which this test fabricates ON EVERY ATTEMPT (first pass and every
 * faithfulness-repair round alike, unlike `fakeModel`'s own repair path, which defaults back to
 * an honest fill once it sees a rejection prompt) — the point of this fake is to exercise "the
 * fabrication survives every repair round", not just the first round. */
function modelFabricatingSection(adapterId: string): ModelCall & { prompts: string[] } {
  const base = ownededitorialModel();
  const prompts: string[] = [];
  const call = (async (request) => {
    prompts.push(request.user);
    if (request.label !== `section:${adapterId}`) return base(request);
    const template = promptBlock(request.user, 'TEMPLATE') as { text: Record<string, string> };
    const answer: { text: Record<string, string> } = { text: {} };
    for (const key of Object.keys(template.text)) answer.text[key] = 'FABRICATED always';
    const text = JSON.stringify(answer);
    return { text, usage: { input: 10, output: 5, cachedRead: 0 }, ms: 1, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

test('sectionSelection: composes the chosen section into the published page and reports it', async () => {
  const pkg = await loadTestEditorial();
  const model = ownededitorialModel();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    lockPaths: ['brand.name'],
    sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' }, directionId: 'modern-minimal' },
  });
  assert.equal(report.sectionOverlay?.entryId, 'hyperui:marketing/ctas/1');
  assert.equal(report.sectionOverlay?.directionId, 'modern-minimal');
  assert.deepEqual(report.sectionOverlay?.remaining, []);
  assert.ok(report.html.includes('data-od-selected-section="hyperui:marketing/ctas/1"'));
  assert.ok(report.html.indexOf('data-od-selected-section') > report.html.indexOf('id="ownededitorial-hero"'));
  assert(report.html.includes('href="#ownededitorial-footer"'), 'adapter contact action resolves to the actual family footer');
  assert(!report.html.includes('href="#contact"'), 'no unresolved adapter fallback');
  assert.equal(report.renderQuality?.passed, true);
  // The published/reported digest is the composed one (base + selection + adapter + direction),
  // not the bare family digest — proven by re-rendering the SAME recipe through the unwrapped
  // package and finding a different digest.
  const bareDigest = pkg.render(report.recipe, ENTRY).manifest.metadata.agencySite.recipeDigest;
  assert.notEqual(report.recipeDigest, bareDigest);
  assert.equal(report.manifest.metadata.agencySite.recipeDigest, report.recipeDigest);
  // The recipe itself carries no trace of the selection — the family validator never saw one.
  assert.equal(JSON.stringify(report.recipe).includes('sectionSelection'), false);
  assert.equal(JSON.stringify(report.recipe).includes('hyperui:marketing'), false);
});

test('sectionSelection: an unknown entry id fails the whole run before any publish', async () => {
  const pkg = await loadTestEditorial();
  const model = ownededitorialModel();
  await assert.rejects(
    runFastLane({
      pkg,
      brief: BRIEF,
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model,
      modelName: 'fake',
    lockPaths: ['brand.name'],
      sectionSelection: { entryId: 'hyperui:marketing/no-such-block/9', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' }, directionId: 'modern-minimal' },
    }),
    SectionSelectionRefusedError,
  );
});

test('sectionSelection: an absent anchor fails fast, before spending any fill effort on the base recipe', async () => {
  const pkg = await loadTestEditorial();
  const model = ownededitorialModel();
  await assert.rejects(
    runFastLane({
      pkg,
      brief: BRIEF,
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model,
      modelName: 'fake',
    lockPaths: ['brand.name'],
      sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-nowhere' }, directionId: 'modern-minimal' },
    }),
    SectionSelectionRefusedError,
  );
  assert.equal(model.prompts.length, 0, 'no model call should be made once the anchor check fails');
});

test('sectionSelection: replace-optional drops the family section first (required-section validation is never bypassed)', async () => {
  const pkg = await loadTestEditorial();
  const model = ownededitorialModel();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    lockPaths: ['brand.name'],
    sectionSelection: { entryId: 'hyperui:marketing/sections/1', placement: { mode: 'replace-optional', targetSectionId: 'ownededitorial-about' }, directionId: 'human-approachable' },
  });
  assert.ok(report.droppedSections?.includes('ownededitorial-about'), 'the optional family section must be dropped through the ordinary validated path');
  assert.ok(report.html.includes('data-od-selected-section="hyperui:marketing/sections/1"'));
});

test('sectionSelection: strict blocks publish when the selected section still states an unsupported fact after repair', async () => {
  const pkg = await loadTestEditorial();
  const model = modelFabricatingSection('hyperui:marketing/ctas/1');
  const verify = fakeJevChecker(['FABRICATED']);
  const publisher = recordingPublisher();
  let ensurePublisherCalls = 0;
  await assert.rejects(
    runFastLane({
      pkg,
      brief: BRIEF,
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model,
      modelName: 'fake',
      lockPaths: ['brand.name'],
      verify,
      strict: true,
      ensurePublisher: async () => {
        ensurePublisherCalls += 1;
        return { publisher, created: true };
      },
      sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' }, directionId: 'modern-minimal' },
    }),
    SectionSelectionRefusedError,
  );
  // Not vacuous: `ensurePublisher` is the only path to a real publisher under `strict`, and
  // nothing reaches it before the section fill's own refusal — so no page, asset or state file
  // was ever written.
  assert.equal(ensurePublisherCalls, 0, 'ensurePublisher must never be called once the section fill itself refuses');
  assert.equal(publisher.saves.length, 0, 'no publish (page, asset or state file) may have happened');
});

test('designReference: reaches the section prompt, never the report, never the recipe, never the html', async () => {
  const pkg = await loadTestEditorial();
  const marker = 'ZZ-DESIGN-REFERENCE-MARKER-ZZ';
  const model = ownededitorialModel();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    lockPaths: ['brand.name'],
    designReference: `Editorial layout, tight grid, restrained motion: ${marker}`,
    sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' }, directionId: 'modern-minimal' },
  });
  assert.ok(model.prompts.some((prompt) => prompt.includes(marker)), 'the section fill prompt must carry the design guidance');
  assert.equal(JSON.stringify(report).includes(marker), false, 'designReference must never surface in RunReport');
});

test('sectionSelection (family overlay regression): the selected section is filled with the family policy, not the composed one', async () => {
  const pkg = await loadTestEditorial();
  const base = ownededitorialModel();
  const sectionPrompts: string[] = [];
  const model: ModelCall = async (request) => {
    if (request.label?.startsWith('section:')) sectionPrompts.push(request.user);
    return base(request);
  };
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: ENTRY,
    revision: 1,
    model,
    modelName: 'fake',
    lockPaths: ['brand.name'],
    sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' }, directionId: 'modern-minimal' },
  });
  assert.ok(report.html.includes('data-od-selected-section="hyperui:marketing/ctas/1"'));
  assert.equal(sectionPrompts.length, 1, 'one fill call, no name-cut or shorten request');
  // The composed-only prompt additions stay out of a family build's selected section.
  assert.ok(!sectionPrompts[0]!.includes('BUDGETS'));
  assert.ok(!sectionPrompts[0]!.includes('never shorten, abbreviate or cut a word'));
});
