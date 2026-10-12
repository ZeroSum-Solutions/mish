import { readFileSync } from 'node:fs';
import path from 'node:path';

export const REVIEW_FIXTURE_ROOT = path.resolve(import.meta.dirname, '../fixtures/workbench/review');
/** AC-R03.4: broken CTA, overflow, low contrast, missing font and a known-good page. */
export const REVIEW_FIXTURES = ['broken-cta', 'overflow-320', 'low-contrast', 'missing-font', 'known-good'] as const;
/** B4-2 round 9 (Sol round 8): probe retargeting after reload, and locators under custom elements. Same expected.json shape. */
export const REVIEW_LOCATOR_FIXTURES = ['probe-retarget', 'probe-decoy', 'probe-duplicates', 'probe-duplicate-inert', 'custom-element-locators'] as const;
/** B4-2 egress fixtures; their expected.json holds one case per allow-list setting. */
export const REVIEW_EGRESS_FIXTURES = ['external-allowed', 'main-frame-escape', 'external-get-form', 'js-get-submit', 'pushstate', 'hash-query', 'blob-nav', 'window-open', 'iframe-form-autosubmit', 'subframe-embed', 'redacted-urls', 'iframe-formdata-src', 'meta-refresh-query', 'iframe-script-path', 'page-text-secrets', 'iframe-base-href', 'iframe-base-elsewhere', 'selector-secrets', 'role-secrets', 'console-sourceurl', 'iframe-base-attr-trick'] as const;
/** B4-2b opt-in motion fixtures: run with a rubric declaring a motion check; `motion` is that check's outcome. */
export const REVIEW_MOTION_FIXTURES = ['auto-carousel', 'reduced-motion-static'] as const;
/** B4-2b review fixtures for motion edge cases; each runs with its own motion parameters and expects one motion outcome. */
export const REVIEW_MOTION_EDGE_FIXTURES = ['slow-carousel', 'shadow-pause', 'implicit-submit', 'below-fold-canvas', 'late-start', 'autofocus-static', 'worker-carousel', 'iframe-timer', 'partial-pause', 'partial-live', 'static-infinite', 'paused-flag', 'heartbeat-static', 'bg-interval', 'bg-hidden-anim', 'tamper-tiles', 'img-swap', 'tile-mask', 'flicker', 'tiny-dot-only', 'tiny-dot-decoy'] as const;
export interface MotionEdgeExpectation { description: string; parameters: Record<string, boolean>; motion: 'pass' | 'fail' | 'inconclusive' | 'not-applicable' }
export const motionEdgeExpectationFor = (name: string): MotionEdgeExpectation => JSON.parse(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'expected.json'), 'utf8'));
export interface FixtureExpectation {
  description: string; outcome: 'passed' | 'failed' | 'inconclusive'; criteria: Record<string, 'pass' | 'fail' | 'inconclusive'>;
  /** Text every reader must see somewhere in the rendered bundle. */
  evidenceIncludes?: string[];
  /** Page-chosen text that must appear nowhere in the bundle, rendered or stored. */
  evidenceExcludes?: string[];
  /** B4-2b motion fixtures: the motion check's outcome under a rubric that declares it. */
  motion?: 'pass' | 'fail';
}
export const expectationFor = (name: string): FixtureExpectation => JSON.parse(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'expected.json'), 'utf8'));
