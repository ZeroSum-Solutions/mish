import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderReviewEvidenceText, reviewBundleCurrencyProblems, parseProjectRubric, parseVerificationBundle, WORKBENCH_MANDATORY_CRITERION_IDS, type ProjectRubric } from '@open-design/contracts';
import { registerWorkbenchReviewRoutes } from '../../src/routes/workbench-review.js';
import { runReviewCli } from '../../src/workbench/review-cli.js';
import { PAUSE_CONTROL_NAME } from '../../src/workbench/review/page-scripts.js';
import { planReview } from '../../src/workbench/review/plan.js';
import { egressDigest, type EgressSummary } from '../../src/workbench/review/egress.js';
import { ev, evidenceSelector, evidenceString, PageText, vocab } from '../../src/workbench/review/evidence.js';
import { createReviewEvidenceStore } from '../../src/workbench/review/evidence-store.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { createWorkbenchReviewService } from '../../src/workbench/review/service.js';
import type { CaptureRequest, MotionCapture, MotionObservation, MotionPhase, PauseAttempt } from '../../src/workbench/review/types.js';
import { knownGoodCapture, portFrom } from './review-capture-fixture.js';

// AC-R06 preamble (B4-2b): motion checks are opt-in. A rubric that declares
// one makes the worker sample motion; nothing else changes for rubrics that
// do not. Missing motion evidence is inconclusive, never a pass.

