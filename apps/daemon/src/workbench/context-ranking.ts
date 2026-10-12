import type { ResourceCandidate, ResourceRef, ProjectDesignContext, ResourceSearchResponse } from '@mish/contracts';
import { fontRequirementFit, fontRequirementsFromContext } from '../fonts/requirements.js';

// NOT bumped, despite selection semantics changing here (selectLexicalResources now lets
// a strong title/item-ID match bypass the decorative/retro style-intent gate, and the
// unrankable fallback in rankContextualResources now forwards project context instead of
// discarding it): packages/contracts/src/api/workbench-context.ts pins
// `rankingVersion: z.literal('local-context/1')`, so any other string here makes every
// parseResourceSearchResponse call in resources.ts throw a ZodError — bumping this alone
// breaks search entirely rather than just invalidating stale cursors. Changing the literal
// is a packages/contracts edit outside this fix's allotted files; see the fixer report.
export const CONTEXT_RANKING_VERSION = 'local-context/1' as const;
export interface ContextualRankingResult {
  items: ResourceCandidate[];
  excluded: NonNullable<ResourceSearchResponse['excluded']>;
  rankable: boolean;
  timedOut: boolean;
}
const titleCollator = new Intl.Collator('en', { sensitivity: 'variant' });
const spines = new Set(['TL','PA','CO','SM','CS','LM','BA','TU','MI']);
const conversionSections: Record<ProjectDesignContext['conversions'][number]['kind'], readonly string[]> = {
  signup: ['newsletter-waitlist','cta-band'], subscribe: ['newsletter-waitlist','cta-band'],
  call: ['contact-form','cta-band','location-map-hours'], contact: ['contact-form','cta-band','location-map-hours'],
  booking: ['booking-availability','cta-band'], purchase: ['product-grid','pricing','cta-band'], download: ['cta-band'], other: [],
};
export function resourceRefKey(ref: ResourceRef): string {
  return Buffer.from(JSON.stringify([1,ref.sourceType,ref.sourceId,ref.itemId,ref.revisionOrDigest])).toString('base64url');
}
export function compareResourceTitles(a: ResourceCandidate, b: ResourceCandidate): number {
  return titleCollator.compare(a.title, b.title) || Buffer.compare(Buffer.from(resourceRefKey(a.ref)), Buffer.from(resourceRefKey(b.ref)));
}
export function resourceOrderingEnvironment(): unknown {
  return { icu: process.versions.icu ?? null, collator: titleCollator.resolvedOptions() };
}
export function literalResourceMatch(item: ResourceCandidate, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const searchable = `${item.title} ${item.category} ${item.ref.itemId} ${item.sourceAttribution.title} ${(item.styleTags ?? []).join(' ')}`.toLowerCase();
  return tokens.every(token => searchable.includes(token));
}
function motionConstraint(context?: ProjectDesignContext) {
  return context?.constraints.find(constraint => constraint.kind === 'motion' && constraint.value !== 'allowed');
}
/** Candidates whose decorative effect runs continuously under GPU-accelerated
 * compositing (ambient parallax, particle fields, animated gradients, canvas loops),
 * as opposed to a one-shot entrance transition. Marked via this styleTags convention;
 * no schema change is needed since styleTags is already free-form. */
export const CONTINUOUS_MOTION_STYLE_TAG = 'continuous-motion';
/** AC-R11 preamble: set by the fonts source on a metadata-only family that only a pinned
 * discovery listing (Google Fonts, Fontshare) knows — no curated fit, no admitted bytes.
 * Such a family answers a query that names it (name, script, weight, axis) but never an
 * empty query, so thousands of listed families cannot crowd the default results. */
