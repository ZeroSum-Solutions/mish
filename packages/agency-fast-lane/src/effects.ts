/**
 * Effect placement: reviewed GenUI catalog components (`packages/genui-catalog`) on a family's
 * named placements, chosen once per build BEFORE the fill (Sol ruling 2026-09-25,
 * catalog-port/sol-wiring-ruling.md).
 *
 * The fast lane only CHOOSES component ids. The family compiler (`renderFamily` in the shared
 * agency compiler, `effects.ts` beside it) owns every byte of HTML an effect adds: the host
 * attributes, the inlined style and script, the CSP hash, and the page byte budget. This module
 * never writes markup.
 *
 * A family offers placements in its own `families/<family>/catalog.json` (`effects.placements`),
 * each with one exact host and a reviewed allowlist. The decision, per build:
 *
 * - Explicit hints (the request's `effects` record, the CLI's `--effect`) win and are never sent
 *   to Jev. An id the family does not allow at that placement is skipped as `not-allowed`.
 * - Every other declared placement is `auto`: ONE Jev request asks one `choice` question per
 *   placement, criteria = each allowed component (name, one-line description, kind) plus `none`.
 *   A pick counts only when the answer is a valid `choice` among the offered ids and its
 *   confidence is at least 0.75. Any Jev failure (no key, timeout, network, non-2xx, unreadable or
 *   malformed answer) yields ZERO automatic effects and a fixed `EffectsJevSkip` code — never a
 *   guess, and never a change to the build's independent faithfulness result.
 * - Guards: at most two effects per page, at most one `js` or background effect, the family's own
 *   `maxEffects`; a quiet or institutional skin takes at most one text or surface effect, a
 *   cinematic or experimental skin up to two, any other, unspecified or low-confidence skin one.
 *
 * Nothing here reaches a report, an event, an error or a log except component ids, placement ids,
 * counts and fixed codes: no Jev answer text, criteria prose or prompt text.
 */

import type { FamilyPackage, RenderResult } from './family.ts';
import { postSystemOne, resolveJevKey } from './jev.ts';
import { SKIN_DESCRIPTIONS, validateChoiceAnswer } from './route.ts';
import { sectionSkipReasonForStatus } from './sections.ts';
import { isObject, type Json, type JsonObject } from './spine.ts';

/** The fixed placement vocabulary (`AgencyEffectPlacementId` in `packages/contracts`). */
export type EffectPlacementId =
  | 'hero-background' | 'hero-title' | 'eyebrow' | 'section-title' | 'card-surface' | 'nav'
  | 'section-reveal' | 'testimonials' | 'gallery' | 'cta';

export const EFFECT_PLACEMENT_IDS: readonly EffectPlacementId[] = [
  'hero-background', 'hero-title', 'eyebrow', 'section-title', 'card-surface', 'nav',
  'section-reveal', 'testimonials', 'gallery', 'cta',
];

/**
 * Lowest priority first: the order the compiler (and the composed-page budget below) drops
 * effects in to keep a page under `PAGE_BYTE_LIMIT`. `hero-title` goes last.
 */
export const EFFECT_DROP_ORDER: readonly EffectPlacementId[] = [
  'section-reveal', 'card-surface', 'section-title', 'eyebrow', 'cta', 'gallery', 'testimonials', 'nav', 'hero-background', 'hero-title',
];

/** Strictly below this many UTF-8 bytes, the final page (`PAGE_BYTE_LIMIT` in the compiler). */
export const PAGE_BYTE_LIMIT = 200 * 1024;

export const DEFAULT_EFFECT_THRESHOLD = 0.75;
/** A routed skin below this confidence counts as unknown (the route's own default threshold). */
export const SKIN_CONFIDENCE_FLOOR = 0.5;
/** Hard per-page cap, whatever the family or skin allows. */
export const MAX_EFFECTS_PER_PAGE = 2;

/** `hint` = named in the request; `jev` = chosen by Jev; `repair` = replayed from a saved build
 * (a repair, or recipe reconciliation). Provenance only: no guard or policy here reads it. */
export type EffectSource = 'hint' | 'jev' | 'repair';

/** The fixed code a page at or over `PAGE_BYTE_LIMIT` fails a build with. */
export const PAGE_TOO_LARGE = 'page-too-large';