const pt = (value: string) => PageText.of(value);
const textOf = (value: Parameters<typeof renderReviewEvidenceText>[0]) => renderReviewEvidenceText(value, 'en');
const base = { projectId: 'p', entry: 'index.html', context: null, clock: () => new Date('2026-10-08T08:00:00.000Z'), newId: () => 'rv_motion' } as const;
const provenance = { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' } as const;

function motionRubric(parameters: Record<string, unknown> = {}, required = true): ProjectRubric {
  return parseProjectRubric({
    schema: 'workbench-rubric/1', projectId: 'p', revision: 4, updatedAt: '2026-10-08T07:00:00.000Z', contextRevision: 1,
    checks: [{
      checkId: 'carousel-motion', kind: 'mechanical', required, severity: required ? 'high' : 'medium',
      requiredBasis: required ? { type: 'project-acceptance', requirementId: 'motion-policy', rationale: 'Moving content must be controllable' } : null,
      provenance, parameters: { type: 'motion', ...parameters }, evidenceTypes: ['probe'], sourceCriteria: [],
    }],
  });
}

const still = (overrides: Partial<MotionObservation> = {}): MotionPhase => ({ observation: { continuousFromMs: 5000, fromMs: 600, toMs: 9000, samples: 20, samplesAfter: 10, movingAfter: [], animationsAfter: [], pixelsChangedAfter: false, movementMs: [], unmeasured: [], subjects: [], timers: [], ...overrides } });
/** Moves on every sample (an infinite animation): its longest quiet stretch is one sample interval. */
const everySample = Array.from({ length: 21 }, (_, index) => 600 + index * 400);
const moving = (overrides: Partial<MotionObservation> = {}): MotionPhase => still({ movingAfter: [pt('#carousel > .track')], animationsAfter: [{ selector: pt('#carousel > .track'), name: pt('transform'), iterations: 1 }], pixelsChangedAfter: true, movementMs: everySample, ...overrides });
const pauseButton = { selector: pt('#pause'), name: pt('Pause carousel'), reachedByKeyboard: true, activatable: true };
const attempt = (after: MotionPhase, extra: Partial<PauseAttempt> = {}): PauseAttempt => ({ selector: pt('#pause'), name: pt('Pause carousel'), blockedDuring: 0, windowOpensDuring: 0, after, ...extra });
const movingBefore = moving({ continuousFromMs: 700, fromMs: 700, toMs: 1100, samples: 2, samplesAfter: 2, movementMs: [1100] });

/** The auto-carousel fixture's shape: it moves, has no pause control and ignores reduced motion live or on load. */
const carouselWithoutControls = (): MotionCapture => ({
  noPreference: moving(), liveChange: moving({ continuousFromMs: 10_000, fromMs: 9000, toMs: 14_500 }), reduced: moving(),
  pause: { controls: [], tabStops: 3, walkComplete: true, before: null, attempts: [] },
});
/** The reduced-motion-static fixture's shape: it moves, its pause button stops it, and reduced motion is static. */
const carouselWithFallback = (): MotionCapture => ({
  noPreference: moving(), liveChange: still({ continuousFromMs: 10_000, fromMs: 9000, toMs: 14_500 }), reduced: still(),
  pause: { controls: [pauseButton], tabStops: 4, walkComplete: true, before: movingBefore, attempts: [attempt(still({ continuousFromMs: 2100, fromMs: 1100, toMs: 6600 }))] },
});
/** A carousel that advances every 7.5 s: base movement only at 7.6–8.4 s, so its longest quiet stretch is 7 s. */
const slowBase = (): MotionPhase => moving({ fromMs: 600, movementMs: [7600, 8000, 8400], movingAfter: [pt('#track')], animationsAfter: [{ selector: pt('#track'), name: pt('transform'), iterations: 1 }] });

const withMotion = (motion: (width: number) => MotionCapture | undefined) => portFrom((width, request) => knownGoodCapture(width, capture => {
  if (request.motion) { const value = motion(width); if (value) capture.motion = value; }
}));

async function review(rubric: ProjectRubric | null, motion: (width: number) => MotionCapture | undefined, requests: CaptureRequest[] = []) {
  const port = withMotion(motion);
  const recording = { ...port, async open() { const session = await port.open(); return { ...session, capture(request: CaptureRequest) { requests.push(request); return session.capture(request); } }; } };
  return parseVerificationBundle(await runMechanicalReview({ ...base, rubric, port: recording }));
}
const motionResult = (bundle: Awaited<ReturnType<typeof review>>) => bundle.results.find(result => result.checkId === 'carousel-motion')!;

describe('motion check planning (opt-in)', () => {
  it('plans a motion check only when the rubric declares one, next to the six synthesized mandatory checks', () => {
    const plan = planReview(motionRubric({ requireLivePreferenceChange: false }), null);
    const motion = plan.checks.find(check => check.checkId === 'carousel-motion')!;
    expect(motion).toMatchObject({ criterionId: null, synthesized: false, required: true, targets: null, viewports: [375, 1440] });
    expect(motion.parameters).toEqual({ type: 'motion', requirePauseControl: true, requireReducedMotionFallback: true, requireLivePreferenceChange: false });
    expect(plan.checks.filter(check => check.synthesized).map(check => check.criterionId)).toEqual([...WORKBENCH_MANDATORY_CRITERION_IDS]);
    expect(planReview(null, null).checks.some(check => check.parameters.type === 'motion')).toBe(false);
  });

  it('asks the worker for motion phases only when a motion check covers the width, with the union of its requirements', async () => {
    const withCheck: CaptureRequest[] = [];
    await review(motionRubric({ requireLivePreferenceChange: false, viewports: [320, 375, 768, 1440, 1920] }), () => carouselWithFallback(), withCheck);
    expect(withCheck.map(request => [request.width, request.motion])).toEqual([320, 375, 768, 1440, 1920].map(width => [width, { pauseControl: true, reducedFallback: true, liveChange: false }]));
    const byDefault: CaptureRequest[] = [];
    const bundle = await review(motionRubric(), () => carouselWithFallback(), byDefault);
    expect(byDefault.map(request => [request.width, request.motion !== undefined])).toEqual([[320, false], [375, true], [768, false], [1440, true]]);
    expect(bundle.viewports).toEqual([320, 375, 768, 1440]);
    expect(bundle.evidence.filter(item => item.id.startsWith('carousel-motion@')).map(item => item.viewport)).toEqual([375, 1440]);
    const without: CaptureRequest[] = [];
    await review(null, () => carouselWithFallback(), without);
    expect(without.every(request => request.motion === undefined)).toBe(true);
  });
});

describe('pause control names', () => {
  it('match pause, stop and hide controls in the shipped locales, as whole words', () => {
    const pattern = new RegExp(PAUSE_CONTROL_NAME, 'iu');
    for (const name of ['Pause carousel', 'Stop animation', 'Hide banner', 'Pausar carrusel', 'Detener', 'Ocultar anuncio']) expect(pattern.test(name), name).toBe(true);
    for (const name of ['Play carousel', 'Stopwatch', 'Book now', 'Shide', '']) expect(pattern.test(name), name).toBe(false);
  });
});

describe('motion check evaluation', () => {
  it('fails an auto carousel without a pause control that ignores reduced motion, naming each failure', async () => {
    const bundle = await review(motionRubric(), () => carouselWithoutControls());
    const result = motionResult(bundle);
    expect(result).toMatchObject({ parameterType: 'motion', criterionId: null, outcome: 'fail' });
    const observations = bundle.evidence.filter(item => result.evidenceIds.includes(item.id)).flatMap(item => item.observations.map(textOf)).join('\n');
    expect(observations).toMatch(/pause, stop or hide/);
    expect(observations).toMatch(/prefers-reduced-motion: reduce/);
    expect(observations).toMatch(/switched to reduce/);
    expect(bundle.outcome).toBe('failed');
    expect(bundle.evidence.find(item => item.id === 'carousel-motion@375')?.type).toBe('probe');
    // Motion reasons and observations are structured evidence/2 messages: the bundle is current, with no free text.
    expect(reviewBundleCurrencyProblems(bundle, { rubricKeys: new Set() })).toEqual([]);
    expect(typeof motionResult(bundle).reason).toBe('object');
  });

  it('passes moving content with a working keyboard pause control and a static reduced-motion fallback', async () => {
    const bundle = await review(motionRubric(), () => carouselWithFallback());
    expect(motionResult(bundle).outcome).toBe('pass');
    expect(bundle.outcome).toBe('passed');
  });

  it('is not applicable when nothing keeps moving past five seconds, and later phases are not needed', async () => {
    const bundle = await review(motionRubric(), () => ({ noPreference: still(), liveChange: null, reduced: null, pause: null }));
    expect(motionResult(bundle).outcome).toBe('not-applicable');
    expect(bundle.outcome).toBe('passed');
  });

  it.each<[string, () => MotionCapture | undefined]>([
    ['the worker returned no motion evidence', () => undefined],
    ['the no-preference phase failed', () => ({ ...carouselWithFallback(), noPreference: { error: ev('capture.leftBeforeLoad') } })],
    ['too few samples after five seconds', () => ({ noPreference: still({ samplesAfter: 1 }), liveChange: null, reduced: null, pause: null })],
    ['the viewport could not be compared, so canvas or image motion is unmeasured', () => ({ noPreference: still({ pixelsChangedAfter: null }), liveChange: null, reduced: null, pause: null })],
    ['a required phase did not run', () => ({ ...carouselWithFallback(), reduced: null })],
    ['the reduced phase lacks pixel evidence for its static claim', () => ({ ...carouselWithFallback(), reduced: still({ pixelsChangedAfter: null }) })],
    ['the pause probe errored', () => ({ ...carouselWithFallback(), pause: { error: ev('motion.budgetSpent') } })],
  ])('is inconclusive, never a pass, when %s', async (_name, motion) => {
    const bundle = await review(motionRubric(), motion);
    expect(motionResult(bundle).outcome).toBe('inconclusive');
    expect(bundle.outcome).toBe('inconclusive');
  });

  it('fails a pause control that keyboard users cannot reach, and one that does not stop the motion', async () => {
    const unreachable = await review(motionRubric(), () => ({ ...carouselWithFallback(), pause: { controls: [{ ...pauseButton, reachedByKeyboard: false }], tabStops: 2, walkComplete: true, before: null, attempts: [] } }));
    expect(motionResult(unreachable).outcome).toBe('fail');
    expect(textOf(motionResult(unreachable).reason)).toMatch(/not reachable by keyboard/);
    const ineffective = await review(motionRubric(), () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton], tabStops: 4, walkComplete: true, before: movingBefore, attempts: [attempt(moving())] } }));
    expect(motionResult(ineffective).outcome).toBe('fail');
    expect(textOf(motionResult(ineffective).reason)).toMatch(/kept moving after/);
  });

  it('names the sampled width, the observation window and viewport-only pixel coverage in a not-applicable finding', async () => {
    const bundle = await review(motionRubric(), () => ({ noPreference: still(), liveChange: null, reduced: null, pause: null }));
    const result = motionResult(bundle);
    expect(textOf(result.reason)).toMatch(/^375px: .*1440px: /);
    const findings = bundle.evidence.filter(item => result.evidenceIds.includes(item.id)).flatMap(item => item.observations.map(textOf)).join('\n');
    expect(findings).toMatch(/at 375px/);
    expect(findings).toMatch(/0\.6 s–9\.0 s after load/);
    expect(findings).toMatch(/pixels were compared for the visible 375×740 viewport only/);
  });
});

