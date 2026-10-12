/**
 * The PROFILE step: one Jev (TypeSafe System One) fan-out request classifies any design input —
 * a catalog prompt, a client brief, a spec, or extracted HTML facts — against the Website Shape
 * Atlas (route), the design taxonomy (sections, components, mechanics, depth, style), and the
 * quality rubric (a pre-score read from the spec text, never a ship grade). See
 * `docs/plans/2026-09-19-design-profile-index-design.md` for the full design. The fixed question
 * set lives in `profile-questions.ts`; this file owns answer validation, resolution
 * (`resolveProfile`), and the request (`createJevProfiler`).
 *
 * `resolveProfile` maps raw Jev answers to a `DesignProfile`; `route.resolved` reuses
 * `resolveRoute` from `route.ts` unmodified, so a profile and a `--family auto` router run agree.
 * Every `archetype_<CODE>` answer present in `answers` is validated and forwarded to
 * `resolveRoute`, not only the top spine's: `route.ts`'s candidate-gathering considers every spine
 * carrying at least `spineShare` of the `spine` answer's own probability mass, and needs that
 * spine's own archetype answer to check candidates against it.
 *
 * Every answer is runtime-validated before use, exactly like `jev.ts`'s own `JevResponseBody`
 * cast and `route.ts`'s `validateChoiceAnswer` — a `JSON.parse` cast claims a shape the network
 * never guarantees. Unlike `route.ts` (which degrades a malformed non-critical answer to a
 * warning so a routable brief still routes), a malformed or missing profile answer throws
 * `ProfileError('malformed answer <id>: <reason>')` and fails the whole profile closed: a profile
 * is stored and later trusted, so one silently garbage field (e.g. a `NaN` quality score) is worse
 * than no profile at all.
 *
 * `createJevProfiler` shares its request mechanics (auth, timeout, lazy cached key, fetchImpl
 * injection) with `route.ts`'s router and `jev.ts`'s faithfulness checker through
 * `postSystemOne`/`resolveJevKey` (`jev.ts`). Unlike `jev.ts`'s advisory gate, profiling is a
 * decision, like routing: a non-2xx throws `ProfileError`, a network failure propagates as-is —
 * never `skipped`. `ProfileError`'s HTTP-failure message never carries Jev's response body, only
 * `jev <status>`: a 4xx can echo request content back, and `state.text` may be licence-restricted
 * reference text for a catalog-sourced profile.
 */

import { createHash } from 'node:crypto';
import type { FamilyRegistry, ShapeAtlas } from './atlas.ts';
import { postSystemOne, resolveJevKey, type JevKeyResolver } from './jev.ts';
import { buildProfileQuestions, STYLE_AXES, type ProfileQuestion, type StyleAxis } from './profile-questions.ts';
import { resolveRoute, type ChoiceAnswer as RouteChoiceAnswer, type ResolveOptions } from './route.ts';
import { isObject } from './spine.ts';
import type { DesignTaxonomy } from './taxonomy.ts';

export { buildProfileQuestions } from './profile-questions.ts';
export type { ProfileQuestion } from './profile-questions.ts';

// ---------------------------------------------------------------------------
// Answer shapes (Jev's three primitives, per `docs.typesafe.ai/primitives`)
// ---------------------------------------------------------------------------

export type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulAnswer = { type: 'noul'; noul: number };
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };
export type ProfileAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** A Choice answer stripped of its `type` discriminant — the shape every route/style judgment in
 * a `DesignProfile` is stored as. */
export type Judgment = { choice: string; confidence: number; probabilities: Record<string, number> };

// ---------------------------------------------------------------------------
// DesignProfile
// ---------------------------------------------------------------------------

export type ProfileSourceKind = 'prompt' | 'brief' | 'spec' | 'html';

export type ProfileSource = {
  kind: ProfileSourceKind;
  id?: string;
  title?: string;
  ref?: string;
  chars: number;
  digest: string;
};

