// Browser-port boundary for the R06.2 mechanical runner. The runner's pure
// logic (plan → evaluate → aggregate) consumes ViewportCapture records; only
// cdp-worker.ts talks to a real browser. Tests inject a fake port.
import type { ObservedBehavior } from '@open-design/contracts';
import type { EgressSummary } from './egress.js';
import type { EvidenceParam, EvidenceText, PageText } from './evidence.js';
import type { ConsoleRecord } from './page-text.js';

/** RGBA with 0–255 channels and 0–1 alpha. */
export type Rgba = [number, number, number, number];

/** A declared target the worker resolves in-page. `key` is echoed back on matching elements. */
export interface TargetRequest {
  key: string;
  /** CSS selector the element must match (or sit inside, for scoped checks). */
  selector?: string;
  /** Same-document or same-origin href a link must resolve to. */
  href?: string;
  /** Accessible-name match, case-insensitive, for conversions declared only by label. */
  label?: string;
}

export interface CaptureRequest {
  url: string;
  width: number;
  height: number;
  targets: TargetRequest[];
  /** Probe clicks on discovered buttons/forms, not only declared targets. */
  probeAllActions: boolean;
  /** Also capture a PNG of the first paint (R03 visual critic); off for mechanical-only runs. */
  screenshot?: boolean;
  /** B4-2b: run the motion phases a rubric motion check at this width needs; absent when no motion check covers it. */
  motion?: MotionRequest;
}

/** Which motion phases one capture runs: the union of the requirements of the motion checks covering its width. */
export interface MotionRequest { pauseControl: boolean; reducedFallback: boolean; liveChange: boolean }

/**
 * Movement seen over one sampling window. Times are milliseconds on the
 * document's own clock (performance.now()). Only movement between two samples
 * both taken at or after `continuousFromMs` counts: five seconds after load
 * (WCAG 2.2.2), or the end of the grace period after an action.
 */
export interface MotionObservation {
  continuousFromMs: number;
  fromMs: number;
  toMs: number;
  samples: number;
  /** Samples taken at or after continuousFromMs; at least two are needed to compare. */
  samplesAfter: number;
  /** Outermost elements whose box, opacity or scroll offset changed between those samples (capped). */
  movingAfter: PageText[];
  /** Running animations or transitions on visible elements at those samples (capped). */
  animationsAfter: { selector: PageText; name: PageText; iterations: number | null }[];
  /** Whether the rendered viewport changed between those samples; null when screenshots were unavailable. */
  pixelsChangedAfter: boolean | null;
  /** Page-clock times of every sample in the window that saw movement (changed boxes or pixels, or a running animation); capped. */
  movementMs: number[];
  /**
   * What the sampler could not see at the end of the window: a canvas, video,
   * possibly animated image or frame outside the viewport (pixels are compared
   * for the viewport only), a running animation-frame loop, a repeating timer
   * or a pending timer. Stillness is never proof while any is present.
   */
  unmeasured: EvidenceText[];
  /** Movement times per moving subject, keyed by `element <digest of its selector>` or `viewport tile rNcM`; keys are never output. */
  subjects: { key: string; movementMs: number[] }[];
  /** Live timer sources at the end of the window (main-world setTimeout/setInterval, keyed by callback), with their recent firing times. */
  timers: MotionTimer[];
}

/** One live timer source the motion tracker saw: a callback with an active interval or a pending timeout. */
export interface MotionTimer {
  key: string;
  kind: 'interval' | 'timeout';
  /** Page-clock times of its recent firings (most recent last; capped). */
  fires: number[];
  /** When its next pending timeout is due; null for intervals. */
  nextDueMs: number | null;
}

export type MotionPhase = { observation: MotionObservation } | { error: EvidenceText };

/** A control named like pause, stop or hide (WCAG 2.2.2). */
export interface PauseControlProbe {
  selector: PageText;
  name: PageText;
  /** Focus reached it by pressing Tab from the top of the page (into open shadow roots and same-origin frames). */
  reachedByKeyboard: boolean;
  /** Button-like, so a key press activates it without submitting a form or following a link. */
  activatable: boolean;
}

/** One key activation of a ranked pause control and what followed it. */
export interface PauseAttempt {
  selector: PageText;
  name: PageText;
  /** Requests refused (blocked or refused under the allow-list) between the key press and the end of the watch. */
  blockedDuring: number;
  /** Attempts to open a new window in the same span. */
  windowOpensDuring: number;
  after: MotionPhase;
}

