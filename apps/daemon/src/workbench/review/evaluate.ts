import type { MechanicalCheckOutcome, VerificationEvidence } from '@mish/contracts';
import { contrastRatio, isLargeText } from './color.js';
import { digestParam, ev, evidenceKey, evidenceRole, evidenceSelector, list, num, readPageText, rubricKey, vocab, type EvidenceText, type PageText } from './evidence.js';
import { describeConsoleRecord } from './page-text.js';
import type { PlannedCheck, PlannedParameters } from './plan.js';
import { PIXEL_TILE_KEY } from './pixel-tiles.js';
import { firstMovementAfter, liveTimerConcerns, longestQuietMs, MAX_PAUSE_ACTIVATIONS, MOTION_SAMPLE_INTERVAL_MS, observedMovement, stillProofMs } from './motion.js';
import type { ActionProbe, MotionCapture, MotionObservation, MotionPhase, TargetRequest, ViewportCapture } from './types.js';

// Findings are structured messages only (see evidence.ts): a template key from
// the contract's closed table and typed parameters. A page string cannot be
// written into a finding without passing a vocabulary, the serve-log/allow-list
// URL reducer or the length+digest token, and the compiler checks it.

/** One check at one width: its verdict and the human-readable findings behind it. */
export interface ViewportVerdict { outcome: MechanicalCheckOutcome; findings: EvidenceText[] }
export type CaptureAtWidth = { capture: ViewportCapture } | { error: EvidenceText };

const MIN_TARGET_CSS_PX = 24;
/** The contract's list-parameter limit. */
const MAX_LISTED_HASHES = 60;
const verdict = (fails: EvidenceText[], open: EvidenceText[], applicable: boolean, notes: EvidenceText[] = []): ViewportVerdict =>
  fails.length ? { outcome: 'fail', findings: [...fails, ...open, ...notes] }
    : open.length ? { outcome: 'inconclusive', findings: [...open, ...notes] }
      : applicable ? { outcome: 'pass', findings: notes } : { outcome: 'not-applicable', findings: notes };

export const inScope = (keys: string[], targets: TargetRequest[] | null) => targets === null || keys.some(key => targets.some(target => target.key === key));

type CtaActionType = Extract<PlannedParameters, { type: 'cta' }>['actionType'];
/** Whether an action is of the kind a CTA check with this action type judges. */
export const ctaKindAllowed = (actionType: CtaActionType, action: ActionProbe) => actionType === 'navigation' ? action.kind === 'link' : actionType === 'form' ? action.kind === 'form' : true;
/** The actions a CTA check judges: its declared targets, or every visible enabled action of its kind. */
export function ctaActionsInScope(check: PlannedCheck, actionType: CtaActionType, capture: ViewportCapture): ActionProbe[] {
  // A discovered action that is hidden or disabled at this width is not a declared CTA here.
  return capture.actions.filter(action => ctaKindAllowed(actionType, action) && (check.targets !== null ? inScope(action.targetKeys, check.targets) : action.visible && !action.disabled));
}

function linkProblem(action: ActionProbe): { fail?: EvidenceText; open?: EvidenceText } {
  const destination = action.destination;
  const label = ev('cta.label', evidenceSelector(action.selector), action.href ?? ev('common.none'));
  if (!destination) return { open: ev('cta.notProbed', label) };
  switch (destination.kind) {
    case 'same-origin': return destination.status && destination.status < 400 ? {} : { fail: ev('cta.missingPage', label, destination.status ?? ev('common.noResponse')) };
    case 'fragment': return destination.found ? {} : { fail: ev('cta.missingFragment', label) };
    case 'script': case 'empty': return { fail: ev('cta.noNavigation', label) };
    case 'external':
      if (typeof destination.status === 'number') return destination.status < 400 ? {} : { fail: ev('cta.missingExternal', label, destination.status) };
      if (destination.reason) return { open: ev('cta.externalUnchecked', label, destination.reason) };
      return { open: ev('cta.externalNotVisited', label) };
    case 'mailto': case 'tel': return {};
  }
}

