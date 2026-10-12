// Taint-by-type for mechanical review evidence (B4-2 rounds 7 and 9).
//
// Every string the page can influence (CDP events, in-page collectors, DOM
// attributes, URLs, hrefs, sources, request and resource fields) enters the
// daemon as an opaque PageText. Findings, observations and reasons are
// structured messages (EvidenceText): a key from the contract's closed
// template table and typed parameters. The only parameters that can come from
// a PageText are:
//
//   (a) a closed-vocabulary value (roles, tag names, resource types, schemes):
//       `evidenceRole`, `evidenceVocabulary`, and structural selectors from
//       `evidenceSelector`;
//   (b) a location checked against this run's serve log and allow-list:
//       `evidenceUrl` keeps a served project path or an allow-listed origin and
//       reduces everything else, origins included, to digests;
//   (c) the length+SHA-256 token: `PageText#token()`.
//
// Values the daemon or the user authored (numbers, rubric keys, allow-list
// hosts, served paths, digests) have their own typed constructors below.
import { createHash } from 'node:crypto';
import {
  REVIEW_ARIA_ROLES, REVIEW_EVIDENCE_VOCABULARIES, REVIEW_TAG_NAMES, REVIEW_URL_SCHEMES, renderReviewEvidenceMessage, renderReviewEvidenceParam, reviewEvidenceArity,
  WORKBENCH_REVIEW_MAX_PATH_DEPTH, WORKBENCH_REVIEW_PREVIEW_HOST,
  type ReviewEvidenceMessage, type ReviewEvidenceParam, type ReviewEvidenceTemplate, type ReviewEvidenceVocabulary,
} from '@mish/contracts';

/**
 * Review evidence: a structured message (template key plus typed parameters,
 * see the contract's workbench-review-evidence.ts). Only the functions in this
 * module produce its parameters, so page text can enter only as a token, a
 * closed-vocabulary value or a reduced location.
 */
export type EvidenceText = ReviewEvidenceMessage;
export type EvidenceParam = ReviewEvidenceParam;
/** What a message may interpolate: another message, a typed parameter, or a number. */
export type EvidenceValue = EvidenceText | EvidenceParam | number;

const isMessage = (value: EvidenceText | EvidenceParam): value is EvidenceText => !('kind' in value);
export function toParam(value: EvidenceValue): EvidenceParam {
  if (typeof value === 'number') return { kind: 'number', value: Number.isFinite(value) ? value : 0 };
  // The compiler already refuses anything else; this keeps a cast from slipping free text through at runtime.
  if (typeof value !== 'object' || value === null || value instanceof PageText || (!('kind' in value) && !('template' in value && 'params' in value))) throw new TypeError('Evidence takes only messages, typed parameters and numbers');
  return isMessage(value) ? { kind: 'message', template: value.template, params: value.params } : value;
}

/** A message from the closed template table. Its parameters must already be evidence (or numbers). */
export function ev(template: ReviewEvidenceTemplate, ...values: EvidenceValue[]): EvidenceText {
  const arity = reviewEvidenceArity(template);
  if (values.length !== arity) throw new Error(`Evidence template ${template} takes ${arity} parameters, got ${values.length}`);
  return { template, params: values.map(toParam) };
}

/** English text of a message, for logs, errors and reviewer prompts. */
export const evidenceString = (text: EvidenceText): string => renderReviewEvidenceMessage(text, 'en');
/** A stable key for comparing two evidence values. */
export const evidenceKey = (value: EvidenceValue): string => JSON.stringify(toParam(value));

// Typed parameters for values daemon code computed without page input.
export const num = (value: number, decimals?: number): EvidenceParam => ({ kind: 'number', value: Number.isFinite(value) ? value : 0, ...(decimals === undefined ? {} : { decimals }) });
export const list = (items: EvidenceValue[]): EvidenceParam => ({ kind: 'list', items: items.map(toParam) });
/** A key from the user's rubric or design context (never page text). */
/**
 * The form a rubric key takes in evidence: without control characters or
 * angle brackets, at most 300 characters. frozenRubricKeys freezes exactly
 * this form, so an honest key always verifies against its own inputs.
 */
