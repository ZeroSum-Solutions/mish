/**
 * storefront family proficiency-bar tests: registry exclusions, the byte budget, the three
 * fixture briefs (rich, near-miss, sparse), no-invented-facts on the sparse fixture, and route
 * negatives — the ownedmaker near-miss brief must never resolve to storefront, and vice versa.
 *
 * `resolveRoute` is the same pure, no-network policy `route.test.ts` exercises directly (see its
 * restaurant/community examples this file follows); these route-negative cases stand in for the
 * `prompt-hero` / atelier-by-email regression pairs from the design ruling without a live Jev call.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadAtlasData } from './routing-fixture.ts';
import { buildRouteQuestions, createJevRouter, resolveRoute, type ChoiceAnswer } from '../src/route.ts';
import { loadFamilyPackage } from '../src/family.ts';
import { runFastLane } from '../src/run.ts';
import { collectFaithfulnessSlots, deterministicClaimFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags, type FaithfulnessSlot } from '../src/jev.ts';
import { fakeJevChecker, fakeModel, type Filler } from './fixtures.ts';
import { editableTemplate, labelPathsFor, traceablePathsFor, type Json, type JsonObject } from '../src/spine.ts';

/**
 * g6-r3-opus55 audit (BLOCK B1): mutates a cloned storefront spine in place, replacing the
 * reference fixture's own `sections[3].items[1].blurb` ("Boxy cut, single chest pocket.") with
 * text that traces cleanly. That blurb is an ACCEPTED, unrelated `deterministicProperNounFlags`
 * residual now that the SCOWL wordlist is back to size 50 (`KNOWN_PROPER_NOUN_RESIDUAL_FLAGS` in
 * `claim-name-honesty-all-families.test.ts`) — several strict-build tests in this file clone the
 * WHOLE reference fixture as their spine and only touch one unrelated field, so without this the
 * unrelated "Boxy" residual alone would fail their strict assertion.
 */
function neutralizeBoxyBlurb(spine: Json): void {
  const sections = (spine as JsonObject).sections as JsonObject[];
  const items = sections[3]!.items as JsonObject[];
  // g6-r3b-opus55 audit (NOTE N-d): asserts the EXACT original value before overwriting it —
  // without this, a future fixture reorder (a section or item inserted/removed) would silently
  // land this overwrite on some OTHER blurb at the same index, corrupting an unrelated test case
  // instead of failing loudly.
  assert.equal(items[1]!.blurb, 'Boxy cut, single chest pocket.', 'neutralizeBoxyBlurb: fixture shape changed — this is no longer the Boxy blurb at sections[3].items[1]');
  items[1]!.blurb = 'Relaxed cut, single chest pocket.';
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(HERE, '../../../plugins/_official/examples/agency-storefront');
const FIXTURES_DIR = path.join(PACKAGE_DIR, 'fixtures/briefs');

const { atlas, registry } = await loadAtlasData();

function choice(choiceValue: string, probabilities: Record<string, number>, confidence = 1): ChoiceAnswer {
  return { type: 'choice', choice: choiceValue, confidence, probabilities };
}

// ---------------------------------------------------------------------------
// Registry: positive fit and named exclusions
// ---------------------------------------------------------------------------

test('registry: storefront is CO / CO.01 / site, and its summary excludes a phone-only maker, marketing-site and listings as exclusions', () => {
  const entry = registry.families.find((f) => f.family === 'storefront');
  assert.ok(entry, 'storefront is registered');
  assert.equal(entry!.spine, 'CO');
  assert.equal(entry!.archetype, 'CO.01');
  assert.equal(entry!.pageKind, 'site');
  const summary = entry!.summary.toLowerCase();
  assert.ok(summary.includes('made-to-order atelier'), 'excludes a phone-only maker');
  assert.ok(summary.includes('marketing-site'), 'names marketing-site as an exclusion');
  assert.ok(summary.includes('listings'), 'names listings as an exclusion');
  assert.ok(summary.includes('buy') || summary.includes('preorder'), 'states the positive fit');
});

test('registry: the atlas accepts storefront\'s archetype reference (validateFamilyRegistry passes for the whole file)', () => {
  const archetype = atlas.archetypes.find((a) => a.id === 'CO.01');
  assert.ok(archetype, 'CO.01 exists in the atlas');
  assert.equal(archetype!.spine, 'CO');
});

// ---------------------------------------------------------------------------
// Contract + byte budget: the package's own reference (rich) fixture
// ---------------------------------------------------------------------------

test('the storefront package loads, and its reference fixture renders under the 200 KiB budget', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const { html } = pkg.render(pkg.fixture, 'storefront-r1.html');
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'under 200 KiB');
  assert.match(html, /^<!doctype html>/);
});

// ---------------------------------------------------------------------------
// Sparse fixture: no invented facts, optional sections and their nav links dropped
// ---------------------------------------------------------------------------

