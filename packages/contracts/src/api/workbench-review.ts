import { reviewFindingDecisionSchema, reviewFindingDecisionProblem } from './workbench-review-decisions.js';
import { z } from 'zod';
import { WORKBENCH_MANDATORY_CRITERION_IDS } from './workbench-context.js';
import { isReviewEvidenceMessage, renderReviewEvidenceText, REVIEW_OBSERVED_BEHAVIORS, REVIEW_RESOURCE_TYPES, reviewEvidenceMessageSchema, reviewEvidenceParamSchema, reviewEvidenceParams, type ReviewEvidenceLocale, type ReviewEvidenceMessage } from './workbench-review-evidence.js';
import { RESOURCE_SOURCE_IDS } from './workbench-resource-ref.js';

// DRAFT (U1, R06.2): mechanical-check evidence records. U2 (R03 review runs)
// extends this file with ReviewRun/reviewer records; nothing here changes the
// rubric contract in workbench-context.ts.

const identifier = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value), 'Identifiers cannot contain padding or controls');
const timestamp = z.string().datetime({ offset: false });
const line = z.string().max(500);
/** A stored text field: a structured message (evidence v2) or, in bundles written before it, a plain string. */
const evidenceText = z.union([reviewEvidenceMessageSchema, line]);
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/**
 * B5-1 W3: checks the daemon adds to a run beyond the rubric's own (at most
 * 100): six unweakened mandatory defaults, up to eight seeded judgments and up
 * to eighteen checklist criteria. Per-run check-id lists hold a full rubric
 * plus this allowance; the daemon refuses a larger plan up front.
 */
export const WORKBENCH_REVIEW_DAEMON_CHECK_ALLOWANCE = 32;
export const WORKBENCH_REVIEW_MAX_CHECK_IDS = 100 + WORKBENCH_REVIEW_DAEMON_CHECK_ALLOWANCE;

// ---------------------------------------------------------------------------
// B4-2, R06.2 external-resource pages (captain-approved additive siblings):
// the per-run evidence egress allow-list. Default-deny stays: without a list
// every external request is refused and the affected checks are inconclusive.
// ---------------------------------------------------------------------------

/** The isolated host the reviewed page renders under; it is served from the project, never the network. */
export const WORKBENCH_REVIEW_PREVIEW_HOST = 'project.od-review.localhost';

/** Per-run egress budgets. Exceeding any of them makes the run inconclusive, never passed. */
export const WORKBENCH_REVIEW_EGRESS_LIMITS = {
  /** Allow-list entries per run. */
  maxHosts: 8,
  /** Network requests (each redirect hop counts) per run. */
  maxRequests: 200,
  /** Response bytes per run. */
  maxBytes: 20 * 1024 * 1024,
  /** Response bytes per request. */
  maxResponseBytes: 5 * 1024 * 1024,
  /** Per request, connect to last byte. */
  requestTimeoutMs: 10_000,
  /** DNS resolution per hop. */
  resolveTimeoutMs: 5_000,
  maxRedirects: 5,
  /** Fetch attempts recorded per run (refused attempts included). */
  maxRecords: 400,
} as const;

export const WORKBENCH_REVIEW_EGRESS_HOST_PROBLEMS = ['empty', 'wildcard', 'scheme-or-path', 'ip-literal', 'special-use', 'invalid-hostname', 'invalid-port', 'restricted-port'] as const;
export type ReviewEgressHostProblem = typeof WORKBENCH_REVIEW_EGRESS_HOST_PROBLEMS[number];

const EGRESS_HOST_MESSAGES: Record<ReviewEgressHostProblem, string> = {
  empty: 'Enter a hostname',
  wildcard: 'Wildcards are not allowed; list each exact hostname',
  'scheme-or-path': 'Enter only a hostname (and an optional :port), without a scheme, path, user or spaces',
  'ip-literal': 'IP addresses are not allowed; list a public hostname',
  'special-use': 'Local, private and special-use names (localhost, .local, .internal, .arpa, …) are not allowed',
  'invalid-hostname': 'Enter a fully qualified ASCII hostname (use the xn-- form for international names)',
  'invalid-port': 'The port must be a number from 1 to 65535',
  'restricted-port': 'Browsers refuse this port (for example 22 or 6000); use the port the site serves over https',
};

/** Ports Chromium refuses to fetch (net::ERR_UNSAFE_PORT, kRestrictedPorts); an entry naming one is refused. */
export const WORKBENCH_REVIEW_EGRESS_RESTRICTED_PORTS: readonly number[] = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];
export const reviewEgressHostMessage = (problem: ReviewEgressHostProblem): string => EGRESS_HOST_MESSAGES[problem];

