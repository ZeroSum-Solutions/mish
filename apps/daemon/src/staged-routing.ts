/**
 * Staged drafting: pure planning for "draft fast, finish with the main model".
 *
 * Nothing here touches the daemon, the database or a child process. The run
 * routes ask `planStagedRouting` once per turn; `routes/staged-run-chain.ts`
 * drives the second Run and records timings on the chain this file creates.
 */
import type {
  StagedDraftSource,
  StagedDraftingStatus,
  StagedFallbackReason,
  StagedRunRecord,
  StagedStageKind,
  StagedStageRecord,
} from '@mish/contracts';

/** Fast draft model on the Claude CLI. */
export const STAGED_CLAUDE_DRAFT_MODEL = 'claude-haiku-5-5';
/** Fast draft model on the DeepSeek agent (id as the DeepSeek CLI lists it). */
export const STAGED_DEEPSEEK_DRAFT_MODEL = 'deepseek-v4-flash';

export interface StagedAgentAvailability {
  id: string;
  available: boolean;
}

export interface StagedModelChoice {
  agentId: string;
  model: string;
}

export interface StagedPlanInput {
  enabled: boolean;
  main: StagedModelChoice;
  agents: readonly StagedAgentAvailability[];
  /** The host cannot stage this run (OD Next strategy, retry, clarification). */
  unsupported?: boolean;
}

export type StagedPlan =
  | { kind: 'staged'; draft: StagedModelChoice & { source: StagedDraftSource } }
  | { kind: 'single'; reason: StagedFallbackReason | null };

const isAvailable = (agents: readonly StagedAgentAvailability[], id: string): boolean =>
  agents.some((agent) => agent.id === id && agent.available);

function pickDraft(
  agents: readonly StagedAgentAvailability[],
): (StagedModelChoice & { source: StagedDraftSource }) | null {
  if (isAvailable(agents, 'claude')) {
    return { agentId: 'claude', model: STAGED_CLAUDE_DRAFT_MODEL, source: 'claude' };
  }
  if (isAvailable(agents, 'deepseek')) {
    return { agentId: 'deepseek', model: STAGED_DEEPSEEK_DRAFT_MODEL, source: 'deepseek' };
  }
  return null;
}

export function planStagedRouting(input: StagedPlanInput): StagedPlan {
  if (!input.enabled) return { kind: 'single', reason: null };
  if (input.unsupported) return { kind: 'single', reason: 'unsupported_run' };
  const draft = pickDraft(input.agents);
  if (!draft) return { kind: 'single', reason: 'draft_unavailable' };
  if (draft.agentId === input.main.agentId && draft.model === input.main.model) {
    return { kind: 'single', reason: 'same_model' };
  }
  return { kind: 'staged', draft };
}

/** What `od agent staged status` and the Settings toggle report. */
export function stagedDraftingStatus(
  input: Omit<StagedPlanInput, 'unsupported'>,
): StagedDraftingStatus {
  const draft = pickDraft(input.agents);
  return {
    enabled: input.enabled,
    draft: draft ? { agentId: draft.agentId, model: draft.model, source: draft.source } : null,
    unavailableReason: draft ? null : 'draft_unavailable',
  };
}

const pendingStage = (stage: StagedStageKind, choice: StagedModelChoice): StagedStageRecord => ({
  stage,
  runId: null,
  agentId: choice.agentId,
  model: choice.model,
  status: 'pending',
  startedAt: null,
  endedAt: null,
  durationMs: null,
});

/**
 * One mutable record shared by every Run of the turn, so any of them reports
 * both stages from `GET /api/runs/:id`.
 */
export function createStagedChain(input: {
  draft: StagedModelChoice;
  finish: StagedModelChoice;
}): StagedRunRecord {
  return {
    stages: [pendingStage('draft', input.draft), pendingStage('finish', input.finish)],
    fallback: null,
  };
}

/** Record for a turn that runs on the main model only, with the reason. */
export function singleStageRecord(
  main: StagedModelChoice,
  reason: StagedFallbackReason,
  message: string,
): StagedRunRecord {
  return { stages: [pendingStage('single', main)], fallback: { reason, message } };
}

export const INTERRUPTED_MESSAGE = 'Draft only — finishing pass interrupted';

interface PipelineLike {
  stages?: ReadonlyArray<{ atoms?: readonly string[]; repeat?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Atoms that need several agents or the user mid-run; their pipeline drives the turn itself. */
const MULTI_AGENT_ATOMS = new Set(['critique-theater', 'discovery-question-form', 'direction-picker']);

/**
 * Multi-agent and workflow pipelines (critique panels, question forms, repeat
 * loops) of a plugin the user chose are not staged. The automatic default
 * scenario — an ordinary prototype turn — is, because it is the main case.
 */
export function pipelineBlocksStaging(
  pipeline: PipelineLike | null | undefined,
  explicitPlugin: boolean,
): boolean {
  // An automatic default (the scenario or example the daemon picks for a
  // project kind) is how an ordinary prototype turn runs; only a plugin the
  // request or project explicitly chose can drive the turn with its own pipeline.
  if (!explicitPlugin) return false;
  return (pipeline?.stages ?? []).some(
    (stage) => stage.repeat === true || (stage.atoms ?? []).some((atom) => MULTI_AGENT_ATOMS.has(atom)),
  );
}

export const STAGED_FALLBACK_MESSAGES: Record<StagedFallbackReason, string> = {
  draft_unavailable: 'No fast draft model is available; the main model ran the whole turn.',
  draft_failed: 'The fast draft pass failed; the main model ran the whole turn.',
  same_model: 'The main model is already the fast model; ran a single pass.',
  unsupported_run: 'This kind of run is not staged; the main model ran the whole turn.',
  draft_incompatible: 'The fast draft agent cannot carry this run; the main model ran the whole turn.',
};

/**
 * User message of the finishing Run. The finishing model sees the project as
 * the draft pass left it, so the message asks for a review and completion
 * rather than a rewrite from scratch.
 */
export function buildFinishPrompt(originalRequest: string): string {
  return [
    'A fast first draft of the work below is already in the project files.',
    'Review that draft against the request, then finish it: fix mistakes, fill gaps and polish the result.',
    'Edit the existing files in place; do not start over.',
    '',
    '## Original request',
    originalRequest,
  ].join('\n');
}