describe('motion evidence the sampler cannot fully see (B2)', () => {
  it.each([
    ['an off-screen canvas', ev('motion.unmeasured.offscreen', vocab('tag', 'canvas'), evidenceSelector(pt('body > main > canvas')))],
    ['an animation-frame loop', ev('motion.unmeasured.raf')],
    ['a Web Worker', ev('motion.unmeasured.workers', 1)],
  ] as const)('is inconclusive, not not-applicable, with %s', async (_name, unmeasured) => {
    const bundle = await review(motionRubric(), () => ({ noPreference: still({ unmeasured: [unmeasured] }), liveChange: null, reduced: null, pause: null }));
    expect(motionResult(bundle).outcome).toBe('inconclusive');
    expect(textOf(motionResult(bundle).reason)).toContain(evidenceString(unmeasured));
  });

  it('does not accept a still reduced-motion load that has unmeasured sources or ends before the base movement recurred', async () => {
    const unmeasured = await review(motionRubric(), () => ({ ...carouselWithFallback(), reduced: still({ unmeasured: [ev('motion.unmeasured.raf')] }) }));
    expect(motionResult(unmeasured).outcome).toBe('inconclusive');
    const short = await review(motionRubric({ requirePauseControl: false, requireLivePreferenceChange: false }), () => ({ ...carouselWithFallback(), noPreference: slowBase(), reduced: still({ toMs: 7000 }) }));
    expect(motionResult(short).outcome).toBe('inconclusive');
    expect(textOf(motionResult(short).reason)).toMatch(/7\.6 s/);
  });
});