function clickProblem(action: ActionProbe): { fail?: EvidenceText; open?: EvidenceText } {
  const effect = action.clickEffect;
  const selector = evidenceSelector(action.selector);
  if (!effect) return { open: ev('cta.notClickProbed', selector) };
  // The probe could not find this exact action again after reloading: nothing it observed is about this action.
  // Activation is verified only on the element the capture saw, found again uniquely at the same place.
  if (effect.target === 'missing') return { open: ev('cta.probeUnmatched', selector) };
  if (effect.target === 'ambiguous') return { open: ev('cta.probeAmbiguous', selector) };
  if (effect.target === 'relocated') return { open: ev('cta.probeRelocated', selector) };
  if (effect.error) return { fail: ev('cta.clickError', selector, effect.error.token()) };
  if (effect.externalBlocked) return { open: ev('cta.externalClick', selector) };
  if (!effect.domMutations && !effect.navigated && !effect.submissionCaptured) return { fail: ev('cta.noEffect', selector) };
  return {};
}

function evaluateCta(check: PlannedCheck, actionType: CtaActionType, capture: ViewportCapture): ViewportVerdict {
  const fails: EvidenceText[] = []; const open: EvidenceText[] = [];
  for (const id of check.unresolvedTargets) open.push(ev('cta.conversionUndeclared', rubricKey(id)));
  const targeted = check.targets !== null;
  for (const target of check.targets ?? []) {
    if (!capture.actions.some(action => action.targetKeys.includes(target.key) && ctaKindAllowed(actionType, action))) fails.push(ev('cta.targetMissing', vocab('actionType', actionType), rubricKey(target.key)));
  }
  const actions = ctaActionsInScope(check, actionType, capture);
  for (const action of actions) {
    const selector = evidenceSelector(action.selector);
    if (!action.visible) { fails.push(ev('cta.hidden', selector)); continue; }
    if (action.disabled) { fails.push(ev('cta.disabled', selector)); continue; }
    if (action.name.isBlank()) fails.push(ev('cta.unnamed', selector));
    if (!action.inline && (action.width < MIN_TARGET_CSS_PX || action.height < MIN_TARGET_CSS_PX)) fails.push(ev('cta.smallTarget', selector, Math.round(action.width), Math.round(action.height)));
    const problem = action.kind === 'link' ? linkProblem(action) : clickProblem(action);
    if (problem.fail) fails.push(problem.fail);
    if (problem.open) open.push(problem.open);
  }
  return verdict(fails, open, actions.length > 0 || targeted);
}

function evaluateContrast(check: PlannedCheck, parameters: Extract<PlannedParameters, { type: 'contrast' }>, capture: ViewportCapture): ViewportVerdict {
  const fails: EvidenceText[] = []; const open: EvidenceText[] = [];
  const texts = capture.texts.filter(text => inScope(text.targetKeys, check.targets));
  // Text the probe never reached may be low contrast, so a truncated sample can fail but never pass.
  if (capture.textsTruncated) open.push(ev('contrast.truncated', capture.width));
  for (const text of texts) {
    const selector = evidenceSelector(text.selector);
    if (!text.background) { open.push(ev('contrast.unmeasured', selector)); continue; }
    const ratio = contrastRatio(text.color, text.background);
    const large = isLargeText(text.fontSizePx, text.fontWeight);
    const minimum = large ? parameters.largeTextMinRatio : parameters.normalTextMinRatio;
    if (ratio + 1e-9 < minimum) fails.push(ev('contrast.low', selector, text.text.token(), num(Number(ratio.toFixed(2)), 2), minimum, vocab('textSize', large ? 'large' : 'normal')));
  }
  return verdict(fails, open, texts.length > 0, [ev('contrast.samples', texts.length)]);
}

