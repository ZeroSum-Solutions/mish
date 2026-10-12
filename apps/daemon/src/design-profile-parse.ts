import {
  DESIGN_STYLE_AXES,
  type DesignJudgment,
  type DesignProfile,
  type DesignProfileRoute,
  type DesignProfileSource,
  type DesignProfileSourceKind,
  type DesignQualityResult,
  type DesignStyleAxis,
} from '@mish/contracts';
import {
  PUBLIC_PREVIEW_URL_MAX_CHARS,
  publicPreviewUrlProblem,
} from '@mish/agency-fast-lane/preview-url';

/**
 * Runtime parser for a `DesignProfile` arriving from outside the daemon — `POST /api/design-index`,
 * which is also what `od design-index add` and `od design-index import` post.
 *
 * Two jobs, and the second is the reason this is a parser rather than a validator.
 *
 * It **checks** every field the index and the search path later assume exists: a body that only
 * carried `schema` and `source.digest` would be stored happily and then break `findProfiles`
 * (which reads `route`, `style` and the label records) and the list order (which reads `at`).
 *
 * It **rebuilds** the profile from an allowlist rather than passing the caller's object through.
 * A stored profile is served back verbatim by `GET /api/design-index/:digest`, so anything the
 * caller attaches rides along: `source.text` holding the page that was profiled, a top-level
 * `input`, a tracking blob. The fast lane's own profiler deliberately keeps the text OUT of a
 * profile — it stores labels, a digest and a length — and this endpoint must not be the way
 * around that.
 *
 * `taxonomy` is checked as a non-empty string, not pinned to the running taxonomy's version: a
 * profile produced against an older vocabulary is still a profile, and refusing to store it would
 * make a taxonomy bump silently drop history.
 */

export type ParsedDesignProfile = { profile: DesignProfile } | { error: string };

const SOURCE_KINDS: DesignProfileSourceKind[] = ['prompt', 'brief', 'spec', 'html'];
/** The design taxonomy fixes the quality scale at 5 ordered levels, so scores run 0 to 4. */
const MAX_QUALITY_SCORE = 4;
/** Website Shape Atlas compatibility scores: 0 (different spine) to 3 (close transfer). */
const MAX_TRANSFER = 3;
/** `meta.catalogId` holds a prompt-catalog row id (a slug), never a document. */
const META_CATALOG_ID_MAX_CHARS = 128;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

class ProfileShapeError extends Error {}

function fail(path: string, expectation: string): never {
  throw new ProfileShapeError(`profile.${path} ${expectation}`);
}

function requireObject(value: unknown, path: string): Obj {
  if (!isObject(value)) fail(path, 'must be an object');
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
}

function requireNumberInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function requireNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, 'must be a finite number of at least 0');
  }
  return value;
}

/** Counts (`calls`, `source.chars`, token usage) are whole numbers; a fractional count is a
 * malformed profile, not a rounding question. `ms` stays a finite non-negative number. */
function requireCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, 'must be a non-negative integer');
  }
  return value;
}

/** An ISO-8601 instant that `Date` both parses and reproduces — the shape `new Date().toISOString()`
 * writes, and the shape the list order sorts on lexically. */
function requireIsoDate(value: unknown, path: string): string {
  const text = requireString(value, path);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    fail(path, 'must be an ISO-8601 date-time, as `new Date().toISOString()` writes it');
  }
  return text;
}

/** A map of label id to probability. Keys stay as given — they are taxonomy ids this daemon may
 * not know, and refusing an unknown one would reject a profile from a newer vocabulary. */
function requireProbabilityMap(value: unknown, path: string): Record<string, number> {
  const source = requireObject(value, path);
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(source)) {
    if (!isUnit(probability)) fail(`${path}.${key}`, 'must be a number between 0 and 1');
    out[key] = probability;
  }
  return out;
}

function requireJudgment(value: unknown, path: string): DesignJudgment {
  const source = requireObject(value, path);
  return {
    choice: requireString(source.choice, `${path}.choice`),
    confidence: requireNumberInRange(source.confidence, `${path}.confidence`, 0, 1),
    probabilities: requireProbabilityMap(source.probabilities, `${path}.probabilities`),
  };
}

function optionalJudgment(value: unknown, path: string): DesignJudgment | undefined {
  return value === undefined ? undefined : requireJudgment(value, path);
}

function requireSource(value: unknown): DesignProfileSource {
  const source = requireObject(value, 'source');
  const kind = source.kind;
  if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as DesignProfileSourceKind)) {
    fail('source.kind', `must be one of ${SOURCE_KINDS.join(', ')}`);
  }
  const id = optionalString(source.id, 'source.id');
  const title = optionalString(source.title, 'source.title');
  const ref = optionalString(source.ref, 'source.ref');
  return {
    kind: kind as DesignProfileSourceKind,
    ...(id !== undefined ? { id } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(ref !== undefined ? { ref } : {}),
    chars: requireCount(source.chars, 'source.chars'),
    digest: requireString(source.digest, 'source.digest'),
  };
}

