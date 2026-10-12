import type { StrategyTaskProjectionV2 } from '../plugins/strategy-v2.js';
import type { StagedRunRecord } from './staged-routing.js';

/** The same physical-Run successor loop serves strategy tasks and staged turns. */
export function runSuccessor(snapshot: {
  strategyTask?: Pick<StrategyTaskProjectionV2, 'terminal' | 'activeRunId' | 'nextRunId'>;
  staged?: StagedRunRecord;
}, runId: string): { nextRunId: string | null; pending: boolean } | null {
  const task = snapshot.strategyTask;
  if (task && !task.terminal) {
    const nextRunId = task.activeRunId !== runId ? task.activeRunId : task.nextRunId;
    if (nextRunId && nextRunId !== runId) return { nextRunId, pending: false };
  }
  const staged = snapshot.staged;
  if (!staged || staged.stopped || staged.interrupted) return null;
  const index = staged.stages.findIndex(stage => stage.runId === runId);
  if (index < 0) return null;
  for (const stage of staged.stages.slice(index + 1)) {
    if (stage.status === 'skipped') continue;
    if (stage.runId && stage.runId !== runId) return { nextRunId: stage.runId, pending: false };
    if (stage.status === 'pending' || stage.status === 'running') return { nextRunId: null, pending: true };
  }
  return null;
}
