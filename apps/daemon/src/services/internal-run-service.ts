/**
 * Daemon-internal seam for preparing and starting one physical chat Run.
 *
 * HTTP routes remain responsible for parsing, authorization, snapshot
 * resolution, response formatting, and lifecycle observers. Callers hand this
 * service the already-resolved run identity/prompt/session inputs so a future
 * coordinator can reuse the same create -> claim -> start transaction without
 * calling the daemon through HTTP.
 */
import type { RunAnalyticsFacts } from './run-analytics-lifecycle.js';

/**
 * `RunAnalyticsFacts` is a REQUIRED argument of `start` on purpose. Analytics
 * used to be installed by whichever caller remembered to do it, and four
 * daemon-internal Run creators silently reported nothing (OPEND-2365). Making
 * the facts part of the start contract means a new caller has to state its
 * analytics identity — including stating that it has none — instead of dropping
 * the Run. The type is owned by the lifecycle so the choke point and the
 * lifecycle cannot drift apart.
 */
export interface InternalRunCreateInput extends Record<string, unknown> {
  /** Daemon-owned nonce shared by this run's keyed host protocol markers. */
  doneKey?: string;
  projectId?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  clientRequestId?: string;
  requestFingerprint?: string;
  agentId?: string;
  pluginId?: string;
  appliedPluginSnapshotId?: string;
  message?: string;
  currentPrompt?: string;
  sessionMode?: string;
  analyticsHints?: Record<string, unknown>;
  /** Daemon-owned immutable OD Next task input descriptor; never accepted from callers. */
  odNextTaskInputSnapshot?: {
    taskExecutionId: string;
    snapshotDir: string;
    manifestSha256: string;
  } | null;
}

export interface InternalPhysicalRun {
  id: string;
  status: string;
}

export interface InternalRunAnalyticsLifecycle<TRun> {
  install(input: RunAnalyticsFacts & { run: TRun }): void;
}

export interface InternalRunRegistry<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
> {
  createOrReuse(meta: TMeta):
    | { kind: 'created'; run: TRun }
    | { kind: 'reused'; run: TRun }
    | { kind: 'conflict'; run: TRun };
  prepareRestart(run: TRun): TRun | null;
  get(id: string): TRun | null;
  drop(run: TRun): void;
  start(run: TRun, starter: () => Promise<unknown>): TRun;
  isTerminal(status: TRun['status']): boolean;
}

export interface AssistantRunClaimOptions {
  status?: string;
  beforeClaimCommit?: () => void;
  isRunActive?: (runId: string) => boolean;
}

export type AssistantRunClaimResult = {
  ok: boolean;
  reason?: 'active' | 'scope';
};

export interface PrepareInternalRunInput<TMeta extends InternalRunCreateInput, TRun> {
  meta: TMeta;
  /**
   * Runs inside the assistant-message claim transaction. The newly allocated
   * physical Run is supplied so a logical coordinator can CAS-claim that exact
   * id before either record becomes visible.
   */
  beforeClaimCommit?: (run: TRun) => void;
  resume?: {
    requested: boolean;
    canResume: (run: TRun) => boolean;
  };
}

export type PreparedInternalRunResult<TRun> =
  | { kind: 'ready'; run: TRun; creationKind: 'created' | 'reused'; resumed: boolean }
  | { kind: 'reused'; run: TRun }
  | { kind: 'idempotency_conflict'; run: TRun }
  | { kind: 'resume_not_allowed'; run: TRun }
  | { kind: 'assistant_claim_conflict'; run: TRun; reason?: 'active' | 'scope' };

/**
 * Coordinated run lifetime admitted at this choke point (absent in ordinary
 * mode). Admission precedes allocation or deferred start, freezes the
 * project scope, and holds it until children and reserved final work drain.
 * The placement runtime's `PlacementRunLifetime` implements this shape.
 */
export interface InternalRunLifetime<TAdmission extends InternalRunAdmission = InternalRunAdmission> {
  admit(input: { projectIds: readonly string[]; signal?: AbortSignal }): Promise<TAdmission>;
}
/** Opaque admitted run; a run reuses it and never requests a nested overlapping admission. */
export interface InternalRunAdmission {
  allocate<T>(work: () => Promise<T>): Promise<T>;
  start(): Promise<void>;
  cancel(): void;
  /** Seals new work; settles only after children and reserved final work drain. */
  finish(): Promise<void>;
  /**
   * Reserved final cleanup. An unstarted run may use it for data-root writes
   * only; the coordinator refuses it on owner/recovery loss or once finished.
   */
  reserveFinal?(kind: 'cleanup'): {
    dataRootWrite<T>(work: (guard: { assertCurrent(): void }) => Promise<T>): Promise<T>;
    settle(): void;
  };
}
export interface AdmittedPreparedRun<TRun, TAdmission extends InternalRunAdmission = InternalRunAdmission> {
  prepared: PreparedInternalRunResult<TRun>;
  /** Null in ordinary mode or when preparation did not yield a ready Run. */
  admission: TAdmission | null;
}