export const DISCOVERY_LISTING_STYLE_TAG = 'discovery-listing';
function waitsForQuery(item: ResourceCandidate, query: string): boolean {
  return !query.trim() && !!item.styleTags?.includes(DISCOVERY_LISTING_STYLE_TAG);
}
/** AC-R05.2: set only by the project-owned token adapters (resources-tokens.ts) on a
 * palette whose text/surface pairs passed WCAG contrast. Same styleTags convention as
 * CONTINUOUS_MOTION_STYLE_TAG; eligibility also checks the source, so a third-party
 * tag of the same spelling never qualifies. */
export const CONTRAST_EVIDENCE_STYLE_TAG = 'contrast-evidence-passed';
/** Sources whose items are the current project's own tokens or suggestions newly derived
 * from its saved brief (AC-R05.2 "validated project-owned derived suggestions"). */
const PROJECT_OWNED_TOKEN_SOURCES: ReadonlySet<ResourceRef['sourceId']> = new Set(['brief-derived-tokens', 'project-tokens']);
/** AC-R05.2 eligibility for the "one colour and one sizing resource" criterion.
 * Only a project-owned token resource qualifies; a reference-only, unavailable,
 * needs-repair or rights-restricted item never does, and a palette qualifies only with
 * passed contrast evidence. A DESIGN.md swatch or a bundled design-system palette is
 * therefore never eligible, whatever its tags say. Eligibility is not readiness: the
 * item stays `unverified` until a per-item acceptance receipt exists. */
export function eligibleTokenKind(item: ResourceCandidate): 'color' | 'sizing' | null {
  if (!PROJECT_OWNED_TOKEN_SOURCES.has(item.ref.sourceId)) return null;
  if (item.readiness === 'reference-only' || item.readiness === 'unavailable' || item.readiness === 'needs-repair') return null;
  if (item.admissionStage === 'reference-only' || item.rightsStatus === 'restricted') return null;
  if (item.category === 'color-palette') return (item.styleTags ?? []).includes(CONTRAST_EVIDENCE_STYLE_TAG) ? 'color' : null;
  if (item.category === 'type-scale' || item.category === 'spacing-scale') return 'sizing';
  return null;
}
export function isContinuousMotionDecoration(item: ResourceCandidate): boolean {
  return (item.styleTags ?? []).some(tag => tag.toLowerCase() === CONTINUOUS_MOTION_STYLE_TAG);
}
/** `styleClass: 'retro'` is the existing documented convention (technical-spec.md's
 * SourceAdmission.styleClass, and prd.md's R17: "ordinary premium-modern searches
 * exclude it unless the project/user explicitly requests retro"). Reused as-is. */
function isRetroStyleClass(item: ResourceCandidate): boolean {
  return item.styleClass?.toLowerCase() === 'retro';
}
const retroStylePattern = /\b(retro|arcade|vhs|y2k|vaporwave|synthwave|windows ?95|win95|react ?95|8-?bit|pixel-art|neon-retro)\b/iu;
/** A retro/decorative word immediately preceded by a negation ("no retro", "not
 * retro", "without retro", …) is the user ruling the style OUT, not requesting it. */
const retroStyleNegationPattern = /\b(no|not|without)\s+(?:a|an|any|the)?\s*(?:retro|arcade|vhs|y2k|vaporwave|synthwave|windows ?95|win95|react ?95|8-?bit|pixel-art|neon-retro)\b/iu;
function textRequestsRetroStyle(text: string): boolean {
  if (!text) return false;
  if (retroStyleNegationPattern.test(text)) return false;
  return retroStylePattern.test(text);
}
/** Explicit retro-styleClass intent: query text or the project's saved style
 * direction wording only. A project motion constraint is a statement about
 * animation tolerance, not about static retro/skeuomorphic styling, so it must
 * not unlock retro styling (AC-R05.2 fix) — see queryRequestsContinuousMotionDecoration
 * for the separate signal that does honor it. */
