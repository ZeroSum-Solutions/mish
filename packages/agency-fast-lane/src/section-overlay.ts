/**
 * Composition overlay: one selectable section on top of a fixed site-family recipe.
 *
 * Implements design decision §2/§3
 * (<private-notes>/mishh-genui-production/motionsites/sol-design.md):
 * a `SectionSelection` names one reviewed adapter (`section-adapter.ts`), a placement, and one of
 * the five `DESIGN_DIRECTIONS`. This module never edits a family's recipe JSON — the family
 * validator's "reject unknown fields" behaviour (see `sol-design.md` §2) is therefore never at
 * risk, because the overlay's own data (the selection and its filled content) never enters that
 * JSON in the first place. Instead:
 *
 *   1. `fillSectionAdapter` makes ONE dedicated model call for the adapter's own slots (a
 *      separate, small unit — not merged into the family's own fill call in this pass; see the
 *      module-level note below on that scope choice), then verifies it against Jev using ONLY
 *      `brief` — `designReference` (an optional, untrusted layout/typography/motion cues string
 *      fetched from a MotionSites prompt) is threaded through the fill prompt as guidance and is
 *      never passed to `verify`, never returned in any report field, and never reaches `onCall`,
 *      a build record, a debug dir or a log: the fill prompt is built as two separate strings
 *      (`adapterPrompts`) — one sent to the model transport, and a structurally distinct one
 *      `onCall` receives, in which the guidance block always carries the fixed
 *      `DESIGN_REFERENCE_WITHHELD_MARKER` instead of `designReference`'s own text.
 *      `tests/section-overlay-design-reference.test.ts` is the standing proof, exercised end to
 *      end through `run.ts`'s `onCall`, `RunReport`, and a simulated `--debug-dir` write.
 *   2. `resolveAnchorOffset` locates a checked, unambiguous insertion point in the family's own
 *      rendered HTML: the end of the named `afterSectionId` element inside `<main>` (or `<body>`
 *      for a family with no `<main>`), or — for `replace-optional` — the end of the section that
 *      immediately precedes the dropped optional slot in the family's own section order (see its
 *      doc comment for why the *rendered* HTML alone cannot answer that).
 *   3. `wrapFamilyPackageForOverlay` returns a `FamilyPackage` whose `render` calls the real one
 *      unchanged, then splices the adapter's deterministic markup (through the adapter's own
 *      `render`, plain text + approved asset ids only — see `section-adapter.ts`) at that anchor,
 *      scoped to the chosen direction's tokens (`direction-tokens.ts`), and rewrites the
 *      manifest's `recipeDigest` to cover the base digest, the selection, the adapter version and
 *      the direction (`artifactDigest`). It takes the adapter already resolved by the caller
 *      rather than re-resolving it, so the digest can never cover a different adapter version
 *      than the one the fill actually ran against (see its own doc comment).
 *
 * MODULE BOUNDARY NOTE: these cached dynamic imports use literal specifiers so the packaged
 * daemon's esbuild prebundle includes the compiler helpers, directions and Cult registry (whose
 * own literal loaders include its adapters). Computed filesystem imports would instead resolve
 * relative to relocated daemon chunks, where the workspace source tree does not exist.
 * Relative TypeScript imports carry a query so JavaScript emit preserves their literal source
 * paths instead of rewriting them to nonexistent JavaScript siblings. Node 24 and esbuild both
 * load these source modules. Queries create separate module instances from plain imports: these
 * helpers hold no shared mutable runtime state, and the overlay passes structural data and
 * functions, never a class identity or an instanceof check across instances. The relocated
 * bundle test exercises Cult adapters through this renderer, including invalid-fill refusal.
 * Local shapes keep relative source imports outside this package's emission boundary; the Cult
 * registry is resolved through its package export.
 *
 * SCOPE NOTE for reviewers: `sol-design.md` §2 describes the adapter's slots as "one additional
 * typed unit" the run's SAME model call fills alongside the rest of the recipe. `run.ts`'s fill
 * loop derives its unit set from the family's own JSON Schema (`limitsFor`/`atomKindsFor`/
 * `unitsOf`, all keyed off `pkg.schema`), so folding in a schema-less adapter unit would mean
 * teaching that pipeline a second, parallel schema source. This implementation instead runs the
 * adapter's fill as one small, separate, fully-verified call (`fillSectionAdapter`), invoked by
 * `runFastLane` right after the family's own fill+verify normally completes and before
 * publication — every guarantee `sol-design.md` actually asks for still holds (one dedicated
 * typed unit, Jev-checked against the brief only, strict verification blocks publish on a
 * failure, the adapter renders deterministically from plain text) at the cost of one extra model
 * round trip per build with a selection. Merging it into the single page-level call is a
 * reasonable follow-up once `run.ts`'s unit machinery grows a second schema source; left for a
 * later pass rather than risking a wide, hard-to-verify change to that file's fill loop here.
 */

import { createHash } from 'node:crypto';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.ts';
import { claimRepairHint } from './repair-hints.ts';
import type { ModelCall, Usage } from './deepseek.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from './jev.ts';
import type { FamilyPackage, RenderResult } from './family.ts';
import { isObject, type Json, type JsonObject } from './spine.ts';
import { internalSectionEntryId, publicAdapterText, publicSectionEntryId } from './cult-public-ids.ts';
import { briefNames, clipWholeWords, cutNames, NUMBER_WORDS, lexicalCuts, promptLimit, tinyValueStands, wordBudget, wordFragments } from './text-clip.ts';

// ---------------------------------------------------------------------------------------------
// Locally-declared shapes for the cross-boundary modules (see the module boundary note above).
// ---------------------------------------------------------------------------------------------

export type AtomKind = 'phone' | 'email' | 'address' | 'plain';
export type SemanticRole = 'background' | 'surface' | 'foreground' | 'muted' | 'accent' | 'on-accent' | 'border';
export type AdapterTextSlot = { name: string; max: number; atom?: AtomKind };
export type AdapterItemsSlot = { name: string; count: number; fields: readonly AdapterTextSlot[] };
export type AdapterFill = {
  text?: Readonly<Record<string, string | null>>;
  items?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string | null>>>>>;
  links?: Readonly<Record<string, string>>;
  assets?: Readonly<Record<string, { src: string; alt?: string }>>;
};
export type SectionAdapter = {
  id: string;
  version: string;
  sourceBlockId: string;
  sourceSha256: string;
  roles: readonly SemanticRole[];
  text: readonly AdapterTextSlot[];
  items?: AdapterItemsSlot;
  links?: readonly { name: string; href: string; label?: string }[];
  assets?: readonly { name: string; altSlot?: string; altMax?: number }[];
  css: string;
  render: (fill: AdapterFill) => string;
};
type AdapterFillError = { slot: string; reason: string };
export type DesignDirection = {
  id: string;
  /** Short user-facing label (`DesignDirection.label` in `packages/contracts/src/prompts/directions.ts`).
   * Not read by anything else in this module — the adapter wrapper only ever needs `palette`/fonts
   * — but carried through so `listDesignDirections` can offer it without a second load. */
  label: string;
  /** One-paragraph mood (`DesignDirection.mood` in `directions.ts`): what `block-plan.ts` shows
   * Jev when it asks which direction a composed page takes. */
  mood?: string;
  displayFont: string;
  bodyFont: string;
  monoFont?: string;
  palette: { bg: string; surface: string; fg: string; muted: string; border: string; accent: string };
};

type OverlayModules = {
  renderSectionAdapter: (adapter: SectionAdapter, fill: AdapterFill) => string;
  validateAdapterFill: (adapter: SectionAdapter, fill: AdapterFill) => AdapterFillError[];
  directionScopeCss: (selector: string, direction: DesignDirection) => string;
  directionBaseCss: (selector: string) => string;
  roleTokensFor: (direction: DesignDirection) => Readonly<Record<SemanticRole, string>>;
  designDirections: readonly DesignDirection[];
  adapters: readonly SectionAdapter[];
  /** `findRealTagOffset`/`findRealTagEnd` (`packages/contracts/src/runtime/html-injection-points.ts`):
   * locate a real structural tag by walking the HTML tokenizer's own states, so a `<body>`/`<main>`
   * an author wrote into a script string or an attribute value is never mistaken for the document's
   * real one (upstream #7410 — `pnpm guard`'s "HTML structural boundary check" enforces this file
   * uses these instead of a plain regex/`indexOf` scan). */
  findRealTagOffset: (html: string, pattern: RegExp) => number;
  findRealTagEnd: (html: string, pattern: RegExp) => number;
  bodyOpen: RegExp;
  bodyClose: RegExp;
};

let cached: Promise<OverlayModules> | undefined;