test('sparse fixture: a single-SKU preorder brief drops every optional section and its nav link, invents nothing, and stays under budget', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const recipe = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'sparse.recipe.json'), 'utf8'));
  const { html } = pkg.render(recipe, 'storefront-sparse-r1.html');
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'under 200 KiB');
  for (const id of ['storefront-collection-grid', 'storefront-product-details', 'storefront-shipping-returns', 'storefront-reviews', 'storefront-story-about']) {
    assert.ok(!html.includes(`id="${id}"`), `${id}: dropped, no section wrapper`);
    assert.ok(!html.includes(`href="#${id}"`), `${id}: its nav link is dropped too`);
  }
  // Required sections still render.
  for (const id of ['storefront-header', 'storefront-hero', 'storefront-featured-product', 'storefront-buy-preorder', 'storefront-footer']) {
    assert.ok(html.includes(`id="${id}"`), `${id}: required section still renders`);
  }
  // The brief's one real fact (the preorder URL) is honored, and nothing invented is present.
  assert.match(html, /href="https:\/\/preorder\.halberdaudio\.example\/one"/);
  assert.ok(!html.includes('$0'), 'no fabricated zero price');
});

// ---------------------------------------------------------------------------
// Fixture-drift prevention (a third audit pass caught this live): the committed reference and
// sparse recipes are hand-authored, not model-generated, so nothing else in this suite ever ran
// them through the same deterministic gate a live build's own text goes through. That let real
// invented facts sit in committed fixtures unnoticed — a reviewer name and phone number in
// reference.fixture.json neither storefront fixture brief states, and an "invented ship date" /
// "a small team" claim in sparse.recipe.json's body copy that directly contradicted sparse.txt's
// own "we don't have shipping dates ... to share yet".
//
// Two layers, deliberately different strictness, because they check different kinds of drift:
//
// 1. `deterministicClaimFlags` (the CLAIM-token half of the same shared gate a live build's quote
//    fields go through — see jev.ts's own docblock on it) runs over EVERY text field of the WHOLE
//    recipe, headings and CTAs included: a genuinely new price, percentage or rating anywhere on
//    the page is always suspicious, and checking claims-only never constrains how the surrounding
//    prose is worded, so this layer can safely run broadly with zero risk of flagging ordinary
//    paraphrase. Proven empirically, not assumed: the FULL word-tracing `deterministicQuoteFlags`
//    was tried first here and flagged 8 fields of entirely legitimate marketing paraphrase in the
//    reference fixture alone (it is built for short reviewer quotes that are supposed to echo the
//    brief closely, not freely-worded body copy) — this is why the broad layer is claims-only.
// 2. A small set of NAMED regression assertions pins the two specific non-numeric invented claims
//    this audit pass found (an unstated shipping-timeline commitment, an unstated team-size
//    claim) directly, since neither is a number/price/rating a claim-token check would catch, and
//    neither is a case a deterministic word-tracing check can safely generalize from without the
//    reference-fixture false-positive problem above. This is honestly a narrower guarantee than
//    layer 1 — proving no NEW commitment/scale claim was ever introduced in general prose requires
//    either full word-tracing (too strict for this family's prose, as proven above) or an LLM
//    judgment (Jev, not available in an offline test) — see this test file's own report on which
//    other bundled families this same gate could reasonably be run against for the same purpose.
// ---------------------------------------------------------------------------

/** Every text field (headings, CTAs, body copy, tagline, item labels/values/blurbs — everything
 * except the brand/product identity fields and prices, which ARE the fact itself, not something
 * to trace) in a storefront recipe, as {path, text} pairs ready for `deterministicClaimFlags`. */
function allTextFieldsOf(recipe: { sections: Array<Record<string, unknown> | null> }): FaithfulnessSlot[] {
  const out: FaithfulnessSlot[] = [];
  const push = (path: string, value: unknown) => { if (typeof value === 'string' && value.length > 0) out.push({ path, text: value }); };
  recipe.sections.forEach((section, index) => {
    if (section === null) return;
    const text = section.text as Record<string, unknown> | undefined;
    if (text) for (const [key, value] of Object.entries(text)) {
      if (Array.isArray(value)) value.forEach((entry, i) => push(`sections[${index}].text.${key}[${i}]`, entry));
      else push(`sections[${index}].text.${key}`, value);
    }
    const items = section.items as Array<Record<string, unknown>> | undefined;
    if (items) items.forEach((item, i) => { for (const [key, value] of Object.entries(item)) push(`sections[${index}].items[${i}].${key}`, value); });
  });
  return out;
}

function assertNoUnsupportedClaimTokens(brief: string, recipe: { sections: Array<Record<string, unknown> | null> }, label: string): void {
  const slots = allTextFieldsOf(recipe);
  assert.ok(slots.length > 0, `${label}: the recipe has text fields to check`);
  const flagged = deterministicClaimFlags(brief, slots, new Set(slots.map((slot) => slot.path)));
  assert.deepEqual(flagged, [], `${label}: every claim token (price/number/percent/rating) anywhere in the recipe must trace to the brief; got ${JSON.stringify(flagged)}`);
}

test('fixture-drift prevention (claim tokens, whole recipe): reference.fixture.json carries no price, number, percent or rating unsupported by rich.txt', () => {
  const brief = readFileSync(path.join(FIXTURES_DIR, 'rich.txt'), 'utf8');
  const recipe = JSON.parse(readFileSync(path.join(HERE, '../../../plugins/_official/examples/agency-storefront/compiler/scripts/families/storefront/reference.fixture.json'), 'utf8'));
  assertNoUnsupportedClaimTokens(brief, recipe, 'reference.fixture.json');
});

