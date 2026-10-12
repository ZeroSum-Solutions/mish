/**
 * Optional sections: one Jev keep/drop request per build, decided BEFORE the fill.
 *
 * A family marks a section optional on its own node in `recipe.schema.json`
 * (`"type": ["object", "null"]` plus an `x-optional` block, and the family's `OPTIONAL_SECTIONS`
 * in `slots.ts`). A brief that gives nothing for such a section — no reviews, no donor figures, no
 * studio story — would make the fill invent it, and the faithfulness gate would then flag it and
 * fail a strict build. Dropping it up front is cheaper and more honest: the slot holds `null`
 * (the array keeps its length, because every contract checks the count and every renderer reads
 * by position), the fill never sees it, the faithfulness check never reads it, and the family
 * compiler renders nothing for it — no markup, no asset, no navigation link.
 *
 * The decision is advisory, like the faithfulness gate: when Jev cannot be reached, answers with
 * an error, or the build runs with `verify: 'off'`, every section is KEPT. Explicit hints (the
 * build request's and the fork seed's `sections`, the CLI's `--keep`/`--drop`) override Jev and
 * are never sent to it.
 *
 * The threshold (0.75) sits below the faithfulness gate's 0.85 on purpose: a section wrongly kept
 * is fabrication that fails a strict build, while a section wrongly dropped only loses a section.
 */

import { postSystemOne, resolveJevKey } from './jev.ts';
import { isObject, type Json, type JsonObject } from './spine.ts';

export type OptionalSection = {
  /** Position in `sections`. */
  index: number;
  /** The section's id: from the spine, or from the reference recipe when the spine already holds `null` there. */
  id: string;
  type: string;
  label: string;
  dropWhen: string;
  keepWhen: string;
  /** Full path labels of nav text slots that only point at this section. */
  navSlots: string[];
  /** The spine already holds `null` here (a repair, or a re-target of a page that dropped it). */
  dropped: boolean;
  /**
   * What the brief must contain word for word before the section can be filled at all
   * (`x-optional.requires`). `quote`: a testimonial section needs a quoted passage from the brief —
   * a brief that only ASKS for testimonials gives the fill nothing to quote, so it would invent one.
   */
  requires?: 'quote';
};

export type SectionHint = 'keep' | 'drop';
export type SectionHints = Readonly<Record<string, SectionHint>>;

export const DEFAULT_SECTION_THRESHOLD = 0.75;
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;

function resolveRef(node: Json | undefined, root: JsonObject): JsonObject | undefined {
  if (!isObject(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const target = ref.slice(2).split('/').reduce<Json | undefined>((acc, segment) => (isObject(acc) ? acc[segment] : undefined), root);
    return resolveRef(target, root);
  }
  return node;
}

const typeConstOf = (node: JsonObject | undefined): string | undefined => {
  const properties = node && isObject(node.properties) ? node.properties : undefined;
  const type = properties && isObject(properties.type) ? properties.type.const : undefined;
  return typeof type === 'string' ? type : undefined;
};

/**
 * The schema node for position `index`, holding the section of type `type`: the prefix item
 * itself, or — for a family whose middle positions admit any of several section types (emmpo's
 * `oneOf` of `$ref`s) — the alternative whose `type` const matches.
 */
function sectionNode(item: Json | undefined, type: string | undefined, root: JsonObject): JsonObject | undefined {
  const node = resolveRef(item, root);
  if (!node) return undefined;
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = node[key];
    if (Array.isArray(alternatives)) {
      return alternatives.map((alternative) => resolveRef(alternative, root)).find((candidate) => typeConstOf(candidate) === type);
    }
  }
  return node;
}

