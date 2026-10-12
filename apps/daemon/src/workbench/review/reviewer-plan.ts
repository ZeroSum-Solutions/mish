import { assertCurrentEvidence, LegacyEvidenceError } from './evidence-store.js';
import { parseVerificationBundle, renderReviewEvidenceMessage, WORKBENCH_DEFAULT_REQUIRED_ROLES, WORKBENCH_REVIEWER_ROLES, type ReviewEvidenceMessage, type ReviewEvidenceParam, type ProjectDesignContext, type ProjectRubric, type ReviewerPlan, type ReviewerRole, type ReviewRubricContent, type ReviewScope, type VerificationBundle } from '@mish/contracts';
import type { EffectiveCheck } from './check-verdicts.js';
import { CHECKLIST_CRITERIA, CHECKLIST_CRITERIA_VERSION, CHECKLIST_SOURCE, checklistCriterion, checklistSourceCriteria } from './checklist-criteria.js';
import { JUDGMENT_SEEDS_VERSION, seedContract, seedJudgmentChecks } from './judgment-seeds.js';
import { isVisualFactsId } from './evidence-detail.js';
import { frozenRubricKeys, planReview } from './plan.js';
import type { ReviewerCheck, ReviewerInput } from './reviewers/types.js';

export interface PlanEntry { role: ReviewerRole; required: boolean }

/** Default product-review plan (technical-spec "Reviews and components"): every role selected; the second-family Gemini reviewer is advisory (D7), the rest required. */
export const DEFAULT_REVIEWER_PLAN: readonly PlanEntry[] = WORKBENCH_REVIEWER_ROLES.map(role => ({ role, required: (WORKBENCH_DEFAULT_REQUIRED_ROLES as readonly string[]).includes(role) }));

export function resolveReviewerPlan(plan: ReviewerPlan | undefined): PlanEntry[] {
  return plan ? plan.reviewers.map(entry => ({ role: entry.role, required: entry.required })) : DEFAULT_REVIEWER_PLAN.map(entry => ({ ...entry }));
}

export class ReviewScopeError extends Error {
  constructor(readonly fields: { path: string; message: string }[]) { super('The review scope names checks outside the rubric'); this.name = 'ReviewScopeError'; }
}

/** The daemon-authored rubric content versions a run freezes (AC-R06.5: a refresh is visible, never silent). */
export const RUBRIC_CONTENT: ReviewRubricContent = {
  judgmentSeeds: JUDGMENT_SEEDS_VERSION, checklistCriteria: CHECKLIST_CRITERIA_VERSION,
  checklistSource: { sourceId: CHECKLIST_SOURCE.sourceId, revisionOrDigest: CHECKLIST_SOURCE.revisionOrDigest },
};

export interface FrozenCheckPlan { mechanicalCheckIds: string[]; judgmentCheckIds: string[]; manualCheckIds: string[]; reviewedCheckIds: string[] }

type RubricCheck = ProjectRubric['checks'][number];
const declaredOf = (check: RubricCheck): EffectiveCheck['declared'] => check.applicability ? { status: check.applicability.status, rationale: check.applicability.rationale, evaluator: check.applicability.evaluator } : null;

/**
 * Every check a run is accountable for (AC-R06.3–R06.5): the mechanical plan
 * (rubric checks plus unweakened mandatory defaults), the rubric's judgment
 * and manual checks, the seeded judgment criteria, and the local checklist
 * criteria (only those with a behavior trigger unless the rubric adopts
 * them). A rubric check replaces a seed or criterion with the same checkId,
 * so accepted project wording, pin and required status always win; the
 * vocabulary still supplies applicability and evidence guidance.
 */