export type ResolvedRoute = {
  archetypeId?: string;
  familyId?: string;
  basis?: string;
  transfer?: number;
};

export type ProfileRoute = {
  spine: Judgment;
  archetype?: Judgment;
  skin: Judgment;
  format: Judgment;
  action: Judgment;
  family: Judgment;
  resolved: ResolvedRoute;
  /** Every `archetype_<CODE>` answer Jev gave, by spine code — `archetype` keeps only the top
   * spine's. Lets a saved profile be re-routed through `resolveRoute` with runner-up spines intact
   * (the route eval's `--replay`). Absent on profiles written before it existed. */
  archetypes?: Record<string, Judgment>;
};

export type ProfileStyle = Record<StyleAxis, Judgment>;
export type QualityResult = { score: number; legend: string; confidence: number };

export type DesignProfile = {
  schema: 'design-profile/1';
  taxonomy: string;
  model: string;
  at: string;
  ms: number;
  calls: number;
  usage?: { input_tokens: number; output_tokens: number };
  source: ProfileSource;
  route: ProfileRoute;
  sections: Record<string, number>;
  components: Record<string, number>;
  mechanics: Record<string, number>;
  depth: Record<string, number>;
  style: ProfileStyle;
  quality: Record<string, QualityResult>;
  truthRisk: number;
  meta?: Record<string, string | number | boolean>;
};

// ---------------------------------------------------------------------------
// ProfileError
// ---------------------------------------------------------------------------

/**
 * Two distinct uses, both fail-closed: a malformed-answer message (`malformed answer <id>:
 * <reason>`, no `status`) from `resolveProfile`'s validators, and a Jev HTTP failure (`jev
 * <status>`, `status` set) from `createJevProfiler`. The HTTP-failure message never carries Jev's
 * response body — see the file header.
 */
export class ProfileError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProfileError';
    if (status !== undefined) this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

function isFiniteInUnitRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Mirrors `route.ts`'s `validateChoiceAnswer`: `type` is `"choice"`, `choice` is one of the
 * options this question actually offered, `confidence` and every `probabilities` value are
 * finite numbers in [0, 1]. */
function validateChoiceAnswer(value: unknown, validChoices: ReadonlySet<string>): Validated<ChoiceAnswer> {
  if (!isObject(value)) return { ok: false, reason: 'missing or not an object' };
  if (value.type !== 'choice') return { ok: false, reason: 'type is not "choice"' };
  if (typeof value.choice !== 'string' || !validChoices.has(value.choice)) return { ok: false, reason: 'choice is not one of the offered options' };
  if (!isFiniteInUnitRange(value.confidence)) return { ok: false, reason: 'confidence is not a finite number in [0, 1]' };
  if (!isObject(value.probabilities)) return { ok: false, reason: 'probabilities is missing or not an object' };
  for (const [option, probability] of Object.entries(value.probabilities)) {
    if (!isFiniteInUnitRange(probability)) return { ok: false, reason: `probabilities.${option} is not a finite number in [0, 1]` };
  }
  return { ok: true, value: value as unknown as ChoiceAnswer };
}

/** `type` is `"noul"`, `noul` is a finite number in [0, 1]. */
function validateNoulAnswer(value: unknown): Validated<NoulAnswer> {
  if (!isObject(value)) return { ok: false, reason: 'missing or not an object' };
  if (value.type !== 'noul') return { ok: false, reason: 'type is not "noul"' };
  if (!isFiniteInUnitRange(value.noul)) return { ok: false, reason: 'noul is not a finite number in [0, 1]' };
  return { ok: true, value: value as unknown as NoulAnswer };
}

/** `type` is `"score"`, `score` is a finite number within the question's own level range, every
 * `probabilities` value is a finite number in [0, 1], the legend entry for the answered level
 * (`round(score)`) is a string matching one of the question's own level descriptions, and
 * `confidence` is a finite number in [0, 1]. */