describe('motion evidence never persists page text raw (batch-4 page-text and selector rules)', () => {
  it('replaces control names and animation names with page-text tokens and re-validates every motion selector', async () => {
    const secretSelector = '#sk_live_abcdefghijklmnopqrstuv';
    const tampered = '#pause"><img src=x onerror=alert(1)>';
    const secretName = 'Pause sk_live_abcdefghijklmnopqrstuv';
    const base = moving({ movingAfter: [pt(secretSelector)], animationsAfter: [{ selector: pt(tampered), name: pt('token-SECRET-anim'), iterations: null }], subjects: [{ key: secretSelector, movementMs: everySample }, { key: 'viewport pixels', movementMs: everySample }], timers: [{ key: 'interval:<script>', kind: 'interval', fires: [6000], nextDueMs: null }] });
    const control = { selector: pt(secretSelector), name: pt(secretName), reachedByKeyboard: true, activatable: true };
    const bundle = await review(motionRubric(), () => ({ ...carouselWithFallback(), noPreference: base, pause: { controls: [control, { ...control, selector: pt('#hide'), name: pt('Hide secret-banner-text'), reachedByKeyboard: false, activatable: false }], tabStops: 3, walkComplete: true, before: movingBefore, attempts: [attempt(moving(), { selector: pt(secretSelector), name: pt(secretName) })] } }));
    const persisted = JSON.stringify(bundle);
    for (const raw of ['sk_live_abcdefghijklmnopqrstuv', 'onerror', 'token-SECRET-anim', 'secret-banner-text', '<script>']) expect(persisted, raw).not.toContain(raw);
    expect(persisted).toContain('"kind":"token"');
    expect(motionResult(bundle).outcome).toBe('fail');
  });
});

describe('pixel-only changes (rounds 4 and 5)', () => {
  const pauseOnly = () => motionRubric({ requireReducedMotionFallback: false, requireLivePreferenceChange: false });
  /** A window where only viewport tiles changed, at the given times; `pixelChangesAfter` is what the round-4 worker reported. */
  const tilesChanged = (window: Partial<MotionObservation>, changes: [string, number][]): MotionPhase => {
    const phase = still({ ...window, pixelsChangedAfter: true, subjects: changes.map(([key, time]) => ({ key, movementMs: [time] })), movementMs: changes.map(([, time]) => time) });
    Object.assign((phase as { observation: MotionObservation }).observation, { pixelChangesAfter: new Set(changes.map(([, time]) => time)).size });
    return phase;
  };
  const afterPress = (changes: [string, number][]) => tilesChanged({ continuousFromMs: 2100, fromMs: 1100, toMs: 6600 }, changes);
  const pressed = (after: MotionPhase): MotionCapture['pause'] => ({ controls: [pauseButton], tabStops: 2, walkComplete: true, before: movingBefore, attempts: [attempt(after)] });
  /** The no-preference load: a carousel whose tile r1c1 changed while it moved. */
  const baseWithTile = () => moving({ subjects: [{ key: '#carousel > .track', movementMs: everySample }, { key: 'viewport tile r1c1', movementMs: everySample }] });

  it('treats one new-tile repaint right after the press (grace plus one sample) as open, never as moving or still', async () => {
    const once = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: baseWithTile(), pause: pressed(afterPress([['viewport tile r6c6', 2300]])) }));
    expect(motionResult(once).outcome).toBe('inconclusive');
    expect(textOf(motionResult(once).reason)).toMatch(/changed once .* without any element moving/);
  });

  it('counts a single pixel-only change later in the watch as motion', async () => {
    const late = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: baseWithTile(), pause: pressed(afterPress([['viewport tile r6c6', 4100]])) }));
    expect(motionResult(late).outcome).toBe('fail');
  });

  it('counts a single repaint in a tile that also changed in the no-preference load as motion (tile-mask)', async () => {
    const recurring = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: baseWithTile(), pause: pressed(afterPress([['viewport tile r1c1', 2300]])) }));
    expect(motionResult(recurring).outcome).toBe('fail');
  });

  it('never applies the repaint allowance to a load window: one pixel-only change after 5 s is motion (img-swap)', async () => {
    const imgSwap = await review(motionRubric(), () => ({ noPreference: tilesChanged({}, [['viewport tile r3c2', 6000], ['viewport pixels', 6000]]), liveChange: null, reduced: null, pause: { controls: [], tabStops: 0, walkComplete: true, before: null, attempts: [] } }));
    expect(motionResult(imgSwap).outcome).toBe('fail');
  });

  it('fails when the pixels keep changing after the press, even with no element moving (canvas, video)', async () => {
    const repeated = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: baseWithTile(), pause: pressed(afterPress([['viewport tile r6c6', 2300], ['viewport tile r6c6', 3100], ['viewport tile r6c6', 3900]])) }));
    expect(motionResult(repeated).outcome).toBe('fail');
  });
});

