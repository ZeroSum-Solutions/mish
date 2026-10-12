import type { Express, Request, Response } from 'express';
import { parsePutProjectDesignContext, parsePutProjectRubric, parsePutWorkbenchPreferences } from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest, AuthorizeProjectRequestSync } from '../collab/project-request-authority.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import {
  assertContextProject, ProjectContextError, readProjectContext, readProjectRubric, readWorkbenchPreferences,
  putProjectContext, putProjectRubric, putWorkbenchPreferences, type ProjectContextReferences,
  checkProjectContextWrite, checkProjectRubricWrite,
} from '../workbench/project-context.js';
import { contextReferenceRequest, type ProjectContextReferenceRequest } from '../workbench/context-references.js';

export interface RegisterWorkbenchContextRoutesDeps extends RouteDeps<'db'> {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  authorizeProjectCommit: AuthorizeProjectRequestSync;
  referencesForProject?(req: Request, projectId: string, references: ProjectContextReferenceRequest): ProjectContextReferences | Promise<ProjectContextReferences>;
}
export function registerWorkbenchContextRoutes(app: Express, deps: RegisterWorkbenchContextRoutesDeps): void {
  const deny = (res: Response) => deps.http.sendApiError(res, 403, 'project-forbidden', 'Project scope is not authorized');
  async function scope(req: Request, res: Response, write: boolean): Promise<string | null> {
    const id = req.params.id;
    const values = [id, req.query.projectId, req.get('x-od-project-id')].filter(value => value !== undefined);
    if (typeof id !== 'string' || values.some(value => typeof value !== 'string' || !value || value.trim() !== value || /\p{Cc}/u.test(value)) || new Set(values).size !== 1) {
      deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Pass one matching project scope'); return null;
    }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    const safeResponse = { req, status() { return safeResponse; }, json() { return deny(res); } } as unknown as Response;
    if (!await deps.authorizeProjectRequest(req, safeResponse, id, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
    assertContextProject(deps.db, id);
    return id;
  }
  function fail(res: Response, error: unknown): void {
    if (error instanceof ProjectContextError) deps.http.sendApiError(res, error.status, error.code, error.message, error.current ? { details: { current: error.current } } : undefined);
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to read or save the project record');
  }
  for (const family of ['context', 'rubric', 'preferences'] as const) {
    app.get(`/api/workbench/projects/:id/${family}`, async (req, res) => {
      try {
        const projectId = await scope(req, res, false); if (!projectId) return;
        const raw = req.query.revision;
        if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
          deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Historical revision must be a positive safe integer'); return;
        }
        const revision = raw === undefined ? undefined : Number(raw);
        res.json(family === 'context' ? readProjectContext(deps.db, projectId, revision) : family === 'rubric' ? readProjectRubric(deps.db, projectId, revision) : readWorkbenchPreferences(deps.db, projectId, revision));
      } catch (error) { fail(res, error); }
    });
    app.put(`/api/workbench/projects/:id/${family}`, async (req, res) => {
      try {
        const projectId = await scope(req, res, true); if (!projectId) return;
        try {
          if (family === 'context') parsePutProjectDesignContext(req.body);
          else if (family === 'rubric') parsePutProjectRubric(req.body);
          else parsePutWorkbenchPreferences(req.body);
        } catch { deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass a complete project draft and a safe nonnegative expected revision'); return; }
        const authorize = () => {
          const silent = { req, status() { return silent; }, json() {} } as unknown as Response;
          if (!deps.authorizeProjectCommit(req, silent, projectId, { mode: 'write', capability: 'writeFiles' })) throw new ProjectContextError(403, 'project-forbidden', 'Project scope is not authorized');
        };
        if (family === 'preferences') { res.json(putWorkbenchPreferences(deps.db, projectId, req.body, authorize)); return; }
        const equal = family === 'context' ? checkProjectContextWrite(deps.db, projectId, req.body, authorize) : checkProjectRubricWrite(deps.db, projectId, req.body, authorize);
        if (equal) { res.json(equal); return; }
        // No await belongs in SQLite. A failed lookup is validated only after
        // the final authority/CAS check, preserving conflict precedence.
        let resolved: ProjectContextReferences | undefined;
        const requested = contextReferenceRequest(family, req.body);
        if (requested.assets.length || requested.resources.length || requested.designSystems.length) {
          try { resolved = await deps.referencesForProject?.(req, projectId, requested); } catch { /* final save fails closed */ }
        }
        res.json(family === 'context' ? putProjectContext(deps.db, projectId, req.body, resolved, authorize) : putProjectRubric(deps.db, projectId, req.body, resolved, authorize));
      } catch (error) { fail(res, error); }
    });
  }
}