function evaluateConsole(parameters: Extract<PlannedParameters, { type: 'console-resources' }>, capture: ViewportCapture): ViewportVerdict {
  const fails: EvidenceText[] = []; const open: EvidenceText[] = [];
  // Console text is never quoted: each error is cited by its record (kind, id, length, digest, source).
  if (parameters.failOnConsoleError && capture.console.length) {
    const count = capture.console.reduce((sum, record) => sum + record.count, 0);
    // The hash list is capped like every list parameter; the count and every record stay complete.
    fails.push(ev('console.errors', count, list(capture.console.slice(0, MAX_LISTED_HASHES).map(record => digestParam(record.sha256.slice(0, 12))))));
    for (const record of capture.console) fails.push(describeConsoleRecord(record));
  }
  if (parameters.failOnBrokenResource) {
    for (const resource of capture.resources) fails.push(ev('console.brokenResource', resource.url, resource.status, resource.resourceType));
    for (const font of capture.fonts) if (font.status === 'error') fails.push(ev('console.fontFailed', font.family.token()));
  }
  for (const request of capture.blockedRequests) {
    open.push(request.reason
      ? ev('console.blockedRefused', request.resourceType, request.url, request.reason)
      : ev('console.blockedDefault', request.resourceType, request.url));
  }
  return verdict(fails, open, true);
}

function evaluateOverflow(check: PlannedCheck, parameters: Extract<PlannedParameters, { type: 'overflow' }>, capture: ViewportCapture): ViewportVerdict {
  const fails: EvidenceText[] = []; const tolerance = parameters.toleranceCssPixels;
  const excess = capture.document.scrollWidth - capture.document.clientWidth;
  if (check.targets === null && excess > tolerance) fails.push(ev('overflow.scroll', excess, capture.width));
  if (check.targets === null && capture.document.layoutWidth - capture.width > tolerance) fails.push(ev('overflow.layout', capture.document.layoutWidth, capture.width));
  if (parameters.checkClippedContent) {
    for (const item of capture.clipped) {
      if (item.axis === 'x' && inScope(item.targetKeys, check.targets) && item.scrollWidth - item.clientWidth > tolerance) fails.push(ev('overflow.clipped', evidenceSelector(item.selector), item.scrollWidth - item.clientWidth));
    }
    for (const item of capture.outsideViewport) {
      const past = Math.max(item.right - capture.width, -item.left);
      if (inScope(item.targetKeys, check.targets) && past > tolerance) fails.push(ev('overflow.outside', evidenceSelector(item.selector), Math.round(past)));
    }
  }
  return verdict(fails, [], true);
}

function evaluateKeyboard(parameters: Extract<PlannedParameters, { type: 'keyboard-focus' }>, capture: ViewportCapture): ViewportVerdict {
  const { focusableCount, steps } = capture.keyboard;
  if (focusableCount === 0) return verdict([], [], false, [ev('keyboard.none')]);
  const fails: EvidenceText[] = []; const notes: EvidenceText[] = [];
  if (parameters.requireVisibleFocus) {
    for (const step of steps) if (step.selector && !step.focusVisible) fails.push(ev('keyboard.noFocusRing', evidenceSelector(step.selector)));
  }
  // Steps are compared by their page-side selector text; only the reduced selector is ever written.
  const visited: string[] = []; let wrapped = false;
  for (const step of steps) {
    const raw = step.selector === null ? null : readPageText(step.selector);
    if (raw === null || raw === visited[0]) { wrapped = visited.length > 0; if (wrapped) break; continue; }
    if (visited.includes(raw)) { if (parameters.requireFocusReturn) fails.push(ev('keyboard.trapped', evidenceSelector(step.selector!))); break; }
    visited.push(raw);
  }
  if (parameters.requireFocusReturn && !wrapped && !fails.some(text => text.template === 'keyboard.trapped')) fails.push(ev('keyboard.noReturn'));
  if (visited.length < focusableCount) notes.push(ev('keyboard.reached', visited.length, focusableCount));
  const unique = new Map(fails.map(text => [evidenceKey(text), text]));
  return verdict([...unique.values()], [], true, notes);
}

