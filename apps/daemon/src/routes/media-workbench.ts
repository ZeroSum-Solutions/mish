import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import { link, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import {
  MEDIA_SAFETY_REJECTION_CODE,
  MEDIA_TASK_CANCELLED_CODE,
  isValidMediaIdempotencyKey,
  mediaFailureNextStep,
  mediaSafetyCategory,
  mediaTaskInterruptReason,
  parseMediaGalleryQuery,
  type MediaGalleryEntry,
  type MediaGalleryEntryDetail,
  type MediaGalleryFile,
  type MediaGalleryOutputState,
  type MediaGalleryResponse,
  type MediaGalleryReuseResponse,
  type MediaGalleryPlaceResponse,
  type MediaGalleryUnlinkResponse,
  type MediaTaskCancelResponse,
  type MediaTaskRetryResponse,
  type ProjectFile,
} from '@open-design/contracts';
import type Database from 'better-sqlite3';

import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { createGalleryOutputMatcher, isContainedOutputPath } from '../media/gallery-witness.js';
import {
  InvalidGalleryCursorError,
  MEDIA_LOCAL_PRINCIPAL,
  MediaIdempotencyKeyTakenError,
  findMediaLineageByIdempotencyKey,
  getMediaLineage,
  listMediaGalleryPage,
  listMediaLineageChain,
  mediaLineageInterruptReason,
  mediaLineageView,
  recordMediaTaskLineage,
  unlinkMediaLineage,
  type MediaLineageRow,
} from '../media/lineage.js';
import {
  MEDIA_OUTPUT_HASH_CONCURRENCY,
  copyVerifiedMediaOutput,
  mapWithConcurrency,
  mediaOutputMatches,
  mediaOutputPath,
  mediaOutputRecord,
} from '../media/output-witness.js';
import type { LiveMediaTask } from '../media/task-store.js';
import type { MediaTaskError } from '../media/tasks.js';
import { ensureProject } from '../projects.js';
import type { ToolTokenGrant } from '../tool-tokens.js';
import type { GenerateOptions, LegacyMediaRouteGrantDecision } from './media.js';

/**
 * Bytes one gallery request may hash to judge its outputs, moved-file
 * candidates included. Past it an entry is `unverifiable` rather than read: a
 * page of long videos must not turn a listing into a multi-gigabyte scan.
 */
export const MEDIA_GALLERY_HASH_BYTE_BUDGET = 512 * 1024 * 1024;

type LocatedOutput =
  | { kind: 'unverifiable' }
  | { kind: 'current' }
  | { kind: 'moved'; file: ProjectFile }
  | { kind: 'superseded'; error: MediaTaskError; verdict: 'mismatch' | 'missing' };

export interface MediaWorkbenchRouteDeps {
  db: Database.Database;
  projectsDir: string;
  sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown;
  isLocalSameOrigin: (req: Request) => boolean;
  authorizeProjectRequest: AuthorizeProjectRequest;
  getProject: (db: Database.Database, id: string) => { id: string; metadata?: Record<string, unknown> | null } | null | undefined;
  getLiveMediaTask: (taskId: string) => LiveMediaTask | null;
  persistMediaTask: (task: LiveMediaTask) => void;
  notifyTaskWaiters: (task: LiveMediaTask) => void;
  mediaTaskAborts: Map<string, AbortController>;
  handleGenerate: (req: Request, res: Response, options: GenerateOptions) => Promise<LiveMediaTask | null>;
  /** The same grant resolution `/api/projects/:id/media/generate` uses. */
  resolveGenerateGrant: (req: Request, projectId: string) => LegacyMediaRouteGrantDecision;
  requestProjectOverride: (projectId: string, tokenProjectId: string) => boolean;
  locateDoneMediaTaskOutput: (
    projectId: string,
    taskFile: unknown,
    projectFiles: () => Promise<readonly ProjectFile[]>,
    claimedNames?: ReadonlySet<string>,
    matchBytes?: typeof mediaOutputMatches,
    projectDir?: string,
  ) => Promise<LocatedOutput>;
  listFiles: (projectsDir: string, projectId: string) => Promise<ProjectFile[]>;
  resolveProjectDir: (projectsDir: string, projectId: string) => string;
  randomUUID: () => string;
}

function galleryFileView(file: Record<string, unknown>, name?: string): MediaGalleryFile {
  const view: MediaGalleryFile = { name: name ?? String(file.name) };
  if (typeof file.size === 'number' && Number.isFinite(file.size)) view.size = file.size;
  if (typeof file.mime === 'string') view.mime = file.mime;
  if (typeof file.kind === 'string') view.kind = file.kind;
  if (typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)) view.sha256 = file.sha256;
  return view;
}