export function effectiveChecks(rubric: ProjectRubric | null, context: ProjectDesignContext | null): EffectiveCheck[] {
  const rubricChecks = new Map((rubric?.checks ?? []).map(check => [check.checkId, check]));
  const seeds = seedJudgmentChecks(context);
  const appliesWhen = (checkId: string): EffectiveCheck['appliesWhen'] => checklistCriterion(checkId)?.appliesWhen ?? seeds.find(seed => seed.checkId === checkId)?.appliesWhen ?? 'always';
  const checks: EffectiveCheck[] = planReview(rubric, context).checks.map(planned => {
    const own = rubricChecks.get(planned.checkId);
    return {
      checkId: planned.checkId, kind: 'mechanical', origin: planned.synthesized ? 'mandatory-default' : 'rubric', required: planned.required, criterion: null, contract: null,
      // W2: a required check that stands in for a mandatory criterion always applies, whatever behavior its vocabulary names.
      appliesWhen: planned.criterionId && planned.required ? 'always' : appliesWhen(planned.checkId), declared: own ? declaredOf(own) : null, mapsTo: planned.criterionId ?? checklistCriterion(planned.checkId)?.mapsTo ?? null, sourceCriteria: own?.sourceCriteria ?? [],
    };
  });
  for (const check of rubric?.checks ?? []) {
    if (check.kind === 'mechanical') continue;
    checks.push({
      checkId: check.checkId, kind: check.kind, origin: 'rubric', required: check.required,
      criterion: check.kind === 'judgment' ? check.parameters.criterion : check.parameters.procedure,
      contract: check.kind === 'judgment' ? seedContract(check.checkId, context)?.contract ?? null : null,
      appliesWhen: appliesWhen(check.checkId), declared: declaredOf(check), mapsTo: null, sourceCriteria: check.sourceCriteria,
    });
  }
  const taken = new Set(checks.map(check => check.checkId));
  for (const seed of seeds) {
    if (taken.has(seed.checkId)) continue;
    taken.add(seed.checkId);
    checks.push({ checkId: seed.checkId, kind: 'judgment', origin: 'judgment-seed', required: false, criterion: seed.criterion, contract: seed.contract, appliesWhen: seed.appliesWhen, declared: null, mapsTo: null, sourceCriteria: [] });
  }
  // Captain decision 1: a criterion the rubric did not adopt applies only where observed behavior triggers it,
  // so criteria without a behavior trigger join a run only through the rubric.
  for (const criterion of CHECKLIST_CRITERIA) {
    if (taken.has(criterion.checkId) || !Array.isArray(criterion.appliesWhen)) continue;
    taken.add(criterion.checkId);
    checks.push({
      checkId: criterion.checkId, kind: criterion.kind, origin: 'checklist', required: criterion.required, criterion: criterion.text, contract: null,
      appliesWhen: criterion.appliesWhen, declared: null, mapsTo: criterion.mapsTo, sourceCriteria: checklistSourceCriteria(criterion),
    });
  }
  return checks;
}

/**
 * Which checks a run covers. Mandatory mechanical checks always run (scope
 * never weakens them); scope narrows what model reviewers are asked about.
 * Unknown check ids in a scope are a field error, never silently dropped.
 * Checklist criteria that read a mandatory check are reported, not re-asked.
 */
