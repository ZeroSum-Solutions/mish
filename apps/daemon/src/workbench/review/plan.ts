import { WORKBENCH_MANDATORY_CRITERION_IDS, WORKBENCH_MOTION_DEFAULT_VIEWPORTS, type ProjectDesignContext, type ProjectRubric } from '@mish/contracts';
import { canonicalRubricKey } from './evidence.js';
import type { MotionRequest, TargetRequest } from './types.js';

export const CORE_VIEWPORTS = [320, 375, 768, 1440] as const;
export type MandatoryCriterionId = typeof WORKBENCH_MANDATORY_CRITERION_IDS[number];
type RubricCheck = ProjectRubric['checks'][number];
type MechanicalRubricCheck = Extract<RubricCheck, { kind: 'mechanical' }>;
type RubricParameters = MechanicalRubricCheck['parameters'];
type RubricTarget = NonNullable<Extract<RubricParameters, { type: 'cta' }>['targets']>[number];

/** Rubric parameters without their scoping fields; `cta.actionType: 'all'` means every action on the page. */
export type PlannedParameters =
  | { type: 'cta'; actionType: 'conversion' | 'form' | 'navigation' | 'all' }
  | { type: 'contrast'; normalTextMinRatio: number; largeTextMinRatio: number }
  | { type: 'console-resources'; failOnConsoleError: boolean; failOnBrokenResource: boolean }
  | { type: 'overflow'; toleranceCssPixels: number; checkClippedContent: boolean }
  | { type: 'keyboard-focus'; requireVisibleFocus: boolean; requireFocusReturn: boolean }
  | { type: 'document-semantics'; requireNamedControls: boolean; requireHeadingStructure: boolean }
  | { type: 'motion'; requirePauseControl: boolean; requireReducedMotionFallback: boolean; requireLivePreferenceChange: boolean };

export interface PlannedCheck {
  checkId: string;
  criterionId: MandatoryCriterionId | null;
  synthesized: boolean;
  required: boolean;
  severity: RubricCheck['severity'];
  parameters: PlannedParameters;
  /** Null scopes the check to the whole page. */
  targets: TargetRequest[] | null;
  /** Declared targets that could not be turned into a probe (for example an undeclared conversion). */
  unresolvedTargets: string[];
  viewports: number[];
}

export interface ReviewPlan {
  checks: PlannedCheck[];
  viewports: number[];
  contextRevision: number;
  rubricRevision: number;
  unresolvedRequiredChecks: string[];
}

/** The unweakened default each mandatory criterion runs with when the rubric omits it. */
const MANDATORY_DEFAULTS: Record<MandatoryCriterionId, PlannedParameters> = {
  'core.declared-actions': { type: 'cta', actionType: 'all' },
  'core.text-contrast': { type: 'contrast', normalTextMinRatio: 4.5, largeTextMinRatio: 3 },
  'core.console-resources': { type: 'console-resources', failOnConsoleError: true, failOnBrokenResource: true },
  'core.responsive-overflow': { type: 'overflow', toleranceCssPixels: 0, checkClippedContent: true },
  'core.keyboard-focus': { type: 'keyboard-focus', requireVisibleFocus: true, requireFocusReturn: true },
  'core.document-semantics': { type: 'document-semantics', requireNamedControls: true, requireHeadingStructure: true },
};

