/**
 * The composed page (`src/block-compose.ts`): real reviewed adapters filled by a fake model,
 * rendered in plan order under one direction, one `<style>`, the family CSP, no scripts, the page
 * byte budget, strict-only publication, and one consistent published plan.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeBlocks,
  COMPOSED_PAGE_CSP,
  ComposedPageTooLargeError,
  CompositionVerifyError,
  contactIndex,
  isComposedRecipe,
  renderWithinBudget,
  type ComposeOptions,
} from '../src/block-compose.ts';
import { fillSectionAdapter, overlayRenderKit, resolveDesignDirection, resolveSectionAdapter, type SectionAdapter } from '../src/section-overlay.ts';
import { RenderQualityError } from '../src/render-quality.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import type { RunEvent } from '../src/run.ts';
import type { ModelCall } from '../src/deepseek.ts';
import type { Json } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, type Filler } from './fixtures.ts';
import { clipWholeWords, isWholeWordPrefix } from '../src/text-clip.ts';
import { publicAdapterText, publicSectionEntryId as pub } from '../src/cult-public-ids.ts';

const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays. Book a visit online.';
const PLAN = {
  spine: 'PA',
  directionId: 'modern-minimal',
  blocks: ['hyperui:marketing/sections/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/ctas/1', 'hyperui:marketing/ctas/1'],
};
const KINDS = ['hero', 'features', 'faq', 'cta-band', 'footer'];

type Saved = { entry?: string; html?: string; manifest?: Json; label: string; file?: string; content?: string };

function fakePublisher(projectId = 'proj-1'): ProjectPublisher & { saves: Saved[]; deleted: number } {
  const publisher = {
    projectId,
    saves: [] as Saved[],
    deleted: 0,
    async savePage(entry: string, html: string, manifest: Json, label: string) { publisher.saves.push({ entry, html, manifest, label }); },
    async saveFile(name: string, content?: string | Uint8Array) { publisher.saves.push({ file: name, label: 'file', ...(typeof content === 'string' ? { content } : {}) }); },
    async deleteProject() { publisher.deleted += 1; return 'deleted' as const; },
  };
  return publisher;
}

/** The default fake copy, kept to whole words like a model that follows BUDGETS: the fixture's own
 * default slices mid-word, which the fill now sends back as a name cut short ("Riverb"). */
const wholeWords: Filler = (key, _value, _at, limit) => {
  const text = `New ${key} for Riverbend Dental`;
  return typeof limit === 'number' ? (clipWholeWords(text, limit) ?? 'New') : text;
};

function options(overrides: Partial<ComposeOptions> = {}): ComposeOptions {
  return {
    plan: PLAN,
    planSource: 'jev',
    requested: 'blocks',
    brief: BRIEF,
    mode: 'sections',
    entry: 'composed-r1.html',
    revision: 1,
    model: fakeModel({ fill: wholeWords }),
    modelName: 'fake-model',
    kinds: KINDS,
    verify: fakeJevChecker(),
    strict: true,
    ...overrides,
  };
}

const selectedIds = (html: string) => [...html.matchAll(/data-od-selected-section="([^"]+)"/g)].map((match) => match[1]);

test('composeBlocks: renders every block in plan order with data-od-selected-section, no removed Cult ids', async () => {
  const events: RunEvent[] = [];
  const report = await composeBlocks(options({ onEvent: (event) => events.push(event) }));
  // The page names Cult blocks by public id; the report and recipe keep the internal ones.
  assert.deepEqual(selectedIds(report.html), PLAN.blocks.map(pub));
  assert.ok(new Set(selectedIds(report.html).filter((id) => id!.startsWith('cult:'))).size === 0);
  assert.equal(report.family, 'composed');
  assert.equal(report.calls, PLAN.blocks.length + 1, 'one fill per block plus the page chrome');
  assert.deepEqual(report.composition, {
    requested: 'blocks', used: 'blocks', spine: 'PA', directionId: 'modern-minimal', blocks: PLAN.blocks, source: 'jev', effects: { mode: 'off', reason: 'no-placements' },
  });
  assert.ok(isComposedRecipe(report.recipe));
  assert.equal(events.filter((event) => event.type === 'unit').length, PLAN.blocks.length + 1);
  // The fixed call-to-action target resolves: the cta band carries id="contact".
  const contactAt = report.html.indexOf('id="contact"');
  assert.ok(contactAt > 0 && report.html.indexOf('data-od-selected-section="hyperui:marketing/ctas/1"') > contactAt);
});

