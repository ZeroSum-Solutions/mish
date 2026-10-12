/**
 * Drives the second physical Run of a staged-drafting turn.
 *
 * The draft Run is started by the normal run route. This module waits for it,
 * records its outcome and timing on the shared chain, then starts the finishing
 * Run — or, when the draft failed, one main-model Run in its place. Every Run
 * is started through `internalRuns.start` (AGENTS "Starting a physical Run").
 */
import { createHash } from 'node:crypto';

import type {
  StagedRunRecord,
  StagedStageKind,
  StagedStageRecord,
  StagedStopReason,
} from '@open-design/contracts';

import { INTERRUPTED_MESSAGE, STAGED_FALLBACK_MESSAGES } from '../staged-routing.js';

export interface StagedChainRun {
  id: string;
  status: string;
  staged?: StagedRunRecord;
}

export interface StagedStagePreparation<TMeta> {
  meta: TMeta;
  analytics: unknown;
}

export interface StagedChainDeps<TRun extends StagedChainRun, TMeta> {
  chain: StagedRunRecord;
  draftRun: TRun;
  now?: () => number;
  /** Called after every change to the chain, so it can be persisted. */
  onChange?: () => void;
  wait(run: TRun): Promise<{ status: string; cancelOrigin?: string | null }>;
  /** Builds the request for the next Run (admission, prompt); may throw. */
  prepareStage(kind: 'finish' | 'single'): Promise<StagedStagePreparation<TMeta>>;
  internalRuns: {
    prepare(input: { meta: TMeta }): { kind: string; run: TRun };
    start(
      run: TRun,
      analytics: never,
      starter: (run: TRun) => Promise<unknown>,
    ): TRun;
  };
  startChatRun(meta: TMeta, run: TRun): Promise<unknown>;
  /** True when the draft Run ended by asking the user a question. */
  draftEndedWithQuestion?(run: TRun): boolean;
  /** True when a newer user turn started in the conversation after the draft. */
  newerTurnExists?(draftRun: TRun): boolean;
  /** Releases a Run that was prepared but could not be started. */
  discardRun?(run: TRun, error: unknown): void;
  reconcileRun?(run: TRun): void;
}

const stageOf = (chain: StagedRunRecord, kind: StagedStageKind): StagedStageRecord | undefined =>
  chain.stages.find((stage) => stage.stage === kind);

function begin(stage: StagedStageRecord, runId: string, at: number): void {
  stage.runId = runId;
  stage.status = 'running';
  stage.startedAt = at;
}

function end(stage: StagedStageRecord, status: StagedStageRecord['status'], at: number): void {
  stage.status = status;
  stage.endedAt = at;
  stage.durationMs = stage.startedAt === null ? null : Math.max(0, at - stage.startedAt);
}

const STOP_MESSAGES: Record<StagedStopReason, string> = {
  canceled: 'Stopped by the user; no further pass runs.',
  question_form: 'The draft ended with a question; the next turn starts a fresh chain.',
  superseded: 'A newer turn started in this conversation; the pending pass was dropped.',
};

/**
 * End the chain: nothing further starts. The first reason wins. Pending stages
 * are skipped; the ids of stages still running are returned so the caller can
 * cancel their Runs.
 */
export function stopChain(chain: StagedRunRecord, reason: StagedStopReason): string[] {
  if (!chain.stopped) chain.stopped = { reason, message: STOP_MESSAGES[reason] };
  chain.interrupted = null;
  const running: string[] = [];
  for (const stage of chain.stages) {
    if (stage.status === 'pending' || stage.status === 'interrupted') stage.status = 'skipped';
    else if (stage.status === 'running' && stage.runId) running.push(stage.runId);
  }
  return running;
}

const terminalStatus = (status: string): StagedStageRecord['status'] =>
  status === 'succeeded' ? 'succeeded' : status === 'canceled' ? 'canceled' : 'failed';