export interface PauseProbe {
  controls: PauseControlProbe[];
  tabStops: number;
  /** True when Tab returned to the first stop (or nothing is focusable); false when the press cap or time budget cut the walk. */
  walkComplete: boolean;
  /** Movement watched in the same document before the first activation; null when nothing was activatable. */
  before: MotionPhase | null;
  /** Ranked activations (pause/stop before hide, nearest the moving content first), ending once the motion stops. */
  attempts: PauseAttempt[];
}

/**
 * B4-2b motion evidence for one width. `noPreference` is a fresh load with
 * prefers-reduced-motion: no-preference; the other phases run only when it
 * shows continuous motion and a requirement needs them (null otherwise).
 */
export interface MotionCapture {
  noPreference: MotionPhase;
  /** The same document after the emulated preference is switched to reduce mid-session. */
  liveChange: MotionPhase | null;
  /** A fresh load with prefers-reduced-motion: reduce. */
  reduced: MotionPhase | null;
  /** A fresh no-preference load: a Tab walk, movement before activation, then ranked key activations. */
  pause: PauseProbe | { error: EvidenceText } | null;
}

/**
 * Captures are where page data enters the daemon. Every string the page could
 * influence is a PageText; every string the worker already reduced for
 * evidence (URLs against the serve log and allow-list, resource types against
 * their vocabulary, its own messages) is an EvidenceText. Evaluation can only
 * turn a PageText into evidence through evidence.ts (see that module).
 */
export interface TextSample {
  selector: PageText;
  text: PageText;
  color: Rgba;
  /** Effective opaque background, or null when an image/gradient/filter makes it undeterminable. */
  background: Rgba | null;
  fontSizePx: number;
  fontWeight: number;
  /** Keys of declared targets (filtered to the keys the request named). */
  targetKeys: string[];
}

export type DestinationKind = 'same-origin' | 'fragment' | 'external' | 'mailto' | 'tel' | 'script' | 'empty';

export interface ActionProbe {
  selector: PageText;
  kind: 'link' | 'button' | 'form';
  name: PageText;
  visible: boolean;
  disabled: boolean;
  width: number;
  height: number;
  /** Inline text links are exempt from the 24×24 target-size floor (WCAG 2.5.8 inline exception). */
  inline: boolean;
  /** The link target reduced against the run's serve log and allow-list. */
  href: EvidenceParam | null;
  /**
   * For links: where the href points. `status` is the served status of a same-origin path, or the
   * fetched status of an external destination on an allowed host; `reason` says why such a fetch
   * produced no status; `found` is for fragments.
   */
  destination: { kind: DestinationKind; status?: number | null; found?: boolean; reason?: EvidenceText } | null;
  /** For buttons and forms: what a safe click/submit did. Submissions go to a mock destination. */
  clickEffect: {
    domMutations: number; navigated: boolean; submissionCaptured: boolean; externalBlocked: boolean; error: PageText | null;
    /**
     * How the probe found the action again after reloading the entry: `same` (the selector resolved to an
     * element with the action's private fingerprint), `relocated` (the unique element with that fingerprint),
     * `missing` or `ambiguous` (nothing was clicked; the activation is unverified, never passed).
     */
    target: 'same' | 'relocated' | 'missing' | 'ambiguous';
  } | null;
  targetKeys: string[];
}

export interface ServedResource {
  /** The request URL reduced against the serve log and allow-list. */
  url: EvidenceParam;
  resourceType: EvidenceParam;
  outcome: 'served' | 'missing' | 'refused';
  status: number;
}

/**
 * R03 visual facts: the rendered first viewport measured from computed styles
 * (VISUAL_PROBE), so text-only reviewers can judge a declared look. Colours and
 * counts are numbers the page can influence but not turn into text; font
 * families and selectors stay PageText until a vocabulary or the structural
 * selector grammar reduces them.
 */
