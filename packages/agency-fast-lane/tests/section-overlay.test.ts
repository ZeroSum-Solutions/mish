/**
 * Composition overlay (`src/section-overlay.ts`): selection, anchor resolution, deterministic
 * composition, digest, and the brief-only faithfulness boundary — design decision §2/§3
 * (<private-notes>/mishh-genui-production/motionsites/sol-design.md).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import {
  artifactDigest,
  assertSafeSectionId,
  fillSectionAdapter,
  resolveAnchorOffset,
  resolveDesignDirection,
  resolveSectionAdapter,
  SectionSelectionRefusedError,
  spliceSectionHtml,
  wrapFamilyPackageForOverlay,
  type SectionPlacement,
} from '../src/section-overlay.ts';
import type { ModelCall } from '../src/deepseek.ts';
import type { FaithfulnessChecker } from '../src/jev.ts';
import { withAdapterDeterministicGates } from '../src/run.ts';
import { fakeJevChecker, fakeModel, promptBlock, TEST_EDITORIAL_DIR } from './fixtures.ts';

/** Always fabricates, on every attempt including every faithfulness-repair round — unlike
 * `fakeModel`'s own repair path, which defaults back to an honest fill once it sees a rejection
 * prompt. Used to prove a fabrication that truly never gets fixed is refused. */
