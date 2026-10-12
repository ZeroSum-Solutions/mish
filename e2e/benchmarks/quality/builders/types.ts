import type { client } from '../api.ts';
import type { BriefCase, BuilderIdentity, CaseRun } from '../types.ts';

/** What one build starts from: the case's request alone, or the request plus a writer's Improve prompt brief. */
export interface BuildInput {
  /** `original`, or the Improve prompt lane that wrote `preview`. */
  writer: string;
  /** The reviewed brief preview to attach (`POST /api/workbench/briefs/attach`); null for `original`. */
  preview: unknown | null;
}

export interface BuildContext {
  api: ReturnType<typeof client>;
  item: BriefCase;
  /** `cases/<id>` inside the packet; generated files go to `files/` under it. */
  dir: string;
  result: CaseRun;
  agent: string; model: string; timeoutMs: number; pollMs: number;
  /** performance.now() when this case started; builders set wallTimeMs from it once generation ends. */
  startedAt: number;
  /** Persists run.json; called after every state change so an interrupted run keeps its evidence. */
  save: () => Promise<void>;
  input?: BuildInput;
}

/** `stop` means admission or cancellation could not be verified: the caller must not start another build. */
export interface BuildOutcome { stop: boolean }

/**
 * One product path that turns a case into saved pages. Every builder records the same CaseRun shape,
 * so capture, judging and scoring do not depend on which path built the pages.
 */
export interface Builder {
  identity: BuilderIdentity;
  build(context: BuildContext): Promise<BuildOutcome>;
}
