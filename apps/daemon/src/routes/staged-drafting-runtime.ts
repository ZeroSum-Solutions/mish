/**
 * Staged drafting for the run routes: decides, per turn, whether a fast draft
 * pass runs first, swaps the Run onto the draft model, and later starts the
 * main-model finishing Run (or "Finish now" after a restart).
 *
 * `POST /api/runs` and `POST /api/chat` both call `apply`; everything that
 * touches the daemon (database, registry, the run choke point) is injected.
 */
import type Database from 'better-sqlite3';
import type { DesignBrief, StagedRunRecord } from '@mish/contracts';

import type { StagedStopReason } from '@mish/contracts';
import { prepareModelAdmission } from '../workbench/prepare-model.js';
import { readAdmittedPublicInput } from '../workbench/replay.js';
import { inheritedRunLineageHints } from '../services/run-analytics-lifecycle.js';
import {
  STAGED_FALLBACK_MESSAGES,
  buildFinishPrompt,
  createStagedChain,
  planStagedRouting,
  singleStageRecord,
} from '../staged-routing.js';
import type { StagedChainEntry, StagedChainStore } from '../staged-chain-store.js';
import {
  buildStagedStageMeta,
  finishInterruptedChain,
  followStagedDraft,
  stopChain,
  trackSingleStage,
  type StagedChainDeps,
  type StagedChainRun,
} from './staged-run-chain.js';

type Json = Record<string, unknown>;

export interface StagedRunLike extends StagedChainRun {
  clientRequestId?: string | null;
  analyticsContext?: unknown;
  analyticsRecovery?: { context?: unknown } | null;
}

export interface StagedDraftingDeps<TRun extends StagedRunLike, TMeta extends Json> {
  db: Database.Database;
  dataDir: string;
  projectsRoot: string;
  getAgentDef: Parameters<typeof prepareModelAdmission>[0]['getAgentDef'];
  readConfig(): Promise<{ stagedDrafting?: boolean; agentCliEnv?: unknown }>;
  detectAgents(agentCliEnv: unknown): Promise<Array<{ id: string; available?: boolean }>>;
  runs: {
    wait(run: TRun): Promise<{ status: string; cancelOrigin?: string | null }>;
    fail(run: TRun, code: string, message: string): unknown;
    get(id: string): TRun | null | undefined;
    cancel(run: TRun, origin: 'user_stop' | 'unknown'): Promise<unknown> | unknown;
  };
  /** True when the Run's streamed text or saved message holds a renderable question form. */
  endedWithQuestion(run: TRun): boolean;
  internalRuns: StagedChainDeps<TRun, TMeta>['internalRuns'];
  startChatRun(meta: TMeta, run: TRun): Promise<unknown>;
  reconcileRun?(run: TRun): void;
  /** Strips secrets and non-persistable fields before a body or meta is stored. */
  sanitize(value: Json): Json;
  store: StagedChainStore;
}

export interface StagedApplyInput {
  meta: Json;
  requestBody: Json;
  modelPreparation: Awaited<ReturnType<typeof prepareModelAdmission>>;
  /** True when the draft agent can carry this run's tool bundle. */
  draftSupports(agentId: string): boolean;
  /** Retry, clarification, BYOK, coordinated placement, OD Next active, no project... */
  unsupported: boolean;
  /** A multi-agent / workflow pipeline drives this turn. */
  pipelineBlocks?: boolean;
}

export interface StagedApplyResult<TRun> {
  record: StagedRunRecord | null;
  /** Call once the draft Run has been started. */
  follow: ((run: TRun) => void) | null;
}