function alwaysFabricates(): ModelCall & { prompts: string[] } {
  const prompts: string[] = [];
  const call = (async ({ user }) => {
    prompts.push(user);
    const template = promptBlock(user, 'TEMPLATE') as { text: Record<string, string> };
    const answer: { text: Record<string, string> } = { text: {} };
    for (const key of Object.keys(template.text)) answer.text[key] = 'FABRICATED always';
    return { text: JSON.stringify(answer), usage: { input: 10, output: 5, cachedRead: 0 }, ms: 1, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

const loadTestEditorial = () => loadFamilyPackage(TEST_EDITORIAL_DIR, 'ownededitorial');
const BRIEF = 'TestEditorial, a design and technology studio in Los Angeles. Brand, product and motion work for ambitious teams.';

// ---------------------------------------------------------------------------------------------
// Adapter / direction resolution
// ---------------------------------------------------------------------------------------------

test('resolveSectionAdapter: the three reviewed HyperUI adapters resolve; an unknown id refuses', async () => {
  for (const id of ['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1']) {
    const adapter = await resolveSectionAdapter(id);
    assert.equal(adapter.id, id);
    assert.ok(adapter.version);
    assert.ok(adapter.text.length > 0);
  }
  await assert.rejects(() => resolveSectionAdapter('hyperui:marketing/heroes/9'), SectionSelectionRefusedError);
});

test('resolveDesignDirection: all five ship, an unknown id refuses', async () => {
  for (const id of ['editorial-monocle', 'modern-minimal', 'human-approachable', 'tech-utility', 'brutalist-experimental']) {
    const direction = await resolveDesignDirection(id);
    assert.equal(direction.id, id);
  }
  await assert.rejects(() => resolveDesignDirection('cyberpunk-neon'), SectionSelectionRefusedError);
});

// ---------------------------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------------------------

test('resolveAnchorOffset: append lands right after the named section, inside <main>', async () => {
  const pkg = await loadTestEditorial();
  const { html } = pkg.render(pkg.fixture, 'ownededitorial-r1.html');
  const placement: SectionPlacement = { mode: 'append', afterSectionId: 'ownededitorial-hero' };
  const fixtureSectionIds = (pkg.fixture.sections as Array<{ id: string } | null>).map((s) => s?.id ?? null);
  const offset = await resolveAnchorOffset(html, fixtureSectionIds, placement);
  const closeTag = '</section>';
  const heroCloseAt = html.indexOf(closeTag, html.indexOf('id="ownededitorial-hero"')) + closeTag.length;
  assert.equal(offset, heroCloseAt);
  const mainEnd = html.indexOf('</main>');
  assert.ok(offset > html.indexOf('<main'));
  assert.ok(offset < mainEnd, 'the anchor must fall inside <main>, never after it');
});

test('resolveAnchorOffset: append refuses an absent id', async () => {
  const pkg = await loadTestEditorial();
  const { html } = pkg.render(pkg.fixture, 'ownededitorial-r1.html');
  const fixtureSectionIds = (pkg.fixture.sections as Array<{ id: string } | null>).map((s) => s?.id ?? null);
  await assert.rejects(
    () => resolveAnchorOffset(html, fixtureSectionIds, { mode: 'append', afterSectionId: 'ownededitorial-does-not-exist' }),
    SectionSelectionRefusedError,
  );
});

test('resolveAnchorOffset: append refuses an ambiguous id (more than one match)', async () => {
  const html = '<main><section id="dup"></section><section id="dup"></section></main>';
  await assert.rejects(() => resolveAnchorOffset(html, ['dup'], { mode: 'append', afterSectionId: 'dup' }), SectionSelectionRefusedError);
});

test('resolveAnchorOffset: replace-optional lands after the section that precedes the dropped one', async () => {
  const pkg = await loadTestEditorial();
  const { html } = pkg.render(pkg.fixture, 'ownededitorial-r1.html');
  const fixtureSectionIds = (pkg.fixture.sections as Array<{ id: string } | null>).map((s) => s?.id ?? null);
  // ownededitorial's fixture order is navigation, hero, statement, about, footer; `about` is the one
  // optional section (the owned schema's x-optional marker).
  const replaceOffset = await resolveAnchorOffset(html, fixtureSectionIds, { mode: 'replace-optional', targetSectionId: 'ownededitorial-about' });
  const appendOffset = await resolveAnchorOffset(html, fixtureSectionIds, { mode: 'append', afterSectionId: 'ownededitorial-statement' });
  assert.equal(replaceOffset, appendOffset, 'replacing the dropped section lands exactly where appending after its predecessor would');
});

test('resolveAnchorOffset: replace-optional on the family\'s first section lands at the very start of <main>', async () => {
  const html = '<main id="m"><section id="only"></section></main>';
  const offset = await resolveAnchorOffset(html, ['only'], { mode: 'replace-optional', targetSectionId: 'only' });
  assert.equal(offset, html.indexOf('<section'));
});

// FIX 4 (delta audit): the fixture declares `statement` non-null, but THIS run's `dropSections`
// (or a spine that already nulled it) dropped it too, so it renders no trace. The declared
// immediate predecessor of `about` is `statement`; the anchor must fall through to the next
// section that is ACTUALLY present in `html` (`hero`), not throw a misleading "anchor not found:
// statement" for a section that was never going to render this run.
test('resolveAnchorOffset: replace-optional falls through when the declared predecessor was itself dropped at runtime', async () => {
  const html = '<main><section id="nav"></section><section id="hero"></section><section id="footer"></section></main>';
  const fixtureSectionIds = ['nav', 'hero', 'statement', 'about', 'footer'];
  const offset = await resolveAnchorOffset(html, fixtureSectionIds, { mode: 'replace-optional', targetSectionId: 'about' });
  const heroCloseAt = html.indexOf('</section>', html.indexOf('id="hero"')) + '</section>'.length;
  assert.equal(offset, heroCloseAt);
});

test('resolveAnchorOffset: replace-optional falls all the way to the start of <main> when every declared predecessor was dropped at runtime', async () => {
  const html = '<main><section id="footer"></section></main>';
  const fixtureSectionIds = ['nav', 'hero', 'statement', 'about', 'footer'];
  const offset = await resolveAnchorOffset(html, fixtureSectionIds, { mode: 'replace-optional', targetSectionId: 'about' });
  assert.equal(offset, html.indexOf('<section'));
});

test('resolveAnchorOffset: a family with no <main> falls back to <body>', async () => {
  const html = '<html><body><section id="s1">x</section></body></html>';
  const offset = await resolveAnchorOffset(html, ['s1'], { mode: 'append', afterSectionId: 's1' });
  assert.equal(offset, html.indexOf('</section>') + '</section>'.length);
});

// New FIX (delta re-audit, code packet #11): an id literal inside a <script> (or <style>, or an
// HTML comment) must never be mistaken for a real anchor element — the <body> fallback runs the
// anchor search over the whole body, including any inline script a family emits before its first
// section, and that search is a plain regex, not the structural-tag tokenizer.
test('resolveAnchorOffset: an id literal inside a <script> is never treated as a real anchor (refuses, does not anchor inside the script)', async () => {
  const html = '<html><body><script>var markup = \'<div id="ownededitorial-hero">fake</div>\';</script></body></html>';
  await assert.rejects(
    () => resolveAnchorOffset(html, ['ownededitorial-hero'], { mode: 'append', afterSectionId: 'ownededitorial-hero' }),
    SectionSelectionRefusedError,
    'a script-string id must never resolve an anchor',
  );
});

test('resolveAnchorOffset: a real element wins over a same-id literal inside a <script> (masked out, not counted as ambiguous)', async () => {
  const html = '<html><body><script>var markup = \'<div id="ownededitorial-hero">fake</div>\';</script><section id="ownededitorial-hero">real</section></body></html>';
  const offset = await resolveAnchorOffset(html, ['ownededitorial-hero'], { mode: 'append', afterSectionId: 'ownededitorial-hero' });
  const realCloseAt = html.indexOf('</section>') + '</section>'.length;
  assert.equal(offset, realCloseAt, 'must anchor on the real <section>, not throw ambiguous and not anchor inside the script');
});

test('resolveAnchorOffset: an id literal inside an HTML comment is never treated as a real anchor', async () => {
  const html = '<html><body><!-- <div id="ownededitorial-hero">commented out</div> --><section id="real-one"></section></body></html>';
  await assert.rejects(
    () => resolveAnchorOffset(html, ['ownededitorial-hero'], { mode: 'append', afterSectionId: 'ownededitorial-hero' }),
    SectionSelectionRefusedError,
  );
});

test('spliceSectionHtml: inserts at the exact offset without disturbing the rest', () => {
  const html = 'ABCDEF';
  assert.equal(spliceSectionHtml(html, 3, '[X]'), 'ABC[X]DEF');
});

// NEW FIX (delta re-audit, code packet #12): `sectionId` is interpolated unescaped into an HTML
// id/data-* attribute and a CSS attribute selector — guarded independently of the (currently
// always-safe) derivation that produces it.
test('assertSafeSectionId: accepts a bare [a-z0-9-]+ token', () => {
  assert.doesNotThrow(() => assertSafeSectionId('od-selected-hyperui-marketing-ctas-1'));
});

test('assertSafeSectionId: refuses a value that could break out of the attribute/selector', () => {
  for (const unsafe of ['od-selected-"><script>alert(1)</script>', 'has space', 'has]bracket', 'HasUppercase', '']) {
    assert.throws(() => assertSafeSectionId(unsafe), SectionSelectionRefusedError, `expected "${unsafe}" to be refused`);
  }
});

// ---------------------------------------------------------------------------------------------
// Fill + faithfulness verification
// ---------------------------------------------------------------------------------------------

test('fillSectionAdapter: fills every slot with plain text on the first pass, no verify configured', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const model = fakeModel();
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model });
  assert.equal(result.calls, 1);
  assert.equal(typeof result.fill.text?.heading, 'string');
  assert.equal(typeof result.fill.text?.cta, 'string');
  assert.deepEqual(result.flagged, []);
});

test('fillSectionAdapter: a flagged fabrication is repaired within the round budget', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  let attempt = 0;
  const model = fakeModel({
    firstAnswer: (template) => {
      attempt += 1;
      const filled = JSON.parse(JSON.stringify(template)) as { text: Record<string, string> };
      for (const key of Object.keys(filled.text)) filled.text[key] = attempt === 1 ? 'FABRICATED result' : `Honest ${key}`;
      return filled;
    },
  });
  const verify = fakeJevChecker(['FABRICATED']);
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, verify, strict: true });
  assert.ok(verify.calls >= 2, 'expected at least an initial check and one post-repair check');
  assert.equal(result.remaining.length, 0, 'the fabrication must be repaired before this resolves under strict');
  assert.ok(result.flagged.includes('text.heading') || result.flagged.length > 0, 'the first flagged round is recorded');
});

