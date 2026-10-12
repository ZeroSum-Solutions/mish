import {
  isIndependentReviewerCompletion, WORKBENCH_BLOCKING_VERDICT_STATUSES,
  type MechanicalCheckResult, type ObservedBehavior, type ObservedBehaviorRecord, type ReviewCheckVerdict, type ReviewerRecord, type ReviewEvidenceMessage, type ReviewFinding,
} from '@mish/contracts';
import { ev, list, PageText, rubricKey, vocab, type EvidenceText } from './evidence.js';
import type { JudgmentContract } from './judgment-seeds.js';
import type { MandatoryCriterionId } from './plan.js';

/** Evaluator ids recorded on every applicability decision. */
export const VERDICT_EVALUATOR = 'check-verdicts/1';
export const OBSERVED_EVALUATOR = 'observed-behavior/1';
export const TARGET_EVALUATOR = 'review-target/1';

/** One check the run is accountable for, from whichever source declared it. */
export interface EffectiveCheck {
  checkId: string;
  kind: 'mechanical' | 'judgment' | 'manual';
  origin: ReviewCheckVerdict['origin'];
  required: boolean;
  /** Judgment question or manual procedure; null for mechanical checks. */
  criterion: string | null;
  /** Evidence guidance sent to the reviewer lanes with a judgment check. */
  contract: JudgmentContract | null;
  /** `always`; the observed behaviors that make it applicable; or `reusable-unit` (only when the rubric declares one). */
  appliesWhen: 'always' | ObservedBehavior[] | 'reusable-unit';
  /** The rubric's own applicability declaration, if any. */
  declared: { status: 'applicable' | 'not-applicable' | 'undetermined'; rationale: string; evaluator: string } | null;
  /** For a mechanical check: the mandatory criterion whose result it reads when it has none of its own. */
  mapsTo: MandatoryCriterionId | null;
  sourceCriteria: ReviewCheckVerdict['sourceCriteria'];
}

/** Evidence v2: an applicability note is a structured message, never free text. */
type Applicability = ReviewCheckVerdict['applicability'] & { note?: EvidenceText };

const behaviorList = (behaviors: readonly ObservedBehavior[]) => list(behaviors.map(behavior => vocab('behavior', behavior)));
/** A rubric's own applicability rationale is user-authored text: carried as a rubric key, never as page text. */
const declaredNote = (rationale: string) => ev('verdict.note.declared', rubricKey(rationale));
/** A mechanical result's reason: its structured message, or (bundles written before evidence v2) the page-text token of its string. */
const resultReason = (reason: ReviewEvidenceMessage | string): EvidenceText => typeof reason === 'string' ? ev('legacy.text', PageText.of(reason).token()) : reason;

/**
 * AC-R06.5 applicability. Behavior observed in the frozen evidence makes a
 * check applicable; a declaration that disagrees with what was observed is a
 * mismatch (a failure for a required check, never N/A); unknown observation is
 * undetermined (inconclusive); N/A needs an evaluator and never skips a check
 * that always applies when it is required.
 */
