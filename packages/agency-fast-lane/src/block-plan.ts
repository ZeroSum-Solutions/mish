/**
 * Block composition planning: which reviewed blocks a composed page uses, in which order, under
 * which design direction (Sol ruling 2026-09-25, cult-port-sol.md §2, task 6).
 *
 * A build's `composition` is independent of the family recipe:
 *
 * - `family` (the default for every existing caller): the family route, unchanged.
 * - `blocks`: a Jev picker request chooses a spine, one design direction and one block per page role
 *   from a deterministic shortlist; `block-compose.ts` fills, verifies, renders and publishes them
 *   as one page. A picker failure falls back to the family route with a fixed reason code.
 * - `auto`: the family route's own spine decides. Blocks run only when that spine has reviewed
 *   blocks that cover the page (`autoCoverage`); otherwise the family route runs and the report
 *   records why (`compositionFallback`).
 *
 * The shortlist is built only from catalog metadata — never from the brief: the insertable
 * section-catalog rows whose adapter resolves in the registry (every checked Cult adapter plus the
 * three HyperUI adapters), each with its taxonomy `sectionKind`, `spineAffinities` and, for Cult
 * rows, the inventory's use cases, tags and style density. Jev sees brand-free titles and use
 * cases, never source code.
 *
 * Page rules the resolution enforces, whatever Jev answers:
 * - exactly one hero, first; one footer, last, when the spine has one;
 * - no `sectionKind` twice, except `features` (two feature roles);
 * - 3 to 7 blocks; an optional role counts only when Jev's probability that it is NOT `none` is
 *   at or above the threshold, and takes the most probable compatible block (`pickForRole`);
 * - a block is compatible with a spine when its affinities name the spine or are `any`. An
 *   `unclassified` block is never compatible: the catalog could not place it, so the planner does
 *   not guess.
 *
 * A post-picker support gate recovers missing section types at 0.8 by default; FAQ uses brief
 * signals deterministically. Gate failures keep the picker plan and report a fixed skip code.
 *
 * Nothing here reaches a report, an event, an error or a log except block ids, the spine code,
 * the direction id, probabilities, counts and fixed codes: no Jev answer text, criteria prose or brief.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { supportBlockPlan, withinBlockPlanDeadline, DEFAULT_SUPPORT_THRESHOLD, type BlockSupportReceipt } from './block-support.ts';
import { postSystemOne, resolveJevKey } from './jev.ts';
import { validateChoiceAnswer, type ChoiceAnswer } from './route.ts';
import { sectionSkipReasonForStatus } from './sections.ts';
import { listComposableAdapterIds, listDesignDirectionMoods } from './section-overlay.ts';
import { isObject, type Json, type JsonObject } from './spine.ts';

/** `AgencyBuildRequest.composition`. */
export type CompositionMode = 'family' | 'blocks' | 'auto';
export const COMPOSITION_MODES: readonly CompositionMode[] = ['family', 'blocks', 'auto'];

/** The family id a composed build reports: the page belongs to no family recipe. */
export const COMPOSED_FAMILY = 'composed';

export const MIN_BLOCKS = 3;
export const MAX_BLOCKS = 7;
/** A spine answer and every optional role pick need at least this confidence. */
export const DEFAULT_BLOCK_THRESHOLD = 0.5;
/** At most this many candidates per role, so one question stays small. */
export const MAX_CANDIDATES_PER_ROLE = 8;

/** The nine atlas spines, in atlas order, with the journey Jev chooses between. */
export const SPINES: ReadonlyArray<{ code: string; name: string; journey: string }> = [
  { code: 'TL', name: 'Trust to lead', journey: 'A service or studio earns trust so the visitor gets in touch.' },
  { code: 'PA', name: 'Product adoption', journey: 'A software product explains itself so the visitor signs up or starts a trial.' },
  { code: 'CO', name: 'Commerce', journey: 'A shop presents products so the visitor buys.' },
  { code: 'SM', name: 'Search and match', journey: 'A directory or marketplace helps the visitor find a listing.' },
  { code: 'CS', name: 'Content subscription', journey: 'A publication or documentation site earns a reader or subscriber.' },
  { code: 'LM', name: 'Learning and membership', journey: 'A course, club or community earns a member.' },
  { code: 'BA', name: 'Booking and attendance', journey: 'A venue, restaurant or event earns a booking.' },
  { code: 'TU', name: 'Task utility', journey: 'A signed-in tool helps the visitor finish a task.' },
  { code: 'MI', name: 'Mission impact', journey: 'A charity or cause earns a donation or volunteer.' },
];