test('fillSectionAdapter: strict refuses the selection when a fabrication survives every repair round', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/sections/1');
  const model = alwaysFabricates();
  const verify = fakeJevChecker(['FABRICATED']);
  await assert.rejects(
    () => fillSectionAdapter({ adapter, brief: BRIEF, model, verify, strict: true, maxFaithfulnessRounds: 1 }),
    SectionSelectionRefusedError,
  );
});

// A round-10 audit pass (storefront-r6-grok.md FIX 4) found a checker that returns `skipped` with
// an EMPTY `flagged` list left `remaining` empty too, so `options.strict && remaining.length > 0`
// never fired and the fill was accepted even though the check never actually completed — the base
// page's own verify loop and `block-compose.ts` both already fail closed on any skip; this one did
// not.
test('fillSectionAdapter: (round 10 FIX 4) strict refuses the selection when the faithfulness check is skipped, even with nothing ever flagged', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const model = fakeModel();
  const verify: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [], ms: 1, calls: 1, skipped: 'network timeout' }; } };
  await assert.rejects(
    () => fillSectionAdapter({ adapter, brief: BRIEF, model, verify, strict: true }),
    SectionSelectionRefusedError,
  );
});

test('fillSectionAdapter: a skipped check is only advisory (never refuses) when the build is not strict', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const model = fakeModel();
  const verify: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [], ms: 1, calls: 1, skipped: 'network timeout' }; } };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, verify, strict: false });
  assert.ok(result.fill, 'a non-strict build must still resolve with a fill, not reject, on a skipped check');
});

