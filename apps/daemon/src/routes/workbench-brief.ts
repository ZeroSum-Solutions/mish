import type { Express, Request, Response } from 'express';
import { type BriefTransformerStatus, type BriefTransformerStatusResponse, attachDesignBriefRequestSchema, previewDesignBriefRequestSchema, createDesignBriefRequestSchema, patchDesignBriefRequestSchema } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { BriefError, type DesignBriefService } from '../workbench/brief/service.js';

export interface RegisterWorkbenchBriefRoutesDeps {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  briefs: DesignBriefService;
  /** Settings → Labs transformer choice and whether its key resolves. Omitted in tests that do not exercise it. */
  transformerStatus?: () => Promise<BriefTransformerStatus>;
}

/**
 * R15 Improve prompt. `od workbench transform` and `od workbench brief …` call
 * these same endpoints. Transforming never starts a run; generation binds an
 * accepted revision through the optional `brief` on `POST /api/runs`.
 */
export function registerWorkbenchBriefRoutes(app: Express, deps: RegisterWorkbenchBriefRoutesDeps): void {
  const deny = (res: Response) => deps.http.sendApiError(res, 403, 'project-forbidden', 'Project scope is not authorized');
  async function scope(req: Request, res: Response, write: boolean, bodyProjectId?: unknown): Promise<{ projectId: string; principalId: string } | null> {
    const values = [bodyProjectId, req.query.projectId, req.get('x-od-project-id')].filter(value => value !== undefined);
    const id = values[0];
    if (typeof id !== 'string' || values.some(value => typeof value !== 'string' || !value || value.trim() !== value || /\p{Cc}/u.test(value)) || new Set(values).size !== 1) {
      deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Pass one matching project scope'); return null;
    }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    const safeResponse = { req, status() { return safeResponse; }, json() { return deny(res); } } as unknown as Response;
    if (!await deps.authorizeProjectRequest(req, safeResponse, id, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
    const principalId = workspace.context ? `workspace:${workspace.context.workspaceId}:${workspace.context.workspaceMemberId}` : 'local-daemon';
    return { projectId: id, principalId };
  }
  function fail(res: Response, error: unknown): void {
    if (error instanceof BriefError) deps.http.sendApiError(res, error.status, error.code, error.message);
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to transform or read the brief');
  }

  // Which model writes briefs. Changed through PUT /api/app-config `improvePromptTransformer`;
  // `od workbench brief transformer` and the Labs row both read this.
  app.get('/api/workbench/briefs/transformer', async (_req, res) => {
    if (!deps.transformerStatus) { deps.http.sendApiError(res, 404, 'NOT_FOUND', 'No transformer status on this daemon'); return; }
    try {
      const body: BriefTransformerStatusResponse = { status: await deps.transformerStatus() };
      res.json(body);
    } catch { deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to read the transformer status'); }
  });
  app.post('/api/workbench/briefs/preview', async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const authority = resolveOptionalLocalWorkspaceRequestAuthority(req);
      if (!authority.ok) { deps.http.sendApiError(res, authority.status, authority.code, authority.message); return; }
      const parsed = previewDesignBriefRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass a nonempty originalText and optional text overrides'); return; }
      const preview = await deps.briefs.preview(parsed.data, controller.signal);
      if (!controller.signal.aborted) res.json(preview);
    } catch (error) { if (!controller.signal.aborted) fail(res, error); }
    finally { res.off('close', abort); }
  });
  app.post('/api/workbench/briefs/attach', async (req, res) => {
    try {
      const parsed = attachDesignBriefRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass projectId and the reviewed preview'); return; }
      const context = await scope(req, res, true, parsed.data.projectId); if (!context) return;
      res.status(201).json(await deps.briefs.attach(parsed.data, context));
    } catch (error) { fail(res, error); }
  });

  app.post('/api/workbench/briefs', async (req, res) => {
    try {
      const body: unknown = req.body ?? {};
      const parsed = createDesignBriefRequestSchema.safeParse(body);
      if (!parsed.success) {
        deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass projectId, a nonempty originalText and at most 10 selected references', { details: { fields: parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path.join('.'), message: issue.message.slice(0, 300) })) } });
        return;
      }
      const context = await scope(req, res, true, parsed.data.projectId); if (!context) return;
      res.status(202).json(await deps.briefs.create(parsed.data, context));
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/briefs/:id', async (req, res) => {
    try {
      const context = await scope(req, res, false); if (!context) return;
      res.json(await deps.briefs.read(context.projectId, String(req.params.id)));
    } catch (error) { fail(res, error); }
  });
  app.patch('/api/workbench/briefs/:id', async (req, res) => {
    try {
      const context = await scope(req, res, true); if (!context) return;
      const parsed = patchDesignBriefRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass expectedRevision with edits, reference decisions or accept'); return; }
      res.json(await deps.briefs.patch(context.projectId, String(req.params.id), parsed.data));
    } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/briefs/:id/cancel', async (req, res) => {
    try {
      const context = await scope(req, res, true); if (!context) return;
      res.json(await deps.briefs.cancel(context.projectId, String(req.params.id)));
    } catch (error) { fail(res, error); }
  });
}
