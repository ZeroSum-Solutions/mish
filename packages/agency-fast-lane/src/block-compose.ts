/**
 * The composed page: a `BlockPlan` (`block-plan.ts`) filled, verified, rendered and published as
 * one page (Sol ruling 2026-09-25, cult-port-sol.md §2, task 6).
 *
 * Every rule a selected section already follows holds here, because every block goes through the
 * same code: `fillSectionAdapter` (one small structured call per block, plain-text slots, Jev fact
 * check against the brief only, faithfulness repairs), the adapter's own validating renderer
 * (escaped text, links fixed at author time, no model URL, approved assets only — a composed page
 * supplies none), and the family CSP (`default-src 'none'`, inline style only, no script).
 *
 * The page adds only fixed chrome: a header with the business name (one more small fill unit,
 * `chrome`, checked like any block) and one fixed nav label per section kind, and a single
 * `<style>` that carries the direction's tokens once and each adapter's scoped CSS once. Each block
 * sits in a wrapper that names it: `data-od-selected-section="<adapter id>"`, in plan order.
 *
 * Publication is strict only (Sol review 2026-09-25, finding 2): nothing is saved until every unit
 * has passed the Jev faithfulness check against the brief, and then the finished page is saved once
 * (the project is created through `ensurePublisher`). A composed page has no progressive paints and
 * no deferred `after` check, so every page it ever saves is the finished page, under the byte
 * budget. `buildSite` refuses `composition: 'blocks' | 'auto'` with any other verify mode
 * (`CompositionVerifyError`), and the daemon route and the CLI reject the combination up front.
 *
 * The finished page must stay under `COMPOSED_PAGE_BYTE_LIMIT`: body blocks are dropped from the
 * end (never the hero, the closing cta band or the footer, and never the last body block) until it
 * fits, and a page that still does not fit fails the build. What was published is ONE plan — the
 * blocks the page actually carries — and that plan is what the recipe, the manifest, the report's
 * `composition.blocks` and the saved fork seed all hold, so a fork replays the published page.
 *
 * Effects: no composed page declares effect placements, so the composition result always reports
 * effects `off` with the fixed reason `no-placements`.
 */

import type { BlockSupportReceipt } from './block-support.ts';
import type { BuildDesignKit } from './kit-direction.ts';
import { checkRenderQuality, RenderQualityError } from './render-quality.ts';
import { createHash } from 'node:crypto';
import { addUsage, type ModelCall, type Usage } from './deepseek.ts';
import type { ArtifactManifest } from './family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from './jev.ts';
import type { ProjectPublisher } from './publish.ts';
import type { FastLaneMode, RunEvent, RunReport, UnitReport, VerifySkipReason } from './run.ts';
import { DEFAULT_MAX_REPAIRS, PublishRollbackError, withAdapterDeterministicGates } from './run.ts';
import {
  fillSectionAdapter,
  overlayRenderKit,
  resolveDesignDirection,
  resolveSectionAdapter,
  type AdapterFill,
  type DesignDirection,
  type SectionAdapter,
} from './section-overlay.ts';
import type { BlockPlan, CompositionFallback, CompositionMode } from './block-plan.ts';
import { COMPOSED_FAMILY } from './block-plan.ts';
import type { Json } from './spine.ts';
import { publicAdapterText, publicSectionEntryId } from './cult-public-ids.ts';

/** Strictly below this many UTF-8 bytes, the finished page (the family compiler's page limit). */
export const COMPOSED_PAGE_BYTE_LIMIT = 200 * 1024;

/** The family CSP, verbatim: nothing on a composed page needs more than inline style. */
export const COMPOSED_PAGE_CSP = "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

const RENDERER_VERSION = 'composed-page-1';

/** What `RunReport.composition` and the `composition` build event carry. Ids and codes only. */
export type CompositionResult = {
  requested: CompositionMode;
  used: 'blocks' | 'family';
  /** `used: 'blocks'`: the chosen spine, direction and blocks, in page order. */
  spine?: string;
  directionId?: string;
  blocks?: string[];
  /** Who chose the plan: Jev, or a replay of a saved build's plan (a fork or a repair). */
  source?: 'jev' | 'replay';
  /** Attempted picker + support Jev calls and elapsed planning time, separate from fill calls. */
  planner?: { calls: number; ms: number };
  /** Planner additions and fail-open reasons, before any render-budget drops. */
  supportGate?: BlockSupportReceipt;
  /** `used: 'family'` after `blocks`/`auto` was asked for: why the family route ran instead. */
  fallback?: CompositionFallback;
  /** Blocks the page budget dropped, from the end. The published page does not carry them. */
  budgetDropped?: string[];
  /** Composed pages declare no effect placements. */
  effects?: { mode: 'off'; reason: 'no-placements' };
  /** The design kit a person picked for this build, and whether the page actually wears it: a
   * composed page takes the kit's direction (`applied: true`); the family route has no direction
   * to replace, so a build that ends there reports `applied: false`. Absent when no kit was picked. */
  designKit?: { id: string; title: string; applied: boolean };
};

