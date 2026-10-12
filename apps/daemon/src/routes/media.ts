import { createDirectoryProbe } from '../directory-probe.js';
import { sendInternalError } from '../http/api-errors.js';
import fs from 'node:fs';
import type { Express } from 'express';
import type {
  DirectoryExistsResponse,
  HyperFramesScaffoldRequest,
  HyperFramesScaffoldResponse,
  MediaExecutionPolicy,
  MediaGenerationResultProps,
  ProjectFile,
  ProjectMediaTaskFile,
} from '@open-design/contracts';
import { mediaTaskInterruptReason } from '@open-design/contracts';
import type { AnalyticsContext } from '../analytics.js';
import { defaultMediaExecutionPolicy, mediaPolicyDenial } from '../media/policy.js';
import { formatMediaTaskDiagnostic } from '../media/diagnostics.js';
import { startHiggsfieldSubscriptionLogin } from '../media/higgsfield-runtime.js';
import type { HiggsfieldSubscriptionLoginResponse } from '@open-design/contracts';
import { findMediaModel } from '../media/models.js';
import type { ImageGenerationRequestSummary } from '../media/image-generation-retry.js';
import type { RouteDeps } from '../server-context.js';
import type {
  AuthorizeProjectRequest,
  AuthorizeProjectToolRequest,
} from '../collab/project-request-authority.js';
import { proxyDispatcherRequestInit } from '../connectionTest.js';
import {
  aihubmixCatalogUrl,
  parseAIHubMixCatalog,
  AIHUBMIX_DEFAULT_BASE_URL,
  type AIHubMixCatalogType,
} from '../integrations/aihubmix.js';
import { isSandboxModeEnabled } from '../sandbox-mode.js';
import { createChatArtifactBlobStore } from '../chat-artifacts/blob-store.js';
import { captureChatArtifactSnapshotFromBytes } from '../chat-artifacts/capture.js';
import { resolveChatArtifactQuota } from '../chat-artifacts/quota.js';
import {
  HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT,
  MEDIA_TASK_WAIT_TOOL_ENDPOINT,
  type ToolTokenGrant,
} from '../tool-tokens.js';
import { associateLateRunProducedFile } from '../runtimes/run-produced-files.js';
import { scaffoldHyperFramesComposition } from '../media/hyperframes-scaffold.js';
import { assignMediaTaskBatches } from '../media/task-batches.js';
import { mediaTaskErrorFromFailure } from '../media/task-error.js';
import {
  MEDIA_OUTPUT_HASH_CONCURRENCY,
  mapWithConcurrency,
  mediaOutputMatches,
  mediaOutputPath,
  mediaOutputRecord,
  supersededMediaOutputErrorFor,
} from '../media/output-witness.js';
import type { MediaTaskError } from '../media/tasks.js';
import type { LiveMediaTask } from '../media/task-store.js';
import {
  getMediaLineage,
  recordMediaTaskLineage,
  sanitizeMediaRequestRecord,
} from '../media/lineage.js';
import { registerMediaWorkbenchRoutes } from './media-workbench.js';
import { normalizePersistedAutomationWorkspaceScope } from '../automations/workspace-scope.js';

const LONG_MEDIA_PROXY_TIMEOUT_MS = 10 * 60 * 1000;
const MEDIA_FILE_MTIME_TOLERANCE_MS = 1;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Files a media task's recorded metadata could still be, after the agent moved
 * or renamed it.
 *
 * An in-project move preserves size and mtime, so the pair is a bounded
 * identity witness that needs no filename guessing. The tolerance absorbs a
 * destination filesystem storing fewer sub-millisecond digits than the source;
 * it is deliberately far below any real filesystem's timestamp granularity,
 * because a wider window buys nothing for a move (which preserves the value
 * exactly) and only makes unrelated files collide. A witness that has drifted
 * past it is not a witness, and staying blind beats showing the wrong image.
 *
 * `claimedNames` are files another task has already proven it owns. A witness
 * may never point at one of those: two chat cards showing the same image is
 * the same lie as one card showing a stranger's.
 */
function mediaTaskFileCandidates(
  taskFile: unknown,
  projectFiles: readonly ProjectFile[],
  claimedNames: ReadonlySet<string>,
): ProjectFile[] {
  if (!taskFile || typeof taskFile !== 'object') return [];
  const file = taskFile as Partial<ProjectMediaTaskFile>;
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (!name) return [];

  const size = finiteNumber(file.size);
  const mtime = finiteNumber(file.mtime);
  if (size === null || mtime === null) return [];
  const kind = typeof file.kind === 'string' && file.kind ? file.kind : null;
  return projectFiles.filter((candidate) => (
    !claimedNames.has(candidate.name)
    && candidate.size === size
    && Math.abs(candidate.mtime - mtime) <= MEDIA_FILE_MTIME_TOLERANCE_MS
    && (kind === null || candidate.kind === kind)
  ));
}

/**
 * Resolve one media task's generation-time file metadata to the path that is
 * currently registered in the project. Ambiguous matches fail closed so
 * ChatPanel never previews an unrelated file.
 */
export function resolveMediaTaskProjectFile(
  taskFile: unknown,
  projectFiles: ProjectFile[],
  claimedNames: ReadonlySet<string> = new Set(),
): ProjectFile | null {
  if (!taskFile || typeof taskFile !== 'object') return null;
  const file = taskFile as Partial<ProjectMediaTaskFile>;
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (!name) return null;

  if (!claimedNames.has(name)) {
    const exact = projectFiles.find((candidate) => candidate.name === name);
    if (exact) return exact;
  }

  const matches = mediaTaskFileCandidates(taskFile, projectFiles, claimedNames);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolve every moved media task against the project at once, so no surviving
 * file is handed to two of them.
 *
 * Per-task uniqueness is not enough: two tasks that recorded the same witness
 * each see exactly one candidate and each would take it. A file that more than
 * one task can claim proves nothing about either, so it is withdrawn from all
 * of them — the same fail-closed rule, applied across tasks instead of within
 * one.
 */
export function resolveMovedMediaTaskFiles(
  candidates: ReadonlyArray<{ taskId: string; file: unknown }>,
  projectFiles: readonly ProjectFile[],
  claimedNames: ReadonlySet<string> = new Set(),
): Map<string, ProjectFile> {
  const matchesByTask = new Map<string, ProjectFile[]>();
  const claimCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const matches = mediaTaskFileCandidates(candidate.file, projectFiles, claimedNames);
    matchesByTask.set(candidate.taskId, matches);
    for (const match of matches) {
      claimCounts.set(match.name, (claimCounts.get(match.name) ?? 0) + 1);
    }
  }

  const resolved = new Map<string, ProjectFile>();
  for (const [taskId, matches] of matchesByTask) {
    const uncontested = matches.filter((match) => (claimCounts.get(match.name) ?? 0) === 1);
    const only = uncontested.length === 1 ? uncontested[0] : undefined;
    if (only) resolved.set(taskId, only);
  }
  return resolved;
}