export const canonicalRubricKey = (value: string): string => value.replace(/[\p{Cc}<>]/gu, '').slice(0, 300) || '?';
export const rubricKey = (value: string): EvidenceParam => ({ kind: 'rubricKey', value: canonicalRubricKey(value) });
/** An allow-list host name (already validated by the contract's host rules). */
export const hostParam = (value: string): EvidenceParam => ({ kind: 'host', value: value.split(':')[0]!.toLowerCase() });
export const addressParam = (value: string): EvidenceParam => ({ kind: 'address', value });
export const digestParam = (hex: string): EvidenceParam => ({ kind: 'digest', value: hex });
/** A project-relative path the file server served. */
export const pathParam = (relPath: string): EvidenceParam => ({ kind: 'path', value: relPath });
export const consoleRef = (id: string): EvidenceParam => ({ kind: 'consoleRef', value: id });
/** A daemon-authored value from a closed vocabulary. */
export function vocab(vocabulary: ReviewEvidenceVocabulary, value: string): EvidenceParam {
  if (!(REVIEW_EVIDENCE_VOCABULARIES[vocabulary] as readonly string[]).includes(value)) throw new Error(`${value} is not in the ${vocabulary} vocabulary`);
  return { kind: 'vocab', vocabulary, value };
}

/** A failure whose message is already evidence (it holds no raw page text). */
export class EvidenceError extends Error {
  constructor(readonly evidence: EvidenceText) { super(evidenceString(evidence)); this.name = 'EvidenceError'; }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const RAW = new WeakMap<PageText, string>();

/**
 * A page-controlled string. Its value is reachable only through readPageText,
 * and only the evidence reducers in this module, console digests and the
 * worker's own calls back into the page use that. Printing it, interpolating
 * it or serializing it yields its token, never its text.
 */
export class PageText {
  private constructor() {}