/** The recipe a composed build publishes and a repair re-fills from. Plain text only. */
export type ComposedRecipe = {
  kind: 'composed-page';
  version: 1;
  plan: BlockPlan;
  chrome: AdapterFill;
  blocks: AdapterFill[];
};

/**
 * A composed recipe as it is published: block ids are public (`cult:<slug>`,
 * `cult-public-ids.ts`), which `resolveSectionAdapter` accepts back. The in-memory recipe keeps the
 * internal ids the block catalog checks a replay against.
 */
export function publicRecipe(recipe: ComposedRecipe): ComposedRecipe {
  return { ...recipe, plan: { ...recipe.plan, blocks: recipe.plan.blocks.map(publicSectionEntryId) } };
}

export function isComposedRecipe(value: unknown): value is ComposedRecipe {
  const recipe = value as Partial<ComposedRecipe> | null | undefined;
  return !!recipe && recipe.kind === 'composed-page' && recipe.version === 1 && !!recipe.plan && Array.isArray(recipe.blocks) && typeof recipe.chrome === 'object';
}

/** The fixed code a page at or over `COMPOSED_PAGE_BYTE_LIMIT` fails with once no body block may go. */
export class ComposedPageTooLargeError extends Error {
  readonly code = 'page-too-large';
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`page-too-large: the composed page is ${bytes} bytes with one body block left, at or over the ${limit}-byte page limit`);
    this.name = 'ComposedPageTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** The header unit: the business name and a one-line description, both checked against the brief. */
export const CHROME_ADAPTER: SectionAdapter = {
  id: 'od:page-chrome',
  version: '1.0.0',
  sourceBlockId: 'page header (the business name exactly as the brief gives it, and one sentence on what it offers)',
  sourceSha256: '',
  roles: [],
  text: [{ name: 'brand', max: 60 }, { name: 'tagline', max: 150 }],
  css: '',
  render: () => '',
};

/** One fixed nav label per section kind; a kind without one is not linked. */
const NAV_LABELS: Record<string, string> = {
  features: 'Features', 'bento-grid': 'Features', integrations: 'Integrations', specifications: 'Details',
  'plan-comparison': 'Plans', 'timeline-roadmap': 'Roadmap', team: 'Team', testimonials: 'Customers',
  'reviews-ratings': 'Reviews', 'blog-articles': 'Updates', pricing: 'Pricing', faq: 'FAQ', 'cta-band': 'Contact',
};


/**
 * The one block whose wrapper carries `id="contact"`: converted Cult blocks and HyperUI ctas/1
 * point every call-to-action and unresolved in-page link at `#contact`, so exactly one element on
 * the page must own that id. The CTA band's section when it rendered, otherwise the footer's,
 * otherwise the last rendered block — never none while any block rendered.
 */