/** Loads and caches the cross-boundary modules this file needs, once per process. */
function loadOverlayModules(): Promise<OverlayModules> {
  cached ??= (async () => {
    const [sectionAdapter, directionTokens, directions, htmlInjectionPoints, ctas1, featureGrids1, sections1] = await Promise.all([
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../../plugins/_official/shared/agency-compiler/scripts/section-adapter.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../../plugins/_official/shared/agency-compiler/scripts/direction-tokens.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../contracts/src/prompts/directions.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../contracts/src/runtime/html-injection-points.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../../plugins/_official/shared/agency-compiler/scripts/section-adapter-ctas-1.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../../plugins/_official/shared/agency-compiler/scripts/section-adapter-feature-grids-1.ts?agency-overlay'),
      // @ts-expect-error TS2307: source query prevents JS emit from rewriting a cross-package TS path to a nonexistent JS sibling.
      import('../../../plugins/_official/shared/agency-compiler/scripts/section-adapter-sections-1.ts?agency-overlay'),
    ]);
    return {
      renderSectionAdapter: sectionAdapter.renderSectionAdapter,
      validateAdapterFill: sectionAdapter.validateAdapterFill,
      directionScopeCss: directionTokens.directionScopeCss,
      directionBaseCss: directionTokens.directionBaseCss,
      roleTokensFor: directionTokens.roleTokensFor,
      designDirections: directions.DESIGN_DIRECTIONS,
      adapters: [ctas1.ADAPTER, featureGrids1.ADAPTER, sections1.ADAPTER],
      findRealTagOffset: htmlInjectionPoints.findRealTagOffset,
      findRealTagEnd: htmlInjectionPoints.findRealTagEnd,
      bodyOpen: htmlInjectionPoints.HTML_TAG_PATTERNS.bodyOpen,
      bodyClose: htmlInjectionPoints.HTML_TAG_PATTERNS.bodyClose,
    };
  })();
  return cached;
}

/** Matches `HTML_TAG_PATTERNS.bodyOpen`/`bodyClose`'s own convention
 * (`packages/contracts/src/runtime/html-injection-points.ts`) for the one tag that module does not
 * itself name — `<main>` is not a preview-bridge injection point there, but the same
 * tokenizer-accurate lookup applies here for the same reason. */
const MAIN_TAG_PATTERNS = { open: /<main(?=[\t\n\f\r />])/i, close: /<\/main(?=[\t\n\f\r >])/i };

export class SectionSelectionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionSelectionRefusedError';
  }
}

// ---------------------------------------------------------------------------------------------
// Adapter registry: the three reviewed HyperUI adapters plus every checked Cult adapter.
// ---------------------------------------------------------------------------------------------

/** The shape of `packages/cult-ui-catalog/generated/index.ts` (declared locally; see the module
 * boundary note). One lazy loader per insertable Cult catalog row, keyed by its `cult:<name>` id. */
type CultRegistryModule = { CULT_ADAPTERS: Readonly<Record<string, () => Promise<SectionAdapter>>> };

/** A Cult catalog id. Checked before the id reaches the registry lookup or any HTML attribute. */
const CULT_ADAPTER_ID = /^cult:[a-z0-9][a-z0-9-]*$/;

let cultRegistry: Promise<CultRegistryModule> | undefined;

function loadCultRegistry(): Promise<CultRegistryModule> {
  cultRegistry ??= import('@mish/cult-ui-catalog/generated') as Promise<CultRegistryModule>;
  return cultRegistry;
}

/** Every id this registry resolves: the three HyperUI ids first, then the Cult ids, sorted. */
export async function listSectionAdapterIds(): Promise<readonly string[]> {
  const [modules, cult] = await Promise.all([loadOverlayModules(), loadCultRegistry()]);
  return [...modules.adapters.map((adapter) => adapter.id), ...Object.keys(cult.CULT_ADAPTERS).sort()];
}

/**
 * Every insertable adapter: the three reviewed HyperUI adapters (`sol-design.md` §2's v1 roster)
 * and every checked Cult adapter in `@mish/cult-ui-catalog`'s generated registry. Loads
 * every Cult adapter module; a build that needs one adapter calls `resolveSectionAdapter` instead.
 */
export async function listSectionAdapters(): Promise<readonly SectionAdapter[]> {
  const ids = await listSectionAdapterIds();
  return Promise.all(ids.map((id) => resolveSectionAdapter(id)));
}

/**
 * G9 dry run: the most model-written link labels a COMPOSED page block may carry. Every adapter
 * link points at the page's one `#contact` fallback (links are fixed at author time), so each
 * labelled link is a destination the brief must name. `cult:marketing-footer-apple` asks for 18
 * of them plus a 7-character brand slot: the dry run's builds invented or cut labels ("Reports",
 * "Security", "Login", "Stripe" twice, "App Studio" as the brand) or overflowed. A one-page brief
 * names a handful of real destinations; six is the most any passing composed block has used.
 */
export const MAX_COMPOSED_LINK_LABELS = 6;

const SENTINEL = 'zzsentinelzz';

/**
 * Why `adapter` may not be composed into a page, or `undefined` when it may:
 * - `fixed-link-name`: a link whose accessible name is fixed block text with no slot text inside
 *   (an icon link such as aria-label="GitHub") — it names a third party the brief never did and
 *   points at `#contact`, so it is both an invented link and a vendor name on the page.
 * - `too-many-link-labels`: more model-labelled links than `MAX_COMPOSED_LINK_LABELS`.
 * - `render-failed`: the adapter throws on a sentinel fill, so it cannot be scanned at all.
 * Reads only the adapter's own declaration and its render of a sentinel fill; never the brief.
 * The standalone section picker (`/api/sections`, `od sections`) is not affected.
 */
export function composeRefusalFor(adapter: SectionAdapter): 'render-failed' | 'fixed-link-name' | 'too-many-link-labels' | undefined {
  const text = Object.fromEntries(adapter.text.map((slot) => [slot.name, SENTINEL]));
  const items = adapter.items ? { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => Object.fromEntries(adapter.items!.fields.map((field) => [field.name, SENTINEL]))) } : undefined;
  let html: string;
  // PR #136 round 1 (Opus N2): an adapter that cannot render a sentinel fill is refused, never
  // treated as composable on an empty page it could not scan.
  try { html = adapter.render({ text, ...(items ? { items } : {}) }); } catch { return 'render-failed'; }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = /\baria-label="([^"]*)"/i.exec(match[1]!)?.[1];
    const inner = match[2]!.replace(/<[^>]*>/g, '').trim();
    if (label !== undefined && !label.includes(SENTINEL) && inner === '') return 'fixed-link-name';
  }
  const labelled = (adapter.links ?? []).filter((link) => link.label !== undefined).length;
  if (labelled > MAX_COMPOSED_LINK_LABELS) return 'too-many-link-labels';
  return undefined;
}

/** The adapter ids a composed page (`block-plan.ts`) may plan with: every resolvable id whose
 * adapter `composeRefusalFor` accepts. */
export async function listComposableAdapterIds(): Promise<readonly string[]> {
  const adapters = await listSectionAdapters();
  return adapters.filter((adapter) => composeRefusalFor(adapter) === undefined).map((adapter) => adapter.id);
}

/**
 * The five `DESIGN_DIRECTIONS` (`packages/contracts/src/prompts/directions.ts`), narrowed to the
 * `id`/`label` a section picker needs to offer a choice — never the full palette/font/mood spec,
 * which is this package's own runtime detail (`resolveDesignDirection`/`wrapFamilyPackageForOverlay`
 * read the rest). Phase D's `GET /api/sections` route and the `od sections`/`od agency build`
 * surfaces call this so all three list the same five ids from the one place that already loads
 * `directions.ts`, loaded through the cached literal source import described above.
 */
export async function listDesignDirections(): Promise<ReadonlyArray<{ id: string; label: string }>> {
  return (await loadOverlayModules()).designDirections.map((direction) => ({ id: direction.id, label: direction.label }));
}

/**
 * Resolves a selectable entry id to its adapter, or refuses. HyperUI ids resolve from the three
 * reviewed adapters; `cult:<name>` ids resolve on demand from the Cult registry, importing only
 * that adapter's module (cached by the module loader, so every call returns the same object).
 * Anything else — an unknown id, a Cult row without a checked adapter — is refused.
 */
export async function resolveSectionAdapter(requestedId: string): Promise<SectionAdapter> {
  // A Cult entry may be named by its public id (`cult:<slug>`) or, from an older project, its
  // internal one; the registry is keyed on the internal id.
  const entryId = internalSectionEntryId(requestedId);
  const hyperui = (await loadOverlayModules()).adapters.find((candidate) => candidate.id === entryId);
  if (hyperui) return hyperui;
  if (CULT_ADAPTER_ID.test(entryId)) {
    const { CULT_ADAPTERS } = await loadCultRegistry();
    const load = Object.hasOwn(CULT_ADAPTERS, entryId) ? CULT_ADAPTERS[entryId] : undefined;
    if (load) {
      const adapter = await load();
      if (adapter.id !== entryId) throw new SectionSelectionRefusedError(`Cult registry entry ${publicSectionEntryId(entryId)} loaded a different adapter`);
      return adapter;
    }
  }
  throw new SectionSelectionRefusedError(`Unknown or not-yet-reviewed section entry: ${publicSectionEntryId(entryId)}`);
}

/**
 * The five directions with their mood text, for `block-plan.ts`'s one Jev `direction` question.
 * Id, label and mood only — never the palette or fonts, which stay this module's render detail.
 */
