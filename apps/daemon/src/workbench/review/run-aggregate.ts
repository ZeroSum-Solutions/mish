import { isIndependentReviewerCompletion, WORKBENCH_MIN_INDEPENDENT_REVIEWERS, type MechanicalCheckResult, type ReviewCheckVerdict, type ReviewerRecord, type ReviewOutcome, type ReviewRunReason } from '@mish/contracts';
import { verdictBlockers } from './check-verdicts.js';

/** Said plainly on every run (HTTP, UI and od) that has an open required judgment or manual check. */
export const REQUIRED_GATE_MESSAGE = 'Required judgment or manual checks are open. The run cannot pass until a person accepts them, and this version has no acceptance flow yet.';

export interface AggregateReviewRunInput {
  /** Mechanical results and unresolved required checks from the run's verification bundle; null when none was produced. */
  mechanical: { results: readonly MechanicalCheckResult[]; unresolvedRequiredChecks: readonly string[] } | null;
  reviewers: readonly ReviewerRecord[];
  interrupted: boolean;
  /** Set when the project moved past the frozen inputs before the evidence was collected. */
  inputsChanged?: string | null;
  /** B5-1 (AC-R06.4): the run's per-check verdicts; their required failures and open gates join the rule below. */
  verdicts?: readonly ReviewCheckVerdict[] | null;
}

export interface AggregateReviewRunResult {
  outcome: ReviewOutcome;
  reasons: ReviewRunReason[];
  completedIndependentReviewers: number;
  incompleteCheckIds: string[];
}

/**
 * Overall review outcome (technical-spec "Reviews and components", AC-R03.2/R03.3).
 *
 * Invariant: only mechanical evidence can make a run `failed`, and only complete
 * evidence can make it `passed`. Model findings, votes and probabilities are not
 * an input here at all, so they can neither establish correctness nor clear a
 * confirmed failure. Every other gap is `inconclusive` with its reason:
 * missing mandatory evidence, unresolved required checks, fewer than two
 * independent model records, a required reviewer that did not complete (its
 * assigned checks stay incomplete), a reviewer that left assigned checks
 * unanswered, inputs that changed before capture, or an interrupted run. A skipped optional
 * reviewer stays visible on its record and changes nothing else.
 *
 * With per-check verdicts (AC-R06.4/R06.5) the same rule covers every
 * effective check: a declared-versus-observed mismatch on a required check is
 * an observed failure; a required manual check, a required judgment awaiting
 * acceptance, or unknown applicability keeps the run open; and an applicable
 * required judgment fewer than two independent reviewers answered is
 * incomplete. An optional one is only shown as unreviewed.
 */
export function aggregateReviewRun(input: AggregateReviewRunInput): AggregateReviewRunResult {
  const reasons: ReviewRunReason[] = [];
  const results = input.mechanical?.results ?? [];
  const blockers = input.verdicts ? verdictBlockers(input.verdicts) : null;
  const failedIds = [...new Set([...results.filter(result => result.required && result.outcome === 'fail').map(result => result.checkId), ...(blockers?.failed ?? [])])];
  if (failedIds.length) reasons.push({ code: 'mandatory-check-failed', message: `Required check failed: ${failedIds.join(', ')}`.slice(0, 500) });

  const missing = results.filter(result => result.required && result.outcome === 'inconclusive');
  if (!input.mechanical) reasons.push({ code: 'mandatory-evidence-missing', message: 'No mechanical evidence was collected' });
  else if (missing.length) reasons.push({ code: 'mandatory-evidence-missing', message: `Required evidence is missing for: ${missing.map(result => result.checkId).join(', ')}`.slice(0, 500) });
  // Open required checks not already reported as missing mechanical evidence (a checklist criterion that reads one is the same gap).
  const reported = new Set(missing.map(result => result.checkId));
  const verdictOf = (id: string) => input.verdicts?.find(verdict => verdict.checkId === id);
  const openVerdicts = input.mechanical ? (blockers?.open ?? []).filter(id => !reported.has(id) && !reported.has(verdictOf(id)?.mechanicalCheckId ?? '')) : [];
  // Captain decision 3: required judgment and manual checks are human gates; the owner-gated acceptance flow (U2) is not built.
  const isGate = (id: string) => { const status = verdictOf(id)?.status; return status === undefined || status === 'awaiting-manual' || status === 'awaiting-acceptance'; };
  // A required check the evidence verified as not applicable is resolved, even though the rubric listed it as a gate.
  const verifiedNotApplicable = (id: string) => verdictOf(id)?.status === 'not-applicable';
  const gates = [...new Set([...(input.mechanical?.unresolvedRequiredChecks ?? []).filter(id => !verifiedNotApplicable(id)), ...openVerdicts.filter(isGate)])];
  const unknown = openVerdicts.filter(id => !isGate(id));
  if (gates.length) reasons.push({ code: 'required-checks-unresolved', message: `${REQUIRED_GATE_MESSAGE} Open: ${gates.join(', ')}`.slice(0, 500) });
  if (unknown.length) reasons.push({ code: 'required-checks-unresolved', message: `Required checks are unresolved (missing evidence or unknown applicability): ${unknown.join(', ')}`.slice(0, 500) });

  const completed = input.reviewers.filter(isIndependentReviewerCompletion).length;
  if (completed < WORKBENCH_MIN_INDEPENDENT_REVIEWERS) reasons.push({ code: 'fewer-than-two-independent-reviewers', message: `Fewer than two independent reviewers completed (${completed})` });

  // A required reviewer that did not complete leaves every assigned check incomplete;
  // one that completed but skipped checks leaves exactly those checks incomplete.
  const incompleteCheckIds = new Set<string>();
  for (const reviewer of input.reviewers.filter(item => item.required)) {
    if (reviewer.status !== 'completed') {
      reviewer.assignedCheckIds.forEach(id => incompleteCheckIds.add(id));
      reasons.push({ code: 'required-reviewer-incomplete', message: `Required reviewer ${reviewer.role} is ${reviewer.status}; its assigned checks are incomplete` });
    } else if (reviewer.unansweredCheckIds.length) {
      reviewer.unansweredCheckIds.forEach(id => incompleteCheckIds.add(id));
      reasons.push({ code: 'required-reviewer-incomplete', message: `Required reviewer ${reviewer.role} answered ${reviewer.assignedCheckIds.length - reviewer.unansweredCheckIds.length} of ${reviewer.assignedCheckIds.length} assigned checks; the rest are incomplete`.slice(0, 500) });
    }
  }

  if (blockers?.undercovered.length) {
    blockers.undercovered.forEach(id => incompleteCheckIds.add(id));
    reasons.push({ code: 'fewer-than-two-independent-reviewers', message: `Fewer than two independent reviewers answered: ${blockers.undercovered.join(', ')}`.slice(0, 500) });
  }

  if (input.inputsChanged) reasons.push({ code: 'inputs-changed', message: input.inputsChanged.slice(0, 500) });
  if (input.interrupted) reasons.push({ code: 'run-interrupted', message: 'The run was interrupted; completed evidence is kept and the result is partial' });

  // Evidence about content the run did not freeze proves nothing about the frozen revision.
  const outcome: ReviewOutcome = failedIds.length && !input.inputsChanged ? 'failed' : reasons.length ? 'inconclusive' : 'passed';
  return { outcome, reasons, completedIndependentReviewers: completed, incompleteCheckIds: [...incompleteCheckIds] };
}