function requireRoute(value: unknown): DesignProfileRoute {
  const route = requireObject(value, 'route');
  const resolved = requireObject(route.resolved, 'route.resolved');
  const archetypeId = optionalString(resolved.archetypeId, 'route.resolved.archetypeId');
  const familyId = optionalString(resolved.familyId, 'route.resolved.familyId');
  const basis = optionalString(resolved.basis, 'route.resolved.basis');
  const transfer = resolved.transfer === undefined
    ? undefined
    : requireNumberInRange(resolved.transfer, 'route.resolved.transfer', 0, MAX_TRANSFER);
  const archetype = optionalJudgment(route.archetype, 'route.archetype');
  return {
    spine: requireJudgment(route.spine, 'route.spine'),
    ...(archetype !== undefined ? { archetype } : {}),
    skin: requireJudgment(route.skin, 'route.skin'),
    format: requireJudgment(route.format, 'route.format'),
    action: requireJudgment(route.action, 'route.action'),
    family: requireJudgment(route.family, 'route.family'),
    resolved: {
      ...(archetypeId !== undefined ? { archetypeId } : {}),
      ...(familyId !== undefined ? { familyId } : {}),
      ...(basis !== undefined ? { basis } : {}),
      ...(transfer !== undefined ? { transfer } : {}),
    },
  };
}

function requireStyle(value: unknown): Record<DesignStyleAxis, DesignJudgment> {
  const style = requireObject(value, 'style');
  const out = {} as Record<DesignStyleAxis, DesignJudgment>;
  for (const axis of DESIGN_STYLE_AXES) out[axis] = requireJudgment(style[axis], `style.${axis}`);
  return out;
}

function requireQuality(value: unknown): Record<string, DesignQualityResult> {
  const quality = requireObject(value, 'quality');
  const out: Record<string, DesignQualityResult> = {};
  for (const [id, entry] of Object.entries(quality)) {
    const dimension = requireObject(entry, `quality.${id}`);
    out[id] = {
      score: requireNumberInRange(dimension.score, `quality.${id}.score`, 0, MAX_QUALITY_SCORE),
      legend: requireString(dimension.legend, `quality.${id}.legend`),
      confidence: requireNumberInRange(dimension.confidence, `quality.${id}.confidence`, 0, 1),
    };
  }
  return out;
}

function optionalUsage(value: unknown): { input_tokens: number; output_tokens: number } | undefined {
  if (value === undefined) return undefined;
  const usage = requireObject(value, 'usage');
  return {
    input_tokens: requireCount(usage.input_tokens, 'usage.input_tokens'),
    output_tokens: requireCount(usage.output_tokens, 'usage.output_tokens'),
  };
}

/**
 * `meta.previewImage` and `meta.previewVideo` are the only meta values the app turns into a URL
 * it hands to the browser (the Home reference cards render them as media), so they are parsed
 * here rather than trusted.
 *
 * The rule itself lives in the fast lane's `preview-url` module, which the catalog preview
 * hydration and the web card builder use too: this endpoint is not the only way a preview URL
 * reaches a profile, so it must not be the only place that decides what an acceptable one is.
 * Only the wording of the 400 is this file's own, hence the reason rather than the predicate.
 */
function requireHttpsUrl(value: unknown, path: string): string {
  const text = requireString(value, path);
  const problem = publicPreviewUrlProblem(text);
  if (problem === 'too-long') fail(path, `must be at most ${PUBLIC_PREVIEW_URL_MAX_CHARS} characters`);
  if (problem === 'malformed') fail(path, 'must be a well-formed absolute URL');
  if (problem !== undefined) fail(path, 'must be an https: URL');
  return text;
}

function requireBoundedString(value: unknown, path: string, max: number): string {
  const text = requireString(value, path);
  if (text.length > max) fail(path, `must be at most ${max} characters`);
  return text;
}

/**
 * Meta is an open bag of primitives, with three exceptions: the keys the app itself consumes
 * (`catalogId` identifies the catalog row a reference card came from, the two preview keys are
 * its media) are checked when present, so a bad value is a 400 naming the key here rather than a
 * broken card later. Every other key keeps the old rule — any string, finite number or boolean.
 */
function optionalMeta(value: unknown): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  const meta = requireObject(value, 'meta');
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(meta)) {
    if (key === 'catalogId') out[key] = requireBoundedString(entry, 'meta.catalogId', META_CATALOG_ID_MAX_CHARS);
    else if (key === 'previewImage' || key === 'previewVideo') out[key] = requireHttpsUrl(entry, `meta.${key}`);
    else if (typeof entry === 'string' || typeof entry === 'boolean') out[key] = entry;
    else if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
    else fail(`meta.${key}`, 'must be a string, a finite number or a boolean');
  }
  return out;
}

export function parseDesignProfile(value: unknown): ParsedDesignProfile {
  try {
    const input = requireObject(value, '');
    if (input.schema !== 'design-profile/1') fail('schema', 'must be "design-profile/1"');

    const usage = optionalUsage(input.usage);
    const meta = optionalMeta(input.meta);

    const profile: DesignProfile = {
      schema: 'design-profile/1',
      taxonomy: requireString(input.taxonomy, 'taxonomy'),
      model: requireString(input.model, 'model'),
      at: requireIsoDate(input.at, 'at'),
      ms: requireNonNegative(input.ms, 'ms'),
      calls: requireCount(input.calls, 'calls'),
      ...(usage !== undefined ? { usage } : {}),
      source: requireSource(input.source),
      route: requireRoute(input.route),
      sections: requireProbabilityMap(input.sections, 'sections'),
      components: requireProbabilityMap(input.components, 'components'),
      mechanics: requireProbabilityMap(input.mechanics, 'mechanics'),
      depth: requireProbabilityMap(input.depth, 'depth'),
      style: requireStyle(input.style),
      quality: requireQuality(input.quality),
      truthRisk: requireNumberInRange(input.truthRisk, 'truthRisk', 0, 1),
      ...(meta !== undefined ? { meta } : {}),
    };
    return { profile };
  } catch (error: unknown) {
    if (error instanceof ProfileShapeError) return { error: error.message };
    throw error;
  }
}