test('composed page promotes only its hero heading, preserving adapter copy, classes, edit slots and CSS', async () => {
  const events: RunEvent[] = [];
  const report = await composeBlocks(options({ onEvent: event => events.push(event) }));
  assert(isComposedRecipe(report.recipe));
  const kit = await overlayRenderKit();
  assert.equal((report.html.match(/<h1\b/g) ?? []).length, 1);
  for (const index of [0, 3]) {
    const adapter = await resolveSectionAdapter(PLAN.blocks[index]!);
    const original = publicAdapterText(adapter.id, kit.renderSectionAdapter(adapter, report.recipe.blocks[index]!));
    const heading = original.match(/<h[12]\b([^>]*)>([\s\S]*?)<\/h[12]\s*>/i)!;
    const expected = `<h${index === 0 ? 1 : 2}${heading[1]}>${heading[2]}</h${index === 0 ? 1 : 2}>`;
    assert(report.html.includes(expected), 'changing heading level preserves all attributes and content');
    assert(report.html.includes(publicAdapterText(adapter.id, adapter.css, 'css')), 'adapter CSS stays complete');
  }
  assert.equal(report.renderQuality?.passed, true);
  assert(events.some(event => event.type === 'render-quality' && event.report.passed));
});

test('a composed page without its semantic hero fails before publisher creation', async () => {
  let publishers = 0;
  const events: RunEvent[] = [];
  await assert.rejects(composeBlocks(options({ kinds: KINDS.map(kind => kind === 'hero' ? 'features' : kind), onEvent: event => events.push(event), ensurePublisher: async () => { publishers++; return { publisher: fakePublisher(), created: true }; } })), error => error instanceof RenderQualityError);
  assert.equal(publishers, 0);
  assert(events.some(event => event.type === 'render-quality' && !event.report.passed));
});

/** Every in-page link target of `html` and every id it defines. */
function anchorsOf(html: string): { hrefs: string[]; ids: string[] } {
  return {
    hrefs: [...html.matchAll(/href="#([^"]*)"/g)].map((match) => match[1]!),
    ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!),
  };
}

test('composeBlocks: every in-page href="#…" resolves to an id on the page, and exactly one element is #contact', async () => {
  const cases: Array<{ blocks: string[]; kinds: string[]; owner: string }> = [
    { blocks: PLAN.blocks, kinds: KINDS, owner: 'hyperui:marketing/ctas/1' },
    // No CTA band: the footer owns #contact.
    { blocks: PLAN.blocks.filter((_id, index) => index !== 3), kinds: KINDS.filter((kind) => kind !== 'cta-band'), owner: 'hyperui:marketing/ctas/1' },
    // HyperUI ctas/1 as the band, and no footer.
    { blocks: ['hyperui:marketing/sections/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/ctas/1'], kinds: ['hero', 'features', 'cta-band'], owner: 'hyperui:marketing/ctas/1' },
    // Neither: the last block owns it.
    { blocks: ['hyperui:marketing/sections/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/feature-grids/1'], kinds: ['hero', 'features', 'faq'], owner: 'hyperui:marketing/feature-grids/1' },
  ];
  for (const { blocks, kinds, owner } of cases) {
    const report = await composeBlocks(options({ plan: { ...PLAN, blocks }, kinds }));
    const { hrefs, ids } = anchorsOf(report.html);
    assert.ok(hrefs.includes('contact'), `${owner}: the page links #contact`);
    for (const href of new Set(hrefs)) assert.ok(ids.includes(href), `${owner}: href="#${href}" resolves`);
    assert.equal(ids.filter((id) => id === 'contact').length, 1, `${owner}: exactly one #contact`);
    assert.equal(new Set(ids).size, ids.length, `${owner}: no duplicate id`);
    assert.match(report.html, new RegExp(`<div id="contact" data-od-section="od-block-\\d+" data-od-selected-section="${pub(owner).replace(/[/:]/g, (c) => `\\${c}`)}"`));
  }
});

test('contactIndex: the CTA band, else the footer, else the last rendered block', () => {
  assert.equal(contactIndex(['hero', 'features', 'cta-band', 'footer'], [1, 1, 1, 1]), 2);
  assert.equal(contactIndex(['hero', 'features', 'cta-band', 'footer'], [1, 1, undefined, 1]), 3, 'a dropped band hands it to the footer');
  assert.equal(contactIndex(['hero', 'features', 'faq'], [1, 1, 1]), 2);
  assert.equal(contactIndex(['hero', 'features', 'footer'], [1, 1, undefined]), 1);
  assert.equal(contactIndex([], []), -1);
});