describe('per-subject intervals and live timers (re-verify NB1, NW1)', () => {
  const pauseOnly = () => motionRubric({ requireReducedMotionFallback: false, requireLivePreferenceChange: false });
  const liveOnly = () => motionRubric({ requireReducedMotionFallback: false, requirePauseControl: false });
  /** A progress bar moving on every sample plus a carousel that moves only at 7.6–8.4 s: pooled, the page never looks quiet. */
  const barAndSlowCarousel = (): MotionPhase => moving({ subjects: [{ key: '#bar', movementMs: everySample }, { key: '#track', movementMs: [7600, 8000, 8400] }] });
  const pressedAt = (after: MotionPhase): MotionCapture['pause'] => ({ controls: [pauseButton], tabStops: 2, walkComplete: true, before: movingBefore, attempts: [attempt(after)] });

  it('requires the after-press watch to cover the slowest moving subject, not the pooled movement', async () => {
    const short = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: barAndSlowCarousel(), pause: pressedAt(still({ continuousFromMs: 2100, fromMs: 1100, toMs: 6600 })) }));
    expect(motionResult(short).outcome).toBe('inconclusive');
    expect(textOf(motionResult(short).reason)).toMatch(/quiet stretches of up to 7\.0 s/);
    const covered = await review(pauseOnly(), () => ({ ...carouselWithFallback(), noPreference: barAndSlowCarousel(), pause: pressedAt(still({ continuousFromMs: 2100, fromMs: 1100, toMs: 10_500 })) }));
    expect(motionResult(covered).outcome).toBe('pass');
  });

  it('applies the per-subject interval to the live switch too', async () => {
    const bundle = await review(liveOnly(), () => ({ ...carouselWithFallback(), noPreference: barAndSlowCarousel(), liveChange: still({ continuousFromMs: 10_100, fromMs: 9100, toMs: 14_600 }) }));
    expect(motionResult(bundle).outcome).toBe('inconclusive');
  });

  it('accepts stillness with a live timer that fired during the watch while nothing moved (a paused flag, a heartbeat)', async () => {
    const heartbeat = { key: 'interval:1', kind: 'interval' as const, fires: [3000, 4000, 5000, 6000], nextDueMs: null };
    const bundle = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: pressedAt(still({ continuousFromMs: 2100, fromMs: 1100, toMs: 6600, timers: [heartbeat] })) }));
    expect(motionResult(bundle).outcome).toBe('pass');
    const na = await review(motionRubric(), () => ({ noPreference: still({ timers: [{ ...heartbeat, fires: [1000, 2000, 6000, 8000] }] }), liveChange: null, reduced: null, pause: null }));
    expect(motionResult(na).outcome).toBe('not-applicable');
  });

  it('needs a timer that moved the page after N firings to fire at least N times during the watch before it counts as harmless', async () => {
    // Base window: the interval fires at 2, 4, 6 and 8 s and the hero moves only after the fourth firing (bg-interval).
    const everyFourth = { key: 'interval:3', kind: 'interval' as const, fires: [2000, 4000, 6000, 8000], nextDueMs: null };
    const base = moving({ movementMs: [600, 8400], subjects: [{ key: '#hero', movementMs: [8400] }] });
    const watch = (fires: number[]) => still({ continuousFromMs: 10_100, fromMs: 9100, toMs: 19_000, timers: [{ ...everyFourth, fires: [...everyFourth.fires, ...fires] }] });
    const live = () => motionRubric({ requireReducedMotionFallback: false, requirePauseControl: false });
    const twice = await review(live(), () => ({ ...carouselWithFallback(), noPreference: base, liveChange: watch([10_200, 12_200]) }));
    expect(motionResult(twice).outcome).toBe('inconclusive');
    expect(textOf(motionResult(twice).reason)).toMatch(/after 4 firing\(s\) .* fired 2 time\(s\) during the watch/);
    const fourTimes = await review(live(), () => ({ ...carouselWithFallback(), noPreference: base, liveChange: watch([10_200, 12_200, 14_200, 16_200]) }));
    expect(motionResult(fourTimes).outcome).toBe('pass');
  });

  it('does not accept stillness while a timer is live that never fired (unsure) or that moved things before and did not fire during the watch', async () => {
    const pending = { key: 'timeout:1', kind: 'timeout' as const, fires: [], nextDueMs: 10_000 };
    const late = await review(motionRubric(), () => ({ noPreference: still({ timers: [pending] }), liveChange: null, reduced: null, pause: null }));
    expect(motionResult(late).outcome).toBe('inconclusive');
    expect(textOf(motionResult(late).reason)).toMatch(/timer .* has not fired/);
    // Fired at 3.0 s in the base window and the carousel moved 0.4 s later; it has not fired since the live switch.
    const linked = { key: 'interval:2', kind: 'interval' as const, fires: [3000], nextDueMs: null };
    const live = await review(liveOnly(), () => ({ ...carouselWithFallback(), noPreference: moving({ movementMs: [600, 3400, 3800], subjects: [{ key: '#track', movementMs: [3400, 3800] }] }), liveChange: still({ continuousFromMs: 10_100, fromMs: 9100, toMs: 18_600, timers: [linked] }) }));
    expect(motionResult(live).outcome).toBe('inconclusive');
    expect(textOf(motionResult(live).reason)).toMatch(/moved the page before/);
  });
});