export interface VisualCapture {
  /** Opaque painted background colours sampled on a grid over the first viewport, with the share of grid points each covers. */
  surfaces: { color: Rgba; share: number }[];
  /** Share of grid points over an image, gradient, video, canvas or frame, whose colour is not measured. */
  mediaShare: number;
  /** Declared font-family value of each sampled text element, with how many elements declare it. */
  fonts: { family: PageText; count: number }[];
  /** Visible elements with a border: bevelled styles (outset, inset, ridge, groove) or any other; rounded corners and the largest radius. */
  borders: { bevel: number; other: number; rounded: number; maxRadiusPx: number };
  /** Visible elements with box shadows (hard-edged: every shadow has zero blur; inset: any inset shadow), gradients and background images. */
  effects: { shadows: number; hardShadows: number; insetShadows: number; gradients: number; backgroundImages: number };
  /** The largest visible boxes in the first viewport (viewport coordinates), with their own opaque background or null. */
  boxes: { selector: PageText; x: number; y: number; width: number; height: number; background: Rgba | null }[];
  /** document.documentElement.scrollHeight in CSS px. */
  documentHeight: number;
}

export interface ViewportCapture {
  width: number;
  height: number;
  /** Set when the entry document itself could not be loaded at this width. */
  loadError: EvidenceText | null;
  /** `layoutWidth` is window.innerWidth; it exceeds the requested width when a page lacks a responsive viewport. */
  document: { lang: PageText | null; title: PageText; scrollWidth: number; clientWidth: number; layoutWidth: number };
  headings: { level: number; text: PageText }[];
  /** Pointer-target size (a visually hidden native input measures its label); absent on ports that do not report it. */
  controls: { selector: PageText; role: PageText; name: PageText; width?: number; height?: number }[];
  texts: TextSample[];
  /** True when the text probe hit its sample limit with text left unmeasured; contrast cannot pass then. */
  textsTruncated: boolean;
  /** Overflow-hidden/clip containers whose content is wider/taller than their box. */
  clipped: { selector: PageText; scrollWidth: number; clientWidth: number; axis: 'x' | 'y'; targetKeys: string[] }[];
  /** Visible text boxes that extend past the viewport's horizontal edges. */
  outsideViewport: { selector: PageText; left: number; right: number; targetKeys: string[] }[];
  actions: ActionProbe[];
  /** Console, exception and log errors as records: never their text (see page-text.ts). */
  console: ConsoleRecord[];
  /** Same-origin resources that were not served successfully, and allowed-host fetches that failed. */
  resources: ServedResource[];
  /** Requests to any origin other than the preview origin that were not answered; `reason` is set when an allowed host was refused. */
  blockedRequests: { url: EvidenceParam; resourceType: EvidenceParam; reason?: EvidenceText }[];
  fonts: { family: PageText; status: 'loaded' | 'error' | 'unloaded' | 'loading' }[];
  /** `documentIndex` is the focused element's position in document order (absent on ports that do not report it). */
  keyboard: { focusableCount: number; steps: { selector: PageText | null; focusVisible: boolean; documentIndex?: number }[] };
  /** Project files served while rendering (paths from the daemon's file server), with SHA-256 of their bytes. */
  served: { path: string; sha256: string }[];
  /** Set when the per-review serving budget refused requests; the review cannot pass then. */
  servingLimit: EvidenceText | null;
  /** Base64 PNG of the viewport before any probe ran; present only when the request asked for it. */
  screenshotPng?: string;
  /**
   * B5-1 (AC-R06.5): behavior counts the page probe reported, with sample selectors (page text until
   * evidenceSelector reduces them); null when it could not tell.
   * Absent on ports that do not report it, which leaves dialogs, images and animation unknown.
   */
  behaviors?: Partial<Record<ObservedBehavior, { count: number; samples: PageText[] } | null>>;
  /** B4-2b motion evidence; present only when the request asked for motion phases. */
  motion?: MotionCapture;
  /** R03 visual facts; absent when the probe failed or the port does not measure them. */
  visual?: VisualCapture;
}

export type WorkerCapability =
  | { available: true; browserVersion: string }
  | { available: false; reason: EvidenceText; recovery: EvidenceText };

export interface ReviewBrowserSession {
  capture(request: CaptureRequest): Promise<ViewportCapture>;
  /** Every egress attempt this session made under the run's allow-list; absent on ports without egress. */
  egress?(): EgressSummary;
  /** B4-2b: egress attempts made by the motion phases' reloads, under their own budget; absent on ports without egress. */
  motionEgress?(): EgressSummary;
  close(): Promise<void>;
}

export interface ReviewBrowserPort {
  /** The isolated origin pages are rendered under (no real network behind it). */
  origin: string;
  capability(): Promise<WorkerCapability>;
  open(): Promise<ReviewBrowserSession>;
}