test('composeBlocks: the saved recipe and state note name Cult blocks by public id, and the saved recipe replays', async () => {
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ ensurePublisher: async () => ({ publisher, created: true }) }));
  const recipeFile = publisher.saves.find((save) => save.file?.endsWith('/recipe.json'))!;
  const note = publisher.saves.find((save) => save.file === 'AGENCY-SITE-STATE.md')!;
  const cultNames = PLAN.blocks.filter((id) => id.startsWith('cult:')).map((id) => id.slice('cult:'.length));
  for (const text of [recipeFile.content!, note.content!]) {
    for (const name of cultNames) assert.ok(!text.includes(name), `a saved file names ${name}`);
  }
  const saved = JSON.parse(recipeFile.content!) as { plan: { blocks: string[] } };
  assert.deepEqual(saved.plan.blocks, PLAN.blocks.map(pub));
  assert.ok(note.content!.includes(PLAN.blocks.map(pub).join(', ')));
  // The digest covers the recipe as saved.
  const page = publisher.saves.find((save) => save.html)!;
  assert.equal((page.manifest as { metadata: { agencySite: { recipeDigest: string } } }).metadata.agencySite.recipeDigest, report.recipeDigest);
  // A saved plan (public ids) and an older one (internal ids) both replay to the same page.
  const fromSaved = await composeBlocks(options({ plan: { ...PLAN, blocks: saved.plan.blocks }, planSource: 'replay' }));
  assert.deepEqual(selectedIds(fromSaved.html), PLAN.blocks.map(pub));
});

test('publicAdapterText swaps only the exact scope and symbol names', () => {
  const css = '.cult-marketing-footer-vercel .a{} .cult-marketing-footer-vercel-x{} #sym-marketing-footer-vercel-3{} .cult-marketing-footer{} marketing-footer-vercel';
  assert.equal(
    publicAdapterText('hyperui:marketing/ctas/1', css, 'css'),
    css,
  );
  assert.equal(publicAdapterText('hyperui:marketing/ctas/1', css), css);
});

test('composeBlocks: one <style>, each adapter\'s CSS once, the family CSP, no script, no remote URL', async () => {
  const report = await composeBlocks(options({ plan: { ...PLAN, blocks: [...PLAN.blocks.slice(0, 2), 'hyperui:marketing/feature-grids/1', ...PLAN.blocks.slice(2)] }, kinds: ['hero', 'features', 'features', 'faq', 'cta-band', 'footer'] }));
  const html = report.html;
  assert.equal(html.match(/<style>/g)?.length, 1, 'exactly one style element');
  for (const id of PLAN.blocks) {
    const adapter = await resolveSectionAdapter(id);
    // As published: the CSS scope names the block by its public id.
    const css = publicAdapterText(adapter.id, adapter.css, 'css');
    if (css.length > 40) assert.equal(html.split(css).length - 1, 1, `${id}'s CSS appears exactly once`);
  }
  // No internal Cult name reaches the page: attribute, section id, class or symbol id.
  for (const id of PLAN.blocks.filter((block) => block.startsWith('cult:'))) {
    assert.ok(!html.includes(id.slice('cult:'.length)), `${id} appears on the page`);
  }
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.equal(csp, COMPOSED_PAGE_CSP);
  assert.ok(csp!.includes("default-src 'none'") && csp!.includes("script-src 'none'"));
  for (const [pattern, what] of [
    [/<script\b/i, 'a <script>'], [/\son[a-z]+\s*=/i, 'an inline handler'], [/https?:\/\//i, 'a remote URL'],
    [/url\(/i, 'a CSS url()'], [/@import/i, 'an @import'], [/javascript:/i, 'a javascript: URL'],
  ] as const) assert.ok(!pattern.test(html), `the page contains ${what}`);
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024);
});

function heroModel(fill: Filler): ModelCall {
  const hero = fakeModel({ fill });
  const base = fakeModel({ fill: wholeWords });
  return request => (request.label === 'section:hyperui:marketing/sections/1' ? hero : base)(request);
}

test('composeBlocks: facts come from the brief only — a fabricated slot is flagged, repaired and never published', async () => {
  let fabricated = 0;
  const fill: Filler = (key, _value, at, limit) => {
    if (at === 'text.heading' && fabricated === 0) {
      fabricated += 1;
      return 'FABRICATED Plans from $49 since 1999';
    }
    return wholeWords(key, _value, at, limit);
  };
  const checker = fakeJevChecker();
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ model: heroModel(fill), verify: checker, strict: true, ensurePublisher: async () => ({ publisher, created: true }) }));
  assert.ok(fabricated > 0, 'the fake did fabricate once');
  assert.ok(report.verify!.flagged.length > 0);
  assert.deepEqual(report.verify!.remaining, []);
  assert.deepEqual(report.strict, { passed: true, checked: report.verify!.checked });
  assert.ok(!report.html.includes('FABRICATED') && !report.html.includes('$49') && !report.html.includes('1999'));
  assert.ok(report.html.includes('Riverbend Dental'));
  assert.equal(publisher.saves.filter((save) => save.html).length, 1, 'strict publishes once, the finished page');
});