export function planChecks(rubric: ProjectRubric | null, context: ProjectDesignContext | null, scope: ReviewScope): FrozenCheckPlan {
  const checks = effectiveChecks(rubric, context);
  const mechanicalCheckIds = planReview(rubric, context).checks.map(check => check.checkId);
  const judgmentCheckIds = checks.filter(check => check.kind === 'judgment').map(check => check.checkId);
  const manualCheckIds = checks.filter(check => check.kind === 'manual').map(check => check.checkId);
  const known = new Set(checks.map(check => check.checkId));
  if (scope.kind === 'checks') {
    const fields = scope.checkIds.flatMap((id, index) => known.has(id) ? [] : [{ path: `scope.checkIds.${index}`, message: `${id} is not a check in the current rubric` }]);
    if (fields.length) throw new ReviewScopeError(fields);
  }
  const inScope = (id: string) => scope.kind === 'all' || scope.checkIds.includes(id);
  return {
    mechanicalCheckIds,
    judgmentCheckIds: judgmentCheckIds.filter(inScope),
    manualCheckIds,
    reviewedCheckIds: [...mechanicalCheckIds, ...judgmentCheckIds].filter(inScope),
  };
}

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`]+/giu;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 [redacted]'],
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|sig|signature|password|passwd|pwd|auth|session|credential|cookie))(\s*[=:]\s*)["']?[^\s"'&;,]{4,}/giu, '$1$2[redacted]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{12,}/gu, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gu, '[redacted]'],
];
/** Long runs (keys, signed blobs); redacted when they mix letters and digits. */
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{32,}/gu;

/**
 * Evidence leaves the daemon for third-party reviewers, so page-derived text is
 * scrubbed first: URL query strings and fragments are dropped (signed URLs and
 * `?api_key=` live there), and secret-shaped strings are replaced.
 */
export function redactEvidenceText(text: string): string {
  let out = text.replace(URL_PATTERN, url => {
    const cut = url.search(/[?#]/u);
    return cut === -1 ? url : `${url.slice(0, cut)}${url[cut] === '?' ? '?[redacted]' : ''}`;
  });
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.replace(HIGH_ENTROPY, run => /[0-9]/u.test(run) && /[A-Za-z]/u.test(run) ? '[redacted]' : run);
}

/** A user-authored rubric key inside a message is user text: scrubbed like the rubric's own criteria. */
function scrubParam(param: ReviewEvidenceParam): ReviewEvidenceParam {
  if (param.kind === 'rubricKey') return { ...param, value: redactEvidenceText(param.value) };
  if (param.kind === 'list') return { ...param, items: param.items.map(scrubParam) };
  if (param.kind === 'message') return { ...param, params: param.params.map(scrubParam) };
  return param;
}
/** Renders a validated, current-bundle message for a reviewer prompt (English, from the template table). */
function reviewerText(value: ReviewEvidenceMessage | string): string {
  // Unreachable for a current bundle (checked below); refuse rather than pass free text on.
  if (typeof value === 'string') throw new LegacyEvidenceError('sent to a reviewer');
  return renderReviewEvidenceMessage({ template: value.template, params: value.params.map(scrubParam) }, 'en');
}

/** Copy-quality judgment dimensions: text reviewers see page copy only as hash tokens, so they abstain on these. */
const COPY_DIMENSIONS: ReadonlySet<string> = new Set(['specificity', 'repetition']);

/** A judgment needs the rendered look when its rubric or seeded contract asks for screenshot or computed-style evidence. */
function isVisualJudgment(rubricTypes: readonly string[] | undefined, contractTypes: readonly string[] | undefined): boolean {
  return [...(rubricTypes ?? []), ...(contractTypes ?? [])].some(type => type === 'screenshot' || type === 'computed-style');
}

/**
 * The text and screenshot input every reviewer gets for the frozen plan and the run's mechanical evidence.
 * Invariant: the bundle is re-validated against the contract (every message
 * parameter against its type and against what the bundle vouches for) and
 * must be current; mechanical text is rendered from the template table, and
 * user-authored text (criteria, style direction, rubric keys) passes
 * redactEvidenceText.
 */
export function buildReviewerInput(args: {
  projectId: string; runId: string; entry: string; rubric: ProjectRubric | null; context: ProjectDesignContext | null;
  reviewedCheckIds: string[]; bundle: VerificationBundle; screenshots: ReviewerInput['screenshots'];
}): ReviewerInput {
  // Re-validated at the boundary: a bundle whose parameters fail their types, or that is not current, never reaches a model.
  let bundle: VerificationBundle;
  try { bundle = parseVerificationBundle(args.bundle); } catch { throw new LegacyEvidenceError('sent to a reviewer: it does not validate against the evidence contract'); }
  assertCurrentEvidence(bundle, 'sent to a reviewer', frozenRubricKeys(args.rubric, args.context));
  const judgments = new Map(effectiveChecks(args.rubric, args.context).filter(check => check.kind === 'judgment').map(check => [check.checkId, check]));
  const results = new Map(bundle.results.map(result => [result.checkId, result]));
  const rubricEvidence = new Map((args.rubric?.checks ?? []).map(check => [check.checkId, check.evidenceTypes]));
  // R03: the measured visual facts a judgment about the rendered look reads (one item per captured width).
  const visualIds = bundle.evidence.filter(item => isVisualFactsId(item.id)).map(item => item.id);
  const checks: ReviewerCheck[] = args.reviewedCheckIds.flatMap((checkId): ReviewerCheck[] => {
    const result = results.get(checkId);
    if (result) return [{ checkId, kind: 'mechanical', criterion: `${result.parameterType} check${result.criterionId ? ` (${result.criterionId})` : ''}`, mechanicalOutcome: result.outcome, mechanicalReason: reviewerText(result.reason), evidenceIds: result.evidenceIds, visual: false, copy: false }];
    const check = judgments.get(checkId);
    if (!check?.criterion) return [];
    const visual = isVisualJudgment(rubricEvidence.get(checkId), check.contract?.evidence);
    return [{ checkId, kind: 'judgment', criterion: redactEvidenceText(check.criterion), mechanicalOutcome: null, mechanicalReason: null, evidenceIds: visual ? visualIds : [], visual, copy: COPY_DIMENSIONS.has(check.contract?.dimension ?? ''), ...(check.contract ? { contract: check.contract } : {}) }];
  });
  const direction = args.context?.styleDirection ?? args.context?.brandDirection;
  return {
    projectId: args.projectId, runId: args.runId, entry: args.entry,
    styleDirection: direction == null ? null : redactEvidenceText(direction),
    checks,
    evidence: bundle.evidence.map(item => ({ id: item.id, summary: reviewerText(item.summary), observations: item.observations.map(reviewerText), detail: (item.detail ?? []).map(reviewerText) })),
    screenshots: args.screenshots,
  };
}