/** One insertable block, as the planner reads it. Structural, so the daemon can build it from
 * its own bundled JSON imports and the CLI from source (`loadBlockCatalogFromSource`). */
export type BlockCatalogEntry = {
  id: string;
  /** Brand-free display title (the section catalog's). */
  title: string;
  sectionKind: string;
  spineAffinities: readonly string[] | 'any' | 'unclassified';
  useCases: readonly string[];
  tags: readonly string[];
  density?: string;
};
export type BlockCatalog = { blocks: readonly BlockCatalogEntry[] };

const HOURS_KIND_TOKENS: ReadonlySet<string> = new Set(['hours', 'visit', 'location']);
/** Whether any block of `plan` is an hours, visit or location section: one whole word of its catalog
 * kind, case folded ("hours-location" yes; "visitor" or "relocation" no). */
export function planShowsHours(catalog: BlockCatalog, plan: BlockPlan): boolean {
  return plan.blocks.some((id) => (catalog.blocks.find((entry) => entry.id === id)?.sectionKind ?? '')
    .toLowerCase().split(/[^a-z0-9]+/).some((token) => HOURS_KIND_TOKENS.has(token)));
}

/** The resolved plan a composed page is built from. Ids only; the order is the page order. */
export type BlockPlan = { spine: string; directionId: string; blocks: string[] };

/** Why a `blocks`/`auto` build took the family route instead (`AgencyCompositionFallback`). */
export type CompositionFallback =
  | 'jev-key-missing' | 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized' | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer'
  | 'no-spine' | 'spine-below-threshold' | 'no-coverage' | 'too-few-blocks' | 'planner-unavailable'
  /** `auto` with a named family: the caller chose the family route. */
  | 'family-named'
  /** `auto`, `family: 'auto'`: `resolveRoute` rejected the model's own `spine`/`family`/`skin`
   * answer as malformed (an id the registry does not list, an unparseable value, or any other
   * `resolveRoute` validation refusal) — the route's `spine` came from that same untrusted
   * answer, so `auto` does not compose from it even when it looks confident and covered. */
  | 'route-invalid'
  /** `auto`: the brief states opening hours and the route found a family, but no planned block
   * shows hours — the family's own page carries them, the composed one would drop them. */
  | 'hours-not-covered';

export const COMPOSITION_FALLBACKS: readonly CompositionFallback[] = [
  'jev-key-missing', 'jev-unreachable', 'jev-timeout', 'jev-unauthorized', 'jev-rate-limited', 'jev-http-error', 'jev-bad-answer',
  'no-spine', 'spine-below-threshold', 'no-coverage', 'too-few-blocks', 'planner-unavailable', 'family-named', 'route-invalid', 'hours-not-covered',
];

// ---------------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------------

type SectionCatalogLike = { entries: ReadonlyArray<{
  id: string; title: string; sourceKind: string; sectionKind: string; availability: string;
  spineAffinities: readonly string[] | 'any' | 'unclassified' | string;
  content?: { adapterId?: string };
}> };
type CultInventoryLike = { rows: ReadonlyArray<{
  id: string;
  original?: { useCases?: readonly string[]; tags?: readonly string[] };
  taxonomy?: { style?: { density?: string } };
}> };

/** Fixed notes for the three HyperUI blocks, which carry no use cases of their own. */
const HYPERUI_NOTES: Record<string, string[]> = {
  hero: ['General opening section: headline, one paragraph and two calls to action'],
  features: ['General grid of features or services'],
  'cta-band': ['General closing call to action band'],
};

/**
 * The planner's catalog from the section catalog (insertable rows only) and the Cult inventory
 * (use cases, tags, density), restricted to ids the adapter registry resolves. Pure.
 */
export function blockCatalogFrom(sectionCatalog: SectionCatalogLike, cultInventory: CultInventoryLike | undefined, adapterIds: readonly string[]): BlockCatalog {
  const resolvable = new Set(adapterIds);
  const cultRows = new Map((cultInventory?.rows ?? []).map((row) => [row.id, row]));
  const blocks: BlockCatalogEntry[] = [];
  for (const entry of sectionCatalog.entries) {
    if (entry.availability !== 'insertable') continue;
    if (entry.sourceKind !== 'hyperui' && entry.sourceKind !== 'cult-pro') continue;
    const adapterId = entry.content?.adapterId;
    if (adapterId !== entry.id || !resolvable.has(entry.id)) continue;
    const affinities = Array.isArray(entry.spineAffinities)
      ? [...entry.spineAffinities]
      : entry.spineAffinities === 'any' ? 'any' as const : 'unclassified' as const;
    const row = cultRows.get(entry.id);
    blocks.push({
      id: entry.id,
      title: entry.title,
      sectionKind: entry.sectionKind,
      spineAffinities: affinities,
      useCases: row?.original?.useCases ? [...row.original.useCases] : (HYPERUI_NOTES[entry.sectionKind] ?? []),
      tags: row?.original?.tags ? [...row.original.tags] : [],
      ...(row?.taxonomy?.style?.density ? { density: row.taxonomy.style.density } : {}),
    });
  }
  blocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { blocks };
}

