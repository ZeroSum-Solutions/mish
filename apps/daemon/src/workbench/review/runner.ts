import { randomUUID } from 'node:crypto';
import { reviewEvidenceMessageProblems, verificationBundleSchema, WORKBENCH_REVIEW_CONFORMANCE_NOTE, WORKBENCH_REVIEW_CONSOLE_SCHEMA, WORKBENCH_REVIEW_EVIDENCE_VERSION, WORKBENCH_REVIEW_EGRESS_LIMITS, WORKBENCH_REVIEW_RUNNER_VERSION, type ReviewConsoleEvidence, type MechanicalCheckResult, type ReviewEgressEvidence, type ReviewEgressPolicy, type ProjectDesignContext, type ProjectRubric, type ReviewEvidenceVouch, type ReviewOutcome, type VerificationBundle, type VerificationEvidence } from '@mish/contracts';
import { egressEvidence, type EgressSummary } from './egress.js';
import { addressParam, digestParam, ev, EvidenceError, list, PageText, pathParam, vocab, type EvidenceParam, type EvidenceText } from './evidence.js';
import { evaluateCheck, type CaptureAtWidth } from './evaluate.js';
import { detailAtWidth, visualFactsEvidence } from './evidence-detail.js';
import { observedBehaviorsEvidence, summarizeObservedBehaviors } from './observed-behaviors.js';
import { motionRequestAt, planReview, type PlannedCheck, type ReviewPlan } from './plan.js';
import { BrowserStartupError, logStartupFailure } from './startup.js';
import type { ReviewBrowserPort, ReviewBrowserSession, TargetRequest, ViewportCapture } from './types.js';

export const MECHANICAL_RUNNER_VERSION = WORKBENCH_REVIEW_RUNNER_VERSION;
export const CONFORMANCE_NOTE = WORKBENCH_REVIEW_CONFORMANCE_NOTE;

export interface RunMechanicalReviewInput {
  projectId: string;
  /** Project-relative entry path, already validated against the request contract. */
  entry: string;
  rubric: ProjectRubric | null;
  context: ProjectDesignContext | null;
  port: ReviewBrowserPort;
  clock?: () => Date;
  newId?: () => string;
  /** Ask the worker for a first-paint PNG at each width (R03 visual critic). */
  screenshots?: boolean;
  /** Receives each successful capture (with its PNG when requested) before evaluation. */
  onCapture?: (width: number, capture: ViewportCapture) => void | Promise<void>;
  /**
   * Cancels the capture (R03 cancel): no further width is captured and the
   * browser session is closed at once. The bundle still records what was
   * captured; the missing widths are inconclusive, never passed.
   */
  signal?: AbortSignal;
  /**
   * B4-2: the run's egress allow-list, recorded in the bundle. The port was
   * built with the same list and enforces it; omitted means default-deny.
   */
  egress?: ReviewEgressPolicy;
}

/** Overall rule from the technical spec; mirrored by the contract's refinement. */
export function aggregateOutcome(results: readonly MechanicalCheckResult[], unresolvedRequiredChecks: readonly string[]): ReviewOutcome {
  if (results.some(result => result.required && result.outcome === 'fail')) return 'failed';
  if (results.some(result => result.required && result.outcome === 'inconclusive') || unresolvedRequiredChecks.length) return 'inconclusive';
  return 'passed';
}

const viewportHeight = (width: number) => (width < 768 ? 740 : 900);
const entryUrl = (origin: string, entry: string) => `${origin}/${entry.split('/').map(encodeURIComponent).join('/')}`;

function captureTargets(plan: ReviewPlan): TargetRequest[] {
  const byKey = new Map<string, TargetRequest>();
  for (const check of plan.checks) for (const target of check.targets ?? []) byKey.set(target.key, target);
  return [...byKey.values()];
}

function resultFor(check: PlannedCheck, outcome: MechanicalCheckResult['outcome'], reason: EvidenceText, evidenceIds: string[], recovery?: EvidenceText): MechanicalCheckResult {
  return {
    checkId: check.checkId, criterionId: check.criterionId, parameterType: check.parameters.type, synthesized: check.synthesized,
    required: check.required, severity: check.severity, outcome, reason, evidenceIds, ...(recovery ? { recovery } : {}),
  };
}

