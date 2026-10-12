// node --test evals/genui/xmock-score.test.mjs — the x-mock eval's pass rule and offline re-score.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KINDS, REQUIRED_BUILDS, captionEvidence, elementById, familyFacts, liveBuildOutcome, overallPass, publishedEntry, rescoreRow, summarizeKinds } from './xmock-score.mjs';

// A clean live row: ten checked-in fact slots, twenty skipped x-mock slots, all captioned.
const row = (kind, over = {}) => ({ kind, ok: true, checked: 40, illustrative: 20, flaggedSlots: [], remaining: 0, evidence: 'present', mockSlots: 20, mockCaptions: { list: 'Sample data' }, uncaptionedMock: [], ...over });
const fullRun = (count = 10) => KINDS.flatMap((kind) => Array.from({ length: count }, () => row(kind)));

test('a full clean live run passes', () => {
  const kinds = summarizeKinds(fullRun(), { live: true });
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), true);
});

test('a live run in verify mode after can never pass', () => {
  const kinds = summarizeKinds(fullRun(), { live: true });
  assert.equal(overallPass(kinds, { verifyMode: 'after' }), false);
});

test('fails on a published flagged fact slot, even when the rate passes', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, flaggedSlots: [{ path: 'sections[1].text.heading', text: 'Since 1990', repeatsBriefClaim: false }] } : r));
  const kinds = summarizeKinds(rows, { live: true });
  const k = kinds[rows[0].kind];
  assert.ok(k.rate < 0.05);
  assert.equal(k.noUnlabelledClaims, false);
  assert.equal(k.pass, false);
  assert.match(k.failures.join('; '), /1 flagged fact slot/);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), false);
});

test('fails on a VERIFY_FAILED build, reported as a caught fabrication', () => {
  const rows = fullRun().map((r, index) => (index === 3
    ? { ...r, brief: 'marketing-site-04', ok: false, errorCode: 'VERIFY_FAILED', remaining: 2, error: 'faithfulness gate' }
    : r));
  const kinds = summarizeKinds(rows, { live: true });
  const k = kinds['marketing-site'];
  assert.equal(k.verifyFailed, 1);
  assert.deepEqual(k.verifyFailedBriefs, ['marketing-site-04']);
  assert.equal(k.pass, false);
  assert.match(k.failures.join('; '), /VERIFY_FAILED \(caught fabrication; 2 fact slot\(s\) left flagged after repair\)/);
  assert.equal(k.remainingInVerifyFailed, 2);
  assert.match(k.failures.join('; '), /9 of 10 rows done/);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), false);
});

test('fails when a done row still has a remaining fact flag', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, remaining: 1 } : r));
  assert.equal(overallPass(summarizeKinds(rows, { live: true }), { verifyMode: 'strict' }), false);
});

test('fails on a skipped x-mock slot the page does not caption', () => {
  const rows = fullRun().map((r, index) => (index === 0
    ? { ...r, brief: 'app-shell-01', mockCaptions: { 'app-shell-list': null }, uncaptionedMock: ['sections[3].items[0].name'] }
    : r));
  const kinds = summarizeKinds(rows, { live: true });
  const k = kinds[rows[0].kind];
  assert.deepEqual(k.uncaptionedMock, [{ brief: 'app-shell-01', path: 'sections[3].items[0].name' }]);
  assert.equal(k.pass, false);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), false);
});

test('fails on a live row with skipped x-mock slots and no caption evidence', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, brief: 'x-01', evidence: undefined, mockCaptions: undefined, uncaptionedMock: undefined } : r));
  const kinds = summarizeKinds(rows, { live: true });
  const k = kinds[rows[0].kind];
  assert.deepEqual(k.missingCaptionEvidence, [{ brief: 'x-01', problem: 'no caption evidence recorded' }]);
  assert.equal(k.pass, false);
});

// Review BLOCK 1: the evidence requirement must not key off the self-reported `illustrative` count.
test('fails on a done build with illustrative 0 and no caption evidence', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, brief: 'x-01', illustrative: 0, evidence: undefined, mockCaptions: undefined, uncaptionedMock: undefined } : r));
  const kinds = summarizeKinds(rows, { live: true });
  assert.equal(kinds[rows[0].kind].pass, false);
  assert.equal(kinds[rows[0].kind].missingCaptionEvidence.length, 1);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), false);
  // Same with `illustrative` omitted entirely.
  const omitted = fullRun().map((r, index) => (index === 0 ? { ...r, illustrative: undefined, evidence: undefined, mockCaptions: undefined } : r));
  assert.equal(overallPass(summarizeKinds(omitted, { live: true }), { verifyMode: 'strict' }), false);
});