const SPECIAL_USE_SUFFIXES = ['localhost', 'local', 'internal', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt'];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** WHATWG URL treats a host whose last label is a number (decimal or 0x hex) as IPv4. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|\d+)$/u;

/**
 * Why an allow-list entry is refused, or null when it is an exact public
 * hostname with an optional explicit port, or the page's own preview host.
 * Pure string rules: the daemon still checks every resolved address.
 */
export function reviewEgressHostProblem(raw: string): ReviewEgressHostProblem | null {
  if (raw === '') return 'empty';
  if (raw.includes('*')) return 'wildcard';
  if (/[/\\?#@\s]|\p{Cc}/u.test(raw) || raw.includes('://')) return 'scheme-or-path';
  const value = raw.toLowerCase();
  if (value.startsWith('[') || (value.match(/:/gu)?.length ?? 0) > 1) return 'ip-literal';
  const [host, port] = value.split(':') as [string, string | undefined];
  const labels = host.split('.');
  if (labels.length && NUMERIC_LABEL.test(labels[labels.length - 1]!)) return 'ip-literal';
  if (host === WORKBENCH_REVIEW_PREVIEW_HOST) return port === undefined ? null : 'special-use';
  if (SPECIAL_USE_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return 'special-use';
  if (host.length > 253 || labels.length < 2 || !labels.every(label => HOST_LABEL.test(label))) return 'invalid-hostname';
  if (port !== undefined && (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > 65_535)) return 'invalid-port';
  if (port !== undefined && WORKBENCH_REVIEW_EGRESS_RESTRICTED_PORTS.includes(Number(port))) return 'restricted-port';
  return null;
}

export const reviewEgressHostSchema = z.string().max(260).superRefine((value, ctx) => {
  const problem = reviewEgressHostProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: `${EGRESS_HOST_MESSAGES[problem]} (${problem})`, params: { problem } });
}).transform(value => value.toLowerCase());

/** The per-run allow-list. Empty (or omitted) means default-deny. */
export const reviewEgressPolicySchema = z.object({
  allowHosts: z.array(reviewEgressHostSchema).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxHosts).refine(unique, 'Each host appears once'),
}).strict();

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
/** An external URL as evidence may keep: its origin (scheme, host, port), never a path, query, userinfo or fragment. */
const externalOrigin = z.string().min(1).max(300).regex(/^(?:https?|wss?):\/\/[a-z0-9.-]+(?::\d{1,5})?$/u, 'Expected an origin without a path');
/** Where a request went, without its path or query: how deep the path was and a digest of path plus query. */
/** Deepest path depth recorded; deeper paths record 200 with `pathDepthCapped`. */
export const WORKBENCH_REVIEW_MAX_PATH_DEPTH = 200;
/** Records v2: where a request went, without its path or query. */
const externalLocationV2 = {
  origin: externalOrigin,
  pathDepth: z.number().int().min(0).max(WORKBENCH_REVIEW_MAX_PATH_DEPTH),
  /** SHA-256 of the URL's path and query (`/a/b?x=1`) as the browser sent them, percent-encoding included. */
  pathQuerySha256: hex64,
};
/** Records v3: v2 plus `pathDepthCapped` (true when the real depth exceeded the cap; pathDepth is then exactly the cap). */
const externalLocationV3 = { ...externalLocationV2, pathDepthCapped: z.boolean() };

const capConsistent = (value: { pathDepth: number; pathDepthCapped?: boolean }, ctx: z.RefinementCtx) => {
  if (value.pathDepthCapped && value.pathDepth !== WORKBENCH_REVIEW_MAX_PATH_DEPTH) ctx.addIssue({ code: 'custom', path: ['pathDepth'], message: `A capped path depth is exactly ${WORKBENCH_REVIEW_MAX_PATH_DEPTH}` });
};

/** One attempt to reach an allowed host. `fetched` means a response arrived; its status may still be a failure. */
function egressFetchSchema<L extends z.ZodRawShape, R extends z.ZodTypeAny, T extends z.ZodTypeAny>(location: L, reason: R, resourceType: T) {
  return z.object({
    /** Where the page's request went: origin, path depth and a digest of path and query; never the path itself. */
    ...location,
    /** Length of the request's query (without `?`); 0 when it has none. */
    queryLength: z.number().int().min(0),
    /** The allow-list entry the request matched. */
    host: z.string().min(1).max(260),
    resourceType,
    outcome: z.enum(['fetched', 'refused', 'failed']),
    reason: reason.nullable(),
    /** The checked address the connection was pinned to (last hop). */
    resolvedAddress: z.string().ip().nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    bytes: z.number().int().min(0),
    sha256: hex64.nullable(),
    durationMs: z.number().int().min(0),
    redirects: z.array(z.object({ ...location, status: z.number().int().min(300).max(399), resolvedAddress: z.string().ip() }).strict().superRefine((value, ctx) => capConsistent(value as never, ctx))).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxRedirects),
  }).strict().superRefine((value, ctx) => {
    capConsistent(value as never, ctx);
    if (value.outcome === 'fetched' && (value.resolvedAddress === null || value.status === null || value.sha256 === null)) ctx.addIssue({ code: 'custom', message: 'A fetched record names its address, status and body digest' });
    if (value.outcome !== 'fetched' && !value.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A refused or failed record names its reason' });
  });
}
const legacyResourceType = z.string().min(1).max(40);
/** The record shape the daemon writes (v4: v3 with a structured reason and a resource type from the CDP vocabulary). */
export const reviewEgressFetchSchema = egressFetchSchema(externalLocationV3, reviewEvidenceMessageSchema, z.enum(REVIEW_RESOURCE_TYPES));
const reviewEgressFetchV3Schema = egressFetchSchema(externalLocationV3, line, legacyResourceType);
const reviewEgressFetchV2Schema = egressFetchSchema(externalLocationV2, line, legacyResourceType);

/**
 * Egress evidence records version the daemon writes. v2 replaced v1's `url`
 * (origin + path) and `querySha256` with path-free external locations; v3
 * added `pathDepthCapped`. Readers accept v2 and v3, each strictly.
 */
export const WORKBENCH_REVIEW_EGRESS_SCHEMA = 'workbench-review-egress/4' as const;
export const WORKBENCH_REVIEW_EGRESS_SCHEMA_V3 = 'workbench-review-egress/3' as const;
export const WORKBENCH_REVIEW_EGRESS_SCHEMA_V2 = 'workbench-review-egress/2' as const;

function egressEvidenceObject<S extends string, F extends z.ZodTypeAny, X extends z.ZodTypeAny>(schema: S, fetch: F, exhausted: X) {
  return z.object({
    schema: z.literal(schema),
    allowHosts: z.array(z.string().min(1).max(260)).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxHosts),
    limits: z.object({
      maxRequests: z.number().int().min(0), maxBytes: z.number().int().min(0), maxResponseBytes: z.number().int().min(0),
      requestTimeoutMs: z.number().int().min(0), maxRedirects: z.number().int().min(0),
    }).strict(),
    fetches: z.array(fetch).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxRecords),
    requests: z.number().int().min(0),
    bytes: z.number().int().min(0),
    /** Set when a budget refused requests; the run cannot pass then. */
    exhausted: exhausted.nullable(),
    /**
     * SHA-256 of the canonical allow-list, limits and fetch records. The daemon
     * recomputes it on every save and read and the run freezes it. It is an
     * unkeyed corruption check, not tamper evidence: a writer with access to
     * the data root can recompute it.
     */
    digest: hex64,
  }).strict();
}
const egressHostsAllowed = (value: { allowHosts: string[]; fetches: { host: string }[] }, ctx: z.RefinementCtx) => {
  value.fetches.forEach((fetch, index) => {
    if (!value.allowHosts.includes(fetch.host)) ctx.addIssue({ code: 'custom', path: ['fetches', index, 'host'], message: 'Fetch from a host outside the allow-list' });
  });
};
const reviewEgressEvidenceV4Object = egressEvidenceObject(WORKBENCH_REVIEW_EGRESS_SCHEMA, reviewEgressFetchSchema, reviewEvidenceMessageSchema);
const reviewEgressEvidenceV3Object = egressEvidenceObject(WORKBENCH_REVIEW_EGRESS_SCHEMA_V3, reviewEgressFetchV3Schema, line);
const reviewEgressEvidenceV2Object = egressEvidenceObject(WORKBENCH_REVIEW_EGRESS_SCHEMA_V2, reviewEgressFetchV2Schema, line);
/**
 * The unversioned egress section written before records carried a version
 * (B4-2 commits 80c23e4843 to d27100eb07): records kept `url` (origin + path)
 * and, from cdea09682a, `queryLength` with `querySha256`. Read only; never written.
 */
const egressUrlV1 = z.string().min(1).max(300);
const reviewEgressFetchV1Schema = z.object({
  url: egressUrlV1,
  host: z.string().min(1).max(260),
  resourceType: z.string().min(1).max(40),
  outcome: z.enum(['fetched', 'refused', 'failed']),
  reason: line.nullable(),
  resolvedAddress: z.string().ip().nullable(),
  status: z.number().int().min(100).max(599).nullable(),
  bytes: z.number().int().min(0),
  sha256: hex64.nullable(),
  durationMs: z.number().int().min(0),
  redirects: z.array(z.object({ url: egressUrlV1, status: z.number().int().min(300).max(399), resolvedAddress: z.string().ip() }).strict()).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxRedirects),
  queryLength: z.number().int().min(0).optional(),
  querySha256: hex64.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.queryLength === undefined) !== (value.querySha256 === undefined)) ctx.addIssue({ code: 'custom', path: ['querySha256'], message: 'Query length and digest are recorded together' });
  if (value.queryLength !== undefined && (value.queryLength === 0) !== (value.querySha256 === null)) ctx.addIssue({ code: 'custom', path: ['querySha256'], message: 'A query digest is present exactly when the request had a query' });
  if (value.outcome === 'fetched' && (value.resolvedAddress === null || value.status === null || value.sha256 === null)) ctx.addIssue({ code: 'custom', message: 'A fetched record names its address, status and body digest' });
  if (value.outcome !== 'fetched' && !value.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A refused or failed record names its reason' });
});
const reviewEgressEvidenceV1Object = egressEvidenceObject('unused', reviewEgressFetchV1Schema, line).omit({ schema: true }).strict();

/** What the daemon writes (v4). */
export const reviewEgressEvidenceV4Schema = reviewEgressEvidenceV4Object.superRefine(egressHostsAllowed);
/**
 * What readers accept: every egress section ever written. Versioned sections
 * are a discriminated union on the version string (v3, v2); the unversioned
 * v1 section has no `schema` field. Every version is strict.
 */
export const reviewEgressEvidenceSchema = z.union([
  z.discriminatedUnion('schema', [reviewEgressEvidenceV4Object, reviewEgressEvidenceV3Object, reviewEgressEvidenceV2Object]),
  reviewEgressEvidenceV1Object,
]).superRefine(egressHostsAllowed);

/**
 * Console and exception evidence. Page-originated free text is never
 * persisted: each distinct message keeps its kind, how often it was seen, its
 * length and SHA-256, and where it came from. v1 kept a project path for every
 * preview-origin source; v2 (written now) keeps a project path only for files
 * the review served and records any other preview-origin source as origin plus
 * digest, because a page can name its own source (`//# sourceURL=`). Readers
 * accept v1 and v2, each strictly.
 */
/**
 * The evidence rules a bundle was written under. `workbench-review-evidence/2`
 * (B4-2 round 9, written now): every reason, recovery, summary and observation
 * is a structured message (workbench-review-evidence.ts), never free text.
 * `/1` (round 8) kept typed but rendered strings. A bundle is current only
 * when it carries /2 and passes reviewBundleCurrencyProblems.
 */