interface CaptureRun {
  captures: Map<number, CaptureAtWidth>;
  /** Every capture's served files, kept per capture (including load-error captures) so changes between captures stay visible. */
  served: ViewportCapture['served'][];
  servingLimits: EvidenceText[];
}

type CaptureHooks = Pick<RunMechanicalReviewInput, 'screenshots' | 'onCapture' | 'signal'>;
const CANCELLED = ev('capture.cancelled');

async function captureAll(session: ReviewBrowserSession, url: string, plan: ReviewPlan, hooks: CaptureHooks = {}): Promise<CaptureRun> {
  const targets = captureTargets(plan);
  const probeAllActions = plan.checks.some(check => check.parameters.type === 'cta' && check.targets === null);
  const run: CaptureRun = { captures: new Map(), served: [], servingLimits: [] };
  for (const width of plan.viewports) {
    if (hooks.signal?.aborted) { run.captures.set(width, { error: CANCELLED }); continue; }
    try {
      const motion = motionRequestAt(plan, width);
      const capture = await session.capture({ url, width, height: viewportHeight(width), targets, probeAllActions, ...(hooks.screenshots ? { screenshot: true } : {}), ...(motion ? { motion } : {}) });
      // Served hashes and serving limits are recorded even for a capture the cancel discards, so integrity stays visible.
      run.served.push(capture.served);
      if (capture.servingLimit) run.servingLimits.push(capture.servingLimit);
      if (hooks.signal?.aborted) { run.captures.set(width, { error: CANCELLED }); continue; }
      if (!capture.loadError) await hooks.onCapture?.(width, capture);
      // The capture's types already keep page text opaque (see evidence.ts); it is evaluated as it is.
      run.captures.set(width, capture.loadError ? { error: capture.loadError } : { capture });
    } catch (error) {
      // A worker failure that is already evidence keeps its message; any other message may echo page text, so only its digest is kept.
      run.captures.set(width, { error: error instanceof EvidenceError ? error.evidence : ev('capture.failed', PageText.of(error instanceof Error ? error.message : 'unknown').token()) });
    }
  }
  return run;
}

/** A condition under which no check may pass, whatever the per-check evidence says. */
interface RunBlocker { evidence: VerificationEvidence; reason: EvidenceText; recovery: EvidenceText }

export const SOURCE_CHANGED_RECOVERY = ev('recovery.sourceChanged');
export const SERVING_LIMIT_RECOVERY = ev('recovery.servingLimit');
export const EGRESS_LIMIT_RECOVERY = ev('recovery.egressLimit');
export const EGRESS_CHANGED_RECOVERY = ev('recovery.egressChanged');

function emptyEgress(allowHosts: string[]): EgressSummary {
  const { maxRequests, maxBytes, maxResponseBytes, requestTimeoutMs, maxRedirects } = WORKBENCH_REVIEW_EGRESS_LIMITS;
  return { allowHosts, limits: { maxRequests, maxBytes, maxResponseBytes, requestTimeoutMs, maxRedirects }, fetches: [], requests: 0, bytes: 0, exhausted: null };
}

function egressLimitBlocker(egress: ReviewEgressEvidence): RunBlocker | null {
  if (!egress.exhausted) return null;
  return { reason: egress.exhausted, recovery: EGRESS_LIMIT_RECOVERY, evidence: { id: 'egress-limit', viewport: null, type: 'environment', summary: ev('summary.egressLimit'), observations: [egress.exhausted] } };
}

/**
 * Same invariant as sourceChangeBlocker, for allowed external resources: one
 * version of each resource per review. A resource is its full URL, so the same
 * path with a different query (its digest) is a different resource.
 */
function egressChangeBlocker(egress: ReviewEgressEvidence): RunBlocker | null {
  const hashes = new Map<string, { location: EvidenceParam; bodies: Set<string> }>();
  for (const fetch of egress.fetches) {
    if (!fetch.sha256) continue;
    const key = `${fetch.origin} ${fetch.pathQuerySha256}`;
    const entry = hashes.get(key) ?? hashes.set(key, { location: egressLocation(fetch), bodies: new Set() }).get(key)!;
    entry.bodies.add(fetch.sha256);
  }
  const changed = [...hashes].filter(([, entry]) => entry.bodies.size > 1).sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry.location);
  if (!changed.length) return null;
  return {
    reason: ev('blocker.egressChanged', list(changed.slice(0, 3))),
    recovery: EGRESS_CHANGED_RECOVERY,
    evidence: { id: 'egress-integrity', viewport: null, type: 'environment', summary: ev('summary.egressChanged'), observations: changed.slice(0, 60).map(location => ev('blocker.egressChangedFetch', location)) },
  };
}