// Round-4 Grok audit (guide-r2): this file already ran `deterministicClaimFlags` broadly (above),
// but never `deterministicTraceableFlags` (the whole-field word-trace gate every `x-verify:
// 'traceable'` row — price, shipping, product-detail — actually goes through at build time) or
// `deterministicSentenceClaimFlags` (this family's own sentence-level gate, `run.ts`'s
// SENTENCE_CLAIM_FAMILIES). Calling only the claims-only layer let the "false-positive = 0" claim
// stay unverified for the two STRICTER gates a live storefront build actually runs. Both are
// called here now, over the reference fixture's own default template — `labelPathsFor` excludes
// the same template CHROME `run.ts`'s real `checkSlots` would (an unchanged `x-label` field, e.g.
// a fixed row heading), so this measures the same bar a live build does, not a stricter one.
test('fixture-drift prevention (traceable rows + sentence claims, whole recipe): reference.fixture.json is faithful to rich.txt under BOTH stricter gates, not just claim tokens', async () => {
  const brief = readFileSync(path.join(FIXTURES_DIR, 'rich.txt'), 'utf8');
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set())!;
  const traceablePaths = traceablePathsFor(pkg.schema, template);
  const labelPaths = labelPathsFor(pkg.schema, template);
  const slots = collectFaithfulnessSlots(pkg.fixture);
  const allSlotPaths = new Set(slots.map((slot) => slot.path).filter((path) => !labelPaths.has(path)));

  const traceableFlagged = deterministicTraceableFlags(brief, slots, traceablePaths);
  assert.deepEqual(traceableFlagged, [], `reference.fixture.json carries a traceable row (price/shipping/product-detail) rich.txt does not support: ${JSON.stringify(traceableFlagged)}`);

  const sentenceFlagged = deterministicSentenceClaimFlags(brief, slots, allSlotPaths);
  assert.deepEqual(sentenceFlagged, [], `reference.fixture.json carries a claim-bearing sentence rich.txt does not support: ${JSON.stringify(sentenceFlagged)}`);
});

test('fixture-drift prevention (claim tokens, whole recipe): sparse.recipe.json carries no price, number, percent or rating unsupported by sparse.txt', () => {
  const brief = readFileSync(path.join(FIXTURES_DIR, 'sparse.txt'), 'utf8');
  const recipe = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'sparse.recipe.json'), 'utf8'));
  assertNoUnsupportedClaimTokens(brief, recipe, 'sparse.recipe.json');
});

test('fixture-drift prevention (named regression): sparse.recipe.json no longer claims a shipping timeline or a team size sparse.txt never states', () => {
  const recipeText = readFileSync(path.join(FIXTURES_DIR, 'sparse.recipe.json'), 'utf8');
  assert.ok(!/finaliz\w* .*ship/i.test(recipeText), 'must not claim to be finalizing a ship date — sparse.txt says none is set at all');
  assert.ok(!/ship date/i.test(recipeText), 'must not mention a ship date in any form — sparse.txt states none exists yet');
  assert.ok(!/small team/i.test(recipeText), 'must not claim a team size sparse.txt never states');
});

test('fixture-drift prevention (named regression): reference.fixture.json no longer invents reviewer names or a phone number rich.txt never gives', () => {
  const recipeText = readFileSync(path.join(HERE, '../../../plugins/_official/examples/agency-storefront/compiler/scripts/families/storefront/reference.fixture.json'), 'utf8');
  assert.ok(!/Alvarez|Kowalski/.test(recipeText), 'must not carry the previously-invented reviewer names');
  assert.ok(!/503-555-0199/.test(recipeText), 'must not carry the previously-invented phone number — rich.txt gives no phone at all');
  assert.ok(!/limited stock/i.test(recipeText), 'the hero must not claim "limited stock" in wording rich.txt itself never uses');
});

// ---------------------------------------------------------------------------
// A round-10 audit pass (storefront-r6-grok.md NOTE 6) found the reference buy block's own email
// atom, `shop@tallowrow.example`, does not appear anywhere in rich.txt (only `hello@` does) — an
// invented contact address baked into the shipped fixture, invisible because the drift test never
// scanned emails at all. Fixed at the source (`reference.fixture.json`/`recipe.json` now use the
// brief's own `hello@tallowrow.example`); this test extends the drift check so a future email
// mismatch is caught the same way `assertNoUnsupportedClaimTokens` already catches a mismatched
// price or number.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function assertEveryEmailTracesToBrief(brief: string, recipeText: string, label: string): void {
  const emails = [...recipeText.matchAll(EMAIL_RE)].map((match) => match[0]);
  assert.ok(emails.length > 0, `sanity: ${label} carries at least one email atom to check`);
  const briefLower = brief.toLowerCase();
  for (const email of emails) {
    assert.ok(briefLower.includes(email.toLowerCase()), `${label}: "${email}" must appear in the brief — an invented or mismatched contact email must never ship`);
  }
}