function validateScoreAnswer(value: unknown, levels: string[]): Validated<ScoreAnswer> {
  if (!isObject(value)) return { ok: false, reason: 'missing or not an object' };
  if (value.type !== 'score') return { ok: false, reason: 'type is not "score"' };
  const maxLevel = levels.length - 1;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > maxLevel) {
    return { ok: false, reason: `score is not a finite number within [0, ${maxLevel}]` };
  }
  if (!isObject(value.probabilities)) return { ok: false, reason: 'probabilities is missing or not an object' };
  for (const [level, probability] of Object.entries(value.probabilities)) {
    if (!isFiniteInUnitRange(probability)) return { ok: false, reason: `probabilities.${level} is not a finite number in [0, 1]` };
  }
  if (!isObject(value.legend)) return { ok: false, reason: 'legend is missing or not an object' };
  const answeredLevel = String(Math.round(value.score));
  const legendText = value.legend[answeredLevel];
  if (typeof legendText !== 'string' || !levels.includes(legendText)) {
    return { ok: false, reason: `legend.${answeredLevel} is not one of the question's own level descriptions` };
  }
  if (!isFiniteInUnitRange(value.confidence)) return { ok: false, reason: 'confidence is not a finite number in [0, 1]' };
  return { ok: true, value: value as unknown as ScoreAnswer };
}

