import { reviewDecisionActorSchema, reviewFindingDecisionRequestSchema, reviewFindingDecisionProblem, type ReviewDecisionActor, type ReviewFindingDecisionAction, type ReviewRunView } from '@open-design/contracts';
import type { ReviewRunStore } from './run-store.js';
import { ReviewRunError } from './run-service.js';

const REFUSALS = {
  'run-active': 'Wait until the review finishes before deciding on a finding.',
  'required-check': 'Required checks cannot be dismissed or accepted as advisory findings. Failures and missing required evidence remain blocking.',
  'not-advisory': 'Only optional design judgments have advisory Accept / Dismiss decisions.',
  'unverified-check': 'This finding has no verified optional judgment check. Collect a new review with complete check verdicts.',
} as const;

/** Serialized read/append/save: terminal runs cannot race reviewer saves; concurrent decisions cannot lose history. */
export function createFindingDecisions(store: ReviewRunStore, ready: Promise<void>, now: () => string, read: (projectId: string, runId: string) => Promise<ReviewRunView>) {
  const pending = new Map<string, Promise<unknown>>();
  return async (projectId: string, runId: string, findingId: string, action: ReviewFindingDecisionAction, actor: ReviewDecisionActor): Promise<ReviewRunView> => {
    await ready;
    const slot = `${projectId}\u0000${runId}`;
    const prior = pending.get(slot) ?? ready;
    const work = prior.catch(() => undefined).then(async () => {
      // Validate even in-process callers; identity and time are never supplied by the decision body.
      const request = reviewFindingDecisionRequestSchema.parse({ action });
      const who = reviewDecisionActorSchema.parse(actor);
      const run = await store.read(projectId, runId);
      if (!run) throw new ReviewRunError(404, 'run-not-found', 'No such review run for this project');
      const finding = run.findings.find(item => item.id === findingId);
      if (!finding) throw new ReviewRunError(404, 'finding-not-found', 'No such finding in this review run');
      const problem = reviewFindingDecisionProblem(run, finding);
      if (problem) throw new ReviewRunError(409, problem, REFUSALS[problem]);
      const history = finding.decisions ?? [];
      const last = history.at(-1);
      if (last?.action !== request.action || JSON.stringify(last.actor) !== JSON.stringify(who)) {
        if (history.length >= 100) throw new ReviewRunError(409, 'decision-history-full', 'This finding has reached its decision history limit. Start a new review.');
        finding.decisions = [...history, { action: request.action, actor: who, at: now() }];
        await store.save(run);
      }
      // No recomputation: mandatory results, incomplete reviewers, evidence and frozen versions stay authoritative.
      return read(projectId, runId);
    });
    pending.set(slot, work);
    try { return await work; } finally { if (pending.get(slot) === work) pending.delete(slot); }
  };
}