/**
 * The final composed page is at or over `PAGE_BYTE_LIMIT` UTF-8 bytes with no effect left on it
 * (no plan, or the compiler dropped every effect and the page still does not fit). The build
 * fails with this rather than publishing the page. Carries only the byte counts and the code.
 * The compiler's `PageByteLimitError` carries the same code; `renderWithEffects` maps it to this.
 */
export class PageTooLargeError extends Error {
  readonly code = PAGE_TOO_LARGE;
  readonly bytes: number;
  readonly limit = PAGE_BYTE_LIMIT;
  constructor(bytes: number) {
    super(`${PAGE_TOO_LARGE}: the page is ${bytes} bytes, at or over the ${PAGE_BYTE_LIMIT}-byte page limit`);
    this.name = 'PageTooLargeError';
    this.bytes = bytes;
  }
}
export type EffectKind = 'css-only' | 'js';

/** The validated plan the compiler applies (`EffectPlan` in the shared compiler's `effects.ts`). */
export type EffectPlan = { effects: Array<{ placement: EffectPlacementId; componentId: string; source: EffectSource }> };

/** Why a placement got no effect (`AgencyEffectSkipReason`). Fixed codes; never free text. */
export type EffectSkipReason =
  | 'none' | 'below-threshold' | 'not-allowed' | 'script-policy' | 'byte-budget' | 'max-effects'
  | 'host-missing' | 'host-occupied' | 'incompatible';

/** Why no automatic effect was chosen at all (`AgencyEffectsJevSkip`). */
export type EffectsJevSkip =
  | 'jev-key-missing' | 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized'
  | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer';

export type EffectApplied = { placement: EffectPlacementId; componentId: string; kind: EffectKind; source: EffectSource };
export type EffectSkipped = { placement: EffectPlacementId; componentId?: string; reason: EffectSkipReason };

/** What the compiler's `renderFamily` reports when it applied a plan. */
export type EffectRenderReport = { applied: EffectApplied[]; skipped: EffectSkipped[]; bytesAdded: number };

/** `AgencyEffectsInput`: `auto`, `off`, or a component id (or `none`) per placement id. */
export type EffectsInput = 'auto' | 'off' | Readonly<Record<string, string>>;

/** `AgencyEffectsResult`: what a build's effect plan did, on `RunReport.effects`. */
export type EffectsResult = {
  mode: 'auto' | 'off' | 'explicit' | 'mixed';
  applied: EffectApplied[];
  skipped: EffectSkipped[];
  jevSkipped?: EffectsJevSkip;
  bytesAdded: number;
};

export type EffectHost = { id: string } | { odId: string };

/** A family's declaration (`families/<family>/catalog.json` → `effects`), as the compiler's
 * `readFamilyEffectDeclaration` validates and returns it. */
export type FamilyEffectDeclaration = {
  scriptPolicy: 'none' | 'hash' | 'inline';
  maxEffects: number;
  placements: Partial<Record<EffectPlacementId, { host: EffectHost; allow: string[] }>>;
};

/**
 * The slice of the GenUI catalog manifest this module reads. The daemon passes
 * `genuiCatalog.manifest` from `@open-design/genui-catalog/data` (bundle-safe literals); the CLI,
 * which runs from source, passes `loadEffectCatalogFromSource()`. Structural, so this package
 * takes no dependency on the catalog package.
 */
export type EffectCatalogEntry = {
  id: string;
  name: string;
  category?: string;
  kind?: EffectKind;
  status?: string;
  source?: { description?: string };
  bytes?: { js: number; css: number };
};
export type EffectCatalog = { components: readonly EffectCatalogEntry[] };

/** `AgencyFamilyEffectsResponse`, for `GET /api/agency/families/:family/effects`. */
export type FamilyEffectsResponse = {
  family: string;
  scriptPolicy: 'none' | 'hash' | 'inline';
  maxEffects: number;
  placements: Array<{
    placement: EffectPlacementId;
    host: string;
    allow: Array<{ id: string; name: string; kind: EffectKind; bytes: { js: number; css: number } }>;
  }>;
};

const isPlacementId = (value: string): value is EffectPlacementId => (EFFECT_PLACEMENT_IDS as readonly string[]).includes(value);

const catalogEntry = (catalog: EffectCatalog | undefined, id: string) => catalog?.components.find((entry) => entry.id === id);

/** A component's kind from the catalog. Unknown is treated as `js`: the stricter of the two. */
export function effectKindOf(catalog: EffectCatalog | undefined, id: string): EffectKind {
  return catalogEntry(catalog, id)?.kind === 'css-only' ? 'css-only' : 'js';
}