test('composeBlocks strict: an unrepaired fabrication publishes nothing and creates no project', async () => {
  const fill: Filler = (key, value, at, limit) => (at === 'text.heading' ? 'FABRICATED forever' : wholeWords(key, value, at, limit));
  const alwaysFabricates = heroModel(fill);
  let ensured = 0;
  const report = await composeBlocks(options({ model: alwaysFabricates, verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0, ensurePublisher: async () => { ensured += 1; return { publisher: fakePublisher(), created: true }; } }));
  assert.equal(report.strict?.passed, false);
  assert.equal(ensured, 0);
  assert.equal(report.projectId, undefined);
});

test('composeBlocks: publishes only after a strict check — any other mode or no checker is refused before any call', async () => {
  const model = fakeModel({ fill: wholeWords });
  const publisher = fakePublisher();
  const ensurePublisher = async () => ({ publisher, created: true });
  await assert.rejects(composeBlocks(options({ model, strict: false, ensurePublisher })), CompositionVerifyError);
  await assert.rejects(composeBlocks(options({ model, verify: undefined as never, ensurePublisher })), CompositionVerifyError);
  assert.equal(model.prompts.length, 0);
  assert.equal(publisher.saves.length, 0);
});

test('composeBlocks: one save, the finished page, with its recipe and note', async () => {
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ ensurePublisher: async () => ({ publisher, created: true }) }));
  const pages = publisher.saves.filter((save) => save.html);
  assert.equal(pages.length, 1, 'no progressive paints: nothing is saved before the check passes');
  assert.equal(pages[0]!.label, 'registered');
  assert.equal(pages[0]!.html, report.html);
  assert.deepEqual(publisher.saves.filter((save) => save.file).map((save) => save.file).sort(), ['AGENCY-SITE-STATE.md', 'agency-site-state/r1/recipe.json']);
  assert.equal(report.projectId, 'proj-1');
});

test('renderWithinBudget: drops body blocks from the end — never the hero, the cta band, the footer or the last body block', async () => {
  const [direction, adapters] = await Promise.all([resolveDesignDirection(PLAN.directionId), Promise.all(PLAN.blocks.map((id) => resolveSectionAdapter(id)))]);
  const full = await composeBlocks(options());
  if (!isComposedRecipe(full.recipe)) throw new Error('not a composed recipe');
  const input = { plan: PLAN, direction, adapters, fills: full.recipe.blocks, chrome: full.recipe.chrome, kinds: KINDS, entry: 'composed-r1.html', revision: 1, recipe: full.recipe };
  const bytes = Buffer.byteLength(full.html, 'utf8');
  const fits = await renderWithinBudget(input, bytes + 1);
  assert.deepEqual(fits.dropped, []);
  const tight = await renderWithinBudget(input, bytes - 10);
  assert.deepEqual(tight.dropped, ['hyperui:marketing/feature-grids/1']);
  assert.deepEqual(tight.rendered, PLAN.blocks.filter((_id, index) => index !== 2));
  // One body block left: nothing more may go.
  await assert.rejects(renderWithinBudget(input, Buffer.byteLength(tight.html, 'utf8') - 10), ComposedPageTooLargeError);
});

