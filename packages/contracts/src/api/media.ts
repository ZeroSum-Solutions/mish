export const MEDIA_EXECUTION_MODES = [
  'enabled',
  'disabled',
] as const;

export type MediaExecutionMode = (typeof MEDIA_EXECUTION_MODES)[number];

export const MEDIA_SURFACES = [
  'image',
  'video',
  'audio',
] as const;

export type MediaSurface = (typeof MEDIA_SURFACES)[number];

export const MEDIA_TASK_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'interrupted',
] as const;

export type MediaTaskStatus = (typeof MEDIA_TASK_STATUSES)[number];

export interface ProjectMediaTaskFile {
  name: string;
  size?: number;
  /** Stable across an in-project rename/move and used to reconcile the final path. */
  mtime?: number;
  kind?: string;
  mime?: string;
}

/**
 * What to do next about a media generation that failed.
 *
 * This is the ONLY failure vocabulary a client — the agent that dispatched
 * the render, the chat host, a CLI caller — is meant to branch on. The
 * internal `code` stays for triage; it is not an answer to "so what now?",
 * and the moment it reached a user's screen it stopped being one at all
 * (「原因未分类(错误代码:MEDIA_DISPATCH_FAILED)」 is a support ticket, not a
 * next step).
 *
 * The values are the run-error ladder (`docs/design/run-errors/error-ux-design.md`
 * §3, mirrored in `apps/web/src/runtime/amr-guidance.ts`) applied to media, so
 * media failures do not grow a second, differently-shaped taxonomy:
 *
 * - rung 1 · the user can fix it right here — `revise-request`,
 *   `switch-model`, `open-settings`, `sign-in`
 * - rung 2 · nothing to fix, it may just work next time — `retry-later`
 * - rung 3 · this path cannot work; take a different one — `add-credit`,
 *   `update-app`, `unsupported`
 * - rung 4 · retrying is futile and we have no other lever — `contact-support`
 * - outside the ladder · the generation worked but its file was replaced
 *   afterwards — `output-superseded` (appended last so existing values keep
 *   their positions)
 *
 * Two failures that put the user in the same place get the SAME value on
 * purpose: a missing OpenAI key and a model with no configured renderer are
 * different bugs and one sentence ("fill it in under Settings").
 */
export const MEDIA_FAILURE_NEXT_STEPS = [
  /** The request itself was refused. Reword it / swap the reference image. */
  'revise-request',
  /** This model cannot serve the request; another one can. */
  'switch-model',
  /** A credential or endpoint is missing or wrong in Settings. */
  'open-settings',
  /** The Mishh Mashh session behind an OD-owned model expired. */
  'sign-in',
  /** Credit is spent. Retrying cannot bring it back. */
  'add-credit',
  /** Transient: upstream wobble, throttling, timeout, local restart. */
  'retry-later',
  /** The installed app/runtime is too old to place the request at all. */
  'update-app',
  /** This run/project does not do this kind of generation, by policy. */
  'unsupported',
  /** We could not name a cause. Ours to fix, not the user's. */
  'contact-support',
  /**
   * Generation succeeded, but the file it wrote was later replaced, moved or
   * deleted (another generation used the same `--output`, or an edit). Not a
   * refusal and not an outage: use the newer file, or regenerate with an
   * output name no other generation uses.
   */
  'output-superseded',
] as const;

export type MediaFailureNextStep = (typeof MEDIA_FAILURE_NEXT_STEPS)[number];

/**
 * Why a content-safety policy refused a media request, as a typed reason a
 * prompt-revision loop can branch on.
 *
 * The set is what the provider adapters can actually observe, nothing more:
 *
 * - `safety.nsfw` — the provider flagged the request as not safe for work.
 *   HiggsField reports a refused job as `status: "nsfw"`, its only safety
 *   verdict.
 * - `safety.unspecified` — a safety rejection whose producer named no reason
 *   (or a reason this build does not know). Never guess a narrower one.
 *
 * Add a value only when an adapter receives a provider signal that proves it.
 */
