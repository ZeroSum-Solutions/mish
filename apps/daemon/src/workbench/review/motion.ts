// B4-2b motion timing shared by the CDP worker (which samples) and the
// evaluator (which judges). Pure: no browser, no I/O.
import { ev, num, type EvidenceText } from './evidence.js';
import type { MotionObservation } from './types.js';

/** WCAG 2.2.2: moving content that lasts more than five seconds after it starts. */
export const MOTION_CONTINUOUS_AFTER_MS = 5_000;
/** A load phase observes until this page-clock time, so motion repeating up to about every four seconds is seen past the threshold. */
export const MOTION_LOAD_WINDOW_MS = 9_000;
/** After an action (a live preference switch, a pause activation), transitions get this long to settle before movement counts. */
export const MOTION_GRACE_MS = 1_000;
/** Shortest after-action window; a page whose motion recurs less often is watched longer (see afterActionWindowMs). */
export const MOTION_ACTION_WINDOW_MS = 5_500;
export const MOTION_SAMPLE_INTERVAL_MS = 400;
/** Longest after-action window; motion that recurs less often than this cannot be proven stopped. */
export const MOTION_AFTER_MAX_MS = 20_000;
/** Pause/stop/hide controls activated per probe, in rank order; each at most once. */
export const MAX_PAUSE_ACTIVATIONS = 5;

/** Whether a window saw anything still moving after its threshold: changed boxes, running animations or changed pixels. */
export const observedMovement = (observation: MotionObservation) => observation.movingAfter.length > 0 || observation.animationsAfter.length > 0 || observation.pixelsChangedAfter === true;

function longestGap(fromMs: number, movementMs: number[]): number {
  const times = [fromMs, ...movementMs.filter(time => time >= fromMs)].sort((a, b) => a - b);
  let longest = 0;
  for (let index = 1; index < times.length; index++) longest = Math.max(longest, times[index]! - times[index - 1]!);
  return longest;
}

/**
 * The longest stretch, counted from the window's first sample, in which one
 * moving subject did not move. Per subject (NB1): a busy progress bar must
 * not hide a carousel that moves only every few seconds. Observations
 * without subjects fall back to the pooled movement times.
 */
export function longestQuietMs(observation: MotionObservation): number {
  const subjects = observation.subjects ?? [];
  if (!subjects.length) return longestGap(observation.fromMs, observation.movementMs);
  return Math.max(0, ...subjects.map(subject => longestGap(observation.fromMs, subject.movementMs)));
}

/** A timer firing counts as having moved the page when movement was seen within this long after it. */
export const TIMER_LINK_MS = 1_000;

/**
 * How many firings of a timer it took, at most, before movement followed one
 * (within TIMER_LINK_MS), in the earlier windows; 0 when movement never
 * followed a firing there. bg-interval acts on every fourth firing: 4.
 */
export function firingsPerMovement(fires: number[], befores: MotionObservation[]): number {
  let most = 0;
  for (const before of befores) {
    let count = 0;
    for (const fire of fires.filter(time => time >= before.fromMs && time <= before.toMs).sort((a, b) => a - b)) {
      count++;
      if (before.movementMs.some(time => time > fire && time <= fire + TIMER_LINK_MS)) { most = Math.max(most, count); count = 0; }
    }
  }
  return most;
}

/**
 * NW1 / round 4: which live timers keep a still window from proving the
 * motion stopped. A timer that moved the page after N firings in an earlier
 * window of the same document is harmless only once it has fired at least N
 * times during the watch with nothing moving. A timer that fired before
 * without movement following is harmless; one never seen firing is harmless
 * only after it fires during the watch (unsure otherwise, the safe side).
 */
export function liveTimerConcerns(observation: MotionObservation, befores: MotionObservation[]): EvidenceText[] {
  const concerns: EvidenceText[] = [];
  for (const timer of observation.timers ?? []) {
    const firedHere = timer.fires.filter(fire => fire >= observation.continuousFromMs && fire <= observation.toMs).length;
    const needed = firingsPerMovement(timer.fires, befores);
    const seenBefore = timer.fires.some(fire => befores.some(before => fire >= before.fromMs && fire <= before.toMs));
    const label = timer.kind === 'interval' ? ev('motion.timer.interval') : timer.nextDueMs !== null ? ev('motion.timer.timeoutDue', num(timer.nextDueMs / 1000, 1)) : ev('motion.timer.timeout');
    if (needed > 0) {
      if (firedHere < needed) concerns.push(ev('motion.timer.linked', label, needed, firedHere));
    } else if (!seenBefore && firedHere === 0) concerns.push(ev('motion.timer.unknown', label));
  }
  return concerns.slice(0, 3);
}

/**
 * Invariant: stillness after an action proves the motion stopped only when
 * the watch (past the grace period) is longer than every quiet stretch seen
 * while the content was moving, plus two samples of slack.
 */
export const stillProofMs = (...moving: MotionObservation[]) => Math.max(0, ...moving.map(longestQuietMs)) + 2 * MOTION_SAMPLE_INTERVAL_MS;

/** How long the worker watches after an action so that stillProofMs can be met, within the bounds. */
export const afterActionWindowMs = (proofMs: number) => Math.min(MOTION_AFTER_MAX_MS, Math.max(MOTION_ACTION_WINDOW_MS, MOTION_GRACE_MS + proofMs + MOTION_SAMPLE_INTERVAL_MS));

/** The first time movement was seen at or after the window's threshold; null when none was. */
export const firstMovementAfter = (observation: MotionObservation) => observation.movementMs.filter(time => time >= observation.continuousFromMs).sort((a, b) => a - b)[0] ?? null;