test('composeBlocks over budget: every saved page fits, and ONE published plan is on the page, the recipe, the manifest and the report', async () => {
  const full = await composeBlocks(options());
  const limit = Buffer.byteLength(full.html, 'utf8') - 10;
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ pageByteLimit: limit, ensurePublisher: async () => ({ publisher, created: true }) }));
  for (const save of publisher.saves.filter((entry) => entry.html)) assert.ok(Buffer.byteLength(save.html!, 'utf8') < limit, 'every saved page is under the budget');
  const published = PLAN.blocks.filter(id => id !== 'hyperui:marketing/feature-grids/1');
  assert.deepEqual(report.composition?.budgetDropped, ['hyperui:marketing/feature-grids/1']);
  assert.deepEqual(report.composition?.blocks, published);
  assert.deepEqual(selectedIds(report.html), published.map(pub));
  if (!isComposedRecipe(report.recipe)) throw new Error('not a composed recipe');
  assert.deepEqual(report.recipe.plan.blocks, published, 'the recipe holds the published plan, not the requested one');
  assert.equal(report.recipe.blocks.length, published.length);
  const manifest = report.manifest as unknown as { metadata: { agencySite: { composition: { blocks: string[] } } } };
  assert.deepEqual(manifest.metadata.agencySite.composition.blocks, published.map(pub));
  // Paths are the published plan's: no path names the dropped block's old index past the end.
  for (const path of [...report.truncated, ...report.nulled, ...report.verify!.flagged]) {
    const index = /^blocks\[(\d+)\]/.exec(path)?.[1];
    if (index !== undefined) assert.ok(Number(index) < published.length, path);
  }
  // Replaying the published plan (a fork) composes the same blocks, without a drop.
  const replay = await composeBlocks(options({ plan: report.recipe.plan, kinds: ['hero', 'cta-band', 'footer'], planSource: 'replay', pageByteLimit: limit }));
  assert.deepEqual(replay.composition?.blocks, published);
});

test('composeBlocks: a block whose text stays over its limit is clipped at a word boundary, not refused', async () => {
  const wordy: Filler = (key, _value, at, limit) => (at === 'text.body'
    ? 'Riverbend Dental offers same-day crowns and sedation options and is open Saturdays '.repeat(8).trim()
    // Short slots get whole words only: a sliced word ("Riv", "lab") is refused by a composed fill.
    : wholeWords(key, _value, at, limit));
  const events: RunEvent[] = [];
  const report = await composeBlocks(options({ model: fakeModel({ fill: wordy }), onEvent: (event) => events.push(event) }));
  assert.ok(report.truncated.includes('blocks[0].text.body'), `truncated: ${report.truncated.join(', ')}`);
  assert.ok(events.some((event) => event.type === 'clipped' && event.label === 'hyperui:marketing/sections/1'));
  const hero = await resolveSectionAdapter('hyperui:marketing/sections/1');
  const max = hero.text.find((slot) => slot.name === 'body')!.max;
  if (!isComposedRecipe(report.recipe)) throw new Error('not a composed recipe');
  const body = report.recipe.blocks[0]!.text!.body!;
  assert.ok(body.length <= max && !body.endsWith(' '));
  const source = 'Riverbend Dental offers same-day crowns and sedation options and is open Saturdays '.repeat(8).trim();
  assert.ok(isWholeWordPrefix(source, body), `no partial word: ${JSON.stringify(body)}`);
  assert.deepEqual(selectedIds(report.html), PLAN.blocks.map(pub));
});

test('composeBlocks: text that reads like an attribute ("one = two") is not taken for an inline handler', async () => {
  const fill: Filler = (key, value, at, limit) => (at === 'text.body' ? 'Plans for one = two studios' : wholeWords(key, value, at, limit));
  const report = await composeBlocks(options({ model: fakeModel({ fill }) }));
  assert.ok(report.html.includes('one = two'));
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(report.html));
});

test('composeBlocks: a repair changes only the flagged slot — an unflagged name cut in the answer is never taken (B-113)', async () => {
  const base = fakeModel({ fill: wholeWords });
  const hero: ModelCall = async (request) => {
    if (request.label !== 'section:hyperui:marketing/sections/1') return base(request);
    const text = request.user.includes('Flagged as unsupported')
      ? { heading: 'River Dental in Boise', body: 'Same-day crowns and sedation options.' }
      : { heading: 'Riverbend Dental in Boise', body: 'Same-day crowns from $49, open Saturdays.' };
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, ms: 1, retries: 0 };
  };
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ model: hero, verify: fakeJevChecker(['$49']), ensurePublisher: async () => ({ publisher, created: true }) }));
  // Only the flagged body changed; the answer's cut heading ("River Dental") never reached the fill.
  assert.equal(report.strict?.passed, true);
  assert.deepEqual(report.verify!.flagged, ['blocks[0].text.body']);
  assert.ok(!report.html.includes('River Dental'), 'the name-cut heading was not taken');
  assert.ok(!report.html.includes('$49'));
  assert.ok(report.html.includes('Riverbend Dental in Boise'));
  assert.equal(publisher.saves.filter((save) => save.html).length, 1);
});