export function contactIndex(kinds: readonly string[], fills: ReadonlyArray<unknown>): number {
  const rendered = (index: number) => index >= 0 && fills[index] !== undefined;
  const cta = kinds.indexOf('cta-band');
  if (rendered(cta)) return cta;
  const footer = kinds.lastIndexOf('footer');
  if (rendered(footer)) return footer;
  for (let index = fills.length - 1; index >= 0; index -= 1) if (rendered(index)) return index;
  return -1;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const PAGE_CSS = '*,*::before,*::after{box-sizing:border-box}'
  + 'body.od-composed{margin:0;background:var(--role-background);color:var(--role-foreground);font-family:var(--role-font-body);line-height:1.5}'
  + '.od-composed-nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;max-width:80rem;margin-inline:auto;padding:1.25rem 1.5rem;border-bottom:1px solid var(--role-border)}'
  + '.od-composed-brand{font-family:var(--role-font-display);font-weight:600;font-size:1.125rem;color:var(--role-foreground);text-decoration:none}'
  + '.od-composed-nav nav{display:flex;flex-wrap:wrap;gap:1.25rem}'
  + '.od-composed-nav nav a{color:var(--role-muted);text-decoration:none;font-size:.9375rem}'
  + '.od-composed-nav nav a:hover{color:var(--role-foreground)}'
  + '.od-composed-foot{max-width:80rem;margin-inline:auto;padding:2rem 1.5rem;color:var(--role-muted);font-size:.875rem;border-top:1px solid var(--role-border)}';

export type RenderComposedInput = {
  plan: BlockPlan;
  direction: DesignDirection;
  adapters: readonly SectionAdapter[];
  /** One per plan block, in order; `undefined` for a block not filled yet (a progressive paint). */
  fills: ReadonlyArray<AdapterFill | undefined>;
  chrome?: AdapterFill;
  kinds: readonly string[];
  entry: string;
  revision: number;
  recipe: ComposedRecipe;
};

/** The modern bento block's static range slider, exactly as the vendored block draws it. */
const BENTO_MODERN_ID = 'cult:bento-modern';
const BENTO_SLIDER = '<input class="cm c1s cx c1t c1u" max="100" min="1" type="range" value="20" disabled>';

/**
 * The modern bento block draws a disabled range slider as decoration, with no label, so every
 * composed page carrying it failed the form-labels check (R4, 2026-10-10: 0 of 5 SaaS builds). That
 * one slider is taken out of the accessibility tree; no other block or control is touched (Sol
 * review of #286: a generic rewrite matched attribute text and hid enabled inputs). If the vendored
 * markup changes, this throws, so a block update cannot silently drop the fix.
 */
export function markDecorativeBentoSlider(publicId: string, html: string): string {
  if (publicId !== BENTO_MODERN_ID) return html;
  if (!html.includes(BENTO_SLIDER)) throw new Error(`${BENTO_MODERN_ID}: its decorative slider markup changed; update markDecorativeBentoSlider`);
  return html.replace(BENTO_SLIDER, BENTO_SLIDER.replace(' disabled>', ' disabled aria-hidden="true" tabindex="-1">'));
}


/**
 * Pure apart from the cached overlay modules: renders the page for whatever is filled so far.
 * Returns the html, the manifest and the ids actually rendered, in order.
 */
export async function renderComposedPage(input: RenderComposedInput): Promise<{ html: string; manifest: ArtifactManifest; rendered: string[] }> {
  const kit = await overlayRenderKit();
  const scope = 'body.od-composed';
  const brand = typeof input.chrome?.text?.brand === 'string' ? input.chrome.text.brand : '';
  const tagline = typeof input.chrome?.text?.tagline === 'string' ? input.chrome.text.tagline : '';
  const cssSeen = new Set<string>();
  const css: string[] = [PAGE_CSS, kit.directionScopeCss(scope, input.direction), kit.directionBaseCss(scope)];
  const sections: string[] = [];
  const nav: string[] = [];
  const rendered: string[] = [];
  const contactAt = contactIndex(input.kinds, input.fills);
  input.adapters.forEach((adapter, index) => {
    const fill = input.fills[index];
    if (!fill) return;
    const sectionId = `od-block-${index + 1}`;
    const domId = index === contactAt ? 'contact' : sectionId;
    if (!cssSeen.has(adapter.id)) {
      cssSeen.add(adapter.id);
      css.push(publicAdapterText(adapter.id, adapter.css, 'css'));
    }
    let sectionHtml = markDecorativeBentoSlider(publicSectionEntryId(adapter.id), publicAdapterText(adapter.id, kit.renderSectionAdapter(adapter, fill)));
    // A reusable section owns h2; the opening hero owns the composed page's h1. Preserve
    // its existing copy, classes and edit slots when promoting its heading at the page boundary.
    const isPageHero = input.kinds[index] === 'hero' && !input.kinds.slice(0, index).includes('hero');
    if (isPageHero && !/<h1\b/i.test(sectionHtml)) {
      sectionHtml = sectionHtml.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2\s*>/i, '<h1$1>$2</h1>');
    } else if (!isPageHero) {
      sectionHtml = sectionHtml.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1\s*>/gi, '<h2$1>$2</h2>');
    }
    sections.push(`<div id="${domId}" data-od-section="${sectionId}" data-od-selected-section="${escapeHtml(publicSectionEntryId(adapter.id))}">${sectionHtml}</div>`);
    rendered.push(adapter.id);
    const label = NAV_LABELS[input.kinds[index] ?? ''];
    if (label && !nav.some((link) => link.includes(`>${label}<`))) nav.push(`<a href="#${domId}">${label}</a>`);
  });
  const hasFooter = input.kinds[input.kinds.length - 1] === 'footer' && input.fills[input.fills.length - 1] !== undefined;
  const html = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="${COMPOSED_PAGE_CSP}">`
    + (tagline ? `<meta name="description" content="${escapeHtml(tagline)}">` : '')
    + `<title>${escapeHtml(brand)}</title><style>${css.join('')}</style></head>`
    + `<body class="od-composed" data-od-composition="blocks" data-od-spine="${escapeHtml(input.plan.spine)}" data-od-direction="${escapeHtml(input.direction.id)}">`
    + `<header class="od-composed-nav" id="top"><a class="od-composed-brand" href="#top" data-od-id="chrome--brand">${escapeHtml(brand)}</a>`
    + (nav.length > 0 ? `<nav aria-label="Sections">${nav.join('')}</nav>` : '')
    + '</header>'
    + `<main id="main-content">${sections.join('')}</main>`
    + (hasFooter || !brand ? '' : `<footer class="od-composed-foot"><p data-od-id="chrome--footer">${escapeHtml(brand)}</p></footer>`)
    + '</body></html>\n';
  // Defense in depth: every adapter is checked script-free at generation time; a composed page
  // that somehow carries a script or an inline handler is refused rather than published.
  // The handler pattern looks inside tags only: escaped text such as "one = two" is not markup.
  if (/<script\b/i.test(html) || /<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) throw new Error('composed page refused: it carries a script or an inline handler');
  const recipeDigest = createHash('sha256')
    // Over the recipe as it is saved (public block ids), so the digest covers the published file.
    .update(JSON.stringify({ recipe: publicRecipe(input.recipe), adapters: input.adapters.map((adapter) => [publicSectionEntryId(adapter.id), adapter.version]), direction: input.direction.id, renderer: RENDERER_VERSION }))
    .digest('hex');
  const manifest = {
    version: 1,
    kind: 'html',
    renderer: 'html',
    title: brand || 'Composed page',
    entry: input.entry,
    status: 'complete',
    exports: ['html', 'pdf', 'zip'],
    sourceSkillId: 'agency-site',
    supportingFiles: [],
    metadata: {
      agencySite: {
        version: 1,
        publication: 'closed-assets-v1',
        recipeDigest,
        rendererVersion: RENDERER_VERSION,
        revision: String(input.revision),
        family: COMPOSED_FAMILY,
        outputScope: 'site',
        composition: { spine: input.plan.spine, directionId: input.direction.id, blocks: rendered.map(publicSectionEntryId) },
      },
    },
  } as unknown as ArtifactManifest;
  return { html, manifest, rendered };
}

/** Kinds `renderWithinBudget` never drops: the page's opening and its closing. */
const KEPT_KINDS = new Set(['hero', 'cta-band', 'footer']);

/**
 * Renders the page under the byte budget: while the page is at or over `limit`, the last rendered
 * body block is dropped — never the hero, the cta band or the footer, and never the last body
 * block, so what is left is still a valid plan (a hero, a body block, the closing blocks). Returns
 * the ids dropped (in drop order); throws `ComposedPageTooLargeError` when nothing more may go and
 * the page still does not fit.
 */
export async function renderWithinBudget(input: RenderComposedInput, limit = COMPOSED_PAGE_BYTE_LIMIT): Promise<{ html: string; manifest: ArtifactManifest; rendered: string[]; dropped: string[] }> {
  const fills = [...input.fills];
  const dropped: string[] = [];
  const droppable = (index: number) => fills[index] !== undefined && !KEPT_KINDS.has(input.kinds[index] ?? '');
  for (;;) {
    const page = await renderComposedPage({ ...input, fills });
    const bytes = Buffer.byteLength(page.html, 'utf8');
    if (bytes < limit) return { ...page, dropped };
    const body = fills.map((_, index) => index).filter(droppable);
    if (body.length <= 1) throw new ComposedPageTooLargeError(bytes, limit);
    const last = body[body.length - 1]!;
    dropped.push(input.adapters[last]!.id);
    fills[last] = undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/** A composed page publishes only after a passing strict Jev check; any other mode is refused. */
export class CompositionVerifyError extends Error {
  readonly code = 'composition-needs-strict';
  constructor(mode: string) {
    super(`composition-needs-strict: a composed page publishes only after a passing strict Jev check, so verify must be 'strict' (got '${mode}')`);
    this.name = 'CompositionVerifyError';
  }
}

export type ComposeOptions = {
  plan: BlockPlan;
  /** Who chose the plan, for the composition result. */
  planSource: 'jev' | 'replay';
  planner?: { calls: number; ms: number };
  supportGate?: BlockSupportReceipt;
  requested: CompositionMode;
  brief: string;
  mode: FastLaneMode;
  entry: string;
  revision: number;
  model: ModelCall;
  modelName: string;
  activeModelName?: () => string;
  /** Section kinds of the plan's blocks, in order (from the planner's catalog). */
  kinds: readonly string[];
  /** The Jev faithfulness checker. Required: a composed page is never published unchecked. */
  verify: FaithfulnessChecker;
  /** Must be `true` (`CompositionVerifyError` otherwise): see the module note. */
  strict: boolean;
  ensurePublisher?: () => Promise<{ publisher: ProjectPublisher; created: boolean }>;
  onEvent?: (event: RunEvent) => void;
  onCall?: (call: { label: string; attempt: number; prompt: string; answer: string }) => void;
  maxRepairs?: number;
  maxFaithfulnessRounds?: number;
  signal?: AbortSignal;
  now?: () => number;
  pageByteLimit?: number;
  /** The picked design kit (`kit-direction.ts`). Its direction replaces the plan's built-in one;
   * the plan itself keeps the planner's direction id, so a fork replays the same plan. */
  designKit?: BuildDesignKit;
};

type UnitSpec = { label: string; prefix: string; adapter: SectionAdapter; index: number | 'chrome' };

/** At most this many remaining slots, each cut to this many characters, are kept on the report. */
const REMAINING_TEXTS_MAX = 20;
const REMAINING_TEXT_CHARS = 200;

/** The published text of each still-flagged slot, capped, so a failed build says what was flagged (B-113). */
function remainingTextsOf(slots: readonly FaithfulnessSlot[], remaining: readonly string[]): Array<{ path: string; text: string }> {
  const textByPath = new Map(slots.map((slot) => [slot.path, slot.text]));
  return remaining.slice(0, REMAINING_TEXTS_MAX).flatMap((path) => {
    const text = textByPath.get(path);
    return text === undefined ? [] : [{ path, text: text.length > REMAINING_TEXT_CHARS ? `${text.slice(0, REMAINING_TEXT_CHARS)}…` : text }];
  });
}

function slotsOf(fill: AdapterFill, prefix: string): FaithfulnessSlot[] {
  const out: FaithfulnessSlot[] = [];
  for (const [name, value] of Object.entries(fill.text ?? {})) if (typeof value === 'string' && value.trim()) out.push({ path: `${prefix}.text.${name}`, text: value });
  for (const [group, rows] of Object.entries(fill.items ?? {})) {
    rows.forEach((row, index) => {
      for (const [field, value] of Object.entries(row)) if (typeof value === 'string' && value.trim()) out.push({ path: `${prefix}.items.${group}[${index}].${field}`, text: value });
    });
  }
  return out;
}

function nullsOf(fill: AdapterFill, prefix: string): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(fill.text ?? {})) if (value === null) out.push(`${prefix}.text.${name}`);
  for (const [group, rows] of Object.entries(fill.items ?? {})) {
    rows.forEach((row, index) => {
      for (const [field, value] of Object.entries(row)) if (value === null) out.push(`${prefix}.items.${group}[${index}].${field}`);
    });
  }
  return out;
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

async function settleAll(running: Array<Promise<unknown>>): Promise<void> {
  let failure: { error: unknown } | undefined;
  await Promise.all(running.map((promise) => promise.catch((error: unknown) => { failure ??= { error }; })));
  if (failure) throw failure.error;
}

/** `blocks[<old index>]…` paths renumbered to the published plan's indexes; a dropped block's paths go. */
function renumber(paths: readonly string[], published: ReadonlyMap<number, number>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const match = /^blocks\[(\d+)\](.*)$/u.exec(path);
    if (!match) { out.push(path); continue; }
    const to = published.get(Number(match[1]));
    if (to !== undefined) out.push(`blocks[${to}]${match[2]}`);
  }
  return out;
}

/**
 * Fills, verifies, renders and publishes one composed page. Returns a `RunReport` so every caller
 * of `buildSite` (the daemon, the CLI) reads a composed build exactly like a family build; a build
 * that does not pass returns `strict.passed: false` with nothing published, as `runFastLane` does.
 */
export async function composeBlocks(options: ComposeOptions): Promise<RunReport> {
  if (options.strict !== true || !options.verify) throw new CompositionVerifyError(options.strict ? 'no checker' : 'not strict');
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const since = () => Math.round(now() - startedAt);
  const emit = options.onEvent ?? (() => {});
  const { plan } = options;

  const [direction, adapters] = await Promise.all([
    options.designKit ? options.designKit.direction : resolveDesignDirection(plan.directionId),
    Promise.all(plan.blocks.map((id) => resolveSectionAdapter(id))),
  ]);
  const units: UnitSpec[] = [
    { label: 'chrome', prefix: 'chrome', adapter: CHROME_ADAPTER, index: 'chrome' },
    // A unit's label reaches the build's events: a Cult block is named by its public id.
    ...adapters.map((adapter, index): UnitSpec => ({ label: publicSectionEntryId(adapter.id), prefix: `blocks[${index}]`, adapter, index })),
  ];

  // Folds a checker's failures into a skipped result (a cancellation still unwinds), and records
  // why, so the page never publishes on a check that did not complete.
  let skipReason: VerifySkipReason | undefined;
  let skipMessage: string | undefined;
  // A round-9 audit pass found this checker wraps `options.verify` RAW — Jev's own judgment only,
  // none of `run.ts`'s deterministic claim/commercial-word gates (`makeCheckOnce`) — even though a
  // composed page's blocks go through the exact same `fillSectionAdapter` call a section-overlay
  // fill does. `withAdapterDeterministicGates` (`run.ts`) is the same wrapper that call uses; see
  // its own docblock for what it adds and why nothing else needs to change (this page publishes
  // strictly already — see this file's module doc — so `fillSectionAdapter`'s own strict/repair
  // loop fails closed on whatever this wrapper adds, exactly as it does for a flag Jev raised
  // itself).
  const gated = withAdapterDeterministicGates(options.verify, COMPOSED_FAMILY, options.signal);
  const tracked: FaithfulnessChecker = {
    checkFaithfulness: async (input) => {
      try {
        const result = await gated.checkFaithfulness(input);
        if (result.skipped !== undefined) {
          skipReason ??= 'jev-unavailable';
          skipMessage ??= result.skipped;
        }
        return result;
      } catch (error) {
        if (isCancellation(error, options.signal)) throw error;
        skipReason ??= 'jev-refused';
        skipMessage ??= error instanceof Error ? error.message : String(error);
        return { flagged: [], ms: 0, calls: 0, skipped: skipMessage };
      }
    },
  };

  const fills: Array<AdapterFill | undefined> = adapters.map(() => undefined);
  let chrome: AdapterFill | undefined;
  const flagged: string[] = [];
  const remaining: string[] = [];
  const truncated: string[] = [];
  const unitReports: UnitReport[] = [];
  const usage: Usage = { input: 0, output: 0, cachedRead: 0 };
  let calls = 0;
  let retries = 0;
  let repairs = 0;

  await settleAll(units.map(async (unit) => {
    const unitStarted = now();
    const result = await fillSectionAdapter({
      adapter: unit.adapter,
      brief: options.brief,
      model: options.model,
      verify: tracked,
      strict: false,
      // The composed fill policy: budgets in the prompt, name-cut repair, and a wordy block cut to
      // whole words rather than failing the whole page (`truncated`).
      composed: true,
      // The family build's own default when the caller names none (see `DEFAULT_MAX_REPAIRS`).
      maxRepairs: options.maxRepairs ?? DEFAULT_MAX_REPAIRS,
      ...(options.maxFaithfulnessRounds !== undefined ? { maxFaithfulnessRounds: options.maxFaithfulnessRounds } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onCall ? { onCall: (call) => options.onCall!({ ...call, label: unit.label }) } : {}),
    });
    calls += result.calls;
    retries += result.retries;
    addUsage(usage, result.usage);
    const unitRepairs = Math.max(0, result.calls - 1);
    repairs += unitRepairs;
    for (const path of result.flagged) flagged.push(`${unit.prefix}.${path}`);
    for (const path of result.remaining) remaining.push(`${unit.prefix}.${path}`);
    for (const dropped of result.discarded ?? []) emit({ type: 'repair-discarded', label: unit.label, round: dropped.round, reason: dropped.reason, detail: dropped.detail });
    if (result.clipped && result.clipped.length > 0) {
      const paths = result.clipped.map((path) => `${unit.prefix}.${path}`);
      truncated.push(...paths);
      emit({ type: 'clipped', label: unit.label, paths });
    }
    if (unit.index === 'chrome') chrome = result.fill; else fills[unit.index] = result.fill;
    const ms = Math.round(now() - unitStarted);
    unitReports.push({ label: unit.label, ms, repairs: unitRepairs });
    emit({ type: 'unit', label: unit.label, ms: since(), repairs: unitRepairs });
  }));
  options.signal?.throwIfAborted();

  // The finished page under the byte budget. The blocks it carries are the published plan.
  const budgeted = await renderWithinBudget({
    plan, direction, adapters, fills, ...(chrome ? { chrome } : {}), kinds: options.kinds, entry: options.entry, revision: options.revision,
    recipe: { kind: 'composed-page', version: 1, plan, chrome: chrome ?? { text: {} }, blocks: [] },
  }, options.pageByteLimit ?? COMPOSED_PAGE_BYTE_LIMIT);
  const kept = fills.map((fill, index) => index).filter((index) => fills[index] !== undefined && !budgeted.dropped.includes(adapters[index]!.id));
  const published = new Map(kept.map((from, to) => [from, to]));
  const publishedPlan: BlockPlan = { spine: plan.spine, directionId: plan.directionId, blocks: kept.map((index) => adapters[index]!.id) };
  const publishedFills = kept.map((index) => fills[index]!);
  const recipe: ComposedRecipe = { kind: 'composed-page', version: 1, plan: publishedPlan, chrome: chrome ?? { text: {} }, blocks: publishedFills };
  // Rendered again from the published plan alone, so the manifest's digest covers the recipe that
  // is saved and replayed — never one that still names a dropped block.
  const final = await renderComposedPage({
    plan: publishedPlan, direction, adapters: kept.map((index) => adapters[index]!), fills: publishedFills, ...(chrome ? { chrome } : {}),
    kinds: kept.map((index) => options.kinds[index]!), entry: options.entry, revision: options.revision, recipe,
  });
  if (Buffer.byteLength(final.html, 'utf8') >= (options.pageByteLimit ?? COMPOSED_PAGE_BYTE_LIMIT)) {
    throw new ComposedPageTooLargeError(Buffer.byteLength(final.html, 'utf8'), options.pageByteLimit ?? COMPOSED_PAGE_BYTE_LIMIT);
  }

  const renderQuality = checkRenderQuality(final.html);
  emit({ type: 'render-quality', report: renderQuality });
  if (!renderQuality.passed) throw new RenderQualityError(renderQuality);

  const publishedSlots = [chrome ? slotsOf(chrome, 'chrome') : [], ...publishedFills.map((fill, index) => slotsOf(fill, `blocks[${index}]`))].flat();
  const flaggedSet = renumber([...new Set(flagged)], published);
  const remainingSet = renumber([...new Set(remaining)], published);
  // Every unit was checked while it filled; the counts are the published page's.
  const verify: NonNullable<RunReport['verify']> = {
    provider: 'jev',
    checked: publishedSlots.length,
    illustrative: 0,
    flagged: flaggedSet,
    repaired: flaggedSet.filter((path) => !remainingSet.includes(path)).length,
    remaining: remainingSet,
    ms: since(),
    ...(skipMessage !== undefined ? { skipped: skipMessage } : {}),
    ...(remainingSet.length > 0 ? { remainingTexts: remainingTextsOf(publishedSlots, remainingSet) } : {}),
  };
  emit({ type: 'verify', checked: verify.checked, illustrative: 0, flagged: flaggedSet.length, repaired: verify.repaired, remaining: remainingSet.length, ms: verify.ms, flaggedPaths: flaggedSet, remainingPaths: remainingSet, ...(skipReason !== undefined ? { skipped: skipReason } : {}) });

  let registeredPublisher: ProjectPublisher | undefined;
  let registeredMs: number | undefined;
  let paints = 0;
  let firstPaintMs: number | undefined;
  let finalPaintMs: number | undefined;
  options.signal?.throwIfAborted();
  const passed = verify.skipped === undefined && verify.remaining.length === 0;
  const strict: NonNullable<RunReport['strict']> = passed
    ? { passed: true, checked: verify.checked }
    : { passed: false, reason: verify.skipped !== undefined ? `verify was skipped: ${verify.skipped}` : `unresolved: ${verify.remaining.join(', ')}` };
  const made = passed ? await options.ensurePublisher?.() : undefined;
  if (made) {
    registeredPublisher = made.publisher;
    try {
      await made.publisher.savePage(options.entry, final.html, final.manifest as unknown as Json, 'registered');
      paints = 1;
      firstPaintMs = since();
      finalPaintMs = firstPaintMs;
      emit({ type: 'paint', count: paints, ms: finalPaintMs, label: 'registered' });
      const stateDir = `agency-site-state/r${options.revision}`;
      const brand = typeof chrome?.text?.brand === 'string' ? chrome.text.brand : 'Composed page';
      const note = [
        `# ${brand} — Agency Site state (registered r${options.revision})`,
        '',
        `Composed from ${publishedPlan.blocks.length} reviewed blocks by the fast lane (${options.modelName}) on ${new Date().toISOString()}.`,
        '',
        `- Entry: \`${options.entry}\``,
        `- Spine: ${publishedPlan.spine}; direction: ${publishedPlan.directionId}`,
        `- Blocks, in order: ${publishedPlan.blocks.map(publicSectionEntryId).join(', ')}`,
        ...(budgeted.dropped.length > 0 ? [`- Dropped to fit the page budget: ${budgeted.dropped.map(publicSectionEntryId).join(', ')}`] : []),
        `- Recipe: \`${stateDir}/recipe.json\``,
        '',
        'Every business fact in this build comes from the brief given to the fast lane. Review before client use.',
        '',
      ].join('\n');
      await settleAll([
        made.publisher.saveFile(`${stateDir}/recipe.json`, `${JSON.stringify(publicRecipe(recipe), null, 2)}\n`),
        made.publisher.saveFile('AGENCY-SITE-STATE.md', note),
      ]);
      registeredMs = since();
      emit({ type: 'registered', ms: registeredMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!made.created) throw new Error(`strict publish failed on project ${made.publisher.projectId}; it may hold a partial file set: ${message}`);
      let deleteError: unknown;
      try {
        await made.publisher.deleteProject();
      } catch (err) {
        deleteError = err;
      }
      if (deleteError === undefined) throw new Error(`strict publish failed after creating project ${made.publisher.projectId}; the new project was removed: ${message}`);
      const deleteMessage = deleteError instanceof Error ? deleteError.message : String(deleteError);
      throw new PublishRollbackError(made.publisher.projectId, `strict publish failed after creating project ${made.publisher.projectId}, and removing it also failed (${deleteMessage}): ${message}`);
    }
  }

  const nulled = [chrome ? nullsOf(chrome, 'chrome') : [], ...publishedFills.map((fill, index) => nullsOf(fill, `blocks[${index}]`))].flat();
  const composition: CompositionResult = {
    requested: options.requested,
    used: 'blocks',
    spine: publishedPlan.spine,
    directionId: publishedPlan.directionId,
    blocks: [...publishedPlan.blocks],
    source: options.planSource,
    ...(options.planner ? { planner: options.planner } : {}),
    ...(options.supportGate ? { supportGate: { ...options.supportGate,
      added: options.supportGate.added.map((row) => ({ ...row, id: publicSectionEntryId(row.id) })),
      removed: options.supportGate.removed.map((row) => ({ ...row, id: publicSectionEntryId(row.id) })),
    } } : {}),
    ...(budgeted.dropped.length > 0 ? { budgetDropped: budgeted.dropped } : {}),
    effects: { mode: 'off', reason: 'no-placements' },
    ...(options.designKit ? { designKit: { id: options.designKit.id, title: options.designKit.title, applied: true } } : {}),
  };
  return {
    family: COMPOSED_FAMILY,
    mode: options.mode,
    model: options.activeModelName?.() ?? options.modelName,
    entry: options.entry,
    revision: options.revision,
    ...(registeredPublisher && registeredMs !== undefined ? { projectId: registeredPublisher.projectId } : {}),
    timings: { firstPaintMs, finalPaintMs, registeredMs, totalMs: since() },
    calls,
    repairs,
    retries,
    paints,
    usage,
    applied: publishedSlots.length,
    missing: [],
    nulled,
    truncated: renumber(truncated, published),
    units: unitReports,
    recipeDigest: final.manifest.metadata.agencySite.recipeDigest,
    recipe: recipe as unknown as Json,
    html: final.html,
    manifest: final.manifest,
    approvedAssets: [],
    renderQuality,
    verify,
    strict,
    composition,
  };
}