export function evaluateApplicability(check: EffectiveCheck, observed: readonly ObservedBehaviorRecord[] | null): Applicability {
  const declared = check.declared;
  if (check.appliesWhen === 'always') {
    if (declared?.status === 'not-applicable') {
      if (check.required) return { status: 'applicable', basis: 'always', evaluator: VERDICT_EVALUATOR, behaviors: [], note: ev('verdict.note.alwaysApplies') };
      return { status: 'not-applicable', basis: 'declared', evaluator: declared.evaluator, behaviors: [], note: declaredNote(declared.rationale) };
    }
    if (declared?.status === 'undetermined') return { status: 'undetermined', basis: 'declared', evaluator: declared.evaluator, behaviors: [], note: declaredNote(declared.rationale) };
    return { status: 'applicable', basis: 'always', evaluator: VERDICT_EVALUATOR, behaviors: [] };
  }
  if (check.appliesWhen === 'reusable-unit') {
    if (declared?.status === 'applicable') return { status: 'applicable', basis: 'declared', evaluator: declared.evaluator, behaviors: [] };
    if (declared?.status === 'undetermined') return { status: 'undetermined', basis: 'declared', evaluator: declared.evaluator, behaviors: [], note: declaredNote(declared.rationale) };
    return { status: 'not-applicable', basis: 'target', evaluator: TARGET_EVALUATOR, behaviors: [], note: ev('verdict.note.pageTarget') };
  }
  const behaviors = check.appliesWhen;
  const records = behaviors.map(behavior => observed?.find(item => item.behavior === behavior) ?? null);
  const seen = behaviors.filter((_, index) => records[index]?.state === 'observed');
  const allAbsent = records.every(record => record?.state === 'not-observed');
  if (seen.length) {
    if (declared?.status === 'not-applicable') return { status: 'applicable', basis: 'mismatch', evaluator: OBSERVED_EVALUATOR, behaviors: seen, note: ev('verdict.note.observedDespiteDeclared', behaviorList(seen), list(records.flatMap(record => record?.samples ?? []).slice(0, 3))) };
    return { status: 'applicable', basis: 'observed', evaluator: OBSERVED_EVALUATOR, behaviors: seen };
  }
  if (allAbsent) {
    if (declared?.status === 'applicable') return { status: 'applicable', basis: 'mismatch', evaluator: OBSERVED_EVALUATOR, behaviors: [...behaviors], note: ev('verdict.note.absentDespiteDeclared', behaviorList(behaviors)) };
    return { status: 'not-applicable', basis: 'not-observed', evaluator: OBSERVED_EVALUATOR, behaviors: [...behaviors], note: ev('verdict.note.notObserved', behaviorList(behaviors)) };
  }
  return { status: 'undetermined', basis: 'unknown', evaluator: OBSERVED_EVALUATOR, behaviors: [...behaviors], note: ev('verdict.note.unknown', behaviorList(behaviors)) };
}

export interface VerdictInputs {
  checks: readonly EffectiveCheck[];
  /** The run's mechanical evidence; null when none was collected. */
  mechanical: { results: readonly MechanicalCheckResult[]; observedBehaviors?: readonly ObservedBehaviorRecord[] | undefined } | null;
  reviewers: readonly ReviewerRecord[];
  findings: readonly ReviewFinding[];
  /** The run's review scope; null or omitted means every check. Judgment checks outside it get no verdict. */
  scopeCheckIds?: readonly string[] | null;
}

/**
 * AC-R06.4 runtime verdicts, one per effective check. Mechanical evidence
 * alone passes or fails a check; reviewer answers are tallied beside it and
 * never change it (AC-R06.3). A judgment needs two independent reviewer
 * answers to count as judged (AC-R03.2); an optional one with fewer is
 * `unreviewed` and never blocks, while a required judgment or manual check
 * stays an explicit human gate (the owner-gated acceptance flow is not built,
 * so such a run cannot pass yet). An unadopted checklist criterion gets a
 * verdict only where the evidence observed its behavior. Judgment checks outside the review
 * scope get no verdict (a required one stays open through the bundle's
 * unresolved required checks).
 */