export function createStagedDrafting<TRun extends StagedRunLike, TMeta extends Json>(
  deps: StagedDraftingDeps<TRun, TMeta>,
) {
  // One entry per chain. Runs carry projections; every mutation writes this
  // entry synchronously before any external work can start or resume.
  const live = new Map<string, StagedChainEntry>();
  const conversationOf = (entry: StagedChainEntry): string | null =>
    typeof entry.draftMeta.conversationId === 'string' ? entry.draftMeta.conversationId : null;
  const isOpen = (chain: StagedRunRecord): boolean =>
    chain.stages.some((stage) => stage.status === 'pending' || stage.status === 'running');
  const persist = (entry: StagedChainEntry) => () => {
    // Retain the fence even if disk I/O fails; never start more work from a
    // stale reloaded record in this process.
    live.set(entry.draftRunId, entry);
    deps.store.save(entry);
    if (!isOpen(entry.chain)) live.delete(entry.draftRunId);
  };
  const entryForRun = (runId: string): StagedChainEntry | null => {
    const current = [...live.values()].find(entry => entry.draftRunId === runId || entry.runIds?.includes(runId) || entry.chain.stages.some(stage => stage.runId === runId));
    return current ?? deps.store.findByRunId(runId);
  };
  /** Admission cursors survive daemon restart; a registry inventory does not. */
  const newerTurnAfter = (entry: StagedChainEntry): boolean => {
    const conversationId = conversationOf(entry);
    if (!conversationId) return false;
    const own = new Set(entry.chain.stages.map((stage) => stage.runId).filter(Boolean) as string[]);
    for (const runId of entry.runIds ?? []) own.add(runId);
    own.add(entry.draftRunId);
    const cursor = deps.db.prepare('SELECT run_id FROM session_admission_cursors WHERE conversation_id = ?').get(conversationId) as { run_id: string } | undefined;
    return Boolean(cursor && !own.has(cursor.run_id));
  };

  // Retire obsolete interrupted chains at startup, before Finish now can be
  // offered. This also upgrades chains written by the pre-fence implementation.
  for (const entry of deps.store.list()) {
    if (!entry.chain.stopped && (isOpen(entry.chain) || entry.chain.interrupted) && newerTurnAfter(entry)) {
      stopChain(entry.chain, 'superseded');
      deps.store.save(entry);
    }
  }

  const chainDeps = (
    entry: StagedChainEntry,
    draftRun: TRun,
  ): StagedChainDeps<TRun, TMeta> => ({
    chain: entry.chain,
    draftRun,
    wait: (run) => deps.runs.wait(run),
    internalRuns: deps.internalRuns,
    startChatRun: deps.startChatRun,
    ...(deps.reconcileRun ? { reconcileRun: deps.reconcileRun } : {}),
    onChange: persist(entry),
    draftEndedWithQuestion: (run) => deps.endedWithQuestion(run),
    newerTurnExists: () => newerTurnAfter(entry),
    discardRun: (run, error) => {
      deps.runs.fail(run, 'STAGED_STAGE_START_FAILED', error instanceof Error ? error.message : String(error));
    },
    prepareStage: async (kind) => {
      const { originalPrompt, mainBody, draftMeta } = entry;
      const stagePrompt = kind === 'finish' ? buildFinishPrompt(originalPrompt) : originalPrompt;
      const prepared = await prepareModelAdmission({
        db: deps.db,
        body: {
          ...mainBody,
          message: stagePrompt,
          currentPrompt: stagePrompt,
          userMessageId: undefined,
          continueFromRunId: undefined,
          expectedModelRevision: undefined,
        },
        dataDir: deps.dataDir,
        fallbackAgentId: null,
        getAgentDef: deps.getAgentDef,
        projectsRoot: deps.projectsRoot,
        getRun: (id) => (deps.runs.get(id) as never) ?? null,
        trustedAutomaticSource: {
          runId: draftRun.id,
          input: readAdmittedPublicInput(deps.db, draftRun.id)
            ?? { prompt: originalPrompt, currentPromptPresent: true, attachmentRefs: [] },
        },
      });
      const stageMeta = buildStagedStageMeta({
        draftMeta: { ...draftMeta, ...(entry.acceptedBrief ? { designBrief: entry.acceptedBrief } : {}) },
        draftRunId: draftRun.id,
        kind,
        originalPrompt,
        main: {
          agentId: prepared.choice.agentId,
          model: prepared.choice.modelId,
          reasoning: prepared.reasoning,
          serviceTier: prepared.serviceTier,
          prepared: prepared.prepared,
          replayInput: prepared.replayInput,
        },
        stagePrompt,
        previousRunId: entry.chain.stages.find((stage) => stage.stage === kind)?.runId ?? null,
        lineage: inheritedRunLineageHints(
          { id: draftRun.id, clientRequestId: draftRun.clientRequestId ?? null },
          draftMeta,
          1,
        ),
      }) as TMeta;
      return {
        meta: stageMeta,
        analytics: {
          body: stageMeta,
          requestAnalyticsContext:
            (draftRun.analyticsContext ?? draftRun.analyticsRecovery?.context ?? null),
          creationKind: 'created',
          resumed: false,
        },
      };
    },
  });

  async function apply(input: StagedApplyInput): Promise<StagedApplyResult<TRun>> {
    const config = await deps.readConfig();
    if (config.stagedDrafting !== true) return { record: null, follow: null };
    const { meta, requestBody, modelPreparation } = input;
    const mainChoice = {
      agentId: modelPreparation.choice.agentId,
      model: modelPreparation.choice.modelId,
    };
    const agents = (await deps.detectAgents(config.agentCliEnv).catch(() => []))
      .map((agent) => ({ id: agent.id, available: Boolean(agent.available) }));
    const plan = planStagedRouting({
      enabled: true,
      main: mainChoice,
      agents,
      unsupported: input.unsupported || input.pipelineBlocks === true || mainChoice.agentId === 'byok-opencode',
    });
    if (plan.kind === 'single') {
      return {
        record: plan.reason
          ? singleStageRecord(mainChoice, plan.reason, STAGED_FALLBACK_MESSAGES[plan.reason])
          : null,
        follow: null,
      };
    }
    const compatible = input.draftSupports(plan.draft.agentId);
    const originalPrompt = typeof requestBody.currentPrompt === 'string'
      ? requestBody.currentPrompt
      : typeof requestBody.message === 'string' ? requestBody.message : '';
    const mainBody: Json = {
      ...requestBody,
      agentId: mainChoice.agentId,
      model: mainChoice.model,
      reasoning: modelPreparation.reasoning,
      serviceTier: modelPreparation.serviceTier,
      message: originalPrompt,
      currentPrompt: originalPrompt,
      priorTranscript: undefined,
    };
    let draftPreparation: Awaited<ReturnType<typeof prepareModelAdmission>> | null = null;
    if (compatible) {
      try {
        draftPreparation = await prepareModelAdmission({
          db: deps.db,
          body: {
            ...mainBody,
            agentId: plan.draft.agentId,
            model: plan.draft.model,
            reasoning: undefined,
            serviceTier: undefined,
            expectedModelRevision: undefined,
          },
          dataDir: deps.dataDir,
          fallbackAgentId: null,
          getAgentDef: deps.getAgentDef,
          projectsRoot: deps.projectsRoot,
          getRun: (id) => (deps.runs.get(id) as never) ?? null,
        });
      } catch (error) {
        console.warn('[staged] draft admission failed; running on the main model', error);
      }
    }
    if (!draftPreparation) {
      const reason = compatible ? 'draft_unavailable' as const : 'draft_incompatible' as const;
      return { record: singleStageRecord(mainChoice, reason, STAGED_FALLBACK_MESSAGES[reason]), follow: null };
    }
    meta.agentId = draftPreparation.choice.agentId;
    meta.model = draftPreparation.choice.modelId;
    meta.reasoning = draftPreparation.reasoning;
    meta.serviceTier = draftPreparation.serviceTier;
    if (draftPreparation.prepared) meta._preparedSessionAdmission = draftPreparation.prepared;
    else delete meta._preparedSessionAdmission;
    if (draftPreparation.replayInput) {
      meta.message = draftPreparation.replayInput.message;
      meta.currentPrompt = draftPreparation.replayInput.currentPrompt;
      meta.priorTranscript = draftPreparation.replayInput.priorTranscript;
    }
    const chain = createStagedChain({
      draft: { agentId: plan.draft.agentId, model: plan.draft.model },
      finish: mainChoice,
    });
    return {
      record: chain,
      follow: (draftRun) => {
        const { _preparedSessionAdmission: _drop, ...persistableMeta } = meta;
        const entry: StagedChainEntry = {
          draftRunId: draftRun.id,
          chain,
          originalPrompt,
          mainBody: deps.sanitize(mainBody),
          draftMeta: deps.sanitize(persistableMeta),
          ...(meta.designBrief ? { acceptedBrief: meta.designBrief as DesignBrief } : {}),
        };
        live.set(draftRun.id, entry);
        deps.store.save(entry);
        followStagedDraft<TRun, TMeta>(chainDeps(entry, draftRun));
      },
    };
  }

  /** "Finish now" for a chain a restart interrupted. */
  async function finishNow(runId: string) {
    const entry = entryForRun(runId);
    if (!entry) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No staged run with this id.' };
    if (!entry.chain.stopped && entry.chain.interrupted && entry.mainBody.brief && !entry.acceptedBrief) {
      return { ok: false as const, code: 'NOT_INTERRUPTED' as const, message: 'The accepted brief snapshot is missing. Start a new turn bound to the accepted brief.' };
    }
    // Register synchronously: cancel/supersede must see the exact entry that
    // prepareStage will use, including during its first await.
    live.set(entry.draftRunId, entry);
    const draftRun = deps.runs.get(entry.draftRunId)
      ?? ({ id: entry.draftRunId, status: 'succeeded' } as TRun);
    try {
      return await finishInterruptedChain<TRun, TMeta>(chainDeps(entry, draftRun));
    } finally {
      if (!isOpen(entry.chain)) live.delete(entry.draftRunId);
    }
  }

  /** Stored chain for a run this process did not create (after a restart). */
  const lookup = (runId: string): StagedRunRecord | null => entryForRun(runId)?.chain ?? null;

  const cancelRuns = async (ids: string[], except: string | null) => {
    for (const id of ids) {
      if (id === except) continue;
      const run = deps.runs.get(id);
      if (run) await deps.runs.cancel(run, 'user_stop');
    }
  };

  /**
   * Cancel reaches the whole chain: no further pass starts, and a stage that
   * is running is stopped. `runId` may be any Run of the chain (the client only
   * holds the draft's).
   */
  async function cancelChain(runId: string, except: string | null): Promise<void> {
    const entry = entryForRun(runId);
    if (!entry) return;
    const ids = stopChain(entry.chain, 'canceled');
    try {
      persist(entry)();
    } catch (error) {
      // The caller cannot reach its own cancellation after a failed save.
      await cancelRuns(ids, null);
      throw error;
    }
    await cancelRuns(ids, except);
  }

  /**
   * A newer user turn started in `conversationId`: every open chain there is
   * dropped (a pending finish never starts, a running one is cancelled), so a
   * finishing pass can never overlap the newer turn.
   */
  async function supersede(conversationId: string | null | undefined): Promise<void> {
    if (!conversationId) return;
    // Persist every fence before the first await (including interrupted chains
    // with no live Run), then wait for cancellation before model preparation.
    const cancellations: Array<{ ids: string[]; draftId: string | null }> = [];
    let persistenceError: unknown;
    for (const stored of deps.store.listByConversation(conversationId)) {
      const item = live.get(stored.draftRunId) ?? stored;
      if (conversationOf(item) !== conversationId || item.chain.stopped || (!isOpen(item.chain) && !item.chain.interrupted)) continue;
      const ids = stopChain(item.chain, 'superseded');
      try { persist(item)(); } catch (error) { persistenceError ??= error; }
      // A draft still running is left to finish (it is not a finishing pass);
      // only the later passes are stopped so none can overlap the newer turn.
      const draftId = item.chain.stages.find((stage) => stage.stage === 'draft')?.runId ?? null;
      cancellations.push({ ids, draftId });
    }
    for (const { ids, draftId } of cancellations) await cancelRuns(ids, draftId);
    if (persistenceError) throw persistenceError;
  }

  return { apply, finishNow, lookup, cancelChain, supersede, trackSingle: trackSingleStage };
}