export const WORKBENCH_REVIEW_EVIDENCE_VERSION = 'workbench-review-evidence/2' as const;
export const WORKBENCH_REVIEW_EVIDENCE_VERSION_V1 = 'workbench-review-evidence/1' as const;
/** The fixed note every bundle carries. */
export const WORKBENCH_REVIEW_CONFORMANCE_NOTE = 'Automated checks target WCAG 2.2 AA but cannot claim full conformance; manual accessibility and target-device checks stay separate gates.';
export const WORKBENCH_REVIEW_RUNNER_VERSION = 'mechanical/1';
export const WORKBENCH_REVIEW_CONSOLE_SCHEMA = 'workbench-review-console/3' as const;
export const WORKBENCH_REVIEW_CONSOLE_SCHEMA_V2 = 'workbench-review-console/2' as const;
export const WORKBENCH_REVIEW_CONSOLE_SCHEMA_V1 = 'workbench-review-console/1' as const;
const previewOrigin = `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`;
function consoleSourceSchema(previewDigestAllowed: boolean) {
  return z.object({
    origin: z.string().max(300),
    /** Project (preview-origin) files the review served. */
    path: z.string().min(1).max(1024).nullable(),
    /** Every other source: SHA-256 of path plus query. */
    pathQuerySha256: hex64.nullable(),
    /** 1-based. */
    line: z.number().int().min(1),
    column: z.number().int().min(1),
  }).strict().superRefine((value, ctx) => {
    const opaque = /^[a-z][a-z0-9+.-]*:$/u.test(value.origin);
    if (value.origin === previewOrigin) {
      const servedPath = value.path !== null && value.pathQuerySha256 === null;
      const digested = previewDigestAllowed && value.path === null && value.pathQuerySha256 !== null;
      if (!servedPath && !digested) ctx.addIssue({ code: 'custom', message: 'A project source keeps a served path, or only a digest' });
    } else if (opaque) {
      if (value.path !== null || value.pathQuerySha256 !== null) ctx.addIssue({ code: 'custom', message: 'An opaque source keeps only its scheme' });
    } else if (!externalOrigin.safeParse(value.origin).success || value.path !== null || value.pathQuerySha256 === null) {
      ctx.addIssue({ code: 'custom', message: 'An external source keeps only its origin and a digest of path and query' });
    }
  });
}
function consoleEntrySchema(previewDigestAllowed: boolean) {
  return z.object({
    id: z.string().regex(/^console-[0-9a-f]{12}$/u),
    kind: z.enum(['console', 'exception', 'log']),
    level: z.literal('error'),
    count: z.number().int().min(1),
    length: z.number().int().min(0),
    sha256: hex64,
    source: consoleSourceSchema(previewDigestAllowed).nullable(),
    viewports: z.array(z.number().int().min(160).max(7680)).max(48),
  }).strict();
}
/**
 * v3 (written now): an origin the run cannot vouch for (not the preview
 * origin, not on the allow-list, not a known scheme) is kept only as
 * `originSha256`. A preview-origin source keeps a served path or a digest.
 */
const consoleSourceV3Schema = z.object({
  /** The preview origin, an allow-listed origin, or a known scheme (`data:`); null when only its digest is kept. */
  origin: z.string().max(300).nullable(),
  /** SHA-256 of an origin the run could not vouch for. */
  originSha256: hex64.nullable(),
  /** Project files the review served. */
  path: z.string().min(1).max(1024).nullable(),
  /** Every other path: SHA-256 of path plus query. */
  pathQuerySha256: hex64.nullable(),
  /** 1-based. */
  line: z.number().int().min(1),
  column: z.number().int().min(1),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.origin === null) {
    if (value.originSha256 === null || value.path !== null) fail('An unverified source keeps only digests');
    return;
  }
  if (value.originSha256 !== null) fail('A source keeps either its origin or its digest');
  if (value.origin === previewOrigin) {
    if ((value.path === null) === (value.pathQuerySha256 === null)) fail('A project source keeps a served path, or only a digest');
  } else if (/^[a-z][a-z0-9+.-]*:$/u.test(value.origin)) {
    if (value.path !== null || value.pathQuerySha256 !== null) fail('An opaque source keeps only its scheme');
  } else if (!externalOrigin.safeParse(value.origin).success || value.path !== null || value.pathQuerySha256 === null) {
    fail('An allow-listed source keeps only its origin and a digest of path and query');
  }
});
export const reviewConsoleEntrySchema = consoleEntrySchema(true).extend({ source: consoleSourceV3Schema.nullable() }).strict();
const reviewConsoleEvidenceV3Object = z.object({ schema: z.literal(WORKBENCH_REVIEW_CONSOLE_SCHEMA), entries: z.array(reviewConsoleEntrySchema).max(400) }).strict();
const reviewConsoleEvidenceV2Object = z.object({ schema: z.literal(WORKBENCH_REVIEW_CONSOLE_SCHEMA_V2), entries: z.array(consoleEntrySchema(true)).max(400) }).strict();
const reviewConsoleEvidenceV1Object = z.object({ schema: z.literal(WORKBENCH_REVIEW_CONSOLE_SCHEMA_V1), entries: z.array(consoleEntrySchema(false)).max(400) }).strict();
/** What the daemon writes (v3). */
export const reviewConsoleEvidenceV3Schema = reviewConsoleEvidenceV3Object;
/** What readers accept: v1, v2 and v3, discriminated on the version string. */
export const reviewConsoleEvidenceSchema = z.discriminatedUnion('schema', [reviewConsoleEvidenceV3Object, reviewConsoleEvidenceV2Object, reviewConsoleEvidenceV1Object]);
export type ReviewConsoleEntry = z.infer<typeof reviewConsoleEntrySchema>;
export type ReviewConsoleEvidence = z.infer<typeof reviewConsoleEvidenceV3Schema>;
export type StoredReviewConsoleEvidence = z.infer<typeof reviewConsoleEvidenceSchema>;

export type ReviewEgressPolicy = z.infer<typeof reviewEgressPolicySchema>;
export type ReviewEgressFetch = z.infer<typeof reviewEgressFetchSchema>;
/** What the daemon writes (v4). */
export type ReviewEgressEvidence = z.infer<typeof reviewEgressEvidenceV4Schema>;
/** What a stored bundle may carry (v2 or v3). */
export type StoredReviewEgressEvidence = z.infer<typeof reviewEgressEvidenceSchema>;

export const WORKBENCH_REVIEW_BUNDLE_ID_PATTERN = /^rv_[A-Za-z0-9_-]{1,64}$/u;
/** `motion` is opt-in (B4-2b) and has no mandatory criterion; the others back the six core criteria. */
export const WORKBENCH_MECHANICAL_PARAMETER_TYPES = ['cta', 'contrast', 'console-resources', 'overflow', 'keyboard-focus', 'document-semantics', 'motion'] as const;

/** One check's verdict. Only `pass` and `not-applicable` resolve a required check. */
export const mechanicalCheckOutcomeSchema = z.enum(['pass', 'fail', 'inconclusive', 'not-applicable']);
/**
 * Overall rule (technical-spec "Reviews and components"): a confirmed required
 * mechanical failure → failed; otherwise missing/inconclusive required evidence
 * or unresolved required judgment/manual checks → inconclusive; otherwise passed.
 */
export const reviewOutcomeSchema = z.enum(['passed', 'failed', 'inconclusive']);

const evidenceSchema = z.object({
  id: identifier(120),
  /** CSS-pixel viewport width the observation was made at; null for run-level evidence. */
  viewport: z.number().int().min(160).max(7680).nullable(),
  type: z.enum(['probe', 'console', 'network', 'computed-style', 'accessibility-tree', 'keyboard-trace', 'environment']),
  summary: evidenceText,
  observations: z.array(evidenceText).max(60),
  /**
   * R03 evidence detail: what the check measured at this width (counts,
   * sizes, ratios, colours, vocabulary names), whatever its outcome, so a
   * reviewer can verify a pass as well as a failure. Absent on bundles
   * written before it existed.
   */
  detail: z.array(evidenceText).max(24).optional(),
}).strict();