const sectionCatalogFile = path.resolve(import.meta.dirname, '../../section-catalog/catalog.json');
const cultInventoryFile = path.resolve(import.meta.dirname, '../../cult-ui-catalog/catalog.json');

let sourceCatalog: Promise<BlockCatalog> | undefined;

/**
 * The catalog read from the workspace files, for the CLI and tests that run from source. The
 * daemon never calls this (a packaged daemon's `import.meta.dirname` is the prebundle's own
 * directory): it builds the same object with `blockCatalogFrom` from its bundled JSON imports.
 */
export function loadBlockCatalogFromSource(): Promise<BlockCatalog> {
  sourceCatalog ??= (async () => {
    const [section, cult, ids] = await Promise.all([
      readFile(sectionCatalogFile, 'utf8').then((text) => JSON.parse(text) as SectionCatalogLike),
      readFile(cultInventoryFile, 'utf8').then((text) => JSON.parse(text) as CultInventoryLike),
      // Composable ids only (G9 dry run): a block with a fixed third-party link name or more link
      // labels than a brief can honestly fill never reaches the plan (`composeRefusalFor`).
      listComposableAdapterIds(),
    ]);
    return blockCatalogFrom(section, cult, ids);
  })();
  return sourceCatalog;
}

// ---------------------------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------------------------

/** Body kinds in page order. A kind the list does not name sorts after these, by name. */
const BODY_KIND_ORDER = [
  'logo-wall', 'features', 'bento-grid', 'integrations', 'specifications', 'plan-comparison', 'stats',
  'timeline-roadmap', 'team', 'testimonials', 'reviews-ratings', 'blog-articles', 'pricing', 'faq',
];
const CLOSING_KINDS = new Set(['cta-band', 'footer']);
/** Kinds that are never a page body block: a whole page, or a kind the catalog could not place. */
const EXCLUDED_KINDS = new Set(['page-composition', 'unclassified', 'navigation']);

/** What a body kind needs from the brief before it may be picked, shown to Jev. */
const KIND_NEEDS: Record<string, string> = {
  pricing: 'Pick only when the brief states prices or plans.',
  testimonials: 'Pick only when the brief quotes customers or names clients.',
  'reviews-ratings': 'Pick only when the brief gives reviews or ratings.',
  team: 'Pick only when the brief names the people on the team.',
  'blog-articles': 'Pick only when the brief names articles, posts or updates.',
  'timeline-roadmap': 'Pick only when the brief gives milestones or a roadmap.',
  faq: 'Pick only when the brief answers questions a visitor would ask.',
  integrations: 'Pick only when the brief names tools or products it works with.',
  'logo-wall': 'Pick only when the brief names clients or partners.',
  specifications: 'Pick only when the brief gives specifications to compare.',
  'plan-comparison': 'Pick only when the brief compares plans.',
};

export type BlockRole = {
  /** Question key suffix and role id: `hero`, `features`, `features_2`, `faq`, `cta`, `footer`. */
  role: string;
  kind: string;
  /** A required role has no `none` option: `hero`, and `footer` when the spine has one. */
  required: boolean;
  /** Candidate ids, deterministic order: explicit spine affinity first, then `any`, then id. */
  candidates: string[];
};

/** Whether `entry` may appear on a page of `spine`. `unclassified` never; `any` always. */
export function compatibleWith(entry: BlockCatalogEntry, spine: string): boolean {
  if (entry.spineAffinities === 'any') return true;
  if (entry.spineAffinities === 'unclassified') return false;
  return entry.spineAffinities.includes(spine);
}

function explicitFor(entry: BlockCatalogEntry, spine: string): boolean {
  return Array.isArray(entry.spineAffinities) && entry.spineAffinities.includes(spine);
}

function kindRank(kind: string): [number, string] {
  const at = BODY_KIND_ORDER.indexOf(kind);
  return [at < 0 ? BODY_KIND_ORDER.length : at, kind];
}

/**
 * The deterministic shortlist for one spine: the page's roles in order, each with its candidate
 * ids. Same catalog and spine in, same roles out. Features take two roles (the one kind allowed
 * twice); every other body kind one.
 */