/** Start the finish or fallback stage; records the outcome on the chain. */
function makeStarter<TRun extends StagedChainRun, TMeta>(deps: StagedChainDeps<TRun, TMeta>) {
  const now = deps.now ?? Date.now;
  const changed = () => deps.onChange?.();
  const persistTerminal = () => {
    try { changed(); } catch (error) { console.warn('[staged] terminal chain could not be saved', error); }
  };
  return async (kind: 'finish' | 'single'): Promise<{ ok: true; runId: string } | { ok: false; message: string }> => {
    const { chain } = deps;
    let stage = stageOf(chain, kind);
    if (!stage) {
      const base = stageOf(chain, 'finish')!;
      stage = { ...base, stage: kind, runId: null, status: 'pending', startedAt: null, endedAt: null, durationMs: null };
      chain.stages.push(stage);
    }
    let allocated: TRun | null = null;
    const dropped = (): boolean => {
      if (!chain.stopped && deps.newerTurnExists?.(deps.draftRun)) stopChain(chain, 'superseded');
      if (!chain.stopped) return false;
      stage!.status = 'skipped';
      changed();
      return true;
    };
    try {
      if (dropped()) return { ok: false, message: 'stopped' };
      changed();
      const prepared = await deps.prepareStage(kind);
      // A cancel or newer turn can land while the pass is being prepared.
      if (dropped()) return { ok: false, message: 'stopped' };
      const result = deps.internalRuns.prepare({ meta: prepared.meta });
      if (result.kind !== 'ready') throw new Error(`Run was not admitted (${result.kind})`);
      const run = result.run;
      allocated = run;
      deps.reconcileRun?.(run);
      run.staged = chain;
      begin(stage, run.id, now());
      changed();
      deps.internalRuns.start(run, prepared.analytics as never, () => deps.startChatRun(prepared.meta, run));
      allocated = null;
      void deps
        .wait(run)
        .then((final) => {
          end(stage!, terminalStatus(final.status), now());
          // A shutdown cut this pass short: keep the draft and offer "Finish now".
          if (final.status === 'canceled' && final.cancelOrigin === 'daemon_shutdown' && kind === 'finish') {
            stage!.status = 'interrupted';
            chain.interrupted = { message: INTERRUPTED_MESSAGE };
          }
          persistTerminal();
        })
        .catch(() => { end(stage!, 'failed', now()); persistTerminal(); });
      return { ok: true, runId: run.id };
    } catch (error) {
      console.warn(`[staged] ${kind} stage could not start`, error);
      // A prepared Run that never started would sit queued and hold its claim.
      if (allocated) {
        try { deps.discardRun?.(allocated, error); } catch { /* best effort */ }
      }
      end(stage, 'failed', now());
      persistTerminal();
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Start recording the draft stage and follow it to its end. Fire and forget. */
export function followStagedDraft<TRun extends StagedChainRun, TMeta>(
  deps: StagedChainDeps<TRun, TMeta>,
): void {
  const { chain, draftRun } = deps;
  const draft = stageOf(chain, 'draft');
  if (!draft) return;
  const now = deps.now ?? Date.now;
  const startNext = makeStarter(deps);
  draftRun.staged = chain;
  begin(draft, draftRun.id, now());
  deps.onChange?.();

  void deps
    .wait(draftRun)
    .then(async (final) => {
      const status = terminalStatus(final.status);
      end(draft, status, now());
      const finish = stageOf(chain, 'finish');
      if (status === 'succeeded') {
        // A draft that asked the user something hands the turn back to them.
        if (!chain.stopped && deps.draftEndedWithQuestion?.(draftRun)) stopChain(chain, 'question_form');
        deps.onChange?.();
        if (chain.stopped) {
          if (finish && finish.status === 'pending') finish.status = 'skipped';
          deps.onChange?.();
          return;
        }
        await startNext('finish');
        return;
      }
      // A canceled draft means the user stopped the turn: spend nothing more.
      if (finish) finish.status = 'skipped';
      if (status === 'canceled') {
        if (!chain.stopped && final.cancelOrigin !== 'daemon_shutdown') stopChain(chain, 'canceled');
      } else {
        chain.fallback = { reason: 'draft_failed', message: STAGED_FALLBACK_MESSAGES.draft_failed };
      }
      deps.onChange?.();
      if (status !== 'canceled' && !chain.stopped) await startNext('single');
    })
    .catch((error) => {
      console.warn('[staged] draft follow-up failed', error);
    });
}

/** "Finish now": start the finishing pass of a chain a restart interrupted. */
export async function finishInterruptedChain<TRun extends StagedChainRun, TMeta>(
  deps: StagedChainDeps<TRun, TMeta>,
): Promise<{ ok: true; runId: string } | { ok: false; code: 'NOT_INTERRUPTED' | 'START_FAILED' | 'SUPERSEDED'; message: string }> {
  if (deps.chain.stopped?.reason === 'superseded') {
    return { ok: false, code: 'SUPERSEDED', message: STOP_MESSAGES.superseded };
  }
  if (deps.chain.stopped) {
    return { ok: false, code: 'NOT_INTERRUPTED', message: deps.chain.stopped.message };
  }
  if (!deps.chain.interrupted) {
    return { ok: false, code: 'NOT_INTERRUPTED', message: 'This run has no interrupted finishing pass.' };
  }
  if (deps.newerTurnExists?.(deps.draftRun)) {
    stopChain(deps.chain, 'superseded');
    deps.chain.interrupted = null;
    deps.onChange?.();
    return { ok: false, code: 'SUPERSEDED', message: STOP_MESSAGES.superseded };
  }
  const finish = stageOf(deps.chain, 'finish');
  deps.draftRun.staged = deps.chain;
  if (finish) finish.status = 'pending';
  deps.chain.interrupted = null;
  deps.onChange?.();
  const started = await makeStarter(deps)('finish');
  if (!started.ok) {
    // Cancel/supersede can replace this optional field during preparation.
    const stopped = deps.chain.stopped as StagedRunRecord['stopped'];
    if (stopped) {
      return { ok: false, code: stopped.reason === 'superseded' ? 'SUPERSEDED' : 'NOT_INTERRUPTED', message: stopped.message };
    }
    deps.chain.interrupted = { message: INTERRUPTED_MESSAGE };
    if (finish) finish.status = 'interrupted';
    deps.onChange?.();
    return { ok: false, code: 'START_FAILED', message: started.message };
  }
  return started;
}

export interface StagedStageMetaInput {
  /** Meta the draft Run was started with. */
  draftMeta: Record<string, unknown>;
  draftRunId: string;
  kind: 'finish' | 'single';
  /** The user's request text, before any replay composition. */
  originalPrompt: string;
  /** Main-model admission result for this stage. */
  main: {
    agentId: string;
    model: string;
    reasoning?: unknown;
    serviceTier?: unknown;
    prepared?: unknown;
    replayInput?: { message: string; currentPrompt: string; priorTranscript: string } | null;
  };
  stagePrompt: string;
  lineage: Record<string, unknown>;
  /** Id of this stage's previous Run, so a retry (Finish now) gets fresh ids. */
  previousRunId?: string | null;
}

/**
 * Meta for the Run that follows the draft. It reuses everything the draft was
 * created with (project, conversation, tools, workspace) but takes the main
 * model, a prompt of its own and fresh ids, so it never collides with the
 * draft's assistant message or idempotency claim.
 */
export function buildStagedStageMeta(input: StagedStageMetaInput): Record<string, unknown> {
  const digest = createHash('sha256')
    .update(`${input.draftRunId}:${input.kind}:${input.previousRunId ?? ''}`)
    .digest('hex');
  const replay = input.main.replayInput;
  const meta: Record<string, unknown> = {
    ...input.draftMeta,
    agentId: input.main.agentId,
    model: input.main.model,
    reasoning: input.main.reasoning,
    serviceTier: input.main.serviceTier,
    message: replay?.message ?? input.stagePrompt,
    currentPrompt: replay?.currentPrompt ?? input.stagePrompt,
    priorTranscript: replay?.priorTranscript ?? '',
    userMessageId: undefined,
    titleGeneration: undefined,
    continueFromRunId: undefined,
    expectedModelRevision: undefined,
    _inheritedSessionAdmission: undefined,
    assistantMessageId: `staged_assistant_${digest.slice(0, 32)}`,
    clientRequestId: `staged_run_${digest.slice(0, 40)}`,
    requestFingerprint: digest,
    analyticsHints: {
      ...((input.draftMeta.analyticsHints as Record<string, unknown> | undefined) ?? {}),
      ...input.lineage,
      stagedStage: input.kind,
    },
  };
  if (input.main.prepared) meta._preparedSessionAdmission = input.main.prepared;
  else delete meta._preparedSessionAdmission;
  return meta;
}

/** Record start/end of the lone main-model stage of a turn that was not staged. */
export function trackSingleStage<TRun extends StagedChainRun>(
  record: StagedRunRecord,
  run: TRun,
  wait: (run: TRun) => Promise<{ status: string }>,
  now: () => number = Date.now,
): void {
  const stage = stageOf(record, 'single');
  if (!stage) return;
  begin(stage, run.id, now());
  void wait(run)
    .then((final) => end(stage, terminalStatus(final.status), now()))
    .catch(() => end(stage, 'failed', now()));
}