export interface InternalRunCreationService<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
> {
  prepare(input: PrepareInternalRunInput<TMeta, TRun>): PreparedInternalRunResult<TRun>;
  start(
    run: TRun,
    analytics: RunAnalyticsFacts,
    starter: (run: TRun) => Promise<unknown>,
    admissionMeta?: TMeta,
  ): TRun;
}
/**
 * Admitted variants of the same choke point for coordinated callers. Ordinary
 * mode (no lifetime) degrades to `prepare`/`start` with a null admission.
 */
export interface AdmittedInternalRunCreation<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
  TAdmission extends InternalRunAdmission = InternalRunAdmission,
> {
  /** Admit (coordinated) before allocation, then prepare inside the run allocation. */
  admitAndPrepare(
    input: PrepareInternalRunInput<TMeta, TRun>,
    scope: { projectIds: readonly string[]; signal?: AbortSignal },
  ): Promise<AdmittedPreparedRun<TRun, TAdmission>>;
  /** Admit a deferred (already allocated) Run before its start; null in ordinary mode. */
  admitDeferred(scope: { projectIds: readonly string[]; signal?: AbortSignal }): Promise<TAdmission | null>;
  /** True when a coordinated run lifetime admits runs (selected placement mode). */
  readonly coordinated?: boolean;
  /**
   * An allocated admitted Run was refused before its registry start. Terminate
   * it through a reserved cleanup ticket (never an unguarded owner-lost write),
   * then seal the admission. Without a cleanup ticket the run is retained.
   */
  refuseAdmitted?(run: TRun, admission: TAdmission, error: unknown): Promise<void>;
  /** Start under an admission: frozen-scope start before spawn. The run's terminal owner finishes it after child and final-work custody. */
  startAdmitted(
    run: TRun,
    analytics: RunAnalyticsFacts,
    starter: (run: TRun) => Promise<unknown>,
    admission: TAdmission | null,
    admissionMeta?: TMeta,
    beforeRegistryStart?: (admission: TAdmission) => void,
  ): Promise<TRun>;
}

export function createInternalRunCreationService<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
  TAdmission extends InternalRunAdmission = InternalRunAdmission,
