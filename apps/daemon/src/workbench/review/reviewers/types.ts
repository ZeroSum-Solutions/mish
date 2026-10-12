// Reviewer-adapter boundary for R03 review runs. The run service only talks to
// these interfaces; each adapter wraps one approved provider lane. Tests inject
// fakes, so no unit test touches a provider.
import type { ReviewAbstainReason, ReviewerReasonCode, ReviewerRecord, ReviewerRole } from '@mish/contracts';
import type { JudgmentContract } from '../judgment-seeds.js';

/** One check a reviewer is asked about. Mechanical checks carry the runner's verdict to challenge. */
export interface ReviewerCheck {
  checkId: string;
  kind: 'mechanical' | 'judgment';
  /** The criterion text (judgment) or a one-line description of the mechanical check. */
  criterion: string;
  mechanicalOutcome: string | null;
  mechanicalReason: string | null;
  evidenceIds: string[];
  /** AC-R06.3: what a judgment reviewer must look at, cite and avoid; absent for checks without a seeded contract. */
  contract?: JudgmentContract;
  /** R03: a judgment that needs the rendered look (screenshot or computed-style evidence); its evidenceIds name the visual facts. */
  visual?: boolean;
  /** R03: a copy-quality judgment (specificity, repetition); text reviewers see copy only as hash tokens. */
  copy?: boolean;
}

export interface ReviewerInput {
  projectId: string;
  /** The review run this input belongs to (names the run's screenshot folder). */
  runId: string;
  entry: string;
  styleDirection: string | null;
  checks: ReviewerCheck[];
  /** Bundle evidence the reviewer may cite by id; `detail` is what the check measured (rendered from typed evidence). */
  evidence: { id: string; summary: string; observations: string[]; detail?: string[] }[];
  /** Absolute PNG paths under the daemon data root, one per viewport width. */
  screenshots: { evidenceId: string; width: number; path: string }[];
}

export interface ReviewerVerdict {
  checkId: string;
  verdict: 'supports' | 'disputes' | 'uncertain';
  probability: number | null;
  rationale: string;
  evidenceRefs: string[];
  /** R03: the reviewer declined to score this check (verdict uncertain, no probability). */
  abstain?: ReviewAbstainReason;
}

/** Why a visual critic ended without reading every screenshot. */
export type VisualFallbackCode = Extract<ReviewerReasonCode, 'screenshot-read-denied' | 'screenshot-read-failed' | 'screenshot-not-read' | 'screenshot-unavailable'>;
export interface VisualFallback { code: VisualFallbackCode; reason: string; recovery: string }

export interface ReviewerResult {
  verdicts: ReviewerVerdict[];
  /** Provider output exactly as returned (bounded by the caller). */
  rawOutput: string;
  inputMode: NonNullable<ReviewerRecord['inputMode']>;
  /** Set with `text-only-fallback`: the observed cause, so the record names it. */
  fallback?: VisualFallback;
}

export type ReviewerAvailability = { available: true } | { available: false; reason: string; recovery: string; code?: ReviewerReasonCode };

export interface ReviewerAdapter {
  role: ReviewerRole;
  provider: ReviewerRecord['provider'];
  modelId: string;
  adapterVersion: string;
  billingLane: ReviewerRecord['billingLane'];
  /** Most checks one call can answer; the run assigns this reviewer only that many, so its record shows its real coverage. */
  maxChecks?: number;
  /**
   * Provider calls one review() of this input would send; 0 when every check abstains. Declared up
   * front so the run neither reserves nor counts a billed call it will not make. Absent means 1.
   */
  plannedCalls?(input: ReviewerInput): number;
  /** Optional: create a run-owned adapter so async route facts cannot drift across concurrent runs. */
  forRun?(): ReviewerAdapter;
  /** Optional: resolve facts that depend on async state (which route is usable) before the run freezes provider, model and lane. Never a provider call. */
  prepare?(): Promise<void>;
  /** Cheap local check (key present, binary resolvable); never a provider call. */
  availability(): Promise<ReviewerAvailability>;
  review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewerResult>;
}

/** A reviewer call that failed for a reason the user can act on. Messages never carry secrets or provider bodies. */
export class ReviewerCallError extends Error {
  constructor(message: string, readonly recovery: string, readonly code: ReviewerReasonCode = 'provider-error') { super(message); this.name = 'ReviewerCallError'; }
}