describe('after-action windows cover the observed movement interval (B1)', () => {
  it('does not accept stillness after a live switch shorter than the page\'s longest quiet stretch', async () => {
    const short = await review(motionRubric({ requirePauseControl: false, requireReducedMotionFallback: false }), () => ({ ...carouselWithFallback(), noPreference: slowBase(), liveChange: still({ continuousFromMs: 10_100, fromMs: 9100, toMs: 14_600 }) }));
    expect(motionResult(short).outcome).toBe('inconclusive');
    expect(textOf(motionResult(short).reason)).toMatch(/moved after quiet stretches of up to 7\.0 s/);
    const covered = await review(motionRubric({ requirePauseControl: false, requireReducedMotionFallback: false }), () => ({ ...carouselWithFallback(), noPreference: slowBase(), liveChange: still({ continuousFromMs: 10_100, fromMs: 9100, toMs: 18_600 }) }));
    expect(motionResult(covered).outcome).toBe('pass');
  });

  it('does not accept stillness after a pause activation shorter than the interval, and needs movement before activation', async () => {
    const pauseOnly = motionRubric({ requireReducedMotionFallback: false, requireLivePreferenceChange: false });
    const short = await review(pauseOnly, () => ({ ...carouselWithFallback(), noPreference: slowBase(), pause: { controls: [pauseButton], tabStops: 2, walkComplete: true, before: movingBefore, attempts: [attempt(still({ continuousFromMs: 9000, fromMs: 8000, toMs: 13_500 }))] } }));
    expect(motionResult(short).outcome).toBe('inconclusive');
    const covered = await review(pauseOnly, () => ({ ...carouselWithFallback(), noPreference: slowBase(), pause: { controls: [pauseButton], tabStops: 2, walkComplete: true, before: movingBefore, attempts: [attempt(still({ continuousFromMs: 9000, fromMs: 8000, toMs: 17_500 }))] } }));
    expect(motionResult(covered).outcome).toBe('pass');
    const notSeenBefore = await review(pauseOnly, () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton], tabStops: 2, walkComplete: true, before: still({ continuousFromMs: 700, fromMs: 700, toMs: 9000 }), attempts: [] } }));
    expect(motionResult(notSeenBefore).outcome).toBe('inconclusive');
    expect(textOf(motionResult(notSeenBefore).reason)).toMatch(/did not move again before/);
  });

  it('does not accept stillness when requests were refused or windows opened after the activation', async () => {
    for (const extra of [{ blockedDuring: 2 }, { windowOpensDuring: 1 }]) {
      const bundle = await review(motionRubric(), () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton], tabStops: 2, walkComplete: true, before: movingBefore, attempts: [attempt(still({ continuousFromMs: 2100, fromMs: 1100, toMs: 6600 }), extra)] } }));
      expect(motionResult(bundle).outcome, JSON.stringify(extra)).toBe('inconclusive');
      expect(textOf(motionResult(bundle).reason)).toMatch(/refused|new window/);
    }
  });
});

