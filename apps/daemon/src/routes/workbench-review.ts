import type { Express, Request, Response } from 'express';
import { reviewFindingDecisionRequestSchema, runMechanicalReviewRequestSchema, startReviewRunRequestSchema } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { resolveMemberVerifiedLocalWorkspaceRequestAuthority, resolveOptionalLocalWorkspaceRequestAuthority, type VerifyWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { ProjectContextError } from '../workbench/project-context.js';
import { ReviewBusyError, type WorkbenchReviewService } from '../workbench/review/service.js';
import { ReviewRunError, type ReviewRunService } from '../workbench/review/run-service.js';

interface WorkbenchReviewRoutesBaseDeps {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  /** Throws ProjectContextError(403) for an unknown project, like the context routes. */
  assertProject(projectId: string): void;
  review: WorkbenchReviewService;
}

/** A mounted R03 decision route must have a membership verifier; mechanical-only routes do not need one. */
export type RegisterWorkbenchReviewRoutesDeps = WorkbenchReviewRoutesBaseDeps & (
  | { runs: ReviewRunService; verifyWorkspaceRequestAuthority: VerifyWorkspaceRequestAuthority }
  | { runs?: undefined }
);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;

/** R06.2 mechanical review: run, list and read verification bundles. The od CLI calls the same endpoints. */
export function registerWorkbenchReviewRoutes(app: Express, deps: RegisterWorkbenchReviewRoutesDeps): void {
  const deny = (res: Response) => deps.http.sendApiError(res, 403, 'project-forbidden', 'Project scope is not authorized');
  async function scope(req: Request, res: Response, write: boolean, bodyProjectId?: unknown): Promise<string | null> {
    const id = bodyProjectId === undefined ? req.params.id : bodyProjectId;
    const values = [id, req.query.projectId, req.get('x-od-project-id')].filter(value => value !== undefined);
    if (typeof id !== 'string' || values.some(value => typeof value !== 'string' || !value || value.trim() !== value || /\p{Cc}/u.test(value)) || new Set(values).size !== 1) {
      deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Pass one matching project scope'); return null;
    }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    const safeResponse = { req, status() { return safeResponse; }, json() { return deny(res); } } as unknown as Response;
    if (!await deps.authorizeProjectRequest(req, safeResponse, id, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
    deps.assertProject(id);
    return id;
  }
  function fail(res: Response, error: unknown): void {
    if (error instanceof ProjectContextError) deps.http.sendApiError(res, error.status, error.code, error.message);
    else if (error instanceof ReviewBusyError) deps.http.sendApiError(res, 409, 'CONFLICT', error.message);
    else if (error instanceof ReviewRunError) {
      const code = error.code === 'review-store-degraded' || error.code === 'review-store-unavailable' ? error.code : { 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED' }[error.status];
      deps.http.sendApiError(res, error.status, code, error.message, { details: { reason: error.code, ...(error.fields.length ? { fields: error.fields } : {}) } });
    }
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to run or read the review');
  }

  // A run never changes project files, but it persists an evidence record for
  // the project, so it needs write authority.
  app.post('/api/workbench/projects/:id/review/mechanical', async (req, res) => {
    try {
      const projectId = await scope(req, res, true); if (!projectId) return;
      const parsed = runMechanicalReviewRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const fields = parsed.error.issues.slice(0, 50).map(issue => ({ path: issue.path.join('.'), message: issue.message.slice(0, 300) }));
        const egress = fields.some(field => field.path.startsWith('egress'));
        deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', egress ? 'The egress allow-list is invalid: list exact public hostnames (optional :port), no wildcards, IP addresses or local names' : 'Pass a project-relative HTML entry without dot segments', { details: { fields } });
        return;
      }
      res.json(await deps.review.run(projectId, parsed.data));
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/projects/:id/review/bundles', async (req, res) => {
    try {
      const projectId = await scope(req, res, false); if (!projectId) return;
      res.json({ projectId, bundles: await deps.review.list(projectId) });
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/projects/:id/review/bundles/:bundleId', async (req, res) => {
    try {
      const projectId = await scope(req, res, false); if (!projectId) return;
      const bundle = await deps.review.read(projectId, String(req.params.bundleId));
      if (!bundle) { deps.http.sendApiError(res, 404, 'NOT_FOUND', 'No such verification bundle for this project'); return; }
      res.json(bundle);
    } catch (error) { fail(res, error); }
  });

  if (!deps.runs) return;
  const { runs, verifyWorkspaceRequestAuthority } = deps;

  // R03 collect-review operation. Starting needs write authority (it persists
  // evidence for the project); review never edits or publishes project files.
  app.post('/api/workbench/reviews', async (req, res) => {
    try {
      const body: unknown = req.body ?? {};
      const projectId = body && typeof body === 'object' ? (body as { projectId?: unknown }).projectId : undefined;
      if (typeof projectId !== 'string') { deps.http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Pass projectId', { details: { fields: [{ path: 'projectId', message: 'Required' }] } }); return; }
      if (!await scope(req, res, true, projectId)) return;
      const key = req.get('idempotency-key');
      if (!key || !IDEMPOTENCY_KEY.test(key)) { deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Pass an Idempotency-Key header (letters, digits, . _ : -; up to 200)'); return; }
      const parsed = startReviewRunRequestSchema.safeParse(body);
      if (!parsed.success) {
        const fields = parsed.error.issues.slice(0, 50).map(issue => ({ path: issue.path.join('.'), message: issue.message.slice(0, 300) }));
        const implementationOnly = fields.some(field => /implementation review only/u.test(field.message));
        deps.http.sendApiError(res, 422, 'VALIDATION_FAILED', implementationOnly ? 'implementation review only: that reviewer is not a product reviewer' : 'The review request is invalid', { details: { fields } });
        return;
      }
      const run = await runs.start(parsed.data, key);
      res.status(202).json(await runs.read(run.projectId, run.id));
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/reviews/:runId', async (req, res) => {
    try {
      const projectId = await scope(req, res, false, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      res.json(await runs.read(projectId, String(req.params.runId)));
    } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/reviews/:runId/cancel', async (req, res) => {
    try {
      const projectId = await scope(req, res, true, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      res.json(await runs.cancel(projectId, String(req.params.runId)));
    } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/reviews/:runId/findings/:findingId/decision', async (req, res) => {
    try {
      const projectId = await scope(req, res, true, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      const parsed = reviewFindingDecisionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { deps.http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Pass only action: accept or dismiss'); return; }
      // Project write scope does not prove a claimed member's identity. Verify
      // membership before persisting that identity in the permanent audit record.
      const authority = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(req, verifyWorkspaceRequestAuthority);
      if (!authority.ok) { deps.http.sendApiError(res, authority.status, authority.code, authority.message); return; }
      // Headerless requests use the local-owner lane after project write authorization.
      // They never infer a member from the daemon's mutable active workspace.
      const actor = authority.context
        ? { kind: 'workspace-member' as const, workspaceId: authority.context.workspaceId, workspaceMemberId: authority.context.workspaceMemberId }
        : { kind: 'local-user' as const };
      res.json(await runs.decideFinding(projectId, String(req.params.runId), String(req.params.findingId), parsed.data.action, actor));
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/projects/:id/reviews', async (req, res) => {
    try {
      const projectId = await scope(req, res, false); if (!projectId) return;
      res.json({ projectId, runs: await runs.list(projectId), reconciliation: runs.reconciliationStatus(projectId) });
    } catch (error) { fail(res, error); }
  });
}
