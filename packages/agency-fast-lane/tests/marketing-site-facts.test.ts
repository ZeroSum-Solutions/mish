/**
 * marketing-site first-pass faithfulness (C10 run 3: 19 of 317 slots flagged on the first pass,
 * 5.99 % against a bar of 5 %). The flags came from three places, each fixed at the source:
 *
 * - testimonials: briefs ASK for them ("a testimonial from a Dallas-based developer") without
 *   giving one, and the fill invented names, roles and quotes. The section now carries
 *   `x-optional.requires: "quote"`, so a brief that quotes no one drops it before the fill.
 * - footer links: nine required link labels made the fill invent neighbourhoods and pages ("West
 *   End", "Accreditation"). Each link is now a nullable atom the prompt names in NULLABLE.
 * - hero, features, cta: invented counts and results ("30 families face eviction each month"),
 *   primed by a reference template full of them. The template copy now states no number, and
 *   the prompt says a request for a fact is not the fact.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildSite, type BuildDeps, type BuildEvent } from '../src/build.ts';
import { loadFamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import type { SectionJudge } from '../src/sections.ts';
import { isObject, mockPathsFor, editableTemplate, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, promptBlock, type Filler } from './fixtures.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-marketing-site'), 'marketing-site');
const ENTRY = 'marketing-site-r1.html';
/** A thin brief of the C10 kind: it asks for testimonials, results and a start date, and gives none. */
const BRIEF = 'Ashgrove Language Academy teaches adult Spanish and French in Boston. Show testimonials from students, say how many graduates reach fluency, and close with the next cohort start date.';