describe('pause-control walk and activation (W1, W2, W4)', () => {
  const pauseOnly = () => motionRubric({ requireReducedMotionFallback: false, requireLivePreferenceChange: false });

  it('reports a Tab walk cut short by its cap or deadline as inconclusive, never a failure', async () => {
    const cut = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [], tabStops: 80, walkComplete: false, before: null, attempts: [] } }));
    expect(motionResult(cut).outcome).toBe('inconclusive');
    expect(textOf(motionResult(cut).reason)).toMatch(/Tab walk stopped after 80 stops/);
    const unreached = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [{ ...pauseButton, reachedByKeyboard: false }], tabStops: 80, walkComplete: false, before: null, attempts: [] } }));
    expect(motionResult(unreached).outcome).toBe('inconclusive');
  });

  it('is inconclusive when the only named controls reached are not button-like (never activated)', async () => {
    const bundle = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [{ selector: pt('input#e'), name: pt('Stop emails for address'), reachedByKeyboard: true, activatable: false }], tabStops: 2, walkComplete: true, before: null, attempts: [] } }));
    expect(motionResult(bundle).outcome).toBe('inconclusive');
    expect(textOf(motionResult(bundle).reason)).toMatch(/not a button-like control/);
  });

  it('passes when a later-ranked control stops the motion, and stays open when ranked controls were left untried', async () => {
    const hide = { selector: pt('#hide'), name: pt('Hide banner'), reachedByKeyboard: true, activatable: true };
    const second = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton, hide], tabStops: 3, walkComplete: true, before: movingBefore, attempts: [attempt(moving()), attempt(still({ continuousFromMs: 9000, fromMs: 8000, toMs: 13_500 }), { selector: pt('#hide'), name: pt('Hide banner') })] } }));
    expect(motionResult(second).outcome).toBe('pass');
    const untried = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton, hide], tabStops: 3, walkComplete: true, before: movingBefore, attempts: [attempt(moving())] } }));
    expect(motionResult(untried).outcome).toBe('inconclusive');
    const allTried = await review(pauseOnly(), () => ({ ...carouselWithFallback(), pause: { controls: [pauseButton, hide], tabStops: 3, walkComplete: true, before: movingBefore, attempts: [attempt(moving()), attempt(moving(), { selector: pt('#hide'), name: pt('Hide banner') })] } }));
    expect(motionResult(allTried).outcome).toBe('fail');
  });

  it('judges only the enabled requirements', async () => {
    const bundle = await review(motionRubric({ requirePauseControl: false, requireLivePreferenceChange: false }), () => ({ ...carouselWithoutControls(), reduced: still(), liveChange: null, pause: null }));
    expect(motionResult(bundle).outcome).toBe('pass');
  });

  it('keeps an optional failing motion check from failing the review', async () => {
    const bundle = await review(motionRubric({}, false), () => carouselWithoutControls());
    expect(motionResult(bundle)).toMatchObject({ required: false, outcome: 'fail' });
    expect(bundle.outcome).toBe('passed');
  });
});