function reconciledMediaTaskFile(
  taskFile: unknown,
  projectFile: ProjectFile,
): Record<string, unknown> {
  const original = taskFile && typeof taskFile === 'object'
    ? taskFile as Record<string, unknown>
    : {};
  return {
    ...original,
    name: projectFile.name,
    size: projectFile.size,
    mtime: projectFile.mtime,
    kind: projectFile.kind,
    mime: projectFile.mime,
  };
}

function mediaProviderId(model: string): string | undefined {
  const registered = findMediaModel(model)?.provider;
  if (registered) return registered;
  if (model.startsWith('fal-ai/')) return 'fal';
  if (model.startsWith('aihubmix-')) return 'aihubmix';
  return undefined;
}

// Short in-memory cache for the AIHubMix media catalogue so the picker can
// refresh without hammering the upstream public endpoint. Keyed by
// `${baseUrl}|${type}`. Values expire after AIHUBMIX_CATALOG_TTL_MS.
const AIHUBMIX_CATALOG_TTL_MS = 5 * 60 * 1000;
const aihubmixCatalogCache = new Map<string, { at: number; models: Array<{ id: string; label: string }> }>();

export interface RegisterMediaRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'paths' | 'ids' | 'auth' | 'media' | 'appConfig' | 'orbit' | 'nativeDialogs' | 'projectStore' | 'projectFiles' | 'conversations' | 'research'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  authorizeProjectToolRequest: AuthorizeProjectToolRequest;
}

export type LegacyMediaRouteGrantDecision =
  | { ok: true; grant: ToolTokenGrant | null }
  | {
      ok: false;
      code: string;
      details?: Record<string, unknown>;
      message: string;
      status: number;
    };

export function resolveLegacyMediaRouteGrant(input: {
  grant: ToolTokenGrant | null;
  projectId: string;
  requestProjectOverride: (projectId: string, tokenProjectId: string) => boolean;
  sandboxMode: boolean;
}): LegacyMediaRouteGrantDecision {
  if (
    input.sandboxMode &&
    input.grant &&
    input.requestProjectOverride(input.projectId, input.grant.projectId)
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      details: { suppliedProjectId: input.projectId },
      message: 'projectId is derived from the tool token',
      status: 403,
    };
  }

  if (!input.grant && input.sandboxMode) {
    return {
      ok: false,
      code: 'TOOL_TOKEN_MISSING',
      message: 'tool token is required for media generation in sandbox mode',
      status: 401,
    };
  }

  return { ok: true, grant: input.grant };
}

export { mediaTaskErrorFromFailure };

/** What `handleGenerate` needs beyond the request itself. */
export interface GenerateOptions {
  projectId: string;
  grant: ToolTokenGrant | null;
  /** The generate body; defaults to `req.body`. A retry passes the recorded request. */
  body?: Record<string, any>;
  /** Lineage for an internal caller (retry). An HTTP edit uses `body.parentTaskId`. */
  lineage?: {
    parent?: { taskId: string; relation: 'retry' | 'edit' };
    idempotencyKey?: string;
    /** Who used the key (Workspace member or 'local'). */
    idempotencyPrincipal?: string;
  };
  /** Replaces the default 202 body. */
  acceptedBody?: (task: LiveMediaTask) => Record<string, unknown>;
}

