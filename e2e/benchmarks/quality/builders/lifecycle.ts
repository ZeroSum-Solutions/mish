import { HttpError } from '../api.ts';
import type { BuildContext } from './types.ts';

const ACTIVE = ['queued', 'running'];
const TERMINAL = ['succeeded', 'failed', 'canceled', 'cancelled'];

/** Polls a chat run until it ends or the deadline passes, saving each status. Returns the terminal status. */
export async function pollRun(context: BuildContext, runId: string, projectId: string, deadline: number): Promise<string> {
  const { api, result } = context;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('Run polling deadline exceeded');
    const status = await api.json(`/api/runs/${encodeURIComponent(runId)}`, projectId, undefined, remaining) as Record<string, unknown>;
    if (!status || ![...ACTIVE, ...TERMINAL].includes(String(status.status))) throw new Error('Invalid run status');
    result.run = status; result.status = String(status.status);
    await context.save();
    if (!ACTIVE.includes(result.status)) return result.status;
    await new Promise(resolve => setTimeout(resolve, Math.min(context.pollMs, Math.max(1, deadline - performance.now()))));
  }
}

/** Cancels an owned chat run and confirms it stopped. Returns false when that cannot be verified. */
export async function cancelRun(context: BuildContext, runId: string, projectId: string): Promise<boolean> {
  try {
    await context.api.json(`/api/runs/${encodeURIComponent(runId)}/cancel`, projectId, {});
    const canceled = await context.api.json(`/api/runs/${encodeURIComponent(runId)}`, projectId) as { status?: string };
    return TERMINAL.includes(canceled.status ?? '');
  } catch { return false; }
}

/** A 4xx proves the daemon refused the request, so nothing was admitted. */
export const refused = (error: unknown) => error instanceof HttpError && error.status < 500;