  static of(value: unknown): PageText {
    const text = new PageText();
    RAW.set(text, typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
    return text;
  }

  static ofNullable(value: unknown): PageText | null {
    return value === null || value === undefined ? null : PageText.of(value);
  }

  get length(): number { return RAW.get(this)!.length; }
  sha256(): string { return sha256(RAW.get(this)!); }
  isBlank(): boolean { return RAW.get(this)!.trim() === ''; }
  /** Equality without exposing either value (deterministic). */
  equals(other: PageText | null): boolean { return other !== null && RAW.get(this) === RAW.get(other); }
  /** Length and SHA-256 prefix: the only form in which page text appears in evidence. */
  token(): EvidenceParam { return { kind: 'token', length: this.length, sha256: this.sha256().slice(0, 12) }; }
  /** `<page text: N chars, sha256 prefix>` */
  toString(): string { return renderReviewEvidenceParam(this.token()); }
  toJSON(): string { return this.toString(); }
}

/** The raw page string, for checks, digests and calls back into the page; never for output. */
export function readPageText(text: PageText): string {
  return RAW.get(text) ?? '';
}

// ---------------------------------------------------------------------------
// (a) Closed vocabularies
// ---------------------------------------------------------------------------

const KNOWN_TAGS: ReadonlySet<string> = new Set(REVIEW_TAG_NAMES);
const ARIA_ROLES: ReadonlySet<string> = new Set(REVIEW_ARIA_ROLES);
export { REVIEW_RESOURCE_TYPES as RESOURCE_TYPES } from '@mish/contracts';

/** A value from a closed vocabulary, or the page-text token. */
export function evidenceVocabulary(value: PageText, vocabulary: ReviewEvidenceVocabulary): EvidenceParam {
  const raw = readPageText(value);
  return (REVIEW_EVIDENCE_VOCABULARIES[vocabulary] as readonly string[]).includes(raw) ? { kind: 'vocab', vocabulary, value: raw } : value.token();
}

/** A control's role: a known ARIA role or HTML tag name, otherwise the page-text token. */
export function evidenceRole(role: PageText): EvidenceParam {
  const raw = readPageText(role);
  return ARIA_ROLES.has(raw) || KNOWN_TAGS.has(raw) ? { kind: 'vocab', vocabulary: 'role', value: raw } : role.token();
}

/** One of `allowed`, or `fallback`: for enum-like fields whose value the page could spoof. */
export function pageEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

const KNOWN_PART = /^([a-z][a-z0-9-]*)(?::nth-of-type\((\d{1,4})\))?$/u;
const WILDCARD_PART = /^\*:nth-child\((\d{1,4})\)$/u;

/**
 * A selector is evidence only when it is structural: a path from <body> of
 * known-tag `tag:nth-of-type(n)` parts and, for elements outside the tag
 * vocabulary (custom elements), positional `*:nth-child(n)` wildcards. An
 * element id or class, however short or plain, is page-chosen, so any
 * selector naming one is the page-text token. The page can tamper with the
 * in-page builder, so the grammar is checked here.
 */
export function evidenceSelector(selector: PageText): EvidenceParam {
  const raw = readPageText(selector);
  if (!raw || raw.length > 1000) return selector.token();
  const parts: { tag: string; index: number | null }[] = [];
  for (const part of raw.split(' > ')) {
    const wildcard = WILDCARD_PART.exec(part);
    if (wildcard) { parts.push({ tag: '*', index: Number(wildcard[1]) }); continue; }
    const known = KNOWN_PART.exec(part);
    if (!known || !KNOWN_TAGS.has(known[1]!) || (known[2] !== undefined && Number(known[2]) < 1)) return selector.token();
    parts.push({ tag: known[1]!, index: known[2] === undefined ? null : Number(known[2]) });
  }
  if (parts.length > 40 || parts[0]!.tag !== 'body' || parts[0]!.index !== null || parts.some(part => part.tag === '*' && part.index! < 1)) return selector.token();
  return { kind: 'selector', parts };
}

// ---------------------------------------------------------------------------
// (b) URLs and paths, verified against the run's serve log and allow-list
// ---------------------------------------------------------------------------

export const PREVIEW_ORIGIN = `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`;
const HIERARCHICAL = new Set(['http:', 'https:', 'ws:', 'wss:']);
const KNOWN_SCHEMES: ReadonlySet<string> = new Set(REVIEW_URL_SCHEMES);

/** What the run can vouch for: project files it served (or read) and origins its allow-list names. */
export interface EvidenceContext {
  /** True for a project-relative path (decoded, no leading slash) the review served or read with status 200. */
  served(relPath: string): boolean;
  /** True for an origin (`https://host[:port]`) on the run's egress allow-list. */
  allowedOrigin(origin: string): boolean;
}
export const UNVERIFIED: EvidenceContext = { served: () => false, allowedOrigin: () => false };

/** Path depth, capped so a very deep path is recorded rather than refused. */
export function pathDepthOf(pathname: string): { pathDepth: number; pathDepthCapped: boolean } {
  const depth = pathname.split('/').filter(Boolean).length;
  return { pathDepth: Math.min(depth, WORKBENCH_REVIEW_MAX_PATH_DEPTH), pathDepthCapped: depth > WORKBENCH_REVIEW_MAX_PATH_DEPTH };
}

/**
 * A URL reduced to what evidence may hold. `origin` is set only for the
 * preview origin, an allow-listed origin or a known opaque scheme; any other
 * origin is `originSha256`. `path` is set only for a served project file; any
 * other path is `pathQuerySha256` (path plus query). A served path keeps its
 * query only as length and digest.
 */
export interface EvidenceLocation {
  origin: string | null;
  originSha256: string | null;
  path: string | null;
  pathDepth: number;
  pathDepthCapped: boolean;
  pathQuerySha256: string | null;
  queryLength: number;
  querySha256: string | null;
}

export function evidenceLocation(url: PageText, context: EvidenceContext, base?: string): EvidenceLocation | null {
  let parsed: URL;
  try { parsed = new URL(readPageText(url), base); } catch { return null; }
  const empty = { path: null, pathDepth: 0, pathDepthCapped: false, pathQuerySha256: null, queryLength: 0, querySha256: null };
  if (!HIERARCHICAL.has(parsed.protocol) || !parsed.host) {
    return KNOWN_SCHEMES.has(parsed.protocol) ? { origin: parsed.protocol, originSha256: null, ...empty } : { origin: null, originSha256: sha256(parsed.protocol), ...empty };
  }
  const query = parsed.search.replace(/^\?/u, '');
  const depth = pathDepthOf(parsed.pathname);
  if (parsed.origin === PREVIEW_ORIGIN) {
    let relPath: string | null = null;
    try { relPath = decodeURIComponent(parsed.pathname).replace(/^\/+/u, ''); } catch { relPath = null; }
    if (relPath !== null && context.served(relPath)) {
      return { origin: parsed.origin, originSha256: null, path: parsed.pathname.slice(0, 1024), ...depth, pathQuerySha256: null, queryLength: query.length, querySha256: query ? sha256(query) : null };
    }
    return { origin: parsed.origin, originSha256: null, path: null, ...depth, pathQuerySha256: sha256(`${parsed.pathname}${parsed.search}`), queryLength: query.length, querySha256: null };
  }
  const verified = context.allowedOrigin(parsed.origin);
  return { origin: verified ? parsed.origin : null, originSha256: verified ? null : sha256(parsed.origin), path: null, ...depth, pathQuerySha256: sha256(`${parsed.pathname}${parsed.search}`), queryLength: query.length, querySha256: null };
}

/** A reduced location as an evidence parameter. */
export function locationParam(location: EvidenceLocation | null): EvidenceParam {
  return location ? { kind: 'location', ...location } : { kind: 'unparseableUrl' };
}

export function evidenceUrl(url: PageText, context: EvidenceContext, base?: string): EvidenceParam {
  return locationParam(evidenceLocation(url, context, base));
}