/** The hero answers "Welcom" (a cut no brief or fill word reveals) until `fixedAfter` calls. */
function welcomModel(fixedAfter: number) {
  const base = fakeModel({ fill: wholeWords });
  let heroCalls = 0;
  const model: ModelCall = async (request) => {
    if (request.label !== 'section:hyperui:marketing/sections/1') return base(request);
    heroCalls += 1;
    const heading = heroCalls > fixedAfter ? 'Welcome to Riverbend Dental' : 'Welcom to Riverbend Dental';
    const text = { heading, body: 'Same-day crowns, sedation options and Saturday visits in Boise.' };
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, ms: 1, retries: 0 };
  };
  return { model, calls: () => heroCalls };
}

test('composeBlocks: a required "Welcom" is repaired before publish (lexical completion gate)', async () => {
  const { model, calls } = welcomModel(2);
  const publisher = fakePublisher();
  const report = await composeBlocks(options({ model, ensurePublisher: async () => ({ publisher, created: true }) }));
  assert.equal(report.strict?.passed, true);
  assert.equal(calls(), 3, 'two attempts, then one narrow rewrite');
  assert.ok(report.html.includes('Welcome to Riverbend Dental'));
  assert.ok(!/Welcom\b/.test(report.html));
  assert.equal(publisher.saves.filter((save) => save.html).length, 1);
});

test('composeBlocks: a required "Welcom" the rewrite does not fix refuses the build; nothing is published', async () => {
  const { model } = welcomModel(99);
  const publisher = fakePublisher();
  await assert.rejects(composeBlocks(options({ model, ensurePublisher: async () => ({ publisher, created: true }) })), /cuts the word "welcome" to "Welcom"/);
  assert.equal(publisher.saves.length, 0);
});

// B-113 (2026-10-10): composed SaaS builds failed strict verify with "repaired 0". A faithfulness
// repair answer is taken only when the WHOLE block validates, so a repair that fixes the flagged
// slot but repeats an over-long slot the first fill only passed by clipping was thrown away
// without a word, and the next round re-flagged the unchanged slot.
const WORDY_BODY = 'Riverbend Dental offers same-day crowns and sedation options and is open Saturdays '.repeat(8).trim();
/** First fill: the hero heading invents a claim and the body runs over its limit (clipped). The
 * faithfulness repair answer fixes the heading but repeats the over-long body. */
