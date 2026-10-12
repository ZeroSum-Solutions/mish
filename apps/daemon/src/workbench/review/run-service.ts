import { createHash, randomUUID } from 'node:crypto';
import {
  isIndependentReviewerCompletion, reviewInterruptReasonSchema, WORKBENCH_REVIEW_MAX_CHECK_IDS, type ReviewerRecord, type ReviewerRole, type ReviewFinding, type ReviewInterruptReason, type ReviewRun,
  type ReviewEgressPolicy, type ReviewRunSummary, type ReviewRunView, type StartReviewRunRequest, type VerificationBundle,
} from '@open-design/contracts';
import { validatedAllowHosts } from './egress.js';
import { reviewFreshness, type EntryVersion } from './freshness.js';
import { isLegacyBundle } from './evidence-store.js';
import { frozenRubricKeys } from './plan.js';
import { computeCheckVerdicts, evaluateApplicability, type EffectiveCheck } from './check-verdicts.js';
import { buildReviewerInput, effectiveChecks, planChecks, resolveReviewerPlan, RUBRIC_CONTENT, type PlanEntry } from './reviewer-plan.js';
import { ReviewerCallError, type ReviewerAdapter, type ReviewerInput } from './reviewers/types.js';
import { visualFallback } from './reviewers/visual-fallback.js';
import { aggregateReviewRun } from './run-aggregate.js';
import { createFindingDecisions } from './finding-decisions.js';
import { createReviewRunStore, type ReviewInventoryRecord } from './run-store.js';
import { ReviewBusyError, type MechanicalRunHooks, type ReviewProjectInputs } from './service.js';

/**
 * Limits from technical-spec "Operations, concurrency and errors", plus the
 * budget guards: one active review per project, a daemon-wide cap on billed
 * reviewer calls per UTC day, and how long a cancelled run waits for the
 * browser to hand back the evidence it already captured.
 */
export const REVIEW_RUN_LIMITS = {
  modelConcurrency: 2, perCallMs: 5 * 60_000, runMs: 15 * 60_000, maxActive: 20, busyRetryMs: 500,
  dailyBilledCalls: 60, cancelGraceMs: 10_000,
} as const;
export type ReviewRunLimits = { [K in keyof typeof REVIEW_RUN_LIMITS]: number };

/** Provider facts for a role whose adapter this daemon does not configure; frozen into the record. */
const ROLE_DEFAULTS: Record<ReviewerRole, Pick<ReviewerRecord, 'provider' | 'modelId' | 'adapterVersion' | 'billingLane'>> = {
  'jev-text': { provider: 'typesafe-jev', modelId: 'jev-latest', adapterVersion: 'unconfigured', billingLane: 'typesafe-system-one' },
  'claude-visual': { provider: 'claude-max', modelId: 'claude-opus-5-5', adapterVersion: 'unconfigured', billingLane: 'max-subscription' },
  'deepseek-adversarial': { provider: 'deepseek', modelId: 'deepseek-flash', adapterVersion: 'unconfigured', billingLane: 'deepseek-metered' },
  'gemini-second-family': { provider: 'gemini', modelId: 'gemini-3.8-flash', adapterVersion: 'unconfigured', billingLane: 'gemini-subscription' },
};

export class ReviewRunError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 429, readonly code: string, message: string, readonly fields: { path: string; message: string }[] = []) { super(message); this.name = 'ReviewRunError'; }
}

export interface ReviewRunServiceDeps {
  /** Absolute daemon data root (RUNTIME_DATA_DIR). */
  dataDir: string;
  projectInputs(projectId: string): ReviewProjectInputs | Promise<ReviewProjectInputs>;
  /** U1's mechanical service, called in-process. */
  mechanical: {
    run(projectId: string, request: { entry: string; egress?: ReviewEgressPolicy }, hooks: MechanicalRunHooks): Promise<VerificationBundle>;
    read(projectId: string, bundleId: string): Promise<VerificationBundle | null>;
  };
  entryVersion(projectId: string, entry: string, versionId: string | null): Promise<EntryVersion | null>;
  reviewers: Partial<Record<ReviewerRole, ReviewerAdapter>>;
  clock?: () => Date;
  newId?: () => string;
  limits?: Partial<ReviewRunLimits>;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const RAW_OUTPUT_LIMIT = 64_000;
/** Roles whose checks are visual: a text-only answer from them is not a review of what they were assigned. */
const VISION_ROLES: ReadonlySet<ReviewerRole> = new Set<ReviewerRole>(['claude-visual']);
const terminal = (run: ReviewRun) => run.operation.status === 'done' || run.operation.status === 'failed' || run.operation.status === 'interrupted';
const billed = (record: Pick<ReviewerRecord, 'billingLane'>) => record.billingLane !== 'max-subscription' && record.billingLane !== 'gemini-subscription';

function semaphore(limit: number) {
  let active = 0; const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await work(); } finally { active--; waiting.shift()?.(); }
  };
}

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Resolves with the promise's value, or null when it rejects or takes longer than `ms`. */
function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms); timer.unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

function interruptReasonOf(signal: AbortSignal): ReviewInterruptReason {
  const parsed = reviewInterruptReasonSchema.safeParse(signal.reason);
  return parsed.success ? parsed.data : 'worker-lost';
}