const HREF_LIKE = /^(?:https?:|mailto:|tel:|\/|\.\.?\/)|\.html?(?:[?#]|$)/iu;

function plannedParameters(parameters: RubricParameters): PlannedParameters {
  switch (parameters.type) {
    case 'cta': return { type: 'cta', actionType: parameters.actionType };
    case 'contrast': return { type: 'contrast', normalTextMinRatio: parameters.normalTextMinRatio, largeTextMinRatio: parameters.largeTextMinRatio };
    case 'console-resources': return { type: 'console-resources', failOnConsoleError: parameters.failOnConsoleError, failOnBrokenResource: parameters.failOnBrokenResource };
    case 'overflow': return { type: 'overflow', toleranceCssPixels: parameters.toleranceCssPixels, checkClippedContent: parameters.checkClippedContent };
    case 'keyboard-focus': return { type: 'keyboard-focus', requireVisibleFocus: parameters.requireVisibleFocus, requireFocusReturn: parameters.requireFocusReturn };
    case 'document-semantics': return { type: 'document-semantics', requireNamedControls: parameters.requireNamedControls, requireHeadingStructure: parameters.requireHeadingStructure };
    case 'motion': return { type: 'motion', requirePauseControl: parameters.requirePauseControl, requireReducedMotionFallback: parameters.requireReducedMotionFallback, requireLivePreferenceChange: parameters.requireLivePreferenceChange };
  }
}

function resolveTargets(targets: RubricTarget[] | undefined, context: ProjectDesignContext | null): { targets: TargetRequest[] | null; unresolved: string[] } {
  if (!targets) return { targets: null, unresolved: [] };
  const resolved: TargetRequest[] = []; const unresolved: string[] = [];
  for (const target of targets) {
    if (target.type === 'selector') { resolved.push({ key: `selector:${target.selector}`, selector: target.selector }); continue; }
    const conversion = context?.conversions.find(item => item.id === target.id);
    if (!conversion) { unresolved.push(target.id); continue; }
    const declared = conversion.target;
    resolved.push({
      key: `conversion:${conversion.id}`, label: conversion.label,
      ...(declared === undefined ? {} : HREF_LIKE.test(declared) ? { href: declared } : { selector: declared }),
    });
  }
  return { targets: resolved, unresolved };
}

/** Motion phases the worker must run at `width`: the union over the motion checks covering it; null when none does. */
export function motionRequestAt(plan: ReviewPlan, width: number): MotionRequest | null {
  let request: MotionRequest | null = null;
  for (const check of plan.checks) {
    const parameters = check.parameters;
    if (parameters.type !== 'motion' || !check.viewports.includes(width)) continue;
    request ??= { pauseControl: false, reducedFallback: false, liveChange: false };
    request.pauseControl ||= parameters.requirePauseControl;
    request.reducedFallback ||= parameters.requireReducedMotionFallback;
    request.liveChange ||= parameters.requireLivePreferenceChange;
  }
  return request;
}

/**
 * Effective mechanical plan: every mechanical rubric check, plus each mandatory
 * criterion the rubric does not declare, at its unweakened default. The core
 * widths are always present; project widths add to them.
 */
export function planReview(rubric: ProjectRubric | null, context: ProjectDesignContext | null): ReviewPlan {
  const checks: PlannedCheck[] = [];
  const unresolvedRequiredChecks: string[] = [];
  for (const check of rubric?.checks ?? []) {
    if (check.kind !== 'mechanical') { if (check.required) unresolvedRequiredChecks.push(check.checkId); continue; }
    const scoped = 'targets' in check.parameters ? check.parameters.targets : undefined;
    const { targets, unresolved } = resolveTargets(scoped, context);
    checks.push({
      checkId: check.checkId,
      criterionId: check.requiredBasis?.type === 'mandatory' ? check.requiredBasis.criterionId : null,
      synthesized: false, required: check.required, severity: check.severity,
      parameters: plannedParameters(check.parameters), targets, unresolvedTargets: unresolved,
      // Motion sampling is slow, so a motion check runs at its own widths (375 and 1440 by default); every other check adds to the core widths.
      viewports: [...new Set([...(check.parameters.type === 'motion' ? WORKBENCH_MOTION_DEFAULT_VIEWPORTS : CORE_VIEWPORTS), ...check.parameters.viewports])].sort((a, b) => a - b),
    });
  }
  const taken = new Set(checks.map(check => check.checkId));
  for (const criterionId of WORKBENCH_MANDATORY_CRITERION_IDS) {
    if (checks.some(check => check.criterionId === criterionId && check.required)) continue;
    const checkId = taken.has(criterionId) ? `${criterionId}:default` : criterionId;
    taken.add(checkId);
    checks.push({ checkId, criterionId, synthesized: true, required: true, severity: 'high', parameters: MANDATORY_DEFAULTS[criterionId], targets: null, unresolvedTargets: [], viewports: [...CORE_VIEWPORTS] });
  }
  const order = (check: PlannedCheck) => check.criterionId ? WORKBENCH_MANDATORY_CRITERION_IDS.indexOf(check.criterionId) : WORKBENCH_MANDATORY_CRITERION_IDS.length;
  checks.sort((a, b) => order(a) - order(b));
  return {
    checks,
    viewports: [...new Set(checks.flatMap(check => check.viewports))].sort((a, b) => a - b),
    contextRevision: context?.revision ?? 0,
    rubricRevision: rubric?.revision ?? 0,
    unresolvedRequiredChecks,
  };
}

/**
 * Every rubric key a review planned from these inputs can name in its
 * evidence: declared target keys and the conversion ids it could not resolve.
 * Readers check a stored bundle's rubric-key parameters against it.
 */
export function frozenRubricKeys(rubric: ProjectRubric | null, context: ProjectDesignContext | null): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const check of planReview(rubric, context).checks) {
    // The same canonical form evaluateCta writes through rubricKey().
    for (const target of check.targets ?? []) keys.add(canonicalRubricKey(target.key));
    for (const id of check.unresolvedTargets) keys.add(canonicalRubricKey(id));
  }
  return keys;
}
