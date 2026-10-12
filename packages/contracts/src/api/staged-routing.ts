/**
 * Staged drafting: a fast model drafts, the user's main model finishes.
 *
 * Opt-in (`AppConfigPrefs.stagedDrafting`), off by default. When on, one
 * logical turn becomes up to two physical Runs over the same project files:
 * a `draft` Run on the fast model, then a `finish` Run on the main model. If
 * the fast stage cannot start or fails, the turn falls back to a single
 * `single` Run on the main model and says so in `fallback`.
 */

export type StagedStageKind = 'draft' | 'finish' | 'single';

export type StagedStageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'skipped'
  /** The daemon restarted while this stage was pending or running. */
  | 'interrupted';

/** Why a turn ran as one main-model pass instead of draft then finish. */
export type StagedFallbackReason =
  /** No fast model is reachable: no Claude CLI and no DeepSeek agent. */
  | 'draft_unavailable'
  /** The fast stage ran and failed; the main model took the turn over. */
  | 'draft_failed'
  /** The main model already is the fast model, so a second pass adds nothing. */
  | 'same_model'
  /** This kind of run (OD Next strategy, retry, clarification) is not staged. */
  | 'unsupported_run'
  /** The draft agent cannot carry this run's tool bundle. */
  | 'draft_incompatible';

export interface StagedStageRecord {
  stage: StagedStageKind;
  /** Null until the stage's physical Run has been allocated. */
  runId: string | null;
  agentId: string;
  model: string | null;
  status: StagedStageStatus;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}

/** Both stages of one logical turn; every Run in the chain reports the same record. */
export interface StagedRunRecord {
  stages: StagedStageRecord[];
  fallback: { reason: StagedFallbackReason; message: string } | null;
  /**
   * Set after a daemon restart left the draft done but the finishing pass
   * unfinished. `POST /api/runs/:id/staged/finish` (or `od agent staged finish`)
   * starts the finishing pass; the flag clears once it starts.
   */
  interrupted?: { message: string } | null;
  /**
   * Why the chain ended before running every stage: the user stopped it, the
   * draft ended by asking a question, or a newer turn started in the same
   * conversation. A stopped chain never starts a further pass.
   */
  stopped?: { reason: StagedStopReason; message: string } | null;
}

export type StagedStopReason = 'canceled' | 'question_form' | 'superseded';

export type StagedDraftSource = 'claude' | 'deepseek';

export interface StagedDraftingStatus {
  enabled: boolean;
  /** The fast stage a turn would use now, or null when none is reachable. */
  draft: { agentId: string; model: string; source: StagedDraftSource } | null;
  /** Why no draft stage is available; null when one is. */
  unavailableReason: StagedFallbackReason | null;
}

export interface StagedDraftingResponse {
  status: StagedDraftingStatus;
}