function claimThenWordyRepair(): ModelCall & { prompts: string[] } {
  const wordy = (heading: string): Filler => (key, value, at, limit) => (at === 'text.body' ? WORDY_BODY : at === 'text.heading' ? heading : wholeWords(key, value, at, limit));
  const first = heroModel(wordy('FABRICATED Trusted by 40,000 patients'));
  // The repair answer also rewrites the unflagged body: that change must never be taken.
  const repair = fakeModel({ fill: (key, value, at, limit) => (at === 'text.body' ? 'UNFLAGGED REWRITE of the body' : at === 'text.heading' ? 'Riverbend Dental' : wholeWords(key, value, at, limit)) });
  const prompts: string[] = [];
  const call = (async (request: Parameters<ModelCall>[0]) => {
    prompts.push(request.user);
    return (request.user.includes('Flagged as unsupported by the brief') ? repair : first)(request);
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

test('B-113: a discarded faithfulness repair is reported with its reason, and the text still flagged is on the report', async () => {
  // A required slot answered with null cannot be taken: the repair is discarded and the slot stays flagged.
  const first = heroModel((key, value, at, limit) => (at === 'text.heading' ? 'FABRICATED Trusted by 40,000 patients' : wholeWords(key, value, at, limit)));
  const nulls = fakeModel({ fill: (key, value, at, limit) => (at === 'text.heading' ? null as unknown as string : wholeWords(key, value, at, limit)) });
  const model = (async (request: Parameters<ModelCall>[0]) => (request.user.includes('Flagged as unsupported by the brief') ? nulls : first)(request)) as ModelCall;
  const events: RunEvent[] = [];
  const report = await composeBlocks(options({ model, strict: true, maxFaithfulnessRounds: 1, onEvent: (event) => events.push(event) }));
  const discarded = events.filter((event) => event.type === 'repair-discarded');
  assert.ok(discarded.length > 0, 'the thrown-away repair is reported');
  assert.ok(discarded.every((event) => event.type === 'repair-discarded' && event.label === 'hyperui:marketing/sections/1' && event.reason === 'invalid' && event.detail.includes('heading: not nullable')));
  assert.equal(report.strict?.passed, false);
  assert.deepEqual(report.verify!.remaining, ['blocks[0].text.heading']);
  assert.deepEqual(report.verify!.remainingTexts, [{ path: 'blocks[0].text.heading', text: 'FABRICATED Trusted by 40,000 patients' }]);
});

test('B-113: a faithfulness repair changes only the flagged slot; the rest of the block stays as published, and the page publishes', async () => {
  const publisher = fakePublisher();
  const events: RunEvent[] = [];
  const report = await composeBlocks(options({ model: claimThenWordyRepair(), strict: true, maxFaithfulnessRounds: 1, onEvent: (event) => events.push(event), ensurePublisher: async () => ({ publisher, created: true }) }));
  assert.equal(report.strict?.passed, true, `remaining: ${JSON.stringify(report.verify?.remainingTexts)}`);
  assert.deepEqual(report.verify!.flagged, ['blocks[0].text.heading']);
  assert.equal(report.verify!.repaired, 1);
  assert.ok(!events.some((event) => event.type === 'repair-discarded'));
  if (!isComposedRecipe(report.recipe)) throw new Error('not a composed recipe');
  const hero = report.recipe.blocks[0]!.text!;
  assert.equal(hero.heading, 'Riverbend Dental');
  // The body is exactly the first fill's clipped text; the repair answer's own body was not taken.
  assert.equal(hero.body, clipWholeWords(WORDY_BODY, 260));
  assert.ok(!report.html.includes('UNFLAGGED REWRITE'));
  assert.ok(!report.html.includes('FABRICATED') && !report.html.includes('40,000'));
  assert.equal(publisher.saves.filter((save) => save.html).length, 1);
});

test('B-113: a repair answer that is not JSON is discarded as malformed; the slot stays flagged and nothing publishes', async () => {
  const first = heroModel((key, value, at, limit) => (at === 'text.heading' ? 'FABRICATED Trusted by 40,000 patients' : wholeWords(key, value, at, limit)));
  const model = (async (request: Parameters<ModelCall>[0]) => (request.user.includes('Flagged as unsupported by the brief')
    ? { text: 'Sorry, I cannot help with that.', usage: { input: 1, output: 1, cachedRead: 0 }, ms: 1, retries: 0 }
    : first(request))) as ModelCall;
  const events: RunEvent[] = [];
  let ensured = 0;
  const report = await composeBlocks(options({ model, strict: true, maxFaithfulnessRounds: 1, onEvent: (event) => events.push(event), ensurePublisher: async () => { ensured += 1; return { publisher: fakePublisher(), created: true }; } }));
  assert.ok(events.some((event) => event.type === 'repair-discarded' && event.reason === 'malformed'));
  assert.equal(report.strict?.passed, false);
  assert.deepEqual(report.verify!.remaining, ['blocks[0].text.heading']);
  assert.equal(ensured, 0);
});

// B-113 (QA run on 28df81b3ac): a how-it-works block's step markers ("1"–"4" in item1–item4) were
// flagged as unsupported numbers and could never be repaired. A slot whose whole text is the number
// its own name ends with is a step marker, not a fact; any other number is still checked.
test('B-113: step markers ("item3": "3") are structure, never checked as facts; other numbers still are', async () => {
  const adapter: SectionAdapter = { id: 'cult:sass-colorful--how-it-works', version: '1', sourceBlockId: 'test:steps', sourceSha256: '', roles: [], text: [1, 2, 3, 4].map(n => ({name: `item${n}`, max: 3, atom: 'plain' as const})), css: '', render: () => '<section>Fixture step badges</section>' };
  const bareNumbers = { async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) {
    return { flagged: slots.filter((slot) => /^\d+$/.test(slot.text.trim())).map((slot) => ({ path: slot.path, probability: 0.9 })), ms: 1, calls: 1 };
  } };
  const markers: Filler = (key, value, at, limit) => { const step = /^text\.item(\d+)$/.exec(at); return step ? step[1]! : wholeWords(key, value, at, limit); };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model: fakeModel({ fill: markers }), composed: true, verify: bareNumbers, strict: true, maxFaithfulnessRounds: 0 });
  assert.deepEqual(result.flagged, []);
  assert.equal(result.fill.text?.item1, '1');
  // "40" in a step slot is not its own step number: it is checked, flagged and refused under strict.
  const forty: Filler = (key, value, at, limit) => (at === 'text.item2' ? '40' : markers(key, value, at, limit));
  await assert.rejects(fillSectionAdapter({ adapter, brief: BRIEF, model: fakeModel({ fill: forty }), composed: true, verify: bareNumbers, strict: true, maxFaithfulnessRounds: 0 }), /text\.item2/);
});