export function queryRequestsRetroStyle(query: string, context?: ProjectDesignContext): boolean {
  return textRequestsRetroStyle(query) || textRequestsRetroStyle(context?.styleDirection ?? '');
}
function motionAllowedConstraint(context?: ProjectDesignContext): boolean {
  return !!context?.constraints.some(constraint => constraint.kind === 'motion' && constraint.value === 'allowed');
}
/** Explicit continuous-motion-decoration intent: the same retro/decorative wording
 * signal as queryRequestsRetroStyle, OR a saved project constraint that explicitly
 * allows motion. Per AC-R05.2, an explicit project constraint outranks inferred
 * style, and "allowed" is the project explicitly opting back into motion the
 * default would otherwise hold back — for motion specifically, never for retro
 * styling, which is a separate claim about static visual style. */
export function queryRequestsContinuousMotionDecoration(query: string, context?: ProjectDesignContext): boolean {
  return queryRequestsRetroStyle(query, context) || motionAllowedConstraint(context);
}
/** AC-R05 preamble: "ordinary clinical/transactional requests suppress continuous GPU
 * decorations by default" (and prd.md R17's identical rule for the retro kit). Absent
 * explicit retro/decorative intent, these candidates only qualify through an exact
 * literal match; spine/section affinity alone cannot surface them. */
function requiresExplicitStyleIntent(item: ResourceCandidate): boolean {
  return isRetroStyleClass(item) || isContinuousMotionDecoration(item);
}
/** Per-item explicit-style-intent check: a retro-styleClass candidate gates on retro
 * wording only; a continuous-motion-decoration candidate additionally honors an
 * explicit motion "allowed" project constraint. An item that requires no style
 * intent is always eligible (the gate is a no-op for it). */
function hasExplicitStyleIntent(item: ResourceCandidate, query: string, context?: ProjectDesignContext): boolean {
  if (isRetroStyleClass(item)) return queryRequestsRetroStyle(query, context);
  if (isContinuousMotionDecoration(item)) return queryRequestsContinuousMotionDecoration(query, context);
  return true;
}
export function hasRankableProjectContext(context: ProjectDesignContext): boolean {
  return !!(context.spineCode && spines.has(context.spineCode)) || context.conversions.some(conversion => conversionSections[conversion.kind].length > 0) || !!motionConstraint(context)
    // AC-R11.3: an explicit saved script, legibility or italic constraint reranks fonts. Brand
    // tone alone is prose and never makes a context rankable.
    || fontRequirementsFromContext(context).requirements.some(requirement => requirement.strength === 'required');
}
function excludedByMotion(item: ResourceCandidate, constraint: ReturnType<typeof motionConstraint>): boolean {
  if (!constraint) return false;
  // A continuous-GPU-motion decoration is motion-category-equivalent: a saved
  // 'none'/'reduced' constraint excludes it the same way an explicit animation
  // category or motionMetadata.state would, even when the explicit-style-intent
  // gate elsewhere would otherwise have let it through (AC-R05.2).
  if (isContinuousMotionDecoration(item)) return true;
  return constraint.value === 'none'
    ? item.category === 'motion' || item.motionMetadata?.state === 'animated' || item.motionMetadata?.state === 'reduced-compatible'
    : item.motionMetadata?.state === 'animated';
}
function annotateMotion(item: ResourceCandidate, constraint: ReturnType<typeof motionConstraint>): ResourceCandidate {
  if (!constraint) return item;
  const metadata = item.motionMetadata;
  const reason = !metadata || metadata.state === 'unknown'
    ? `Motion metadata is unknown; compatibility with saved ${constraint.value} constraint ${constraint.id} is unverified`
    : `motionMetadata ${metadata.state} (${metadata.basis}, ${metadata.field}) is advisory; rendered motion behavior remains unverified`;
  return { ...item, fitReasons: [...new Set([...item.fitReasons, reason])] };
}
function exclusions(constraint: ReturnType<typeof motionConstraint>, count: number): ContextualRankingResult['excluded'] {
  return constraint && count ? [{ reason: 'motion-constraint', constraintId: constraint.id, count }] : [];
}
function uniqueItems(items: readonly ResourceCandidate[]): ResourceCandidate[] {
  return [...new Map(items.map(item => [resourceRefKey(item.ref), item])).values()];
}
// --- AC-R05.3 relevance-benchmark harness --------------------------------------
// A frozen, human-rated ten-query/five-spine pool and its pass/fail gate remain
// open (two independent raters must label a query's eligible result pool before
// any benchmark run can close that criterion). This harness is the reusable
// counting/grouping math the eventual human-labeled run will execute; it accepts
// any labels, including the unverified placeholder shipped in
// tests/fixtures/workbench/relevance/labels.json.
export interface RelevanceBenchmarkLabel { acceptable: readonly string[] }
export interface RelevanceBenchmarkSummary {
  queryId: string; mode: 'global' | 'contextual';
  /** itemIds actually counted, after collapsing variant-group siblings into one slot. */
  topFive: readonly string[];
  acceptableInTopFive: number;
}
/** A variantGroup's siblings are one logical candidate; one should not occupy two of
 * the five ranked slots a diverse top five is meant to represent. Non-variant items
 * (including distinct owned-origin candidates that merely share a category or
 * implementationOrigin) are never collapsed — only an explicit shared variantGroup
 * groups them. */