const checkResultSchema = z.object({
  checkId: identifier(64),
  criterionId: z.enum(WORKBENCH_MANDATORY_CRITERION_IDS).nullable(),
  parameterType: z.enum(WORKBENCH_MECHANICAL_PARAMETER_TYPES),
  /** True when the rubric omitted this mandatory criterion and the runner used its unweakened default. */
  synthesized: z.boolean(),
  required: z.boolean(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  outcome: mechanicalCheckOutcomeSchema,
  reason: evidenceText,
  evidenceIds: z.array(identifier(120)).max(200),
  /** Present when the outcome is inconclusive because the environment could not produce evidence. */
  recovery: evidenceText.optional(),
}).strict();

const sourceHashSchema = z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();

// ---------------------------------------------------------------------------
// B5-1, AC-R06.5 (captain-approved additive siblings): behavior the frozen
// evidence observed. A dialog, tab, input or animation seen here makes the
// checks that depend on it applicable; `unknown` keeps them inconclusive.
// ---------------------------------------------------------------------------

export const WORKBENCH_OBSERVED_BEHAVIORS = REVIEW_OBSERVED_BEHAVIORS;
export const observedBehaviorSchema = z.enum(WORKBENCH_OBSERVED_BEHAVIORS);
export const observedBehaviorRecordSchema = z.object({
  behavior: observedBehaviorSchema,
  /** `unknown` when no capture could tell (no browser, a failed width, or a probe that did not report it). */
  state: z.enum(['observed', 'not-observed', 'unknown']),
  /** Most instances seen at any one width. */
  count: z.number().int().min(0),
  /** Widths it was seen at. */
  viewports: z.array(z.number().int().min(160).max(7680)).max(48),
  /** Evidence v2: where it was seen, as structural selectors (or the page-text token for anything else); never page text. */
  samples: z.array(reviewEvidenceParamSchema.refine((param): boolean => param.kind === 'selector' || param.kind === 'token', 'A behavior sample is a structural selector or a page-text token')).max(10),
}).strict().superRefine((value, ctx) => {
  if ((value.state === 'observed') !== (value.count > 0)) ctx.addIssue({ code: 'custom', path: ['count'], message: 'An observed behavior has a count; any other state has none' });
});

export const verificationBundleSchema = z.object({
  schema: z.literal('workbench-verification-bundle/1'),
  id: z.string().regex(WORKBENCH_REVIEW_BUNDLE_ID_PATTERN),
  projectId: identifier(200),
  entry: z.string().min(1).max(1024),
  /** Project files the evidence worker actually served while rendering, with their SHA-256. */
  sourceHashes: z.array(sourceHashSchema).max(2000),
  contextRevision: z.number().int().min(0),
  rubricRevision: z.number().int().min(0),
  /** The isolated origin the page was rendered under; all other network egress is blocked. */
  previewOrigin: z.string().min(1).max(200),
  environment: z.object({
    worker: z.enum(['cdp-chromium', 'unavailable']),
    browserVersion: z.string().max(200).nullable(),
    runnerVersion: z.string().max(40),
  }).strict(),
  viewports: z.array(z.number().int().min(160).max(7680)).min(1).max(48).refine(unique, 'Duplicate viewport'),
  startedAt: timestamp,
  endedAt: timestamp,
  results: z.array(checkResultSchema).max(WORKBENCH_REVIEW_MAX_CHECK_IDS),
  evidence: z.array(evidenceSchema).max(2000),
  /** Required judgment/manual rubric checks this mechanical run cannot resolve. */
  unresolvedRequiredChecks: z.array(identifier(64)).max(100),
  outcome: reviewOutcomeSchema,
  /** Automation never claims full WCAG 2.2 AA conformance. */
  conformanceNote: line,
  /** B4-2: the run's egress allow-list and every allowed fetch; absent on bundles written before it existed. */
  egress: reviewEgressEvidenceSchema.optional(),
  /** Console and exception records without message bodies (absent on bundles written before them). */
  console: reviewConsoleEvidenceSchema.optional(),
  /** Written on every new bundle; absent on bundles written before typed evidence. */
  evidenceVersion: z.enum([WORKBENCH_REVIEW_EVIDENCE_VERSION, WORKBENCH_REVIEW_EVIDENCE_VERSION_V1]).optional(),
  /**
   * Set by the daemon when it serves a bundle that is not current (no
   * evidenceVersion, or any section older than current). The stored bytes are
   * kept as the user's local history; what is served tokenizes their free
   * text, and none of it is sent to a reviewer, exported or shared. Never
   * written to storage.
   */
  legacy: z.literal(true).optional(),
  /** B5-1: behavior the captures observed (AC-R06.5 applicability); absent on bundles written before it existed. */
  observedBehaviors: z.array(observedBehaviorRecordSchema).max(WORKBENCH_OBSERVED_BEHAVIORS.length).refine(values => unique(values.map(value => value.behavior)), 'Each behavior appears once').optional(),
  /**
   * B4-2b: allowed-host requests made while the motion phases reloaded the
   * page, recorded with the same redaction as `egress` (origin and path,
   * query only as length and SHA-256). Kept apart so they spend their own
   * budget and never trigger the run's egress budget or change blockers;
   * present only when the rubric declared a motion check.
   */
  motionEgress: reviewEgressEvidenceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.motionEgress && value.egress && (value.motionEgress.allowHosts.length !== value.egress.allowHosts.length || value.motionEgress.allowHosts.some((host, index) => host !== value.egress!.allowHosts[index]))) {
    ctx.addIssue({ code: 'custom', path: ['motionEgress', 'allowHosts'], message: 'Motion egress uses the run allow-list' });
  }
  if (!unique(value.results.map(result => result.checkId))) ctx.addIssue({ code: 'custom', path: ['results'], message: 'Duplicate check result' });
  const evidenceIds = new Set(value.evidence.map(item => item.id));
  if (evidenceIds.size !== value.evidence.length) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Duplicate evidence id' });
  value.results.forEach((result, index) => {
    if (result.evidenceIds.some(id => !evidenceIds.has(id))) ctx.addIssue({ code: 'custom', path: ['results', index, 'evidenceIds'], message: 'Result cites unknown evidence' });
  });
  for (const id of WORKBENCH_MANDATORY_CRITERION_IDS) {
    if (!value.results.some(result => result.criterionId === id && result.required)) ctx.addIssue({ code: 'custom', path: ['results'], message: `Missing mandatory criterion ${id}` });
  }
  const failed = value.results.some(result => result.required && result.outcome === 'fail');
  const open = value.results.some(result => result.required && result.outcome === 'inconclusive') || value.unresolvedRequiredChecks.length > 0;
  const expected = failed ? 'failed' : open ? 'inconclusive' : 'passed';
  if (value.outcome !== expected) ctx.addIssue({ code: 'custom', path: ['outcome'], message: `Outcome must be ${expected} for these results` });
  if (value.environment.worker === 'unavailable' && value.outcome === 'passed') ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'A review without a browser worker cannot pass' });
  if (value.egress?.exhausted && value.outcome === 'passed') ctx.addIssue({ code: 'custom', path: ['egress', 'exhausted'], message: 'A review that exhausted its egress budget cannot pass' });
  // Every structured message names only what this bundle can vouch for.
  for (const problem of messageProblems(value)) ctx.addIssue({ code: 'custom', message: problem });
});

/** Every stored text field of a bundle: result reasons and recovery, evidence summaries, observations and detail, egress and motion egress v4 reasons. */
function bundleTexts(bundle: VerificationBundle): (ReviewEvidenceMessage | string)[] {
  const texts: (ReviewEvidenceMessage | string)[] = [];
  for (const result of bundle.results) { texts.push(result.reason); if (result.recovery !== undefined) texts.push(result.recovery); }
  for (const item of bundle.evidence) texts.push(item.summary, ...item.observations, ...(item.detail ?? []));
  for (const egress of [bundle.egress, bundle.motionEgress]) {
    if (egress && 'schema' in egress && egress.schema === WORKBENCH_REVIEW_EGRESS_SCHEMA) {
      for (const fetch of egress.fetches) if (fetch.reason) texts.push(fetch.reason as ReviewEvidenceMessage);
      if (egress.exhausted) texts.push(egress.exhausted as ReviewEvidenceMessage);
    }
  }
  return texts;
}

const allowedOriginsOf = (bundle: Pick<VerificationBundle, 'egress'>) => new Set((bundle.egress?.allowHosts ?? []).map(host => `https://${host}`));
const servedPathsOf = (bundle: Pick<VerificationBundle, 'sourceHashes'>) => new Set(bundle.sourceHashes.map(item => item.path));
const servedPathOf = (urlPath: string): string | null => { try { return decodeURIComponent(urlPath).replace(/^\/+/u, ''); } catch { return null; } };

/** What a bundle vouches for: the files it served, its egress allow-list and its console records. */
export type ReviewEvidenceVouch = Pick<VerificationBundle, 'sourceHashes' | 'egress' | 'console'>;

