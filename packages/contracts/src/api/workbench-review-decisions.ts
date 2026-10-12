import { z } from 'zod';
import type { ReviewFinding, ReviewRun } from './workbench-review.js';

const id = z.string().min(1).max(200).refine(value => value.trim() === value && !/\p{Cc}/u.test(value), 'Invalid identity');
export const reviewFindingDecisionRequestSchema = z.object({ action: z.enum(['accept', 'dismiss']) }).strict();
export const reviewDecisionActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-user') }).strict(),
  z.object({ kind: z.literal('workspace-member'), workspaceId: id, workspaceMemberId: id }).strict(),
]);
export const reviewFindingDecisionSchema = reviewFindingDecisionRequestSchema.extend({
  actor: reviewDecisionActorSchema,
  at: z.string().datetime({ precision: 3 }),
}).strict();
export type ReviewFindingDecisionAction = z.infer<typeof reviewFindingDecisionRequestSchema>['action'];
export type ReviewDecisionActor = z.infer<typeof reviewDecisionActorSchema>;
export type ReviewFindingDecision = z.infer<typeof reviewFindingDecisionSchema>;

/** Decisions annotate advisory findings only; they never resolve a check or alter evidence/outcomes. */
export function reviewFindingDecisionProblem(run: Pick<ReviewRun, 'operation' | 'checkVerdicts'>, finding: Pick<ReviewFinding, 'checkId'>): 'run-active' | 'required-check' | 'not-advisory' | 'unverified-check' | null {
  if (run.operation.status === 'queued' || run.operation.status === 'running') return 'run-active';
  const check = run.checkVerdicts?.find(verdict => verdict.checkId === finding.checkId);
  if (!check) return 'unverified-check';
  if (check.required) return 'required-check';
  if (check.kind !== 'judgment') return 'not-advisory';
  if (check.applicability.status !== 'applicable' || check.applicability.basis === 'mismatch' || !['judged', 'unreviewed'].includes(check.status)) return 'unverified-check';
  return null;
}
