import type { Express, Request, Response } from 'express';
import { stat } from 'node:fs/promises';
import { parseCreateIntakeBatchRequest, parseAttachIntakeRequest, parseClearIntakeRequest } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { requestWithWorkspaceNavigationScope, resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import { ensureProject, ensureValidatedProjectSubdir } from '../projects.js';
import { streamAssetFileToResponse } from './library.js';
import { IntakeError, IntakeService, type IntakeWriteAuthority } from '../workbench/intake.js';
import { intakeManifest, type IntakeSelector } from '../workbench/intake-store.js';
import { INTAKE_FILE_MAX_BYTES, INTAKE_SIZE_EXCEEDED_MESSAGE } from '../workbench/intake-policy.js';
import { mapPlacementFailure, type PlacementHttpMapping } from '../workbench/placement/runtime-status.js';
import { PlacementCoordinationError } from '../workbench/placement/write-coordinator.js';

export interface RegisterWorkbenchIntakeRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'conversations'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  /**
   * Trusted daemon-local Intake custody from the placement runtime
   * (`createIntakeWriteAuthority`); never chosen by request fields. Not a
   * shared ServerContext key: registration refuses to start without it.
   */
  intakeWriteAuthority?: IntakeWriteAuthority;
}
/**
 * Placement refusals keep their typed envelope: owner/recovery/admission 503,
 * scope drift/busy 409. The destination project is authorized before
 * admission, so an unresolvable admitted root is a 409; a cancelled pending
 * admission is a retryable 503 for a caller that already went away.
 */
