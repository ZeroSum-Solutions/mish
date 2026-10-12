import { parseProjectRubricDraft, type ObservedBehavior, type ProjectRubric } from '@mish/contracts';
import type { MandatoryCriterionId } from './plan.js';

/**
 * AC-R06.5: Design System Checklist anchors mapped to independently written
 * local criteria (docs/plans/2026-10-02-design-workbench/motion-and-checklist-policy.md
 * and evidence/design-system-checklist.md). The source anchors are
 * traceability only: our checkIds, wording, parameters and required status
 * are local. No checklist prose, code or fonts are imported.
 *
 * Bump CHECKLIST_CRITERIA_VERSION whenever a criterion changes. Runs freeze it;
 * an older run then reads outdated. An accepted rubric is never rewritten: a
 * criterion adopted into a rubric keeps its own wording and pin.
 */
export const CHECKLIST_CRITERIA_VERSION = 'checklist-criteria/1';
const PIN = '28f06a284d010ddb4dc1f68e7c92720ce734310a';
const DATA = `https://github.com/ardakaracizmeli/design-system-checklist/blob/${PIN}/src/data`;

export const CHECKLIST_SOURCE = {
  sourceId: 'design-system-checklist',
  revisionOrDigest: PIN,
  site: 'https://www.designsystemchecklist.com/',
  repository: 'https://github.com/ardakaracizmeli/design-system-checklist',
  /** Audited 2026-10-02: no LICENSE file, no package licence, GitHub reports none. Public visibility is not a reuse grant. */
  licence: { declared: null, redistribution: 'not-granted', basis: 'evidence/design-system-checklist.md (audited 2026-10-02 at the pinned commit)' },
  provenance: 'Local criteria are independently written; only the source anchor IDs and links are referenced. No checklist prose, code, data modules or fonts are copied.',
} as const;

export interface ChecklistAnchor { criterionId: string; category: 'foundations' | 'components' | 'maintenance'; canonicalUrl: string }
const anchor = (criterionId: string, category: ChecklistAnchor['category']): ChecklistAnchor => ({
  criterionId, category,
  canonicalUrl: `${DATA}/${category === 'foundations' ? 'designFoundations' : category === 'components' ? 'components' : 'maintenance'}.js`,
});

/** The 24 source anchors the audit verified at the pin; a maximum evaluation slice, not 24 mandatory checks. */
export const CHECKLIST_ANCHORS: readonly ChecklistAnchor[] = [
  ...['df-color-a11y', 'df-color-semantic', 'df-layout-breakpoints', 'df-layout-spacing', 'df-typography-mobile', 'df-typography-performance', 'df-motion-duration', 'df-motion-a11y', 'df-elevation-z', 'df-iconography-a11y']
    .map(id => anchor(id, 'foundations')),
  ...['c-button-loading', 'c-button-disabled', 'c-button-a11y-role', 'c-button-a11y-focus', 'c-text-field-label', 'c-text-field-error', 'c-text-field-helper', 'c-text-field-a11y-label', 'c-modal-close', 'c-modal-a11y-focus', 'c-modal-a11y-keyboard', 'c-tabs-a11y-keyboard', 'c-image-a11y-alt']
    .map(id => anchor(id, 'components')),
  anchor('m-documentation-sandbox', 'maintenance'),
];

type RubricEvidenceType = ProjectRubric['checks'][number]['evidenceTypes'][number];
export interface ChecklistCriterion {
  checkId: string;
  anchors: string[];
  kind: 'mechanical' | 'judgment' | 'manual';
  /** The existing mandatory check this criterion reads; only such a criterion is required by default. */
  mapsTo: MandatoryCriterionId | null;
  required: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Our own one-line intent (never source prose). */
  intent: string;
  /** Judgment question or manual procedure; null for mapped mechanical criteria. */
  text: string | null;
  targetScope: string;
  evidenceTypes: RubricEvidenceType[];
  /** `always`; the observed behaviors that make it applicable; or `reusable-unit` (only a declared reusable unit). */
  appliesWhen: 'always' | ObservedBehavior[] | 'reusable-unit';
}

const mechanical = (checkId: string, anchors: string[], mapsTo: MandatoryCriterionId, intent: string, targetScope: string, evidenceTypes: RubricEvidenceType[], appliesWhen: ChecklistCriterion['appliesWhen']): ChecklistCriterion =>
  ({ checkId, anchors, kind: 'mechanical', mapsTo, required: true, severity: 'high', intent, text: null, targetScope, evidenceTypes, appliesWhen });
const judgment = (checkId: string, anchors: string[], intent: string, text: string, targetScope: string, appliesWhen: ChecklistCriterion['appliesWhen'], severity: ChecklistCriterion['severity'] = 'medium'): ChecklistCriterion =>
  ({ checkId, anchors, kind: 'judgment', mapsTo: null, required: false, severity, intent, text, targetScope, evidenceTypes: ['screenshot', 'judgment-rationale'], appliesWhen });