test('fixture-drift prevention (contact atoms): every email address in reference.fixture.json appears in rich.txt', () => {
  const brief = readFileSync(path.join(FIXTURES_DIR, 'rich.txt'), 'utf8');
  const recipeText = readFileSync(path.join(HERE, '../../../plugins/_official/examples/agency-storefront/compiler/scripts/families/storefront/reference.fixture.json'), 'utf8');
  assertEveryEmailTracesToBrief(brief, recipeText, 'reference.fixture.json');
});

test('fixture-drift prevention (contact atoms): every email address in sparse.recipe.json appears in sparse.txt', () => {
  const brief = readFileSync(path.join(FIXTURES_DIR, 'sparse.txt'), 'utf8');
  const recipeText = readFileSync(path.join(FIXTURES_DIR, 'sparse.recipe.json'), 'utf8');
  const emails = [...recipeText.matchAll(EMAIL_RE)].map((match) => match[0]);
  if (emails.length === 0) return; // sparse.txt may state no contact email at all; nothing to check.
  const briefLower = brief.toLowerCase();
  for (const email of emails) assert.ok(briefLower.includes(email.toLowerCase()), `sparse.recipe.json: "${email}" must appear in sparse.txt`);
});

test('strict run (contact atoms, FIX 5): an invented buy email, URL and hyphenated phone each flag and fail the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248. Contact hello@tallowrow.example.';
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; text: { url?: string | null; phone?: string | null; email?: string | null } } | null>;
  const buyIndex = spineSections.findIndex((section) => section?.type === 'buy-preorder');
  spineSections[buyIndex]!.text.url = 'https://shop.tallowrow.example/invented';
  spineSections[buyIndex]!.text.phone = '503-555-0199';
  spineSections[buyIndex]!.text.email = null;
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the contact-atom gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(report.verify!.flagged.includes(`sections[${buyIndex}].text.url`), `an invented buy URL must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`);
  assert.ok(report.verify!.flagged.includes(`sections[${buyIndex}].text.phone`), `an invented hyphenated phone must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`);
});

// ---------------------------------------------------------------------------
// Route negatives (pure resolveRoute policy, no network)
// ---------------------------------------------------------------------------

test('route policy (hand-built answers): resolveRoute picks storefront over ownedmaker given storefront-leaning probabilities, all else CO.01-shaped', () => {
  // ownedmaker moved from spine CO/archetype CO.01 to spine TL/archetype TL.06 (G7 task f8 root cause
  // (b) — see atlas.ts and eval-v7/G7-DIAGNOSIS.md), so under a CO/CO.01 answer set ownedmaker is not
  // even a candidate any more (CO -> TL transfer is 1, below minTransfer 2); this still checks
  // storefront wins its own home spine/archetype cleanly.
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.83, ownedmaker: 0.1, 'marketing-site': 0.03, listings: 0.02, ownededitorial: 0.01, none: 0.01 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
  assert.notEqual(decision.family?.id, 'ownedmaker');
  assert.equal(decision.archetype?.id, 'CO.01');
});

// Deliberately NOT named or described as exercising near-miss.txt: this is a pure resolveRoute
// policy check against a hand-built answer set, proving only that resolveRoute itself picks ownedmaker
// when handed ownedmaker-leaning probabilities. It says nothing about what a real classifier would
// actually decide when given near-miss.txt's own text — that is the separate, fixture-driving
// test below (`route (live pipeline, near-miss.txt text)`). Keeping these two claims apart is the
// fix for the exact conflation the coordinator's audit caught: the same test shape with
// choice('storefront', ...) here would "prove" the opposite of what the brief says, since this
// test never reads the brief at all.
test('route policy (hand-built answers): resolveRoute picks ownedmaker over ownededitorial given ownedmaker-leaning probabilities, all else TL.06-shaped', () => {
  // ownedmaker's own home is now spine TL/archetype TL.06 (G7 task f8 root cause (b) — see atlas.ts
  // and eval-v7/G7-DIAGNOSIS.md: a made-to-order maker/atelier brief with no cart is a TL
  // "personal expert or portfolio" story, not a CO one). storefront is not even a candidate here
  // (CO -> TL transfer is 1, below minTransfer 2), so this checks ownedmaker over its real same-spine
  // competitor, ownededitorial.
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.06', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 1, none: 0 }),
    family: choice('ownedmaker', { ownedmaker: 0.79, ownededitorial: 0.12, ownedcontractor: 0.05, ownedcinematic: 0.02, ownedsite: 0.01, none: 0.01 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'ownedmaker');
  assert.notEqual(decision.family?.id, 'ownededitorial');
  assert.ok(!decision.candidates.some((c) => c.family === 'storefront'), 'storefront is not reachable from TL: CO -> TL transfer is 1, below minTransfer 2');
  assert.equal(decision.archetype?.id, 'TL.06');
});

// ---------------------------------------------------------------------------
// route (near-miss.txt REQUEST CONSTRUCTION ONLY — not a routing-outcome proof): the fixture's
// OWN text is read from disk and sent through the real request-building step
// (`buildRouteQuestions`) inside `createJevRouter`, proving the pipeline reads this specific
// file's content into the request it actually sends, not a paraphrase of it in a test comment.
//
// This does NOT prove "near-miss.txt routes to ownedmaker." A second audit pass caught that an earlier
// version of this test misleadingly implied that: its fake HTTP response was a canned ownedmaker-
// leaning answer that ignored the request body entirely (`() => ({...fixedAnswers})`), so ANY
// brief text — including storefront's own rich.txt — would have produced the identical "routes to
// ownedmaker" assertion passing. That is not evidence the classifier itself would decide ownedmaker for
// THIS brief; it only exercises resolveRoute's policy given an arbitrary fixed answer, exactly
// like the hand-built `route policy` tests above (and those already cover that claim). Recording
// a genuine classifier answer for this specific fixture (model, date, prompt) would be the real
// fix, but that requires an actual live call this offline suite cannot make; until then this test
// asserts ONLY what it can honestly prove: that near-miss.txt's real text reaches the classifier
// request unmodified. It intentionally does NOT assert anything about the routing decision.
// ---------------------------------------------------------------------------

function fakeFetch(captured: { body: JsonObject }[], respond: (body: JsonObject) => JsonObject): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({ body });
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as typeof fetch;
}