describe('motion egress evidence (allowed-host requests during motion reloads)', () => {
  const limits = { maxRequests: 200, maxBytes: 20 * 1024 * 1024, maxResponseBytes: 5 * 1024 * 1024, requestTimeoutMs: 10_000, maxRedirects: 3 };
  const record = (sha: string): EgressSummary['fetches'][number] => ({ origin: 'https://cdn.example.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: 'e'.repeat(64), queryLength: 3, host: 'cdn.example.com', resourceType: 'Script', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 120, sha256: sha.repeat(64), durationMs: 9, redirects: [] });
  const summary = (fetches: EgressSummary['fetches'], exhausted: EgressSummary['exhausted'] = null): EgressSummary => ({ allowHosts: ['cdn.example.com'], limits, fetches, requests: fetches.length, bytes: 120 * fetches.length, exhausted });
  const egress = { allowHosts: ['cdn.example.com'] };
  function portWith(main: EgressSummary, motion: EgressSummary) {
    const port = withMotion(() => carouselWithFallback());
    return { ...port, async open() { const session = await port.open(); return { ...session, egress: () => main, motionEgress: () => motion }; } };
  }

  it('records motion fetches in their own digested section, without spending or blocking the run', async () => {
    // Different bytes for one URL and an exhausted budget would block the run if they were main egress.
    const motion = summary([record('a'), record('b')], ev('egress.requestLimit', 200));
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, rubric: motionRubric(), egress, port: portWith(summary([]), motion) }));
    expect(bundle.outcome).toBe('passed');
    expect(bundle.egress?.fetches).toEqual([]);
    expect(bundle.motionEgress).toMatchObject({ allowHosts: ['cdn.example.com'], fetches: motion.fetches, requests: 2, exhausted: motion.exhausted });
    const motionEgress = bundle.motionEgress as Extract<NonNullable<typeof bundle.motionEgress>, { schema: 'workbench-review-egress/4' }>;
    expect(motionEgress.schema).toBe('workbench-review-egress/4');
    expect(motionEgress.digest).toBe(egressDigest(motionEgress));
    expect(motionEgress.fetches.every(fetch => !('url' in fetch) && !('path' in fetch) && /^https:\/\/[^/?#@]+$/u.test(fetch.origin))).toBe(true);
    const motionResult = bundle.results.find(result => result.checkId === 'carousel-motion')!;
    expect(motionResult.evidenceIds).toContain('motion-egress');
    expect(bundle.evidence.find(item => item.id === 'motion-egress')?.observations.map(textOf).join('\n')).toMatch(/cdn\.example\.com/);
  });

  it('is absent when the rubric declares no motion check', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, rubric: null, egress, port: portWith(summary([]), summary([record('a')])) }));
    expect(bundle).not.toHaveProperty('motionEgress');
  });

  it('is frozen: the evidence store refuses a motion egress record edited after the run', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'od-review-motion-egress-'));
    try {
      const store = createReviewEvidenceStore(data);
      const bundle = await runMechanicalReview({ ...base, rubric: motionRubric(), egress, port: portWith(summary([]), summary([record('a')])) });
      await store.save(bundle);
      expect(await store.read('p', bundle.id)).toEqual(bundle);
      const file = path.join(data, 'workbench-review', 'projects', createHash('sha256').update('p', 'utf8').digest('hex').slice(0, 32), `${bundle.id}.json`);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      stored.motionEgress.fetches[0].status = 404;
      await writeFile(file, JSON.stringify(stored));
      await expect(store.read('p', bundle.id)).rejects.toThrow();
    } finally { await rm(data, { recursive: true, force: true }); }
  });
});

describe('motion checks over HTTP and the od CLI', () => {
  let server: Server | undefined; const dirs: string[] = [];
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function boot(rubric: ProjectRubric | null) {
    const data = await mkdtemp(path.join(tmpdir(), 'od-review-motion-')); dirs.push(data);
    const requests: CaptureRequest[] = [];
    const port = withMotion(() => carouselWithoutControls());
    const app = express(); app.use(express.json());
    registerWorkbenchReviewRoutes(app, {
      http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) },
      authorizeProjectRequest: async () => true,
      assertProject: () => undefined,
      review: createWorkbenchReviewService({
        dataDir: data, projectInputs: () => ({ root: path.join(data, 'project-root'), context: null, rubric }),
        createPort: () => ({ ...port, async open() { const session = await port.open(); return { ...session, capture(request: CaptureRequest) { requests.push(request); return session.capture(request); } }; } }),
      }),
    });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const output: unknown[] = [];
    return { url, data, requests, output, cli: (args: string[]) => runReviewCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value) }) };
  }

  it('honours a rubric motion check through both surfaces with the same result and no new flag', async () => {
    const { url, requests, output, cli } = await boot(motionRubric());
    const response = await fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: 'index.html' }) });
    const http = parseVerificationBundle(await response.json());
    expect(requests.map(request => [request.width, request.motion ?? null])).toEqual([[320, null], [375, { pauseControl: true, reducedFallback: true, liveChange: true }], [768, null], [1440, { pauseControl: true, reducedFallback: true, liveChange: true }]]);
    requests.length = 0;
    expect(await cli(['run', '--project', 'p', '--entry', 'index.html', '--json'])).toBe(4);
    const viaCli = parseVerificationBundle(output.pop());
    expect(requests.filter(request => request.motion?.pauseControl).map(request => request.width)).toEqual([375, 1440]);
    const strip = (bundle: typeof http) => bundle.results.map(({ checkId, parameterType, outcome, reason, required }) => ({ checkId, parameterType, outcome, reason, required }));
    expect(strip(viaCli)).toEqual(strip(http));
    expect(http.results.find(result => result.checkId === 'carousel-motion')?.outcome).toBe('fail');
  });

  it('serves a bundle stored before the motion parameter existed, unchanged', async () => {
    const { url, data } = await boot(null);
    const stored = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../../../packages/contracts/tests/fixtures/workbench-review-pre-motion/bundle.json'), 'utf8'));
    const dir = path.join(data, 'workbench-review', 'projects', createHash('sha256').update('p', 'utf8').digest('hex').slice(0, 32));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${stored.id}.json`), JSON.stringify(stored));
    const read = await fetch(`${url}/api/workbench/projects/p/review/bundles/${stored.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(stored);
  });
});