>(deps: {
  runs: InternalRunRegistry<TMeta, TRun>;
  claimAssistantMessage: (
    run: TRun,
    options?: AssistantRunClaimOptions,
  ) => AssistantRunClaimResult;
  /**
   * Armed for every physical Run this service starts, whoever asked for it.
   * Required: an optional dependency would let a future factory construct this
   * service, satisfy the `.runs.start` guard, and still emit nothing. A harness
   * that wants silence injects a no-op lifecycle and says so.
   */
  analyticsLifecycle: InternalRunAnalyticsLifecycle<TRun>;
  /** Daemon conversation admission applies to every creator, including internal stages. */
  claimAdmission?: (run: TRun, meta: TMeta) => void;
  assertRecovery?: (run: TRun) => void;
  /**
   * Placement fence (ordinary C2a transition fences or coordinated recovery).
   * Runs before allocation and again before start; throws a mapped error.
   */
  assertMutationAdmissible?: (projectId: string | undefined) => void;
  runLifetime?: InternalRunLifetime<TAdmission> | null;
  /**
   * Terminates an allocated Run whose admitted start was refused (B2), so no
   * queued Run, idempotency claim or assistant claim outlives the refusal.
   * Called only inside the reserved cleanup write, after its guard passed.
   */
  discardRefusedRun?: (run: TRun, error: unknown) => void;
  /**
   * Registers each admitted project's CURRENT authorized location before run
   * admission, outside any permit (as standalone project writes do), so a
   * project created after boot is admitted instead of refused as unknown.
   */
  registerAdmissionProjects?: (scope: { projectIds: readonly string[]; signal?: AbortSignal }) => Promise<void>;
}): InternalRunCreationService<TMeta, TRun> & AdmittedInternalRunCreation<TMeta, TRun, TAdmission> {
  const preparedRuns = new WeakSet<TRun>();
  const isRunActive = (runId: string): boolean => {
    const existing = deps.runs.get(runId);
    return Boolean(existing && !deps.runs.isTerminal(existing.status));
  };

  const prepare = (
    input: PrepareInternalRunInput<TMeta, TRun>,
  ): PreparedInternalRunResult<TRun> => {
    deps.assertMutationAdmissible?.(input.meta.projectId);
    const creation = deps.runs.createOrReuse(input.meta);
    if (creation.kind === 'conflict') {
      return { kind: 'idempotency_conflict', run: creation.run };
    }

    const run = creation.run;
    if (creation.kind === 'reused') {
      if (!input.resume?.requested) return { kind: 'reused', run };
      if (!input.resume.canResume(run)) return { kind: 'resume_not_allowed', run };
      deps.assertRecovery?.(run);

      const claim = deps.claimAssistantMessage(run, {
        status: 'queued',
        isRunActive,
      });
      if (!claim.ok) {
        return {
          kind: 'assistant_claim_conflict',
          run,
          ...(claim.reason ? { reason: claim.reason } : {}),
        };
      }
      if (!deps.runs.prepareRestart(run)) {
        return { kind: 'resume_not_allowed', run };
      }
      preparedRuns.add(run);
      return { kind: 'ready', run, creationKind: 'reused', resumed: true };
    }

    let claim: AssistantRunClaimResult;
    try {
      claim = deps.claimAssistantMessage(run, {
        ...((input.beforeClaimCommit || deps.claimAdmission)
          ? { beforeClaimCommit: () => { deps.claimAdmission?.(run, input.meta); input.beforeClaimCommit?.(run); } }
          : {}),
        isRunActive,
      });
    } catch (error) {
      // The registry create is optimistic. A failed ownership transaction must
      // not leave a physical Run that can be listed, streamed, or reconciled.
      deps.runs.drop(run);
      throw error;
    }
    if (!claim.ok) {
      deps.runs.drop(run);
      return {
        kind: 'assistant_claim_conflict',
        run,
        ...(claim.reason ? { reason: claim.reason } : {}),
      };
    }
    preparedRuns.add(run);
    return { kind: 'ready', run, creationKind: 'created', resumed: false };
  };

  const start: InternalRunCreationService<TMeta, TRun>['start'] = (run, analytics, starter, admissionMeta) => {
    deps.assertMutationAdmissible?.(admissionMeta?.projectId ?? (run as { projectId?: string }).projectId);
    // Deferred autonomous creators allocate before their durable scheduler
    // slot exists. Admit the prepared final conversation before any spawn.
    if (deps.claimAdmission && !preparedRuns.has(run)) {
      if (!admissionMeta) throw new Error('Unprepared internal run requires immutable admission inputs');
      const claim = deps.claimAssistantMessage(run, { isRunActive, beforeClaimCommit: () => deps.claimAdmission!(run, admissionMeta) });
      if (!claim.ok) throw new Error('Autonomous run ownership claim failed');
      preparedRuns.add(run);
    }
    // Before the child is spawned: `run_created` describes a Run that has
    // been accepted, and the terminal half must already be attached when the
    // Run settles — including a Run that fails on its first tick.
    deps.analyticsLifecycle.install({ ...analytics, run });
    return deps.runs.start(run, () => starter(run));
  };
  const admit = async (scope: { projectIds: readonly string[]; signal?: AbortSignal }) => {
    if (!deps.runLifetime) return null;
    await deps.registerAdmissionProjects?.(scope);
    return await deps.runLifetime.admit(scope);
  };
  const refuseAdmitted = async (run: TRun, admission: TAdmission, error: unknown): Promise<void> => {
    let cleanup: ReturnType<NonNullable<InternalRunAdmission['reserveFinal']>> | null = null;
    if (deps.discardRefusedRun && !deps.runs.isTerminal(run.status)) {
      // Owner/recovery loss or an already released permit refuses the ticket:
      // the run is then retained rather than terminated by an unsafe write.
      try { cleanup = admission.reserveFinal?.('cleanup') ?? null; }
      catch (cleanupError) { console.warn('[placement] refused run retained without cleanup ticket', cleanupError); }
    }
    // A cancel that already drained this permit must not mask the refusal.
    try { admission.cancel(); } catch { /* permit already released */ }
    if (cleanup) {
      const ticket = cleanup;
      try {
        await ticket.dataRootWrite(async (guard) => {
          guard.assertCurrent();
          if (!deps.runs.isTerminal(run.status)) deps.discardRefusedRun!(run, error);
        });
      } catch (cleanupError) {
        console.warn('[placement] refused run cleanup was not admitted', cleanupError);
      } finally {
        ticket.settle();
      }
    }
    void admission.finish().catch(() => undefined);
  };

  return {
    prepare,
    start,
    coordinated: Boolean(deps.runLifetime),
    refuseAdmitted,
    admitDeferred: admit,
    async admitAndPrepare(input, scope) {
      const admission = await admit(scope);
      if (!admission) return { prepared: prepare(input), admission: null };
      let prepared: PreparedInternalRunResult<TRun>;
      try { prepared = await admission.allocate(async () => prepare(input)); }
      catch (error) { await admission.finish(); throw error; }
      if (prepared.kind !== 'ready') { await admission.finish(); return { prepared, admission: null }; }
      return { prepared, admission };
    },
    async startAdmitted(run, analytics, starter, admission, admissionMeta, beforeRegistryStart) {
      if (!admission) return start(run, analytics, starter, admissionMeta);
      try {
        // Frozen-scope start precedes the starter, so no child can spawn first.
        await admission.start();
        beforeRegistryStart?.(admission);
        return start(run, analytics, starter, admissionMeta);
      } catch (error) {
        await refuseAdmitted(run, admission, error);
        throw error;
      }
    },
  };
}