/**
 * What one structured message names that the bundle cannot vouch for (empty
 * when it may stand): a location's origin is the preview origin, an
 * allow-listed origin or a known scheme; a location path or a path parameter
 * is a file the review served (sourceHashes); a host is on the allow-list; a
 * console reference is one of the bundle's console records. The runner uses it
 * to drop a single advisory detail message rather than the whole bundle.
 */
export function reviewEvidenceMessageProblems(message: ReviewEvidenceMessage, vouch: ReviewEvidenceVouch): string[] {
  const problems: string[] = [];
  const origins = allowedOriginsOf(vouch); const served = servedPathsOf(vouch);
  const hosts = new Set((vouch.egress?.allowHosts ?? []).map(host => host.split(':')[0]!));
  const consoleIds = new Set((vouch.console?.entries ?? []).map(entry => entry.id));
  for (const param of reviewEvidenceParams(message)) {
    if (param.kind === 'location') {
      if (param.origin !== null && param.origin.includes('//') && param.origin !== previewOrigin && !origins.has(param.origin)) problems.push(`${message.template}: a location names an origin the run did not allow`);
      if (param.path !== null && (param.origin !== previewOrigin || !served.has(servedPathOf(param.path) ?? ''))) problems.push(`${message.template}: a location names a path the review did not serve`);
    }
    if (param.kind === 'path' && !served.has(param.value)) problems.push(`${message.template}: a path the review did not serve`);
    if (param.kind === 'host' && !hosts.has(param.value)) problems.push(`${message.template}: a host outside the allow-list`);
    if (param.kind === 'consoleRef' && !consoleIds.has(param.value)) problems.push(`${message.template}: an unknown console record`);
  }
  return problems;
}

/** Every structured message of a bundle checked against what the bundle vouches for. */
function messageProblems(bundle: VerificationBundle): string[] {
  return bundleTexts(bundle).flatMap(text => isReviewEvidenceMessage(text) ? reviewEvidenceMessageProblems(text, bundle) : []);
}

/**
 * Why a bundle is not current evidence (empty when it is). A current bundle
 * carries evidence version /2, console records v3, egress records v4 when it
 * has egress, a structured message in every text field, and only the fixed
 * values for its note, preview origin and runner; console sources name only
 * served paths and allowed origins; and every rubric-key parameter is a key of
 * the rubric and context the review was planned from (`rubricKeys`, which the
 * caller derives from the frozen inputs; without it no rubric key verifies).
 * Anything else, whatever its labels say, is read through the legacy path and
 * never sent to a model.
 */
export function reviewBundleCurrencyProblems(bundle: VerificationBundle, options: { rubricKeys?: ReadonlySet<string> | null } = {}): string[] {
  const problems: string[] = [];
  for (const text of bundleTexts(bundle)) {
    if (!isReviewEvidenceMessage(text)) continue;
    if (reviewEvidenceParams(text).some(param => param.kind === 'rubricKey' && !options.rubricKeys?.has(param.value))) problems.push(`${text.template}: a rubric key the frozen rubric and context do not name`);
  }
  if (bundle.legacy) problems.push('marked legacy');
  if (bundle.evidenceVersion !== WORKBENCH_REVIEW_EVIDENCE_VERSION) problems.push('not evidence version /2');
  if (bundle.console?.schema !== WORKBENCH_REVIEW_CONSOLE_SCHEMA) problems.push('console records are not v3');
  if (bundle.egress && !('schema' in bundle.egress && bundle.egress.schema === WORKBENCH_REVIEW_EGRESS_SCHEMA)) problems.push('egress records are not v4');
  if (bundle.motionEgress && !('schema' in bundle.motionEgress && bundle.motionEgress.schema === WORKBENCH_REVIEW_EGRESS_SCHEMA)) problems.push('motion egress records are not v4');
  if (bundleTexts(bundle).some(text => typeof text === 'string')) problems.push('free text in a reason, recovery, summary or observation');
  if (bundle.conformanceNote !== WORKBENCH_REVIEW_CONFORMANCE_NOTE) problems.push('unexpected conformance note');
  if (bundle.previewOrigin !== previewOrigin) problems.push('unexpected preview origin');
  if (bundle.environment.runnerVersion !== WORKBENCH_REVIEW_RUNNER_VERSION) problems.push('unexpected runner version');
  if (bundle.environment.browserVersion !== null && !/^[A-Za-z]{1,40}\/[0-9][0-9.]{0,40}$/u.test(bundle.environment.browserVersion)) problems.push('unexpected browser version');
  if ((bundle.egress?.allowHosts ?? []).some(host => reviewEgressHostProblem(host) !== null)) problems.push('an allow-list entry is not a valid host');
  const origins = allowedOriginsOf(bundle); const served = servedPathsOf(bundle);
  if (bundle.console?.schema === WORKBENCH_REVIEW_CONSOLE_SCHEMA) {
    for (const entry of bundle.console.entries) {
      const source = entry.source; if (!source) continue;
      if (source.path !== null && !served.has(servedPathOf(source.path) ?? '')) problems.push('a console source names a path the review did not serve');
      if (source.origin !== null && source.origin.includes('//') && source.origin !== previewOrigin && !origins.has(source.origin)) problems.push('a console source names an origin the run did not allow');
    }
  }
  return problems;
}

/** Every text field of a bundle rendered from the evidence template table (what `od ... --lang` prints beside the bundle). */
export function renderVerificationBundleText(bundle: VerificationBundle, locale: ReviewEvidenceLocale) {
  const text = (value: ReviewEvidenceMessage | string) => renderReviewEvidenceText(value, locale);
  return {
    locale,
    results: bundle.results.map(result => ({ checkId: result.checkId, reason: text(result.reason), ...(result.recovery !== undefined ? { recovery: text(result.recovery) } : {}) })),
    evidence: bundle.evidence.map(item => ({ id: item.id, summary: text(item.summary), observations: item.observations.map(text), ...(item.detail ? { detail: item.detail.map(text) } : {}) })),
  };
}

export const isCurrentVerificationBundle = (bundle: VerificationBundle, options: { rubricKeys?: ReadonlySet<string> | null } = {}): boolean => reviewBundleCurrencyProblems(bundle, options).length === 0;

/** POST /api/workbench/projects/:id/review/mechanical */
export const runMechanicalReviewRequestSchema = z.object({
  /** Project-relative HTML entry to render; defaults to index.html. */
  entry: z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !value.split(/[\\/]/u).some(part => part === '..' || part.startsWith('.')) && !/\p{Cc}/u.test(value), 'Expected a project-relative path without dot segments').default('index.html'),
  /** B4-2: opt-in hosts the evidence worker may fetch for this run; omitted means default-deny. */
  egress: reviewEgressPolicySchema.optional(),
}).strict();

export const verificationBundleSummarySchema = z.object({
  id: z.string().regex(WORKBENCH_REVIEW_BUNDLE_ID_PATTERN), entry: z.string(), outcome: reviewOutcomeSchema, startedAt: timestamp, endedAt: timestamp,
  /** The bundle was recorded before evidence redaction (see verificationBundleSchema.legacy). */
  legacy: z.literal(true).optional(),
}).strict();
export const verificationBundleListSchema = z.object({ projectId: identifier(200), bundles: z.array(verificationBundleSummarySchema).max(200) }).strict();

export type MechanicalCheckOutcome = z.infer<typeof mechanicalCheckOutcomeSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
export type VerificationEvidence = z.infer<typeof evidenceSchema>;
export type MechanicalCheckResult = z.infer<typeof checkResultSchema>;
export type VerificationBundle = z.infer<typeof verificationBundleSchema>;
export type RunMechanicalReviewRequest = z.infer<typeof runMechanicalReviewRequestSchema>;
export type VerificationBundleSummary = z.infer<typeof verificationBundleSummarySchema>;
export type VerificationBundleList = z.infer<typeof verificationBundleListSchema>;
export const parseVerificationBundle = (input: unknown): VerificationBundle => verificationBundleSchema.parse(input);
export const parseRunMechanicalReviewRequest = (input: unknown): RunMechanicalReviewRequest => runMechanicalReviewRequestSchema.parse(input);
export const parseVerificationBundleList = (input: unknown): VerificationBundleList => verificationBundleListSchema.parse(input);

const HTML_ENTRY_PATTERN = /\.html?$/iu;