export async function listDesignDirectionMoods(): Promise<ReadonlyArray<{ id: string; label: string; mood: string }>> {
  return (await loadOverlayModules()).designDirections.map((direction) => ({ id: direction.id, label: direction.label, mood: direction.mood ?? direction.label }));
}

export async function resolveDesignDirection(directionId: string): Promise<DesignDirection> {
  const direction = (await loadOverlayModules()).designDirections.find((candidate) => candidate.id === directionId);
  if (!direction) throw new SectionSelectionRefusedError(`Unknown design direction: ${directionId}`);
  return direction;
}

export type SectionPlacement =
  | { mode: 'append'; afterSectionId: string }
  | { mode: 'replace-optional'; targetSectionId: string };

/** V1 accepts exactly one selection on a site family (`sol-design.md` §2). */
export type SectionSelection = {
  entryId: string;
  placement: SectionPlacement;
  directionId: string;
};

// ---------------------------------------------------------------------------------------------
// Anchor resolution — pure, no cross-boundary dependency.
// ---------------------------------------------------------------------------------------------

type ElementSpan = { tag: string; openEnd: number; closeStart: number; closeEnd: number };

/**
 * Masks `<script>...</script>`, `<style>...</style>` and HTML comment (`<!--...-->`) spans to
 * spaces, preserving the exact string length so every offset the anchor search computes against
 * the masked text still lines up 1:1 with the real `html` a caller later splices into.
 *
 * `matchElementOpens`/`spanFromOpenMatch` below are a plain regex scan, not the tokenizer
 * `mainRegionSync` uses to find the `<main>`/`<body>` BOUNDARY (see that function's own doc
 * comment on why the boundary lookup is safe from script/style content). Nothing masked the
 * region's INTERIOR before this: `mainRegionSync`'s `<body>` fallback runs over the whole body,
 * including any inline `<script>`/`<style>` a family emits before its first section, so an
 * `id="..."` string literal inside that script — or a fake `<div id="x">...</div>` substring used
 * as example markup in a comment — could be matched as a real anchor element, and its own
 * `</div>`-shaped substrings could desync the nesting-depth counter in `spanFromOpenMatch`. This
 * mask closes both: called once, up front, in `resolveAnchorOffsetSync`, and threaded through
 * every anchor-search call from there — see `tests/section-overlay.test.ts`'s
 * "an id literal inside a <script> must never anchor" test.
 */
function maskNonAnchorSpans(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (match) => ' '.repeat(match.length));
}

/** Every `<TAG ... id="id" ...>` open-tag match for `id`, searched only within
 * `[regionStart, regionEnd)`. Shared by `findElementSpan` (throws on 0 or >1 matches) and
 * `findElementSpanIfPresent` (treats 0 matches as "not rendered this run" rather than an error) so
 * the two never drift on what counts as a match. `html` here is expected to already be
 * `maskNonAnchorSpans`-masked (see that function's doc comment); this function itself does no
 * masking so it stays a pure, allocation-light substring scan. */
function matchElementOpens(html: string, id: string, regionStart: number, regionEnd: number): RegExpMatchArray[] {
  const region = html.slice(regionStart, regionEnd);
  const openPattern = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, 'g');
  return [...region.matchAll(openPattern)];
}

/** The span of one already-located open-tag `match` through its own matching close tag. Tracks
 * same-tag nesting depth so a `<div id="x">` that itself contains nested `<div>`s still resolves
 * to ITS OWN closing tag, not the first inner `</div>`. */
function spanFromOpenMatch(html: string, match: RegExpMatchArray, id: string, regionStart: number, regionEnd: number): ElementSpan {
  const region = html.slice(regionStart, regionEnd);
  const tag = match[1]!.toLowerCase();
  const openEnd = regionStart + match.index! + match[0].length;
  const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = openEnd - regionStart;
  let depth = 1;
  for (let next = tagPattern.exec(region); next; next = tagPattern.exec(region)) {
    const isClose = next[1] === '/';
    const selfClosing = !isClose && /\/>\s*$/.test(next[0]);
    if (selfClosing) continue;
    depth += isClose ? -1 : 1;
    if (depth === 0) {
      const closeStart = regionStart + next.index!;
      return { tag, openEnd, closeStart, closeEnd: closeStart + next[0].length };
    }
  }
  throw new SectionSelectionRefusedError(`Anchor malformed: no matching closing tag for id "${id}"`);
}

/** The unambiguous span of `<TAG ... id="id" ...>...</TAG>` in `html`, searched only within
 * `[regionStart, regionEnd)`. Throws when the id is absent or appears more than once in the
 * region — "checked ... anchor" (`sol-design.md` §2): an absent or ambiguous id must refuse the
 * selection, never guess. */
function findElementSpan(html: string, id: string, regionStart: number, regionEnd: number): ElementSpan {
  const matches = matchElementOpens(html, id, regionStart, regionEnd);
  if (matches.length === 0) throw new SectionSelectionRefusedError(`Anchor not found: no element with id "${id}" in the checked region`);
  if (matches.length > 1) throw new SectionSelectionRefusedError(`Anchor ambiguous: ${matches.length} elements with id "${id}" in the checked region`);
  return spanFromOpenMatch(html, matches[0]!, id, regionStart, regionEnd);
}

/**
 * Same lookup as `findElementSpan`, but returns `undefined` instead of throwing when `id` is
 * simply absent from the rendered region — the expected shape when a `replace-optional` anchor's
 * declared predecessor (per the family's fixed section order) was itself dropped at runtime
 * (`dropSections`/`applySectionDrops` — see `resolveAnchorOffsetSync`'s backward walk below, FIX 4
 * in the delta audit). Ambiguous (more than one match) and malformed (no matching close tag) still
 * throw: those mean the rendered HTML is unexpectedly wrong, never "this id was dropped".
 */
function findElementSpanIfPresent(html: string, id: string, regionStart: number, regionEnd: number): ElementSpan | undefined {
  const matches = matchElementOpens(html, id, regionStart, regionEnd);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new SectionSelectionRefusedError(`Anchor ambiguous: ${matches.length} elements with id "${id}" in the checked region`);
  return spanFromOpenMatch(html, matches[0]!, id, regionStart, regionEnd);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TagUtils = Pick<OverlayModules, 'findRealTagOffset' | 'findRealTagEnd' | 'bodyOpen' | 'bodyClose'>;

/** `[start, end)` of the page's main content flow: inside `<main>...</main>` when the family
 * renders one (watson, fervor — the site families with a literal `<main>`), else the whole
 * `<body>...</body>` (marketing-site and others render sections as direct body children). Either
 * way, every anchor lookup is confined to this region, so a selection can never resolve into the
 * page `<head>` or into a family's own script/style block. Located with `findRealTagOffset`/
 * `findRealTagEnd` (see the doc comment on `OverlayModules`), never a plain regex/`indexOf` scan
 * of the whole document — `pnpm guard`'s HTML structural boundary check requires it.
 *
 * Takes the already-loaded `tagUtils` rather than loading them itself: `wrapFamilyPackageForOverlay`
 * below needs this logic to run SYNCHRONOUSLY inside the `FamilyPackage.render` closure it returns
 * (that interface's `render` is sync, called from deep inside `run.ts`'s fill loop), so it resolves
 * the cross-boundary module once, up front, and passes the plain functions through from there. */
function mainRegionSync(html: string, tagUtils: TagUtils): { start: number; end: number } {
  const { findRealTagOffset, findRealTagEnd, bodyOpen, bodyClose } = tagUtils;
  const mainStart = findRealTagEnd(html, MAIN_TAG_PATTERNS.open);
  if (mainStart >= 0) {
    const mainEnd = findRealTagOffset(html, MAIN_TAG_PATTERNS.close);
    if (mainEnd > mainStart) return { start: mainStart, end: mainEnd };
  }
  const bodyStart = findRealTagEnd(html, bodyOpen);
  if (bodyStart < 0) throw new SectionSelectionRefusedError('Anchor region not found: rendered page has neither <main> nor <body>');
  const bodyEnd = findRealTagOffset(html, bodyClose);
  if (bodyEnd <= bodyStart) throw new SectionSelectionRefusedError('Anchor region malformed: unmatched <body>');
  return { start: bodyStart, end: bodyEnd };
}

/**
 * The character offset in `html` to splice the section at, for `placement`. For `append`, the end
 * of the named section's element. For `replace-optional`, the end of the element immediately
 * PRECEDING the target in the family's own declared section order (`fixtureSectionIds`, e.g.
 * `pkg.fixture.sections.map(s => s?.id)` — order is fixed per family, independent of which slots a
 * given recipe happened to null out): the ORDER always comes from the fixture, never inferred from
 * the rendered HTML, because a dropped optional section renders no trace at all for a post-hoc scan
 * to find (every family's `render.ts` filters `null` sections out before mapping to markup; see
 * e.g. `presentSections` in the shared `sections.ts`).
 *
 * The fixture's immediate predecessor is not always the right anchor, though: it is only a
 * candidate id, and this run's OWN `dropSections` (or a spine that already nulled it) may have
 * dropped that very section too — declared non-null in the fixture, absent from THIS run's actual
 * `html` (FIX 4, delta audit). So the walk goes backward through the fixture's declared order,
 * skipping every id that is null in the fixture (already unconditionally optional-and-dropped) OR
 * that `findElementSpanIfPresent` reports absent from `html` (dropped this run), and anchors on the
 * first one that is actually rendered. Exhausting every declared predecessor without finding one
 * present (or the target being the family's first declared section to begin with) anchors at the
 * very start of the main region.
 */
function resolveAnchorOffsetSync(html: string, fixtureSectionIds: ReadonlyArray<string | null>, placement: SectionPlacement, tagUtils: TagUtils): number {
  // Masked once, up front, and used for every lookup below — offsets computed against it apply
  // unchanged to the real `html` a caller splices into (`maskNonAnchorSpans` preserves length).
  const masked = maskNonAnchorSpans(html);
  const region = mainRegionSync(masked, tagUtils);
  if (placement.mode === 'append') {
    const span = findElementSpan(masked, placement.afterSectionId, region.start, region.end);
    return span.closeEnd;
  }
  const index = fixtureSectionIds.findIndex((id) => id === placement.targetSectionId);
  if (index < 0) throw new SectionSelectionRefusedError(`Anchor not found: family declares no section "${placement.targetSectionId}"`);
  for (const id of fixtureSectionIds.slice(0, index).reverse()) {
    if (id === null) continue;
    const span = findElementSpanIfPresent(masked, id, region.start, region.end);
    if (span) return span.closeEnd;
  }
  return region.start;
}

/** Public async form: loads `tagUtils` itself, for a caller with no reason to keep the result
 * synchronous — `run.ts`'s early, fail-fast structural check (before any fill effort is spent)
 * is the only caller. */
export async function resolveAnchorOffset(html: string, fixtureSectionIds: ReadonlyArray<string | null>, placement: SectionPlacement): Promise<number> {
  const tagUtils = await loadOverlayModules();
  return resolveAnchorOffsetSync(html, fixtureSectionIds, placement, tagUtils);
}

export function spliceSectionHtml(html: string, offset: number, sectionHtml: string): string {
  return `${html.slice(0, offset)}${sectionHtml}${html.slice(offset)}`;
}

/**
 * The family's declared section id order, from its reference fixture (`pkg.fixture.sections`) —
 * fixed per family, independent of which slots a given run happened to null out. Shared by
 * `run.ts`'s early fail-fast anchor check and `wrapFamilyPackageForOverlay`'s render-time
 * re-check (FIX 5, delta audit) so the two can never derive a different order from the same
 * package: before this helper existed, each site inlined its own copy of this exact expression,
 * which could silently drift.
 */
export function fixtureSectionIdsOf(pkg: Pick<FamilyPackage, 'fixture'>): ReadonlyArray<string | null> {
  const sections = (pkg.fixture as { sections?: unknown }).sections;
  return (Array.isArray(sections) ? (sections as Array<{ id?: unknown } | null>) : []).map((section) => (
    section && typeof section.id === 'string' ? section.id : null
  ));
}

// ---------------------------------------------------------------------------------------------
// Fill + faithfulness verification (brief only — designReference never reaches this)
// ---------------------------------------------------------------------------------------------

export type AdapterFillTemplate = { text: Record<string, string>; items?: Record<string, Array<Record<string, string>>> };

function templateFor(adapter: SectionAdapter): AdapterFillTemplate {
  const text: Record<string, string> = {};
  for (const slot of adapter.text) text[slot.name] = '';
  const template: AdapterFillTemplate = { text };
  if (adapter.items) template.items = { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => Object.fromEntries(adapter.items!.fields.map((f) => [f.name, '']))) };
  return template;
}