/** Visible-path checks for a reuse target name: one plain file name, nothing else. */
function isPlainFileName(name: string): boolean {
  return name.length > 0
    && name.length <= 200
    && name === path.basename(name)
    && !name.startsWith('.')
    && !/[\u0000-\u001f\\/]/.test(name);
}

/**
 * Whose idempotency key this is. A Workspace request names its member (the
 * project authority gate has already checked the pair); anything else is the
 * single local principal.
 */
function requestPrincipal(req: Request): string {
  const member = req.get('x-od-workspace-member-id')?.trim();
  return member && member.length <= 200 ? `member:${member}` : MEDIA_LOCAL_PRINCIPAL;
}

function idempotencyKeyFrom(req: Request): unknown {
  return req.get('idempotency-key') ?? (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
}

/**
 * Run the project authority gate without letting it answer: returns whether
 * the caller may read, writing nothing to `res`. Task-addressed routes use it
 * so a caller who cannot read a task's project gets the same 404 as for a
 * task that does not exist — a 403 would prove the id is real.
 */
async function canRead(
  authorize: AuthorizeProjectRequest,
  req: Request,
  res: Response,
  projectId: string,
): Promise<boolean> {
  const silent = Object.create(res) as Response;
  silent.status = (() => silent) as unknown as Response['status'];
  silent.json = (() => silent) as unknown as Response['json'];
  silent.send = (() => silent) as unknown as Response['send'];
  silent.end = (() => silent) as unknown as Response['end'];
  return authorize(req, silent, projectId, { mode: 'read' });
}

export function registerMediaWorkbenchRoutes(app: Express, deps: MediaWorkbenchRouteDeps): void {
  const { db, sendApiError } = deps;
  /**
   * Work in flight per (project, principal, key). A second request with the
   * same key waits for the first and then replays its result, so a double
   * click or a transport retry never starts a second task or copy.
   */
  const inflight = new Map<string, Promise<void>>();
  const claimKey = async (slot: string): Promise<() => void> => {
    for (let pending = inflight.get(slot); pending; pending = inflight.get(slot)) await pending;
    let release!: () => void;
    inflight.set(slot, new Promise<void>((resolve) => { release = resolve; }));
    return () => {
      inflight.delete(slot);
      release();
    };
  };

  const refuseCrossOrigin = (req: Request, res: Response): boolean => {
    if (deps.isLocalSameOrigin(req)) return false;
    sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected: media actions are restricted to the local UI / CLI');
    return true;
  };
  const taskNotFound = (res: Response) => void sendApiError(res, 404, 'MEDIA_TASK_NOT_FOUND', 'media task not found');

  // ---------------------------------------------------------------- cancel

  app.post('/api/media/tasks/:id/cancel', async (req, res) => {
    if (refuseCrossOrigin(req, res)) return;
    const task = deps.getLiveMediaTask(String(req.params.id));
    if (!task || !await canRead(deps.authorizeProjectRequest, req, res, task.projectId)) return taskNotFound(res);
    if (!await deps.authorizeProjectRequest(req, res, task.projectId, { mode: 'write', capability: 'writeFiles' })) return;

    const alreadyCancelled = mediaTaskInterruptReason(task.status, task.error?.code) === 'user-cancelled';
    if (!alreadyCancelled && task.status !== 'queued' && task.status !== 'running') {
      return void sendApiError(
        res,
        409,
        'MEDIA_TASK_NOT_CANCELLABLE',
        `media task is ${task.status}; only a queued or running task can be cancelled`,
        { details: { status: task.status } },
      );
    }
    if (!alreadyCancelled) {
      // Terminal state first, abort second: the worker's settle handlers see
      // `interrupted` and leave it alone, whichever way the abort lands.
      task.status = 'interrupted';
      task.error = {
        message: 'cancelled by the user',
        code: MEDIA_TASK_CANCELLED_CODE,
        retryable: true,
        nextStep: mediaFailureNextStep({ code: MEDIA_TASK_CANCELLED_CODE }),
      };
      task.endedAt = Date.now();
      deps.persistMediaTask(task);
      deps.mediaTaskAborts.get(task.id)?.abort(new Error('media task cancelled by the user'));
      deps.notifyTaskWaiters(task);
    }
    const body: MediaTaskCancelResponse = {
      taskId: task.id,
      projectId: task.projectId,
      status: 'interrupted',
      interruptReason: 'user-cancelled',
      endedAt: task.endedAt ?? Date.now(),
      cancellation: {
        // No adapter exposes a provider-side cancel yet; every cancel is a
        // local abort that refuses late bytes.
        mode: 'local-abort',
        providerCancel: 'unsupported',
        alreadyCancelled,
      },
    };
    res.json(body);
  });

  // ----------------------------------------------------------------- retry

  const retryResponse = (row: MediaLineageRow, replayed: boolean): MediaTaskRetryResponse => {
    const live = deps.getLiveMediaTask(row.taskId);
    return {
      taskId: row.taskId,
      projectId: row.projectId,
      status: live?.status ?? row.status,
      startedAt: live?.startedAt ?? row.createdAt,
      retryOf: row.parentTaskId ?? row.taskId,
      lineage: mediaLineageView(row),
      idempotencyKey: row.idempotencyKey ?? '',
      replayed,
    };
  };

  app.post('/api/media/tasks/:id/retry', async (req, res) => {
    if (refuseCrossOrigin(req, res)) return;
    const sourceId = String(req.params.id);
    // The history row outlives the live task (swept an hour after it ends),
    // so a retry works from it first.
    const history = getMediaLineage(db, sourceId);
    const live = deps.getLiveMediaTask(sourceId);
    const projectId = history?.projectId ?? live?.projectId;
    if (!projectId || !await canRead(deps.authorizeProjectRequest, req, res, projectId)) return taskNotFound(res);

    // Exactly the grant /media/generate resolves: a tool token is required in
    // sandbox mode, and a token's run policy governs what it may generate.
    const grant = deps.resolveGenerateGrant(req, projectId);
    if (!grant.ok) {
      return void sendApiError(res, grant.status, grant.code, grant.message, grant.details ? { details: grant.details } : {});
    }
    const toolGrant: ToolTokenGrant | null = grant.grant;
    if (toolGrant && deps.requestProjectOverride(projectId, toolGrant.projectId)) {
      return void sendApiError(res, 403, 'FORBIDDEN', 'the tool token belongs to a different project');
    }
    if (!await deps.authorizeProjectRequest(req, res, projectId, { mode: 'write', capability: 'writeFiles' })) return;
    if (!deps.getProject(db, projectId)) return void sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');

    const key = idempotencyKeyFrom(req);
    if (!isValidMediaIdempotencyKey(key)) {
      return void sendApiError(
        res,
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'retry starts a new task; send an Idempotency-Key header (1–128 visible ASCII characters)',
      );
    }
    const principal = requestPrincipal(req);

    const replay = (row: MediaLineageRow) => {
      if (row.relation !== 'retry' || row.parentTaskId !== sourceId) {
        return void sendApiError(
          res,
          409,
          'IDEMPOTENCY_KEY_CONFLICT',
          'this idempotency key already started a different task',
          { details: { taskId: row.taskId } },
        );
      }
      res.status(200).json(retryResponse(row, true));
    };

    const release = await claimKey(`${projectId}\u0000${principal}\u0000${key}`);
    try {
      // Checked only once the key is ours: from here to the insert nothing
      // else in this process can use it.
      const existing = findMediaLineageByIdempotencyKey(db, projectId, principal, key);
      if (existing) return replay(existing);

      const status = live?.status ?? history?.status;
      const error = live?.error ?? history?.error ?? null;
      if (status !== 'failed' && status !== 'interrupted') {
        return void sendApiError(
          res,
          409,
          'MEDIA_TASK_NOT_RETRYABLE',
          `media task is ${status}; only a failed or interrupted task can be retried`,
          { details: { status: status ?? null } },
        );
      }
      if (error?.code === MEDIA_SAFETY_REJECTION_CODE) {
        const safetyCategory = mediaSafetyCategory(error.code, error.category) ?? 'safety.unspecified';
        return void sendApiError(
          res,
          422,
          'MEDIA_RETRY_SAFETY_REJECTED',
          'the provider refused this request on content-safety grounds; repeating it unchanged would be refused again. Revise the prompt or reference images and generate again.',
          { details: { safetyCategory, nextStep: 'revise-request', ...(error.subject ? { subject: error.subject } : {}) } },
        );
      }
      if (!history?.request) {
        return void sendApiError(
          res,
          422,
          'MEDIA_RETRY_REQUEST_UNAVAILABLE',
          'this task predates request recording, so there is nothing to replay; generate again instead',
        );
      }

      // A retry always writes under a fresh, collision-free name: reusing
      // the original's would overwrite whatever now holds that name.
      const body: Record<string, unknown> = { ...history.request };
      delete body.output;
      try {
        await deps.handleGenerate(req, res, {
          projectId,
          grant: toolGrant,
          body,
          lineage: {
            parent: { taskId: sourceId, relation: 'retry' },
            idempotencyKey: key,
            idempotencyPrincipal: principal,
          },
          acceptedBody: (task) => {
            const row = getMediaLineage(db, task.id);
            return row ? { ...retryResponse(row, false) } : { taskId: task.id };
          },
        });
      } catch (err: any) {
        if (err instanceof MediaIdempotencyKeyTakenError) {
          // Another daemon writer won the key between our check and insert.
          // Nothing was started on our side; answer with the winner.
          const winner = findMediaLineageByIdempotencyKey(db, projectId, principal, key);
          if (winner) return replay(winner);
        }
        if (!res.headersSent) {
          const statusCode = typeof err?.status === 'number' ? err.status : 400;
          const errBody: Record<string, unknown> = { error: String(err && err.message ? err.message : err) };
          if (err?.code) errBody.code = err.code;
          res.status(statusCode).json(errBody);
        }
      }
    } finally {
      release();
    }
  });

  // --------------------------------------------------------------- gallery

  type JudgedOutput = {
    state: MediaGalleryOutputState;
    file?: MediaGalleryFile;
    error?: MediaTaskError;
  };

  const buildEntries = async (projectId: string, rows: MediaLineageRow[]): Promise<MediaGalleryEntry[]> => {
    // One budget and one listing per request; every hash the request
    // triggers is charged to the budget, candidates included.
    const projectDir = deps.resolveProjectDir(deps.projectsDir, projectId);
    const matcher = createGalleryOutputMatcher({
      projectDir,
      budgetBytes: MEDIA_GALLERY_HASH_BYTE_BUDGET,
    });
    const listing: { files?: Promise<ProjectFile[]> } = {};
    const projectFiles = () => (listing.files ??= deps.listFiles(deps.projectsDir, projectId));
    return mapWithConcurrency(rows, MEDIA_OUTPUT_HASH_CONCURRENCY, async (row) => {
      const output = await judgeOutput(row, projectFiles, matcher.matches, projectDir);
      return galleryEntry(row, output);
    });
  };

  const judgeOutput = async (
    row: MediaLineageRow,
    projectFiles: () => Promise<readonly ProjectFile[]>,
    matchBytes: typeof mediaOutputMatches,
    projectDir: string,
  ): Promise<JudgedOutput> => {
    const file = row.file;
    if (row.status !== 'done' || !file || typeof file.name !== 'string' || !file.name.trim()) {
      return { state: 'none' };
    }
    // No digest (a task from before the witness): the recorded name is
    // shown, unproven.
    if (!mediaOutputRecord(file)) return { state: 'unverifiable', file: galleryFileView(file) };
    let located: LocatedOutput;
    try {
      located = await deps.locateDoneMediaTaskOutput(row.projectId, file, projectFiles, new Set(), matchBytes, projectDir);
    } catch {
      return { state: 'unverifiable', file: galleryFileView(file) };
    }
    switch (located.kind) {
      case 'current':
        return { state: 'current', file: galleryFileView(file) };
      case 'moved':
        return { state: 'moved', file: galleryFileView(file, located.file.name) };
      case 'unverifiable':
        return { state: 'unverifiable', file: galleryFileView(file) };
      case 'superseded':
        return { state: located.verdict === 'missing' ? 'missing' : 'superseded', error: located.error };
    }
  };

  const galleryEntry = (row: MediaLineageRow, output: JudgedOutput): MediaGalleryEntry => {
    const interruptReason = mediaLineageInterruptReason(row);
    const safetyCategory = mediaSafetyCategory(row.error?.code, row.error?.category);
    const error = output.error ?? (row.status === 'failed' || row.status === 'interrupted' ? row.error : null);
    const recordedName = typeof row.file?.name === 'string' ? row.file.name : undefined;
    return {
      id: row.taskId,
      projectId: row.projectId,
      kind: row.surface,
      status: row.status,
      ...(interruptReason ? { interruptReason } : {}),
      createdAt: row.createdAt,
      endedAt: row.endedAt,
      provenance: {
        providerId: row.providerId,
        model: row.model,
        promptDigest: row.promptDigest,
        ...(safetyCategory ? { safetyCategory } : {}),
        stub: row.stub,
      },
      lineage: mediaLineageView(row),
      ...(output.file ? { file: output.file } : {}),
      output: { state: output.state, ...(recordedName && output.state !== 'none' ? { recordedName } : {}) },
      ...(error ? { error } : {}),
      unlinked: row.unlinkedAt !== null,
      replayable: row.request !== null,
    };
  };

  /** Shared preamble: same-origin, project exists, caller may read (or write) it. */
  const authorizedProject = async (
    req: Request,
    res: Response,
    projectId: string,
    mode: 'read' | 'write',
  ): Promise<boolean> => {
    if (refuseCrossOrigin(req, res)) return false;
    if (!deps.getProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return false;
    }
    return deps.authorizeProjectRequest(
      req,
      res,
      projectId,
      mode === 'read' ? { mode: 'read' } : { mode: 'write', capability: 'writeFiles' },
    );
  };

  /** An entry readable through `projectId`; another project's id is a 404, never a leak. */
  const entryInProject = (projectId: string, entryId: string): MediaLineageRow | null => {
    const row = getMediaLineage(db, entryId);
    return row && row.projectId === projectId ? row : null;
  };
  const entryNotFound = (res: Response) =>
    void sendApiError(res, 404, 'MEDIA_GALLERY_ENTRY_NOT_FOUND', 'gallery entry not found in this project');

  app.get('/api/projects/:id/media/gallery', async (req, res) => {
    const projectId = String(req.params.id);
    if (!await authorizedProject(req, res, projectId, 'read')) return;
    const parsed = parseMediaGalleryQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      return void sendApiError(res, 400, 'BAD_REQUEST', parsed.message, { details: { field: parsed.field } });
    }
    let page: ReturnType<typeof listMediaGalleryPage>;
    try {
      page = listMediaGalleryPage(db, projectId, parsed.query);
    } catch (err) {
      if (err instanceof InvalidGalleryCursorError) {
        return void sendApiError(res, 400, 'BAD_REQUEST', err.message, { details: { field: 'cursor' } });
      }
      throw err;
    }
    const body: MediaGalleryResponse = {
      entries: await buildEntries(projectId, page.rows),
      nextCursor: page.nextCursor,
      limit: parsed.query.limit,
    };
    res.json(body);
  });

  app.get('/api/projects/:id/media/gallery/:entryId', async (req, res) => {
    const projectId = String(req.params.id);
    if (!await authorizedProject(req, res, projectId, 'read')) return;
    const row = entryInProject(projectId, String(req.params.entryId));
    if (!row) return entryNotFound(res);
    const chainRows = listMediaLineageChain(db, projectId, row.rootTaskId);
    const chain = await buildEntries(projectId, chainRows);
    const entry = chain.find((candidate) => candidate.id === row.taskId)
      ?? (await buildEntries(projectId, [row]))[0]!;
    const body: MediaGalleryEntryDetail = { entry, chain, request: row.request };
    res.json(body);
  });

  app.post('/api/projects/:id/media/gallery/:entryId/unlink', async (req, res) => {
    const projectId = String(req.params.id);
    if (!await authorizedProject(req, res, projectId, 'write')) return;
    const entryId = String(req.params.entryId);
    if (!entryInProject(projectId, entryId)) return entryNotFound(res);
    unlinkMediaLineage(db, projectId, entryId);
    const body: MediaGalleryUnlinkResponse = { id: entryId, unlinked: true, bytesRetained: true };
    res.json(body);
  });

  // Placement and reuse share the verified-copy primitive.
  const copyEntry = (action: 'place' | 'reuse') => async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    if (!await authorizedProject(req, res, projectId, 'read')) return;
    const source = entryInProject(projectId, String(req.params.entryId));
    if (!source) return entryNotFound(res);
    const requestBody = (req.body ?? {}) as { targetProjectId?: unknown; output?: unknown };
    const targetProjectId = action === 'place' && requestBody.targetProjectId === undefined ? projectId
      : typeof requestBody.targetProjectId === 'string' ? requestBody.targetProjectId.trim() : '';
    if (!targetProjectId) return void sendApiError(res, 400, 'BAD_REQUEST', 'targetProjectId is required');
    if (requestBody.output !== undefined && (typeof requestBody.output !== 'string' || !isPlainFileName(requestBody.output))) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'output must be a plain file name (no directories)', { details: { field: 'output' } });
    }
    const key = idempotencyKeyFrom(req);
    if (key !== undefined && !isValidMediaIdempotencyKey(key)) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'Idempotency-Key must be 1–128 visible ASCII characters', { details: { field: 'idempotencyKey' } });
    }
    const targetProject = deps.getProject(db, targetProjectId);
    if (!targetProject) return void sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'target project not found');
    if (!await deps.authorizeProjectRequest(req, res, targetProjectId, { mode: 'write', capability: 'writeFiles' })) return;

    if (source.stub) return void sendApiError(res, 409, 'MEDIA_GALLERY_OUTPUT_UNAVAILABLE', 'placeholder bytes cannot be placed or reused as generated assets');
    const principal = requestPrincipal(req);
    const replay = async (row: MediaLineageRow) => {
      if (row.relation !== 'reuse' || row.parentTaskId !== source.taskId
        || (row.file?.copyAction ?? 'reuse') !== action
        || (row.file && 'copyOutput' in row.file && row.file.copyOutput !== (requestBody.output ?? null))) {
        return void sendApiError(res, 409, 'IDEMPOTENCY_KEY_CONFLICT', 'this idempotency key already made a different entry', { details: { entryId: row.taskId } });
      }
      const file = row.file ?? {};
      const body: MediaGalleryReuseResponse | MediaGalleryPlaceResponse = {
        ...(action === 'place' ? { action: 'place' as const } : {}),
        // Replay verifies current bytes too; it never resurrects a missing copy.
        entry: (await buildEntries(targetProjectId, [row]))[0]!,
        sourceId: source.taskId,
        sourceProjectId: projectId,
        bytesCopied: typeof file.size === 'number' ? file.size : 0,
      };
      res.status(200).json(body);
    };

    const release = typeof key === 'string'
      ? await claimKey(`${targetProjectId}\u0000${principal}\u0000${key}`)
      : () => {};
    try {
      if (typeof key === 'string') {
        const existing = findMediaLineageByIdempotencyKey(db, targetProjectId, principal, key);
        if (existing) return await replay(existing);
      }

      const unavailable = (reason: string) => void sendApiError(
        res,
        409,
        'MEDIA_GALLERY_OUTPUT_UNAVAILABLE',
        `this entry has no output that still holds its generated bytes (${reason}); nothing was copied`,
      );
      const record = source.status === 'done' ? mediaOutputRecord(source.file) : null;
      if (!record) return unavailable(source.status === 'done' ? 'no recorded digest' : `status ${source.status}`);
      const sourceDir = deps.resolveProjectDir(deps.projectsDir, projectId);
      const located = await deps.locateDoneMediaTaskOutput(projectId, source.file, () => deps.listFiles(deps.projectsDir, projectId), undefined, undefined, sourceDir);
      const sourceName = located.kind === 'moved' ? located.file.name : located.kind === 'current' ? record.name : null;
      if (!sourceName) return unavailable(located.kind);
      const sourcePath = mediaOutputPath(sourceDir, sourceName);
      if (!sourcePath || !await isContainedOutputPath(sourceDir, sourcePath)) return unavailable('path outside the project');

      // Copy and verify under a hidden temporary name, then publish with an
      // exclusive hard link: a crash or a failed verification never leaves a
      // file under the final name, and the final name is never overwritten.
      const targetDir = await ensureProject(deps.projectsDir, targetProjectId, targetProject.metadata);
      const tempPath = path.join(targetDir, `.od-reuse-${cryptoRandomUUID()}.partial`);
      const copy = await copyVerifiedMediaOutput(sourcePath, record, tempPath);
      if (copy.kind !== 'copied') {
        await unlink(tempPath).catch(() => {});
        return unavailable(copy.kind);
      }
      const wanted = typeof requestBody.output === 'string' ? requestBody.output : path.basename(sourceName);
      const ext = path.extname(wanted);
      const stem = wanted.slice(0, wanted.length - ext.length) || 'media';
      let finalName: string | null = null;
      try {
        for (let attempt = 1; attempt <= 50 && !finalName; attempt += 1) {
          const name = attempt === 1 ? wanted : `${stem}-${attempt}${ext}`;
          try {
            await link(tempPath, path.join(targetDir, name));
            finalName = name;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
          }
        }
      } finally {
        await unlink(tempPath).catch(() => {});
      }
      if (!finalName) return void sendApiError(res, 409, 'CONFLICT', 'no free file name for the copy in the target project');

      const written = await stat(path.join(targetDir, finalName));
      const sourceFile = source.file ?? {};
      const file = {
        name: finalName,
        size: written.size,
        mtime: written.mtimeMs,
        sha256: record.sha256,
        copyAction: action,
        copyOutput: requestBody.output ?? null,
        ...(typeof sourceFile.kind === 'string' ? { kind: sourceFile.kind } : {}),
        ...(typeof sourceFile.mime === 'string' ? { mime: sourceFile.mime } : {}),
        ...(source.providerId ? { providerId: source.providerId } : {}),
        ...(source.model ? { model: source.model } : {}),
      };
      const now = Date.now();
      let row: MediaLineageRow;
      try {
        row = recordMediaTaskLineage(db, {
          taskId: deps.randomUUID(),
          projectId: targetProjectId,
          status: 'done',
          createdAt: now,
          endedAt: now,
          surface: source.surface ?? undefined,
          model: source.model ?? undefined,
          providerId: source.providerId ?? undefined,
          // A copy is not a generation: there is no request to replay.
          request: null,
          promptDigest: source.promptDigest,
          parent: { taskId: source.taskId, relation: 'reuse' },
          file,
          stub: source.stub,
          ...(typeof key === 'string' ? { idempotencyKey: key, idempotencyPrincipal: principal } : {}),
        });
      } catch (err) {
        // Lost the key to another writer: our copy is redundant, remove it.
        await unlink(path.join(targetDir, finalName)).catch(() => {});
        if (err instanceof MediaIdempotencyKeyTakenError && typeof key === 'string') {
          const winner = findMediaLineageByIdempotencyKey(db, targetProjectId, principal, key);
          if (winner) return await replay(winner);
        }
        throw err;
      }
      const body: MediaGalleryReuseResponse | MediaGalleryPlaceResponse = {
        ...(action === 'place' ? { action: 'place' as const } : {}),
        entry: galleryEntry(row, { state: 'current', file: galleryFileView(file) }),
        sourceId: source.taskId,
        sourceProjectId: projectId,
        bytesCopied: copy.bytes,
      };
      res.status(201).json(body);
    } finally {
      release();
    }
  };
  app.post('/api/projects/:id/media/gallery/:entryId/place', copyEntry('place'));
  app.post('/api/projects/:id/media/gallery/:entryId/reuse', copyEntry('reuse'));
}