export function shortlistBlocks(catalog: BlockCatalog, spine: string): BlockRole[] {
  const byKind = new Map<string, BlockCatalogEntry[]>();
  for (const entry of catalog.blocks) {
    if (EXCLUDED_KINDS.has(entry.sectionKind) || !compatibleWith(entry, spine)) continue;
    const list = byKind.get(entry.sectionKind) ?? [];
    list.push(entry);
    byKind.set(entry.sectionKind, list);
  }
  const ordered = (kind: string) => [...(byKind.get(kind) ?? [])]
    .sort((a, b) => Number(explicitFor(b, spine)) - Number(explicitFor(a, spine)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_CANDIDATES_PER_ROLE)
    .map((entry) => entry.id);
  const roles: BlockRole[] = [];
  const hero = ordered('hero');
  if (hero.length > 0) roles.push({ role: 'hero', kind: 'hero', required: true, candidates: hero });
  const bodyKinds = [...byKind.keys()]
    .filter((kind) => kind !== 'hero' && !CLOSING_KINDS.has(kind))
    .sort((a, b) => {
      const [ra, na] = kindRank(a);
      const [rb, nb] = kindRank(b);
      return ra - rb || (na < nb ? -1 : na > nb ? 1 : 0);
    });
  for (const kind of bodyKinds) {
    const candidates = ordered(kind);
    const role = kind.replace(/[^a-z0-9]+/g, '_');
    roles.push({ role, kind, required: false, candidates });
    if (kind === 'features' && candidates.length > 1) roles.push({ role: `${role}_2`, kind, required: false, candidates });
  }
  const cta = ordered('cta-band');
  if (cta.length > 0) roles.push({ role: 'cta', kind: 'cta-band', required: false, candidates: cta });
  const footer = ordered('footer');
  if (footer.length > 0) roles.push({ role: 'footer', kind: 'footer', required: true, candidates: footer });
  return roles;
}

/** Whether `spine`'s shortlist has a footer: its page then ends with exactly one. */
export function spineTakesFooter(catalog: BlockCatalog, spine: string): boolean {
  return shortlistBlocks(catalog, spine).some((role) => role.kind === 'footer');
}

/** Whether roles can make a valid page: a hero, a body role, and a cta or footer. */
function rolesCoverPage(roles: readonly BlockRole[]): boolean {
  const hero = roles.some((role) => role.kind === 'hero');
  const body = roles.some((role) => role.kind !== 'hero' && !CLOSING_KINDS.has(role.kind));
  const closing = roles.some((role) => CLOSING_KINDS.has(role.kind));
  return hero && body && closing;
}

/** The spines a `blocks` build may choose: those whose shortlist can make a valid page. */
export function composableSpines(catalog: BlockCatalog): string[] {
  return SPINES.map((spine) => spine.code).filter((code) => rolesCoverPage(shortlistBlocks(catalog, code)));
}

/**
 * `auto`'s rule: at least three reviewed blocks that name `spine` explicitly (or, for the hero
 * role only, a spine-agnostic hero, since no reviewed Cult hero exists yet) cover a hero, one
 * body kind and a cta or footer. HyperUI's `any` body and closing blocks alone never qualify a
 * spine: they would turn every brief into a composed page and bypass the families built for it.
 */
export function autoCoverage(catalog: BlockCatalog, spine: string): boolean {
  const usable = catalog.blocks.filter((entry) => !EXCLUDED_KINDS.has(entry.sectionKind) && compatibleWith(entry, spine));
  const hero = usable.some((entry) => entry.sectionKind === 'hero');
  const explicit = usable.filter((entry) => explicitFor(entry, spine) && entry.sectionKind !== 'hero');
  const body = explicit.some((entry) => !CLOSING_KINDS.has(entry.sectionKind));
  const closing = explicit.some((entry) => CLOSING_KINDS.has(entry.sectionKind));
  return hero && body && closing;
}

// ---------------------------------------------------------------------------------------------
// The Jev request
// ---------------------------------------------------------------------------------------------

type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };

/** A criteria key for a block id: Jev keys stay plain identifiers. */
export const optionKey = (id: string) => id.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

function blockCriterion(entry: BlockCatalogEntry): string {
  const uses = entry.useCases.slice(0, 3).join('; ');
  return `${entry.title} (${entry.sectionKind})${uses ? `: ${uses}` : ''}${entry.density ? `. Density: ${entry.density}` : ''}.`;
}

const NONE_CRITERION = 'Leave this section out: the brief gives it nothing true to say.';

export type AskedRole = { role: string; key: string; kind: string; required: boolean; options: Map<string, string> };
export type AskedPlan = {
  spine?: { key: 'spine'; options: Map<string, string> };
  direction: { key: 'direction'; options: Map<string, string> };
  roles: AskedRole[];
};