/** An egress record's path-free location (origin, depth, digest of path and query). */
const egressLocation = (location: Pick<ReviewEgressEvidence['fetches'][number], 'origin' | 'pathDepth' | 'pathDepthCapped' | 'pathQuerySha256'> & { queryLength?: number }): EvidenceParam =>
  ({ kind: 'location', origin: location.origin, originSha256: null, path: null, pathDepth: location.pathDepth, pathDepthCapped: location.pathDepthCapped, pathQuerySha256: location.pathQuerySha256, queryLength: location.queryLength ?? 0, querySha256: null });

/** Console records across every width: one entry per distinct record, with its total count and the widths it appeared at. */
function consoleEvidence(captures: ReadonlyMap<number, CaptureAtWidth>): ReviewConsoleEvidence {
  const entries = new Map<string, ReviewConsoleEvidence['entries'][number]>();
  for (const [width, entry] of [...captures].sort(([a], [b]) => a - b)) {
    if (!('capture' in entry)) continue;
    for (const record of entry.capture.console) {
      const seen = entries.get(record.id);
      if (seen) { seen.count += record.count; if (!seen.viewports.includes(width)) seen.viewports.push(width); }
      else entries.set(record.id, { ...record, viewports: [width] });
    }
  }
  return { schema: WORKBENCH_REVIEW_CONSOLE_SCHEMA, entries: [...entries.values()].slice(0, 400) };
}

function egressObservation(fetch: ReviewEgressEvidence['fetches'][number]): EvidenceText {
  const hops = fetch.redirects.length ? ev('egress.afterRedirects', fetch.redirects.length) : ev('common.nothing');
  const type = vocab('resourceType', fetch.resourceType);
  return fetch.outcome === 'fetched'
    ? ev('egress.fetched', egressLocation(fetch), type, addressParam(fetch.resolvedAddress!), fetch.status!, fetch.bytes, fetch.durationMs, hops, digestParam(fetch.sha256!.slice(0, 16)))
    : ev('egress.notFetched', vocab('egressOutcome', fetch.outcome), egressLocation(fetch), type, hops, fetch.reason!);
}

/**
 * Invariant: every check in a bundle judges one version of each source file.
 * A path served with more than one SHA-256 across (or within) captures means
 * the project changed mid-review, and the checks saw different versions.
 */
function sourceChangeBlocker(served: CaptureRun['served']): RunBlocker | null {
  const hashes = new Map<string, Set<string>>();
  for (const files of served) for (const file of files) (hashes.get(file.path) ?? hashes.set(file.path, new Set()).get(file.path)!).add(file.sha256);
  const changed = [...hashes].filter(([, set]) => set.size > 1).map(([path]) => path).sort();
  if (!changed.length) return null;
  const first = list(changed.slice(0, 5).map(pathParam));
  return {
    reason: changed.length > 5 ? ev('blocker.sourceChangedMore', first, changed.length - 5) : ev('blocker.sourceChanged', first),
    recovery: SOURCE_CHANGED_RECOVERY,
    evidence: { id: 'source-integrity', viewport: null, type: 'environment', summary: ev('summary.sourceChanged'), observations: changed.slice(0, 60).map(path => ev('blocker.sourceChangedFile', pathParam(path))) },
  };
}

function servingLimitBlocker(limits: EvidenceText[]): RunBlocker | null {
  if (!limits.length) return null;
  const distinct = [...new Map(limits.map(limit => [JSON.stringify(limit), limit])).values()];
  return { reason: limits[0]!, recovery: SERVING_LIMIT_RECOVERY, evidence: { id: 'serving-limit', viewport: null, type: 'environment', summary: ev('summary.servingLimit'), observations: distinct.slice(0, 10) } };
}

/** First-seen SHA-256 per path; a path with several hashes is reported by sourceChangeBlocker. */
function sourceHashesOf(served: CaptureRun['served']): VerificationBundle['sourceHashes'] {
  const first = new Map<string, string>();
  for (const files of served) for (const file of files) if (!first.has(file.path)) first.set(file.path, file.sha256);
  return [...first].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
}