/** A one-block adapter with a required body and three item rows, for the per-slot repair cases. */
const ROWS_ADAPTER: SectionAdapter = {
  id: 'test:rows', version: '1', sourceBlockId: 'test:rows', sourceSha256: '', roles: [], css: '',
  text: [{ name: 'body', max: 120 }],
  items: { name: 'features', count: 3, fields: [{ name: 'blurb', max: 60 }] },
  links: [],
  render: (fill) => `<section><p>${fill.text?.body ?? ''}</p></section>`,
};
const answer = (value: unknown) => ({ text: JSON.stringify(value), usage: { input: 1, output: 1, cachedRead: 0 }, ms: 1, retries: 0 });
const markerChecker = () => fakeJevChecker(['FABRICATED']);

test('B-113 (Sol r1): a malformed item row in a repair answer is discarded, never thrown; the next repair is taken', async () => {
  const replies = [
    { text: { body: 'Riverbend Dental in Boise.' }, items: { features: [{ blurb: 'Same-day crowns' }, { blurb: 'Sedation options' }, { blurb: 'FABRICATED award' }] } },
    { items: { features: [{}, {}, 'bad'] } },
    { text: { body: 'Riverbend Dental in Boise.' }, items: { features: [{ blurb: 'Same-day crowns' }, { blurb: 'Sedation options' }, { blurb: 'Open Saturdays' }] } },
  ];
  let call = 0;
  const model = (async () => answer(replies[Math.min(call++, replies.length - 1)])) as unknown as ModelCall;
  const result = await fillSectionAdapter({ adapter: ROWS_ADAPTER, brief: BRIEF, model, composed: true, verify: markerChecker(), strict: true, maxFaithfulnessRounds: 2 });
  assert.deepEqual(result.remaining, []);
  assert.equal(result.fill.items?.features?.[2]?.blurb, 'Open Saturdays');
  assert.equal(result.discarded?.[0]?.reason, 'malformed');
});

test('B-113 (Sol r1): one invalid flagged value keeps its previous value; the other flagged values are still taken', async () => {
  const replies = [
    { text: { body: 'FABRICATED since 1999' }, items: { features: [{ blurb: 'Same-day crowns' }, { blurb: 'Sedation options' }, { blurb: 'FABRICATED award' }] } },
    // The body comes back null (not nullable); the item comes back fixed.
    { text: { body: null }, items: { features: [{ blurb: 'Same-day crowns' }, { blurb: 'Sedation options' }, { blurb: 'Open Saturdays' }] } },
  ];
  let call = 0;
  const model = (async () => answer(replies[Math.min(call++, replies.length - 1)])) as unknown as ModelCall;
  const result = await fillSectionAdapter({ adapter: ROWS_ADAPTER, brief: BRIEF, model, composed: true, verify: markerChecker(), maxFaithfulnessRounds: 1 });
  assert.equal(result.fill.items?.features?.[2]?.blurb, 'Open Saturdays', 'the valid item repair was taken');
  assert.equal(result.fill.text?.body, 'FABRICATED since 1999', 'the rejected body keeps its previous value');
  assert.deepEqual(result.remaining, ['text.body']);
  assert.ok(result.discarded?.some((entry) => entry.reason === 'invalid' && entry.detail.includes('body: not nullable')));
});

test('B-113 (Sol r2): a numbered slot outside a declared step block is always checked — a statistic or a price is a fact', async () => {
  const bareNumbers = { async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) {
    return { flagged: slots.filter((slot) => /^\d+$/.test(slot.text.trim())).map((slot) => ({ path: slot.path, probability: 0.9 })), ms: 1, calls: 1 };
  } };
  // "7" + "Years in business" and "4" + "/mo": the number in a slot named for it is a claim here.
  for (const [id, slotName, value] of [['cult:marketing-stats-hex', 'body7', '7'], ['cult:marketing-pricing-apple', 'label4', '4']] as const) {
    const adapter: SectionAdapter = { id, version: '1', sourceBlockId: 'test:number', sourceSha256: '', roles: [], text: [{name: slotName, max: 40}], css: '', render: () => '<p>Fixture number</p>' };
    const fill: Filler = (key, v, at, limit) => (at === `text.${slotName}` ? value : wholeWords(key, v, at, limit));
    await assert.rejects(fillSectionAdapter({ adapter, brief: BRIEF, model: fakeModel({ fill }), composed: true, verify: bareNumbers, strict: true, maxFaithfulnessRounds: 0 }), new RegExp(`text\\.${slotName}`), id);
  }
});