export function dedupeVariantGroups(items: readonly ResourceCandidate[]): ResourceCandidate[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.variantGroup ?? `ref:${resourceRefKey(item.ref)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function summarizeTopFiveAcceptability(queryId: string, mode: RelevanceBenchmarkSummary['mode'], ranked: readonly ResourceCandidate[], label: RelevanceBenchmarkLabel | undefined): RelevanceBenchmarkSummary {
  const topFive = dedupeVariantGroups(ranked).slice(0, 5).map(item => item.ref.itemId);
  const acceptable = new Set(label?.acceptable ?? []);
  return { queryId, mode, topFive, acceptableInTopFive: topFive.filter(id => acceptable.has(id)).length };
}
/** Normalizes to lowercase words separated by single spaces, so punctuation/casing
 * differences between a query and a title/item-ID ("React95", "react-95", "react 95")
 * do not defeat a genuine phrase match. */
function normalizeForPhraseMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}
/** BLOCK fix: a strong title/item-ID match — the query names the specific candidate,
 * not merely a word its category, styleTags or sourceAttribution happens to share with
 * other items — stands in for explicit style intent, the same "or exact literal match"
 * escape hatch rankContextualResources' own `literal` already grants unconditionally
 * (see its loop: `if (literal || spine || primary || secondary)` never re-checks style
 * intent once `literal` is true). Scoped to title+item-ID only (not category/styleTags/
 * sourceAttribution, which is what literalResourceMatch searches) and require at least
 * two tokens, so a single generic word shared across many titles (e.g. "kit") does not
 * count as naming one of them — only a query that is itself impractically ambiguous
 * would hit a two-token false positive here.
 *
 * WARN fix: this used to require only that every query token appear SOMEWHERE in the
 * concatenated `${title} ${itemId}` string — so a two-generic-word query ("neon kit")
 * could bypass decorative/retro suppression by having one word match the title and an
 * unrelated word match a different item's item-ID, without the query actually naming
 * that item. The query must now match the title OR the item-ID (checked separately,
 * never concatenated) as a contiguous normalized phrase, or equal the item-ID exactly. */
/** Whether `needle`'s normalized words appear as a CONTIGUOUS run of whole
 *  words somewhere in `haystack`'s normalized words — not a plain substring
 *  check, which would let a needle match inside a longer word it happens to
 *  be a prefix/suffix of (the WARN fix this guards: "neon kit" must not
 *  match "antineon kitten" just because "antineon" ends with "neon" and
 *  "kitten" starts with "kit"). Both arguments are already
 *  `normalizeForPhraseMatch` output (single-space-separated lowercase
 *  words), so splitting on a plain space is exact. */
function containsWholeWordPhrase(haystack: string, needle: string): boolean {
  const haystackWords = haystack.split(' ').filter(Boolean);
  const needleWords = needle.split(' ').filter(Boolean);
  if (needleWords.length === 0) return false;
  for (let start = 0; start <= haystackWords.length - needleWords.length; start++) {
    if (needleWords.every((word, offset) => haystackWords[start + offset] === word)) return true;
  }
  return false;
}
function queryNamesItemByTitleOrId(item: ResourceCandidate, query: string): boolean {
  const trimmedQuery = query.toLowerCase().trim();
  if (!trimmedQuery) return false;
  // Exact item-ID equality: a single token is enough here — the query IS
  // the concrete identifier, not a generic word that merely overlaps one.
  if (item.ref.itemId.toLowerCase() === trimmedQuery) return true;
  const tokens = trimmedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2) return false;
  const normalizedQuery = normalizeForPhraseMatch(query);
  if (!normalizedQuery) return false;
  return containsWholeWordPhrase(normalizeForPhraseMatch(item.title), normalizedQuery)
    || containsWholeWordPhrase(normalizeForPhraseMatch(item.ref.itemId), normalizedQuery);
}
/** Cheap literal fallback used whenever ranking is unavailable (context toggle off,
 * no saved project, context absent/not-rankable, or the ranking budget expired).
 * It still applies an explicitly requested motion exclusion, and — per the AC-R05
 * preamble — still requires explicit style intent for a continuous-GPU-motion or
 * retro-styleClass candidate, UNLESS the query strongly names that specific item by
 * title or item-ID (queryNamesItemByTitleOrId) — mirroring rankContextualResources'
 * own unconditional literal-match bypass. A bare literalResourceMatch alone is still
 * not itself explicit intent here, since it trivially "matches" every candidate on an
 * empty query and matches any short/generic query whose words happen to appear in a
 * decorative item's title (that case is exactly what queryNamesItemByTitleOrId's
 * two-token floor rules out). */
export function selectLexicalResources(items: readonly ResourceCandidate[], query: string, context?: ProjectDesignContext): Pick<ContextualRankingResult, 'items' | 'excluded'> {
  const constraint = motionConstraint(context); let count = 0;
  const selected = uniqueItems(items).filter(item => {
    if (waitsForQuery(item, query) || !literalResourceMatch(item, query)) return false;
    if (requiresExplicitStyleIntent(item) && !hasExplicitStyleIntent(item, query, context) && !namesNonRetroItem(item, query)) return false;
    if (excludedByMotion(item, constraint)) { count++; return false; }
    return true;
  }).map(item => annotateMotion(item, constraint)).sort(compareResourceTitles);
  return { items: subordinateRetroReferences(selected, query, context), excluded: exclusions(constraint, count) };
}
/**
 * AC-R17.4: a retro-styleClass item needs retro intent itself (retro wording,
 * the kit's own name such as "React95", or the saved style direction). A
 * generic phrase that happens to occur in its title ("settings form",
 * "application window") is an ordinary search and must not surface the
 * opt-in retro kit; the title-naming bypass stays for continuous-motion items.
 */
function namesNonRetroItem(item: ResourceCandidate, query: string): boolean {
  return !isRetroStyleClass(item) && queryNamesItemByTitleOrId(item, query);
}
/**
 * AC-R17.4: under an explicit retro request, a reference-only retro entry (for
 * example an attributed Dell 1996 DESIGN.md analysis) complements the actual
 * kit and ranks after every retro resource that can be previewed or applied.
 * A stable partition: every other order, and every non-retro query, is untouched.
 */
export function subordinateRetroReferences<T extends ResourceCandidate>(items: readonly T[], query: string, context?: ProjectDesignContext): T[] {
  if (!queryRequestsRetroStyle(query, context)) return [...items];
  const reference = (item: T) => isRetroStyleClass(item) && item.readiness === 'reference-only';
  if (!items.some(item => isRetroStyleClass(item) && !reference(item))) return [...items];
  return [...items.filter(item => !reference(item)), ...items.filter(reference)];
}
/** Full authorized facet cohort in; no source lookup, inference, acquisition or capability mutation. */
export function rankContextualResources(items: readonly ResourceCandidate[], query: string, context: ProjectDesignContext, options: { now?: () => number; budgetMs?: number; pageLimit?: number } = {}): ContextualRankingResult {
  // WARN fix: a saved context can be "not rankable" for spine/conversion scoring (no
  // spineCode, no mapped conversion, no non-'allowed' motion constraint) while still
  // carrying an explicit motion:'allowed' constraint or styleDirection wording — both
  // read by hasExplicitStyleIntent via selectLexicalResources' own context parameter.
  // Previously this branch called selectLexicalResources(items, query) with no context
  // at all, so that saved permission silently had no effect in the one mode it would
  // otherwise have reached (the timed-out `fallback` below already passes context
  // through correctly; this was the one place that did not).
  if (!hasRankableProjectContext(context)) return { ...selectLexicalResources(items, query, context), rankable: false, timedOut: false };
  const now = options.now ?? (() => performance.now()); const budget = options.budgetMs ?? 250;
  if (!Number.isFinite(budget) || budget < 0) throw new RangeError('Ranking budget must be finite and nonnegative');
  const start = now(); const expired = () => now() - start >= budget;
  const fallback = (): ContextualRankingResult => ({ ...selectLexicalResources(items, query, context), rankable: true, timedOut: true });
  const cohort = uniqueItems(items); if (expired()) return fallback();
  const constraint = motionConstraint(context); let count = 0;
  const fontRequirements = fontRequirementsFromContext(context).requirements;
  const scored: { item: ResourceCandidate; score: number }[] = [];
  for (let index = 0; index < cohort.length; index++) {
    const item = cohort[index]!;
    if (waitsForQuery(item, query)) continue;
    // AC-R17.4: a literal match alone never surfaces an opt-in retro item without retro intent.
    const literal = literalResourceMatch(item, query) && (!isRetroStyleClass(item) || hasExplicitStyleIntent(item, query, context));
    // Ordinary clinical/transactional requests suppress continuous-GPU decorations
    // and the retro styleClass by default; only an exact literal match (the user
    // named the effect/kit) or explicit retro/decorative intent surfaces them. The
    // explicit-intent check is per item: a retro-styleClass item gates on retro
    // wording only, while a continuous-motion item also honors a saved motion
    // "allowed" constraint — a motion constraint must not unlock retro styling.
    const explicitStyleIntent = hasExplicitStyleIntent(item, query, context);
    const nonLiteralEligible = explicitStyleIntent;
    const spine = nonLiteralEligible && !!context.spineCode && Array.isArray(item.spineAffinities) && item.spineAffinities.includes(context.spineCode);
    const matching = nonLiteralEligible ? context.conversions.filter(conversion => item.sectionKind !== undefined && conversionSections[conversion.kind].includes(item.sectionKind)) : [];
    const primary = matching.find(conversion => conversion.role === 'primary');
    const secondary = matching.find(conversion => conversion.role === 'secondary');
    // AC-R05.2: the project's own tokens and its brief-derived suggestions are grounded
    // in this project by construction, so ranked context includes them without a word match.
    const grounded = PROJECT_OWNED_TOKEN_SOURCES.has(item.ref.sourceId);
    if (literal || spine || primary || secondary || grounded) {
      if (excludedByMotion(item, constraint)) count++;
      else {
        const reasons = [...item.fitReasons];
        if (spine) reasons.push(`spineAffinities includes ${context.spineCode}, matching saved spine ${context.spineCode}`);
        // AC-R11.1: a font explains its own curated fit and counter-fit for the saved spine.
        const fontFit = spine ? item.fontProfile?.spineFit.find(fit => fit.spine === context.spineCode) : undefined;
        if (fontFit) reasons.push(`Font fit for ${fontFit.spine}: ${fontFit.fit}`, `Counter-fit: ${fontFit.counterFit}`);
        if (primary) reasons.push(`sectionKind ${item.sectionKind} suits saved primary ${primary.kind} conversion ${primary.id}; action behavior is unverified`);
        if (secondary) reasons.push(`sectionKind ${item.sectionKind} suits saved secondary ${secondary.kind} conversion ${secondary.id}; action behavior is unverified`);
        if (literal) reasons.push(query.trim() ? 'Literal metadata matches every query token' : 'Empty query includes this local metadata candidate');
        if (grounded) reasons.push(item.ref.sourceId === 'brief-derived-tokens' ? 'Suggested for this project from its saved brief' : 'Declared by this project’s own files');
        if (requiresExplicitStyleIntent(item) && explicitStyleIntent && (spine || primary || secondary)) reasons.push('Explicit retro/decorative intent permits this continuous-motion or retro-styleClass candidate beyond a literal match');
        // Explicit font requirements (script, legibility, italic) outrank spine fit; tone is a preference.
        const requirementFit = fontRequirementFit(item, fontRequirements);
        reasons.push(...requirementFit.reasons);
        scored.push({ item: annotateMotion({ ...item, fitReasons: [...new Set(reasons)] }, constraint), score: (spine ? 30 : 0) + (primary ? 20 : 0) + (secondary ? 10 : 0) + (literal ? 15 : 0) + (grounded ? 1 : 0) + requirementFit.score });
      }
    }
    if ((index + 1) % 32 === 0 && expired()) return fallback();
  }
  if (expired()) return fallback();
  scored.sort((a,b) => b.score - a.score || compareResourceTitles(a.item, b.item));
  if (expired()) return fallback();
  const ordered = subordinateRetroReferences(scored.map(entry => entry.item), query, context);
  return { items: slotEligibleTokens(ordered, contextTokenSlotIndex(options.pageLimit)), excluded: exclusions(constraint, count), rankable: true, timedOut: false };
}
/** AC-R05.2 places the best-ranked eligible colour and sizing resource directly after
 * the top five component results, so the first result group always carries them
 * without displacing the CTA/layout suggestions the top five are measured on (AC-R05.3).
 * A smaller first page moves the two slots up to its last two positions (limit 2: the
 * page is exactly colour and sizing; limit 1: colour only). Ranked context only: lexical
 * modes never reorder. The page limit is part of the cursor binding, so pages stay stable. */
export const CONTEXT_TOKEN_SLOT_INDEX = 5;
export function contextTokenSlotIndex(pageLimit?: number): number {
  return pageLimit === undefined ? CONTEXT_TOKEN_SLOT_INDEX : Math.max(0, Math.min(CONTEXT_TOKEN_SLOT_INDEX, pageLimit - 2));
}
function slotEligibleTokens(items: readonly ResourceCandidate[], slotIndex: number): ResourceCandidate[] {
  // The project's own declared tokens outrank suggestions derived from its brief.
  const picks = (['color', 'sizing'] as const).flatMap(kind => {
    const found = items.find(item => eligibleTokenKind(item) === kind && item.ref.sourceId === 'project-tokens') ?? items.find(item => eligibleTokenKind(item) === kind);
    return found ? [found] : [];
  });
  if (!picks.length) return [...items];
  const rest = items.filter(item => !picks.includes(item));
  const at = Math.min(slotIndex, rest.length);
  const slotted = picks.map(item => ({ ...item, fitReasons: [...new Set([...item.fitReasons, `Eligible project ${eligibleTokenKind(item) === 'color' ? 'colour (contrast evidence passed)' : 'sizing'} resource, shown in the first result group`])] }));
  return [...rest.slice(0, at), ...slotted, ...rest.slice(at)];
}