/** The placements a declaration offers, in vocabulary order. */
export function declaredPlacements(declaration: FamilyEffectDeclaration | null | undefined): EffectPlacementId[] {
  if (!declaration) return [];
  return EFFECT_PLACEMENT_IDS.filter((placement) => declaration.placements[placement] !== undefined);
}

/** The ids a placement may take: its allowlist, minus `js` components on a `none` script policy. */
export function allowedAt(declaration: FamilyEffectDeclaration, placement: EffectPlacementId, catalog: EffectCatalog | undefined): string[] {
  const allow = declaration.placements[placement]?.allow ?? [];
  return declaration.scriptPolicy === 'none' ? allow.filter((id) => effectKindOf(catalog, id) === 'css-only') : [...allow];
}

// ---------------------------------------------------------------------------------------------
// The Jev request
// ---------------------------------------------------------------------------------------------

type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };

/** Question key for a placement: Jev keys are identifiers, placement ids are kebab-case. */
export const effectQuestionKey = (placement: EffectPlacementId) => `effect_${placement.replace(/-/g, '_')}`;

const PLACEMENT_LABELS: Record<EffectPlacementId, string> = {
  'hero-background': 'hero background',
  'hero-title': 'hero headline',
  eyebrow: 'eyebrow label',
  'section-title': 'section heading',
  'card-surface': 'card surfaces',
  nav: 'navigation bar',
  'section-reveal': 'section entrances',
  testimonials: 'testimonials block',
  gallery: 'gallery',
  cta: 'call to action',
};

/** One line per component: its name, the catalog's own description (without its prop list), kind. */
export function componentCriterion(entry: EffectCatalogEntry | undefined, id: string): string {
  const name = entry?.name ?? id;
  const description = (entry?.source?.description ?? '').replace(/\s*Props:.*$/s, '').trim();
  const kind = entry?.kind === 'css-only' ? 'CSS only' : 'script';
  return `${name}${description ? `: ${description}` : ''} (${kind}).`;
}

const NONE_CRITERION = 'No effect here: the brief gives no reason for ornament at this spot, or an effect would distract from the content or clash with the tone.';

/**
 * The one fan-out request: the brief (and the skin, when known) as `state`, one `choice` question
 * per declared placement — or per placement in `only`, when given (hinted placements are never
 * asked). Criteria are each allowed component id plus `none`. A placement with nothing it may
 * take (every allowed id is `js` on a `none` script policy, or absent from the catalog) is not
 * asked. `asked` lists the placements and the options each question offered.
 */
export function buildEffectQuestions(
  brief: string,
  skin: string | undefined,
  declaration: FamilyEffectDeclaration,
  catalog: EffectCatalog | undefined,
  only?: readonly EffectPlacementId[],
): { state: { brief: string; skin: string }; questions: Record<string, ChoiceQuestion>; asked: Array<{ placement: EffectPlacementId; key: string; options: string[] }> } {
  const questions: Record<string, ChoiceQuestion> = {};
  const asked: Array<{ placement: EffectPlacementId; key: string; options: string[] }> = [];
  const placements = declaredPlacements(declaration).filter((placement) => only === undefined || only.includes(placement));
  for (const placement of placements) {
    // Auto offers only components the catalog describes: an undescribed id cannot be judged.
    const ids = allowedAt(declaration, placement, catalog).filter((id) => id !== 'none' && (catalog === undefined || catalogEntry(catalog, id) !== undefined));
    if (ids.length === 0) continue;
    const criteria: Record<string, string> = {};
    for (const id of ids) criteria[id] = componentCriterion(catalogEntry(catalog, id), id);
    criteria.none = NONE_CRITERION;
    const key = effectQuestionKey(placement);
    questions[key] = {
      type: 'choice',
      instructions: `Which reviewed visual effect, if any, suits the ${PLACEMENT_LABELS[placement]} of this client's page, given \`brief\` and the visual \`skin\`? Choose none unless the brief's tone clearly supports it.`,
      criteria,
    };
    asked.push({ placement, key, options: [...ids, 'none'] });
  }
  const skinText = skin && skin !== 'unspecified' ? `${skin}: ${SKIN_DESCRIPTIONS[skin] ?? ''}`.trim() : 'unspecified';
  return { state: { brief, skin: skinText }, questions, asked };
}