// Review BLOCK 2: a failed recipe or page read is recorded on the row and fails the kind.
test('fails on a done build whose recipe or page could not be read', () => {
  const recipeFailed = captionEvidence(null, '<main></main>', new Set());
  assert.equal(recipeFailed.evidence, 'missing');
  assert.match(recipeFailed.evidenceError, /recipe not read/);
  const pageFailed = captionEvidence({ sections: [] }, '', new Set());
  assert.equal(pageFailed.evidence, 'missing');
  assert.match(pageFailed.evidenceError, /page not read/);
  const rows = fullRun().map((r, index) => (index === 0
    ? { ...r, brief: 'x-01', mockCaptions: undefined, uncaptionedMock: undefined, evidence: 'missing', evidenceError: 'recipe not read: GET agency-site-state/r1/recipe.json -> 404' }
    : r));
  const k = summarizeKinds(rows, { live: true })[rows[0].kind];
  assert.equal(k.pass, false);
  assert.match(k.failures.join('; '), /x-01 \(recipe not read: GET .* -> 404\)/);
});

test('fails when the gate skipped more x-mock slots than the published recipe carries', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, illustrative: 21, mockSlots: 20 } : r));
  const k = summarizeKinds(rows, { live: true })[rows[0].kind];
  assert.equal(k.pass, false);
  assert.match(k.missingCaptionEvidence[0].problem, /skipped 21 .* carries 20/);
});

// Review FIX 6: exactly ten rows per kind; an appended retry is not 10 of 10.
test('fails a kind with 11 rows, even when all 11 are done', () => {
  const rows = [...fullRun(), row('app-shell')];
  const kinds = summarizeKinds(rows, { live: true });
  assert.equal(kinds['app-shell'].builds, 11);
  assert.equal(kinds['app-shell'].allDone, false);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), false);
});

test('publishedEntry reads the entry and revision from the build record', () => {
  const note = '# Acme — Agency Site state (registered r3)\n\n- Entry: `app-shell-r3.html`\n- Family: app-shell, revision 3\n- Recipe digest: `x`\n';
  assert.deepEqual(publishedEntry(note), { entry: 'app-shell-r3.html', revision: 3 });
  assert.equal(publishedEntry('- Entry: `a.html`\n'), null);
  assert.equal(publishedEntry(null), null);
});

// A correct strict live run CAN pass. Rows built from daemon-shaped answers (a terminal `done`
// snapshot and the `verify` event's `counts`, with a flag the gate repaired) for ten briefs per
// kind give ok = 10 per kind, and a first-pass rate under 5 % passes.
test('a strict live run built from daemon-shaped build answers passes', () => {
  const rows = KINDS.flatMap((kind) => Array.from({ length: 10 }, (_, index) => ({
    kind,
    flaggedSlots: [],
    evidence: 'present',
    mockSlots: 20,
    mockCaptions: { s: 'Sample data' },
    uncaptionedMock: [],
    ...liveBuildOutcome({
      snapshot: { id: `b-${kind}-${index}`, status: 'done', projectId: 'p1' },
      counts: { checked: 40, illustrative: 20, flagged: index === 0 ? 1 : 0, repaired: index === 0 ? 1 : 0, remaining: 0 },
    }),
  })));
  const kinds = summarizeKinds(rows, { live: true });
  for (const kind of KINDS) assert.equal(kinds[kind].ok, 10);
  assert.equal(kinds['app-shell'].flagged, 1);
  assert.equal(overallPass(kinds, { verifyMode: 'strict' }), true);
});

test('liveBuildOutcome strict: ok only with a done build, verify counts and nothing remaining', () => {
  const done = { status: 'done' };
  const counts = { checked: 3, illustrative: 1, flagged: 1, repaired: 1, remaining: 0 };
  assert.deepEqual(liveBuildOutcome({ snapshot: done, counts }), { ok: true, checked: 3, illustrative: 1, flaggedCount: 1, remaining: 0 });
  const caught = liveBuildOutcome({ snapshot: { status: 'failed', error: { code: 'VERIFY_FAILED', message: 'gate' } }, counts: { ...counts, remaining: 1, repaired: 0 } });
  assert.equal(caught.ok, false);
  assert.equal(caught.errorCode, 'VERIFY_FAILED');
  assert.match(liveBuildOutcome({ snapshot: done, counts: undefined }).error, /no verify counts/);
});