/**
 * J4-01: the review Start form (and the `od workbench review start` input
 * file) defaulted its entry to a hardcoded `index.html` no matter which page
 * the project actually serves. Both callers resolve this instead: the
 * project's currently open file when it is HTML, else the project's first
 * HTML file (as `GET /api/projects/:id/files` orders them, newest first),
 * else the entry of the project's last review run. `null` means none of the
 * three tiers resolved anything (a brand-new project with no HTML files and
 * no prior run); the caller decides its own final fallback.
 */
export function resolveDefaultReviewEntry(input: {
  activeFileName?: string | null;
  projectFileNames?: readonly string[];
  lastRunEntry?: string | null;
}): string | null {
  const isHtml = (name: string | null | undefined): name is string => typeof name === 'string' && name.length > 0 && HTML_ENTRY_PATTERN.test(name);
  if (isHtml(input.activeFileName)) return input.activeFileName;
  const firstHtml = input.projectFileNames?.find(isHtml);
  if (firstHtml) return firstHtml;
  return input.lastRunEntry ?? null;
}

// ---------------------------------------------------------------------------
// U2, R03 review runs (captain-approved in batch 2): additive siblings for the collect-review
// operation (POST /api/workbench/reviews). Nothing above changes.
// ---------------------------------------------------------------------------

/** Product-review roles (AC-R03.2). The default plan selects all three as required. */
export const WORKBENCH_REVIEWER_ROLES = ['jev-text', 'claude-visual', 'deepseek-adversarial', 'gemini-second-family'] as const;
/** Roles the default plan selects as required; later roles are optional unless the caller marks them required (D7: advisory second family). */
export const WORKBENCH_DEFAULT_REQUIRED_ROLES = ['jev-text', 'claude-visual', 'deepseek-adversarial'] as const;
/** Lanes that belong to implementation review, never product acceptance (AC-R03.2). */
export const WORKBENCH_IMPLEMENTATION_REVIEW_ONLY = ['grok', 'grok-architecture'] as const;
export const WORKBENCH_REVIEW_RUN_ID_PATTERN = /^rr_[A-Za-z0-9_-]{1,64}$/u;
/** Multi-model scope needs at least this many successful independent model records. */
export const WORKBENCH_MIN_INDEPENDENT_REVIEWERS = 2;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const runId = z.string().regex(WORKBENCH_REVIEW_RUN_ID_PATTERN);
const checkId = identifier(64);

export const reviewerRoleSchema = z.enum(WORKBENCH_REVIEWER_ROLES);
/** Accepts a product role; names an implementation-only lane explicitly so callers can say why. */
const requestedReviewerRoleSchema = z.string().superRefine((value, ctx) => {
  if ((WORKBENCH_IMPLEMENTATION_REVIEW_ONLY as readonly string[]).includes(value)) ctx.addIssue({ code: 'custom', message: `${value} is implementation review only, not a product reviewer` });
  else if (!(WORKBENCH_REVIEWER_ROLES as readonly string[]).includes(value)) ctx.addIssue({ code: 'custom', message: `Unknown reviewer role; use one of ${WORKBENCH_REVIEWER_ROLES.join(', ')}` });
}).transform(value => value as z.infer<typeof reviewerRoleSchema>);

export const reviewScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('checks'), checkIds: z.array(checkId).min(1).max(WORKBENCH_REVIEW_MAX_CHECK_IDS).refine(unique, 'Duplicate check id') }).strict(),
]);
const reviewerPlanEntrySchema = z.object({ role: reviewerRoleSchema, required: z.boolean() }).strict();
export const reviewerPlanSchema = z.object({
  reviewers: z.array(z.object({ role: requestedReviewerRoleSchema, required: z.boolean() }).strict()).max(WORKBENCH_REVIEWER_ROLES.length)
    .refine(values => unique(values.map(value => value.role)), 'Each reviewer role appears once'),
}).strict();

/** POST /api/workbench/reviews — the collect-review operation (technical-spec "Collect/review R03/R06"). */
export const startReviewRunRequestSchema = z.object({
  projectId: identifier(200),
  /** The saved revision to review: the entry file and, optionally, one of its saved version ids (must be current). */
  snapshot: z.object({ entry: runMechanicalReviewRequestSchema.shape.entry, versionId: identifier(128).nullable().default(null) }).strict(),
  scope: reviewScopeSchema.default({ kind: 'all' }),
  /** The rubric revision the caller reviewed against; a newer one answers 409. Zero means no rubric. */
  rubricRevision: z.number().int().min(0),
  /** Omitted: Jev, Claude visual critic and DeepSeek Flash required, plus the Gemini second-family reviewer as optional. */
  reviewerPlan: reviewerPlanSchema.optional(),
  /** B4-2: opt-in hosts the evidence worker may fetch for this run; omitted means default-deny. */
  egress: reviewEgressPolicySchema.optional(),
}).strict();

/**
 * A reviewer's claim about one check. `evidence-linked` claims cite at least one
 * verification-bundle evidence id; anything else is labeled `judgment` (AC-R03.2).
 * `supports`/`disputes` are relative to the check passing; neither a verdict nor
 * a probability changes the run outcome (AC-R03.3).
 */
/**
 * Why a reviewer declined to score a check it was asked about. `insufficient-visual-evidence`:
 * a text-only reviewer had no measured visual facts for a check that needs the rendered look.
 * `insufficient-text-evidence`: a copy-quality judgment (specificity, repetition) for a
 * text-only reviewer, which sees page copy only as length and hash tokens. Either way it
 * answers uncertain instead of guessing.
 */
export const WORKBENCH_REVIEW_ABSTAIN_REASONS = ['insufficient-visual-evidence', 'insufficient-text-evidence'] as const;
export const reviewFindingSchema = z.object({
  id: identifier(120),
  reviewerRole: reviewerRoleSchema,
  checkId,
  verdict: z.enum(['supports', 'disputes', 'uncertain']),
  kind: z.enum(['evidence-linked', 'judgment']),
  evidenceRefs: z.array(identifier(120)).max(20).refine(unique, 'Duplicate evidence ref'),
  rationale: z.string().max(2000),
  probability: z.number().min(0).max(1).nullable(),
  /** D7: explicit user decisions, oldest first. Absent on legacy/undecided findings. */
  decisions: z.array(reviewFindingDecisionSchema).max(100).optional(),
  /** R03: set when the reviewer abstained; the finding is then an uncertain judgment with no probability. */
  abstainReason: z.enum(WORKBENCH_REVIEW_ABSTAIN_REASONS).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'evidence-linked' && !value.evidenceRefs.length) ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'An evidence-linked claim cites evidence; otherwise label it a judgment' });
  if (value.abstainReason && (value.verdict !== 'uncertain' || value.probability !== null || value.kind !== 'judgment' || value.evidenceRefs.length)) ctx.addIssue({ code: 'custom', path: ['abstainReason'], message: 'An abstention is an uncertain judgment with no probability and no evidence' });
});

export const reviewerStatusSchema = z.enum(['pending', 'running', 'completed', 'skipped', 'failed', 'cancelled']);
/**
 * R03: the cause of a skipped, failed or cancelled reviewer, as a closed code
 * beside its human reason (UI and CLI label it per locale). Codes are
 * permanent: a stored record names them.
 */