export type EffectPick = { placement: EffectPlacementId; componentId: string; confidence: number };

/**
 * Pure: Jev's answers into picks. Accepts only a `choice` answer whose choice is one of the
 * offered options, with finite confidence and probabilities in [0, 1]. `none` → skipped `none`;
 * below `threshold` → skipped `below-threshold`. ANY malformed or missing answer rejects the whole
 * set (`jev-bad-answer`): no pick from a request that did not answer as asked.
 */
export function resolveEffectChoices(
  answers: unknown,
  asked: ReadonlyArray<{ placement: EffectPlacementId; key: string; options: readonly string[] }>,
  options: { threshold?: number } = {},
): { picks: EffectPick[]; skipped: EffectSkipped[] } | { jevSkipped: 'jev-bad-answer' } {
  const threshold = options.threshold ?? DEFAULT_EFFECT_THRESHOLD;
  if (!isObject(answers as Json)) return { jevSkipped: 'jev-bad-answer' };
  const table = answers as JsonObject;
  const picks: EffectPick[] = [];
  const skipped: EffectSkipped[] = [];
  for (const question of asked) {
    const checked = validateChoiceAnswer(table[question.key], new Set(question.options));
    if ('reason' in checked) return { jevSkipped: 'jev-bad-answer' };
    const { choice, confidence } = checked.answer;
    if (choice === 'none') skipped.push({ placement: question.placement, reason: 'none' });
    else if (confidence < threshold) skipped.push({ placement: question.placement, componentId: choice, reason: 'below-threshold' });
    else picks.push({ placement: question.placement, componentId: choice, confidence });
  }
  return { picks, skipped };
}

export type EffectJudgement = { picks: EffectPick[]; skipped: EffectSkipped[]; jevSkipped?: EffectsJevSkip; ms: number; calls: number };

export type EffectJudge = {
  judge: (input: { brief: string; skin?: string; declaration: FamilyEffectDeclaration; catalog?: EffectCatalog; placements: readonly EffectPlacementId[] }) => Promise<EffectJudgement>;
};

export type JevEffectJudgeOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  threshold?: number;
  endpoint?: string;
  /** Cancels the request; rethrown, never folded into `jevSkipped`. */
  signal?: AbortSignal;
};

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The Jev effect judge: one `postSystemOne` request per build. Never throws for Jev's own
 * failures — each becomes a fixed `EffectsJevSkip` code with zero picks. Only the caller's own
 * cancellation is rethrown.
 */