function placementRefusal(error: unknown): PlacementHttpMapping | null {
  const mapped = mapPlacementFailure(error); if (mapped) return mapped;
  if (!(error instanceof PlacementCoordinationError)) return null;
  const cancelled = error.code === 'ADMISSION_CANCELLED';
  return { status: cancelled ? 503 : 409, code: cancelled ? 'UPSTREAM_UNAVAILABLE' : 'CONFLICT', message: error.message, retryable: cancelled, details: { kind: 'placement', reason: error.code } };
}
/** Response cancellation cancels only a pending project admission, never accepted Intake work. */
function cancellation(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  if (res.destroyed) controller.abort();
  return controller.signal;
}
function assertCallerPresent(signal: AbortSignal): void {
  if (signal.aborted) throw new PlacementCoordinationError('ADMISSION_CANCELLED', 'Admission cancelled before Intake work began');
}
function closeUnreadPut(req: Request, res: Response): void {
  if (!req.readableEnded && !res.headersSent) {
    res.setHeader('Connection', 'close');
    res.shouldKeepAlive = false;
  }
}
/** No token or path in the URL: navigation carries the existing paired namespace selectors. */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\/;]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function registerWorkbenchIntakeRoutes(app: Express, deps: RegisterWorkbenchIntakeRoutesDeps): IntakeService {
  const { db, paths, projectStore, conversations, http, authorizeProjectRequest, intakeWriteAuthority } = deps;
  if (!intakeWriteAuthority) throw new Error('Workbench Intake routes require the placement write authority');
  const service = new IntakeService({ db, libraryDir: paths.LIBRARY_DIR, projectsDir: paths.PROJECTS_DIR, authority: intakeWriteAuthority, projectDirectory: async (id, dir, finalIO) => {
    const project = projectStore.getProject(db, id); if (!project) throw new IntakeError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    // Guarded project-root creation first, so the validated subfolder step only creates the folder itself.
    await ensureProject(paths.PROJECTS_DIR, id, project.metadata, finalIO); finalIO.assertCurrent();
    const target = await ensureValidatedProjectSubdir(paths.PROJECTS_DIR, id, dir, project.metadata, finalIO);
    if (target.relDir !== dir) throw new IntakeError(400, 'BAD_REQUEST', 'Project folder must be a valid unchanged relative path');
    return target.absDir;
  } });
  const fail = (res: Response, error: unknown) => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof IntakeError) {
      if (error.status === 429) res.setHeader('Retry-After', '1');
      return http.sendApiError(res, error.status, error.code, error.message, { retryable: error.retryable });
    }
    const placement = placementRefusal(error);
    if (placement) return http.sendApiError(res, placement.status, placement.code, placement.message, { retryable: placement.retryable, details: placement.details });
    return http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Intake operation failed');
  };
  app.use('/api/workbench/intake', (req,res,next) => {
    const local = validateLocalDaemonRequest(req);
    if (!local.ok) return http.sendApiError(res, 403, 'FORBIDDEN', local.message, { details: local.details });
    res.vary('Origin'); if (local.origin) res.setHeader('Access-Control-Allow-Origin', local.origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OD-Project-Id, X-OD-Workspace-Id, X-OD-Workspace-Member-Id, X-OD-Intake-Retry');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const selector = (req: Request, navigation = false): IntakeSelector => {
    let scoped = req;
    if (navigation) {
      if (['workspaceId','workspaceMemberId'].some(key => req.query[key] !== undefined && typeof req.query[key] !== 'string')) throw new IntakeError(400, 'BAD_REQUEST', 'Invalid navigation scope');
      const normalized = requestWithWorkspaceNavigationScope(req); if (normalized === 'conflict') throw new IntakeError(400, 'BAD_REQUEST', 'Workspace navigation and headers must match'); scoped = normalized as Request;
    }
    const resolved = resolveOptionalLocalWorkspaceRequestAuthority(scoped);
    if (!resolved.ok) throw new IntakeError(resolved.status, 'WORKSPACE_CONTEXT_INCOMPLETE', resolved.message);
    return resolved.context ? [resolved.context.workspaceId, resolved.context.workspaceMemberId] : null;
  };
  const projectGate = async (req: Request, res: Response, projectId: string, write: boolean, navigation = false): Promise<boolean> => {
    const header = req.get('x-od-project-id'); if (header !== undefined && header !== projectId) throw new IntakeError(400, 'BAD_REQUEST', 'Project header and frozen destination must match');
    return authorizeProjectRequest(req, res, projectId, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read', ...(navigation ? { allowNavigationQuery: true } : {}) });
  };
  const batchGate = async (req: Request, res: Response, write: boolean, navigation = false): Promise<boolean> => {
    const id = String(req.params.batchId); service.assertSelector(id, selector(req, navigation));
    const destination = intakeManifest(service.batch(id)).destination;
    return destination.kind !== 'project' || await projectGate(req,res,destination.projectId,write,navigation);
  };
  const conversationGate = (projectId: string, conversationId: string): void => {
    if (conversations.getConversation(db, conversationId)?.projectId !== projectId) throw new IntakeError(403, 'project-forbidden', 'Conversation does not belong to the authorized project');
  };
  app.post('/api/workbench/intake', async (req,res) => {
    try {
      let input; try { input = parseCreateIntakeBatchRequest(req.body); } catch { throw new IntakeError(400, 'BAD_REQUEST', 'Invalid intake manifest'); }
      const scoped = selector(req);
      if (input.destination.kind === 'project') {
        if (!await projectGate(req,res,input.destination.projectId,true)) return;
        if (input.destination.conversationId) conversationGate(input.destination.projectId,input.destination.conversationId);
      }
      res.json(await service.create(input,scoped));
    } catch (error) { fail(res,error); }
  });
  app.get('/api/workbench/intake', async (req,res) => {
    try {
      if (req.query.state !== 'pending') throw new IntakeError(400, 'BAD_REQUEST', 'Use state=pending');
      const scoped = selector(req);
      const projectId = req.query.projectId;
      if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) throw new IntakeError(400, 'BAD_REQUEST', 'Choose one project');
      if (projectId && !await projectGate(req,res,projectId,false)) return;
      res.json({ batches: service.list(scoped,projectId) });
    } catch (error) { fail(res,error); }
  });
  app.get('/api/workbench/intake/:batchId', async (req,res) => {
    try { if (!await batchGate(req,res,false)) return; res.json(service.snapshot(String(req.params.batchId))); } catch (error) { fail(res,error); }
  });
  app.put('/api/workbench/intake/:batchId/files/:clientFileId', async (req,res) => {
    let release: (() => void) | undefined;
    const signal = cancellation(res);
    try {
      // Authorization may send its own response before this route can handle
      // the unread upload body. Set the close header before crossing that gate.
      const priorConnection = res.getHeader('Connection');
      const unreadAtGate = !req.readableEnded;
      if (unreadAtGate) res.setHeader('Connection', 'close');
      if (!await batchGate(req,res,true)) { closeUnreadPut(req,res); return; }
      if (unreadAtGate && !res.headersSent) {
        if (priorConnection === undefined) res.removeHeader('Connection');
        else res.setHeader('Connection', priorConnection);
      }
      assertCallerPresent(signal);
      if (req.get('content-type') !== 'application/octet-stream') throw new IntakeError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/octet-stream');
      const retryMode = req.get('x-od-intake-retry');
      if (retryMode !== undefined) {
        if (retryMode !== 'placement' || req.get('content-length') !== '0' || req.get('transfer-encoding') !== undefined) throw new IntakeError(400, 'BAD_REQUEST', 'Project placement retry requires an empty request body');
        // The retry has no upload bytes. Close this HTTP connection after its
        // response so undeclared trailing bytes cannot become a later request.
        res.setHeader('Connection', 'close');
        res.json(await service.retryProjectPlacement(String(req.params.batchId),String(req.params.clientFileId),() => batchGate(req,res,true),{ signal }));
        return;
      }
      const length = req.get('content-length'); if (length && Number(length) > INTAKE_FILE_MAX_BYTES) throw new IntakeError(413, 'intake-size-exceeded', INTAKE_SIZE_EXCEEDED_MESSAGE);
      service.item(String(req.params.batchId),String(req.params.clientFileId));
      release = service.admit();
      res.json(await service.put(String(req.params.batchId),String(req.params.clientFileId),req,release,() => batchGate(req,res,true),{ signal }));
    } catch (error) { closeUnreadPut(req,res); fail(res,error); } finally { release?.(); }
  });
  app.delete('/api/workbench/intake/:batchId', async (req,res) => {
    try {
      if (!await batchGate(req,res,true)) return;
      let input; try { input = parseClearIntakeRequest(req.body ?? {}); } catch { throw new IntakeError(400, 'BAD_REQUEST', 'Invalid clear request'); }
      res.json(await service.clear(String(req.params.batchId),input));
    } catch (error) { fail(res,error); }
  });
  app.post('/api/workbench/intake/:batchId/attach', async (req,res) => {
    const signal = cancellation(res);
    try {
      if (!await batchGate(req,res,true)) return;
      let input; try { input = parseAttachIntakeRequest(req.body); } catch { throw new IntakeError(400, 'BAD_REQUEST', 'Invalid attach request'); }
      if (!await projectGate(req,res,input.projectId,true)) return; conversationGate(input.projectId,input.conversationId);
      assertCallerPresent(signal);
      res.json(await service.attach(String(req.params.batchId),input,() => projectGate(req,res,input.projectId,true),{ signal }));
    } catch (error) { fail(res,error); }
  });
  app.get('/api/workbench/intake/:batchId/files/:clientFileId/download', async (req,res) => {
    try {
      if (!await batchGate(req,res,false,true)) return;
      const file = service.download(String(req.params.batchId),String(req.params.clientFileId));
      const info = await stat(file.path); if (!info.isFile() || info.size !== file.size) throw new IntakeError(404, 'bytes-removed', 'Original bytes are unavailable', true);
      res.setHeader('Content-Type','application/octet-stream'); res.setHeader('Content-Length',String(info.size));
      res.setHeader('Content-Disposition',attachmentDisposition(file.filename)); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Content-Security-Policy','sandbox'); res.setHeader('Cache-Control','private, no-store');
      streamAssetFileToResponse(file.path,res,() => http.sendApiError(res,404,'bytes-removed','Original bytes are unavailable',{retryable:true}));
    } catch (error) { if (!(error instanceof IntakeError) && (error as NodeJS.ErrnoException)?.code === 'ENOENT') fail(res,new IntakeError(404,'bytes-removed','Original bytes are unavailable',true)); else fail(res,error); }
  });
  return service;
}