export const WORKBENCH_REVIEWER_REASON_CODES = [
  // Setup
  'not-configured', 'unavailable', 'availability-check-failed', 'key-missing', 'cli-missing', 'cli-auth-missing', 'cli-outdated', 'cli-failed',
  // Visual critic input
  'screenshot-read-denied', 'screenshot-read-failed', 'screenshot-not-read', 'screenshot-unavailable',
  // Run policy
  'no-applicable-checks', 'daily-limit', 'legacy-evidence', 'inputs-changed',
  // Provider call
  'timeout', 'provider-unreachable', 'provider-auth-rejected', 'provider-error', 'invalid-response', 'no-verdicts',
  // Run lifecycle
  'run-stopped', 'operation-failed', 'daemon-restart', 'unexpected-error',
] as const;
export const reviewerReasonCodeSchema = z.enum(WORKBENCH_REVIEWER_REASON_CODES);
export const reviewerRecordSchema = z.object({
  role: reviewerRoleSchema,
  required: z.boolean(),
  provider: z.enum(['typesafe-jev', 'claude-max', 'deepseek', 'gemini', 'openrouter']),
  modelId: identifier(120),
  adapterVersion: identifier(40),
  billingLane: z.enum(['typesafe-system-one', 'max-subscription', 'deepseek-metered', 'gemini-subscription', 'openrouter-metered']),
  /** `text-only-fallback`: a visual critic that could not read screenshots; its claims are judgments. */
  inputMode: z.enum(['text', 'vision', 'text-only-fallback']).nullable(),
  status: reviewerStatusSchema,
  reason: line.nullable(),
  recovery: line.nullable(),
  /** R03: the closed cause behind `reason`; absent on records written before codes existed. */
  reasonCode: reviewerReasonCodeSchema.optional(),
  inputDigest: sha256.nullable(),
  assignedCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS),
  /** Assigned checks a completed reviewer left unanswered; such a reviewer is not an independent completion. */
  unansweredCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS).default([]),
  /**
   * B5-1: provider calls actually sent for this reviewer (a reviewer's checks are split into calls no larger
   * than its limit). Persisted before each call, so a restart rebuilds the daily billed-call count exactly.
   * Absent on records written before it existed; those count as one call.
   */
  providerCalls: z.number().int().min(0).optional(),
  /** The provider's raw structured output, stored verbatim (bounded); never a fabricated explanation. */
  rawOutput: z.string().max(64_000).nullable(),
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
}).strict().superRefine((value, ctx) => {
  if (['skipped', 'failed', 'cancelled'].includes(value.status) && (!value.reason || !value.recovery)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'An unavailable reviewer shows its reason and recovery' });
  if (value.reasonCode && !['skipped', 'failed', 'cancelled'].includes(value.status)) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: 'Only a skipped, failed or cancelled reviewer carries a reason code' });
  if (value.status === 'completed' && value.rawOutput === null) ctx.addIssue({ code: 'custom', path: ['rawOutput'], message: 'A completed reviewer stores its raw output' });
  if (value.unansweredCheckIds.some(id => !value.assignedCheckIds.includes(id))) ctx.addIssue({ code: 'custom', path: ['unansweredCheckIds'], message: 'Only assigned checks can be unanswered' });
});

/** A reviewer counts toward multi-model scope only when it completed and answered every assigned check. */
export function isIndependentReviewerCompletion(reviewer: Pick<z.infer<typeof reviewerRecordSchema>, 'status' | 'unansweredCheckIds'>): boolean {
  return reviewer.status === 'completed' && reviewer.unansweredCheckIds.length === 0;
}

export const reviewRunReasonSchema = z.object({
  code: z.enum(['mandatory-check-failed', 'mandatory-evidence-missing', 'required-checks-unresolved', 'fewer-than-two-independent-reviewers', 'required-reviewer-incomplete', 'run-interrupted', 'operation-failed', 'inputs-changed']),
  message: line,
}).strict();

// ---------------------------------------------------------------------------
// B5-1, AC-R06.3/R06.4/R06.5 (captain-approved additive siblings): the
// per-check verdicts a run reports, and the rubric-content versions it froze.
// ---------------------------------------------------------------------------

/** Where an effective check came from: the project rubric, an unweakened mandatory default, a seeded judgment, or a checklist criterion. */
export const WORKBENCH_CHECK_ORIGINS = ['rubric', 'mandatory-default', 'judgment-seed', 'checklist'] as const;
/**
 * One check's verdict. `pass`/`fail`/`inconclusive`/`not-applicable` come from
 * mechanical evidence only. `judged` means two or more independent reviewers
 * answered an optional judgment check; it is never a pass. `unreviewed` means
 * fewer than two did; it never blocks, so only an optional judgment can be
 * unreviewed. `awaiting-manual` and `awaiting-acceptance` are explicit human
 * gates: a required one keeps the run from passing.
 */
export const WORKBENCH_CHECK_VERDICT_STATUSES = ['pass', 'fail', 'inconclusive', 'not-applicable', 'judged', 'awaiting-manual', 'awaiting-acceptance', 'unreviewed'] as const;
/** Statuses that keep a required check from resolving. */
export const WORKBENCH_BLOCKING_VERDICT_STATUSES = ['fail', 'inconclusive', 'awaiting-manual', 'awaiting-acceptance'] as const;
export const reviewCheckVerdictSchema = z.object({
  checkId,
  kind: z.enum(['mechanical', 'judgment', 'manual']),
  origin: z.enum(WORKBENCH_CHECK_ORIGINS),
  required: z.boolean(),
  status: z.enum(WORKBENCH_CHECK_VERDICT_STATUSES),
  /** Evidence v2: a structured message from the evidence template table (rendered per locale), never free text. */
  reason: reviewEvidenceMessageSchema,
  applicability: z.object({
    status: z.enum(['applicable', 'not-applicable', 'undetermined']),
    /** always; observed / not-observed (frozen evidence); declared (rubric); unknown (no observation); mismatch (declared and observed disagree); target (the reviewed target kind). */
    basis: z.enum(['always', 'observed', 'not-observed', 'declared', 'unknown', 'mismatch', 'target']),
    evaluator: identifier(200),
    behaviors: z.array(observedBehaviorSchema).max(WORKBENCH_OBSERVED_BEHAVIORS.length),
  }).strict(),
  /** The mechanical result this verdict reads (itself, or the mandatory check a checklist criterion maps to). */
  mechanicalCheckId: checkId.nullable(),
  /** W2: that result's outcome, so a required check can never read not-applicable while its result failed or is open. */
  mechanicalOutcome: mechanicalCheckOutcomeSchema.nullable().optional(),
  sourceCriteria: z.array(z.object({ sourceId: z.enum(RESOURCE_SOURCE_IDS), revisionOrDigest: identifier(256), criterionId: identifier(200), canonicalUrl: z.string().min(1).max(2048) }).strict()).max(12),
  /** Answers from independent completed reviewers; they inform, never decide. */
  reviewerAnswers: z.object({ supports: z.number().int().min(0), disputes: z.number().int().min(0), uncertain: z.number().int().min(0) }).strict(),
  evidenceIds: z.array(identifier(120)).max(200),
}).strict().superRefine((value, ctx) => {
  const mismatch = value.applicability.basis === 'mismatch';
  // Only mechanical evidence (a probe, or the observed behavior behind a mismatch) passes or fails a check.
  if (value.kind !== 'mechanical' && (value.status === 'pass' || (value.status === 'fail' && !mismatch))) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Only mechanical evidence passes or fails a check; judgment and manual checks resolve through people' });
  if (value.kind !== 'mechanical' && value.status === 'not-applicable' && value.applicability.status !== 'not-applicable') ctx.addIssue({ code: 'custom', path: ['applicability'], message: 'A not-applicable verdict names its applicability basis' });
  if (mismatch && value.required && value.status !== 'fail') ctx.addIssue({ code: 'custom', path: ['status'], message: 'A declared-versus-observed mismatch fails a required check' });
  if (value.kind === 'mechanical' && value.required && value.status === 'not-applicable' && (value.mechanicalOutcome === 'fail' || value.mechanicalOutcome === 'inconclusive')) ctx.addIssue({ code: 'custom', path: ['status'], message: 'A required mechanical check cannot be not-applicable while its result failed or is inconclusive' });
  if (value.status === 'unreviewed' && (value.kind !== 'judgment' || value.required)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Only an optional judgment can be unreviewed; a required one stays awaiting acceptance' });
});
/** Versions of the daemon-authored rubric content a run applied (judgment seeds, checklist criteria). */
export const reviewRubricContentSchema = z.object({
  judgmentSeeds: identifier(60),
  checklistCriteria: identifier(60),
  checklistSource: z.object({ sourceId: z.enum(RESOURCE_SOURCE_IDS), revisionOrDigest: identifier(256) }).strict(),
}).strict();
export const reviewOperationStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'interrupted']);
export const reviewInterruptReasonSchema = z.enum(['user-cancelled', 'daemon-restart', 'worker-lost', 'timeout', 'superseded']);