export function computeCheckVerdicts(input: VerdictInputs): ReviewCheckVerdict[] {
  const results = input.mechanical?.results ?? [];
  const observed = input.mechanical ? input.mechanical.observedBehaviors ?? null : null;
  const independent = new Set(input.reviewers.filter(isIndependentReviewerCompletion).map(reviewer => reviewer.role));
  const scope = input.scopeCheckIds ? new Set(input.scopeCheckIds) : null;
  const verdicts: ReviewCheckVerdict[] = [];
  for (const check of input.checks) {
    const answers = { supports: 0, disputes: 0, uncertain: 0 };
    for (const finding of input.findings) if (finding.checkId === check.checkId && independent.has(finding.reviewerRole)) answers[finding.verdict === 'supports' ? 'supports' : finding.verdict === 'disputes' ? 'disputes' : 'uncertain']++;
    const answered = answers.supports + answers.disputes + answers.uncertain;
    const { note, ...applicability } = evaluateApplicability(check, observed);
    const base = { checkId: check.checkId, kind: check.kind, origin: check.origin, required: check.required, applicability, sourceCriteria: check.sourceCriteria, reviewerAnswers: answers };
    // Evidence v2: the reason is a structured message (the applicability note, when there is one, leads it).
    const push = (status: ReviewCheckVerdict['status'], reason: EvidenceText, mechanicalCheckId: string | null = null, evidenceIds: string[] = [], mechanicalOutcome: MechanicalCheckResult['outcome'] | null = null) =>
      verdicts.push({ ...base, status, reason: note ? ev('verdict.withNote', note, reason) : reason, mechanicalCheckId, ...(check.kind === 'mechanical' ? { mechanicalOutcome } : {}), evidenceIds });

    if (check.kind === 'judgment' && scope && !scope.has(check.checkId)) continue;
    // Captain decision 1: an unadopted checklist criterion applies only where the evidence observed its behavior.
    if (check.origin === 'checklist' && applicability.status !== 'applicable') continue;
    if (applicability.basis === 'mismatch') { push('fail', ev('verdict.mismatch')); continue; }
    if (check.kind === 'mechanical') {
      const result = results.find(item => item.checkId === check.checkId) ?? (check.mapsTo ? results.find(item => item.criterionId === check.mapsTo && item.required) : undefined);
      if (applicability.status === 'not-applicable') { push('not-applicable', ev('verdict.notApplicable'), result?.checkId ?? null, [], result?.outcome ?? null); continue; }
      if (!result) { push('inconclusive', input.mechanical ? ev('verdict.noResult') : ev('verdict.noEvidence')); continue; }
      const reason = result.checkId === check.checkId ? resultReason(result.reason) : ev('verdict.reads', rubricKey(result.checkId), resultReason(result.reason));
      // An unobservable behavior never adds a gate beyond the mechanical result the check reads.
      push(result.outcome, reason, result.checkId, result.evidenceIds, result.outcome);
      continue;
    }
    if (applicability.status === 'not-applicable') { push('not-applicable', ev('verdict.notApplicable')); continue; }
    if (applicability.status === 'undetermined') { push('inconclusive', ev('verdict.undetermined')); continue; }
    if (check.kind === 'manual') { push('awaiting-manual', check.required ? ev('verdict.manualRequired') : ev('verdict.manualOptional')); continue; }
    if (check.required) push('awaiting-acceptance', ev('verdict.awaitingAcceptance', answered));
    else if (answered >= 2) push('judged', ev('verdict.judged', answered));
    // Captain decision 2: an optional judgment with fewer than two answers is shown, never a blocker.
    else push('unreviewed', ev('verdict.unreviewed', answered));
  }
  return verdicts;
}

export interface VerdictBlockers {
  /** Required checks with a confirmed failure. */
  failed: string[];
  /** Required checks left open (missing evidence, unknown applicability, or an explicit human gate). */
  open: string[];
  /** Applicable REQUIRED judgment checks fewer than two independent reviewers answered (optional ones are only unreviewed). */
  undercovered: string[];
}

export function verdictBlockers(verdicts: readonly ReviewCheckVerdict[]): VerdictBlockers {
  const open = new Set<string>(WORKBENCH_BLOCKING_VERDICT_STATUSES.filter(status => status !== 'fail'));
  return {
    failed: verdicts.filter(verdict => verdict.required && verdict.status === 'fail').map(verdict => verdict.checkId),
    open: verdicts.filter(verdict => verdict.required && open.has(verdict.status)).map(verdict => verdict.checkId),
    undercovered: verdicts.filter(verdict => verdict.kind === 'judgment' && verdict.required && verdict.applicability.status === 'applicable' && verdict.applicability.basis !== 'mismatch'
      && verdict.reviewerAnswers.supports + verdict.reviewerAnswers.disputes + verdict.reviewerAnswers.uncertain < 2).map(verdict => verdict.checkId),
  };
}
