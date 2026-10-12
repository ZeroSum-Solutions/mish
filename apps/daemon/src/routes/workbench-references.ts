import type { Express } from 'express';
import type { RegisterWorkbenchConnectorRoutesDeps } from './workbench-connectors.js';
import { ConnectorError } from '../workbench/connectors/connector-error.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { ReferenceFanoutService } from '../workbench/references/fanout.js';
import { untilAborted } from '../workbench/references/abort.js';

/** Same daemon authority boundary as read-only connector search. No project files or credentials in DTOs. */
export function registerWorkbenchReferenceRoutes(app: Express, deps: {
  http: RegisterWorkbenchConnectorRoutesDeps['http']; service: ReferenceFanoutService;
}): void {
  let active = 0;
  app.post('/api/workbench/references/fanout', async (req, res) => {
    if (!deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) {
      deps.http.sendApiError(res, 403, 'FORBIDDEN', 'Cross-origin request rejected'); return;
    }
    const authority = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!authority.ok) { deps.http.sendApiError(res, authority.status, authority.code, authority.message); return; }
    // A scoped tool bearer must never be upgraded to the daemon owner's connector seat.
    const principalId = bearerTokenFromRequest(req) ? 'tool-agent' : authority.context
      ? `workspace:${authority.context.workspaceId}:${authority.context.workspaceMemberId}` : 'local-daemon';
    if (active >= 2) { deps.http.sendApiError(res, 429, 'connector-rate-limited', 'Reference discovery is busy; try again', { retryable: true }); return; }
    active++;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new DOMException('Reference client disconnected', 'AbortError'));
    };
    res.on('close', onClose);
    try {
      const result = await untilAborted(controller.signal, () => deps.service.fanout(req.body, { principalId, signal: controller.signal }));
      if (!controller.signal.aborted && !res.destroyed) res.json(result);
    }
    catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (error instanceof ConnectorError) deps.http.sendApiError(res, error.status, error.code, error.message);
      else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Reference discovery failed');
    } finally { res.off('close', onClose); active--; }
  });
}