/** Always fills the CTA slot with an unstated commercial claim, on every attempt including every
 * faithfulness-repair round — the round-9 exploit shape (storefront-r5-grok.md BLOCK 1/NOTE): a
 * price/shipping/commercial word on a button or body slot that Jev's own probabilistic judgment
 * never flags (the fake Jev checker below carries no marker for it at all), so only a
 * deterministic gate wired into the checker can catch it. */
function alwaysClaimsFreeShipping(): ModelCall & { prompts: string[] } {
  const prompts: string[] = [];
  const call = (async ({ user }) => {
    prompts.push(user);
    const template = promptBlock(user, 'TEMPLATE') as { text: Record<string, string> };
    const answer: { text: Record<string, string> } = { text: {} };
    for (const key of Object.keys(template.text)) answer.text[key] = key === 'cta' ? 'Free shipping' : `Honest ${key}`;
    return { text: JSON.stringify(answer), usage: { input: 10, output: 5, cachedRead: 0 }, ms: 1, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

// ---------------------------------------------------------------------------------------------
// A round-9 audit pass (storefront-r5-grok.md NOTE) found `fillSectionAdapter`'s two callers
// (this file's own caller, `runFastLane`'s section-overlay path, and `block-compose.ts`'s
// composed page) always pass the RAW `FaithfulnessChecker` straight through, so a section fill's
// invented commercial claim was checked by Jev's own judgment alone — never by the deterministic
// claim/commercial-word gates the base page's own fill gets. `withAdapterDeterministicGates`
// (`run.ts`) is the fix, wired at both call sites; these two tests prove the gap AND the fix using
// the exact same fill, model and Jev stub — only the checker passed to `fillSectionAdapter`
// differs.
// ---------------------------------------------------------------------------------------------

test('fillSectionAdapter: (round 9 wiring) a raw, unwrapped checker never catches an unstated "Free shipping" claim on the CTA', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const model = alwaysClaimsFreeShipping();
  const verify = fakeJevChecker(['FABRICATED']); // no marker for "Free shipping": Jev itself never flags it
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, verify, strict: true });
  assert.equal(result.remaining.length, 0, 'the raw checker alone lets the unstated shipping claim through clean — the gap this round closes');
  assert.equal(result.fill.text?.cta, 'Free shipping');
});

test('fillSectionAdapter: (round 9 wiring) wrapping the SAME checker with withAdapterDeterministicGates catches the same claim and fails the selection closed', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const model = alwaysClaimsFreeShipping();
  const rawVerify = fakeJevChecker(['FABRICATED']);
  const gatedVerify = withAdapterDeterministicGates(rawVerify, 'storefront');
  await assert.rejects(
    () => fillSectionAdapter({ adapter, brief: BRIEF, model, verify: gatedVerify, strict: true, maxFaithfulnessRounds: 1 }),
    SectionSelectionRefusedError,
    'a wrapped checker must fail the strict selection closed on the same unstated "Free shipping" claim',
  );
});