export function registerMediaRoutes(app: Express, ctx: RegisterMediaRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, requireLocalDaemonRequest, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT, PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  // Derived from the one resolved daemon data root; the store rejects anything
  // else, so there is no second data root to drift.
  const chatArtifactBlobs = createChatArtifactBlobStore({ dataDir: RUNTIME_DATA_DIR });
  const chatArtifactQuota = resolveChatArtifactQuota(process.env);
  const { authorizeToolRequest, optionalToolGrantFromRequest, requestProjectOverride } = ctx.auth;
  const { randomUUID } = ctx.ids;
  const { MEDIA_PROVIDERS, IMAGE_MODELS, VIDEO_MODELS, AUDIO_MODELS_BY_KIND, MEDIA_ASPECTS, VIDEO_LENGTHS_SEC, AUDIO_DURATIONS_SEC, readMaskedConfig, writeConfig, generateMedia, createMediaTask, persistMediaTask, appendTaskProgress, notifyTaskWaiters, getLiveMediaTask, mediaTaskSnapshot, listMediaTasksByProject, listElevenLabsVoiceOptions } = ctx.media;
  const { readAppConfig, writeAppConfig } = ctx.appConfig;
  const onAppConfigWritten =
    typeof ctx.appConfig.onAppConfigWritten === 'function'
      ? ctx.appConfig.onAppConfigWritten
      : null;
  const { orbitService } = ctx.orbit;
  const { openBrowser, openNativeFolderDialog } = ctx.nativeDialogs;
  const { getWorkspaceProjectByProjectId, getProject } = ctx.projectStore;
  const { listFiles, resolveProjectDir, resolveProjectFilePath } = ctx.projectFiles;
  const { insertConversation, upsertMessage } = ctx.conversations;
  const { searchResearch, ResearchError } = ctx.research;
  const getResolvedPort = () => resolvedPortRef.current;

  const mediaPolicyForGrant = (grant: ToolTokenGrant | null):
    | { ok: true; policy: MediaExecutionPolicy }
    | { ok: false; code: string; message: string } => {
    if (!grant?.runId) return { ok: true, policy: defaultMediaExecutionPolicy() };
    const run = design.runs.get(grant.runId);
    if (!run) {
      return {
        ok: false,
        code: 'MEDIA_POLICY_UNAVAILABLE',
        message: 'media generation policy is unavailable for this run',
      };
    }
    return { ok: true, policy: run.mediaExecution ?? defaultMediaExecutionPolicy() };
  };

  const mediaAnalyticsContext = async (
    req: any,
    grant: ToolTokenGrant | null,
  ): Promise<AnalyticsContext | null> => {
    const requestContext = design.readAnalyticsContext(req);
    if (requestContext) return requestContext;

    const runContext = grant?.runId
      ? design.runs.get(grant.runId)?.analyticsContext ?? null
      : null;
    if (runContext) return runContext;

    // Standalone `od media generate` requests do not carry browser analytics
    // headers or a parent run. Match the updater's daemon-internal identity
    // fallback, but only after explicit metrics consent; capture() re-checks
    // the same consent before sending.
    const appConfig = await readAppConfig(RUNTIME_DATA_DIR).catch(() => null);
    const installationId =
      appConfig?.telemetry?.metrics === true
      && typeof appConfig.installationId === 'string'
      && appConfig.installationId
        ? appConfig.installationId
        : null;
    if (!installationId) return null;
    return {
      deviceId: installationId,
      sessionId: installationId,
      clientType: 'desktop',
      locale: 'en',
      requestId: null,
    };
  };

  /**
   * In-flight generations' cancel handles, keyed by task id. Owned here
   * because the route that starts a generation is the only place its worker
   * exists; a task hydrated after a restart has no worker to abort.
   */
  const mediaTaskAborts = new Map<string, AbortController>();

  const handleGenerate = async (
    req: any,
    res: any,
    options: GenerateOptions,
  ): Promise<LiveMediaTask | null> => {
    const projectId = options.projectId;
    const body: Record<string, any> = options.body ?? req.body ?? {};
    const project = getProject(db, projectId);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return null;
    }

    const surface = body?.surface;
    if (surface !== 'image' && surface !== 'video' && surface !== 'audio') {
      sendApiError(res, 400, 'BAD_REQUEST', 'surface must be image, video, or audio');
      return null;
    }
    const model = typeof body?.model === 'string' ? body.model : '';
    if (!model) {
      sendApiError(res, 400, 'BAD_REQUEST', 'model is required');
      return null;
    }

    const policy = mediaPolicyForGrant(options.grant);
    if (!policy.ok) {
      sendApiError(res, 403, policy.code, policy.message);
      return null;
    }
    const denial = mediaPolicyDenial(policy.policy, { surface, model });
    if (denial) {
      sendApiError(res, 403, denial.code, denial.message);
      return null;
    }

    // An explicit edit: the new output derives from an earlier one in this
    // project. Internal callers (retry) pass their own lineage instead.
    let lineageParent = options.lineage?.parent;
    if (!lineageParent && body?.parentTaskId !== undefined) {
      const parentId = typeof body.parentTaskId === 'string' ? body.parentTaskId.trim() : '';
      const parent = parentId ? getMediaLineage(db, parentId) : null;
      if (!parent || parent.projectId !== projectId) {
        sendApiError(res, 400, 'BAD_REQUEST', 'parentTaskId must name a media task in this project');
        return null;
      }
      lineageParent = { taskId: parent.taskId, relation: 'edit' };
    }

    /**
     * The dual of `attachLateOutputToRunMessage` below: hand the FAILURE back to
     * the turn that asked for it.
     *
     * Every failure path here already knew which run this was — `runId` is right
     * there in `options.grant`, printed in the `[media]` diagnostic and shipped
     * to analytics — and none of them wrote it anywhere the run could see. So
     * the run's terminal verdict came from the agent's exit code alone: the
     * agent apologises in prose and exits 0, and the turn published
     * `status: "succeeded"`, `endedWithUnfinishedWork: false`, a green check and
     * an empty artifact rail while the daemon's own log said the only
     * deliverable had failed 55s earlier.
     *
     * Declared outside the try so BOTH failure paths reach it: the async
     * provider rejection AND the synchronous dispatch throw below, which marks
     * the same task failed and would otherwise stay silent for the same reason.
     *
     * Best-effort by construction: the task is already marked failed and its
     * waiters already told, so this must never turn a recorded failure into an
     * unhandled rejection.
     */
    const reportFailureToRun = (taskId: string, error: unknown): void => {
      // A user cancel is not a failed deliverable the run must answer for.
      if (mediaTaskInterruptReason(task?.status ?? '', task?.error?.code) === 'user-cancelled') return;
      const runId = options.grant?.runId;
      if (!runId || !taskId) return;
      try {
        design.runs.noteMediaTaskFailure(runId, {
          taskId,
          surface,
          model,
          failedAt: Date.now(),
          error,
        });
      } catch (err) {
        console.warn('[media] run failure association failed', err);
      }
    };

    let task: ReturnType<typeof createMediaTask> | null = null;
    try {
      const taskId = randomUUID();
      const analyticsContext = await mediaAnalyticsContext(req, options.grant);
      let providerRequestSummary:
        | (ImageGenerationRequestSummary & { providerId: string })
        | null = null;
      const requestedProviderId = mediaProviderId(model);
      // The durable history row comes FIRST, before the live task exists: for
      // a retry it is the idempotency record, and losing the race for the key
      // (MediaIdempotencyKeyTakenError) must leave nothing behind — no task,
      // no failure. For every other generation it is evidence, not a
      // precondition: a failed write costs the gallery one entry, never the
      // user their generation.
      try {
        recordMediaTaskLineage(db, {
          taskId,
          projectId,
          status: 'queued',
          createdAt: Date.now(),
          surface,
          model,
          providerId: requestedProviderId,
          request: sanitizeMediaRequestRecord(body),
          parent: lineageParent,
          idempotencyKey: options.lineage?.idempotencyKey,
          idempotencyPrincipal: options.lineage?.idempotencyPrincipal,
        });
      } catch (err) {
        if (options.lineage?.idempotencyKey) throw err;
        console.warn('[media] lineage record failed', err);
      }
      task = createMediaTask(taskId, projectId, {
        surface: body?.surface,
        model: body?.model,
        runId: options.grant?.runId,
      });
      const cancelController = new AbortController();
      mediaTaskAborts.set(taskId, cancelController);
      const diagnosticContext = {
        taskId,
        runId: options.grant?.runId,
        projectId,
        surface,
        model,
      };
      console.error(formatMediaTaskDiagnostic({
        ...diagnosticContext,
        event: 'queued',
        providerId: requestedProviderId,
        status: task.status,
        referenceImageCount: Array.isArray(body?.images)
          ? body.images.length
          : body?.image
            ? 1
            : 0,
        hasCompositionDir: Boolean(body?.compositionDir),
      }));

      /**
       * Hand this task's output back to the turn that asked for it.
       *
       * A media generation is a 202 dispatch: the file can land long after the
       * run went terminal, and the run-terminal produced-file floor works off a
       * filesystem diff frozen before these bytes existed (Plane OPEND-2608 /
       * OPEND-2609). `associateLateRunProducedFile` is additive and refuses to
       * act while the run is still live, so the terminal pass keeps ownership
       * of every file that DID land in time.
       *
       * Resolves the project directory exactly the way `generateMedia` does
       * (`ensureProject(projectsRoot, projectId)` — no metadata), so this points
       * at the bytes that were actually written.
       */
      const attachLateOutputToRunMessage = async (meta: unknown): Promise<void> => {
        const runId = options.grant?.runId;
        const name =
          meta && typeof meta === 'object' && typeof (meta as { name?: unknown }).name === 'string'
            ? (meta as { name: string }).name
            : '';
        if (!runId || !name) return;
        try {
          await associateLateRunProducedFile(db, {
            runId,
            projectRoot: resolveProjectDir(PROJECTS_DIR, projectId),
            projectRelativePath: name,
          });
        } catch (err) {
          console.warn('[media] late produced-file association failed', err);
        }
      };

      const proxyDispatcher = proxyDispatcherRequestInit(process.env, {
        headersTimeout: LONG_MEDIA_PROXY_TIMEOUT_MS,
        bodyTimeout: LONG_MEDIA_PROXY_TIMEOUT_MS,
      });
      task.status = 'running';
      persistMediaTask(task);
      const liveTask = task;
      /** True once the user cancelled: nothing may move the task off that state. */
      const wasCancelled = () => liveTask.status !== 'running';
      // Media billing follows the project's Workspace binding, not its sharing
      // visibility. A private project inside a team Workspace must still spend
      // that Workspace's balance; `findTeamWorkspaceIdForProject` deliberately
      // answers the narrower collaboration question and excludes it.
      const workspaceId =
        getWorkspaceProjectByProjectId(db, projectId)?.workspaceId?.trim() || undefined;
      generateMedia({
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        surface: body?.surface,
        model: body?.model,
        prompt: body?.prompt,
        output: body?.output,
        aspect: body?.aspect,
        quality: typeof body?.quality === 'string' ? body.quality : undefined,
        resolution: typeof body?.resolution === 'string' ? body.resolution : undefined,
        length:
          typeof body?.length === 'number' ? body.length : undefined,
        duration:
          typeof body?.duration === 'number'
            ? body.duration
            : undefined,
        voice: body?.voice,
        audioKind: body?.audioKind,
        language: typeof body?.language === 'string' ? body.language : undefined,
        loop: typeof body?.loop === 'boolean' ? body.loop : undefined,
        promptInfluence: typeof body?.promptInfluence === 'number'
          ? body.promptInfluence
          : undefined,
        compositionDir: body?.compositionDir,
        image: body?.image,
        images: Array.isArray(body?.images) ? body.images : undefined,
        workspaceId,
        // Strong capture path (spec §5.1.1): freeze the provider's own bytes
        // the moment they land, so a later turn overwriting the same output
        // name can never rewrite this message's history. Bound to THIS run and
        // task, so the run-terminal pass can reuse it verbatim instead of
        // re-reading a file that may already have moved on.
        onBytesWritten: async (written: {
          bytes: Buffer;
          name: string;
          mime: string;
          kind: string;
          mtime: number;
        }) => {
          // A cancelled task's late bytes are not its output; never snapshot
          // them into the run's chat history.
          if (wasCancelled()) return;
          await captureChatArtifactSnapshotFromBytes(
            { db, blobs: chatArtifactBlobs, quota: chatArtifactQuota },
            {
              projectId,
              projectRelativePath: written.name,
              kind: written.kind,
              mime: written.mime,
              bytes: written.bytes,
              sourceMtime: written.mtime,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              mediaTaskId: taskId,
            },
          );
        },
        onProgress: (line: any) => {
          if (!wasCancelled()) appendTaskProgress(liveTask, line);
        },
        requestInit: proxyDispatcher.requestInit,
        signal: cancelController.signal,
        onProviderRequestSettled: (summary: ImageGenerationRequestSummary & { providerId: string }) => {
          providerRequestSummary = summary;
        },
      })
        .then(async (meta: any) => {
          if (wasCancelled()) {
            // The bytes were already on disk when the cancel arrived. They
            // stay in the project (a cancel never deletes files) but are not
            // adopted as this task's output.
            const name = typeof meta?.name === 'string' ? meta.name : 'output';
            appendTaskProgress(liveTask, `output ${name} landed before the cancel took effect; it is not this task's output`);
            return;
          }
          task.status = 'done';
          task.file = meta;
          task.endedAt = Date.now();
          persistMediaTask(task);
          if (analyticsContext && providerRequestSummary) {
            captureMediaGenerationResult({
              analyticsContext,
              durationMs: task.endedAt - task.startedAt,
              meta,
              model,
              projectId,
              providerRequestSummary,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              surface,
              taskId,
            });
          }
          notifyTaskWaiters(task);
          console.error(formatMediaTaskDiagnostic({
            ...diagnosticContext,
            event: 'done',
            providerId: meta?.providerId ?? providerRequestSummary?.providerId ?? requestedProviderId,
            status: task.status,
            elapsedMs: task.endedAt - task.startedAt,
            fileSize: typeof meta?.size === 'number' ? meta.size : undefined,
            mime: typeof meta?.mime === 'string' ? meta.mime : undefined,
          }));
          // Last, and only after the waiters have been told: this generation
          // may have outlived the turn that asked for it, and the run-terminal
          // floor froze its file list before these bytes existed. Attach them
          // to that turn now, additively. A no-op whenever the run is still
          // live — the terminal pass covers that case on its own.
          await attachLateOutputToRunMessage(meta);
        })
        .catch((err: any) => {
          // Cancelled: the abort is the expected way this promise ends.
          if (wasCancelled()) return;
          task.status = 'failed';
          task.error = mediaTaskErrorFromFailure(err, { model });
          task.endedAt = Date.now();
          persistMediaTask(task);
          if (analyticsContext && providerRequestSummary) {
            captureMediaGenerationResult({
              analyticsContext,
              durationMs: task.endedAt - task.startedAt,
              model,
              projectId,
              providerRequestSummary,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              surface,
              taskId,
            });
          }
          notifyTaskWaiters(task);
          console.error(formatMediaTaskDiagnostic({
            ...diagnosticContext,
            event: 'failed',
            providerId: providerRequestSummary?.providerId ?? requestedProviderId,
            status: task.error.status,
            code: task.error.code,
            elapsedMs: task.endedAt - task.startedAt,
            error: task.error.message,
          }));
          // Last, and only after the waiters have been told: the run that asked
          // for this generation must not be able to report itself complete when
          // the host just watched its deliverable fail.
          reportFailureToRun(taskId, task.error);
        })
        .finally(() => {
          mediaTaskAborts.delete(taskId);
          return proxyDispatcher.close();
        });

      res.status(202).json(
        options.acceptedBody
          ? options.acceptedBody(task)
          : { taskId, status: task.status, startedAt: task.startedAt },
      );
      return task;
    } catch (err: any) {
      if (task) mediaTaskAborts.delete(task.id);
      if (task && task.status !== 'interrupted') {
        task.status = 'failed';
        task.error = mediaTaskErrorFromFailure(err, { model });
        task.endedAt = Date.now();
        persistMediaTask(task);
        notifyTaskWaiters(task);
        console.error(formatMediaTaskDiagnostic({
          event: 'failed',
          taskId: task.id,
          runId: options.grant?.runId,
          projectId,
          surface,
          model,
          providerId: mediaProviderId(model),
          status: task.error.status,
          code: task.error.code,
          elapsedMs: task.endedAt - task.startedAt,
          error: task.error.message,
        }));
        // Same invariant as the async rejection above: a dispatch that threw
        // before the provider was ever reached is still a generation this run
        // asked for and did not get.
        reportFailureToRun(task.id, task.error);
      }
      throw err;
    }
  };

  const handleHyperFramesScaffold = async (
    req: any,
    res: any,
    projectId: string,
  ) => {
    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const body = (req.body ?? {}) as Partial<HyperFramesScaffoldRequest>;
    if (typeof body.compositionDir !== 'string' || !body.compositionDir.trim()) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'compositionDir is required');
    }
    const projectDir = resolveProjectDir(PROJECTS_DIR, project.id, project.metadata);
    const result: HyperFramesScaffoldResponse = await scaffoldHyperFramesComposition({
      projectDir,
      compositionDir: body.compositionDir,
    });
    return res.status(201).json(result);
  };

  const captureMediaGenerationResult = (input: {
    analyticsContext: AnalyticsContext;
    durationMs: number;
    meta?: { providerError?: string | null; usedStubFallback?: boolean };
    model: string;
    projectId: string;
    providerRequestSummary: ImageGenerationRequestSummary & { providerId: string };
    runId?: string;
    surface: 'image' | 'video' | 'audio';
    taskId: string;
  }) => {
    const summary = input.providerRequestSummary;
    const props = {
      page_name: 'studio',
      area: 'media_generation',
      project_id: input.projectId,
      task_id: input.taskId,
      ...(input.runId ? { run_id: input.runId } : {}),
      surface: input.surface,
      provider_id: summary.providerId,
      model_id: input.model,
      result: input.meta && !input.meta.providerError && !input.meta.usedStubFallback
        ? 'success'
        : 'failed',
      ...(summary.initialResponseStatus !== undefined
        ? { initial_response_status: summary.initialResponseStatus }
        : {}),
      ...(summary.responseStatus !== undefined
        ? { response_status: summary.responseStatus }
        : {}),
      attempt_count: summary.attemptCount,
      retry_count: summary.retryCount,
      ...(summary.retryReason ? { retry_reason: summary.retryReason } : {}),
      ...(summary.retryAfterMs !== undefined
        ? { retry_after_ms: summary.retryAfterMs }
        : {}),
      ...(summary.retryDelayMs !== undefined
        ? { retry_delay_ms: summary.retryDelayMs }
        : {}),
      retry_final_result: summary.retryFinalResult,
      duration_ms: Math.max(0, input.durationMs),
      used_stub_fallback: input.meta?.usedStubFallback === true,
    } satisfies MediaGenerationResultProps;

    try {
      design.analytics.capture({
        eventName: 'media_generation_result',
        context: input.analyticsContext,
        appVersion: design.getAppVersion(),
        properties: props,
        insertId: `media_generation_result:${input.taskId}`,
      });
    } catch {
      // Analytics is best-effort and must not change the media task outcome.
    }
  };
  app.get('/api/media/models', (_req, res) => {
    res.json({
      providers: MEDIA_PROVIDERS,
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
      audio: AUDIO_MODELS_BY_KIND,
      aspects: MEDIA_ASPECTS,
      videoLengthsSec: VIDEO_LENGTHS_SEC,
      audioDurationsSec: AUDIO_DURATIONS_SEC,
    });
  });

  // Live AIHubMix media catalogue. The static IMAGE_MODELS registry only
  // seeds a couple of AIHubMix entries; the picker calls this to list the full
  // image-generation catalogue straight from AIHubMix
  // (GET /api/v1/models?type=image_generation, public). Ids are prefixed
  // `aihubmix-` so they stay unique and route through the AIHubMix renderer
  // (which strips the prefix to the wire name). Falls back to the cached copy
  // on upstream failure so a transient blip doesn't empty the picker.
  app.get('/api/media/providers/aihubmix/models', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const raw = req.query.type;
    const type: AIHubMixCatalogType =
      raw === 'llm' || raw === 'video' || raw === 'tts'
        ? raw
        : 'image_generation';
    // This is an unauthenticated, public GET. The AIHubMix catalogue lives at a
    // single fixed origin, so we deliberately do NOT honour a caller-supplied
    // `baseUrl` here — letting the caller pick the fetch target would open an
    // SSRF hole (e.g. pointing the daemon at http://169.254.169.254/ cloud
    // metadata). Hard-code the official origin instead; a custom BYOK base URL
    // only ever needs to differ for authenticated chat/media calls, not for
    // browsing the public model catalogue.
    const baseUrl = AIHUBMIX_DEFAULT_BASE_URL;
    const cacheKey = `${baseUrl}|${type}`;
    const cached = aihubmixCatalogCache.get(cacheKey);
    if (cached && Date.now() - cached.at < AIHUBMIX_CATALOG_TTL_MS) {
      return res.json({ ok: true, cached: true, models: cached.models });
    }
    const dispatcher = proxyDispatcherRequestInit();
    try {
      const resp = await fetch(aihubmixCatalogUrl(baseUrl, type), {
        ...dispatcher.requestInit,
        method: 'GET',
        // The catalogue endpoint is public — no auth header (sending an empty
        // Bearer would be rejected by some gateways).
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        if (cached) return res.json({ ok: true, stale: true, models: cached.models });
        return res.status(502).json({ ok: false, detail: `aihubmix catalog ${resp.status}` });
      }
      const data = await resp.json();
      const models = parseAIHubMixCatalog(data).map((m) => ({
        id: `aihubmix-${m.id}`,
        label: m.label,
      }));
      aihubmixCatalogCache.set(cacheKey, { at: Date.now(), models });
      return res.json({ ok: true, models });
    } catch (err: any) {
      if (cached) return res.json({ ok: true, stale: true, models: cached.models });
      return res
        .status(502)
        .json({ ok: false, detail: String(err && err.message ? err.message : err) });
    } finally {
      await dispatcher.close();
    }
  });

  app.post('/api/media/higgsfield/login', (_req, res) => {
    try {
      startHiggsfieldSubscriptionLogin();
      const result: HiggsfieldSubscriptionLoginResponse = { provider: 'higgsfield', status: 'pending' };
      res.status(202).json(result);
    } catch { res.status(503).json({ error: 'HiggsField CLI is unavailable. Update Mishh Mashh.' }); }
  });

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err: any) {
      sendInternalError(res, err);
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/media/providers/elevenlabs/voices', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
      const proxyDispatcher = proxyDispatcherRequestInit(process.env);
      try {
        const voices = await listElevenLabsVoiceOptions(PROJECT_ROOT, {
          limit,
          requestInit: proxyDispatcher.requestInit,
        });
        res.json({ voices });
      } finally {
        await proxyDispatcher.close();
      }
    } catch (err: any) {
      const message = String(err && err.message ? err.message : err);
      const status = message.includes('no ElevenLabs API key') ? 400 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      res.json({ config });
    } catch (err: any) {
      sendInternalError(res, err);
    }
  });

  app.put('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    // B4-1: defense in depth only. A request that declares a workspace member
    // identity cannot change the adoption executor switch, but the absence of
    // those headers proves nothing (any loopback caller can omit them). The
    // switch is therefore not an authority: it can only close the executor,
    // and a closure latches until the owner restarts the daemon with the
    // process opt-in (adoption-provisioning.ts createAdoptionLabsSwitch).
    if (
      req.body && typeof req.body === 'object' && Object.hasOwn(req.body, 'placementAdoptionExecutor')
      && (req.get('x-od-workspace-id') !== undefined || req.get('x-od-workspace-member-id') !== undefined)
    ) {
      return sendApiError(res, 403, 'FORBIDDEN', 'A request with a workspace member identity cannot change the adoption executor switch', {
        details: { reason: 'local-owner-required', key: 'placementAdoptionExecutor' },
      });
    }
    try {
      const currentConfig = await readAppConfig(RUNTIME_DATA_DIR);
      if (
        req.body?.orbit
        && typeof req.body.orbit === 'object'
        && Object.hasOwn(req.body.orbit, 'workspaceScope')
        && JSON.stringify(req.body.orbit) !== JSON.stringify(currentConfig.orbit)
      ) {
        const scope = normalizePersistedAutomationWorkspaceScope(
          req.body.orbit.workspaceScope,
        );
        if (req.body.orbit.workspaceScope !== null && !scope) {
          return res.status(400).json({
            error: 'Orbit Workspace scope must contain workspaceId and workspaceMemberId',
            code: 'WORKSPACE_CONTEXT_INCOMPLETE',
          });
        }
        if (scope) {
          const claimedWorkspaceId = String(req.get('x-od-workspace-id') ?? '').trim();
          const claimedMemberId = String(req.get('x-od-workspace-member-id') ?? '').trim();
          if (
            claimedWorkspaceId !== scope.workspaceId
            || claimedMemberId !== scope.workspaceMemberId
          ) {
            return res.status(400).json({
              error: 'Orbit Workspace scope must match the explicit request identity',
              code: 'WORKSPACE_CONTEXT_INCOMPLETE',
            });
          }
        }
      }
      const config = await writeAppConfig(RUNTIME_DATA_DIR, req.body);
      orbitService.configure(config.orbit);
      onAppConfigWritten?.(config);
      res.json({ config });
    } catch (err: any) {
      if (err?.code === 'INVALID_APP_CONFIG_VALUE') {
        // Nested envelope on purpose. `od`'s error reader only finds a code in
        // this shape; from a flat body it falls back to `daemon-not-running`
        // and exits 64, which tells a caller to go start a daemon that just
        // answered. Rejected input should read as a plain failure.
        return res.status(400).json({
          error: { code: err.code, message: String(err.message) },
        });
      }
      const status = err?.code === 'WORKSPACE_ACCESS_DENIED'
          ? 403
          : 500;
      res
        .status(status)
        .json({
          error: String(err && err.message ? err.message : err),
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.retryable ? { retryable: true } : {}),
        });
    }
  });

  const probeDirectory = createDirectoryProbe();

  // Lightweight existence probe for a single directory, used by the composer
  // to flag a working directory in red the moment its folder is gone (the
  // composer re-checks on focus / picker-open, so deletions reflect live).
  app.post('/api/dir-exists', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const dir = typeof req.body?.path === 'string' ? req.body.path : '';
    const state = dir ? await probeDirectory(dir) : 'missing';
    const body: DirectoryExistsResponse = state === 'exists' || state === 'missing'
      ? { exists: state === 'exists' }
      : { exists: null, status: 'unknown', reason: state };
    res.json(body);
  });

  // Recent directories are probed concurrently. Confirmed missing folders
  // are pruned from config; temporarily unavailable mounts are only hidden.
  app.get('/api/recent-dirs', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      const recents = Array.isArray(config.recentLinkedDirs)
        ? config.recentLinkedDirs
        : [];
      const states = await Promise.all(recents.map((dir: string) => probeDirectory(dir)));
      const existing = recents.filter((_dir: string, index: number) => states[index] === 'exists');
      // A timeout or permission failure is not proof of deletion. Hide an
      // unavailable mount for this response but preserve it for the next probe.
      const retained = recents.filter((_dir: string, index: number) => states[index] !== 'missing');
      if (retained.length !== recents.length) {
        await writeAppConfig(RUNTIME_DATA_DIR, { recentLinkedDirs: retained });
      }
      /** @type {import('@open-design/contracts').RecentLinkedDirsResponse} */
      const body = { dirs: existing };
      res.json(body);
    } catch (err: any) {
      sendInternalError(res, err);
    }
  });

  app.get('/api/orbit/status', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      res.json(await orbitService.status());
    } catch (err: any) {
      sendInternalError(res, err);
    }
  });

  app.post('/api/orbit/run', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const locale = typeof req.body?.locale === 'string' ? req.body.locale : null;
      res.json(await orbitService.start('manual', { locale }));
    } catch (err: any) {
      const status = err?.code === 'WORKSPACE_ACCESS_DENIED'
          ? 403
          : 500;
      res
        .status(status)
        .json({
          error: String(err && err.message ? err.message : err),
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.retryable ? { retryable: true } : {}),
        });
    }
  });

  app.post('/api/system/open-external', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ ok: false, error: 'url must be a valid URL' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'url must be http or https' });
      }
      const child = openBrowser(parsed.toString());
      res.json({ ok: Boolean(child) });
    } catch (err: any) {
      sendInternalError(res, err, 'INTERNAL_ERROR', 'internal server error', { ok: false });
    }
  });

  // Native OS folder picker dialog. Returns { path: string | null }.
  app.post('/api/dialog/open-folder', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const selected = await openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err: any) {
      sendInternalError(res, err);
    }
  });

  app.post('/api/projects/:id/media/hyperframes/scaffold', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error: 'cross-origin request rejected: HyperFrames scaffolding is restricted to the local UI / CLI',
      });
    }
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        project.id,
        { mode: 'write', capability: 'writeFiles' },
      )) return;
      await handleHyperFramesScaffold(req, res, project.id);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post(HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT, async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'media:scaffold', {
      endpoint: HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT,
    });
    if (!grant) return;
    try {
      if (!await ctx.authorizeProjectToolRequest(
        res,
        grant.projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;
      await handleHyperFramesScaffold(req, res, grant.projectId);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/projects/:id/media/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: media generation is restricted to the local UI / CLI',
      });
    }

    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        project.id,
        { mode: 'write', capability: 'writeFiles' },
      )) return;
      const grant = optionalToolGrantFromRequest(req, { operation: 'media:generate' });
      const grantDecision = resolveLegacyMediaRouteGrant({
        grant,
        projectId: req.params.id,
        requestProjectOverride,
        sandboxMode: isSandboxModeEnabled(process.env),
      });
      if (!grantDecision.ok) {
        return sendApiError(
          res,
          grantDecision.status,
          grantDecision.code,
          grantDecision.message,
          grantDecision.details ? { details: grantDecision.details } : {},
        );
      }
      await handleGenerate(req, res, { projectId: req.params.id, grant: grantDecision.grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/tools/media/generate', async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'media:generate');
    if (!grant) return;
    try {
      if (!await ctx.authorizeProjectToolRequest(
        res,
        grant.projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;
      await handleGenerate(req, res, { projectId: grant.projectId, grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/research/search', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: research search is restricted to the local UI / CLI',
      });
    }

    try {
      const proxyDispatcher = proxyDispatcherRequestInit(process.env);
      try {
        const result = await searchResearch({
          projectRoot: PROJECT_ROOT,
          query: req.body?.query,
          maxSources:
            typeof req.body?.maxSources === 'number'
              ? req.body.maxSources
              : undefined,
          providers: Array.isArray(req.body?.providers)
            ? req.body.providers
            : undefined,
          requestInit: proxyDispatcher.requestInit,
        });
        res.json(result);
      } finally {
        await proxyDispatcher.close();
      }
    } catch (err: any) {
      if (err instanceof ResearchError) {
        return res.status(err.status).json({
          error: { code: err.code, message: err.message },
        });
      }
      res.status(500).json({
        error: {
          code: 'RESEARCH_FAILED',
          message: String(err && err.message ? err.message : err),
        },
      });
    }
  });

  /**
   * Where a done task's output is NOW, judged by the bytes it wrote.
   *
   * One truth for the wait endpoint and the project task list, so they agree
   * whichever is asked first:
   *   - the recorded name still holds the task's bytes → current;
   *   - otherwise a unique project file with the recorded size and mtime (a
   *     move preserves both) that ALSO holds the task's bytes → moved there;
   *   - otherwise the output was overwritten or deleted → superseded, and the
   *     task names no file.
   * Tasks from before the digest existed, and outputs the daemon cannot read
   * right now (EMFILE, EACCES), cannot be judged ('unverifiable') and keep
   * the old name-based behaviour: an I/O error is never a superseded output.
   *
   * The directory is the one generateMedia writes into
   * (`ensureProject(PROJECTS_DIR, projectId)`, no metadata).
   */
  const locateDoneMediaTaskOutput = async (
    projectId: string,
    taskFile: unknown,
    projectFiles: () => Promise<readonly ProjectFile[]>,
    claimedNames: ReadonlySet<string> = new Set(),
    /**
     * How bytes are compared. The gallery passes a budgeted, cached,
     * realpath-contained matcher so every hash it triggers (including the
     * moved-file candidates below) is charged and bounded.
     */
    matchBytes: typeof mediaOutputMatches = mediaOutputMatches,
    // Gallery/copy supply the registered root; legacy generation waits retain
    // the managed generation root until generation itself adopts metadata.
    projectDir?: string,
  ): Promise<
    | { kind: 'unverifiable' }
    | { kind: 'current' }
    | { kind: 'moved'; file: ProjectFile }
    | { kind: 'superseded'; error: MediaTaskError; verdict: 'mismatch' | 'missing' }
  > => {
    const record = mediaOutputRecord(taskFile);
    if (!record) return { kind: 'unverifiable' };
    const dir = projectDir ?? resolveProjectDir(PROJECTS_DIR, projectId);
    const target = mediaOutputPath(dir, record.name);
    const verdict = target ? await matchBytes(target, record) : 'missing';
    if (verdict === 'match') return { kind: 'current' };
    // An I/O error (EMFILE, EACCES) proves nothing about the bytes: never
    // report it as superseded.
    if (verdict === 'unreadable') return { kind: 'unverifiable' };
    let files: readonly ProjectFile[];
    try {
      files = await projectFiles();
    } catch {
      return { kind: 'unverifiable' };
    }
    const claimed = new Set([...claimedNames, record.name]);
    const matches: ProjectFile[] = [];
    for (const candidate of mediaTaskFileCandidates(taskFile, files, claimed)) {
      const candidatePath = mediaOutputPath(dir, candidate.name);
      if (!candidatePath) continue;
      const candidateVerdict = await matchBytes(candidatePath, record);
      if (candidateVerdict === 'unreadable') return { kind: 'unverifiable' };
      if (candidateVerdict === 'match') matches.push(candidate);
    }
    if (matches.length === 1) return { kind: 'moved', file: matches[0]! };
    return { kind: 'superseded', error: supersededMediaOutputErrorFor(record.name, verdict), verdict };
  };

  app.post('/api/media/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const authorizationHeader = req.get('authorization');
    // Once a caller chooses the tool-token lane, invalid, expired, or
    // under-scoped credentials must not downgrade to project authorization.
    const toolGrant = typeof authorizationHeader === 'string'
      ? authorizeToolRequest(
          req,
          res,
          'media:generate',
          { endpoint: MEDIA_TASK_WAIT_TOOL_ENDPOINT },
        )
      : null;
    if (typeof authorizationHeader === 'string' && !toolGrant) return;
    if (
      toolGrant
      && !await ctx.authorizeProjectToolRequest(
        res,
        toolGrant.projectId,
        { mode: 'read' },
      )
    ) return;

    // Token callers must prove their grant targets the persisted local project
    // before task lookup; cloud availability is irrelevant to this local wait.
    const taskId = req.params.id;
    const task = getLiveMediaTask(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (toolGrant) {
      if (requestProjectOverride(task.projectId, toolGrant.projectId)) {
        return sendApiError(
          res,
          403,
          'FORBIDDEN',
          'media task belongs to a different project',
        );
      }
    } else if (!await ctx.authorizeProjectRequest(
      req,
      res,
      task.projectId,
      { mode: 'read' },
    )) {
      return;
    }

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = async () => {
      if (res.writableEnded || res.destroyed) return;
      const snapshot = mediaTaskSnapshot(task, since);
      if (snapshot.status === 'done') {
        // A done result may name a file only while it holds the bytes this
        // task wrote (see locateDoneMediaTaskOutput).
        try {
          const located = await locateDoneMediaTaskOutput(
            task.projectId,
            task.file,
            () => listFiles(PROJECTS_DIR, task.projectId),
          );
          if (located.kind === 'moved') {
            task.file = reconciledMediaTaskFile(task.file, located.file);
            persistMediaTask(task);
            snapshot.file = task.file;
          } else if (located.kind === 'superseded') {
            delete snapshot.file;
            snapshot.error = located.error;
          }
        } catch (err) {
          console.warn('[media] output witness check failed', err);
        }
      }
      if (res.writableEnded || res.destroyed) return;
      res.json(snapshot);
    };

    if (
      task.status === 'done' ||
      task.status === 'failed' ||
      task.status === 'interrupted' ||
      task.progress.length > since
    ) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      void respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/media/tasks', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const projectId = req.params.id;
    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    if (!await ctx.authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const taskRows = listMediaTasksByProject(db, projectId, {
      includeTerminal: includeDone,
    });
    const confirmedFiles = new Map<string, ProjectFile>();
    const movedCandidates: typeof taskRows = [];
    // Tasks that recorded a digest are judged by their bytes, the same way the
    // wait endpoint judges them (locateDoneMediaTaskOutput). That needs the
    // listing and the generation to share a directory; an imported-folder
    // project does not (generateMedia writes outside its baseDir), so it
    // keeps the name-based path below.
    const witnessTasks: typeof taskRows = [];
    const supersededOutputs = new Map<string, MediaTaskError>();
    const sharesGenerationDir =
      resolveProjectDir(PROJECTS_DIR, projectId, project.metadata) === resolveProjectDir(PROJECTS_DIR, projectId);
    const listing: { files?: Promise<ProjectFile[]> } = {};
    const projectFiles = (): Promise<ProjectFile[]> =>
      (listing.files ??= listFiles(PROJECTS_DIR, projectId, { metadata: project.metadata }));
    if (includeDone && taskRows.some((task: any) => task.status === 'done')) {
      await Promise.all(taskRows.map(async (task: any) => {
        if (task.status !== 'done') return;
        const name = typeof task.file?.name === 'string' ? task.file.name.trim() : '';
        if (!name) return;
        if (sharesGenerationDir && mediaOutputRecord(task.file)) {
          witnessTasks.push(task);
          return;
        }
        try {
          confirmedFiles.set(
            task.id,
            await resolveProjectFilePath(PROJECTS_DIR, projectId, name, project.metadata),
          );
        } catch {
          if (finiteNumber(task.file?.size) !== null && finiteNumber(task.file?.mtime) !== null) {
            movedCandidates.push(task);
          }
        }
      }));
    }
    if (witnessTasks.length > 0) {
      // Pass 1: outputs still at their recorded name claim it first.
      const unresolved: typeof taskRows = [];
      await mapWithConcurrency(witnessTasks, MEDIA_OUTPUT_HASH_CONCURRENCY, async (task: any) => {
        const located = await locateDoneMediaTaskOutput(projectId, task.file, async () => []);
        // 'unverifiable' (an I/O error, not a proven mismatch) keeps the
        // name-based answer: it must never read as superseded.
        if (located.kind !== 'current' && located.kind !== 'unverifiable') {
          unresolved.push(task);
          return;
        }
        try {
          confirmedFiles.set(
            task.id,
            await resolveProjectFilePath(PROJECTS_DIR, projectId, task.file.name.trim(), project.metadata),
          );
        } catch {
          unresolved.push(task);
        }
      });
      // Pass 2: the rest follow their bytes, never onto a claimed name.
      for (const task of unresolved as any[]) {
        const claimedNames = new Set([...confirmedFiles.values()].map((file) => file.name));
        const located = await locateDoneMediaTaskOutput(projectId, task.file, projectFiles, claimedNames);
        if (located.kind === 'moved') confirmedFiles.set(task.id, located.file);
        else if (located.kind === 'superseded') supersededOutputs.set(task.id, located.error);
      }
    }
    if (movedCandidates.length > 0) {
      try {
        const listedFiles = await projectFiles();
        // Files a task still resolves by its recorded path are already
        // spoken for; a moved task must not take one of them.
        const claimedNames = new Set(
          [...confirmedFiles.values()].map((file) => file.name),
        );
        const resolved = resolveMovedMediaTaskFiles(
          movedCandidates.map((task: any) => ({ taskId: task.id, file: task.file })),
          listedFiles,
          claimedNames,
        );
        for (const [taskId, file] of resolved) confirmedFiles.set(taskId, file);
      } catch {
        // Task status remains useful when an imported folder is temporarily
        // unavailable. Omit unconfirmed files and let the client's bounded
        // terminal poll reconcile them if the project root returns.
      }
    }
    const batches = assignMediaTaskBatches(taskRows.map((task: any) => ({
      id: task.id,
      runId: task.runId,
      surface: task.surface,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      sequence: task.sequence,
    })));
    const tasks = taskRows.map((t: any) => {
      const resolvedFile = confirmedFiles.get(t.id) ?? null;
      let confirmedFile: Record<string, unknown> | null = null;
      if (resolvedFile) {
        confirmedFile = reconciledMediaTaskFile(t.file, resolvedFile);
        if ((t.file as { name?: unknown } | null)?.name !== resolvedFile.name) {
          const liveTask = getLiveMediaTask(t.id);
          if (liveTask) {
            liveTask.file = confirmedFile;
            persistMediaTask(liveTask);
          }
        }
      }
      const batch = batches.get(t.id);
      return {
        taskId: t.id,
        sequence: t.sequence,
        ...(batch ?? {}),
        ...(t.runId ? { runId: t.runId } : {}),
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
        surface: t.surface,
        model: t.model,
        progress: t.progress.slice(-3),
        progressCount: t.progress.length,
        ...(confirmedFile ? { file: confirmedFile } : {}),
        ...(t.status === 'failed' || t.status === 'interrupted' ? { error: t.error } : {}),
        ...(supersededOutputs.has(t.id) ? { error: supersededOutputs.get(t.id) } : {}),
        ...(mediaTaskInterruptReason(t.status, t.error?.code)
          ? { interruptReason: mediaTaskInterruptReason(t.status, t.error?.code) }
          : {}),
      };
    });
    // Newest first, with creation order breaking the ties a parallel fan-out
    // always produces.
    tasks.sort((a: any, b: any) => (b.startedAt - a.startedAt) || (b.sequence - a.sequence));
    res.json({ tasks });
  });

  // AC-R10.1 cancel/retry and AC-R10.2 gallery. Registered from here so they
  // share this module's live task store, abort handles and output witness.
  registerMediaWorkbenchRoutes(app, {
    db,
    projectsDir: PROJECTS_DIR,
    sendApiError,
    isLocalSameOrigin: (req) => isLocalSameOrigin(req, getResolvedPort()),
    authorizeProjectRequest: ctx.authorizeProjectRequest,
    getProject,
    getLiveMediaTask,
    persistMediaTask,
    notifyTaskWaiters,
    mediaTaskAborts,
    handleGenerate,
    resolveGenerateGrant: (req, projectId) => resolveLegacyMediaRouteGrant({
      grant: optionalToolGrantFromRequest(req, { operation: 'media:generate' }),
      projectId,
      requestProjectOverride,
      sandboxMode: isSandboxModeEnabled(process.env),
    }),
    requestProjectOverride,
    locateDoneMediaTaskOutput,
    listFiles: (projectsDir, projectId) => listFiles(projectsDir, projectId, { metadata: getProject(db, projectId)?.metadata }),
    resolveProjectDir: (projectsDir, projectId) => resolveProjectDir(projectsDir, projectId, getProject(db, projectId)?.metadata),
    randomUUID,
  });

  // Multi-file upload that the chat composer uses for paste/drop/picker.
  // Files land flat in the project folder; the response carries the same
  // metadata as listFiles so the client can stage them as ChatAttachments
  // without a separate refetch.

}