/**
 * AC-R03.1: the evidence must be about the inputs the run froze. Returns why it
 * is not (a newer rubric or context, an entry whose bytes differ from the
 * frozen digest, or a file served with different bytes across widths), or null.
 */
export function frozenInputsDrift(run: ReviewRun, bundle: VerificationBundle, servedDrift: ReadonlySet<string>): string | null {
  const frozen = run.frozen;
  if (bundle.rubricRevision !== frozen.rubricRevision) return `The rubric moved to revision ${bundle.rubricRevision} after the review froze revision ${frozen.rubricRevision}; the evidence was not collected against the frozen rubric`;
  if (bundle.contextRevision !== frozen.contextRevision) return `The project context moved to revision ${bundle.contextRevision} after the review froze revision ${frozen.contextRevision}`;
  const entry = bundle.sourceHashes.find(source => source.path === frozen.snapshot.entry);
  if (entry && frozen.snapshot.contentDigest && entry.sha256 !== frozen.snapshot.contentDigest) return `${frozen.snapshot.entry} changed after the review started; the evidence is about newer content than the frozen revision`;
  if (servedDrift.size) return `Project files changed while the evidence was captured: ${[...servedDrift].slice(0, 5).join(', ')}`;
  const frozenHosts = frozen.egress?.allowHosts ?? [];
  const usedHosts = bundle.egress?.allowHosts ?? [];
  if (frozenHosts.length !== usedHosts.length || frozenHosts.some((host, index) => host !== usedHosts[index])) return 'The evidence was collected under a different egress allow-list than the review froze';
  return null;
}

/**
 * The collect-review operation (AC-R03.1–R03.4): freezes the inputs, runs the
 * mechanical evidence through U1's service in-process, checks that evidence is
 * about the frozen inputs, then runs the selected model reviewers (at most two
 * calls at a time), persisting every completed record as it lands so
 * cancellation or a daemon restart keeps it. Review never edits or publishes
 * the project; it only writes under the data root.
 */