test('fillSectionAdapter: designReference reaches the model prompt but never the faithfulness check', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const marker = 'ZZ-DESIGN-REFERENCE-MARKER-ZZ';
  const model = fakeModel();
  const seenByVerify: string[] = [];
  const verify = { async checkFaithfulness({ brief, slots }: { brief: string; slots: { path: string; text: string }[] }) {
    seenByVerify.push(brief, ...slots.map((s) => s.text));
    return { flagged: [], ms: 1, calls: 1 };
  } };
  await fillSectionAdapter({ adapter, brief: BRIEF, designReference: `Layout cue: ${marker}`, model, verify });
  assert.ok(model.prompts.some((prompt) => prompt.includes(marker)), 'the model prompt must carry the design guidance');
  assert.ok(!seenByVerify.some((text) => text.includes(marker)), 'the faithfulness check must never see the design guidance');
});

// ---------------------------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------------------------

test('artifactDigest: deterministic, and changes with any of its four inputs', () => {
  const selection = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'x' } as const, directionId: 'modern-minimal' };
  const a = artifactDigest('base', selection, '1.0.0');
  const b = artifactDigest('base', selection, '1.0.0');
  assert.equal(a, b);
  assert.notEqual(artifactDigest('different-base', selection, '1.0.0'), a);
  assert.notEqual(artifactDigest('base', { ...selection, directionId: 'tech-utility' }, '1.0.0'), a);
  assert.notEqual(artifactDigest('base', selection, '1.0.1'), a);
  assert.notEqual(artifactDigest('base', { ...selection, entryId: 'hyperui:marketing/sections/1' }, '1.0.0'), a);
});

// ---------------------------------------------------------------------------------------------
// FamilyPackage wrapper: full composition against a real family
// ---------------------------------------------------------------------------------------------

test('wrapFamilyPackageForOverlay: composes the section into ownededitorial without ever changing what the family validator sees', async () => {
  const pkg = await loadTestEditorial();
  let sawInput: unknown;
  const spyPkg = { ...pkg, render: (input: Parameters<typeof pkg.render>[0], entry: string) => { sawInput = input; return pkg.render(input, entry); } };
  const selection = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' } as const, directionId: 'modern-minimal' };
  const adapter = await resolveSectionAdapter(selection.entryId);
  const direction = await resolveDesignDirection(selection.directionId);
  const fill = { text: { heading: 'Talk to TestEditorial', body: 'Tell us about your next launch.', cta: 'Book a call' } };
  const wrapped = await wrapFamilyPackageForOverlay(spyPkg, selection, direction, adapter, fill);
  const result = wrapped.render(pkg.fixture, 'ownededitorial-r1.html');

  assert.equal(sawInput, pkg.fixture, 'the wrapper must hand the family validator the exact, unmodified recipe object');
  assert.ok(result.html.includes('Talk to TestEditorial'));
  assert.ok(result.html.includes('data-od-selected-section="hyperui:marketing/ctas/1"'));
  assert.ok(result.html.includes('data-od-selected-direction="modern-minimal"'));
  assert.ok(result.html.includes('--role-accent'), 'the direction\'s role tokens must be bound in the inserted section\'s own scope');
  assert.ok(result.html.indexOf('Talk to TestEditorial') > result.html.indexOf('id="ownededitorial-hero"'), 'inserted after the anchor');
  assert.ok(result.html.indexOf('Talk to TestEditorial') < result.html.indexOf('</main>'), 'inserted inside <main>');

  const baseline = pkg.render(pkg.fixture, 'ownededitorial-r1.html');
  assert.notEqual(result.manifest.metadata.agencySite.recipeDigest, baseline.manifest.metadata.agencySite.recipeDigest, 'the composed digest must differ from the unselected base digest');
  const overlayMeta = (result.manifest.metadata.agencySite as unknown as { sectionOverlay: { entryId: string; directionId: string } }).sectionOverlay;
  assert.equal(overlayMeta.entryId, 'hyperui:marketing/ctas/1');
  assert.equal(overlayMeta.directionId, 'modern-minimal');
});