/**
 * The one request: the brief as `state`, then `choice` questions for the spine (unless `spine`
 * is fixed, as in `auto`), the direction, and one per role over the union of the composable
 * spines' candidates (resolution drops a pick that is not compatible with the chosen spine).
 */
export function buildBlockPlanQuestions(
  brief: string,
  catalog: BlockCatalog,
  directions: ReadonlyArray<{ id: string; label: string; mood: string }>,
  options: { spine?: string } = {},
): { state: { brief: string }; questions: Record<string, ChoiceQuestion>; asked: AskedPlan } | undefined {
  const spines = options.spine !== undefined ? [options.spine] : composableSpines(catalog);
  if (spines.length === 0) return undefined;
  const questions: Record<string, ChoiceQuestion> = {};
  let spineAsked: AskedPlan['spine'];
  if (options.spine === undefined) {
    const criteria: Record<string, string> = {};
    const map = new Map<string, string>();
    for (const code of spines) {
      const spine = SPINES.find((candidate) => candidate.code === code)!;
      criteria[code] = `${spine.name}: ${spine.journey}`;
      map.set(code, code);
    }
    criteria.none = 'None of these journeys fits the brief.';
    map.set('none', 'none');
    questions.spine = { type: 'choice', instructions: 'Which visitor journey does this client\'s page serve, given `brief`?', criteria };
    spineAsked = { key: 'spine', options: map };
  }
  const directionCriteria: Record<string, string> = {};
  const directionMap = new Map<string, string>();
  for (const direction of directions) {
    const key = optionKey(direction.id);
    directionCriteria[key] = direction.mood.slice(0, 400);
    directionMap.set(key, direction.id);
  }
  questions.direction = { type: 'choice', instructions: 'Which visual direction suits this client\'s page, given `brief`? Judge the business and its audience, not the wording.', criteria: directionCriteria };

  // One role list over every candidate spine: the same role key across spines, candidates merged.
  const merged = new Map<string, BlockRole>();
  for (const code of spines) {
    for (const role of shortlistBlocks(catalog, code)) {
      const current = merged.get(role.role);
      if (!current) merged.set(role.role, { ...role, candidates: [...role.candidates] });
      else {
        for (const id of role.candidates) if (!current.candidates.includes(id)) current.candidates.push(id);
        // A footer is required only where every spine has one; otherwise `none` must stay possible.
        current.required = current.required && role.required;
      }
    }
  }
  const byId = new Map(catalog.blocks.map((entry) => [entry.id, entry]));
  const roles: AskedRole[] = [];
  const allRoles = [...merged.values()];
  if (options.spine === undefined) {
    // A role absent from some composable spine cannot be required.
    for (const role of allRoles) {
      if (role.required && !spines.every((code) => shortlistBlocks(catalog, code).some((candidate) => candidate.role === role.role))) role.required = false;
    }
  }
  for (const role of allRoles) {
    const criteria: Record<string, string> = {};
    const map = new Map<string, string>();
    for (const id of role.candidates) {
      const entry = byId.get(id)!;
      const key = optionKey(id);
      criteria[key] = blockCriterion(entry);
      map.set(key, id);
    }
    if (!role.required) {
      criteria.none = NONE_CRITERION;
      map.set('none', 'none');
    }
    const key = `block_${role.role}`;
    const needs = KIND_NEEDS[role.kind] ? ` ${KIND_NEEDS[role.kind]}` : '';
    questions[key] = {
      type: 'choice',
      instructions: `Which reviewed ${role.kind} block best presents this client's page, given \`brief\`?${needs}${role.required ? '' : ' Choose none when the brief does not support it.'}`,
      criteria,
    };
    roles.push({ role: role.role, key, kind: role.kind, required: role.required, options: map });
  }
  return { state: { brief }, questions, asked: { ...(spineAsked ? { spine: spineAsked } : {}), direction: { key: 'direction', options: directionMap }, roles } };
}

export type ResolvedBlockPlan = { plan: BlockPlan; confidence: number };

/**
 * Pure: Jev's answers into a plan, or the fixed reason there is none. Any malformed or missing
 * answer rejects the whole request (`jev-bad-answer`) — no plan from a request that did not
 * answer as asked. The spine needs `threshold`; an optional role's pick needs `threshold` too,
 * and a pick the chosen spine cannot take is dropped. The page rules (hero first, footer last,
 * no duplicate kind except features, no duplicate id, 3 to 7 blocks) hold whatever Jev said.
 */