function evaluateSemantics(parameters: Extract<PlannedParameters, { type: 'document-semantics' }>, capture: ViewportCapture): ViewportVerdict {
  const fails: EvidenceText[] = [];
  if (!capture.document.lang || capture.document.lang.isBlank()) fails.push(ev('semantics.noLang'));
  if (capture.document.title.isBlank()) fails.push(ev('semantics.noTitle'));
  if (parameters.requireHeadingStructure) {
    if (!capture.headings.some(heading => heading.level === 1)) fails.push(ev('semantics.noH1'));
    capture.headings.forEach((heading, index) => {
      const previous = capture.headings[index - 1];
      if (previous && heading.level > previous.level + 1) fails.push(ev('semantics.headingJump', heading.text.token(), previous.level, heading.level));
    });
  }
  if (parameters.requireNamedControls) for (const control of capture.controls) if (control.name.isBlank()) fails.push(ev('semantics.unnamedControl', evidenceSelector(control.selector), evidenceRole(control.role)));
  return verdict(fails, [], true);
}

/** Seconds with one decimal, as a typed number parameter. */
const seconds = (ms: number) => num(ms / 1000, 1);
/** What kept moving: element selectors and animations (structural selectors or tokens), or the viewport. */
function movingSubject(observation: MotionObservation): EvidenceText {
  const parts: EvidenceText[] = [];
  const seen = new Set<string>();
  const add = (text: EvidenceText) => { const key = evidenceKey(text); if (!seen.has(key)) { seen.add(key); parts.push(text); } };
  for (const selector of observation.movingAfter.slice(0, 3)) add(ev('motion.subject.element', evidenceSelector(selector)));
  for (const item of observation.animationsAfter.slice(0, 3)) add(ev(item.iterations === null ? 'motion.subject.animationInfinite' : 'motion.subject.animation', evidenceSelector(item.selector), item.name.token()));
  return parts.length ? ev('motion.subject.list', list(parts)) : ev('motion.subject.viewport');
}

type PhaseState = { state: 'moving' | 'still'; observation: MotionObservation } | { state: 'open'; reason: EvidenceText };
interface StillProof {
  /** After an action: the watch past the grace period must be at least this long (stillProofMs of the moving windows). */
  minWatchMs?: number;
  /** The quiet stretch that sets minWatchMs, for the finding. */
  quietMs?: number;
  /** A load phase must still be watching at this page-clock time, when the motion was seen without a preference. */
  untilMs?: number | null;
  /** Earlier windows of the same document, for judging live timers (NW1); the window itself when omitted. */
  befores?: MotionObservation[];
  /**
   * Set for the watch after an action (live switch, pause press): `earlier`
   * holds the moving windows before it (the no-preference load and the
   * pre-press window), whose changed viewport tiles count as known motion.
   */
  afterAction?: { earlier: MotionObservation[] };
}

const isPixelSubject = (key: string) => key === 'viewport pixels' || PIXEL_TILE_KEY.test(key);
/**
 * NW2 (round 5): a pixel-only change after an action is excused as a late
 * repaint only when every such change came within one sample of the end of
 * the grace period, and none is in a tile that also changed while the
 * content was moving before. Anything else is motion; load windows never
 * get the allowance.
 */
function lateRepaintOnly(observation: MotionObservation, earlier: MotionObservation[]): boolean {
  const changes = (observation.subjects ?? []).filter(subject => isPixelSubject(subject.key))
    .flatMap(subject => subject.movementMs.filter(time => time >= observation.continuousFromMs).map(time => ({ key: subject.key, time })));
  if (!changes.length) return false;
  const knownTiles = new Set(earlier.flatMap(window => (window.subjects ?? []).filter(subject => PIXEL_TILE_KEY.test(subject.key)).map(subject => subject.key)));
  return changes.every(change => change.time <= observation.continuousFromMs + MOTION_SAMPLE_INTERVAL_MS && !knownTiles.has(change.key));
}