function requireChoice(answers: Record<string, unknown>, id: string, validChoices: ReadonlySet<string>): ChoiceAnswer {
  const result = validateChoiceAnswer(answers[id], validChoices);
  if (!result.ok) throw new ProfileError(`malformed answer ${id}: ${result.reason}`);
  return result.value;
}
function requireNoul(answers: Record<string, unknown>, id: string): NoulAnswer {
  const result = validateNoulAnswer(answers[id]);
  if (!result.ok) throw new ProfileError(`malformed answer ${id}: ${result.reason}`);
  return result.value;
}
function requireScore(answers: Record<string, unknown>, id: string, levels: string[]): ScoreAnswer {
  const result = validateScoreAnswer(answers[id], levels);
  if (!result.ok) throw new ProfileError(`malformed answer ${id}: ${result.reason}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

function toJudgment(answer: ChoiceAnswer): Judgment {
  return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
}

function nearestLevel(score: number, levelCount: number): number {
  return Math.max(0, Math.min(levelCount - 1, Math.round(score)));
}

/**
 * The pure mapping from a completed set of Jev answers (all ~105 questions, however many
 * requests it took to gather them) to a `DesignProfile`, minus the call metadata
 * (`model`/`at`/`ms`/`calls`/`usage`) `createJevProfiler` fills in afterward. Every answer is
 * validated before use (see the file header); a malformed or missing one throws `ProfileError`.
 * `route.resolved` reuses `resolveRoute` from `route.ts` exactly as it is called there, so a
 * profile and a `--family auto` router run agree.
 */
export function resolveProfile(
  answers: Record<string, ProfileAnswer>,
  atlas: ShapeAtlas,
  registry: FamilyRegistry,
  taxonomy: DesignTaxonomy,
  source: ProfileSource,
  options: ResolveOptions = {},
  meta?: Record<string, string | number | boolean>,
): Omit<DesignProfile, 'model' | 'at' | 'ms' | 'calls' | 'usage'> {
  const spineChoices = new Set<string>(['none', ...atlas.spines.map((spine) => spine.code)]);
  const spineAnswer = requireChoice(answers, 'spine', spineChoices);

  const skinChoices = new Set<string>(['unspecified', ...atlas.skins]);
  const skinAnswer = requireChoice(answers, 'skin', skinChoices);

  const formatChoices = new Set<string>(['unspecified', ...atlas.formats.map((format) => format.name)]);
  const formatAnswer = requireChoice(answers, 'format', formatChoices);

  const actionChoices = new Set<string>(taxonomy.action.map((action) => action.id));
  const actionAnswer = requireChoice(answers, 'action', actionChoices);

  const familyChoices = new Set<string>(['none', ...registry.families.map((entry) => entry.family)]);
  const familyAnswer = requireChoice(answers, 'family', familyChoices);

  // Every archetype_<CODE> answer actually present is validated and forwarded to resolveRoute —
  // not only the top spine's — since resolveRoute's own candidate-gathering may consult a
  // runner-up spine (see the file header).
  const routeAnswersForResolve: Record<string, RouteChoiceAnswer> = { spine: spineAnswer, family: familyAnswer, skin: skinAnswer };
  const archetypeAnswers = new Map<string, ChoiceAnswer>();
  for (const spine of atlas.spines) {
    const key = `archetype_${spine.code}`;
    if (!(key in answers)) continue;
    const validChoices = new Set<string>(['none', ...atlas.archetypes.filter((archetype) => archetype.spine === spine.code).map((archetype) => archetype.id)]);
    const archetypeAnswer = requireChoice(answers, key, validChoices);
    archetypeAnswers.set(spine.code, archetypeAnswer);
    routeAnswersForResolve[key] = archetypeAnswer;
  }

  const policy = resolveRoute(routeAnswersForResolve, atlas, registry, options);
  const topArchetypeAnswer = spineAnswer.choice !== 'none' ? archetypeAnswers.get(spineAnswer.choice) : undefined;

  const route: ProfileRoute = {
    spine: toJudgment(spineAnswer),
    skin: toJudgment(skinAnswer),
    format: toJudgment(formatAnswer),
    action: toJudgment(actionAnswer),
    family: toJudgment(familyAnswer),
    resolved: {
      archetypeId: policy.archetype?.id,
      familyId: policy.family?.id,
      basis: policy.family?.basis,
      transfer: policy.family?.transfer,
    },
    ...(topArchetypeAnswer ? { archetype: toJudgment(topArchetypeAnswer) } : {}),
    ...(archetypeAnswers.size > 0 ? { archetypes: Object.fromEntries([...archetypeAnswers].map(([code, answer]) => [code, toJudgment(answer)])) } : {}),
  };

  const sections: Record<string, number> = {};
  for (const label of taxonomy.sections) sections[label.id] = requireNoul(answers, `section_${label.id}`).noul;
  const components: Record<string, number> = {};
  for (const label of taxonomy.components) components[label.id] = requireNoul(answers, `component_${label.id}`).noul;
  const mechanics: Record<string, number> = {};
  for (const label of taxonomy.mechanics) mechanics[label.id] = requireNoul(answers, `mechanic_${label.id}`).noul;
  const depth: Record<string, number> = {};
  for (const label of taxonomy.depth) depth[label.id] = requireNoul(answers, `depth_${label.id}`).noul;

  const styleChoicesFor = (axis: StyleAxis): Set<string> => new Set<string>(['unspecified', ...taxonomy.style[axis].map((option) => option.id)]);
  const style = Object.fromEntries(
    STYLE_AXES.map((axis) => [axis, toJudgment(requireChoice(answers, `style_${axis}`, styleChoicesFor(axis)))]),
  ) as ProfileStyle;

  const quality: Record<string, QualityResult> = {};
  for (const dimension of taxonomy.quality) {
    const answer = requireScore(answers, `quality_${dimension.id}`, dimension.levels);
    const level = nearestLevel(answer.score, dimension.levels.length);
    quality[dimension.id] = { score: answer.score, legend: answer.legend[String(level)] ?? dimension.levels[level]!, confidence: answer.confidence };
  }

  const truthRisk = requireNoul(answers, 'truth_risk').noul;

  return {
    schema: 'design-profile/1',
    taxonomy: taxonomy.version,
    source,
    route,
    sections,
    components,
    mechanics,
    depth,
    style,
    quality,
    truthRisk,
    ...(meta ? { meta } : {}),
  };
}

// ---------------------------------------------------------------------------
// createJevProfiler
// ---------------------------------------------------------------------------

export type JevProfilerOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  endpoint?: string;
};

export type ProfileInput = {
  text: string;
  /** Extracted HTML facts (`html-facts.ts`'s `htmlFacts(html)`), when the source is an uploaded
   * page. Carried alongside `text` in `state` — never replacing it — so every question's "`text`
   * (or `facts` when given)" wording resolves against both. */
  facts?: Record<string, unknown>;
  atlas: ShapeAtlas;
  registry: FamilyRegistry;
  taxonomy: DesignTaxonomy;
  threshold?: number;
  minTransfer?: number;
  spineShare?: number;
  source: Omit<ProfileSource, 'chars' | 'digest'>;
  meta?: Record<string, string | number | boolean>;
};

export type JevProfiler = { profile: (input: ProfileInput) => Promise<DesignProfile> };

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;

// Same documented ceilings and headroom `jev.ts` uses (see its header): 64,000 tokens for
// `state` + all `questions`, with ~4 characters/token estimation since the API gives no
// tokenizer. Profiling asks a fixed ~105-question set every time, so instead of `jev.ts`'s
// slot-by-slot batching, a single over-budget input splits the fixed question set itself into
// exactly two requests, each carrying the full state.
const CHARS_PER_TOKEN = 4;
const MAX_REQUEST_TOKENS = 56_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type JevResponseBody = { model: string; answers: Record<string, ProfileAnswer>; usage?: { input_tokens: number; output_tokens: number } };

export function createJevProfiler(options: JevProfilerOptions): JevProfiler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const key: JevKeyResolver = resolveJevKey(options.apiKey);

  const profile: JevProfiler['profile'] = async (input) => {
    const startedAt = performance.now();
    const questions = buildProfileQuestions(input.atlas, input.registry, input.taxonomy, input.minTransfer);
    const state: Record<string, unknown> = input.facts !== undefined ? { text: input.text, facts: input.facts } : { text: input.text };

    const stateTokens = estimateTokens(JSON.stringify(state));
    const questionEntries = Object.entries(questions);
    const questionsTokens = questionEntries.reduce((sum, [, question]) => sum + estimateTokens(JSON.stringify(question)), 0);

    const batches: [string, ProfileQuestion][][] =
      stateTokens + questionsTokens <= MAX_REQUEST_TOKENS
        ? [questionEntries]
        : [questionEntries.slice(0, Math.ceil(questionEntries.length / 2)), questionEntries.slice(Math.ceil(questionEntries.length / 2))];

    const answers: Record<string, ProfileAnswer> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    let modelUsed = model;

    for (const batch of batches) {
      const batchQuestions = Object.fromEntries(batch);
      // A network failure or timeout propagates as-is: profiling is a decision, not an advisory
      // gate like `jev.ts`'s faithfulness check, so there is no `skipped` outcome here — the same
      // fail-closed contract `route.ts`'s router follows.
      const raw = await postSystemOne({ endpoint, model, timeoutMs, fetchImpl, key, state, questions: batchQuestions });
      calls += 1;
      // The message never carries `raw.text` (Jev's response body): a 4xx can echo the request
      // back, and `state.text` may be licence-restricted reference text for a catalog-sourced
      // profile — see the file header. `status` is kept as a typed field for callers that want it.
      if (!raw.ok) throw new ProfileError(`jev ${raw.status}`, raw.status);
      const json = JSON.parse(raw.text) as JevResponseBody;
      modelUsed = json.model;
      Object.assign(answers, json.answers);
      inputTokens += json.usage?.input_tokens ?? 0;
      outputTokens += json.usage?.output_tokens ?? 0;
    }

    const digest = createHash('sha256').update(input.text).digest('hex');
    const source: ProfileSource = { ...input.source, chars: input.text.length, digest };
    const resolved = resolveProfile(answers, input.atlas, input.registry, input.taxonomy, source, {
      threshold: input.threshold,
      minTransfer: input.minTransfer,
      spineShare: input.spineShare,
    }, input.meta);

    return {
      ...resolved,
      model: modelUsed,
      at: new Date().toISOString(),
      ms: Math.round(performance.now() - startedAt),
      calls,
      ...(calls > 0 ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens } } : {}),
    };
  };

  return { profile };
}