const manual = (checkId: string, anchors: string[], intent: string, text: string, targetScope: string, appliesWhen: ChecklistCriterion['appliesWhen'], severity: ChecklistCriterion['severity'] = 'high'): ChecklistCriterion =>
  ({ checkId, anchors, kind: 'manual', mapsTo: null, required: false, severity, intent, text, targetScope, evidenceTypes: ['manual-observation', 'keyboard-trace'], appliesWhen });

export const CHECKLIST_CRITERIA: readonly ChecklistCriterion[] = [
  mechanical('dsc.color-contrast', ['df-color-a11y'], 'core.text-contrast', 'Rendered text meets the contrast thresholds where it is actually drawn.', 'Every sampled text element at each captured width', ['probe', 'computed-style'], 'always'),
  judgment('dsc.color-semantics', ['df-color-semantic'], 'Each colour role keeps one meaning across the page.', 'Does each colour role keep one meaning across the page: the same accent for every primary action, and status colours not reused as decoration?', 'The whole entry page', 'always'),
  mechanical('dsc.layout-breakpoints', ['df-layout-breakpoints'], 'core.responsive-overflow', 'Every declared width renders without page overflow or clipped content.', 'Core and project widths', ['probe', 'screenshot'], 'always'),
  judgment('dsc.spacing-rhythm', ['df-layout-spacing'], 'Spacing follows a consistent rhythm.', 'Does spacing follow a consistent rhythm, with related items closer together than unrelated groups at every captured width?', 'The whole entry page', 'always', 'low'),
  judgment('dsc.type-readability', ['df-typography-mobile'], 'Text stays readable at the narrowest width.', 'At the narrowest captured width, is body text readable without zooming: adequate size, line length and wrapping, with no words cut off?', 'Body and heading text at the narrowest width', 'always'),
  mechanical('dsc.font-loading', ['df-typography-performance'], 'core.console-resources', 'Font files load without errors.', 'Font and other resources the entry requests', ['console', 'network'], 'always'),
  judgment('dsc.motion-timing', ['df-motion-duration'], 'Animations are brief and consistently timed.', 'Are animations brief and consistently timed for what they do, with no long or competing transitions that delay reading or action?', 'Animated elements', ['animation'], 'low'),
  manual('dsc.motion-reduced', ['df-motion-a11y'], 'Reduced-motion users get a static, fully usable page.', 'Turn on the reduced-motion preference and reload: non-essential motion stops or becomes a static state with content and actions intact. Flip the preference while the page is open and confirm the page follows.', 'Animated elements', ['animation']),
  judgment('dsc.overlay-order', ['df-elevation-z'], 'Overlays sit above what they cover.', 'When an overlay is open, does it sit above the content it covers, with nothing showing through or above it that should be hidden?', 'Dialogs and other overlays', ['dialog']),
  mechanical('dsc.icon-names', ['df-iconography-a11y'], 'core.document-semantics', 'Icon-only controls have accessible names.', 'Every visible control', ['accessibility-tree'], 'always'),
  judgment('dsc.button-states', ['c-button-loading', 'c-button-disabled'], 'Disabled and busy buttons look and behave that way.', 'Where buttons can be disabled or busy, are those states visibly distinct, and does a busy button refuse a second activation?', 'Buttons', ['button']),
  mechanical('dsc.button-role-focus', ['c-button-a11y-role', 'c-button-a11y-focus'], 'core.keyboard-focus', 'Buttons are reachable by keyboard with visible focus.', 'Buttons and button-like controls', ['keyboard-trace'], ['button']),
  mechanical('dsc.field-labels', ['c-text-field-label', 'c-text-field-a11y-label'], 'core.document-semantics', 'Every text field has a programmatic label.', 'Text inputs, selects and text areas', ['accessibility-tree'], ['text-input']),
  judgment('dsc.field-errors', ['c-text-field-error', 'c-text-field-helper'], 'Field errors and help say how to recover.', 'Do validation errors and helper text say what went wrong and how to fix it, next to the field they describe?', 'Text inputs and their messages', ['text-input']),
  manual('dsc.modal-keyboard', ['c-modal-close', 'c-modal-a11y-focus', 'c-modal-a11y-keyboard'], 'Dialogs work fully from the keyboard.', 'Open each dialog with the keyboard: focus moves into it and stays inside while it is open, Escape and a visible close control dismiss it, and focus returns to the control that opened it.', 'Dialogs', ['dialog']),
  manual('dsc.tabs-keyboard', ['c-tabs-a11y-keyboard'], 'Tabs work fully from the keyboard.', 'Move into each tab list with the keyboard: arrow keys move between tabs, the selected tab is announced, and its panel follows the selection.', 'Tab lists', ['tabs']),
  judgment('dsc.image-alt', ['c-image-a11y-alt'], 'Images have fitting text alternatives.', 'Do informative images have text alternatives that say what the image conveys, and are decorative images hidden from assistive technology?', 'Images', ['image']),
  manual('dsc.unit-demo', ['m-documentation-sandbox'], 'A reusable unit has an editable demonstration.', 'For a reusable unit, open its editable demonstration and confirm each documented state and action can be exercised there.', 'Reusable units (not single pages)', 'reusable-unit', 'medium'),
];