/**
 * Invariant: a phase shows movement only from changes it actually saw, and
 * shows stillness only with enough samples after its threshold, a viewport
 * comparison, no source the sampler cannot see (B2) and a watch long enough
 * that the observed motion would have recurred inside it (B1). Anything less
 * is open evidence, never stillness.
 */
function phaseState(phase: MotionPhase | null, label: EvidenceText, proof: StillProof = {}): PhaseState {
  if (!phase) return { state: 'open', reason: ev('motion.phase.notObserved', label) };
  if ('error' in phase) return { state: 'open', reason: ev('motion.phase.failed', label, phase.error) };
  const observation = phase.observation;
  // A pixel change with no element moving right after an action may be a late repaint; it proves neither.
  if (proof.afterAction && observedMovement(observation) && !observation.movingAfter.length && !observation.animationsAfter.length && lateRepaintOnly(observation, proof.afterAction.earlier)) {
    return { state: 'open', reason: ev('motion.phase.lateRepaint', label, seconds(observation.continuousFromMs)) };
  }
  if (observedMovement(observation)) return { state: 'moving', observation };
  if (observation.samplesAfter < 2) return { state: 'open', reason: ev('motion.phase.fewSamples', label, observation.samplesAfter, seconds(observation.continuousFromMs)) };
  if (observation.pixelsChangedAfter === null) return { state: 'open', reason: ev('motion.phase.pixelsUnknown', label) };
  if (observation.unmeasured.length) return { state: 'open', reason: ev('motion.phase.unmeasured', label, list(observation.unmeasured.slice(0, 3))) };
  const timers = liveTimerConcerns(observation, proof.befores ?? [observation]);
  if (timers.length) return { state: 'open', reason: ev('motion.phase.timers', label, list(timers)) };
  const watched = observation.toMs - observation.continuousFromMs;
  if (proof.minWatchMs !== undefined && watched < proof.minWatchMs) return { state: 'open', reason: ev('motion.phase.watchTooShort', label, seconds(watched), seconds(proof.quietMs ?? 0)) };
  if (proof.untilMs != null && observation.toMs < proof.untilMs + MOTION_SAMPLE_INTERVAL_MS) return { state: 'open', reason: ev('motion.phase.endedEarly', label, seconds(observation.toMs), seconds(proof.untilMs)) };
  return { state: 'still', observation };
}

type PauseVerdict = { fail: EvidenceText } | { open: EvidenceText } | { note: EvidenceText };
/** Pause controls as evidence: structural selector (or its token) and the token of the accessible name. */
const controlNames = (controls: { selector: PageText; name: PageText }[]) => list(controls.slice(0, 3).map(control => ev('motion.control', evidenceSelector(control.selector), control.name.token())));

