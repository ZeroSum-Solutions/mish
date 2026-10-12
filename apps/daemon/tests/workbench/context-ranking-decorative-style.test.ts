import { expect, it } from 'vitest';
import type { ResourceCandidate } from '@mish/contracts';
import { rankContextualResources, selectLexicalResources, queryRequestsRetroStyle, queryRequestsContinuousMotionDecoration, isContinuousMotionDecoration, hasRankableProjectContext, CONTINUOUS_MOTION_STYLE_TAG } from '../../src/workbench/context-ranking.js';
import { candidate, savedContext, booking } from './context-ranking-fixture.js';
const ids = (items: readonly ResourceCandidate[]) => items.map(item => item.ref.itemId);

// AC-R05 preamble: "ordinary clinical/transactional requests suppress continuous GPU
// decorations by default" and "[retro] excludes it unless the project/user explicitly
// requests retro" (prd.md line 225, same convention reused via styleClass).
it('suppresses continuous-GPU decorative and retro-styleClass candidates from an ordinary clinical/transactional query', () => {
  const saved = savedContext({ spineCode: 'SM', conversions: [booking] });
  const decorative = candidate('ambient-glow', { spineAffinities: ['SM'], styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  const retroKit = candidate('react95-window', { sectionKind: 'booking-availability', styleClass: 'retro' });
  const ordinary = candidate('calendar', { sectionKind: 'booking-availability' });
  const items = [decorative, retroKit, ordinary];
  const ranked = rankContextualResources(items, 'Build a calm premium dentistry landing page where patients book their first appointment', saved);
  expect(ranked.rankable).toBe(true);
  expect(ids(ranked.items)).toEqual(['calendar']);
  expect(selectLexicalResources(items, 'dentistry appointment booking').items).toEqual([]);
});
it('keeps the exact literal-matched candidate even when it is retro or decorative, in ranked mode', () => {
  // rankContextualResources' literal-match path is unaffected by this fix: an exact
  // literal match (the user named the effect/kit) still bypasses the style-intent
  // gate there, per the AC-R05 preamble's own "or" (literal match OR explicit intent).
  const decorative = candidate('starfield-particles', { title: 'Ambient starfield particles', styleTags: [CONTINUOUS_MOTION_STYLE_TAG, 'particles'] });
  const retroKit = candidate('react95-kit', { title: 'React95 window chrome', styleClass: 'retro' });
  const items = [decorative, retroKit];
  const saved = savedContext({ spineCode: 'SM' });
  expect(ids(rankContextualResources(items, 'starfield particles', saved).items)).toEqual(['starfield-particles']);
});
// BLOCK finding: selectLexicalResources (the function actually used whenever the "Use
// project context" toggle is off, no project is saved, context is absent/not-rankable,
// or ranking times out — AC-R05.1's own enumerated fallback states) never applied the
// requiresExplicitStyleIntent/queryRequestsRetroStyle gate at all, so a literal-only
// match (including a trivial generic-word or empty-query match) always surfaced
// continuous-GPU-motion and retro-styleClass candidates in every one of those modes.
it('requires explicit style intent inside selectLexicalResources too, not only inside rankContextualResources', () => {
  const decorative = candidate('decorative-kit', { title: 'Retro glow kit', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  const retroKit = candidate('retro-kit', { title: 'Retro widget kit', styleClass: 'retro' });
  const ordinaryKit = candidate('ordinary-kit', { title: 'Plain toolbox kit' });
  const items = [decorative, retroKit, ordinaryKit];
  // A short, generic query whose only shared word ("kit") appears in every title must
  // not count as the "exact literal match" that names the retro/decorative effect.
  expect(ids(selectLexicalResources(items, 'kit').items)).toEqual(['ordinary-kit']);
  // An empty query must not trivially "match" (and thus surface) every candidate either.
  expect(ids(selectLexicalResources(items, '').items)).toEqual(['ordinary-kit']);
  // Explicit retro wording in the query both names the retro/decorative items (so they
  // literal-match) and grants the explicit intent the gate requires; the plain kit, which
  // has no "retro" in its title, no longer literal-matches this query at all.
  expect(new Set(ids(selectLexicalResources(items, 'retro kit').items))).toEqual(new Set(['decorative-kit', 'retro-kit']));
});
// BLOCK fix (was: "selectLexicalResources(items,'react95 window') returns [] for the
// react95 kit" — this test used to assert exactly that empty result, i.e. it encoded
// the bug, not the fix its own title described. selectLexicalResources now lets a
// strong title/item-ID match bypass the gate exactly as rankContextualResources'
// unconditional `literal` already does (see the test above), so these two precise,
// item-naming queries now surface their own item through the cheap lexical fallback
// too — matching the "or exact literal match" half of the AC-R05 preamble in both
// modes instead of only in ranked mode.
it('still keeps a genuinely exact literal match through selectLexicalResources when it specifically names the retro/decorative item', () => {
  const decorative = candidate('starfield-particles', { title: 'Ambient starfield particles', styleTags: [CONTINUOUS_MOTION_STYLE_TAG, 'particles'] });
  const retroKit = candidate('react95-kit', { title: 'React95 window chrome', styleClass: 'retro' });
  const items = [decorative, retroKit];
  // Each query names only its own item by title, so only that item passes the first
  // (literalResourceMatch) filter at all; the fixed gate then lets it through.
  expect(ids(selectLexicalResources(items, 'starfield particles').items)).toEqual(['starfield-particles']);
  expect(ids(selectLexicalResources(items, 'react95 window').items)).toEqual(['react95-kit']);
});
// WARN finding: queryNamesItemByTitleOrId used to require only that every query token
// appear SOMEWHERE in the concatenated `${title} ${itemId}` string, so a two-generic-word
// query could bypass decorative/retro suppression by matching one word in the title and
// an unrelated word in a different item's item-ID — without the query actually naming
// that item as a contiguous phrase. The fix requires a contiguous normalized-phrase match
// against the title OR the item-ID (checked separately), or an exact item-ID match.
it('does not let a two-generic-word query bypass decorative suppression via a scattered title/item-ID match', () => {
  // "neon" only appears in the title; "kit" only appears in the item-ID. Neither field
  // contains the query as a contiguous phrase, so this must not count as naming the item.
  const decorative = candidate('dashboard-widget-kit', { title: 'Neon Dashboard', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorative], 'neon kit').items)).toEqual([]);
});
// WARN fix: a plain substring check on the space-joined normalized phrase let a
// query match INSIDE a longer word it happened to be a prefix/suffix of — "neon kit"
// is a substring of "neon kitten" (itself inside "antineon kitten"), even though
// neither "antineon" nor "kitten" is the word "neon"/"kit". The fix requires a
// contiguous run of WHOLE normalized words, not a raw substring.
it('does not let "neon kit" match inside "antineon kitten" (word boundaries, not substrings)', () => {
  const decorativeByTitle = candidate('dashboard-widget', { title: 'Antineon Kitten', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorativeByTitle], 'neon kit').items)).toEqual([]);
  const decorativeById = candidate('antineon-kitten', { title: 'Ambient Glow', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorativeById], 'neon kit').items)).toEqual([]);
});
// Single-token exact item-ID equality must still name the item even though the
// two-token floor otherwise applies to the phrase-match branch.
it('a single-token query still names the item via an exact item-ID match', () => {
  const decorative = candidate('neon-kit', { title: 'Ambient Glow', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorative], 'neon-kit').items)).toEqual(['neon-kit']);
  // A single generic word is still not enough on its own to name the item.
  expect(ids(selectLexicalResources([decorative], 'neon').items)).toEqual([]);
});
it('still lets a genuine contiguous phrase in the title or the item-ID name the item', () => {
  const decorativeByTitle = candidate('neon-kit-02', { title: 'Neon Kit Deluxe', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorativeByTitle], 'neon kit').items)).toEqual(['neon-kit-02']);
  // A phrase match against the item-ID alone (punctuation-insensitive) also counts,
  // even when the title shares none of the query's words.
  const decorativeById = candidate('neon-kit-deluxe', { title: 'Ambient Glow', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([decorativeById], 'neon kit').items)).toEqual(['neon-kit-deluxe']);
  // Reordering the query's words no longer names the item as a contiguous phrase.
  const reordered = candidate('kit-neon-02', { title: 'Kit Neon Deluxe', styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  expect(ids(selectLexicalResources([reordered], 'neon kit').items)).toEqual([]);
});
it('surfaces continuous-GPU decoration and retro candidates by spine/section when the query explicitly requests retro style', () => {
  const saved = savedContext({ spineCode: 'SM', conversions: [booking] });
  const decorative = candidate('ambient-glow', { spineAffinities: ['SM'], styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  const retroKit = candidate('react95-window', { sectionKind: 'booking-availability', styleClass: 'retro' });
  const ordinary = candidate('calendar', { sectionKind: 'booking-availability' });
  const items = [decorative, retroKit, ordinary];
  const ranked = rankContextualResources(items, 'Give this retro Windows95 arcade landing page a booking flow', saved);
  expect(new Set(ids(ranked.items))).toEqual(new Set(['ambient-glow', 'react95-window', 'calendar']));
  const decorativeResult = ranked.items.find(item => item.ref.itemId === 'ambient-glow')!;
  expect(decorativeResult.fitReasons.join(' ').toLowerCase()).toContain('retro');
});
it('treats an explicit project motion "allowed" constraint as equally explicit permission for continuous-motion decorations, per AC-R05.2 explicit-outranks-inferred', () => {
  const saved = savedContext({ spineCode: 'SM', constraints: [{ id: 'allowed', kind: 'motion', value: 'allowed' }] });
  const decorative = candidate('ambient-glow', { spineAffinities: ['SM'], styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  const ranked = rankContextualResources([decorative], 'Build a calm clinical intake form', saved);
  expect(ids(ranked.items)).toEqual(['ambient-glow']);
});
// BLOCK finding: a motion:'allowed' constraint is a statement only about animation
// tolerance; it must not also unlock retro/skeuomorphic *styling*, which is a separate
// claim. Reproduces the finding's exact evidence: an ordinary, non-retro dental-intake
// query with a saved motion:'allowed' constraint must not surface a retro-styleClass
// candidate by spine/section match alone.
it('does not let a project motion "allowed" constraint unlock retro-styleClass candidates', () => {
  const saved = savedContext({ spineCode: 'SM', constraints: [{ id: 'allowed', kind: 'motion', value: 'allowed' }], conversions: [booking] });
  const retroKit = candidate('react95-window', { sectionKind: 'booking-availability', styleClass: 'retro' });
  const ranked = rankContextualResources([retroKit], 'Build a calm clinical intake form for a dental office', saved);
  expect(ids(ranked.items)).toEqual([]);
  expect(queryRequestsContinuousMotionDecoration('Build a calm clinical intake form for a dental office', saved)).toBe(true);
  expect(queryRequestsRetroStyle('Build a calm clinical intake form for a dental office', saved)).toBe(false);
});
// BLOCK finding: excludedByMotion never treated the new continuous-motion styleTags
// convention as motion-category-equivalent, so a saved reduced-motion/no-animation
// constraint failed to exclude a continuous-motion-tagged candidate whenever the query
// also carried explicit retro/decorative intent (a realistic combination: a
// vestibular-sensitive user who wants a retro look with no animation).
it('excludes a continuous-motion-tagged candidate under a motion:none constraint even when explicit retro/decorative intent would otherwise admit it', () => {
  const saved = savedContext({ spineCode: 'SM', constraints: [{ id: 'none', kind: 'motion', value: 'none' }] });
  const decorative = candidate('looping-arcade-glow', { title: 'Looping retro arcade glow', spineAffinities: ['SM'], styleTags: [CONTINUOUS_MOTION_STYLE_TAG] });
  const ranked = rankContextualResources([decorative], 'Give this retro arcade site a Windows95 look', saved);
  expect(ids(ranked.items)).toEqual([]);
  expect(ranked.excluded).toEqual([{ reason: 'motion-constraint', constraintId: 'none', count: 1 }]);
  // Same exclusion holds through the cheap lexical fallback, via a query that
  // literal-matches the item (and still carries explicit retro intent).
  expect(ids(selectLexicalResources([decorative], 'looping retro arcade glow', saved).items)).toEqual([]);
});
// WARN finding: a saved project whose only declared constraint is motion:'allowed'
// (no spineCode, no mapped conversion) is "not rankable" for spine/conversion scoring,
// so rankContextualResources took its cheap-fallback branch at context-ranking.ts ~173
// — but that branch used to call selectLexicalResources(items, query) with NO context
// argument at all, silently discarding the saved motion:'allowed' permission in the one
// mode that would otherwise have reached it (the timed-out `fallback` a few lines later
// already forwarded context correctly; only this early return did not).
it('forwards project context through the unrankable lexical fallback, so a motion "allowed" constraint with no spine or conversion still grants its continuous-motion permission there', () => {
  const saved = savedContext({ constraints: [{ id: 'allowed', kind: 'motion', value: 'allowed' }] });
  expect(hasRankableProjectContext(saved)).toBe(false); // confirms this exercises the ~173 fallback branch, not full ranking
  // Matches only via sourceAttribution.title, not via title/item-ID, so this is isolated
  // from the strong-title/item-ID bypass above: the only thing that can explain this
  // continuous-motion item surviving the gate here is the saved motion:'allowed' context.
  const decorative = candidate('ambient-glow', { styleTags: [CONTINUOUS_MOTION_STYLE_TAG], sourceAttribution: { title: 'Loop Collection' } });
  const ranked = rankContextualResources([decorative], 'loop collection', saved);
  expect(ranked.rankable).toBe(false);
  expect(ids(ranked.items)).toEqual(['ambient-glow']);
});
it('exposes the retro-intent and continuous-motion helpers as pure, context-aware predicates', () => {
  expect(queryRequestsRetroStyle('a retro arcade site', savedContext())).toBe(true);
  expect(queryRequestsRetroStyle('a windows95 control panel', savedContext())).toBe(true);
  expect(queryRequestsRetroStyle('a calm clinical intake form', savedContext())).toBe(false);
  expect(queryRequestsRetroStyle('a calm clinical intake form', savedContext({ styleDirection: 'vaporwave synthwave' }))).toBe(true);
  // WARN finding: simple negation ("no retro", "not retro", "without retro") must not
  // count as a request for the style being ruled out.
  expect(queryRequestsRetroStyle('Please no retro styling, keep it clean and modern', savedContext())).toBe(false);
  expect(queryRequestsRetroStyle('Not a retro look please', savedContext())).toBe(false);
  expect(queryRequestsRetroStyle('without retro vibes', savedContext())).toBe(false);
  expect(queryRequestsRetroStyle('a retro arcade site', savedContext())).toBe(true); // unnegated retro wording elsewhere still counts
  // A motion:'allowed' constraint is continuous-motion intent, never retro intent.
  const motionAllowed = savedContext({ constraints: [{ id: 'allowed', kind: 'motion', value: 'allowed' }] });
  expect(queryRequestsRetroStyle('a calm clinical intake form', motionAllowed)).toBe(false);
  expect(queryRequestsContinuousMotionDecoration('a calm clinical intake form', motionAllowed)).toBe(true);
  expect(queryRequestsContinuousMotionDecoration('a calm clinical intake form', savedContext())).toBe(false);
  expect(isContinuousMotionDecoration(candidate('x', { styleTags: [CONTINUOUS_MOTION_STYLE_TAG] }))).toBe(true);
  expect(isContinuousMotionDecoration(candidate('x', { styleTags: ['layout'] }))).toBe(false);
});