test('route request construction (near-miss.txt): the real fixture text reaches the classifier request unmodified — this test proves NOTHING about what the classifier would actually decide', async () => {
  const nearMissBrief = readFileSync(path.join(FIXTURES_DIR, 'near-miss.txt'), 'utf8');
  const captured: { body: JsonObject }[] = [];
  // This response is a fixed stand-in the pipeline never actually asked for — it ignores the
  // request body entirely, by construction, so nothing below may treat the resulting `decision`
  // as evidence of what a real classifier would answer for near-miss.txt. Only the CAPTURED
  // REQUEST (asserted below) is genuine evidence.
  const router = createJevRouter({
    consensusK: 1,
    apiKey: 'test-key',
    fetchImpl: fakeFetch(captured, () => ({
      model: 'jev-1.13.0-unrecorded-stand-in',
      answers: {
        spine: choice('CO', { CO: 1 }),
        archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
        family: choice('ownedmaker', { ownedmaker: 1 }),
        skin: choice('unspecified', { unspecified: 1 }),
      } satisfies Record<string, ChoiceAnswer>,
    })),
  });
  await router.route({ brief: nearMissBrief, atlas, registry });

  // Proves the real file content, not a stand-in string, made it into the request the pipeline
  // actually builds and sends — the ONLY claim this test makes.
  assert.equal(captured.length, 1, 'exactly one request was sent');
  assert.equal((captured[0]!.body as { state: { brief: string } }).state.brief, nearMissBrief, 'the built request state carries near-miss.txt\'s own text verbatim');
  const { questions } = buildRouteQuestions(nearMissBrief, atlas, registry);
  assert.deepEqual((captured[0]!.body as JsonObject).questions, questions, 'the request questions match what buildRouteQuestions derives from this brief, the registry and the atlas');
});

test('route: a software-trial, pricing-tiers answer set routes to marketing-site, not storefront', () => {
  const answers = {
    spine: choice('PA', { PA: 1 }),
    archetype_PA: choice('PA.01', { 'PA.01': 1, none: 0 }),
    family: choice('marketing-site', { 'marketing-site': 0.85, storefront: 0.05, 'app-shell': 0.05, 'docs-hub': 0.03, none: 0.02 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'marketing-site');
  assert.notEqual(decision.family?.id, 'storefront');
});

// ---------------------------------------------------------------------------
// End-to-end proof: the deterministic attribution check runs inside the real fast-lane pipeline,
// not only as a unit under jev.test.ts. A fake Jev checker that only flags a literal 'FABRICATED'
// marker stands in for Jev genuinely missing an invented name (exactly what the live Cerebras
// build did): the invented review name carries no such marker, so the LLM side of the check would
// pass it at 0 flagged on its own, the same way it did live.
// ---------------------------------------------------------------------------

test('strict run: an invented review name with no brief support is flagged even though the (fake) Jev judge misses it entirely', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example. A couple of buyers left quiet, glowing notes about the canvas holding up well.';
  const INVENTED_NAME = 'Persephone Quill-Ashworth';
  // The package's own reference fixture now honestly starts both reviewers' `name` at null (a
  // third audit pass caught it carrying invented names/a phone number rich.txt never states — see
  // reference.fixture.json's own history). This test's whole point is reproducing a MODEL that
  // fills in an invented name Jev's own judge misses, so it needs a starting `name` the fill step
  // will actually ask the model to confirm-or-rewrite — an explicit `spine` override with a
  // placeholder starting value gives it exactly that, independent of the shared fixture's own
  // (now correctly null) default.
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; items?: Array<{ name: string | null }> } | null>;
  const reviewsSection = spineSections.find((section) => section?.type === 'reviews')!;
  reviewsSection.items![0]!.name = 'Placeholder Reviewer';
  const fill: Filler = (key, value, _at, limit) => {
    if (key === 'name') return INVENTED_NAME.slice(0, limit ?? INVENTED_NAME.length);
    return typeof value === 'string' ? value : `New ${key}`.slice(0, limit ?? 40);
  };
  const model = fakeModel({ fill });
  // A checker that behaves exactly like the live Cerebras run: it flags nothing (no 'FABRICATED'
  // marker anywhere), the same way Jev's own LLM judge passed the two invented names at 0 flagged.
  const verify = fakeJevChecker(['FABRICATED']);
  const report = await runFastLane({ pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true });
  assert.ok(report.verify, 'a verify report was produced');
  const flaggedPaths = report.verify!.flagged;
  assert.ok(
    flaggedPaths.some((path: string) => path.endsWith('.name')),
    `the invented name must be deterministically flagged even though the fake Jev judge missed it; flaggedPaths: ${JSON.stringify(flaggedPaths)}`,
  );
});