test('liveBuildOutcome after: ok only with a done build, a done verdict and verify counts', () => {
  const done = { status: 'done' };
  const counts = { checked: 3, illustrative: 1, flagged: 0, repaired: 0, remaining: 0 };
  const after = (over) => liveBuildOutcome({ verifyMode: 'after', snapshot: done, verify: done, counts, ...over });
  assert.equal(after({}).ok, true);
  assert.equal(after({ verify: { status: 'skipped' } }).ok, false);
  assert.equal(after({ verify: { status: 'pending' } }).ok, false);
  assert.equal(after({ snapshot: { status: 'failed' } }).ok, false);
  assert.match(after({ counts: undefined }).error, /no verify counts/);
});

test('a truncated live run fails: one build, or fewer than ten done per kind', () => {
  assert.equal(overallPass(summarizeKinds([row('app-shell')], { live: true })), false);
  const nine = summarizeKinds(fullRun(REQUIRED_BUILDS - 1), { live: true });
  assert.equal(Object.values(nine).some((k) => k.pass), false);
  assert.equal(overallPass(nine), false);
  // Ten attempted but only nine finished fails too: the bar is 10/10.
  const rows = fullRun().map((r, index) => (index % 10 === 9 ? { ...r, ok: false } : r));
  assert.equal(overallPass(summarizeKinds(rows, { live: true })), false);
});

test('a run missing a kind fails, live or rescore', () => {
  const twoKinds = fullRun().filter((r) => r.kind !== 'crm-dashboard');
  assert.equal(overallPass(summarizeKinds(twoKinds, { live: true })), false);
  assert.equal(overallPass(summarizeKinds(twoKinds, { live: false })), false);
});

test('the rate rule is rate < 5 % per kind, on first-pass flags the gate repaired', () => {
  // Strict builds repair what the gate flags, so the rate reads `flaggedCount`, not published slots.
  const at = (perBuild) => summarizeKinds(fullRun().map((r) => (r.kind === 'marketing-site' ? { ...r, flaggedCount: perBuild } : r)), { live: true });
  // 400 checked per kind: 10 flagged is 2.5 % (passes); 20 is exactly 5 % (fails).
  const below = at(1);
  assert.equal(below['marketing-site'].rate, 10 / 400);
  assert.equal(below['marketing-site'].pass, true);
  const atLimit = at(2);
  assert.equal(atLimit['marketing-site'].rate, 0.05);
  assert.equal(atLimit['marketing-site'].pass, false);
  assert.equal(overallPass(atLimit), false);
});

test('captionEvidence: a slot is captioned only inside its own section', () => {
  const recipe = { sections: [{ id: 'topnav' }, { id: 'hero' }, { id: 'list' }] };
  const html = '<main><nav id="topnav"><div data-od-mock="sample-data"><p>Ana</p><p class="x" data-od-mock="caption">Sample data</p></div></nav>'
    + '<section id="hero"><h1>Hi</h1></section>'
    + '<section id="list" data-od-mock="sample-data"><p data-od-mock="caption">  </p><section id="inner"></section><p>Row</p></section>'
    + '<p data-od-mock="caption">Stray caption outside</p></main>';
  const evidence = captionEvidence(recipe, html, new Set(['sections[0].items.user', 'sections[2].items[0].name', 'brand.name']));
  assert.equal(evidence.evidence, 'present');
  assert.equal(evidence.mockSlots, 3);
  assert.deepEqual(evidence.mockCaptions, { topnav: 'Sample data', list: null });
  assert.deepEqual(evidence.uncaptionedMock, ['brand.name', 'sections[2].items[0].name']);
  assert.equal(captionEvidence(recipe, null, new Set()).evidence, 'missing');
  assert.equal(elementById(html, 'list').endsWith('<p>Row</p></section>'), true);
});

// Review FIX 7: single quotes and any whitespace before `id` match; an absent section is missing
// evidence, never read as captioned.
test('elementById accepts single-quoted ids and any whitespace; a missing section is missing evidence', () => {
  const html = "<main><section\n\tid='list' class=\"x\"><p data-od-mock='caption'>Sample data</p></section></main>";
  assert.equal(captionEvidence({ sections: [{ id: 'list' }] }, html, new Set(['sections[0].items[0].name'])).evidence, 'present');
  assert.equal(elementById('<p data-od-id="list">x</p>', 'list'), null);
  const absent = captionEvidence({ sections: [{ id: 'list' }, { id: 'gone' }] }, html, new Set(['sections[0].items[0].name', 'sections[1].items[0].name']));
  assert.equal(absent.evidence, 'missing');
  assert.match(absent.evidenceError, /not found in the published page: gone/);
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, ...absent } : r));
  assert.equal(summarizeKinds(rows, { live: true })[rows[0].kind].pass, false);
});