/** Digits, currency, and quotation marks: the fact-like marks a copy slot must not carry. */
const FACT_LIKE = /[0-9$€£"“”]/;

/** Every string leaf of `value` with its path label. */
function leaves(value: Json | undefined, at = '', out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${at}[${index}]`, out));
  else if (isObject(value)) for (const [key, child] of Object.entries(value)) leaves(child, at ? `${at}.${key}` : key, out);
  return out;
}

/** A model that follows the prompt: null for NULLABLE footer links, the sample kept, neutral copy elsewhere. */
const obedientFill: Filler = (key, value, at, limit) => {
  if (key === 'links') return null;
  if (/^items\[\d\]\.(name|price|period|features|cta)/.test(at)) return value;
  const text = `Ashgrove ${key}`;
  return typeof limit === 'number' ? text.slice(0, limit) : text;
};

function deps(model: ReturnType<typeof fakeModel>, asked: string[][], checked: string[]): BuildDeps {
  const keepAll: SectionJudge = { judge: async ({ optional }) => { asked.push(optional.map((section) => section.id)); return { dropped: [], kept: optional.map((section) => section.id), warnings: [], ms: 1, calls: 1 }; } };
  const checker: FaithfulnessChecker = { checkFaithfulness: async ({ slots }: { slots: FaithfulnessSlot[] }) => { checked.push(...slots.map((slot) => slot.path)); return { flagged: [], ms: 1, calls: 1 }; } };
  return {
    createModelCaller: () => model,
    createJevChecker: () => checker,
    createJevRouter: () => { throw new Error('no routing in this test'); },
    createSectionJudge: () => keepAll,
    resolveJevCredential: async () => 'fake-jev-key',
    resolveModelKey: async () => 'fake-model-key',
    daemonFetch: (async () => { throw new Error('a dry run never reaches the daemon'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
  };
}

test('the reference copy the fill imitates states no number, price or quote outside the sample slots', () => {
  const template = editableTemplate(pkg.fixture)!;
  const samples = mockPathsFor(pkg.schema, template);
  const proof = /^sections\[2\]/;
  const offending = leaves(template).filter(([at, text]) => !samples.has(at) && !proof.test(at) && FACT_LIKE.test(text));
  assert.deepEqual(offending, [], 'hero, features, cta and footer copy carry no fact-like value to copy the shape of');
});

test('a thin brief: no testimonials, footer links offered as null, and zero fact-like values the brief lacks', async () => {
  const model = fakeModel({ fill: obedientFill });
  const asked: string[][] = [];
  const checked: string[] = [];
  const events: BuildEvent[] = [];
  const result = await buildSite({
    brief: BRIEF, family: 'marketing-site', mode: 'sections', revision: 1, verify: 'advisory',
    prepare: async () => ({ pkg, entry: ENTRY, lockPaths: ['brand.name'] }),
    onEvent: (event) => events.push(event),
  }, deps(model, asked, checked));
  assert.equal(result.outcome, 'built');
  const report = (result as Extract<typeof result, { outcome: 'built' }>).report;

  // Testimonials: dropped up front, never asked for, never checked, never rendered.
  assert.deepEqual(asked, [], 'no keep/drop question: the brief quotes no one');
  assert.deepEqual(report.droppedSections, ['marketing-site-proof']);
  assert.equal((report.recipe as JsonObject & { sections: Json[] }).sections[2], null);
  assert.ok(!model.prompts.some((prompt) => prompt.includes('"marketing-site-proof"')));
  assert.ok(!checked.some((slot) => slot.startsWith('sections[2]')));
  assert.ok(!report.html.includes('id="marketing-site-proof"'));

  // Every fill prompt says a request for a fact is not the fact.
  for (const prompt of model.prompts) assert.ok(prompt.includes('A brief that asks for a fact without giving it does not state it.'));

  // Footer links: named in NULLABLE with the fact they hold; a null link renders nothing.
  const footerPrompt = model.prompts.find((prompt) => prompt.includes('Fill the "marketing-site-footer" part'))!;
  assert.ok(footerPrompt.includes('"page-or-service-named-in-brief"'), 'the footer prompt names the link kind');
  assert.ok(!report.html.includes('data-od-id="marketing-site-footer--columns-'), 'no footer column over no link');
  assert.equal(report.nulled.filter((at) => /^sections\[5\]\.items\.columns\[\d\]\.links\[\d\]$/.test(at)).length, 9);

  // No fact-like value the brief does not state, anywhere outside the illustrative pricing.
  const samples = mockPathsFor(pkg.schema, report.recipe);
  const invented = leaves(report.recipe)
    .filter(([at]) => !samples.has(at) && !/\.(id|type|family)$|^family$|^sections\[\d\]\.(id|type)$/.test(at))
    .filter(([, text]) => (text.match(/[0-9]+|[$€£]|["“”]/g) ?? []).some((mark) => !BRIEF.includes(mark)));
  assert.deepEqual(invented, []);
});

/** A model that ignores the prompt: counts and a result in the copy, invented footer pages, and a
 * testimonial if it is ever asked for one. */
const disobedientFill: Filler = (key, value, at, limit) => {
  if (/^items\[\d\]\.(name|price|period|features|cta)/.test(at)) return value;
  const text = key === 'links' ? 'West End' : key === 'quote' ? 'Best school in Boston, 10 out of 10' : `Ashgrove ${key}: 30 graduates reach fluency by week 8`;
  return typeof limit === 'number' ? text.slice(0, limit) : text;
};

/** A stand-in for Jev: flags every slot carrying a number the brief does not state. */
function numberChecker(checked: string[]): FaithfulnessChecker {
  return {
    checkFaithfulness: async ({ slots }: { slots: FaithfulnessSlot[] }) => {
      checked.push(...slots.map((slot) => slot.path));
      const flagged = slots.filter((slot) => (slot.text.match(/[0-9]+/g) ?? []).some((digits) => !BRIEF.includes(digits))).map((slot) => ({ path: slot.path, probability: 0.95 }));
      return { flagged, ms: 1, calls: 1 };
    },
  };
}

test('a model that ignores the rules: invented counts fail the strict gate, and no testimonial is ever asked for', async () => {
  const model = fakeModel({ fill: disobedientFill });
  const asked: string[][] = [];
  const checked: string[] = [];
  const base = deps(model, asked, checked);
  const result = await buildSite({
    brief: BRIEF, family: 'marketing-site', mode: 'sections', revision: 1, verify: 'strict',
    prepare: async () => ({ pkg, entry: ENTRY, lockPaths: ['brand.name'] }),
  }, { ...base, createJevChecker: () => numberChecker(checked) });
  assert.equal(result.outcome, 'built');
  const report = (result as Extract<typeof result, { outcome: 'built' }>).report;
  assert.equal(report.strict?.passed, false, 'the invented counts survive repair, so strict refuses the page');
  assert.match(report.strict?.reason ?? '', /^unresolved: /);
  assert.equal(result.projectId, undefined, 'nothing is published');
  assert.ok(checked.some((slot) => slot.startsWith('sections[0].text.')), 'the hero copy was checked, not skipped');
  // The testimonial the model would invent never gets the chance: the section is dropped first.
  assert.ok(!model.prompts.some((prompt) => prompt.includes('"marketing-site-proof"')));
  assert.ok(!report.html.includes('Best school in Boston'));
});