export function createJevEffectJudge(options: JevEffectJudgeOptions): EffectJudge {
  const key = resolveJevKey(options.apiKey);
  const threshold = options.threshold ?? DEFAULT_EFFECT_THRESHOLD;
  return {
    judge: async ({ brief, skin, declaration, catalog, placements }) => {
      const started = performance.now();
      const ms = () => Math.round(performance.now() - started);
      const nothing = (jevSkipped: EffectsJevSkip, calls: number): EffectJudgement => ({ picks: [], skipped: [], jevSkipped, ms: ms(), calls });
      const { state, questions, asked } = buildEffectQuestions(brief, skin, declaration, catalog, placements);
      if (asked.length === 0) return { picks: [], skipped: [], ms: 0, calls: 0 };
      let resolvedKey: string;
      try {
        resolvedKey = await key();
        if (typeof resolvedKey !== 'string' || resolvedKey.length === 0) return nothing('jev-key-missing', 0);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return nothing('jev-key-missing', 0);
      }
      let response: Awaited<ReturnType<typeof postSystemOne>>;
      try {
        response = await postSystemOne({
          endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
          model: options.model ?? DEFAULT_MODEL,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchImpl: options.fetchImpl ?? fetch,
          key: async () => resolvedKey,
          state,
          questions,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return nothing(timedOut ? 'jev-timeout' : 'jev-unreachable', 0);
      }
      if (!response.ok) {
        const code = sectionSkipReasonForStatus(response.status);
        return nothing(code, 1);
      }
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        return nothing('jev-bad-answer', 1);
      }
      const answers = isObject(body as Json) ? (body as JsonObject).answers : undefined;
      const resolved = resolveEffectChoices(answers, asked, { threshold });
      if ('jevSkipped' in resolved) return nothing(resolved.jevSkipped, 1);
      return { ...resolved, ms: ms(), calls: 1 };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

const QUIET_SKINS = new Set(['Minimal and quiet', 'Corporate and institutional', 'Technical and utilitarian', 'Data-dense', 'Luxury']);
const EXPRESSIVE_SKINS = new Set(['Cinematic and immersive', 'Experimental']);

export type SkinSignal = { choice: string; confidence?: number };

/**
 * The skin's cap on AUTOMATIC effects: quiet and institutional skins one text or surface effect;
 * cinematic and experimental skins two; every other, unspecified or low-confidence skin one.
 */
export function skinEffectCap(skin: SkinSignal | undefined): { max: number; textOrSurfaceOnly: boolean } {
  if (!skin || skin.choice === 'unspecified' || (skin.confidence !== undefined && skin.confidence < SKIN_CONFIDENCE_FLOOR)) return { max: 1, textOrSurfaceOnly: false };
  if (QUIET_SKINS.has(skin.choice)) return { max: 1, textOrSurfaceOnly: true };
  if (EXPRESSIVE_SKINS.has(skin.choice)) return { max: 2, textOrSurfaceOnly: false };
  return { max: 1, textOrSurfaceOnly: false };
}

const dropRank = (placement: EffectPlacementId) => EFFECT_DROP_ORDER.indexOf(placement);
/** Highest priority first (`hero-title` first). */
const byPriority = <T extends { placement: EffectPlacementId }>(items: readonly T[]) => [...items].sort((a, b) => dropRank(b.placement) - dropRank(a.placement));

export type EffectDecision = { plan: EffectPlan; result: EffectsResult; ms: number };

/**
 * `mode` from what was requested and what applied: `off` stays `off`; a request that named
 * effects is `explicit` unless Jev also applied one (`mixed`), or only Jev did (`auto`).
 */
export function effectsMode(requested: 'auto' | 'off' | 'explicit', applied: readonly { source: EffectSource }[]): EffectsResult['mode'] {
  if (requested === 'off') return 'off';
  if (requested === 'auto') return 'auto';
  const jev = applied.some((item) => item.source === 'jev');
  // `repair` replays ids a request once named, so it counts as `hint` for the mode.
  const hint = applied.some((item) => item.source === 'hint' || item.source === 'repair');
  if (jev && hint) return 'mixed';
  return jev ? 'auto' : 'explicit';
}

/**
 * The whole decision for one build. Hints first (never asked), then one Jev request for every
 * other declared placement, then the guards. A family with no declaration, or `off`, plans
 * nothing. `result.applied` lists what the PLAN carries (kinds from the catalog); the compiler's
 * render report is merged in afterwards (`mergeEffectsResult`).
 */
export async function decideEffects(input: {
  input: EffectsInput;
  declaration: FamilyEffectDeclaration | null | undefined;
  catalog?: EffectCatalog;
  skin?: SkinSignal;
  brief: string;
  judge?: EffectJudge;
  /** The source the record's ids are reported with: `repair` when they replay a saved build. */
  hintSource?: 'hint' | 'repair';
}): Promise<EffectDecision> {
  const { declaration, catalog } = input;
  const requested: 'auto' | 'off' | 'explicit' = input.input === 'off' ? 'off' : input.input === 'auto' ? 'auto' : 'explicit';
  const hints: Readonly<Record<string, string>> = typeof input.input === 'object' ? input.input : {};
  const skipped: EffectSkipped[] = [];
  const empty = (mode: EffectsResult['mode']): EffectDecision => ({ plan: { effects: [] }, result: { mode, applied: [], skipped, bytesAdded: 0 }, ms: 0 });
  if (requested === 'off') return empty('off');

  // Hints, re-checked against the family (the daemon already refused unknown ids; a CLI or a
  // `family: 'auto'` build could not).
  const hinted = new Set<string>();
  const hintCandidates: EffectApplied[] = [];
  for (const [placement, id] of Object.entries(hints)) {
    hinted.add(placement);
    if (!isPlacementId(placement) || !declaration || declaration.placements[placement] === undefined) {
      if (isPlacementId(placement)) skipped.push({ placement, ...(id !== 'none' ? { componentId: id } : {}), reason: id === 'none' ? 'none' : 'not-allowed' });
      continue;
    }
    if (id === 'none') {
      skipped.push({ placement, reason: 'none' });
    } else if (!(declaration.placements[placement]?.allow ?? []).includes(id)) {
      skipped.push({ placement, componentId: id, reason: 'not-allowed' });
    } else if (declaration.scriptPolicy === 'none' && effectKindOf(catalog, id) === 'js') {
      skipped.push({ placement, componentId: id, reason: 'script-policy' });
    } else {
      hintCandidates.push({ placement, componentId: id, kind: effectKindOf(catalog, id), source: input.hintSource ?? 'hint' });
    }
  }
  if (!declaration) return empty(effectsMode(requested, []));

  const pageCap = Math.max(0, Math.min(MAX_EFFECTS_PER_PAGE, declaration.maxEffects));
  const planned: EffectApplied[] = [];
  const isHeavy = (item: EffectApplied) => item.kind === 'js' || item.placement === 'hero-background' || catalogEntry(catalog, item.componentId)?.category === 'background';
  const heavyCount = () => planned.filter(isHeavy).length;
  const admit = (item: EffectApplied, cap: number): boolean => {
    if (planned.length >= cap || (isHeavy(item) && heavyCount() >= 1)) {
      skipped.push({ placement: item.placement, componentId: item.componentId, reason: 'max-effects' });
      return false;
    }
    planned.push(item);
    return true;
  };
  for (const item of byPriority(hintCandidates)) admit(item, pageCap);

  // Auto: every declared placement no hint named, only while the skin's cap leaves room.
  let jevSkipped: EffectsJevSkip | undefined;
  let ms = 0;
  const skinCap = skinEffectCap(input.skin);
  const autoCap = Math.min(pageCap, skinCap.max);
  const toAsk = declaredPlacements(declaration).filter((placement) => !hinted.has(placement));
  if (input.judge && toAsk.length > 0 && planned.length < autoCap) {
    const verdict = await input.judge.judge({ brief: input.brief, ...(input.skin ? { skin: input.skin.choice } : {}), declaration, ...(catalog ? { catalog } : {}), placements: toAsk });
    ms = verdict.ms;
    if (verdict.jevSkipped !== undefined) {
      jevSkipped = verdict.jevSkipped;
    } else {
      skipped.push(...verdict.skipped);
      const picks = [...verdict.picks].sort((a, b) => dropRank(b.placement) - dropRank(a.placement) || b.confidence - a.confidence);
      for (const pick of picks) {
        // The judge answers only from the offered options; re-checked so a fake or future judge
        // cannot widen the allowlist.
        if (!allowedAt(declaration, pick.placement, catalog).includes(pick.componentId)) {
          skipped.push({ placement: pick.placement, componentId: pick.componentId, reason: 'not-allowed' });
          continue;
        }
        const item: EffectApplied = { placement: pick.placement, componentId: pick.componentId, kind: effectKindOf(catalog, pick.componentId), source: 'jev' };
        const category = catalogEntry(catalog, pick.componentId)?.category;
        if (skinCap.textOrSurfaceOnly && category !== 'text' && category !== 'surface') {
          skipped.push({ placement: item.placement, componentId: item.componentId, reason: 'max-effects' });
          continue;
        }
        admit(item, autoCap);
      }
    }
  }

  const ordered = byPriority(planned);
  return {
    plan: { effects: ordered.map(({ placement, componentId, source }) => ({ placement, componentId, source })) },
    result: { mode: effectsMode(requested, ordered), applied: ordered, skipped, ...(jevSkipped !== undefined ? { jevSkipped } : {}), bytesAdded: 0 },
    ms,
  };
}

/**
 * The decision's result with the compiler's render report folded in: `applied` and `bytesAdded`
 * come from the render (what the page really carries), the render's skips are added to the
 * decision's, and a planned effect the render neither applied nor skipped — a compiler copy that
 * does not apply plans at all — is skipped as `incompatible`.
 *
 * `mode` is the DECISION's, never recomputed from what survived the render: a `mixed` decision
 * whose Jev effect the compiler dropped (byte budget, occupied host) stays `mixed`. `mode` says
 * how the plan was chosen; `applied` and `skipped` say what the page carries and why.
 */
export function mergeEffectsResult(decision: EffectsResult, plan: EffectPlan | undefined, render: EffectRenderReport | undefined): EffectsResult {
  const planned = plan?.effects ?? [];
  if (planned.length === 0) return { ...decision, applied: [], bytesAdded: 0 };
  const applied = render ? render.applied.map((item) => ({ ...item })) : [];
  const skipped = [...decision.skipped, ...(render ? render.skipped.map((item) => ({ ...item })) : [])];
  for (const item of planned) {
    const accounted = applied.some((a) => a.placement === item.placement) || skipped.some((s) => s.placement === item.placement && s.componentId === item.componentId);
    if (!accounted) skipped.push({ placement: item.placement, componentId: item.componentId, reason: 'incompatible' });
  }
  return {
    mode: decision.mode,
    applied,
    skipped,
    ...(decision.jevSkipped !== undefined ? { jevSkipped: decision.jevSkipped } : {}),
    bytesAdded: render?.bytesAdded ?? 0,
  };
}

/** A decision result for a caller that has a plan but no decision (a direct `runFastLane`); with
 * no decision to keep, `mode` is derived from the plan's sources here (see `mergeEffectsResult`). */
export function resultOfPlan(plan: EffectPlan): EffectsResult {
  return { mode: effectsMode(plan.effects.some((item) => item.source !== 'jev') ? 'explicit' : 'auto', plan.effects), applied: [], skipped: [], bytesAdded: 0 };
}

// ---------------------------------------------------------------------------------------------
// Rendering with a plan
// ---------------------------------------------------------------------------------------------

type PlanRender = (input: Json, entry: string, options?: { effects?: EffectPlan }) => RenderResult;

const isPageByteLimit = (error: unknown): error is { code: string; bytes: number } =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PAGE_TOO_LARGE && typeof (error as { bytes?: unknown }).bytes === 'number';

/** Throws `PageTooLargeError` unless `html` is strictly below `PAGE_BYTE_LIMIT` UTF-8 bytes. */
export function assertPageBudget(html: string): void {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes >= PAGE_BYTE_LIMIT) throw new PageTooLargeError(bytes);
}

/**
 * Renders with `plan` (when it carries any effect) and holds the page budget on the FINAL page.
 *
 * One enforcement point for effects: the compiler's `applyEffectPlan` sees the composed page (the
 * selected section's overlay splices in through `renderFamily`'s `compose`, before the plan
 * applies), drops effects lowest priority first to fit, and reports each as `byte-budget` — this
 * function only passes that report through. What is left to this function is the zero-effect
 * limit: a page at or over `PAGE_BYTE_LIMIT` with no plan, or one whose composed base the compiler
 * refused (its `PageByteLimitError`), fails with `PageTooLargeError` and is never published.
 *
 * `final: false` marks an intermediate render (the spine, a unit's merge): it may be over the
 * limit before the fill trims it, so it never throws for size. A plan the compiler refuses on an
 * oversized base renders without the plan instead. The caller holds the final page to the budget.
 */
export function renderWithEffects(render: PlanRender, input: Json, entry: string, plan: EffectPlan | undefined, options: { final?: boolean } = {}): RenderResult {
  const final = options.final ?? true;
  let result: RenderResult;
  try {
    result = plan && plan.effects.length > 0 ? render(input, entry, { effects: plan }) : render(input, entry);
  } catch (error) {
    if (!isPageByteLimit(error)) throw error;
    if (final) throw new PageTooLargeError(error.bytes);
    return render(input, entry);
  }
  if (final) assertPageBudget(result.html);
  return result;
}

// ---------------------------------------------------------------------------------------------
// The family's placements, for the daemon's picker endpoint
// ---------------------------------------------------------------------------------------------

/** `GET /api/agency/families/:family/effects`: what the family offers, labelled from the catalog. */
export function familyEffectsResponse(pkg: Pick<FamilyPackage, 'family' | 'effects'>, catalog: EffectCatalog | undefined): FamilyEffectsResponse {
  const declaration = pkg.effects;
  if (!declaration) return { family: pkg.family, scriptPolicy: 'none', maxEffects: 0, placements: [] };
  return {
    family: pkg.family,
    scriptPolicy: declaration.scriptPolicy,
    maxEffects: declaration.maxEffects,
    placements: declaredPlacements(declaration).map((placement) => {
      const host = declaration.placements[placement]!.host;
      return {
        placement,
        host: 'id' in host ? host.id : host.odId,
        allow: allowedAt(declaration, placement, catalog).map((id) => {
          const entry = catalogEntry(catalog, id);
          return { id, name: entry?.name ?? id, kind: effectKindOf(catalog, id), bytes: entry?.bytes ? { js: entry.bytes.js, css: entry.bytes.css } : { js: 0, css: 0 } };
        }),
      };
    }),
  };
}