export const reviewRunSchema = z.object({
  schema: z.literal('workbench-review-run/1'),
  id: runId,
  projectId: identifier(200),
  /** The durable WorkbenchOperation record for this collect-review run. */
  operation: z.object({
    id: identifier(120),
    kind: z.literal('collect-review'),
    status: reviewOperationStatusSchema,
    stage: z.enum(['queued', 'mechanical', 'reviewers', 'finished']),
    interruptReason: reviewInterruptReasonSchema.nullable(),
    attempt: z.number().int().min(1),
    idempotencyKey: identifier(200),
    inputDigest: sha256,
    cancelRequested: z.boolean(),
    error: line.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).strict(),
  /** Everything the run froze at start (AC-R03.1); `sourceHashes` arrive with the mechanical evidence. */
  frozen: z.object({
    snapshot: z.object({ entry: z.string().min(1).max(1024), versionId: identifier(128).nullable(), contentDigest: sha256.nullable() }).strict(),
    scope: reviewScopeSchema,
    rubricRevision: z.number().int().min(0),
    contextRevision: z.number().int().min(0),
    sourceHashes: z.array(sourceHashSchema).max(2000),
    plan: z.object({
      mechanicalCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS),
      judgmentCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS),
      reviewers: z.array(reviewerPlanEntrySchema).max(WORKBENCH_REVIEWER_ROLES.length),
      /** B5-1: manual checks the run reports as explicit gates; absent on runs written before it existed. */
      manualCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS).optional(),
    }).strict(),
    reviewerModelIds: z.array(z.object({ role: reviewerRoleSchema, modelId: identifier(120) }).strict()).max(WORKBENCH_REVIEWER_ROLES.length),
    /** B4-2: the allow-list the run froze and, once evidence lands, the digest of its egress records. */
    egress: z.object({ allowHosts: z.array(z.string().min(1).max(260)).max(WORKBENCH_REVIEW_EGRESS_LIMITS.maxHosts), fetchDigest: hex64.nullable() }).strict().optional(),
    /** B5-1: the judgment-seed and checklist-criteria versions the run applied; a later version marks the run outdated. */
    rubricContent: reviewRubricContentSchema.optional(),
  }).strict(),
  bundleId: z.string().regex(WORKBENCH_REVIEW_BUNDLE_ID_PATTERN).nullable(),
  /** Screenshot evidence ids captured for the visual critic (`screenshot-<width>`). */
  screenshotEvidenceIds: z.array(identifier(120)).max(48),
  reviewers: z.array(reviewerRecordSchema).max(WORKBENCH_REVIEWER_ROLES.length),
  findings: z.array(reviewFindingSchema).max(600),
  completedIndependentReviewers: z.number().int().min(0),
  /** Null until the run reaches a terminal status. */
  outcome: reviewOutcomeSchema.nullable(),
  reasons: z.array(reviewRunReasonSchema).max(20),
  /** Checks a missing required reviewer was assigned; they stay incomplete (AC-R03.2). */
  incompleteCheckIds: z.array(checkId).max(WORKBENCH_REVIEW_MAX_CHECK_IDS),
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
  /** B5-1: one verdict per effective check, set when the run finishes; absent on runs written before it existed. */
  checkVerdicts: z.array(reviewCheckVerdictSchema).max(200).optional(),
}).strict().superRefine((value, ctx) => {
  const terminal = ['done', 'failed', 'interrupted'].includes(value.operation.status);
  if (terminal !== (value.outcome !== null)) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'Only a terminal run carries an outcome' });
  if ((value.operation.status === 'interrupted') !== (value.operation.interruptReason !== null)) ctx.addIssue({ code: 'custom', path: ['operation', 'interruptReason'], message: 'An interrupted run names its interrupt reason' });
  if (value.completedIndependentReviewers !== value.reviewers.filter(isIndependentReviewerCompletion).length) ctx.addIssue({ code: 'custom', path: ['completedIndependentReviewers'], message: 'Count must match fully answered completed reviewer records' });
  if (value.outcome === 'passed' && (value.operation.status !== 'done' || value.completedIndependentReviewers < WORKBENCH_MIN_INDEPENDENT_REVIEWERS)) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'Only a finished run with two or more independent reviewers can pass' });
  if (!unique(value.reviewers.map(reviewer => reviewer.role))) ctx.addIssue({ code: 'custom', path: ['reviewers'], message: 'Duplicate reviewer role' });
  if (!unique(value.findings.map(finding => finding.id))) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Duplicate finding id' });
  const roles = new Set(value.reviewers.map(reviewer => reviewer.role));
  value.findings.forEach((finding, index) => {
    if (finding.decisions?.length && reviewFindingDecisionProblem(value, finding)) ctx.addIssue({ code: 'custom', path: ['findings', index, 'decisions'], message: 'Only verified optional judgment findings carry advisory decisions' });
    if (!roles.has(finding.reviewerRole)) ctx.addIssue({ code: 'custom', path: ['findings', index, 'reviewerRole'], message: 'Finding from a reviewer outside the run' });
  });
  if (value.checkVerdicts) {
    if (!unique(value.checkVerdicts.map(verdict => verdict.checkId))) ctx.addIssue({ code: 'custom', path: ['checkVerdicts'], message: 'Duplicate check verdict' });
    // AC-R06.4: a page cannot pass with a known required failure or a required check left open.
    const blocking = value.checkVerdicts.filter(verdict => verdict.required && (WORKBENCH_BLOCKING_VERDICT_STATUSES as readonly string[]).includes(verdict.status));
    if (value.outcome === 'passed' && blocking.length) ctx.addIssue({ code: 'custom', path: ['outcome'], message: `A run cannot pass while required checks are unresolved: ${blocking.map(verdict => verdict.checkId).slice(0, 5).join(', ')}` });
  }
});

export const reviewReconciliationStatusSchema = z.object({
  state: z.enum(['reconciling', 'ready', 'degraded']),
  failedRunIds: z.array(runId),
}).strict();

/** GET /api/workbench/reviews/:id — the run plus whether newer project changes made it outdated. */
export const reviewRunViewSchema = z.object({
  run: reviewRunSchema,
  reconciliation: reviewReconciliationStatusSchema.optional(),
  freshness: z.object({ state: z.enum(['current', 'outdated']), reasons: z.array(line).max(50) }).strict(),
}).strict();
export const reviewRunSummarySchema = z.object({
  id: runId, entry: z.string(), status: reviewOperationStatusSchema, outcome: reviewOutcomeSchema.nullable(), createdAt: timestamp, endedAt: timestamp.nullable(),
}).strict();
export const reviewRunListSchema = z.object({ projectId: identifier(200), runs: z.array(reviewRunSummarySchema).max(200), reconciliation: reviewReconciliationStatusSchema.optional() }).strict();

export type ReviewerRole = z.infer<typeof reviewerRoleSchema>;
export type ReviewScope = z.infer<typeof reviewScopeSchema>;
export type ReviewerPlan = z.infer<typeof reviewerPlanSchema>;
export type StartReviewRunRequest = z.infer<typeof startReviewRunRequestSchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewerStatus = z.infer<typeof reviewerStatusSchema>;
export type ReviewerReasonCode = z.infer<typeof reviewerReasonCodeSchema>;
export type ReviewAbstainReason = typeof WORKBENCH_REVIEW_ABSTAIN_REASONS[number];
export type ReviewerRecord = z.infer<typeof reviewerRecordSchema>;
export type ReviewRunReason = z.infer<typeof reviewRunReasonSchema>;
export type ReviewInterruptReason = z.infer<typeof reviewInterruptReasonSchema>;
export type ReviewRun = z.infer<typeof reviewRunSchema>;
export type ReviewRunView = z.infer<typeof reviewRunViewSchema>;
export type ReviewRunSummary = z.infer<typeof reviewRunSummarySchema>;
export type ReviewRunList = z.infer<typeof reviewRunListSchema>;
export type ObservedBehavior = z.infer<typeof observedBehaviorSchema>;
export type ObservedBehaviorRecord = z.infer<typeof observedBehaviorRecordSchema>;
export type ReviewCheckVerdict = z.infer<typeof reviewCheckVerdictSchema>;
export type ReviewCheckVerdictStatus = ReviewCheckVerdict['status'];
export type ReviewRubricContent = z.infer<typeof reviewRubricContentSchema>;
export const parseStartReviewRunRequest = (input: unknown): StartReviewRunRequest => startReviewRunRequestSchema.parse(input);
export const parseReviewRun = (input: unknown): ReviewRun => reviewRunSchema.parse(input);
export const parseReviewRunView = (input: unknown): ReviewRunView => reviewRunViewSchema.parse(input);
export const parseReviewRunList = (input: unknown): ReviewRunList => reviewRunListSchema.parse(input);