export class ChecklistSelectionError extends Error {
  constructor(message: string) { super(message); this.name = 'ChecklistSelectionError'; }
}

/** Resolves selected source anchors to local checkIds; unknown or repeated anchors are refused, never dropped. */
export function validateChecklistSelection(anchorIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const checkIds: string[] = [];
  for (const id of anchorIds) {
    if (seen.has(id)) throw new ChecklistSelectionError(`${id} is selected twice`);
    seen.add(id);
    const criterion = CHECKLIST_CRITERIA.find(item => item.anchors.includes(id));
    if (!criterion) throw new ChecklistSelectionError(`${id} is not a verified anchor at ${PIN}`);
    if (!checkIds.includes(criterion.checkId)) checkIds.push(criterion.checkId);
  }
  return checkIds;
}

export const checklistCriterion = (checkId: string): ChecklistCriterion | null => CHECKLIST_CRITERIA.find(item => item.checkId === checkId) ?? null;

/** The attribution tuples a criterion cites, one per anchor. */
export function checklistSourceCriteria(criterion: ChecklistCriterion) {
  return criterion.anchors.map(id => ({
    sourceId: CHECKLIST_SOURCE.sourceId, revisionOrDigest: PIN, criterionId: id,
    canonicalUrl: CHECKLIST_ANCHORS.find(item => item.criterionId === id)!.canonicalUrl,
  }));
}

const VIEWPORTS = [320, 375, 768, 1440];
const MANDATORY_PARAMETERS = {
  'core.text-contrast': { type: 'contrast', normalTextMinRatio: 4.5, largeTextMinRatio: 3, viewports: VIEWPORTS },
  'core.responsive-overflow': { type: 'overflow', toleranceCssPixels: 0, checkClippedContent: true, viewports: VIEWPORTS },
  'core.console-resources': { type: 'console-resources', failOnConsoleError: true, failOnBrokenResource: true, viewports: VIEWPORTS },
  'core.keyboard-focus': { type: 'keyboard-focus', requireVisibleFocus: true, requireFocusReturn: true, viewports: VIEWPORTS },
  'core.document-semantics': { type: 'document-semantics', requireNamedControls: true, requireHeadingStructure: true, viewports: VIEWPORTS },
} as const;

/**
 * The rubric check that explicitly adopts one criterion. Selecting criteria
 * changes a rubric only through an explicit revision (rubric PUT with
 * If-Match, from the UI or `od workbench rubric set`); this builds the check
 * for that draft and validates it against the rubric contract.
 */
export function checklistRubricCheck(checkId: string): ProjectRubric['checks'][number] {
  const criterion = checklistCriterion(checkId);
  if (!criterion) throw new ChecklistSelectionError(`${checkId} is not a local checklist criterion`);
  const provenance = {
    origin: 'imported' as const, derivation: 'source-criterion' as const,
    source: { resourceRef: { sourceType: 'reference' as const, sourceId: CHECKLIST_SOURCE.sourceId, itemId: criterion.anchors[0]!, revisionOrDigest: PIN } },
    rationale: `Independently written local criterion (${CHECKLIST_CRITERIA_VERSION}) anchored to ${criterion.anchors.join(', ')}`,
  };
  const common = { checkId, severity: criterion.severity, provenance, evidenceTypes: criterion.evidenceTypes, intent: criterion.intent, sourceCriteria: checklistSourceCriteria(criterion) };
  const check = criterion.kind === 'mechanical'
    ? { ...common, kind: 'mechanical', required: true, requiredBasis: { type: 'mandatory', criterionId: criterion.mapsTo }, parameters: MANDATORY_PARAMETERS[criterion.mapsTo as keyof typeof MANDATORY_PARAMETERS] }
    : criterion.kind === 'judgment'
      ? { ...common, kind: 'judgment', required: false, requiredBasis: null, parameters: { type: 'criterion', criterion: criterion.text, targetScope: criterion.targetScope } }
      : { ...common, kind: 'manual', required: false, requiredBasis: null, parameters: { type: 'manual-procedure', procedure: criterion.text, environment: 'Any current desktop or mobile browser with a keyboard', targetScope: criterion.targetScope } };
  return parseProjectRubricDraft({ contextRevision: 1, checks: [check] }).checks[0]!;
}