test('wrapFamilyPackageForOverlay: compose is idempotent per section id — a repeated compose never splices twice', async () => {
  const pkg = await loadTestEditorial();
  // A package that honours `compose` twice and never reports `composed`: the wrapper's own
  // fallback splice then runs a third time on the same page.
  const eager = {
    ...pkg,
    render: (input: Parameters<typeof pkg.render>[0], entry: string, options?: Parameters<typeof pkg.render>[2]) => {
      const base = pkg.render(input, entry);
      const html = options?.compose ? options.compose(options.compose(base.html)) : base.html;
      return { ...base, html };
    },
  };
  const selection = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' } as const, directionId: 'modern-minimal' };
  const adapter = await resolveSectionAdapter(selection.entryId);
  const direction = await resolveDesignDirection(selection.directionId);
  const wrapped = await wrapFamilyPackageForOverlay(eager, selection, direction, adapter, { text: { heading: 'Talk to TestEditorial', body: 'Tell us more.', cta: 'Book a call' } });
  const count = (html: string) => html.split('data-od-selected-section="hyperui:marketing/ctas/1"').length - 1;
  const first = wrapped.render(pkg.fixture, 'ownededitorial-r1.html');
  const second = wrapped.render(pkg.fixture, 'ownededitorial-r1.html');
  assert.equal(count(first.html), 1, 'one spliced section');
  assert.equal(count(second.html), 1, 'one spliced section on a second render through the same package');
  assert.equal(second.html, first.html);
});

test('wrapFamilyPackageForOverlay: rejects when the anchor is absent, before any composition happens', async () => {
  const pkg = await loadTestEditorial();
  const selection = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-nowhere' } as const, directionId: 'modern-minimal' };
  const adapter = await resolveSectionAdapter(selection.entryId);
  const direction = await resolveDesignDirection(selection.directionId);
  const wrapped = await wrapFamilyPackageForOverlay(pkg, selection, direction, adapter, { text: { heading: 'x', body: 'y', cta: 'z' } });
  assert.throws(() => wrapped.render(pkg.fixture, 'ownededitorial-r1.html'), SectionSelectionRefusedError);
});

// FIX 5 (delta audit): `wrapFamilyPackageForOverlay` must compute the digest from the ADAPTER
// OBJECT IT WAS GIVEN, never by re-resolving `selection.entryId` itself — otherwise a caller that
// filled against one adapter version could publish a digest covering a different one.
test('wrapFamilyPackageForOverlay: the digest, manifest AND rendered HTML all reflect the exact adapter object passed in, never a re-resolved one', async () => {
  const pkg = await loadTestEditorial();
  const selection = { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' } as const, directionId: 'modern-minimal' };
  const realAdapter = await resolveSectionAdapter(selection.entryId);
  const direction = await resolveDesignDirection(selection.directionId);
  const RENDER_MARKER = 'PASSED-ADAPTER-RENDER-MARKER-7f2c';
  // A distinct version AND a distinct `render` output, as if the caller's own resolution (e.g. a
  // future non-static catalog) returned a different object than a second, independent
  // `resolveSectionAdapter` call would — proving this function never performs that second call,
  // for RENDERING or for the digest/manifest (delta re-audit, tests packet #10: the prior version
  // of this test asserted only the digest/manifest, which would still pass if rendering silently
  // re-resolved).
  const passedAdapter = { ...realAdapter, version: '9.9.9-test-only', render: () => `<p>${RENDER_MARKER}</p>` };
  const fill = { text: { heading: 'Talk to TestEditorial', body: 'Tell us about your next launch.', cta: 'Book a call' } };
  const wrapped = await wrapFamilyPackageForOverlay(pkg, selection, direction, passedAdapter, fill);
  const result = wrapped.render(pkg.fixture, 'ownededitorial-r1.html');

  assert.ok(result.html.includes(RENDER_MARKER), 'the rendered section must reflect the passed adapter\'s own render output, not a re-resolved one');
  assert.equal(result.html.includes('Talk to TestEditorial'), false, 'the real (re-resolved) adapter\'s render must never appear');

  const baseDigest = pkg.render(pkg.fixture, 'ownededitorial-r1.html').manifest.metadata.agencySite.recipeDigest;
  const expectedDigest = artifactDigest(baseDigest, selection, passedAdapter.version);
  assert.equal(result.manifest.metadata.agencySite.recipeDigest, expectedDigest);
  const overlayMeta = (result.manifest.metadata.agencySite as unknown as { sectionOverlay: { adapterVersion: string } }).sectionOverlay;
  assert.equal(overlayMeta.adapterVersion, '9.9.9-test-only');
});
