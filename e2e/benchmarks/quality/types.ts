import type { BuildOnBrandResult, SiteCheckResult } from '@open-design/contracts';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export interface Conversion {
  action: string; labels: string[]; destinationRoles: string[]; demoOnly: boolean;
}
export interface BriefCase {
  id: string; industry: string; kitId: string; brief: string; split: 'dev' | 'unseen';
  suppliedFacts: Record<string, string | string[]>; omittedFacts: string[]; conversion: Conversion;
  regressionAnchor?: boolean; sourcePath?: string;
  /** Absent means the agency `grade` suite; `improve-prompt` cases feed `compare --writers`. */
  suite?: 'improve-prompt';
  /** Gaps a good brief raises as open questions instead of filling in. */
  questions?: string[];
}
export type Observation<T> = { status: 'complete'; value: T } | { status: 'missing' | 'failed'; reason: string };
export type Identity<T> = { status: 'available'; value: T; source: string } | { status: 'unavailable'; reason: string };
export interface CaseFingerprint {
  caseId: string; kit: { id: string; contentHash: Identity<string>; files: Identity<FileReceipt[]> };
  fontFiles: Identity<FileReceipt[]>; stagedAssets: Identity<FileReceipt[]>;
  promptVariant: Identity<string>; builder: Identity<{ agent: string; model: string }>;
  /** compare mode: the input this case was built from; absent for grade packets. */
  input?: { writer: string; previewSha256: string | null };
}
/** Which product path built the pages, and with what options. Part of the fingerprint. */
export interface BuilderIdentity { id: 'build-on-brand' | 'chat-run' | 'agency-build'; options: Record<string, string | number | boolean | null>; }
export interface Fingerprint {
  digest: string; fixtureDigest: string; captureSettings: typeof import('./settings.ts').CAPTURE_SETTINGS;
  cases: CaseFingerprint[];
  /** Absent on packets made before builders existed; those all used build-on-brand. */
  builder?: BuilderIdentity;
}
export interface FileReceipt { name: string; bytes: number; sha256: string; }
export interface CaseRun {
  caseId: string; industry: string; kitId: string; status: string; wallTimeMs: number;
  build?: BuildOnBrandResult; run?: Record<string, unknown>; siteCheck?: SiteCheckResult;
  /** chat-run and agency-build: the project and run they created, and the page the run reported. */
  target?: { projectId?: string; runId?: string; agencyBuildId?: string; entry: string | null; briefId?: string };
  /** compare mode: which input built this case, and the SHA-256 of the brief preview it attached. */
  input?: { writer: string; previewSha256: string | null };
  files: FileReceipt[]; failures: string[];
}
export interface BenchmarkRun {
  schema: 'quality-benchmark/1'; runId: string; mode: 'live' | 'stub'; startedAt: string;
  fixtureDigest: string; settings: { agent: string; model: string; pageCount: number; useLibrary: boolean };
  environment: { daemon: string; health: unknown; version: unknown; sourceSha: string | null };
  cases: CaseRun[]; fingerprint: Fingerprint;
}
export interface SectionCapture {
  id: string; selector: string; box: { x: number; y: number; width: number; height: number };
  screenshot: string; screenshotSha256?: string; error?: string;
  cropBox?: { x: number; y: number; width: number; height: number };
}
export interface ConversionMatch { selector: string; label: string; target: string | null; resolves: boolean; reason?: string; }
export interface KeyboardStep { selector: string | null; label: string; visibleFocus: boolean | null; primary: boolean; internalTabStopsUnmeasured: boolean; }
export interface FormObservation {
  selector: string; action: string; method: string; exercised: boolean;
  requests: Array<{ url: string; method: string; blocked: boolean }>; reason?: string;
  settling: { windowMs: number; durationMs: number; complete: boolean };
}
export interface MotionSample { animationCount: number; layoutShift: number; movedElements: number; sampleFrames: number; }
export interface ResourceEvidence {
  requests: Array<{ url: string; type: string; status: number | null; bytes: number | null; failure?: string }>;
  imageBytes: number; fontBytes: number;
  fontFaces: Array<{ family: string; weight: string; style: string; status: string }>;
  requestedFonts: Array<{ family: string; weight: string; style: string; available: boolean | null }>;
  images: Array<{ src: string; rendered: { width: number; height: number }; natural: { width: number; height: number } }>;
}
export interface CaptureFact {
  caseId: string; page: string; viewport: { width: number; height: number };
  evidenceFile?: string; evidenceSha256?: string;
  id: string; sections: SectionCapture[]; sectionEvidence: Observation<{ count: number }>;
  conversion: Observation<{ matches: ConversionMatch[]; exists: boolean; resolves: boolean }>;
  forms: Observation<FormObservation[]>;
  keyboard: Observation<{ tabStopCount: number; tabStopCountComplete: boolean; nativeExitObserved: boolean; nativeTabOrder: string[]; steps: KeyboardStep[]; trapDetected: boolean; primaryReachable: boolean; exhausted: boolean; reason?: string }>;
  motion: Observation<{ normal: MotionSample; reduced: MotionSample }>; resources: Observation<ResourceEvidence>;
  screenshot: string; screenshotSha256?: string; documentHeightPx?: number; screenshotHeightPx?: number; horizontalOverflowPx: number; consoleErrors: string[];
  brokenImages: string[]; blockedRequests: string[]; error?: string;
}
export interface Captures { schema: 'quality-captures/2'; runId: string; captureProtocolDigest: string; browser: string; facts: CaptureFact[]; }
export interface Rubric {
  version: string; status: 'placeholder' | 'approved';
  criteria: Array<{ id: string; name: string; anchors: Record<'1' | '2' | '3' | '4' | '5', string> }>;
  grades: Record<Grade, string>;
}
export interface Judgment { grade: Grade | null; criteria: Record<string, number | null>; failures: string[]; note: string; evidence?: Record<string, string>; }
export type ReviewerId = 'claude' | 'codex';
export interface Reviewer { id: ReviewerId; model: string; }
export interface Inventory { concept: string; placeholders: string[]; brackets: string[]; inventedFacts: string[]; unreadEvidence: string[]; }
export interface JudgeSample extends Judgment {
  page?: string;
  reviewer: ReviewerId; model: string; observedModels: string[]; index: number; inventory: Inventory;
  workerTimeMs: number; receiptFiles: string[]; receiptDigests: Record<string,string>;
}
export interface CaseJudgments { caseId: string; origin: 'model' | 'stub' | 'missing-evidence'; samples: JudgeSample[]; reason?: string; reasons?: string[]; }
export interface Judgments {
  schema: 'quality-judgments/2'; runId: string; evidenceDigest: string; evaluatorProtocolDigest: string; judgeProtocolDigest: string; mode: 'live' | 'stub'; rubricDigest: string; rubric: Rubric;
  requestedModel: string; reviewers: Reviewer[]; sampleCount: 3; actualModels: string[]; judgedAt: string; wallTimeMs: number;
  cases: CaseJudgments[]; phaseReceipts: Record<string,string>;
}
