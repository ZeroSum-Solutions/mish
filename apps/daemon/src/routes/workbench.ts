import type { Express, Request, Response } from 'express';
import { parseResourceSearchRequest, type ResourceRequestContext } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { requestWithWorkspaceNavigationScope, resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { ResourceError, inspectResource, previewResource, searchResources, type ResourceSourceAdapter, type ResourceSearchOptions } from '../workbench/resources.js';
import { ProjectContextError } from '../workbench/project-context.js';
import type { ComponentTargetFacts, ComponentProjectFacts } from '../workbench/component-ranking.js';
import { TOKEN_SPECIMEN_CSP } from '../workbench/token-evidence.js';

export interface RegisterWorkbenchRoutesDeps {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  sourcesForRequest(req: Request, context: ResourceRequestContext): readonly ResourceSourceAdapter[];
  componentContextForRequest?(req: Request, context: ResourceRequestContext): Promise<ResourceSearchOptions>;
  projectStateForRequest?(req: Request, context: ResourceRequestContext): ResourceSearchOptions['projectState'];
}
/** Shared by every workbench resource route: one project-scope rule and one error envelope. */
export function createWorkbenchResourceRequestScope(deps: Pick<RegisterWorkbenchRoutesDeps, 'http' | 'authorizeProjectRequest'>) {
  const fail = (res: Response, error: unknown) => {
    if (error instanceof ProjectContextError && error.status === 403) error = new ResourceError(403, 'project-forbidden', 'Project scope is not authorized');
    if (error instanceof ResourceError) return deps.http.sendApiError(res, error.status, error.code, error.message, error.nextSteps.length ? { details: { nextSteps: error.nextSteps } } : undefined);
    return deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Resource inspection failed');
  };
  /** `navigation` admits the Workspace pair from the query for iframe document loads, which
   * cannot set headers (read-only; the same rule the design-system preview routes use). */
  const resolveContext = async (req: Request, res: Response, requestedProject?: unknown, navigation = false): Promise<{ context: ResourceRequestContext; scoped: Request } | null> => {
    const queryProject = req.query.projectId;
    const headerProject = req.get('x-od-project-id');
    const scopes = [requestedProject, queryProject, headerProject].filter(value => value !== undefined);
    if (scopes.some(value => typeof value !== 'string' || !value.trim()) || new Set(scopes).size > 1) {
      deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Project header and request scope must match'); return null;
    }
    const scoped = navigation ? requestWithWorkspaceNavigationScope(req) : req;
    if (scoped === 'conflict') { deps.http.sendApiError(res, 400, 'WORKSPACE_CONTEXT_CONFLICT', 'workspace header and navigation scope must match'); return null; }
    const authority = resolveOptionalLocalWorkspaceRequestAuthority(scoped);
    if (!authority.ok) { deps.http.sendApiError(res, authority.status, authority.code, authority.message); return null; }
    const projectId = scopes[0] as string | undefined;
    if (projectId) {
      // The existing project gate owns authorization. Normalize its denial envelope without
      // exposing private project existence, binding metadata or a current resource key.
      const denialResponse = {
        req,
        status() { return denialResponse; },
        json() { return deps.http.sendApiError(res, 403, 'project-forbidden', 'Project scope is not authorized'); },
      } as unknown as Response;
      if (!await deps.authorizeProjectRequest(req, denialResponse, projectId, { mode: 'read', ...(navigation ? { allowNavigationQuery: true } : {}) })) return null;
    }
    return { scoped: scoped as Request, context: { principalId: authority.context ? `workspace:${authority.context.workspaceId}:${authority.context.workspaceMemberId}` : 'local-daemon', ...(projectId ? { projectId } : {}) } };
  };
  return { fail, resolveContext };
}
/** This route remains behind server.ts's global API auth. Identifiers confer no authority. */
export function registerWorkbenchRoutes(app: Express, deps: RegisterWorkbenchRoutesDeps): void {
  const { fail, resolveContext } = createWorkbenchResourceRequestScope(deps);
  const search = (componentsMode?: 'rank' | 'list') => async (req: Request, res: Response) => {
    let request;
    try {
      request = parseResourceSearchRequest(req.body);
      if (componentsMode) request = parseResourceSearchRequest({ ...request, componentPicker: { ...(request.componentPicker ?? {}), mode: componentsMode } });
    }
    catch { return deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid resource search request'); }
    try {
      const resolved = await resolveContext(req,res,request.projectId); if (!resolved) return;
      const { context } = resolved;
      const scopedRequest = { ...request, ...(context.projectId ? { projectId: context.projectId } : {}) };
      const projectState = deps.projectStateForRequest?.(req, context);
      res.json(await searchResources(scopedRequest,context,deps.sourcesForRequest(req,context), { ...(projectState ? { projectState } : {}), ...(request.componentPicker ? await deps.componentContextForRequest?.(req, context) : {}), componentsOnly: !!componentsMode }));
    } catch (error) { fail(res,error); }
  };
  app.post('/api/workbench/resources/search', search());
  app.post('/api/workbench/components/rank', search('rank'));
  app.post('/api/workbench/components/list', search('list'));
  app.get('/api/workbench/resources/:refKey', async (req,res) => {
    try {
      const resolved = await resolveContext(req,res); if (!resolved) return;
      res.json(await inspectResource(String(req.params.refKey),resolved.context,deps.sourcesForRequest(req,resolved.context), deps.componentContextForRequest ? { ...(await deps.componentContextForRequest(req, resolved.context)), ...(deps.projectStateForRequest ? { projectState: deps.projectStateForRequest(req, resolved.context) } : {}) } : undefined));
    } catch (error) { fail(res,error); }
  });
  // AC-R07.3: a static specimen for an owned token cohort. The web harness loads the HTML
  // as sandboxed srcDoc; the CSP admits no network request, frame, base or form target and
  // sandboxes direct navigation. `Accept: application/json` (od workbench preview) gets the
  // same specimen's token values from the same checks, for UI/CLI parity.
  app.get('/api/workbench/resources/:refKey/preview', async (req,res) => {
    try {
      const resolved = await resolveContext(req,res,undefined,true); if (!resolved) return;
      const preview = await previewResource(String(req.params.refKey),resolved.context,deps.sourcesForRequest(resolved.scoped,resolved.context));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Accept');
      if (req.accepts(['html', 'json']) === 'json') {
        res.json({ ref: preview.resource.ref, refKey: preview.resource.refKey, title: preview.specimen.title, category: preview.specimen.category, tokens: preview.specimen.tokens, notes: preview.specimen.notes });
        return;
      }
      res.setHeader('Content-Security-Policy', TOKEN_SPECIMEN_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('html').send(preview.html);
    } catch (error) { fail(res,error); }
  });
}
