import type { Express, Request, Response } from 'express';
import { parsePutSessionModel, sessionModelChoicesEqual } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import type { RuntimeAgentDef } from '../runtimes/types.js';
import { isKnownModel, sanitizeCustomModel } from '../runtimes/models.js';
import { assertModelSession, putSessionModel, readSessionModel, SessionModelError } from '../workbench/session-model.js';
import { evaluateModelPreflight } from '../workbench/model-preflight.js';

export interface RegisterWorkbenchModelRoutesDeps extends RouteDeps<'db'> {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  agents: {
    getAgentDef(agentId: string): RuntimeAgentDef | null | undefined;
    modelScopeForAgent(agentId: string): Promise<string | null>;
  };
}
export function registerWorkbenchModelRoutes(app: Express, deps: RegisterWorkbenchModelRoutesDeps): void {
  const deny = (res: Response) => deps.http.sendApiError(res, 403, 'project-forbidden', 'Project scope is not authorized');
  async function scope(req: Request, res: Response, write: boolean): Promise<string | null> {
    const values = [req.query.projectId, req.get('x-od-project-id')].filter(v => v !== undefined);
    if (!values.length || values.some(v => typeof v !== 'string' || !v.trim()) || new Set(values).size !== 1) {
      deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Pass one matching project scope'); return null;
    }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    const projectId = (values[0] as string).trim();
    const safeResponse = { req, status() { return safeResponse; }, json() { return deny(res); } } as unknown as Response;
    if (!await deps.authorizeProjectRequest(req, safeResponse, projectId, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
    assertModelSession(deps.db, projectId, String(req.params.id));
    return projectId;
  }
  function fail(res: Response, error: unknown): void {
    if (error instanceof SessionModelError) deps.http.sendApiError(res, error.status, error.code, error.message, error.current ? { details: { current: error.current } } : undefined);
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to read or save the session model');
  }
  app.get('/api/workbench/sessions/:id/model', async (req, res) => {
    try { const projectId = await scope(req, res, false); if (projectId) res.json(readSessionModel(deps.db, projectId, String(req.params.id))); } catch (error) { fail(res, error); }
  });
  app.put('/api/workbench/sessions/:id/model', async (req, res) => {
    try {
      const projectId = await scope(req, res, true); if (!projectId) return;
      let input: ReturnType<typeof parsePutSessionModel>;
      try { input = parsePutSessionModel(req.body); } catch { deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass a complete public choice and a safe nonnegative expected revision'); return; }
      const current = readSessionModel(deps.db, projectId, String(req.params.id));
      const { expectedRevision, ...choice } = input;
      // Lost-success retries consume the accepted persisted identity before a
      // later profile/catalog change; future revisions still fail in the store.
      if (expectedRevision !== current.revision || sessionModelChoicesEqual(current.choice, choice)) {
        res.json(putSessionModel(deps.db, projectId, String(req.params.id), input)); return;
      }
      const def = deps.agents.getAgentDef(input.agentId);
      const modelScope = await deps.agents.modelScopeForAgent(input.agentId);
      if (!def || (input.modelId !== 'default' && !isKnownModel(def, input.modelId, modelScope) && !(def.supportsCustomModel !== false && sanitizeCustomModel(input.modelId) === input.modelId))) {
        deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Agent or model is not supported'); return;
      }
      res.json(putSessionModel(deps.db, projectId, String(req.params.id), input));
    } catch (error) { fail(res, error); }
  });
  // AC-R02.3: advisory, non-mutating — read scope only. Callers run this
  // before submit to learn whether the candidate agent/model/attachments
  // combination is usable; a failed result changes nothing server-side.
  app.post('/api/workbench/sessions/:id/model/preflight', async (req, res) => {
    try {
      const projectId = await scope(req, res, false); if (!projectId) return;
      res.json(await evaluateModelPreflight(deps.agents, req.body));
    } catch (error) {
      if (error instanceof SessionModelError) { fail(res, error); return; }
      deps.http.sendApiError(res, 400, 'VALIDATION_FAILED', 'Pass a public agent/model choice and safe attachment descriptors');
    }
  });
}