export const MEDIA_SAFETY_CATEGORIES = ['safety.nsfw', 'safety.unspecified'] as const;

export type MediaSafetyCategory = (typeof MEDIA_SAFETY_CATEGORIES)[number];

/** The media failure code a content-safety refusal carries. */
export const MEDIA_SAFETY_REJECTION_CODE = 'safety_rejection';

export function isMediaSafetyCategory(value: unknown): value is MediaSafetyCategory {
  return typeof value === 'string' && (MEDIA_SAFETY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The category a failure carries: the producer's own value when it is a known
 * category, `safety.unspecified` for any other safety rejection, and nothing
 * for a failure that is not a safety rejection.
 */
export function mediaSafetyCategory(
  code: string | null | undefined,
  category: unknown,
): MediaSafetyCategory | undefined {
  if (code?.trim() !== MEDIA_SAFETY_REJECTION_CODE) return undefined;
  return isMediaSafetyCategory(category) ? category : 'safety.unspecified';
}

export interface ProjectMediaTaskError {
  message: string;
  status?: number;
  code?: string;
  subject?: 'prompt' | 'input_image' | 'output_image';
  /** Typed reason for a content-safety refusal; present only on `code: "safety_rejection"`. */
  category?: MediaSafetyCategory;
  retryable?: boolean;
  /**
   * The classified next step. Always present on a failure the daemon
   * recorded: an absent value would push every consumer back to guessing from
   * `message`, which is the habit this field exists to end.
   */
  nextStep?: MediaFailureNextStep;
}

/**
 * A media generation the HOST itself watched fail, attributed to the run that
 * asked for it.
 *
 * The daemon has always known this: `routes/media.ts` writes a `[media]`
 * `event: "failed"` diagnostic carrying the very `run_id` that dispatched the
 * task. It just never handed the fact back to the run, so the run's terminal
 * frame was decided by the agent's exit code alone — the agent exits 0 after
 * apologising in prose, and the turn published `status: "succeeded"`,
 * `endedWithUnfinishedWork: false`, a green check, and an empty artifact rail.
 *
 * This is host-observed evidence, never a reading of the model's own words.
 * The apology sentence the media contract asks the model to copy verbatim
 * (`prompts/media-contract.ts`, design S22) is COPY: it can be rewritten in any
 * release, and no completeness verdict may depend on what it says.
 */
export interface RunMediaTaskFailure {
  /** The media task's id, so a consumer can fetch its full record. */
  taskId: string;
  /** `image` | `video` | `audio`, as requested. Absent if the request never named one. */
  surface?: string;
  /** The requested media model id. */
  model?: string;
  /** When the host recorded the failure. */
  failedAt: number;
  /** The task's own classified error, verbatim — same shape the media task
   *  endpoints publish, so an error card needs no second vocabulary. */
  error: ProjectMediaTaskError;
}

/** Everything a media failure can be classified from. All fields optional. */
export interface MediaFailureSignal {
  /**
   * The producer's stable code, when it published one. Never invent it: an
   * unrecognised code must NOT be promoted to a content refusal, or a user
   * gets sent off to rewrite a prompt that was never the problem.
   */
  code?: string | null | undefined;
  /** A real upstream HTTP status. Omit rather than defaulting it. */
  status?: number | null | undefined;
  /** The producer's diagnostic sentence. Read, never shown to a user. */
  message?: string | null | undefined;
  /** Only an explicit boolean counts; undefined means "the producer did not say". */
  retryable?: boolean | null | undefined;
  /** Model id, so an OD-owned (`vela/*`) credential failure is not read as a BYOK one. */
  model?: string | null | undefined;
}

/**
 * The code a done media task's wait result carries when the file it wrote has
 * since been overwritten, moved or deleted. The result then names no file.
 */
export const MEDIA_OUTPUT_SUPERSEDED_CODE = 'MEDIA_OUTPUT_SUPERSEDED';

const MEDIA_FAILURE_NEXT_STEP_BY_CODE: Readonly<Record<string, MediaFailureNextStep>> = {
  // Content policy. The one code that licenses "reword it".
  safety_rejection: 'revise-request',
  // A done task's output path no longer holds the bytes it wrote. Never
  // revise-request: that tells the user content review refused the prompt.
  [MEDIA_OUTPUT_SUPERSEDED_CODE]: 'output-superseded',
  // Daemon/dispatcher policy for this run.
  MEDIA_EXECUTION_DISABLED: 'unsupported',
  MEDIA_SURFACE_DENIED: 'unsupported',
  // The run allows media but not THIS model — another allowed one exists.
  MEDIA_MODEL_DENIED: 'switch-model',
  // No renderer is wired for the selected model: a Settings problem, whether
  // the fix is a key or a different provider entry.
  STUB_PROVIDER_DISABLED: 'open-settings',
  // Local plumbing. Nothing upstream is wrong and nothing is spent.
  MEDIA_DISPATCHER_UNREACHABLE: 'retry-later',
  DAEMON_RESTART: 'retry-later',
  // The user stopped it. Nothing is broken and nothing needs fixing: running
  // it again (as a new, linked task) is the whole recovery.
  MEDIA_TASK_CANCELLED: 'retry-later',
  RATE_LIMITED: 'retry-later',
  UPSTREAM_UNAVAILABLE: 'retry-later',
  // The installed runtime cannot place the call at all.
  MEDIA_CLI_INCOMPATIBLE: 'update-app',
  // Money.
  AMR_INSUFFICIENT_BALANCE: 'add-credit',
  // Identity behind an OD-owned model.
  AMR_AUTH_REQUIRED: 'sign-in',
  AGENT_AUTH_REQUIRED: 'sign-in',
};

/**
 * Provider adapters throw a uniform `"<tag> <status>: <body>"` sentence
 * (`openai image 429: …`, `senseaudio tts 401: unauthorized`), and a few
 * throw the bare `"<verb> <status>"` form (`openai image fetch 404`). Those
 * two shapes are the only places an upstream status survives into a plain
 * `Error`, so they are the only ones read here. Both are anchored to the
 * short tag that opens the sentence, so a three-digit number inside the
 * truncated response body that follows cannot be mistaken for a status.
 */
const TAGGED_STATUS_RE = /^[A-Za-z][\w .\/-]{0,32}?\s([1-5]\d\d):\s/;
const BARE_STATUS_RE =
  /^[A-Za-z][\w .\/-]{0,32}?\b(?:fetch|download|submit|poll|content)\s+([1-5]\d\d)\b/i;

/** `no Fal API key — configure it in …`, `no OpenAI credential — …`. */
const MISSING_CREDENTIAL_RE = /\bno\s+(?:[\w.-]+\s+){0,3}(?:api key|credential)\b/i;
/** Every long-poll adapter gives up with this exact phrase. */
const RENDER_TIMED_OUT_RE = /\bdid not finish in time\b/i;

function nextStepForStatus(
  status: number,
  odOwnedModel: boolean,
): MediaFailureNextStep | undefined {
  if (status === 401 || status === 403) return odOwnedModel ? 'sign-in' : 'open-settings';
  if (status === 402) return 'add-credit';
  if (status === 404) return 'switch-model';
  if (status === 408 || status === 425 || status === 429) return 'retry-later';
  if (status >= 500 && status <= 599) return 'retry-later';
  return undefined;
}

function statusFromMessage(message: string): number | undefined {
  const tagged = TAGGED_STATUS_RE.exec(message);
  if (tagged?.[1]) return Number(tagged[1]);
  const bare = BARE_STATUS_RE.exec(message);
  if (bare?.[1]) return Number(bare[1]);
  return undefined;
}

/**
 * Classify a media failure into the one thing its reader should do next.
 *
 * Precedence is deliberate and narrows outward from proof to guess: a code the
 * producer published, then a real HTTP status, then the two message shapes
 * that provably carry a status, then a two-entry message allowlist, then the
 * producer's own retry verdict. Anything left is `contact-support` — "we could
 * not name it" is an honest answer and its copy still offers a retry, whereas
 * guessing `revise-request` would blame the user for our outage.
 */
export function mediaFailureNextStep(signal: MediaFailureSignal): MediaFailureNextStep {
  const code = typeof signal.code === 'string' ? signal.code.trim() : '';
  const byCode = code ? MEDIA_FAILURE_NEXT_STEP_BY_CODE[code] : undefined;
  if (byCode) return byCode;

  const model = typeof signal.model === 'string' ? signal.model.trim() : '';
  const odOwnedModel = model.startsWith('vela/');

  if (typeof signal.status === 'number' && Number.isFinite(signal.status)) {
    const byStatus = nextStepForStatus(signal.status, odOwnedModel);
    if (byStatus) return byStatus;
  }

  const message = typeof signal.message === 'string' ? signal.message : '';
  if (message) {
    const embedded = statusFromMessage(message);
    if (embedded !== undefined) {
      const byEmbedded = nextStepForStatus(embedded, odOwnedModel);
      if (byEmbedded) return byEmbedded;
    }
    if (MISSING_CREDENTIAL_RE.test(message)) return 'open-settings';
    if (RENDER_TIMED_OUT_RE.test(message)) return 'retry-later';
  }

  if (signal.retryable === true) return 'retry-later';
  return 'contact-support';
}

/** A project media task snapshot consumed by ChatPanel's per-output progress row. */
export interface ProjectMediaTask {
  taskId: string;
  /**
   * Creation order within the daemon's media task store. Compare it, never
   * persist or display it. `startedAt` ties on every parallel fan-out, so this
   * is the only field that keeps a batch's cells in their real positions
   * across polls. Absent from a producer that does not report it — fall back
   * to `startedAt` then.
   */
  sequence?: number;
  /**
   * Identity of the generation batch this task belongs to: same-run,
   * same-surface tasks whose lifetimes overlap, which is what a user perceives
   * as one "generate the illustrations" action. Absent means the producer did
   * not group; treat the task as a batch of one rather than guessing a total.
   */
  batchId?: string;
  /** 1-based position within `batchId`. The N in "N/M". */
  batchIndex?: number;
  /**
   * Tasks known in `batchId`. The M in "N/M". It grows while the batch is open
   * and freezes once its last member ends, so a progress row's denominator
   * never walks backwards. A one-at-a-time generation reports 1 here: the
   * product ruling is a single spinner, not a fabricated total.
   */
  batchSize?: number;
  runId?: string;
  status: MediaTaskStatus;
  startedAt: number;
  endedAt: number | null;
  elapsed: number;
  surface?: string;
  model?: string;
  progress: string[];
  progressCount: number;
  file?: ProjectMediaTaskFile;
  error?: ProjectMediaTaskError;
  /**
   * Why an `interrupted` task stopped. Absent on every other status, and on
   * an interrupted task whose producer predates the field.
   */
  interruptReason?: MediaTaskInterruptReason;
}

export interface ProjectMediaTasksResponse {
  tasks: ProjectMediaTask[];
}

export const MEDIA_POLICY_DENIAL_CODES = [
  'MEDIA_EXECUTION_DISABLED',
  'MEDIA_SURFACE_DENIED',
  'MEDIA_MODEL_DENIED',
] as const;

export type MediaPolicyDenialCode = (typeof MEDIA_POLICY_DENIAL_CODES)[number];

/**
 * Run-scoped policy controlling Mishh Mashh-owned media generation only.
 *
 * `allowedSurfaces` and `allowedModels` apply solely to `/api/tools/media/generate`
 * and in-run `od media generate`. External MCP media tools are intentionally
 * unaffected: provider policy for those belongs to the MCP server / orchestrator.
 */
export interface MediaExecutionPolicy {
  mode: MediaExecutionMode;
  allowedSurfaces?: MediaSurface[];
  allowedModels?: string[];
}

export const DEFAULT_MEDIA_EXECUTION_POLICY: MediaExecutionPolicy = {
  mode: 'enabled',
};

export interface MediaPolicyTarget {
  surface: MediaSurface;
  model?: string;
}

export interface MediaPolicyDenial {
  code: MediaPolicyDenialCode;
  message: string;
}

export function mediaExecutionPolicyDenial(
  policy: MediaExecutionPolicy,
  target: MediaPolicyTarget,
): MediaPolicyDenial | null {
  if (policy.mode === 'disabled') {
    return {
      code: 'MEDIA_EXECUTION_DISABLED',
      message: 'media generation is disabled for this run',
    };
  }
  if (
    Array.isArray(policy.allowedSurfaces) &&
    policy.allowedSurfaces.length > 0 &&
    !policy.allowedSurfaces.includes(target.surface)
  ) {
    return {
      code: 'MEDIA_SURFACE_DENIED',
      message: `media surface "${target.surface}" is not allowed for this run`,
    };
  }
  if (
    target.model &&
    Array.isArray(policy.allowedModels) &&
    policy.allowedModels.length > 0 &&
    !policy.allowedModels.includes(target.model)
  ) {
    return {
      code: 'MEDIA_MODEL_DENIED',
      message: `media model "${target.model}" is not allowed for this run`,
    };
  }
  return null;
}

/** Request for Mishh Mashh's deterministic local HyperFrames scaffold. */
export interface HyperFramesScaffoldRequest {
  /** Project-relative path in the form `.hyperframes-cache/<id>`. */
  compositionDir: string;
}

/** Files created before the agent authors the composition HTML. */
export interface HyperFramesScaffoldResponse {
  compositionDir: string;
  files: ['hyperframes.json', 'meta.json', 'index.html'];
}

/** Starts the local provider-owned OAuth browser flow; contains no tokens. */
export interface HiggsfieldSubscriptionLoginResponse { provider: 'higgsfield'; status: 'pending' }

// ---------------------------------------------------------------------------
// AC-R10.1 — cancel and retry.
//
// A cancelled task keeps the existing five-state vocabulary: it ends
// `interrupted` with `interruptReason: "user-cancelled"`, the same reason name
// the workbench operations use. There is deliberately no sixth `cancelled`
// status: every reader of `MediaTaskStatus` (the chat batch grid, the CLI
// exit codes, the SQLite CHECK constraint) already treats `interrupted` as a
// terminal non-success, and a new status would read as "still running" to
// each of them until they learned it.
// ---------------------------------------------------------------------------

/** Why an `interrupted` media task stopped. */
export const MEDIA_TASK_INTERRUPT_REASONS = ['user-cancelled', 'daemon-restart'] as const;

export type MediaTaskInterruptReason = (typeof MEDIA_TASK_INTERRUPT_REASONS)[number];

/** The error code a user-cancelled media task carries. */
export const MEDIA_TASK_CANCELLED_CODE = 'MEDIA_TASK_CANCELLED';

/** The error code a task the daemon found unfinished at boot carries. */
export const MEDIA_TASK_DAEMON_RESTART_CODE = 'DAEMON_RESTART';

export function isMediaTaskInterruptReason(value: unknown): value is MediaTaskInterruptReason {
  return typeof value === 'string'
    && (MEDIA_TASK_INTERRUPT_REASONS as readonly string[]).includes(value);
}

/**
 * The interrupt reason a task's status and error code prove, or undefined.
 * Derived rather than stored so a task written before the field existed reads
 * back with the same answer as a new one.
 */
export function mediaTaskInterruptReason(
  status: MediaTaskStatus | string,
  code: string | null | undefined,
): MediaTaskInterruptReason | undefined {
  if (status !== 'interrupted') return undefined;
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (trimmed === MEDIA_TASK_CANCELLED_CODE) return 'user-cancelled';
  if (trimmed === MEDIA_TASK_DAEMON_RESTART_CODE) return 'daemon-restart';
  return undefined;
}

/**
 * How a cancel reached the work.
 *
 * - `provider` — the adapter asked the provider to cancel its job.
 * - `local-abort` — the daemon aborted its own in-flight request and refuses
 *   to write any bytes that arrive afterwards. The provider may still finish
 *   (and bill) its side; nothing it returns becomes this task's output.
 */
export const MEDIA_TASK_CANCEL_MODES = ['provider', 'local-abort'] as const;

export type MediaTaskCancelMode = (typeof MEDIA_TASK_CANCEL_MODES)[number];

/** `POST /api/media/tasks/:id/cancel` → 200. */
export interface MediaTaskCancelResponse {
  taskId: string;
  projectId: string;
  status: 'interrupted';
  interruptReason: 'user-cancelled';
  endedAt: number;
  cancellation: {
    mode: MediaTaskCancelMode;
    /** Whether a provider-side cancel was requested. No adapter supports one today. */
    providerCancel: 'requested' | 'unsupported';
    /** True when the task was already cancelled; the call changed nothing. */
    alreadyCancelled: boolean;
  };
}

/** How a gallery entry came to exist. */
export const MEDIA_LINEAGE_RELATIONS = ['original', 'retry', 'edit', 'reuse'] as const;

export type MediaLineageRelation = (typeof MEDIA_LINEAGE_RELATIONS)[number];

/**
 * Where a task sits in its version chain. Retries and edits point at the task
 * they derive from; nothing is ever rewritten in place. An edit is linked only
 * when its generate request names `parentTaskId` (`od media generate
 * --parent`); passing an earlier output as a reference image alone does not
 * link the two.
 */
export interface MediaTaskLineage {
  /** The chain's first task. Equal to the entry's own id for an original. */
  rootId: string;
  /** The task this one derives from; null for an original. */
  parentId: string | null;
  relation: MediaLineageRelation;
  /** 1 for an original; a retry is its parent's attempt + 1. */
  attempt: number;
  /**
   * False when the parent lives in another project (a `reuse`). Its id is
   * shown, but its record is only readable through that project.
   */
  parentInProject: boolean;
}

/**
 * `POST /api/media/tasks/:id/retry` request body. The `Idempotency-Key`
 * header carries the key; `idempotencyKey` here is the fallback for callers
 * that cannot set headers.
 */
export interface MediaTaskRetryRequest {
  idempotencyKey?: string;
}

/** `POST /api/media/tasks/:id/retry` → 202 (new task) or 200 (replayed key). */
export interface MediaTaskRetryResponse {
  taskId: string;
  projectId: string;
  status: MediaTaskStatus;
  startedAt: number;
  retryOf: string;
  lineage: MediaTaskLineage;
  idempotencyKey: string;
  /** True when this key already produced `taskId`; no new task was started. */
  replayed: boolean;
}

/** Refusals a retry can return, beyond the generic 400/403/404. */
export const MEDIA_RETRY_REFUSAL_CODES = [
  /** 409: the source is queued, running or done. Only failed/interrupted tasks retry. */
  'MEDIA_TASK_NOT_RETRYABLE',
  /** 422: a content-safety refusal is never retried unchanged. Revise and generate again. */
  'MEDIA_RETRY_SAFETY_REJECTED',
  /** 422: the source predates request recording, so there is nothing to replay. */
  'MEDIA_RETRY_REQUEST_UNAVAILABLE',
  /** 400: retry is a mutating call and needs an idempotency key. */
  'IDEMPOTENCY_KEY_REQUIRED',
  /** 409: the key was already used for a different source task. */
  'IDEMPOTENCY_KEY_CONFLICT',
] as const;

export type MediaRetryRefusalCode = (typeof MEDIA_RETRY_REFUSAL_CODES)[number];

/** Upper bound on an idempotency key, in characters. */
export const MEDIA_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A key the daemon will store: 1–128 visible ASCII characters. */
export function isValidMediaIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MEDIA_IDEMPOTENCY_KEY_MAX_LENGTH
    && /^[\x21-\x7e]+$/.test(value);
}

// ---------------------------------------------------------------------------
// AC-R10.2 — gallery.
// ---------------------------------------------------------------------------

/**
 * What a gallery entry's output file is now, judged by the bytes the task
 * recorded (the B4-3 output witness), never by name alone.
 *
 * - `current` — the recorded path still holds exactly those bytes.
 * - `moved` — the bytes now live at `file.name`, a different project path.
 * - `superseded` — the recorded path holds different bytes, or is not a
 *   regular file.
 * - `missing` — nothing is at the recorded path and the bytes were not found.
 * - `unverifiable` — the bytes could not be read (I/O error, hashing budget
 *   spent, or a task that predates the digest). Never a mismatch.
 * - `none` — the task wrote no output.
 */
export const MEDIA_GALLERY_OUTPUT_STATES = [
  'current',
  'moved',
  'superseded',
  'missing',
  'unverifiable',
  'none',
] as const;

export type MediaGalleryOutputState = (typeof MEDIA_GALLERY_OUTPUT_STATES)[number];

export interface MediaGalleryProvenance {
  providerId: string | null;
  model: string | null;
  /** sha256 (hex) of the prompt text; null when no prompt was sent. */
  promptDigest: string | null;
  /** Present only when the task failed a content-safety check. */
  safetyCategory?: MediaSafetyCategory;
  /**
   * True when the bytes came from the placeholder renderer, never a provider.
   * A stub entry is not a generated asset and must be shown as one.
   */
  stub: boolean;
}

export interface MediaGalleryFile {
  name: string;
  size?: number;
  mime?: string;
  kind?: string;
  sha256?: string;
}

/** One task in a project's media gallery. `id` is the task id and is stable. */
export interface MediaGalleryEntry {
  id: string;
  projectId: string;
  kind: MediaSurface | null;
  status: MediaTaskStatus;
  interruptReason?: MediaTaskInterruptReason;
  createdAt: number;
  endedAt: number | null;
  provenance: MediaGalleryProvenance;
  lineage: MediaTaskLineage;
  /**
   * The output as it is now. Present only when `output.state` is `current`,
   * `moved` or `unverifiable` (the last keeps the recorded name, unproven).
   */
  file?: MediaGalleryFile;
  output: { state: MediaGalleryOutputState; recordedName?: string };
  error?: ProjectMediaTaskError;
  /** Hidden from the default listing; its bytes are untouched. */
  unlinked: boolean;
  /** Whether the daemon holds the request needed to retry this task. */
  replayable: boolean;
}

export const MEDIA_GALLERY_DEFAULT_LIMIT = 50;
export const MEDIA_GALLERY_MAX_LIMIT = 100;

/** Parsed `GET /api/projects/:id/media/gallery` query. */
export interface MediaGalleryQuery {
  kind?: MediaSurface;
  status?: MediaTaskStatus[];
  provider?: string;
  /** Inclusive lower bound on `createdAt`, epoch ms. */
  from?: number;
  /** Exclusive upper bound on `createdAt`, epoch ms. */
  to?: number;
  cursor?: string;
  limit: number;
  includeUnlinked: boolean;
}

export interface MediaGalleryResponse {
  entries: MediaGalleryEntry[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  limit: number;
}

/** The replayable request a task recorded. No credentials are ever stored. */
export interface MediaGalleryRequestRecord {
  surface: MediaSurface;
  model: string;
  prompt?: string;
  output?: string;
  aspect?: string;
  quality?: string;
  resolution?: string;
  length?: number;
  duration?: number;
  voice?: string;
  audioKind?: string;
  language?: string;
  loop?: boolean;
  promptInfluence?: number;
  compositionDir?: string;
  image?: string;
  images?: string[];
}

/** `GET /api/projects/:id/media/gallery/:entryId`. */
export interface MediaGalleryEntryDetail {
  entry: MediaGalleryEntry;
  /** Every entry in this project sharing the entry's root, oldest first. */
  chain: MediaGalleryEntry[];
  request: MediaGalleryRequestRecord | null;
}

/** `POST /api/projects/:id/media/gallery/:entryId/reuse` body. */
export interface MediaGalleryReuseRequest {
  /** Same-project reuse remains supported and creates a unique copy. */
  targetProjectId: string;
  /** Project-relative name in the target; defaults to the source file's base name, made unique. */
  output?: string;
  /**
   * Fallback for the `Idempotency-Key` header. Optional on reuse; when sent,
   * a repeat with the same key (same project and principal, within 30 days)
   * answers 200 with the first copy instead of making another.
   */
  idempotencyKey?: string;
}

/** 201: the bytes were copied (200 when an idempotency key replays); the source project is untouched. */
export interface MediaGalleryReuseResponse {
  entry: MediaGalleryEntry;
  sourceId: string;
  sourceProjectId: string;
  bytesCopied: number;
}

/** `POST /api/projects/:id/media/gallery/:entryId/place`: verified copy into the destination project.
 * Copy lineage uses `reuse`; this is not a new generation or edit.
 */
export interface MediaGalleryPlaceRequest {
  /** Current canvas project; omitted by legacy callers to copy within the source project. */
  targetProjectId?: string;
  /** Plain asset filename. Collisions get a suffix; existing bytes are never overwritten. */
  output?: string;
  idempotencyKey?: string;
}

export interface MediaGalleryPlaceResponse extends MediaGalleryReuseResponse {
  action: 'place';
}

/** `POST /api/projects/:id/media/gallery/:entryId/unlink` → 200. */
export interface MediaGalleryUnlinkResponse {
  id: string;
  unlinked: true;
  /** Unlink never deletes the file: the bytes may be shared with other entries or project files. */
  bytesRetained: true;
}

export type MediaGalleryQueryParseResult =
  | { ok: true; query: MediaGalleryQuery }
  | { ok: false; field: string; message: string };

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return typeof value === 'string' ? value : undefined;
}

function parseQueryInstant(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d{1,16}$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate a raw gallery query (`req.query` or CLI flags). Unknown values are
 * refused rather than ignored, so a typo never silently widens the listing.
 */
export function parseMediaGalleryQuery(raw: Record<string, unknown>): MediaGalleryQueryParseResult {
  const query: MediaGalleryQuery = { limit: MEDIA_GALLERY_DEFAULT_LIMIT, includeUnlinked: false };

  const kind = firstQueryValue(raw.kind)?.trim();
  if (kind) {
    if (!(MEDIA_SURFACES as readonly string[]).includes(kind)) {
      return { ok: false, field: 'kind', message: `kind must be one of ${MEDIA_SURFACES.join(', ')}` };
    }
    query.kind = kind as MediaSurface;
  }

  const status = firstQueryValue(raw.status)?.trim();
  if (status) {
    const values = [...new Set(status.split(',').map((value) => value.trim()).filter(Boolean))];
    for (const value of values) {
      if (!(MEDIA_TASK_STATUSES as readonly string[]).includes(value)) {
        return { ok: false, field: 'status', message: `status must be among ${MEDIA_TASK_STATUSES.join(', ')}` };
      }
    }
    if (values.length > 0) query.status = values as MediaTaskStatus[];
  }

  const provider = firstQueryValue(raw.provider)?.trim();
  if (provider) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) {
      return { ok: false, field: 'provider', message: 'provider must be a provider id' };
    }
    query.provider = provider;
  }

  for (const field of ['from', 'to'] as const) {
    const value = firstQueryValue(raw[field]);
    if (value === undefined || value.trim() === '') continue;
    const instant = parseQueryInstant(value);
    if (instant === null) {
      return { ok: false, field, message: `${field} must be epoch milliseconds or an ISO date` };
    }
    query[field] = instant;
  }
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    return { ok: false, field: 'to', message: 'to must be later than from' };
  }

  const cursor = firstQueryValue(raw.cursor)?.trim();
  if (cursor) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) {
      return { ok: false, field: 'cursor', message: 'cursor is not one this daemon issued' };
    }
    query.cursor = cursor;
  }

  const limit = firstQueryValue(raw.limit)?.trim();
  if (limit) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1) {
      return { ok: false, field: 'limit', message: `limit must be 1–${MEDIA_GALLERY_MAX_LIMIT}` };
    }
    query.limit = Math.min(Number(limit), MEDIA_GALLERY_MAX_LIMIT);
  }

  const includeUnlinked = firstQueryValue(raw.includeUnlinked)?.trim();
  query.includeUnlinked = includeUnlinked === '1' || includeUnlinked === 'true';
  return { ok: true, query };
}