/**
 * The limits the fill prompt shows. A selected section (the family overlay) shows each hard
 * maximum as it is; a composed block (`composed`) shows it with headroom (`promptLimit`), since its
 * over-long answers are clipped rather than refused.
 */
function promptLimitsFor(adapter: SectionAdapter, composed: boolean): Json {
  const shown = (max: number) => (composed ? promptLimit(max) : max);
  const text: Record<string, number> = {};
  for (const slot of adapter.text) text[slot.name] = shown(slot.max);
  const limits: JsonObject = { text: text as unknown as Json };
  if (adapter.items) limits.items = { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => Object.fromEntries(adapter.items!.fields.map((f) => [f.name, shown(f.max)]))) } as unknown as Json;
  return limits as Json;
}

function budgetLine(path: string, max: number, nullable: boolean): string {
  const limit = promptLimit(max);
  const words = wordBudget(limit);
  return `- ${path}: at most ${limit} characters, about ${words} word${words === 1 ? '' : 's'}${nullable ? ', or null' : ''}`;
}

/** One BUDGETS line per slot; an item field is listed once for all its rows. */
export function budgetsFor(adapter: SectionAdapter): string[] {
  const lines = adapter.text.map((slot) => budgetLine(`text.${slot.name}`, slot.max, Boolean(slot.atom)));
  if (adapter.items) {
    const group = `items.${adapter.items.name}[0-${adapter.items.count - 1}]`;
    for (const field of adapter.items.fields) lines.push(budgetLine(`${group}.${field.name}`, field.max, Boolean(field.atom)));
  }
  return lines;
}

/**
 * The composed page's last resort for an answer that is still over its limits after every repair
 * attempt: each over-long slot is cut with `clipWholeWords` (complete sentences, else whole words;
 * never part of a word). A slot where not even one word fits is omitted when the adapter lets it be
 * null (its fact atom), and otherwise left as it was, so the fill stays invalid and is refused
 * rather than rendered with a fragment. Returns the new fill and the paths it changed.
 */
export function clipAdapterFill(adapter: SectionAdapter, fill: AdapterFill): { fill: AdapterFill; paths: string[] } {
  const paths: string[] = [];
  const clipSlot = (spec: { max: number; atom?: unknown }, value: string | null | undefined, path: string): string | null | undefined => {
    if (typeof value !== 'string' || value.trim().length <= spec.max) return value;
    const cut = clipWholeWords(value, spec.max);
    if (cut !== undefined) { paths.push(path); return cut; }
    if (spec.atom) { paths.push(path); return null; }
    return value;
  };
  const text: Record<string, string | null> = { ...(fill.text ?? {}) } as Record<string, string | null>;
  for (const slot of adapter.text) {
    if (slot.name in text) text[slot.name] = clipSlot(slot, text[slot.name], `text.${slot.name}`) as string | null;
  }
  const out: AdapterFill = { ...fill, text };
  if (adapter.items && fill.items?.[adapter.items.name]) {
    const name = adapter.items.name;
    const fields = adapter.items.fields;
    out.items = {
      ...fill.items,
      [name]: fill.items[name]!.map((row, index) => {
        const next: Record<string, string | null> = { ...row } as Record<string, string | null>;
        for (const field of fields) {
          if (field.name in next) next[field.name] = clipSlot(field, next[field.name], `items.${name}[${index}].${field.name}`) as string | null;
        }
        return next;
      }),
    } as AdapterFill['items'];
  }
  return { fill: out, paths };
}

/** `fill` with every nullable slot whose text `isCut` flags set to null, and the paths it nulled. */
export function omitCutNullables(adapter: SectionAdapter, fill: AdapterFill, isCut: (text: string, max: number) => boolean): { fill: AdapterFill; paths: string[] } {
  const paths: string[] = [];
  const text: Record<string, string | null> = { ...(fill.text ?? {}) } as Record<string, string | null>;
  for (const slot of adapter.text) {
    const value = text[slot.name];
    if (slot.atom && typeof value === 'string' && isCut(value, slot.max)) { text[slot.name] = null; paths.push(`text.${slot.name}`); }
  }
  const out: AdapterFill = { ...fill, text };
  if (adapter.items && fill.items?.[adapter.items.name]) {
    const name = adapter.items.name;
    const fields = adapter.items.fields.filter((field) => field.atom);
    out.items = {
      ...fill.items,
      [name]: fill.items[name]!.map((row, index) => {
        const next: Record<string, string | null> = { ...row } as Record<string, string | null>;
        for (const field of fields) {
          const value = next[field.name];
          if (typeof value === 'string' && isCut(value, field.max)) { next[field.name] = null; paths.push(`items.${name}[${index}].${field.name}`); }
        }
        return next;
      }),
    } as AdapterFill['items'];
  }
  return { fill: out, paths };
}

/** A validation error with the fix spelled out for a too-long value: its length, the limit and
 * the word budget, and the whole-word rule. Other errors pass through unchanged. */
function withLengthHint(adapter: SectionAdapter, fill: AdapterFill, error: { slot: string; reason: string }): string {
  const over = /^exceeds (\d+) characters$/.exec(error.reason);
  if (!over) return `${error.slot}: ${error.reason}`;
  const max = Number(over[1]);
  const limit = promptLimit(max);
  const value = valueAt(adapter, fill, error.slot);
  const had = typeof value === 'string' ? ` (yours had ${value.trim().length})` : '';
  const words = wordBudget(limit);
  return `${error.slot}: exceeds ${max} characters${had}. Fix: write at most ${limit} characters, about ${words} word${words === 1 ? '' : 's'}, as complete words; shorten the phrase, never cut a word`;
}