// ---------------------------------------------------------------------------
// End-to-end proof: `pkg.checkLinkHonesty` (shared `sections.ts`'s `dishonestLinks`) is actually
// wired into the pre-publish gate for storefront, not merely defined and unused — a dead/invented
// href must fail a strict build closed exactly like an invented name or quote, with no path for
// the repair loop to attach the flag to a unit and "fix" it away.
// ---------------------------------------------------------------------------

test('strict run: a dead link the (stubbed) link-honesty check reports is flagged and fails the strict build closed, with nothing registered', async () => {
  const realPkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  assert.equal(typeof realPkg.checkLinkHonesty, 'function', 'storefront\'s compiler copy loads dishonestLinks as checkLinkHonesty');
  // Stubbed to always report one dead link regardless of the actual rendered HTML — isolates the
  // wiring itself (does run.ts call this and act on its result?) from whether storefront's own
  // templates happen to produce a dishonest link today (they don't; see link-honesty.test.ts's
  // "storefront: the reference fixture ... has no dishonest links").
  const pkg = { ...realPkg, checkLinkHonesty: () => ['/invented-careers-page'] };
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example.';
  const model = fakeModel({ fill: (_key, value, _at, limit) => (typeof value === 'string' ? value : null) });
  // No 'FABRICATED' marker anywhere in this fill, so the fake Jev checker itself flags nothing —
  // the link-honesty stub is the ONLY source of a flag in this run, isolating the assertion to it.
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg,
    brief,
    mode: 'sections',
    entry: 'storefront-r1.html',
    revision: 1,
    model,
    modelName: 'fake',
    verify,
    strict: true,
    ensurePublisher: async () => {
      created = true;
      throw new Error('ensurePublisher must never be called once the link-honesty gate has failed');
    },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.projectId, undefined, 'no project id on the report');
  assert.ok(report.strict, 'strict verdict is reported');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.some((path: string) => path.includes('/invented-careers-page')),
    `the dead link must appear in the flagged paths; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
  assert.ok(
    report.verify!.remaining.some((path: string) => path.includes('/invented-careers-page')),
    'the flag has no unit to repair against and must survive to remaining, exactly like any other unrepairable flag',
  );
});

// ---------------------------------------------------------------------------
// A fourth audit pass found price, shipping, hero and description slots entirely OUTSIDE the
// deterministic gate on a live build — makeCheckOnce only ran the attribution and quote checks,
// so a strict build could publish an invented price or an unstated commercial claim anywhere
// EXCEPT a review quote, unchecked. These three tests each isolate one of the audit's own named
// cases end to end through the REAL runFastLane pipeline (not the bare jev.ts functions), with
// the fake Jev checker deliberately blind (no 'FABRICATED' marker), so only the newly-wired
// deterministicClaimFlags/deterministicCommercialWordFlags calls inside makeCheckOnce can be the
// source of the flag.
// ---------------------------------------------------------------------------

test('strict run (makeCheckOnce wiring): an invented price ($199 when the brief says $248) is flagged and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. The Field Jacket is $248. https://shop.tallowrow.example.';
  const fill: Filler = (key, value, _at, limit) => {
    if (key === 'price') return '$199'.slice(0, limit ?? 24);
    return typeof value === 'string' ? value : null;
  };
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the price gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.some((path: string) => path.includes('price')),
    `an invented $199 price must be flagged when the brief says $248; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

test('strict run (makeCheckOnce wiring): "Free shipping" appearing in the hero body with no shipping info in the brief is flagged and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example.';
  // `Filler`'s `at` is relative to each unit's OWN template (every section's body field arrives
  // as the same bare "text.body"), so it cannot distinguish hero's body from any other section's —
  // an explicit `spine` override (the same technique the "invented review name" test above uses
  // for `name`) sets the exact field directly instead, and the fill step below just echoes
  // whatever value it is given back unchanged.
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; text: { body?: string } } | null>;
  const heroIndex = spineSections.findIndex((section) => section?.type === 'hero');
  spineSections[heroIndex]!.text.body = 'Free shipping on every order.';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the shipping-claim gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.includes(`sections[${heroIndex}].text.body`),
    `an unstated "Free shipping" claim in the hero must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

test('strict run (makeCheckOnce wiring): "5 stars" appearing in the shipping-returns body with no rating in the brief is flagged and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example. Orders ship within three business days.';
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; text: { body?: string } } | null>;
  const shippingIndex = spineSections.findIndex((section) => section?.type === 'shipping-returns');
  spineSections[shippingIndex]!.text.body = 'Orders ship within three business days. Rated 5 stars.';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the rating-claim gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.includes(`sections[${shippingIndex}].text.body`),
    `an unstated "5 stars" rating claim in the shipping-returns body must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

test('G8 dry run: the footer\'s link labels are fixed section labels — no fill can write one, and each opens a real section', async () => {
  // A live Cerebras build wrote "Shipping" into the old model-writable footer `links` list — a
  // label that named no section on the page — and the commercial-word gate refused it. The footer
  // now lists the page's own sections with the header nav's fixed labels.
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const spineSections = pkg.fixture.sections as Array<{ id: string; type: string; text: Record<string, unknown> } | null>;
  const footer = spineSections.find((section) => section?.type === 'footer')!;
  assert.equal(Object.hasOwn(footer.text, 'links'), false, 'the footer has no model-writable links field');
  const html = pkg.render(pkg.fixture, 'storefront-r1.html').html;
  const footerHtml = html.slice(html.indexOf(`<footer id="${footer.id}"`));
  const anchors = [...footerHtml.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((match) => ({ target: match[1]!, label: match[2]! }));
  assert.ok(anchors.length >= 2, footerHtml.slice(0, 400));
  for (const anchor of anchors) assert.ok(spineSections.some((section) => section?.id === anchor.target), `${anchor.label} -> #${anchor.target} is a section on this page`);
  assert.ok(anchors.some((anchor) => anchor.label === 'Shop'));
});

// ---------------------------------------------------------------------------
// Effects budget: at most 2 effects total, at most 1 of which is a real <script> on the page.
// An independent audit read storefront's catalog.json (masked-heading + glare-hover, both
// declared placements) and concluded both are JS effects, over the family's own ≤1-script rule.
// That reading does not match this compiler's actual behavior: `glare-hover`'s catalog entry is
// `"kind": "css-only"` (packages/genui-catalog/components/glare-hover/meta.json agrees — its
// effect is pure CSS; `auto.js` only merges per-instance prop overrides into CSS custom
// properties, the same "css-only" convention several other catalog components use), and the
// shared compiler's `applyEffects` (plugins/_official/shared/agency-compiler/scripts/effects.ts)
// only ever emits a `<script>` tag for a component whose `componentKind(id) === 'js'` — so
// applying BOTH storefront effects together still yields exactly one `<script>` element. This
// test proves that directly against the real rendered page, rather than trusting either reading.
// ---------------------------------------------------------------------------

test('effects budget: applying both of storefront\'s declared effects together still emits at most one <script> tag', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const plan = {
    effects: [
      { placement: 'hero-title' as const, componentId: 'masked-heading', source: 'hint' as const },
      { placement: 'card-surface' as const, componentId: 'glare-hover', source: 'hint' as const },
    ],
  };
  const result = pkg.render(pkg.fixture, 'storefront-r1.html', { effects: plan });
  const scriptTagCount = (result.html.match(/<script\b/gi) ?? []).length;
  assert.equal(scriptTagCount, 1, `expected exactly one <script> tag with both effects applied, got ${scriptTagCount}`);
  assert.deepEqual(
    result.effects?.applied?.map((item) => item.componentId).sort(),
    ['glare-hover', 'masked-heading'],
    'both effects were genuinely applied, not silently skipped, when this assertion ran',
  );
  assert.equal(
    result.effects?.applied?.find((item) => item.componentId === 'masked-heading')?.kind,
    'js',
  );
  assert.equal(
    result.effects?.applied?.find((item) => item.componentId === 'glare-hover')?.kind,
    'css-only',
    'glare-hover is genuinely css-only, not a second script effect wearing a css-only label',
  );
});

// ---------------------------------------------------------------------------
// A fifth audit pass (round 9, storefront-r5-grok.md BLOCK 1) found `isNavLabelPath` exempted
// EVERY path ending in `cta`/`ctaLabel`/`links(\[N\])` from `deterministicCommercialWordFlags` —
// not just page-structure nav labels, but the header CTA and the buy-preorder button themselves,
// real rendered purchase-button copy. `isNavLinkPath`/`navLinkMatchesSectionHeading` narrow the
// exemption to a `links`/`links[N]` slot whose own text literally IS one of the page's own
// section headings; `cta`/`ctaLabel` are never exempt any more. These two tests prove the button
// paths are gated again. (The footer-link test that used to follow is gone: since the G8 dry run
// the footer has no model-writable link labels at all — see the legacy-strip test below.)
// ---------------------------------------------------------------------------

test('strict run (nav exemption narrowed): the header CTA is no longer exempt — "Free shipping" with no shipping fact in the brief flags and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example.';
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; text: { cta?: string } } | null>;
  const headerIndex = spineSections.findIndex((section) => section?.type === 'header');
  spineSections[headerIndex]!.text.cta = 'Free shipping';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the header-CTA gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.includes(`sections[${headerIndex}].text.cta`),
    `an unstated "Free shipping" claim on the header CTA must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

test('strict run (nav exemption narrowed): the buy-preorder ctaLabel is no longer exempt — "Guaranteed" with no such promise in the brief flags and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = 'Tallow Row, a Portland workwear label. Field Jacket, $248, https://shop.tallowrow.example.';
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; text: { ctaLabel?: string } } | null>;
  const buyIndex = spineSections.findIndex((section) => section?.type === 'buy-preorder');
  spineSections[buyIndex]!.text.ctaLabel = 'Guaranteed';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the buy-button gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.includes(`sections[${buyIndex}].text.ctaLabel`),
    `an unstated "Guaranteed" claim on the buy-preorder button must be flagged; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

test('G8 dry run: an old saved recipe that still carries footer.text.links compiles, and the legacy labels never render', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const legacy = structuredClone(pkg.fixture) as { sections: Array<{ type: string; text: Record<string, unknown> } | null> };
  const footer = legacy.sections.find((section) => section?.type === 'footer')!;
  footer.text.links = ['Shop', 'Free shipping on every order', 'Contact'];
  const html = pkg.render(legacy as never, 'storefront-r1.html').html;
  assert.equal(html.includes('Free shipping on every order'), false, 'a legacy footer label is stripped, never rendered');
});