export function createReviewRunService(deps: ReviewRunServiceDeps) {
  const limits: ReviewRunLimits = { ...REVIEW_RUN_LIMITS, ...deps.limits };
  const store = createReviewRunStore(deps.dataDir);
  const clock = deps.clock ?? (() => new Date());
  const now = () => clock().toISOString();
  const day = () => now().slice(0, 10);
  const active = new Map<string, { run: ReviewRun; controller: AbortController; done: Promise<void> }>();
  /** Starts in flight, keyed by project and Idempotency-Key; set before the first await so a concurrent duplicate joins it. */
  const starting = new Map<string, Promise<ReviewRun>>();
  /** Projects with a review starting or running (reserved synchronously). */
  const busyProjects = new Set<string>();
  const billedCalls = { day: '', count: 0 };
  const countedRecords = new Set<string>();
  let reconciliation: { state: 'reconciling' | 'ready' | 'degraded'; failedRunIds: string[] } = { state: 'reconciling', failedRunIds: [] };
  let pendingReconciliation: ReviewInventoryRecord[] | null = null;
  let globalFailures = 0;
  let retryAfter = 0;
  let ready = launchReconcile();

  function reconciliationStatus(projectId?: string) {
    if (projectId === undefined || pendingReconciliation === null) return { ...reconciliation, failedRunIds: [...reconciliation.failedRunIds] };
    const key = sha256(projectId).slice(0, 32);
    const failures = pendingReconciliation.filter(record => record.projectKey === key);
    const failedRunIds = failures.flatMap(record => record.id === null ? [] : [record.id]);
    // A retry must not make an unresolved project appear safe to start.
    return { state: failures.length ? 'degraded' as const : 'ready' as const, failedRunIds };
  }

  function launchReconcile(): Promise<void> {
    reconciliation = { state: 'reconciling', failedRunIds: [] };
    // Attach the rejection handler at creation, before any caller awaits startup.
    return reconcile().catch(error => {
      console.warn('[review-runs] Restart reconciliation failed', error);
      reconciliation = { state: 'degraded', failedRunIds: [] };
      globalFailures++;
      // The first retry is immediate; repeated whole-store failures back off to 30 seconds.
      retryAfter = globalFailures === 1 ? 0 : Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(globalFailures - 2, 5));
    });
  }

  async function ensureReady(): Promise<void> {
    const attempt = ready;
    await attempt;
    if (reconciliation.state === 'degraded' && ready === attempt && Date.now() >= retryAfter) ready = launchReconcile();
    await ready;
  }

  function countBilledCall(at: string): void {
    if (billedCalls.day !== at.slice(0, 10)) { billedCalls.day = at.slice(0, 10); billedCalls.count = 0; }
    billedCalls.count++;
  }

  /** AC-R03.4: a run abandoned by a restart is interrupted, never completed by assumption; completed records stay. */
  async function reconcile(): Promise<void> {
    const initial = pendingReconciliation === null;
    const today = day();
    const inventory = initial ? await store.inventory() : { runs: [], unavailable: [] };
    const stored = inventory.runs;
    if (initial) {
      billedCalls.day = today; billedCalls.count = 0;
      countedRecords.clear();
    }
    const targets: (ReviewInventoryRecord & { run?: ReviewRun })[] = pendingReconciliation ? [...pendingReconciliation] : stored.map(run => ({ projectKey: sha256(run.projectId).slice(0, 32), id: run.id, run }));
    const failed: ReviewInventoryRecord[] = [...inventory.unavailable];
    for (const target of targets) {
      try {
        if (target.id === null) {
          const project = await store.inventoryProject(target.projectKey);
          failed.push(...project.unavailable);
          targets.push(...project.runs.map(run => ({ projectKey: target.projectKey, id: run.id, run })));
          continue;
        }
        const result = target.run ? { status: 'found' as const, run: target.run } : await store.readInventoryResult({ projectKey: target.projectKey, id: target.id });
        if (result.status === 'missing' || result.status === 'corrupt') continue;
        if (result.status !== 'found') { failed.push({ projectKey: target.projectKey, id: target.id }); continue; }
        const run = result.run;
        const recordKey = `${target.projectKey}/${run.id}`;
        if (!countedRecords.has(recordKey)) {
          for (const reviewer of run.reviewers) if (billed(reviewer) && reviewer.startedAt?.startsWith(today)) for (let call = 0; call < (reviewer.providerCalls ?? 1); call++) countBilledCall(reviewer.startedAt);
          countedRecords.add(recordKey);
        }
        if (active.has(run.id) || (run.operation.status !== 'queued' && run.operation.status !== 'running')) continue;
        const bundle = run.bundleId ? await deps.mechanical.read(run.projectId, run.bundleId).catch(error => {
          console.warn('[review-runs] Could not read recovered evidence bundle', run.id, error);
          return null;
        }) : null;
        for (const reviewer of run.reviewers) {
          if (reviewer.status === 'pending' || reviewer.status === 'running') Object.assign(reviewer, { status: 'cancelled', reasonCode: 'daemon-restart', reason: 'The daemon restarted before this reviewer finished', recovery: 'Start a new review run; completed evidence is kept.', endedAt: reviewer.startedAt ? now() : null });
        }
        finish(run, bundle, 'interrupted', 'daemon-restart');
        await store.save(run);
      } catch (error) {
        console.warn('[review-runs] Could not reconcile review run', target.id, error);
        failed.push({ projectKey: target.projectKey, id: target.id });
      }
    }
    pendingReconciliation = failed;
    globalFailures = 0; retryAfter = 0;
    reconciliation = { state: failed.length ? 'degraded' : 'ready', failedRunIds: failed.flatMap(run => run.id === null ? [] : [run.id]) };
  }

  /**
   * B5-1 (AC-R06.4): per-check verdicts for a run whose evidence is about its
   * frozen inputs. Null without evidence or effective checks (a restart that
   * no longer has the frozen inputs, or evidence about changed inputs).
   */
  function verdictsFor(run: ReviewRun, bundle: VerificationBundle | null, checks: readonly EffectiveCheck[] | null) {
    if (!bundle || !checks) return null;
    return computeCheckVerdicts({
      checks, mechanical: { results: bundle.results, observedBehaviors: bundle.observedBehaviors }, reviewers: run.reviewers, findings: run.findings,
      scopeCheckIds: run.frozen.scope.kind === 'checks' ? run.frozen.scope.checkIds : null,
    });
  }

  function finish(run: ReviewRun, bundle: VerificationBundle | null, status: 'done' | 'failed' | 'interrupted', interruptReason: ReviewInterruptReason | null, extra: { error?: string | null; inputsChanged?: string | null; checks?: readonly EffectiveCheck[] | null } = {}): void {
    const error = extra.error ?? null;
    const verdicts = extra.inputsChanged ? null : verdictsFor(run, bundle, extra.checks ?? null);
    if (verdicts) run.checkVerdicts = verdicts;
    const aggregate = aggregateReviewRun({ mechanical: bundle, reviewers: run.reviewers, interrupted: status === 'interrupted', inputsChanged: extra.inputsChanged ?? null, verdicts });
    if (status === 'failed') aggregate.reasons.push({ code: 'operation-failed', message: (error ?? 'The review operation failed').slice(0, 500) });
    const at = now();
    run.operation = { ...run.operation, status, stage: 'finished', interruptReason, error, updatedAt: at };
    run.outcome = status === 'failed' && aggregate.outcome === 'passed' ? 'inconclusive' : aggregate.outcome;
    run.reasons = aggregate.reasons.slice(0, 20);
    run.completedIndependentReviewers = aggregate.completedIndependentReviewers;
    run.incompleteCheckIds = aggregate.incompleteCheckIds;
    run.endedAt = at;
  }

  /** Every reviewer is assigned every reviewed check; runReviewer splits them into calls no larger than its limit. */
  function assign(_role: ReviewerRole, reviewedCheckIds: readonly string[]): string[] {
    return [...reviewedCheckIds];
  }

  function newRecord(entry: PlanEntry, reviewedCheckIds: string[], adapter: ReviewerAdapter | undefined): ReviewerRecord {
    const facts = adapter ? { provider: adapter.provider, modelId: adapter.modelId, adapterVersion: adapter.adapterVersion, billingLane: adapter.billingLane } : ROLE_DEFAULTS[entry.role];
    return { role: entry.role, required: entry.required, ...facts, inputMode: null, status: 'pending', reason: null, recovery: null, inputDigest: null, assignedCheckIds: assign(entry.role, reviewedCheckIds), unansweredCheckIds: [], rawOutput: null, startedAt: null, endedAt: null };
  }

  /**
   * Starts a review, or replays the run an equal request with the same
   * Idempotency-Key already started. A concurrent duplicate joins the start in
   * flight instead of starting (and billing) a second run.
   */
  async function start(request: StartReviewRunRequest, idempotencyKey: string): Promise<ReviewRun> {
    const slot = `${request.projectId}\u0000${idempotencyKey}`;
    const inputDigest = sha256(JSON.stringify(request));
    const inFlight = starting.get(slot);
    if (inFlight) {
      const run = await inFlight;
      if (run.operation.inputDigest !== inputDigest) throw new ReviewRunError(409, 'idempotency-key-reused', 'This Idempotency-Key was used for a different review request');
      return structuredClone(run);
    }
    const work = startOnce(request, idempotencyKey, inputDigest);
    starting.set(slot, work);
    try { return structuredClone(await work); } finally { starting.delete(slot); }
  }

  async function startOnce(request: StartReviewRunRequest, idempotencyKey: string, inputDigest: string): Promise<ReviewRun> {
    await ensureReady();
    if (reconciliationStatus(request.projectId).state !== 'ready') throw new ReviewRunError(409, 'review-store-degraded', 'Review recovery is incomplete; try again after storage recovers');
    const lookup = await store.findByKeyResult(request.projectId, idempotencyKey);
    if (lookup.status === 'unavailable' || lookup.status === 'corrupt') throw new ReviewRunError(409, 'review-store-unavailable', 'The previous review record is temporarily unreadable; retry after storage recovers');
    const prior = lookup.status === 'found' ? lookup.run : null;
    if (prior) {
      if (prior.operation.inputDigest !== inputDigest) throw new ReviewRunError(409, 'idempotency-key-reused', 'This Idempotency-Key was used for a different review request');
      return prior;
    }
    // Reserved in the same tick as the check, so two starts cannot both pass it.
    if (busyProjects.has(request.projectId)) throw new ReviewRunError(409, 'review-already-running', 'A review of this project is already running; wait for it or cancel it');
    if (busyProjects.size >= limits.maxActive) throw new ReviewRunError(429, 'review-queue-full', 'Too many reviews are running; try again later');
    busyProjects.add(request.projectId);
    let handedOff = false;
    try {
      const inputs = await deps.projectInputs(request.projectId);
      const rubricRevision = inputs.rubric?.revision ?? 0;
      if (request.rubricRevision !== rubricRevision) throw new ReviewRunError(409, 'superseded', `The rubric is at revision ${rubricRevision}; start the review from the current revision`);
      let checks: ReturnType<typeof planChecks>;
      try { checks = planChecks(inputs.rubric, inputs.context, request.scope); } catch (error) {
        if (error && typeof error === 'object' && 'fields' in error) throw new ReviewRunError(422, 'scope-outside-rubric', 'The review scope names checks outside the rubric', (error as { fields: { path: string; message: string }[] }).fields);
        throw error;
      }
      // W3: refuse a plan the run record cannot hold before anything is stored or billed, with a field error rather than a failed save.
      const largest = Math.max(checks.mechanicalCheckIds.length, checks.judgmentCheckIds.length, checks.manualCheckIds.length, checks.reviewedCheckIds.length);
      if (largest > WORKBENCH_REVIEW_MAX_CHECK_IDS) {
        throw new ReviewRunError(422, 'plan-too-large', 'The review plan is larger than a run can hold', [{ path: 'rubricRevision', message: `This rubric plans ${largest} checks in one list; a run holds at most ${WORKBENCH_REVIEW_MAX_CHECK_IDS} checks (the rubric's own plus the ones the daemon adds). Remove rubric checks and save a new revision.` }]);
      }
      const entry = await deps.entryVersion(request.projectId, request.snapshot.entry, request.snapshot.versionId);
      if (!entry) throw new ReviewRunError(404, 'revision-not-found', 'The saved revision does not exist for this project');
      // Known gap (AC-R03.1): the browser worker renders the live project files, so only the current saved revision can be reviewed.
      if (!entry.current) throw new ReviewRunError(409, 'revision-not-current', 'That saved revision is no longer the current content; restore it or review the current revision');

      const plan = resolveReviewerPlan(request.reviewerPlan);
      const reviewers = { ...deps.reviewers };
      for (const item of plan) {
        const adapter = reviewers[item.role];
        if (adapter?.forRun) reviewers[item.role] = adapter.forRun();
      }
      // Adapters whose route depends on async state settle it now, so the frozen record names the lane the run will really use.
      await Promise.all(plan.map(item => reviewers[item.role]?.prepare?.().catch(() => undefined)));
      const at = now();
      const id = `rr_${deps.newId?.() ?? randomUUID()}`;
      const run: ReviewRun = {
        schema: 'workbench-review-run/1', id, projectId: request.projectId,
        operation: { id: `op_${id.slice(3)}`, kind: 'collect-review', status: 'queued', stage: 'queued', interruptReason: null, attempt: 1, idempotencyKey, inputDigest, cancelRequested: false, error: null, createdAt: at, updatedAt: at },
        frozen: {
          snapshot: { entry: request.snapshot.entry, versionId: entry.versionId, contentDigest: entry.contentDigest },
          scope: request.scope, rubricRevision, contextRevision: inputs.context?.revision ?? 0, sourceHashes: [],
          plan: { mechanicalCheckIds: checks.mechanicalCheckIds, judgmentCheckIds: checks.judgmentCheckIds, reviewers: plan, manualCheckIds: checks.manualCheckIds },
          reviewerModelIds: plan.map(item => ({ role: item.role, modelId: reviewers[item.role]?.modelId ?? ROLE_DEFAULTS[item.role].modelId })),
          // B4-2: the allow-list is frozen with the inputs; the digest of what it fetched arrives with the evidence.
          egress: { allowHosts: request.egress?.allowHosts ?? [], fetchDigest: null },
          // B5-1: the seed and checklist versions this run applies; a later version marks it outdated.
          rubricContent: RUBRIC_CONTENT,
        },
        bundleId: null, screenshotEvidenceIds: [],
        reviewers: plan.map(item => newRecord(item, checks.reviewedCheckIds, reviewers[item.role])),
        findings: [], completedIndependentReviewers: 0, outcome: null, reasons: [], incompleteCheckIds: [], createdAt: at, endedAt: null,
      };
      await store.save(run);
      await store.saveKey(run.projectId, idempotencyKey, run.id);
      const controller = new AbortController();
      const done = execute(run, inputs, checks.reviewedCheckIds, controller, reviewers).finally(() => { active.delete(run.id); busyProjects.delete(run.projectId); });
      active.set(run.id, { run, controller, done });
      handedOff = true;
      return structuredClone(run);
    } finally {
      if (!handedOff) busyProjects.delete(request.projectId);
    }
  }

  async function execute(run: ReviewRun, inputs: ReviewProjectInputs, reviewedCheckIds: string[], controller: AbortController, reviewers: ReviewRunServiceDeps['reviewers']): Promise<void> {
    const signal = controller.signal;
    // Stops in-flight reviewer calls when the run fails for a non-cancel reason, so none mutates a finished run.
    const stop = new AbortController();
    const reviewerSignal = AbortSignal.any([signal, stop.signal]);
    const deadline = setTimeout(() => controller.abort('timeout'), limits.runMs); deadline.unref?.();
    let finalized = false;
    let saving = Promise.resolve();
    // Saves are serialized; a failed save surfaces to its caller (the run then fails explicitly) without blocking later saves.
    // Once the run is terminal only the final save may write, so a late writer can never overwrite the final record.
    const persist = (final = false) => {
      if (finalized || (!final && terminal(run))) return saving;
      const copy = structuredClone(run);
      saving = saving.catch(() => undefined).then(() => store.save(copy));
      return saving;
    };
    const touch = (patch: Partial<ReviewRun['operation']>) => { run.operation = { ...run.operation, ...patch, updatedAt: now() }; };
    let bundle: VerificationBundle | null = null;
    const screenshots: ReviewerInput['screenshots'] = [];
    const served = new Map<string, string>();
    const servedDrift = new Set<string>();
    const link = (evidence: VerificationBundle) => {
      bundle = evidence; run.bundleId = evidence.id; run.frozen.sourceHashes = evidence.sourceHashes; run.screenshotEvidenceIds = screenshots.map(shot => shot.evidenceId);
      if (run.frozen.egress) run.frozen.egress = { ...run.frozen.egress, fetchDigest: evidence.egress?.digest ?? null };
    };
    let mechanical: Promise<VerificationBundle> | null = null;
    // B5-1: every check the run is accountable for, from the inputs it froze.
    const checks = effectiveChecks(inputs.rubric, inputs.context);
    try {
      touch({ status: 'running', stage: 'mechanical' }); await persist();
      const wantsScreens = run.reviewers.some(reviewer => reviewer.role === 'claude-visual');
      const hooks: MechanicalRunHooks = {
        signal,
        ...(wantsScreens ? { screenshots: true } : {}),
        onCapture: async (width, capture) => {
          for (const file of capture.served) {
            const seen = served.get(file.path);
            if (seen !== undefined && seen !== file.sha256) servedDrift.add(file.path);
            served.set(file.path, file.sha256);
          }
          if (!wantsScreens || !capture.screenshotPng || signal.aborted) return;
          const file = await store.saveScreenshot(run.projectId, run.id, width, capture.screenshotPng).catch(() => null);
          if (file) screenshots.push({ evidenceId: `screenshot-${width}`, width, path: file });
        },
      };
      mechanical = runMechanical(run, hooks, signal);
      link(await Promise.race([mechanical, abortable(signal)]));
      const evidence = bundle!;

      const drift = frozenInputsDrift(run, evidence, servedDrift);
      if (isLegacyBundle(evidence, frozenRubricKeys(inputs.rubric, inputs.context))) {
        // Legacy evidence holds unredacted page text: it is never sent to a reviewer.
        clearTimeout(deadline);
        for (const reviewer of run.reviewers) Object.assign(reviewer, { status: 'skipped', reasonCode: 'legacy-evidence', reason: 'The evidence was recorded before evidence redaction, so it is never sent to a reviewer', recovery: 'Start a new review to collect current evidence.' });
        finish(run, evidence, 'done', null);
      } else if (drift) {
        clearTimeout(deadline);
        for (const reviewer of run.reviewers) Object.assign(reviewer, { status: 'skipped', reasonCode: 'inputs-changed', reason: 'The project changed after the review started, so no reviewer was called', recovery: 'Start a new review of the current revision.' });
        finish(run, evidence, 'interrupted', 'superseded', { inputsChanged: drift });
      } else {
        // AC-R06.5: reviewers judge only checks the frozen evidence makes applicable; the rest get their verdict without a model call.
        const applicable = applicableReviewIds(checks, reviewedCheckIds, evidence);
        for (const record of run.reviewers) record.assignedCheckIds = assign(record.role, applicable);
        touch({ stage: 'reviewers' }); await persist();
        const input = buildReviewerInput({ projectId: run.projectId, runId: run.id, entry: run.frozen.snapshot.entry, rubric: inputs.rubric, context: inputs.context, reviewedCheckIds: applicable, bundle: evidence, screenshots });
        const evidenceIds = new Set([...evidence.evidence.map(item => item.id), ...run.screenshotEvidenceIds]);
        const limit = semaphore(limits.modelConcurrency);
        await Promise.race([
          Promise.all(run.reviewers.map(record => limit(() => runReviewer(run, record, input, evidenceIds, reviewerSignal, persist, reviewers[record.role])))),
          abortable(signal),
        ]);
        clearTimeout(deadline);
        finish(run, evidence, 'done', null, { checks });
      }
    } catch (error) {
      clearTimeout(deadline);
      const aborted = signal.aborted;
      if (!aborted) stop.abort('worker-lost');
      // A cancel during capture closes the browser; wait briefly for the evidence it already captured.
      if (aborted && !bundle && mechanical) { const late = await settleWithin(mechanical, limits.cancelGraceMs); if (late) link(late); }
      for (const reviewer of run.reviewers) if (reviewer.status === 'pending' || reviewer.status === 'running') Object.assign(reviewer, { status: 'cancelled', reasonCode: aborted ? 'run-stopped' : 'operation-failed', reason: aborted ? 'The run stopped before this reviewer finished' : 'The review operation failed before this reviewer finished', recovery: 'Start a new review run; completed evidence is kept.', endedAt: reviewer.startedAt ? now() : null });
      if (aborted) finish(run, bundle, 'interrupted', interruptReasonOf(signal), { checks });
      else finish(run, bundle, 'failed', null, { checks, error: error instanceof Error ? `The review operation failed: ${error.message.slice(0, 300)}` : 'The review operation failed' });
    }
    // A final save that fails leaves the stored record running; restart reconciliation then interrupts it.
    const last = persist(true);
    finalized = true;
    await last.catch(() => undefined);
  }

  /** U1's service runs one browser job at a time; wait for it (cancellable) instead of failing the run. */
  async function runMechanical(run: ReviewRun, hooks: MechanicalRunHooks, signal: AbortSignal): Promise<VerificationBundle> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      // Persisted runs are re-validated before any egress: a stored list never skips the contract's host rules.
      const allowHosts = validatedAllowHosts(run.frozen.egress?.allowHosts ?? []);
      try { return await deps.mechanical.run(run.projectId, { entry: run.frozen.snapshot.entry, ...(allowHosts.length ? { egress: { allowHosts } } : {}) }, hooks); } catch (error) {
        if (!(error instanceof ReviewBusyError) || signal.aborted) throw error;
        await Promise.race([new Promise(resolve => setTimeout(resolve, limits.busyRetryMs)), abortable(signal)]);
      }
    }
  }

  async function runReviewer(run: ReviewRun, record: ReviewerRecord, input: ReviewerInput, evidenceIds: Set<string>, runSignal: AbortSignal, persist: () => Promise<void>, adapter: ReviewerAdapter | undefined): Promise<void> {
    // Every await below can outlive a cancel; nothing touches the record once the run stopped.
    const stopped = () => runSignal.aborted || terminal(run);
    if (stopped()) return;
    const set = (patch: Partial<ReviewerRecord>) => Object.assign(record, patch);
    if (!adapter) { set({ status: 'skipped', reasonCode: 'not-configured', reason: 'This reviewer is not configured on this daemon', recovery: 'Configure the provider in Settings, or deselect this reviewer for the run.' }); await persist(); return; }
    // W5: nothing applicable to review means no call and no billing, not a reviewer failure.
    if (!record.assignedCheckIds.length) { set({ status: 'skipped', reasonCode: 'no-applicable-checks', reason: 'No applicable checks were assigned to this reviewer, so it was not called', recovery: 'Widen the review scope, or review a page whose evidence makes these checks applicable.' }); await persist(); return; }
    const availability = await adapter.availability().catch(() => ({ available: false as const, reason: 'The reviewer availability check failed', recovery: 'Check the provider settings, then run the review again.', code: 'availability-check-failed' as const }));
    if (stopped()) return;
    if (!availability.available) { set({ status: 'skipped', reasonCode: availability.code ?? 'unavailable', reason: availability.reason, recovery: availability.recovery }); await persist(); return; }
    const assigned = input.checks.filter(check => record.assignedCheckIds.includes(check.checkId));
    const scoped: ReviewerInput = { ...input, checks: assigned, screenshots: record.role === 'claude-visual' ? input.screenshots : [] };
    // Captain decision 1: never send a reviewer more than its limit; split its checks into calls no larger than maxChecks.
    const size = adapter.maxChecks && adapter.maxChecks > 0 ? adapter.maxChecks : assigned.length;
    const chunks: ReviewerInput[] = [];
    for (let index = 0; index < assigned.length; index += size) chunks.push({ ...scoped, checks: assigned.slice(index, index + size) });
    // R03: an adapter that will make no call for a chunk (every check abstains) says so up front; nothing is reserved or counted for it.
    const planned = chunks.map(chunk => Math.max(0, Math.trunc(adapter.plannedCalls?.(chunk) ?? 1)));
    const plannedTotal = planned.reduce((sum, calls) => sum + calls, 0);
    const startedAt = now();
    // Every chunk is a billed call. All of them are reserved up front (so two reviewers cannot overrun the cap together),
    // and a reservation is returned for every chunk that was never sent, so a failed first call does not consume the rest.
    let reserved = 0;
    if (billed(record)) {
      const used = billedCalls.day === startedAt.slice(0, 10) ? billedCalls.count : 0;
      const remain = Math.max(0, limits.dailyBilledCalls - used);
      if (plannedTotal > remain) {
        set({ status: 'skipped', reasonCode: 'daily-limit', reason: `This reviewer needs ${plannedTotal} billed call${plannedTotal === 1 ? '' : 's'}; ${remain} remain of this daemon's daily limit of ${limits.dailyBilledCalls}`, recovery: 'Run the review again after midnight UTC, narrow the review scope, or deselect billed reviewers for this run.' });
        await persist(); return;
      }
      for (let call = 0; call < plannedTotal; call++) countBilledCall(startedAt);
      reserved = plannedTotal;
    }
    const release = () => { if (reserved && billedCalls.day === startedAt.slice(0, 10)) billedCalls.count = Math.max(0, billedCalls.count - reserved); reserved = 0; };
    set({ status: 'running', startedAt, inputDigest: sha256(JSON.stringify(scoped)), providerCalls: 0 }); await persist();
    if (stopped()) { release(); return; }
    let signal: AbortSignal = runSignal;
    try {
      const parts: Awaited<ReturnType<ReviewerAdapter['review']>>[] = [];
      for (const [index, chunk] of chunks.entries()) {
        signal = AbortSignal.any([runSignal, AbortSignal.timeout(limits.perCallMs)]);
        const calls = planned[index]!;
        reserved = Math.max(0, reserved - calls);
        // Recorded before the call is sent, so a crash mid-call can never undercount on restart.
        if (calls) { set({ providerCalls: (record.providerCalls ?? 0) + calls }); await persist(); }
        parts.push(await Promise.race([adapter.review(chunk, signal), abortable(signal)]));
        if (stopped()) { release(); return; }
      }
      const result = {
        verdicts: parts.flatMap(part => part.verdicts),
        rawOutput: parts.length === 1 ? parts[0]!.rawOutput : parts.map((part, index) => `[call ${index + 1} of ${parts.length}]\n${part.rawOutput}`).join('\n'),
        inputMode: parts.find(part => part.inputMode === 'text-only-fallback')?.inputMode ?? parts[parts.length - 1]!.inputMode,
        fallback: parts.find(part => part.fallback)?.fallback,
      };
      const fallback = result.inputMode === 'text-only-fallback';
      // Invariant: a reviewer whose role needs vision is never an independent completion unless it read the screenshots.
      if (fallback && VISION_ROLES.has(record.role)) {
        // R03: the record names the observed cause (no screenshot, a denied or failed read, no read attempted).
        const cause = result.fallback ?? visualFallback(scoped.screenshots);
        set({ status: 'skipped', inputMode: result.inputMode, reasonCode: cause.code, reason: cause.reason, recovery: cause.recovery, rawOutput: result.rawOutput.slice(0, RAW_OUTPUT_LIMIT), endedAt: now() });
        run.completedIndependentReviewers = run.reviewers.filter(isIndependentReviewerCompletion).length;
        await persist(); return;
      }
      const findings: ReviewFinding[] = result.verdicts.filter(verdict => record.assignedCheckIds.includes(verdict.checkId)).map(verdict => {
        const evidenceRefs = verdict.evidenceRefs.filter(ref => evidenceIds.has(ref));
        // R03: an abstention is an uncertain judgment with no probability and no evidence, whatever the adapter sent.
        if (verdict.abstain) return { id: `${record.role}-${verdict.checkId}`.slice(0, 120), reviewerRole: record.role, checkId: verdict.checkId, verdict: 'uncertain', kind: 'judgment', evidenceRefs: [], rationale: verdict.rationale.slice(0, 2000), probability: null, abstainReason: verdict.abstain };
        return { id: `${record.role}-${verdict.checkId}`.slice(0, 120), reviewerRole: record.role, checkId: verdict.checkId, verdict: verdict.verdict, kind: !fallback && evidenceRefs.length ? 'evidence-linked' : 'judgment', evidenceRefs, rationale: verdict.rationale.slice(0, 2000), probability: verdict.probability };
      });
      const answered = new Set(findings.map(finding => finding.checkId));
      run.findings.push(...findings);
      set({ status: 'completed', inputMode: result.inputMode, unansweredCheckIds: record.assignedCheckIds.filter(id => !answered.has(id)), rawOutput: result.rawOutput.slice(0, RAW_OUTPUT_LIMIT), endedAt: now() });
      run.completedIndependentReviewers = run.reviewers.filter(isIndependentReviewerCompletion).length;
    } catch (error) {
      release();
      if (stopped()) return;
      if (signal.aborted) set({ status: 'failed', reasonCode: 'timeout', reason: `The reviewer did not answer within ${Math.round(limits.perCallMs / 60_000)} minutes`, recovery: 'Run the review again; if it repeats, deselect this reviewer for the run.', endedAt: now() });
      else if (error instanceof ReviewerCallError) set({ status: 'failed', reasonCode: error.code, reason: error.message.slice(0, 500), recovery: error.recovery.slice(0, 500), endedAt: now() });
      else set({ status: 'failed', reasonCode: 'unexpected-error', reason: 'The reviewer call failed unexpectedly', recovery: 'Run the review again; if it repeats, deselect this reviewer for the run.', endedAt: now() });
    }
    await persist();
  }

  /**
   * AC-R03.1 for egress: the stored evidence must still carry the egress
   * digest this run froze. The digest is an unkeyed corruption check, so a
   * mismatch says the evidence changed, not who changed it.
   */
  async function egressEvidenceProblem(run: ReviewRun): Promise<string | null> {
    const frozen = run.frozen.egress?.fetchDigest;
    if (!frozen || !run.bundleId) return null;
    let stored: VerificationBundle | null;
    try { stored = await deps.mechanical.read(run.projectId, run.bundleId); } catch {
      return 'The stored evidence could not be verified against its egress digest';
    }
    if (stored?.egress?.digest !== frozen) return 'The stored evidence no longer carries the egress digest this run froze';
    return null;
  }

  async function read(projectId: string, runId: string): Promise<ReviewRunView> {
    await ensureReady();
    const run = await store.read(projectId, runId);
    if (!run) throw new ReviewRunError(404, 'run-not-found', 'No such review run for this project');
    const inputs = await deps.projectInputs(projectId);
    const entry = await deps.entryVersion(projectId, run.frozen.snapshot.entry, null).catch(() => null);
    const freshness = await reviewFreshness(run, { root: inputs.root, rubricRevision: inputs.rubric?.revision ?? 0, contextRevision: inputs.context?.revision ?? 0, entry, rubricContent: RUBRIC_CONTENT });
    const evidence = await egressEvidenceProblem(run);
    if (evidence) { freshness.state = 'outdated'; freshness.reasons = [...freshness.reasons, evidence].slice(0, 50); }
    return { run, freshness, reconciliation: reconciliationStatus(projectId) };
  }

  /** Cancel keeps every completed record and marks the run interrupted (user-cancelled) with partial status. */
  async function cancel(projectId: string, runId: string): Promise<ReviewRunView> {
    await ensureReady();
    const run = await store.read(projectId, runId);
    if (!run) throw new ReviewRunError(404, 'run-not-found', 'No such review run for this project');
    const handle = active.get(runId);
    if (!handle) throw new ReviewRunError(409, 'run-not-active', 'This review run is not running');
    handle.run.operation = { ...handle.run.operation, cancelRequested: true, updatedAt: now() };
    handle.controller.abort('user-cancelled');
    await handle.done;
    return read(projectId, runId);
  }

  async function list(projectId: string): Promise<ReviewRunSummary[]> {
    await ensureReady();
    return (await store.list(projectId)).map(run => ({ id: run.id, entry: run.frozen.snapshot.entry, status: run.operation.status, outcome: run.outcome, createdAt: run.createdAt, endedAt: run.endedAt }));
  }

  /** Test and shutdown hook: resolves when every running review has persisted its final record. */
  async function idle(): Promise<void> { await ready; await Promise.all([...active.values()].map(handle => handle.done)); }

  const decideFinding = createFindingDecisions(store, ready, now, read);
  return { start, read, cancel, list, idle, decideFinding, reconciliationStatus, screenshotDir: store.screenshotDir };
}
export type ReviewRunService = ReturnType<typeof createReviewRunService>;

/** Reviewed checks the frozen evidence makes applicable: mechanical checks always, judgment checks only when applicable without a mismatch. */
export function applicableReviewIds(checks: readonly EffectiveCheck[], reviewedCheckIds: readonly string[], bundle: VerificationBundle): string[] {
  const byId = new Map(checks.map(check => [check.checkId, check]));
  const observed = bundle.observedBehaviors ?? null;
  return reviewedCheckIds.filter(id => {
    const check = byId.get(id);
    if (!check || check.kind !== 'judgment') return true;
    const applicability = evaluateApplicability(check, observed);
    return applicability.status === 'applicable' && applicability.basis !== 'mismatch';
  });
}