/** The value a validator error names: a text slot (`title`) or an item field (`rows[0].title`). */
function valueAt(adapter: SectionAdapter, fill: AdapterFill, slot: string): unknown {
  const item = /^([^[]+)\[(\d+)\]\.(.+)$/.exec(slot);
  if (item && adapter.items && item[1] === adapter.items.name) return fill.items?.[item[1]]?.[Number(item[2])]?.[item[3]!];
  return fill.text?.[slot];
}

function nullableFor(adapter: SectionAdapter): Json | undefined {
  const text: Record<string, string> = {};
  for (const slot of adapter.text) if (slot.atom) text[slot.name] = slot.atom;
  if (Object.keys(text).length === 0 && !adapter.items?.fields.some((f) => f.atom)) return undefined;
  const nullable: JsonObject = { text: text as unknown as Json };
  if (adapter.items) {
    const itemNullable = Object.fromEntries(adapter.items.fields.filter((f) => f.atom).map((f) => [f.name, f.atom]));
    if (Object.keys(itemNullable).length > 0) nullable.items = { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => itemNullable) } as unknown as Json;
  }
  return nullable as Json;
}

/**
 * `previous` with the value at `path` (`text.heading`, `items.rows[0].title`) taken from `answer`;
 * every other value is `previous`'s own. `undefined` when the answer does not carry a well-formed
 * value there (a string or `null`, in a row that is an object at an index `previous` has), so a
 * malformed answer can never throw here.
 */
function withFlaggedValue(previous: AdapterFill, answer: AdapterFill, path: string): AdapterFill | undefined {
  const isRow = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const isValue = (value: unknown): value is string | null => typeof value === 'string' || value === null;
  const textSlot = /^text\.([^.[\]]+)$/.exec(path);
  if (textSlot) {
    const name = textSlot[1]!;
    const value: unknown = isRow(answer.text) ? (answer.text as Record<string, unknown>)[name] : undefined;
    if (!isValue(value)) return undefined;
    return { ...previous, text: { ...previous.text, [name]: value } };
  }
  const itemSlot = /^items\.([^.[\]]+)\[(\d+)\]\.([^.[\]]+)$/.exec(path);
  if (!itemSlot) return undefined;
  const group = itemSlot[1]!;
  const index = Number(itemSlot[2]);
  const field = itemSlot[3]!;
  const rows = previous.items?.[group];
  const answerRows: unknown = isRow(answer.items) ? (answer.items as Record<string, unknown>)[group] : undefined;
  const row: unknown = Array.isArray(answerRows) ? answerRows[index] : undefined;
  const value: unknown = isRow(row) ? row[field] : undefined;
  if (!rows || index >= rows.length || !isValue(value)) return undefined;
  return { ...previous, items: { ...previous.items, [group]: rows.map((current, i) => (i === index ? { ...current, [field]: value } : current)) } };
}

/**
 * The slots a block declares as step numbers, by adapter id. Only these may hold a bare step
 * marker; a numbered slot elsewhere (a statistic `body7`, a price `label4`) can state a fact, so it
 * is always checked (Sol review of #294, round 2). Add a block here only after reading its markup.
 */
const STEP_MARKER_SLOTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Renders a numbered badge beside each of its four steps.
  ['cult:sass-colorful--how-it-works', new Set(['text.item1', 'text.item2', 'text.item3', 'text.item4'])],
]);

/**
 * A step marker: a declared step slot (`STEP_MARKER_SLOTS`) whose whole text is the number its own
 * name ends with ("item3": "3"). It numbers a block's steps; it states nothing about the business.
 */
function isStepMarker(adapterId: string, slot: FaithfulnessSlot): boolean {
  if (!STEP_MARKER_SLOTS.get(adapterId)?.has(slot.path)) return false;
  const own = /(\d+)$/.exec(slot.path);
  return own !== null && /^\d{1,2}$/.test(slot.text.trim()) && Number(slot.text.trim()) === Number(own[1]);
}

function flatSlots(fill: AdapterFill): FaithfulnessSlot[] {
  const out: FaithfulnessSlot[] = [];
  for (const [name, value] of Object.entries(fill.text ?? {})) if (typeof value === 'string' && value.trim()) out.push({ path: `text.${name}`, text: value });
  for (const [group, rows] of Object.entries(fill.items ?? {})) {
    rows.forEach((row, index) => {
      for (const [field, value] of Object.entries(row)) if (typeof value === 'string' && value.trim()) out.push({ path: `items.${group}[${index}].${field}`, text: value });
    });
  }
  return out;
}