/** WCAG 2.2.2 pause, stop or hide: a ranked key activation must stop motion that was seen moving in the same document. */
function evaluatePause(pause: MotionCapture['pause'], base: MotionObservation, subject: EvidenceText, width: number): PauseVerdict {
  if (!pause) return { open: ev('motion.pause.notRun', width) };
  if ('error' in pause) return { open: ev('motion.pause.failed', width, pause.error) };
  const reached = pause.controls.filter(control => control.reachedByKeyboard);
  const activatable = reached.filter(control => control.activatable);
  if (!activatable.length) {
    if (reached.length) return { open: ev('motion.pause.notButtonLike', controlNames(reached), width) };
    if (!pause.walkComplete) return { open: ev('motion.pause.walkCut', pause.tabStops, width) };
    if (pause.controls.length) return { fail: ev('motion.pause.unreachable', controlNames(pause.controls), width) };
    return { fail: ev('motion.pause.none', subject, width, pause.tabStops) };
  }
  const before = phaseState(pause.before, ev('motion.label.beforePress', width));
  if (before.state === 'open') return { open: before.reason };
  if (before.state === 'still') return { open: ev('motion.pause.notMovingBefore', width) };
  const quietMs = Math.max(longestQuietMs(base), longestQuietMs(before.observation));
  const proof = { minWatchMs: stillProofMs(base, before.observation), quietMs, befores: [before.observation], afterAction: { earlier: [base, before.observation] } };
  const opens: EvidenceText[] = []; const stillMoving: EvidenceText[] = [];
  for (const attempt of pause.attempts) {
    const label = ev('motion.label.afterPress', controlNames([attempt]), width);
    const after = phaseState(attempt.after, label, proof);
    if (after.state === 'moving') { stillMoving.push(ev('motion.pause.stillMoving', controlNames([attempt]), width, movingSubject(after.observation), seconds(after.observation.continuousFromMs))); continue; }
    if (after.state === 'open') { opens.push(after.reason); continue; }
    if (attempt.blockedDuring || attempt.windowOpensDuring) { opens.push(ev('motion.pause.refused', label, attempt.blockedDuring, attempt.windowOpensDuring)); continue; }
    return { note: ev('motion.pause.stopped', controlNames([attempt]), width) };
  }
  if (opens.length) return { open: opens[0]! };
  const expected = Math.min(activatable.length, MAX_PAUSE_ACTIVATIONS);
  if (pause.attempts.length < expected) return { open: stillMoving.length ? ev('motion.pause.untriedMoving', pause.attempts.length, expected, width, stillMoving[0]!) : ev('motion.pause.untried', pause.attempts.length, expected, width) };
  return { fail: stillMoving[0] ?? ev('motion.pause.noneStopped', width) };
}

/**
 * AC-R06 preamble (WCAG 2.2.2, 2.3.3): content that keeps moving more than
 * five seconds after load needs a keyboard-reachable pause/stop/hide control
 * that stops it, a static or reduced page under prefers-reduced-motion:
 * reduce, and must honour a live switch to reduce. Not-applicable needs
 * positive evidence that nothing moves, with its window and pixel coverage stated.
 */
function evaluateMotion(parameters: Extract<PlannedParameters, { type: 'motion' }>, capture: ViewportCapture): ViewportVerdict {
  const width = capture.width;
  const motion = capture.motion;
  if (!motion) return verdict([], [ev('motion.notSampled', width)], true);
  const base = phaseState(motion.noPreference, ev('motion.label.noPreference', width));
  if (base.state === 'open') return verdict([], [base.reason], true);
  const from = seconds(base.observation.fromMs); const to = seconds(base.observation.toMs);
  if (base.state === 'still') return verdict([], [], false, [ev('motion.notApplicable', width, seconds(base.observation.continuousFromMs), from, to, width, capture.height)]);
  const subject = movingSubject(base.observation);
  const fails: EvidenceText[] = []; const open: EvidenceText[] = [];
  const notes = [ev('motion.baseMoving', width, subject, seconds(base.observation.continuousFromMs), from, to, seconds(longestQuietMs(base.observation)))];
  if (parameters.requirePauseControl) {
    const pause = evaluatePause(motion.pause, base.observation, subject, width);
    if ('fail' in pause) fails.push(pause.fail); else if ('open' in pause) open.push(pause.open); else notes.push(pause.note);
  }
  if (parameters.requireReducedMotionFallback) {
    const reduced = phaseState(motion.reduced, ev('motion.label.reduced', width), { untilMs: firstMovementAfter(base.observation) });
    if (reduced.state === 'open') open.push(reduced.reason);
    else if (reduced.state === 'moving') fails.push(ev('motion.reduced.moving', width, movingSubject(reduced.observation), seconds(reduced.observation.continuousFromMs)));
    else notes.push(ev('motion.reduced.still', seconds(reduced.observation.continuousFromMs), width, seconds(reduced.observation.toMs)));
  }
  if (parameters.requireLivePreferenceChange) {
    const live = phaseState(motion.liveChange, ev('motion.label.live', width), { minWatchMs: stillProofMs(base.observation), quietMs: longestQuietMs(base.observation), befores: [base.observation], afterAction: { earlier: [base.observation] } });
    if (live.state === 'open') open.push(live.reason);
    else if (live.state === 'moving') fails.push(ev('motion.live.moving', width, movingSubject(live.observation)));
    else notes.push(ev('motion.live.still', width, seconds(live.observation.toMs - live.observation.continuousFromMs)));
  }
  return verdict(fails, open, true, notes);
}