/**
 * The block one role contributes, or `undefined` for none. A required role takes Jev's choice. An
 * optional role asks two questions of the same answer: whether the page has this role at all
 * (`1 - P(none)` at or above the threshold), and which compatible block fills it (the most probable
 * one). Judging inclusion by Jev's confidence in one block instead would drop a role the brief
 * clearly supports whenever several reviewed blocks share the vote — a larger catalog would make
 * pages shorter. An answer without a `none` probability falls back to that confidence.
 */
export function pickForRole(
  role: AskedRole,
  answer: ChoiceAnswer,
  byId: ReadonlyMap<string, BlockCatalogEntry>,
  spine: string,
  threshold: number,
): { id: string; confidence: number } | undefined {
  const usable = (key: string): BlockCatalogEntry | undefined => {
    const id = role.options.get(key);
    const entry = id === undefined || id === 'none' ? undefined : byId.get(id);
    return entry && compatibleWith(entry, spine) ? entry : undefined;
  };
  if (role.required) {
    const entry = usable(answer.choice);
    return entry ? { id: entry.id, confidence: answer.confidence } : undefined;
  }
  const noneKey = [...role.options].find(([, id]) => id === 'none')?.[0];
  const pNone = noneKey !== undefined ? answer.probabilities[noneKey] : undefined;
  // Support is the probability on blocks the chosen spine can take, out of Jev's WHOLE answer:
  // probability on a block this spine cannot take is no vote for the role here and is not
  // renormalised away, so 0.92 on an incompatible block, 0.04 on a compatible one and 0.04 on
  // `none` gives support 0.04 and the role stays out.
  let compatible = 0;
  for (const [key, probability] of Object.entries(answer.probabilities)) if (typeof probability === 'number' && usable(key)) compatible += probability;
  const support = typeof pNone === 'number' ? compatible : (usable(answer.choice) ? answer.confidence : 0);
  if (support < threshold) return undefined;
  if (typeof pNone !== 'number') {
    const entry = usable(answer.choice);
    return entry ? { id: entry.id, confidence: answer.confidence } : undefined;
  }
  let best: { id: string; confidence: number } | undefined;
  for (const [key, probability] of Object.entries(answer.probabilities)) {
    const entry = usable(key);
    // Ties go to the lower id, so the answer's key order never changes the page.
    if (entry && (!best || probability > best.confidence || (probability === best.confidence && entry.id < best.id))) best = { id: entry.id, confidence: probability };
  }
  return best;
}

export function resolveBlockPlan(
  answers: unknown,
  asked: AskedPlan,
  catalog: BlockCatalog,
  options: { spine?: string; threshold?: number } = {},
): ResolvedBlockPlan | { fallback: CompositionFallback } {
  const threshold = options.threshold ?? DEFAULT_BLOCK_THRESHOLD;
  if (!isObject(answers as Json)) return { fallback: 'jev-bad-answer' };
  const table = answers as JsonObject;
  let spine = options.spine;
  let confidence = 1;
  if (asked.spine) {
    const checked = validateChoiceAnswer(table.spine, new Set(asked.spine.options.keys()));
    if ('reason' in checked) return { fallback: 'jev-bad-answer' };
    if (checked.answer.choice === 'none') return { fallback: 'no-spine' };
    if (checked.answer.confidence < threshold) return { fallback: 'spine-below-threshold' };
    spine = checked.answer.choice;
    confidence = checked.answer.confidence;
  }
  if (spine === undefined) return { fallback: 'no-spine' };
  const direction = validateChoiceAnswer(table.direction, new Set(asked.direction.options.keys()));
  if ('reason' in direction) return { fallback: 'jev-bad-answer' };
  const directionId = asked.direction.options.get(direction.answer.choice)!;

  const byId = new Map(catalog.blocks.map((entry) => [entry.id, entry]));
  const picks: Array<{ id: string; kind: string; role: string; required: boolean; confidence: number }> = [];
  const footerAnswers: Array<{ role: AskedRole; answer: ChoiceAnswer }> = [];
  for (const role of asked.roles) {
    const checked = validateChoiceAnswer(table[role.key], new Set(role.options.keys()));
    if ('reason' in checked) return { fallback: 'jev-bad-answer' };
    if (role.kind === 'footer') footerAnswers.push({ role, answer: checked.answer });
    const pick = pickForRole(role, checked.answer, byId, spine, threshold);
    if (pick) picks.push({ id: pick.id, kind: role.kind, role: role.role, required: role.required, confidence: pick.confidence });
  }
  // The chosen spine's footer rule. The footer question is optional when some candidate spine has
  // no footer, so Jev may have answered `none` (or picked an incompatible footer); a spine that has
  // one still takes one: the most probable footer it is compatible with, whatever `none` scored.
  if (spineTakesFooter(catalog, spine) && !picks.some((pick) => pick.kind === 'footer')) {
    let best: { id: string; confidence: number } | undefined;
    for (const { role, answer } of footerAnswers) {
      for (const [key, probability] of Object.entries(answer.probabilities)) {
        const id = role.options.get(key);
        const entry = id === undefined || id === 'none' ? undefined : byId.get(id);
        if (entry && compatibleWith(entry, spine) && (!best || probability > best.confidence || (probability === best.confidence && entry.id < best.id))) best = { id: entry.id, confidence: probability };
      }
    }
    if (!best) return { fallback: 'too-few-blocks' };
    picks.push({ id: best.id, kind: 'footer', role: 'footer', required: true, confidence: best.confidence });
  }
  // Hero first, footer last, no duplicate id, no duplicate kind except features.
  const seenIds = new Set<string>();
  const seenKinds = new Set<string>();
  const kept = picks.filter((pick) => {
    if (seenIds.has(pick.id)) return false;
    if (seenKinds.has(pick.kind) && pick.kind !== 'features') return false;
    seenIds.add(pick.id);
    seenKinds.add(pick.kind);
    return true;
  });
  const hero = kept.filter((pick) => pick.kind === 'hero').slice(0, 1);
  const footer = kept.filter((pick) => pick.kind === 'footer').slice(0, 1);
  const cta = kept.filter((pick) => pick.kind === 'cta-band').slice(0, 1);
  let body = kept.filter((pick) => pick.kind !== 'hero' && pick.kind !== 'footer' && pick.kind !== 'cta-band');
  // Over the cap: the least confident body picks go first; the page order is kept.
  const room = MAX_BLOCKS - hero.length - footer.length - cta.length;
  if (body.length > room) {
    const keep = new Set([...body].sort((a, b) => b.confidence - a.confidence).slice(0, Math.max(0, room)).map((pick) => pick.id));
    body = body.filter((pick) => keep.has(pick.id));
  }
  const ordered = [...hero, ...body, ...cta, ...footer];
  if (hero.length === 0 || body.length === 0 || cta.length + footer.length === 0 || ordered.length < MIN_BLOCKS) {
    return { fallback: 'too-few-blocks' };
  }
  return { plan: { spine, directionId, blocks: ordered.map((pick) => pick.id) }, confidence };
}