/**
 * Runs the mechanical half of a review (AC-R06.2). Without a capable browser
 * worker every check is inconclusive with setup recovery; nothing passes on
 * missing evidence (AC-R06.4). The returned bundle is contract-validated.
 */
export async function runMechanicalReview(input: RunMechanicalReviewInput): Promise<VerificationBundle> {
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const plan = planReview(input.rubric, input.context);
  const evidence: VerificationEvidence[] = [];
  const results: MechanicalCheckResult[] = [];
  let browserVersion: string | null = null;
  let sourceHashes: VerificationBundle['sourceHashes'] = [];
  const allowHosts = [...(input.egress?.allowHosts ?? [])];
  let egress = egressEvidence(emptyEgress(allowHosts));
  let console: ReviewConsoleEvidence = { schema: WORKBENCH_REVIEW_CONSOLE_SCHEMA, entries: [] };
  // B5-1 (AC-R06.5): behavior the captures observed; all unknown until a capture says otherwise.
  let observedBehaviors = summarizeObservedBehaviors(null);
  // B4-2b: recorded whenever a motion check is planned, apart from `egress` so it never blocks the run.
  const motionPlanned = plan.checks.some(check => check.parameters.type === 'motion');
  let motionEgress = egressEvidence(emptyEgress(allowHosts));

  const cancelled = { available: false as const, reason: ev('worker.cancelled'), recovery: ev('recovery.newRun') };
  const capability = input.signal?.aborted ? cancelled : await input.port.capability();
  let session: ReviewBrowserSession | null = null;
  let unavailable: { reason: EvidenceText; recovery: EvidenceText } | null = capability.available ? null : capability;
  if (capability.available) {
    browserVersion = capability.browserVersion;
    try { session = await input.port.open(); } catch (error) {
      const failure = error instanceof BrowserStartupError ? error : new BrowserStartupError('unknown', error instanceof Error ? error.message : 'unknown error');
      logStartupFailure(failure);
      unavailable = { reason: ev('worker.startFailed', vocab('startupFailure', failure.failure)), recovery: ev(`recovery.startup.${failure.failure}`) };
    }
  }

  if (unavailable || !session) {
    const reason = unavailable?.reason ?? ev('worker.none');
    evidence.push({ id: 'environment', viewport: null, type: 'environment', summary: ev('summary.noBrowser'), observations: [reason] });
    for (const check of plan.checks) results.push(resultFor(check, 'inconclusive', reason, ['environment'], unavailable?.recovery));
  } else {
    const open = session;
    let closing: Promise<void> | null = null;
    const close = () => (closing ??= open.close().catch(() => undefined));
    const onAbort = () => { void close(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    try {
      const run = await captureAll(open, entryUrl(input.port.origin, input.entry), plan, { ...(input.screenshots ? { screenshots: true } : {}), ...(input.onCapture ? { onCapture: input.onCapture } : {}), ...(input.signal ? { signal: input.signal } : {}) });
      sourceHashes = sourceHashesOf(run.served);
      console = consoleEvidence(run.captures);
      observedBehaviors = summarizeObservedBehaviors(run.captures);
      evidence.push(observedBehaviorsEvidence(observedBehaviors));
      // R03: the rendered page at each captured width, measured from computed styles, for text-only reviewers.
      for (const [, entry] of [...run.captures].sort(([a], [b]) => a - b)) {
        const facts = 'capture' in entry ? visualFactsEvidence(entry.capture) : null;
        if (facts) evidence.push(facts);
      }
      const summary = open.egress?.();
      egress = egressEvidence(summary ? { ...summary, allowHosts } : emptyEgress(allowHosts));
      const motionSummary = motionPlanned ? open.motionEgress?.() : undefined;
      if (motionSummary) motionEgress = egressEvidence({ ...motionSummary, allowHosts });
      const motionEgressCited = motionPlanned && (allowHosts.length > 0 || motionEgress.fetches.length > 0);
      if (motionEgressCited) evidence.push({ id: 'motion-egress', viewport: null, type: 'network', summary: ev(motionEgress.exhausted ? 'motion.egressSummaryExhausted' : 'motion.egressSummary', motionEgress.fetches.filter(item => item.outcome === 'fetched').length, motionEgress.fetches.length), observations: motionEgress.fetches.slice(0, 60).map(egressObservation) });
      const blockers = [sourceChangeBlocker(run.served), servingLimitBlocker(run.servingLimits), egressLimitBlocker(egress), egressChangeBlocker(egress)].filter((item): item is RunBlocker => item !== null);
      evidence.push(...blockers.map(blocker => blocker.evidence));
      // Every attempt to reach an allowed host, for the reviewers and the resource check.
      const egressCited = allowHosts.length > 0 || egress.fetches.length > 0;
      const listed = allowHosts.length ? list(allowHosts.map(host => ({ kind: 'host', value: host.split(':')[0]! }) as EvidenceParam)) : ev('common.empty');
      if (egressCited) evidence.push({ id: 'egress', viewport: null, type: 'network', summary: ev('summary.egress', egress.fetches.filter(item => item.outcome === 'fetched').length, egress.fetches.length, listed), observations: egress.fetches.slice(0, 60).map(egressObservation) });
      for (const check of plan.checks) {
        const evaluated = evaluateCheck(check, run.captures);
        // R03: what the check measured at each captured width, pass or fail, so a reviewer can verify the verdict.
        evidence.push(...evaluated.evidence.map(item => {
          const entry = item.viewport === null ? undefined : run.captures.get(item.viewport);
          const detail = entry && 'capture' in entry ? detailAtWidth(check, entry.capture) : [];
          return detail.length ? { ...item, detail } : item;
        }));
        const evidenceIds = [...blockers.map(blocker => blocker.evidence.id), ...(egressCited && check.parameters.type === 'console-resources' ? ['egress'] : []), ...(motionEgressCited && check.parameters.type === 'motion' ? ['motion-egress'] : []), ...evaluated.evidence.map(item => item.id)];
        // A blocked run keeps its per-check evidence for diagnosis but can neither pass nor fail.
        if (blockers.length) results.push(resultFor(check, 'inconclusive', ev('result.blocked', list(blockers.map(blocker => blocker.reason))), evidenceIds, ev('recovery.list', list(blockers.map(blocker => blocker.recovery)))));
        else results.push(resultFor(check, evaluated.outcome, evaluated.reason, evidenceIds));
      }
    } finally { input.signal?.removeEventListener('abort', onAbort); await close(); }
  }

  const bundle = {
    schema: 'workbench-verification-bundle/1',
    id: input.newId?.() ?? `rv_${randomUUID()}`,
    projectId: input.projectId, entry: input.entry, sourceHashes,
    contextRevision: plan.contextRevision, rubricRevision: plan.rubricRevision,
    previewOrigin: input.port.origin,
    environment: { worker: unavailable || !browserVersion ? 'unavailable' : 'cdp-chromium', browserVersion: unavailable ? null : browserVersion, runnerVersion: MECHANICAL_RUNNER_VERSION },
    viewports: plan.viewports, startedAt, endedAt: clock().toISOString(),
    results, evidence: vouchedDetail(evidence, { sourceHashes, egress, console }), unresolvedRequiredChecks: plan.unresolvedRequiredChecks,
    outcome: aggregateOutcome(results, plan.unresolvedRequiredChecks),
    conformanceNote: CONFORMANCE_NOTE,
    egress,
    console,
    ...(motionPlanned ? { motionEgress } : {}),
    evidenceVersion: WORKBENCH_REVIEW_EVIDENCE_VERSION,
    observedBehaviors,
  };
  return verificationBundleSchema.parse(bundle);
}

/**
 * R03 detail is advisory: a detail message that names something this bundle
 * cannot vouch for (a path it did not serve, an origin or host off the
 * allow-list, an unknown console record) is dropped on its own; the rest of
 * the detail, the findings and the verdicts stay.
 */
function vouchedDetail(evidence: VerificationEvidence[], vouch: ReviewEvidenceVouch): VerificationEvidence[] {
  return evidence.map(item => {
    if (!item.detail) return item;
    const detail = item.detail.filter(message => typeof message !== 'string' && reviewEvidenceMessageProblems(message, vouch).length === 0);
    const { detail: _detail, ...rest } = item;
    return detail.length ? { ...rest, detail } : rest;
  });
}
