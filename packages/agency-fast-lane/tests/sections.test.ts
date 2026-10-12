/**
 * The optional-section keep/drop decision (`src/sections.ts`): the one Jev request's shape, the
 * 0.75 threshold edge, malformed answers, Jev failures (500, network, timeout) that keep every
 * section and report a fixed skip code, a caller's cancellation that is rethrown, and explicit hints that override Jev and are
 * never sent to it. Offline: every request goes to a fake `fetch`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applySectionDrops, briefHasQuote, buildKeepDropQuestions, createJevSectionJudge, decideSections, optionalSectionsOf, resolveKeepDrop, withoutDroppedSections, type OptionalSection, type SectionJudge } from '../src/sections.ts';
import { editableTemplate, unitsOf, type JsonObject } from '../src/spine.ts';
import { loadFamilyPackage } from '../src/family.ts';
import { WATSON_DIR } from './fixtures.ts';

const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, open Saturdays.';

const section = (index: number, id: string, extra: Partial<OptionalSection> = {}): OptionalSection => ({
  index,
  id,
  type: id,
  label: `${id} label`,
  dropWhen: `The brief has no ${id}.`,
  keepWhen: `The brief states ${id}.`,
  navSlots: [],
  dropped: false,
  ...extra,
});

const REVIEWS = section(7, 'reviews', { label: 'customer reviews', navSlots: ['sections[0].content.reviewsLabel'] });
const SUPPORT = section(8, 'support');

type Captured = { body: JsonObject; signal: AbortSignal | undefined };

function fakeFetch(captured: Captured[], respond: (body: JsonObject) => Response | Promise<Response>): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({ body, signal: init?.signal ?? undefined });
    return respond(body);
  }) as typeof fetch;
}

const answer = (answers: JsonObject) => () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });

test('one request per build: the brief as state, one Noul question per optional section', async () => {
  const { state, questions } = buildKeepDropQuestions(BRIEF, [REVIEWS, SUPPORT]);
  assert.deepEqual(state, { brief: BRIEF });
  assert.deepEqual(Object.keys(questions), ['drop_7', 'drop_8']);
  const reviews = questions.drop_7!;
  assert.equal(reviews.type, 'noul');
  assert.match(reviews.instructions, /`customer reviews` section/);
  assert.match(reviews.instructions, /`brief` gives nothing for it/);
  assert.equal(reviews.criteria.true, 'The brief has no reviews. Filling it would mean inventing it.');
  assert.equal(reviews.criteria.false, 'The brief states reviews.');

  const captured: Captured[] = [];
  const judge = createJevSectionJudge({ apiKey: 'k', fetchImpl: fakeFetch(captured, answer({ drop_7: { type: 'noul', noul: 0.9 }, drop_8: { type: 'noul', noul: 0.1 } })) });
  const verdict = await judge.judge({ brief: BRIEF, optional: [REVIEWS, SUPPORT] });
  assert.equal(captured.length, 1, 'exactly one request');
  assert.deepEqual(Object.keys(captured[0]!.body.questions as JsonObject), ['drop_7', 'drop_8']);
  assert.equal(captured[0]!.body.model, 'jev-1.13.0');
  assert.deepEqual(verdict.dropped, ['reviews']);
  assert.deepEqual(verdict.kept, ['support']);
  assert.equal(verdict.skipped, undefined);
});

test('threshold edge: 0.749 keeps, 0.75 drops', () => {
  const kept = resolveKeepDrop({ drop_7: { type: 'noul', noul: 0.749 } }, [REVIEWS]);
  assert.deepEqual(kept, { dropped: [], kept: ['reviews'], warnings: [] });
  const dropped = resolveKeepDrop({ drop_7: { type: 'noul', noul: 0.75 } }, [REVIEWS]);
  assert.deepEqual(dropped, { dropped: ['reviews'], kept: [], warnings: [] });
  assert.deepEqual(resolveKeepDrop({ drop_7: { type: 'noul', noul: 0.8 } }, [REVIEWS], 0.85).kept, ['reviews'], 'the threshold is configurable');
});

test('malformed answers keep the section and add a warning', () => {
  const cases: Array<[string, unknown]> = [
    ['string noul', { type: 'noul', noul: '0.9' }],
    ['NaN', { type: 'noul', noul: Number.NaN }],
    ['above 1', { type: 'noul', noul: 1.2 }],
    ['below 0', { type: 'noul', noul: -0.1 }],
    ['wrong type', { type: 'choice', noul: 0.9 }],
    ['not an object', 0.9],
    ['missing', undefined],
  ];
  for (const [name, value] of cases) {
    const resolved = resolveKeepDrop(value === undefined ? {} : { drop_7: value }, [REVIEWS]);
    assert.deepEqual(resolved.dropped, [], `${name}: nothing dropped`);
    assert.deepEqual(resolved.kept, ['reviews'], `${name}: kept`);
    assert.equal(resolved.warnings.length, 1, `${name}: one warning`);
    assert.match(resolved.warnings[0]!, /^reviews: kept/);
  }
  assert.deepEqual(resolveKeepDrop('not answers', [REVIEWS]).kept, ['reviews'], 'a non-object answers table keeps everything');
});

test('Jev unavailable keeps every section and says why: 500, network error, timeout, unreadable body', async () => {
  const failures: Array<[string, typeof fetch, RegExp]> = [
    ['500', fakeFetch([], () => new Response('<html>stack trace with secrets</html>', { status: 500 })), /^jev-http-error$/],
    ['401', fakeFetch([], () => new Response('nope', { status: 401 })), /^jev-unauthorized$/],
    ['429', fakeFetch([], () => new Response('slow down', { status: 429 })), /^jev-rate-limited$/],
    // A transport error's own text never rides out: it could carry anything, a key included.
    ['network', (async () => { throw new TypeError('fetch failed: Bearer secrets-in-the-message'); }) as typeof fetch, /^jev-unreachable$/],
    ['not JSON', fakeFetch([], () => new Response('{oops', { status: 200 })), /^jev-bad-answer$/],
  ];
  for (const [name, fetchImpl, reason] of failures) {
    const judge = createJevSectionJudge({ apiKey: 'k', fetchImpl });
    const verdict = await judge.judge({ brief: BRIEF, optional: [REVIEWS, SUPPORT] });
    assert.deepEqual(verdict.dropped, [], `${name}: nothing dropped`);
    assert.deepEqual(verdict.kept, ['reviews', 'support'], `${name}: everything kept`);
    assert.match(verdict.skipped ?? '', reason, `${name}: skipped says why`);
    assert.ok(!(verdict.skipped ?? '').includes('secrets'), `${name}: never the response body`);
  }

  // A real timeout: the request waits on its own signal, which only the judge's timeout fires.
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;
  const judge = createJevSectionJudge({ apiKey: 'k', fetchImpl: hanging, timeoutMs: 20 });
  const verdict = await judge.judge({ brief: BRIEF, optional: [REVIEWS] });
  assert.deepEqual(verdict.kept, ['reviews']);
  assert.equal(verdict.skipped, 'jev-timeout', 'a timeout is reported as skipped, not thrown');
});

test('a caller cancellation is rethrown, never folded into skipped', async () => {
  const controller = new AbortController();
  const captured: Captured[] = [];
  const aborting = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ body: {}, signal: init?.signal ?? undefined });
    controller.abort();
    throw init?.signal?.reason ?? new DOMException('aborted', 'AbortError');
  }) as typeof fetch;
  const judge = createJevSectionJudge({ apiKey: 'k', fetchImpl: aborting, signal: controller.signal });
  await assert.rejects(judge.judge({ brief: BRIEF, optional: [REVIEWS] }), (error: unknown) => (error as { name?: string }).name === 'AbortError');
  assert.ok(captured[0]!.signal, 'the request carries a signal combining the timeout and the cancellation');
  assert.equal(captured[0]!.signal!.aborted, true, 'the caller abort reached the request');
});

test('hints override Jev and are never sent; an unknown hint id is ignored with a warning', async () => {
  const asked: string[][] = [];
  const judge: SectionJudge = {
    judge: async ({ optional }) => {
      asked.push(optional.map((candidate) => candidate.id));
      return { dropped: optional.map((candidate) => candidate.id), kept: [], warnings: [], ms: 3, calls: 1 };
    },
  };
  const decision = await decideSections({ brief: BRIEF, optional: [REVIEWS, SUPPORT], hints: { reviews: 'keep', nonsense: 'drop' }, judge });
  assert.deepEqual(asked, [['support']], 'the hinted id is not sent to Jev');
  assert.deepEqual(decision.kept, ['reviews']);
  assert.deepEqual(decision.dropped, ['support']);
  assert.equal(decision.source, 'jev');
  assert.deepEqual(decision.warnings, ['nonsense: not an optional section of this family, hint ignored']);

  const allHinted = await decideSections({ brief: BRIEF, optional: [REVIEWS, SUPPORT], hints: { reviews: 'drop', support: 'keep' }, judge });
  assert.equal(asked.length, 1, 'no request at all when every optional section is hinted');
  assert.deepEqual(allHinted, { dropped: ['reviews'], restored: [], kept: ['support'], source: 'hint', warnings: [], ms: 0 });
});

test('no judge (verify off, or a repair) keeps every unhinted section; a section already dropped stays dropped unless a keep hint restores it', async () => {
  const none = await decideSections({ brief: BRIEF, optional: [REVIEWS, SUPPORT] });
  assert.deepEqual(none, { dropped: [], restored: [], kept: ['reviews', 'support'], source: 'default', warnings: [], ms: 0 });

  const already = section(7, 'reviews', { dropped: true });
  const stays = await decideSections({ brief: BRIEF, optional: [already, SUPPORT] });
  assert.deepEqual(stays.dropped, ['reviews'], 'a null already in the spine is not re-judged and stays dropped');
  const restored = await decideSections({ brief: BRIEF, optional: [already], hints: { reviews: 'keep' } });
  assert.deepEqual(restored.restored, ['reviews']);
  assert.deepEqual(restored.kept, ['reviews']);

  const skipped = await decideSections({
    brief: BRIEF,
    optional: [REVIEWS],
    judge: { judge: async () => ({ dropped: [], kept: ['reviews'], warnings: [], ms: 1, calls: 0, skipped: 'jev-http-error' }) },
  });
  assert.equal(skipped.source, 'default');
  assert.equal(skipped.skipped, 'jev-http-error');

  // Hints decided some, Jev was asked about the rest and failed: `hint`, with the skip code.
  const hintedSkip = await decideSections({
    brief: BRIEF,
    optional: [REVIEWS, SUPPORT],
    hints: { support: 'drop' },
    judge: { judge: async () => ({ dropped: [], kept: ['reviews'], warnings: [], ms: 1, calls: 1, skipped: 'jev-timeout' }) },
  });
  assert.deepEqual({ source: hintedSkip.source, skipped: hintedSkip.skipped, dropped: hintedSkip.dropped, kept: hintedSkip.kept }, { source: 'hint', skipped: 'jev-timeout', dropped: ['support'], kept: ['reviews'] });
});

test('optionalSectionsOf reads x-optional off the family schema; applySectionDrops nulls, restores and refuses', async () => {
  const pkg = await loadFamilyPackage(WATSON_DIR, 'watson');
  const optional = optionalSectionsOf(pkg.schema, pkg.fixture);
  assert.deepEqual(optional.map(({ index, id, type, dropped }) => ({ index, id, type, dropped })), [{ index: 3, id: 'watson-about', type: 'about', dropped: false }]);
  assert.ok(optional[0]!.label && optional[0]!.dropWhen && optional[0]!.keepWhen);

  const spine = structuredClone(pkg.fixture);
  assert.deepEqual(applySectionDrops(spine, pkg.schema, pkg.fixture, ['watson-about']), []);
  assert.equal((spine.sections as unknown[])[3], null);
  assert.deepEqual(optionalSectionsOf(pkg.schema, spine, pkg.fixture).map((candidate) => [candidate.id, candidate.dropped]), [['watson-about', true]], 'a dropped section keeps its id from the reference recipe');

  // A dropped section is neither a unit nor shown to the whole-page prompt.
  const template = editableTemplate(spine);
  const units = unitsOf(template!, undefined).map((unit) => unit.label);
  assert.ok(!units.includes('watson-about') && !units.includes('section-3'), 'no unit for a dropped section');
  const shown = withoutDroppedSections(template, template!) as JsonObject;
  assert.equal((shown.sections as unknown[]).length, 4);

  // The positional filter refuses a value whose sections do not line up with the template.
  assert.throws(() => withoutDroppedSections({ sections: [{}, {}] }, template!), /do not line up/);

  applySectionDrops(spine, pkg.schema, pkg.fixture, [], ['watson-about']);
  assert.deepEqual((spine.sections as unknown[])[3], (pkg.fixture.sections as unknown[])[3], 'a keep hint restores the reference section');

  assert.throws(() => applySectionDrops(structuredClone(pkg.fixture), pkg.schema, pkg.fixture, ['watson-hero']), /watson-hero is not an optional section of family watson/);
});

test('CLI --keep/--drop become hints; a section named by both, or a non-id, is a usage error', async () => {
  const { parseFastLaneArgs, parseSectionHints, CliExit } = await import('../src/cli-args.ts');
  assert.equal(parseSectionHints([], []), undefined);
  assert.deepEqual(parseSectionHints(['final-cta'], ['reviews', 'support']), { 'final-cta': 'keep', reviews: 'drop', support: 'drop' });
  assert.throws(() => parseSectionHints(['reviews'], ['reviews']), (error: unknown) => error instanceof CliExit && /both name section reviews/.test(error.message));
  assert.throws(() => parseSectionHints(['Reviews!'], []), (error: unknown) => error instanceof CliExit && /not a section id/.test(error.message));
  const parsed = parseFastLaneArgs(['--family', 'wrenfield', '--brief', 'b.md', '--drop', 'reviews', '--keep', 'final-cta']);
  assert.deepEqual(parsed.sectionHints, { 'final-cta': 'keep', reviews: 'drop' });
});

test('briefHasQuote: a quoted passage of three or more words, straight or curly', () => {
  assert.equal(briefHasQuote('A client says "they fixed my crown the same day".'), true);
  assert.equal(briefHasQuote('Dana wrote \u201cthe kindest team in Boise\u201d last spring.'), true);
  assert.equal(briefHasQuote('Feature testimonials from patients and a review from a local school.'), false);
  assert.equal(briefHasQuote('The "Steady Hands" membership starts at fifteen dollars.'), false, 'a quoted name is not a quote');
  assert.equal(briefHasQuote("The clinic's staff aren't on call."), false, 'apostrophes are not quotes');
});

test('a section that requires a quote is dropped without asking Jev when the brief quotes no one', async () => {
  const quoted = { ...REVIEWS, requires: 'quote' as const };
  const asked: string[][] = [];
  const judge: SectionJudge = { judge: async ({ optional }) => { asked.push(optional.map((entry) => entry.id)); return { dropped: [], kept: optional.map((entry) => entry.id), warnings: [], ms: 3, calls: 1 }; } };

  const alone = await decideSections({ brief: BRIEF, optional: [quoted], judge });
  assert.deepEqual({ dropped: alone.dropped, kept: alone.kept, source: alone.source }, { dropped: ['reviews'], kept: [], source: 'brief' });
  assert.deepEqual(asked, [], 'nothing left to ask');
  assert.ok(alone.warnings.includes('reviews: dropped, the brief quotes no one'));

  const mixed = await decideSections({ brief: BRIEF, optional: [quoted, SUPPORT], judge });
  assert.deepEqual({ dropped: mixed.dropped, kept: mixed.kept, source: mixed.source }, { dropped: ['reviews'], kept: ['support'], source: 'jev' });
  assert.deepEqual(asked, [['support']], 'Jev is asked only about the rest');

  const withQuote = await decideSections({ brief: `${BRIEF} A patient says "best cleaning I ever had".`, optional: [quoted], judge });
  assert.deepEqual(withQuote.kept, ['reviews'], 'a quoted brief goes to Jev as before');

  const hinted = await decideSections({ brief: BRIEF, optional: [quoted], hints: { reviews: 'keep' }, judge });
  assert.deepEqual(hinted.kept, ['reviews'], 'an explicit keep hint still wins');

  const unjudged = await decideSections({ brief: BRIEF, optional: [quoted] });
  assert.deepEqual({ kept: unjudged.kept, source: unjudged.source }, { kept: ['reviews'], source: 'default' }, 'verify off keeps every section, as before');
});