// ---------------------------------------------------------------------------
// Round 11 (storefront-r7-grok.md, item A): `x-verify: 'traceable'` on product-details' `value`
// row catches a fabricated material/origin fact that neither `deterministicClaimFlags` (no digit)
// nor `deterministicCommercialWordFlags` (no denylist word) could ever see — this is exactly the
// gap product-detail rows had before this round: "Jev-only".
// ---------------------------------------------------------------------------

test('strict run (traceable rows, item A): a fabricated product-detail value ("Made in Seattle" vs. the brief\'s "made in Portland") flags and fails the strict build closed', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = readFileSync(path.join(FIXTURES_DIR, 'rich.txt'), 'utf8');
  const spine = structuredClone(pkg.fixture);
  const spineSections = spine.sections as Array<{ type: string; items?: Array<{ label: string; value: string }> } | null>;
  const detailsIndex = spineSections.findIndex((section) => section?.type === 'product-details');
  spineSections[detailsIndex]!.items![1]!.value = 'Made in Seattle, Washington';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  let created = false;
  const report = await runFastLane({
    pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true,
    ensurePublisher: async () => { created = true; throw new Error('ensurePublisher must never be called once the traceable-row gate has failed'); },
  });
  assert.equal(created, false, 'nothing was ever published');
  assert.equal(report.strict!.passed, false, 'the gate failed');
  assert.ok(
    report.verify!.flagged.includes(`sections[${detailsIndex}].items[1].value`),
    `a fabricated origin fact with no digit and no denylist word must still be flagged, via the new traceable-row check; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});

// ---------------------------------------------------------------------------
// Round 11, item D: the exact faithful-paraphrase case the audit itself asked for — "ships within
// three business days" (rich.txt's own wording) written back as "shipping in three business
// days" must still pass, under plain stemming (the FIX item).
// ---------------------------------------------------------------------------

test('strict run (round 11 item D): "shipping in three business days" (a stemmed paraphrase of rich.txt\'s own "Orders ship within three business days") still passes strict', async () => {
  const pkg = await loadFamilyPackage(PACKAGE_DIR, 'storefront');
  const brief = readFileSync(path.join(FIXTURES_DIR, 'rich.txt'), 'utf8');
  assert.ok(/\bship\b/i.test(brief) && !/\bshipping\b/i.test(brief), 'sanity: rich.txt must say "ship" (the verb), never "shipping", for this test to prove anything');
  const spine = structuredClone(pkg.fixture);
  // See the sibling nav-link-exemption test's own comment: the "Boxy cut" blurb is an unrelated,
  // accepted `deterministicProperNounFlags` residual (wordlist reverted to size 50 per BLOCK B1),
  // neutralized so it doesn't sink this test's own unrelated strict-pass assertion.
  neutralizeBoxyBlurb(spine);
  const spineSections = spine.sections as Array<{ type: string; text: { body?: string } } | null>;
  const shippingIndex = spineSections.findIndex((section) => section?.type === 'shipping-returns');
  spineSections[shippingIndex]!.text.body = 'Shipping in three business days. Unworn pieces with tags attached can be returned within thirty days for a refund.';
  const fill: Filler = (_key, value) => (typeof value === 'string' ? value : null);
  const model = fakeModel({ fill });
  const verify = fakeJevChecker(['FABRICATED']);
  const report = await runFastLane({ pkg, brief, spine, mode: 'sections', entry: 'storefront-r1.html', revision: 1, model, modelName: 'fake', verify, strict: true });
  assert.equal(report.strict!.passed, true, `a faithful stemmed paraphrase must still publish; strict: ${JSON.stringify(report.strict)}`);
  assert.ok(
    !report.verify!.flagged.includes(`sections[${shippingIndex}].text.body`),
    `"shipping" must trace to the brief's own "ships" under plain stemming; flaggedPaths: ${JSON.stringify(report.verify!.flagged)}`,
  );
});