/** A saved plan (a fork's replay) that today's catalog no longer accepts. `reason` is the
 * `checkBlockPlan` sentence: ids and fixed phrases only, safe to show a client. */
export class BlockPlanReplayError extends Error {
  readonly code = 'plan-no-longer-applies';
  readonly reason: string;
  constructor(reason: string) {
    super(`plan-no-longer-applies: the saved block plan no longer applies: ${reason}`);
    this.name = 'BlockPlanReplayError';
    this.reason = reason;
  }
}

/**
 * A replayed plan (a fork of a composed build) checked against today's catalog: every
 * id still resolves and is compatible, the direction exists, and the page rules still hold. The
 * reason names the first rule the plan breaks; `undefined` means the plan is usable as it is.
 */
export function checkBlockPlan(plan: BlockPlan, catalog: BlockCatalog, directionIds: readonly string[]): string | undefined {
  if (!SPINES.some((spine) => spine.code === plan.spine)) return `unknown spine ${plan.spine}`;
  if (!directionIds.includes(plan.directionId)) return `unknown direction ${plan.directionId}`;
  if (plan.blocks.length < MIN_BLOCKS || plan.blocks.length > MAX_BLOCKS) return `a plan takes ${MIN_BLOCKS} to ${MAX_BLOCKS} blocks`;
  const byId = new Map(catalog.blocks.map((entry) => [entry.id, entry]));
  const kinds: string[] = [];
  for (const id of plan.blocks) {
    const entry = byId.get(id);
    if (!entry) return `block ${id} is not an insertable catalog block`;
    if (!compatibleWith(entry, plan.spine)) return `block ${id} does not fit spine ${plan.spine}`;
    kinds.push(entry.sectionKind);
  }
  if (new Set(plan.blocks).size !== plan.blocks.length) return 'a block appears twice';
  if (kinds[0] !== 'hero' || kinds.filter((kind) => kind === 'hero').length !== 1) return 'a plan starts with its one hero';
  const footerAt = kinds.indexOf('footer');
  if (footerAt >= 0 && footerAt !== kinds.length - 1) return 'the footer comes last';
  const repeated = kinds.filter((kind, index) => kind !== 'features' && kinds.indexOf(kind) !== index);
  if (repeated.length > 0) return `section kind ${repeated[0]} appears twice`;
  if (footerAt < 0 && spineTakesFooter(catalog, plan.spine)) return `spine ${plan.spine} takes a footer, last`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------

export type BlockPlanJudgement =
  | { plan: BlockPlan; confidence: number; ms: number; calls: number; supportGate?: BlockSupportReceipt }
  | { fallback: CompositionFallback; ms: number; calls: number };

export type BlockPlanner = {
  plan: (input: { brief: string; catalog: BlockCatalog; spine?: string }) => Promise<BlockPlanJudgement>;
};

export type JevBlockPlannerOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  /** Total deadline for picker and support together, including setup; default 15 seconds. */
  timeoutMs?: number;
  threshold?: number;
  /** Post-picker yes/no section support; independent of the picker threshold. Default 0.8. */
  supportThreshold?: number;
  endpoint?: string;
  /** Cancels the request; rethrown, never folded into a fallback. */
  signal?: AbortSignal;
  /** The five directions; defaults to the overlay's own list. Injected by tests. */
  directions?: ReadonlyArray<{ id: string; label: string; mood: string }>;
};

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * One picker request, then a fail-open support request for missing types. Picker failures become
 * fixed `CompositionFallback` codes; support failures keep the plan with a skip code. Cancellation
 * propagates. Invalid support-threshold configuration is rejected before any request.
 */