function parseFill(adapter: SectionAdapter, answer: string): AdapterFill {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch (error) {
    throw new Error(`answer was not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('answer must be a JSON object');
  const record = parsed as Record<string, unknown>;
  const text = record.text && typeof record.text === 'object' && !Array.isArray(record.text) ? (record.text as Record<string, string | null>) : {};
  const items: Record<string, Array<Record<string, string | null>>> = {};
  if (adapter.items && record.items && typeof record.items === 'object') {
    const rows = (record.items as Record<string, unknown>)[adapter.items.name];
    if (Array.isArray(rows)) items[adapter.items.name] = rows as Array<Record<string, string | null>>;
  }
  return { text, items };
}

export type FillSectionAdapterOptions = {
  adapter: SectionAdapter;
  brief: string;
  /** Untrusted layout/typography/motion cues, e.g. from a fetched MotionSites prompt — steers
   * tone/emphasis only. Never reaches `verify`, never appears in the returned report. Reaches
   * `onCall` (below) only as the fixed `DESIGN_REFERENCE_WITHHELD_MARKER`, never its own text —
   * see `adapterPrompts`. */
  designReference?: string;
  model: ModelCall;
  verify?: FaithfulnessChecker;
  strict?: boolean;
  maxRepairs?: number;
  maxFaithfulnessRounds?: number;
  signal?: AbortSignal;
  /**
   * The composed-page fill policy (`block-compose.ts` turns it on; off by default, so a selected
   * section of a family build fills exactly as before — same prompt, same repairs, same refusals):
   *
   * - The prompt shows each limit with headroom and a BUDGETS block (characters and words per
   *   slot), and a too-long repair message names the length, the limit and the budget.
   * - A value that cuts a brief name or number word short ("Quick" for "QuickBooks") is sent back
   *   for repair. After the last attempt, a nullable slot that still cuts one is omitted; a
   *   required slot gets one narrow rewrite request, and the fill is refused if that fails too.
   * - When every attempt is rejected, each over-long slot of the last answer is cut to whole words
   *   (`clipAdapterFill`: complete sentences first, never part of a word; a nullable slot where no
   *   word fits is omitted) and accepted if that alone makes it valid. A required slot where not
   *   even one word fits gets one narrow shorten request; if that fails too, the fill is refused.
   *   The clipped paths come back as `clipped`; the faithfulness check still runs on them.
   */
  composed?: boolean;
  /**
   * Receives every prompt/answer this function's model calls make — same shape as
   * `RunOptions.onCall` in `run.ts`, and `run.ts` forwards its own `onCall` straight through here.
   * The `prompt` this receives is always the RECORD prompt (`adapterPrompts`' `forRecord`): built
   * from the same base as the one actually sent to the model, but with `designReference`'s content
   * replaced by `DESIGN_REFERENCE_WITHHELD_MARKER`. This is the structural half of the
   * design-reference boundary (BLOCK 1, delta audit): the guidance text itself is never passed to
   * this callback, so a caller that persists `onCall` payloads (`cli.ts`'s `--debug-dir`, or any
   * future build-record writer) can never end up with `designReference` on disk, regardless of
   * what it does with what it receives.
   */
  onCall?: (call: { label: string; attempt: number; prompt: string; answer: string }) => void;
};

export type FillSectionAdapterResult = {
  fill: AdapterFill;
  calls: number;
  usage: Usage;
  retries: number;
  flagged: string[];
  remaining: string[];
  /** `composed` only: the slot paths cut to their limit (`text.body`, `items.rows[0].title`). */
  clipped?: string[];
  /** Faithfulness repair answers thrown away (the previous fill kept), with why (B-113). */
  discarded?: Array<{ round: number; reason: 'malformed' | 'invalid'; detail: string }>;
};

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input;
  total.output += usage.output;
  total.cachedRead += usage.cachedRead;
}

/** The fixed marker that stands in for `designReference`'s own text in the RECORD prompt
 * (`adapterPrompts`' `forRecord`) — the one `onCall` receives. Never the guidance text itself. */
export const DESIGN_REFERENCE_WITHHELD_MARKER = '[design reference withheld]';

/** One guidance block, `DESIGN GUIDANCE (...)`, wrapping either the real design-reference text
 * (for the model) or `DESIGN_REFERENCE_WITHHELD_MARKER` (for the record) — same wording either
 * way, so the two prompts differ in exactly one place. */
function designGuidanceBlock(text: string): string {
  return `DESIGN GUIDANCE (layout/typography/motion cues only — not a source of facts, never quote or reuse its copy, business claims or contact details)\n${text}\n\n`;
}

/** Splices `guidance` into `base` right after `CLIENT BRIEF`, before `TASK` — deliberately NOT
 * between `LIMITS` and `TEMPLATE` (or after `TEMPLATE`): a consumer that locates one of those
 * blocks by scanning to the NEXT known section header (as `buildUserPrompt`'s own shape invites,
 * and as this package's own test fixtures do) assumes `LIMITS` is immediately followed by
 * `TEMPLATE` with nothing between; inserting there would make a `LIMITS` scan swallow the guidance
 * text as trailing (invalid) JSON. Inserting before `TASK` keeps that adjacency intact for every
 * section after it. */
function withGuidance(base: string, guidance: string): string {
  const marker = '\nTASK\n';
  const at = base.indexOf(marker);
  return at < 0 ? `${guidance}${base}` : `${base.slice(0, at + 1)}${guidance}${base.slice(at + 1)}`;
}

/** The section's own copy prompt WITHOUT any design reference — the part that is identical
 * whether or not a `designReference` was given, and so the part safe to build once and reuse for
 * both `adapterPrompts` outputs below. */
function baseAdapterPrompt(adapter: SectionAdapter, brief: string, composed: boolean, rejected?: { answer: string; error: string }): string {
  return buildUserPrompt({
    brief,
    template: templateFor(adapter) as unknown as Json,
    limits: promptLimitsFor(adapter, composed),
    nullable: nullableFor(adapter),
    ...(composed ? { budgets: budgetsFor(adapter) } : {}),
    scope: `Fill the inserted "${adapter.sourceBlockId}" section`,
    rejected,
  });
}

/**
 * The two prompt strings for one call, built from the same `base` so they are byte-identical
 * outside the guidance block:
 *
 *   - `forModel`: sent to the model transport, carrying `designReference` in full when given.
 *     Exists only as a local value passed straight into `options.model(...)`; this function
 *     returns it, but `fillSectionAdapter` below is the only caller and never stores or forwards
 *     it anywhere except that one call.
 *   - `forRecord`: safe to hand to `onCall` (and so to `--debug-dir`, a build record, or any other
 *     logger a caller wires up) — the guidance block's content is always
 *     `DESIGN_REFERENCE_WITHHELD_MARKER`, never `designReference`'s own text.
 *
 * This is the structural half of the design-reference boundary (`sol-design.md` §2's "untrusted
 * design guidance ... in memory, separate from the client brief"; BLOCK 1, delta audit): the two
 * strings are computed as two distinct values from the start, not one prompt with a value redacted
 * out of it after the fact, so there is no code path in which `forRecord` could ever end up
 * carrying `designReference`'s text.
 */
function adapterPrompts(adapter: SectionAdapter, brief: string, designReference: string | undefined, composed: boolean, rejected?: { answer: string; error: string }): { forModel: string; forRecord: string } {
  const base = baseAdapterPrompt(adapter, brief, composed, rejected);
  if (!designReference) return { forModel: base, forRecord: base };
  const trimmed = designReference.trim().slice(0, 4000);
  return {
    forModel: withGuidance(base, designGuidanceBlock(trimmed)),
    forRecord: withGuidance(base, designGuidanceBlock(DESIGN_REFERENCE_WITHHELD_MARKER)),
  };
}

async function loadValidateAdapterFill(): Promise<OverlayModules['validateAdapterFill']> {
  return (await loadOverlayModules()).validateAdapterFill;
}

export async function fillSectionAdapter(options: FillSectionAdapterOptions): Promise<FillSectionAdapterResult> {
  const { adapter } = options;
  const validateAdapterFill = await loadValidateAdapterFill();
  const maxRepairs = options.maxRepairs ?? 1;
  const maxFaithfulnessRounds = options.maxFaithfulnessRounds ?? 2;
  const label = `section:${adapter.id}`;
  let calls = 0;
  const usage: Usage = { input: 0, output: 0, cachedRead: 0 };
  let retries = 0;
  const call = async (prompts: { forModel: string; forRecord: string }, attempt: number) => {
    calls += 1;
    const response = await options.model({ system: SYSTEM_PROMPT, user: prompts.forModel, label, signal: options.signal });
    addUsage(usage, response.usage);
    retries += response.retries;
    options.onCall?.({ label, attempt, prompt: prompts.forRecord, answer: response.text });
    return response;
  };

  const composed = options.composed === true;
  const prompt = (rejected?: { answer: string; error: string }) => adapterPrompts(adapter, options.brief, options.designReference, composed, rejected);
  const errorText = (parsed: AdapterFill, error: { slot: string; reason: string }) => (composed ? withLengthHint(adapter, parsed, error) : `${error.slot}: ${error.reason}`);
  // Composed only. Brief names plus number words: a step label cut to fit ("Fou") reads as
  // clipped text too.
  const names = composed ? [...briefNames(options.brief), ...NUMBER_WORDS] : [];
  const briefWords = new Set([...options.brief.matchAll(/[A-Za-z][A-Za-z'’]*/gu)].map((match) => match[0].toLowerCase()));
  // Composed only. Every token is also checked for self-truncation in general (`wordFragments`):
  // a strict prefix of a brief word or of another word of the same fill that is not itself a word
  // ("invoi" for "invoices"), in slots of any length.
  const briefLetters = new Set([...options.brief.matchAll(/[A-Za-z]+/gu)].map((match) => match[0].toLowerCase()));
  const fragmentTargets = (candidate: AdapterFill): Set<string> => new Set([...briefLetters, ...flatSlots(candidate).flatMap((slot) => [...slot.text.matchAll(/[A-Za-z]+/gu)].map((match) => match[0].toLowerCase()))]);
  const cutsIn = (text: string, targets: ReadonlySet<string>): string[] => {
    const named = cutNames(text, names, briefWords);
    const fragments = wordFragments(text, briefLetters, targets).filter((fragment) => !named.some((cut) => cut.word === fragment.word));
    // The lexical completion gate: a token no dictionary knows that starts a list word.
    const lexical = lexicalCuts(text, briefLetters).filter((cut) => !named.some((other) => other.word === cut.word) && !fragments.some((other) => other.word === cut.word));
    return [
      ...named.map((cut) => `cuts the name "${cut.name}" to "${cut.word}"`),
      ...[...fragments, ...lexical].map((fragment) => `cuts the word "${fragment.of}" to "${fragment.word}"`),
    ];
  };
  const nameCutErrors = (candidate: AdapterFill): string[] => {
    if (!composed) return [];
    const targets = fragmentTargets(candidate);
    return flatSlots(candidate).flatMap((slot) => cutsIn(slot.text, targets)
      .map((cut) => `${slot.path}: ${cut}. Fix: write every word and name in full, or leave it out and use other words; never shorten a name or a word`));
  };
  let fill: AdapterFill | undefined;
  let lastAnswer = '';
  let lastError = '';
  for (let attempt = 0; attempt <= maxRepairs && !fill; attempt += 1) {
    const prompts = prompt(attempt === 0 ? undefined : { answer: lastAnswer, error: lastError });
    const response = await call(prompts, attempt);
    lastAnswer = response.text;
    try {
      const parsed = parseFill(adapter, response.text);
      const errors = validateAdapterFill(adapter, parsed);
      if (errors.length > 0) throw new Error(errors.map((e) => errorText(parsed, e)).join('; '));
      // A name the model cut to fit ("Quick" for "QuickBooks") reads as clipped text: while a
      // repair is left, it is sent back like any other error. The last attempt's cuts are handled
      // after the loop (`settleCuts`): omitted where nullable, one narrow rewrite otherwise.
      const cuts = attempt < maxRepairs ? nameCutErrors(parsed) : [];
      if (cuts.length > 0) throw new Error(cuts.join('; '));
      fill = parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  let clipped: string[] | undefined;
  if (!fill && composed) {
    try {
      const parsed = parseFill(adapter, lastAnswer);
      const { fill: cut, paths } = clipAdapterFill(adapter, parsed);
      const left = validateAdapterFill(adapter, cut);
      if (paths.length > 0 && left.length === 0) {
        fill = cut;
        clipped = paths;
      } else if (left.length > 0 && left.every((error) => /^exceeds \d+ characters$/.test(error.reason))) {
        // A required slot not even one word of which fits (a 7-character label answered with a
        // 10-letter name): no clip can fix it without a fragment, so the model gets one last,
        // narrow request to shorten exactly those values. Its answer is clipped the same way.
        const rule = `${left.map((error) => withLengthHint(adapter, cut, error)).join('; ')}. Rewrite only these values, shorter, as whole words; change no other value.`;
        const response = await call(prompt({ answer: JSON.stringify(cut), error: rule }), calls);
        const shortened = clipAdapterFill(adapter, parseFill(adapter, response.text));
        if (validateAdapterFill(adapter, shortened.fill).length === 0) {
          fill = shortened.fill;
          clipped = [...new Set([...paths, ...shortened.paths])];
        } else {
          lastError = left.map((error) => `${error.slot}: ${error.reason}`).join('; ');
        }
      }
    } catch (error) {
      // Unparseable: refused below with the last attempt's own error. A cancellation propagates.
      if (options.signal?.aborted) throw error;
    }
  }
  if (!fill) throw new SectionSelectionRefusedError(`Section fill rejected after ${maxRepairs + 1} attempt(s): ${lastError}`);
  // Composed only, and always BEFORE the faithfulness check, so Jev checks the exact fill that is
  // returned: nothing after the check calls the model or adds text. A name, number word or other
  // word still cut short after the repair is omitted where the
  // adapter lets the slot be null ("Tri" in a 3-character step label), so the page never shows it.
  // So is a tiny nullable value that is not plainly a whole word (`tinyValueStands`: "Inv", "Rpt").
  // A required slot that still cuts a name gets one narrow rewrite request; if its answer still
  // cuts one (or is not valid), the fill is refused — a composed page never shows a cut name.
  const omitCuts = (candidate: AdapterFill): AdapterFill => {
    if (!composed) return candidate;
    const targets = fragmentTargets(candidate);
    const omitted = omitCutNullables(adapter, candidate, (text, max) => cutsIn(text, targets).length > 0 || !tinyValueStands(text, max, briefWords));
    if (omitted.paths.length > 0) clipped = [...new Set([...(clipped ?? []), ...omitted.paths])];
    return omitted.fill;
  };
  const settleCuts = async (candidate: AdapterFill): Promise<AdapterFill> => {
    const omitted = omitCuts(candidate);
    if (!composed) return omitted;
    const left = nameCutErrors(omitted);
    if (left.length === 0) return omitted;
    const rule = `${left.join('; ')}. Rewrite only these values with every word and name in full; change no other value.`;
    const response = await call(prompt({ answer: JSON.stringify(omitted), error: rule }), calls);
    let rewritten: AdapterFill | undefined;
    try {
      const parsed = parseFill(adapter, response.text);
      if (validateAdapterFill(adapter, parsed).length === 0) rewritten = omitCuts(parsed);
    } catch { /* refused below */ }
    const still = rewritten ? nameCutErrors(rewritten) : left;
    if (!rewritten || still.length > 0) throw new SectionSelectionRefusedError(`Section fill refused: a required value still cuts a word or name short: ${still.join('; ')}`);
    return rewritten;
  };
  fill = await settleCuts(fill);
  const clippedNow = () => (clipped ? { clipped } : {});

  if (!options.verify) return { fill, calls, usage, retries, flagged: [], remaining: [], ...clippedNow() };

  let flaggedEver: string[] = [];
  let remaining: string[] = [];
  const discarded: NonNullable<FillSectionAdapterResult['discarded']> = [];
  /**
   * Composed only (B-113): a repair answer changes only the flagged slots, one at a time. Each
   * flagged value is taken from the answer, clipped like a first fill and validated; a value that
   * is missing, malformed or invalid keeps its previous, checked value (and stays flagged), while
   * the other flagged values are still taken. Every unflagged value stays exactly as checked. A
   * value that still cuts a word after the nullable cuts are omitted is put back as well, so the
   * returned fill has no cut word and the next round checks exactly what may publish.
   */
  const takeFlaggedRepairs = (previous: AdapterFill, answer: AdapterFill, paths: readonly string[]) => {
    let next = previous;
    let taken = 0;
    let malformed = false;
    const clips: string[] = [];
    const rejected: string[] = [];
    const takenPaths: string[] = [];
    for (const path of paths) {
      const merged = withFlaggedValue(next, answer, path);
      if (merged === undefined) {
        malformed = true;
        rejected.push(`${path}: missing or malformed in the answer`);
        continue;
      }
      const cut = clipAdapterFill(adapter, merged);
      const errors = validateAdapterFill(adapter, cut.fill);
      if (errors.length > 0) {
        rejected.push(errors.map((e) => `${e.slot}: ${e.reason}`).join('; '));
        continue;
      }
      next = cut.fill;
      clips.push(...cut.paths);
      takenPaths.push(path);
      taken += 1;
    }
    if (taken === 0) return { fill: previous, taken, malformed, clips, rejected };
    let settled = omitCuts(next);
    const cutPaths = nameCutErrors(settled).map((error) => error.slice(0, error.indexOf(':')));
    if (cutPaths.length > 0) {
      for (const path of cutPaths) {
        const restored = withFlaggedValue(settled, previous, path);
        if (restored) settled = restored;
        rejected.push(`${path}: cuts a word or name short`);
      }
      taken -= takenPaths.filter((path) => cutPaths.includes(path)).length;
    }
    // Defence in depth: the fill handed on must validate and cut nothing, or nothing is taken.
    if (taken <= 0 || validateAdapterFill(adapter, settled).length > 0 || nameCutErrors(settled).length > 0) {
      return { fill: previous, taken: 0, malformed, clips: [], rejected };
    }
    return { fill: settled, taken, malformed, clips, rejected };
  };
  // A round-10 audit pass (storefront-r6-grok.md FIX 4) found a checker that returns `skipped`
  // with an EMPTY `flagged` left `remaining` empty too, so `options.strict && remaining.length > 0`
  // below never fired and the spliced section registered on a check that never actually completed
  // — the base page's own verify loop (`run.ts`) and `block-compose.ts` both already fail closed
  // on any skip; this loop did not. `skippedThisRun` makes that failure explicit and independent
  // of whether anything was ever flagged.
  let skippedThisRun: string | undefined;
  for (let round = 0; round <= maxFaithfulnessRounds; round += 1) {
    // Composed only: a block's step markers ("item3": "3") are structure, not facts, so they are
    // never sent to the check (B-113). Every other slot, any other number included, still is.
    const checkSlots = composed ? flatSlots(fill).filter((slot) => !isStepMarker(adapter.id, slot)) : flatSlots(fill);
    const check = await options.verify.checkFaithfulness({ brief: options.brief, slots: checkSlots });
    const flaggedPaths = check.flagged.map((f) => f.path);
    if (check.skipped !== undefined) {
      skippedThisRun = check.skipped;
      remaining = flaggedEver.length > 0 ? flaggedEver : flaggedPaths;
      break;
    }
    for (const path of flaggedPaths) if (!flaggedEver.includes(path)) flaggedEver.push(path);
    if (flaggedPaths.length === 0) {
      remaining = [];
      break;
    }
    remaining = flaggedPaths;
    if (round === maxFaithfulnessRounds) break;
    // G8 dry run: the same rule the family repair states (`run.ts`'s `FAITHFULNESS_RULE`) — a
    // "neutral wording" reword of a claim sentence is still an untraced claim — with the same
    // per-slot hint (`repair-hints.ts`): the words the brief lacks and its closest sentences.
    const rule = 'Fix each flagged value: return null where the slot is nullable; otherwise either state the fact only in the brief\'s own words (copy the brief sentence quoted for it, shortened to fit, with no word added or swapped), or delete the claim and write a short label that has no number, date, time, price, amount, count, distance, award or sales word (free, price, order, ship, delivery, return, stock, sale, gift). Do not paraphrase a claim or swap in synonyms, and never write a name, link label or product the brief does not state. Change no other value.';
    const textByPath = new Map(flatSlots(fill).map((slot) => [slot.path, slot.text]));
    const named = flaggedPaths.map((path) => {
      const text = textByPath.get(path);
      const hint = text === undefined ? '' : claimRepairHint(options.brief, text);
      return text === undefined ? path : `${path} ("${text}"${hint ? `; ${hint}` : ''})`;
    });
    const prompts = prompt({ answer: JSON.stringify(fill), error: `Flagged as unsupported by the brief: ${named.join('; ')}. ${rule}` });
    // A composed fill may have made a shorten or rewrite request, so `calls` so far is this call's
    // attempt index; a selected section keeps its original numbering.
    const response = await call(prompts, composed ? calls : maxRepairs + 1 + round);
    // A repair that is not taken keeps the previous fill, and the next round's check reports it
    // again; the reason is recorded so a failed build says why nothing was repaired (B-113).
    let parsed: AdapterFill;
    try {
      parsed = parseFill(adapter, response.text);
    } catch (error) {
      discarded.push({ round, reason: 'malformed', detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!composed) {
      const errors = validateAdapterFill(adapter, parsed);
      if (errors.length > 0) {
        discarded.push({ round, reason: 'invalid', detail: errors.map((e) => `${e.slot}: ${e.reason}`).join('; ') });
        continue;
      }
      fill = parsed;
      continue;
    }
    const repaired = takeFlaggedRepairs(fill, parsed, flaggedPaths);
    if (repaired.rejected.length > 0) discarded.push({ round, reason: repaired.taken === 0 && repaired.malformed ? 'malformed' : 'invalid', detail: repaired.rejected.join('; ') });
    if (repaired.taken > 0) {
      fill = repaired.fill;
      if (repaired.clips.length > 0) clipped = [...new Set([...(clipped ?? []), ...repaired.clips])];
    }
  }
  // Every accepted fill was checked by the loop above; a fill changed after its last check would
  // be a bug, never something to publish.
  if (composed && nameCutErrors(fill).length > 0) throw new SectionSelectionRefusedError('Section fill refused: the checked fill still cuts a word short');
  if (options.strict && (remaining.length > 0 || skippedThisRun !== undefined)) {
    const reason = remaining.length > 0
      ? `unsupported facts remain after repair: ${remaining.join(', ')}`
      : `the faithfulness check was skipped and never completed: ${skippedThisRun}`;
    throw new SectionSelectionRefusedError(`Section selection refused: ${reason}`);
  }
  return { fill, calls, usage, retries, flagged: flaggedEver, remaining, ...clippedNow(), ...(discarded.length > 0 ? { discarded } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Digest + FamilyPackage wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Covers the base recipe digest, the selection, the adapter version and the direction — the
 * artifact digest `sol-design.md` §2 requires. Deliberately does NOT cover `designReference` or
 * the filled section text.
 *
 * Precisely (NIT 6, delta audit): this means two builds with the SAME selection (same
 * entry/placement/direction/adapter version) but DIFFERENT filled section text share this exact
 * digest — a re-fill never changes it. That is intended, not an oversight: this digest identifies
 * WHICH section and direction were composed onto the page, not the exact bytes rendered for it.
 * `baseRecipeDigest` (this function's first argument, from the family's own render) is what plays
 * the byte-identity role for everything the overlay did NOT add; nothing gives the overlay's own
 * filled text that same role, by design, because a re-fill of an unchanged selection is not
 * treated as a new artifact.
 */
export function artifactDigest(baseRecipeDigest: string, selection: SectionSelection, adapterVersion: string): string {
  const canonical = JSON.stringify({ baseRecipeDigest, entryId: selection.entryId, placement: selection.placement, directionId: selection.directionId, adapterVersion });
  return createHash('sha256').update(canonical).digest('hex');
}

export type SectionOverlayMetadata = {
  entryId: string;
  adapterVersion: string;
  sourceBlockId: string;
  placement: SectionPlacement;
  directionId: string;
  sectionId: string;
};

/** Wraps `innerHtml` (already the adapter's own deterministic render) in a scoped section shell
 * carrying the direction's role tokens, focus styles and reduced-motion guard — never the whole
 * page's `:root`, so an inserted section can never restyle the rest of the family's fixed page. */
/** `sectionId` shapes `wrapFamilyPackageForOverlay` always produces (`od-selected-<adapter id,
 * non-alphanumerics collapsed to '-'>`). Enforced here, not just relied on at the derivation site
 * (NEW FIX, delta re-audit code packet #12): `wrapSectionForDirection` below interpolates
 * `sectionId` unescaped into an HTML `id`/`data-*` attribute value and a CSS attribute selector
 * (`[data-od-section="${sectionId}"]`); a future adapter id containing `"` or `]` would otherwise
 * break the selector or inject into it, with nothing catching that between the derivation and the
 * interpolation. */
const SECTION_ID_PATTERN = /^[a-z0-9-]+$/;

/** Exported so `tests/section-overlay.test.ts` can prove this guard actually fires — the normal
 * derivation (`wrapFamilyPackageForOverlay`'s own `sectionId` construction) always collapses
 * non-alphanumerics to `-` and so can never itself produce a value this rejects; a direct test
 * against an adversarial string is the only way to prove the guard, not just the derivation, is
 * what keeps this safe. */
export function assertSafeSectionId(sectionId: string): void {
  if (!SECTION_ID_PATTERN.test(sectionId)) {
    throw new SectionSelectionRefusedError(`Section id "${sectionId}" is not a safe HTML id / CSS-selector token (expected ${SECTION_ID_PATTERN})`);
  }
}

async function wrapSectionForDirection(adapter: SectionAdapter, direction: DesignDirection, sectionId: string, innerHtml: string): Promise<string> {
  assertSafeSectionId(sectionId);
  const modules = await loadOverlayModules();
  const selector = `[data-od-section="${sectionId}"]`;
  const css = `${modules.directionScopeCss(selector, direction)}${modules.directionBaseCss(selector)}${publicAdapterText(adapter.id, adapter.css, 'css')}`;
  return `<div id="${sectionId}" data-od-section="${sectionId}" data-od-selected-section="${publicSectionEntryId(adapter.id)}" data-od-selected-direction="${direction.id}"><style>${css}</style>${publicAdapterText(adapter.id, innerHtml)}</div>`;
}

/**
 * The render half of the overlay modules, for `block-compose.ts`: the validating adapter renderer
 * and the direction's scoped tokens and base rules. The same functions the overlay itself uses,
 * so a composed page and an overlaid section can never disagree on escaping or tokens.
 */
export async function overlayRenderKit(): Promise<Pick<OverlayModules, 'renderSectionAdapter' | 'directionScopeCss' | 'directionBaseCss'>> {
  const modules = await loadOverlayModules();
  return { renderSectionAdapter: modules.renderSectionAdapter, directionScopeCss: modules.directionScopeCss, directionBaseCss: modules.directionBaseCss };
}

/** The seven role values for one direction — exported for the direction contrast test
 * (`tests/contrast-directions.test.ts`) so it exercises the exact function the overlay uses. */
export async function roleTokensFor(direction: DesignDirection): Promise<Readonly<Record<SemanticRole, string>>> {
  return (await loadOverlayModules()).roleTokensFor(direction);
}

/**
 * Wraps a `FamilyPackage` so every `render` call additionally splices the (already-filled and
 * verified) section at a freshly re-checked anchor and rewrites the manifest's digest. The real
 * family validator runs completely unchanged on the untouched recipe — this wrapper never adds a
 * field to the JSON `pkg.render` receives.
 *
 * Takes `adapter` already resolved by the caller (FIX 5, delta audit) rather than re-resolving it
 * here from `selection.entryId`: `run.ts` resolves the adapter once, uses that exact object for
 * `fillSectionAdapter`, and passes the SAME object here, so the digest this function computes
 * (`artifactDigest(..., adapter.version)`) can never cover a different `version` than the one the
 * fill/verify pass actually ran against. A second, independent `resolveSectionAdapter` call here
 * was harmless while the v1 catalog is a static in-process array (every resolution returns the
 * same cached object), but would silently risk exactly that divergence once the catalog stops
 * being static (`packages/section-catalog`, worktree A) — removed rather than left to rely on
 * today's implementation detail.
 */
export async function wrapFamilyPackageForOverlay(pkg: FamilyPackage, selection: SectionSelection, direction: DesignDirection, adapter: SectionAdapter, fill: AdapterFill): Promise<FamilyPackage> {
  const modules = await loadOverlayModules();
  const publicId = publicSectionEntryId(adapter.id);
  const sectionId = `od-selected-${publicId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}`;
  const fixtureSectionIds = fixtureSectionIdsOf(pkg);
  const sectionHtml = modules.renderSectionAdapter(adapter, fill).replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1\s*>/gi, '<h2$1>$2</h2>');
  const sectionMarkup = await wrapSectionForDirection(adapter, direction, sectionId, sectionHtml);
  // Idempotent per section id: a page that already carries this section (a compiler that ran
  // `compose` without reporting `composed`, or a second `compose` call) is returned unchanged.
  const marker = `data-od-section="${sectionId}"`;
  const splice = (html: string): string => {
    if (html.includes(marker)) return html;
    const masked = maskNonAnchorSpans(html);
    const present = (id: string) => matchElementOpens(masked, id, 0, masked.length).length === 1;
    const sections = Array.isArray(pkg.fixture.sections) ? pkg.fixture.sections.filter(isObject) : [];
    // Adapter destinations are author-owned. Bind their generic contact fragment to a real
    // family section; keep a family's existing literal #contact when it already defines one.
    const contact = present('contact') ? 'contact' : [
      ...sections.filter(section => /contact|join|booking|inquiry|cta/i.test(String(section.type))),
      ...sections.filter(section => section.type === 'footer'),
    ].map(section => section.id).find((id): id is string => typeof id === 'string' && present(id));
    const markup = contact ? sectionMarkup.replace(/href=(['"])#contact\1/g, `href="#${encodeURIComponent(contact)}"`) : sectionMarkup;
    return spliceSectionHtml(html, resolveAnchorOffsetSync(html, fixtureSectionIds, selection.placement, modules), markup);
  };
  const wrap = (result: RenderResult): RenderResult => {
    // The compiler composed it already (before its effect plan) unless it predates `compose`, or
    // is a hand-built test package: then the splice happens here, on the returned page.
    const { composed, ...rest } = result;
    const html = composed ? rest.html : splice(rest.html);
    result = rest;
    const baseDigest = result.manifest.metadata.agencySite.recipeDigest;
    // Over the internal entry id, so the same section digests the same whichever id named it.
    const digest = artifactDigest(baseDigest, { ...selection, entryId: internalSectionEntryId(selection.entryId) }, adapter.version);
    const manifest = {
      ...result.manifest,
      metadata: {
        ...result.manifest.metadata,
        agencySite: {
          ...result.manifest.metadata.agencySite,
          recipeDigest: digest,
          sectionOverlay: { entryId: publicId, adapterVersion: adapter.version, sourceBlockId: publicSectionEntryId(adapter.sourceBlockId), placement: selection.placement, directionId: direction.id, sectionId } satisfies SectionOverlayMetadata,
        },
      },
    } as RenderResult['manifest'];
    return { ...result, html, manifest };
  };
  // The section splices in through the compiler's `compose`, BEFORE the effect plan applies, so
  // the compiler budgets effects against the composed page; `renderWithEffects` (`effects.ts`)
  // then holds the zero-effect limit on the result.
  return { ...pkg, render: (input, entry, options) => wrap(pkg.render(input, entry, { ...options, compose: splice })) };
}