export function evaluateAtWidth(check: PlannedCheck, capture: ViewportCapture): ViewportVerdict {
  const parameters = check.parameters;
  switch (parameters.type) {
    case 'cta': return evaluateCta(check, parameters.actionType, capture);
    case 'contrast': return evaluateContrast(check, parameters, capture);
    case 'console-resources': return evaluateConsole(parameters, capture);
    case 'overflow': return evaluateOverflow(check, parameters, capture);
    case 'keyboard-focus': return evaluateKeyboard(parameters, capture);
    case 'document-semantics': return evaluateSemantics(parameters, capture);
    case 'motion': return evaluateMotion(parameters, capture);
  }
}

const EVIDENCE_TYPE: Record<PlannedParameters['type'], VerificationEvidence['type']> = {
  cta: 'probe', contrast: 'computed-style', 'console-resources': 'console', overflow: 'probe', 'keyboard-focus': 'keyboard-trace', 'document-semantics': 'accessibility-tree', motion: 'probe',
};

/** Fold per-width verdicts: any fail → fail; any open width → inconclusive; all n/a → n/a; else pass. */
export function evaluateCheck(check: PlannedCheck, captures: ReadonlyMap<number, CaptureAtWidth>): { outcome: MechanicalCheckOutcome; reason: EvidenceText; evidence: VerificationEvidence[] } {
  const evidence: VerificationEvidence[] = []; const perWidth: [number, ViewportVerdict][] = [];
  for (const width of check.viewports) {
    const entry = captures.get(width);
    const result: ViewportVerdict = !entry ? { outcome: 'inconclusive', findings: [ev('capture.none', width)] }
      : 'error' in entry ? { outcome: 'inconclusive', findings: [ev('capture.failedAt', width, entry.error)] }
        : evaluateAtWidth(check, entry.capture);
    perWidth.push([width, result]);
    evidence.push({ id: `${check.checkId}@${width}`, viewport: width, type: EVIDENCE_TYPE[check.parameters.type], summary: ev('summary.atWidth', vocab('outcome', result.outcome), width), observations: result.findings.slice(0, 60) });
  }
  const pick = (outcome: MechanicalCheckOutcome) => perWidth.filter(([, result]) => result.outcome === outcome);
  const outcome: MechanicalCheckOutcome = pick('fail').length ? 'fail' : pick('inconclusive').length ? 'inconclusive' : pick('pass').length ? 'pass' : 'not-applicable';
  const reason = outcome === 'pass' ? ev('result.passed', list(check.viewports))
    // A motion n/a states what was watched at each width (AC-R06(5): n/a needs its reason).
    : outcome === 'not-applicable' ? (check.parameters.type === 'motion' ? ev('result.byWidth', list(perWidth.map(([width, result]) => ev('result.atWidth', width, result.findings[0] ?? ev('result.notApplicable'))))) : ev('result.notApplicable'))
      : ev('result.byWidth', list(pick(outcome).map(([width, result]) => ev('result.atWidth', width, result.findings[0] ?? ev('result.outcome', vocab('outcome', outcome))))));
  return { outcome, reason, evidence };
}