test('flagged fact slots are listed and the unlabelled candidates counted', () => {
  const rows = fullRun().map((r, index) => (index === 0
    ? { ...r, flaggedSlots: [{ path: 'a', text: 'Award-winning since 1990', repeatsBriefClaim: false }, { path: 'b', text: 'Riverbend', repeatsBriefClaim: true }] }
    : r));
  const k = summarizeKinds(rows, { live: true })[rows[0].kind];
  assert.deepEqual(k.flaggedPaths, ['a', 'b']);
  assert.equal(k.unlabelledClaimCandidates, 1);
});

test('a flagged x-mock path fails the run even when every rate passes', () => {
  const rows = fullRun().map((r, index) => (index === 0 ? { ...r, mockViolations: ['sections[0].items[0].value'] } : r));
  assert.equal(overallPass(summarizeKinds(rows, { live: true })), false);
});

// A tiny synthetic family: one fact slot and two x-mock slots.
const facts = familyFacts(() => ({
  schema: { type: 'object', properties: { m: { type: 'object', 'x-mock': true } } },
  fixture: { f: 'fact', m: { a: 'one', b: 'two' } },
}));

test('rescoreRow takes illustrative from the report when the report carries it', () => {
  const r = rescoreRow({ kind: 'app', ok: true, verify: { status: 'done', flagged: ['f'] }, verifyEventCounts: { checked: 1, illustrative: 2 } }, facts);
  assert.equal(r.illustrativeSource, 'report');
  assert.equal(r.checked, 1);
  assert.equal(r.illustrative, 2);
});

test('rescoreRow uses the package recipe only when the report checked exactly its slots', () => {
  const verified = rescoreRow({ kind: 'app', ok: true, verify: { status: 'done', flagged: ['m.a'] }, verifyEventCounts: { checked: 3 }, summary: { nulled: 0 } }, facts);
  assert.equal(verified.illustrativeSource, 'package-recipe-verified');
  assert.equal(verified.checked, 1);
  assert.equal(verified.excludedAsMock, 1);
  // Checked a different number of slots than the package recipe has: not derivable, not invented.
  const other = rescoreRow({ kind: 'app', ok: true, verify: { status: 'done', flagged: [] }, verifyEventCounts: { checked: 2 }, summary: { nulled: 0 } }, facts);
  assert.equal(other.ok, false);
  assert.equal(other.illustrativeSource, undefined);
  assert.match(other.error, /not derivable/);
  // Something was nulled: the package recipe no longer describes what was checked.
  const nulled = rescoreRow({ kind: 'app', ok: true, verify: { status: 'done', flagged: [] }, verifyEventCounts: { checked: 3 }, summary: { nulled: 1 } }, facts);
  assert.equal(nulled.ok, false);
});

test('rescoreRow recomputes from a saved recipe, where a nulled group has no mock slots', () => {
  const r = rescoreRow({ kind: 'app', ok: true, verify: { status: 'done', flagged: [] }, verifyEventCounts: { checked: 1 }, recipe: { f: 'fact', m: null } }, facts);
  assert.equal(r.illustrativeSource, 'recipe');
  assert.equal(r.illustrative, 0);
  assert.equal(r.checked, 1);
});

// The caption scan must read the real family markup, not only the hand-written fixture above:
// render each kind's package recipe and check every x-mock slot is found under its caption.
test('captionEvidence finds a caption for every x-mock slot in the three real family renders', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { recipeMockPaths } = await import('./xmock-score.mjs');
  const repo = path.resolve(import.meta.dirname, '../..');
  const renderers = { 'app-shell': 'renderAppShell', 'crm-dashboard': 'renderCrmDashboard', 'marketing-site': 'renderMarketingSite' };
  for (const kind of KINDS) {
    const dir = path.join(repo, 'plugins/_official/examples', `agency-${kind}`);
    const render = (await import(path.join(dir, 'compiler/scripts/families', kind, 'render.ts')))[renderers[kind]];
    const recipe = JSON.parse(readFileSync(path.join(dir, 'families', kind, 'recipe.json'), 'utf8'));
    const schema = JSON.parse(readFileSync(path.join(dir, 'compiler/scripts/families', kind, 'recipe.schema.json'), 'utf8'));
    const mock = recipeMockPaths(schema, recipe);
    const evidence = captionEvidence(recipe, render(recipe, {}, { entry: `${kind}-r1.html`, outputScope: 'static-prototype' }), mock);
    assert.ok(mock.size > 0, `${kind} has x-mock slots`);
    assert.equal(evidence.evidence, 'present', `${kind}: every section found`);
    assert.deepEqual(evidence.uncaptionedMock, [], `${kind}: every x-mock slot is captioned`);
  }
});