export function createJevBlockPlanner(options: JevBlockPlannerOptions): BlockPlanner {
  const supportThreshold = options.supportThreshold ?? DEFAULT_SUPPORT_THRESHOLD;
  if (!Number.isFinite(supportThreshold) || supportThreshold < 0 || supportThreshold > 1) throw new Error('supportThreshold must be a finite number in [0, 1]');
  const key = resolveJevKey(options.apiKey);
  return {
    plan: async ({ brief, catalog, spine }) => {
      const started = performance.now();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const remainingMs = () => Math.max(0, Math.ceil(timeoutMs - (performance.now() - started)));
      const ms = () => Math.round(performance.now() - started);
      const fallback = (code: CompositionFallback, calls: number): BlockPlanJudgement => ({ fallback: code, ms: ms(), calls });
      if (spine !== undefined && !composableSpines(catalog).includes(spine)) return fallback('no-coverage', 0);
      let directions: NonNullable<JevBlockPlannerOptions['directions']>;
      try { directions = options.directions ?? await withinBlockPlanDeadline(listDesignDirectionMoods(), signal); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        return fallback(deadline.aborted ? 'jev-timeout' : 'jev-unreachable', 0);
      }
      const built = buildBlockPlanQuestions(brief, catalog, directions, spine !== undefined ? { spine } : {});
      if (!built) return fallback('no-coverage', 0);
      let resolvedKey: string;
      try {
        resolvedKey = await withinBlockPlanDeadline(key(), signal);
        if (typeof resolvedKey !== 'string' || resolvedKey.length === 0) return fallback('jev-key-missing', 0);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return fallback(deadline.aborted ? 'jev-timeout' : 'jev-key-missing', 0);
      }
      let calls = 0;
      let response: Awaited<ReturnType<typeof postSystemOne>>;
      try {
        signal.throwIfAborted();
        calls = 1;
        response = await withinBlockPlanDeadline(postSystemOne({
          endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
          model: options.model ?? DEFAULT_MODEL,
          timeoutMs: remainingMs(),
          fetchImpl: options.fetchImpl ?? fetch,
          key: async () => resolvedKey,
          state: built.state,
          questions: built.questions,
          signal,
        }), signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return fallback(timedOut ? 'jev-timeout' : 'jev-unreachable', calls);
      }
      if (!response.ok) return fallback(sectionSkipReasonForStatus(response.status), 1);
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        return fallback('jev-bad-answer', 1);
      }
      const answers = isObject(body as Json) ? (body as JsonObject).answers : undefined;
      const resolved = resolveBlockPlan(answers, built.asked, catalog, { ...(spine !== undefined ? { spine } : {}), ...(options.threshold !== undefined ? { threshold: options.threshold } : {}) });
      if ('fallback' in resolved) return fallback(resolved.fallback, 1);
      const supported = await supportBlockPlan({ brief, plan: resolved.plan, catalog, asked: built.asked, pickerAnswers: answers, options,
        request: { endpoint: options.endpoint ?? DEFAULT_ENDPOINT, model: options.model ?? DEFAULT_MODEL,
          timeoutMs: remainingMs(), fetchImpl: options.fetchImpl ?? fetch,
          key: async () => resolvedKey, state: {}, questions: {}, signal },
      });
      return { plan: supported.plan, supportGate: supported.supportGate, confidence: resolved.confidence, ms: ms(), calls: 1 + supported.calls };
    },
  };
}