const strings = (value: Json | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * The sections of `spine` its family schema marks optional (`x-optional`), in order.
 *
 * A dropped section carries neither id nor type, so a position the spine already holds `null` in
 * takes its identity from `reference` (the package's reference recipe) — but not by position
 * alone: a family whose middle sections may reorder (emmpo) can hold the null anywhere. The
 * dropped section is the reference section the spine no longer has (its type is missing from the
 * spine's remaining sections, counted per type) and the schema admits, as an optional section, at
 * that position. The reference section at the same index wins when it qualifies; otherwise the
 * first missing one in reference order does.
 */
export function optionalSectionsOf(schema: JsonObject, spine: JsonObject, reference: JsonObject = spine): OptionalSection[] {
  const sectionsSchema = isObject(schema.properties) ? resolveRef(schema.properties.sections, schema) : undefined;
  const prefix = sectionsSchema && Array.isArray(sectionsSchema.prefixItems) ? sectionsSchema.prefixItems : [];
  const current = Array.isArray(spine.sections) ? spine.sections : [];
  const referenceSections = (Array.isArray(reference.sections) ? reference.sections : [])
    .map((item, index) => (isObject(item) && typeof item.id === 'string' && typeof item.type === 'string' ? { index, id: item.id, type: item.type } : undefined));
  // Per type: how many reference sections of that type the spine no longer has.
  const missing = new Map<string, number>();
  for (const item of referenceSections) if (item) missing.set(item.type, (missing.get(item.type) ?? 0) + 1);
  for (const item of current) if (isObject(item) && typeof item.type === 'string') missing.set(item.type, (missing.get(item.type) ?? 0) - 1);
  const claimed = new Set<number>();
  const optionalNode = (index: number, type: string): JsonObject | undefined => {
    const optional = sectionNode(prefix[index], type, schema)?.['x-optional'];
    return isObject(optional) ? optional : undefined;
  };
  const droppedIdentity = (index: number): { id: string; type: string } | undefined => {
    const fits = (candidate: { index: number; id: string; type: string } | undefined) =>
      candidate !== undefined && !claimed.has(candidate.index) && (missing.get(candidate.type) ?? 0) > 0 && optionalNode(index, candidate.type) !== undefined;
    const same = referenceSections[index];
    const chosen = fits(same) ? same : referenceSections.find(fits);
    if (!chosen) return undefined;
    claimed.add(chosen.index);
    missing.set(chosen.type, (missing.get(chosen.type) ?? 0) - 1);
    return chosen;
  };
  const out: OptionalSection[] = [];
  current.forEach((item, index) => {
    const source = isObject(item) ? item : item === null ? droppedIdentity(index) : undefined;
    const id = source?.id;
    const type = source?.type;
    if (typeof id !== 'string' || typeof type !== 'string') return;
    const optional = optionalNode(index, type);
    if (!optional) return;
    out.push({
      index,
      id,
      type,
      label: typeof optional.label === 'string' ? optional.label : type,
      dropWhen: typeof optional.dropWhen === 'string' ? optional.dropWhen : '',
      keepWhen: typeof optional.keepWhen === 'string' ? optional.keepWhen : '',
      navSlots: strings(optional.navSlots),
      dropped: item === null,
      ...(optional.requires === 'quote' ? { requires: 'quote' as const } : {}),
    });
  });
  return out;
}

type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

/** The one fan-out request: the brief as `state`, one Noul question per section, `drop_<index>`. */
export function buildKeepDropQuestions(brief: string, optional: readonly OptionalSection[]): { state: { brief: string }; questions: Record<string, NoulQuestion> } {
  const questions: Record<string, NoulQuestion> = {};
  for (const section of optional) {
    questions[`drop_${section.index}`] = {
      type: 'noul',
      instructions: `Would a \`${section.label}\` section on this client's page have to invent its content because \`brief\` gives nothing for it?`,
      criteria: {
        true: `${section.dropWhen} Filling it would mean inventing it.`.trim(),
        false: section.keepWhen,
      },
    };
  }
  return { state: { brief }, questions };
}

export type KeepDropResolution = { dropped: string[]; kept: string[]; warnings: string[] };

/** Same checks `route.ts`'s `validateChoiceAnswer` makes, for a Noul answer. */
function validateNoulAnswer(value: unknown): { noul: number } | { reason: string } {
  if (!isObject(value as Json)) return { reason: 'missing or not an object' };
  const answer = value as JsonObject;
  if (answer.type !== 'noul') return { reason: 'type is not "noul"' };
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return { reason: 'noul is not a finite number in [0, 1]' };
  return { noul: answer.noul };
}

/**
 * Pure: turns Jev's answers into the drop list. A section is dropped only at `noul >= threshold`;
 * a missing or malformed answer keeps it and records why.
 */
export function resolveKeepDrop(answers: unknown, optional: readonly OptionalSection[], threshold = DEFAULT_SECTION_THRESHOLD): KeepDropResolution {
  const table = isObject(answers as Json) ? answers as JsonObject : {};
  const out: KeepDropResolution = { dropped: [], kept: [], warnings: [] };
  for (const section of optional) {
    const checked = validateNoulAnswer(table[`drop_${section.index}`]);
    if ('reason' in checked) {
      out.kept.push(section.id);
      out.warnings.push(`${section.id}: kept, the keep/drop answer was ${checked.reason}`);
    } else if (checked.noul >= threshold) {
      out.dropped.push(section.id);
    } else {
      out.kept.push(section.id);
    }
  }
  return out;
}

/**
 * Why Jev could not decide, as a fixed code. Never a transport message or a response body: those
 * can carry anything the network stack or the platform put in them, and this code is printed by
 * the CLI and carried on build events.
 */
export type SectionSkipReason = 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized' | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer';

/** The skip code for a non-2xx Jev status. */
export function sectionSkipReasonForStatus(status: number): SectionSkipReason {
  if (status === 401 || status === 403) return 'jev-unauthorized';
  if (status === 429) return 'jev-rate-limited';
  return 'jev-http-error';
}

export type SectionJudgement = KeepDropResolution & { ms: number; calls: number; skipped?: SectionSkipReason };

export type SectionJudge = {
  judge: (input: { brief: string; optional: readonly OptionalSection[] }) => Promise<SectionJudgement>;
};

export type JevSectionJudgeOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  threshold?: number;
  endpoint?: string;
  /** Cancels the request; rethrown, never folded into `skipped`. */
  signal?: AbortSignal;
};

/**
 * The Jev keep/drop judge. Never throws for Jev's own failures: a non-2xx answer, a network
 * error, a timeout or an unreadable body keeps every section and says why in `skipped`, as a
 * fixed `SectionSkipReason` (never an error message or a response body). Only the caller's own
 * cancellation is rethrown.
 */
export function createJevSectionJudge(options: JevSectionJudgeOptions): SectionJudge {
  const key = resolveJevKey(options.apiKey);
  const threshold = options.threshold ?? DEFAULT_SECTION_THRESHOLD;
  return {
    judge: async ({ brief, optional }) => {
      const started = performance.now();
      const keepAll = (skipped: SectionSkipReason, calls: number): SectionJudgement => ({
        dropped: [],
        kept: optional.map((section) => section.id),
        warnings: [],
        ms: Math.round(performance.now() - started),
        calls,
        skipped,
      });
      if (optional.length === 0) return { dropped: [], kept: [], warnings: [], ms: 0, calls: 0 };
      const { state, questions } = buildKeepDropQuestions(brief, optional);
      let response: Awaited<ReturnType<typeof postSystemOne>>;
      try {
        response = await postSystemOne({
          endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
          model: options.model ?? DEFAULT_MODEL,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchImpl: options.fetchImpl ?? fetch,
          key,
          state,
          questions,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return keepAll(timedOut ? 'jev-timeout' : 'jev-unreachable', 0);
      }
      if (!response.ok) return keepAll(sectionSkipReasonForStatus(response.status), 1);
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        return keepAll('jev-bad-answer', 1);
      }
      const answers = isObject(body as Json) ? (body as JsonObject).answers : undefined;
      const resolved = resolveKeepDrop(answers, optional, threshold);
      return { ...resolved, ms: Math.round(performance.now() - started), calls: 1 };
    },
  };
}

/**
 * Whether the brief quotes anyone: a passage of at least three words between straight or curly
 * double quotes. A testimonial can only be faithful when the brief supplies its words; a request
 * such as "feature a testimonial from a local developer" supplies none.
 *
 * Matched against the brief with every run of whitespace (including a line break) collapsed to
 * one space first \u2014 a live practice build found a real, genuinely-quoted review invisible to the
 * un-collapsed version: a brief supplied as an ordinary word-wrapped `.txt` file breaks a long
 * quote across a line exactly where its own wrapping happens to land, and the original regex's
 * `[^"\u201c\u201d\n]` explicitly excluded `\n` from the quoted span, so that whole quote never
 * matched at all \u2014 `practice-reviews` was dropped as unsupported on a brief that plainly quotes
 * three named patients. A brief's own line breaks are formatting, never a fact inside the quote,
 * so collapsing them costs nothing a real quote needs.
 */
export function briefHasQuote(brief: string): boolean {
  const collapsed = brief.replace(/\s+/gu, ' ');
  for (const match of collapsed.matchAll(/["\u201c]([^"\u201c\u201d]{1,600})["\u201d]/gu)) {
    if ((match[1]!.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu) ?? []).length >= 3) return true;
  }
  return false;
}

export type SectionDecision = {
  /** Ids to set to `null` before the fill. */
  dropped: string[];
  /** Ids the spine already held `null` in that a `keep` hint restores from the reference recipe. */
  restored: string[];
  kept: string[];
  /**
   * `jev` when Jev answered; `hint` when explicit hints decided and Jev decided nothing (it was
   * not asked, or — with `skipped` set — could not answer); `brief` when only a section's own
   * precondition decided (`requires`: the brief quotes no one); `default` when nothing did (every
   * section kept).
   */
  source: 'jev' | 'hint' | 'brief' | 'default';
  skipped?: SectionSkipReason;
  warnings: string[];
  ms: number;
};

/**
 * The whole decision for one build. Hints win and are not sent to Jev. A hint for an id the family
 * does not mark optional is ignored with a warning. A section the spine already dropped stays
 * dropped (it is not re-judged) unless a `keep` hint restores it. With no `judge` (verify off, or
 * a repair that must not re-judge) every other section is kept.
 */
export async function decideSections(input: { brief: string; optional: readonly OptionalSection[]; hints?: SectionHints; judge?: SectionJudge }): Promise<SectionDecision> {
  const { optional } = input;
  const hints = input.hints ?? {};
  const warnings: string[] = [];
  const known = new Set(optional.map((section) => section.id));
  for (const id of Object.keys(hints)) if (!known.has(id)) warnings.push(`${id}: not an optional section of this family, hint ignored`);
  const dropped: string[] = [];
  const restored: string[] = [];
  const kept: string[] = [];
  const toJudge: OptionalSection[] = [];
  let hinted = false;
  let ruled = false;
  for (const section of optional) {
    const hint = Object.hasOwn(hints, section.id) ? hints[section.id] : undefined;
    if (hint === 'drop') {
      hinted = true;
      dropped.push(section.id);
    } else if (hint === 'keep') {
      hinted = true;
      kept.push(section.id);
      if (section.dropped) restored.push(section.id);
    } else if (section.dropped) {
      dropped.push(section.id);
    } else if (input.judge && section.requires === 'quote' && !briefHasQuote(input.brief)) {
      // Decided without asking Jev: there is nothing in the brief to quote, so a kept section could
      // only be filled by inventing its quotes. Only when the build judges at all (verify not off),
      // the same scope as the Jev drop it stands in for.
      ruled = true;
      dropped.push(section.id);
      warnings.push(`${section.id}: dropped, the brief quotes no one`);
    } else {
      toJudge.push(section);
    }
  }
  const undecided = hinted ? 'hint' : ruled ? 'brief' : 'default';
  if (!input.judge || toJudge.length === 0) {
    kept.push(...toJudge.map((section) => section.id));
    return { dropped, restored, kept, source: undecided, warnings, ms: 0 };
  }
  const verdict = await input.judge.judge({ brief: input.brief, optional: toJudge });
  dropped.push(...verdict.dropped);
  kept.push(...verdict.kept);
  warnings.push(...verdict.warnings);
  const source = verdict.skipped === undefined ? 'jev' : undecided;
  return { dropped, restored, kept, source, ...(verdict.skipped !== undefined ? { skipped: verdict.skipped } : {}), warnings, ms: verdict.ms };
}

/**
 * Applies a decision to a spine in place, before the spine is first rendered: each dropped id's
 * slot becomes `null`, each restored id's slot takes the reference recipe's section back. Returns
 * the nav slot paths of every section that ends up dropped (including ones the spine already
 * held `null` in), for the caller to lock so the model never writes a label that will not render.
 * Throws when asked to drop a section the family does not mark optional.
 */
export function applySectionDrops(spine: JsonObject, schema: JsonObject, reference: JsonObject, drop: readonly string[] = [], restore: readonly string[] = []): string[] {
  const optional = optionalSectionsOf(schema, spine, reference);
  const sections = Array.isArray(spine.sections) ? spine.sections : [];
  const referenceSections = Array.isArray(reference.sections) ? reference.sections : [];
  // By id, not by position: in a family whose middle sections reorder, the dropped section's
  // reference copy may sit at another index.
  const referenceById = (id: string) => referenceSections.find((candidate) => isObject(candidate) && candidate.id === id);
  for (const id of drop) {
    const section = optional.find((candidate) => candidate.id === id);
    if (!section) throw new Error(`section ${id} is not an optional section of family ${String(spine.family)}`);
    sections[section.index] = null;
  }
  for (const id of restore) {
    const section = optional.find((candidate) => candidate.id === id);
    const original = section ? referenceById(id) : undefined;
    if (section && sections[section.index] === null && original !== undefined) sections[section.index] = structuredClone(original);
  }
  return optional.filter((section) => sections[section.index] === null).flatMap((section) => section.navSlots);
}

/** The ids of the optional sections `spine` holds `null` for, identified as `optionalSectionsOf` does. */
export function droppedSectionIds(spine: JsonObject, schema: JsonObject, reference: JsonObject): string[] {
  return optionalSectionsOf(schema, spine, reference).filter((section) => section.dropped).map((section) => section.id);
}

/**
 * `value` (a template, or a limits or atom-kinds object shaped like it) with every section the
 * template holds `null` for removed, for the whole-page prompt: the model is shown only the
 * sections it must fill. Answers are matched back by id, so positions need not line up.
 *
 * The filter is positional, so `value.sections` must line up with `template.sections` (the shape
 * `limitsFor`/`atomKindsFor` build keeps the template's array length). A length mismatch would
 * drop the wrong entries silently, so it throws instead.
 */
export function withoutDroppedSections(value: Json | undefined, template: Json): Json | undefined {
  if (!isObject(value) || !isObject(template) || !Array.isArray(value.sections) || !Array.isArray(template.sections)) return value;
  const shown = template.sections;
  if (value.sections.length !== shown.length) {
    throw new Error(`withoutDroppedSections: ${value.sections.length} sections do not line up with the template's ${shown.length}`);
  }
  return { ...value, sections: value.sections.filter((_, index) => shown[index] !== null) };
}
