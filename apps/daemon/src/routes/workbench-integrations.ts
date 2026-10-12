import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { LicenceWriteSurface } from '@open-design/contracts';
import { buildConnectorInventory, buildIntegrationRoster, type RosterMcpServer } from '../workbench/integration-roster.js';
import { IntegrationStatusError, type IntegrationStatusService } from '../workbench/integration-status.js';
import { LicenceRecordError, putLicenceRecord, readAllLicenceRecords, readLicenceRecord } from '../workbench/licence-record.js';

export interface RegisterWorkbenchIntegrationRoutesDeps {
  db: Database.Database;
  status?: Pick<IntegrationStatusService, 'status' | 'test'>;
  http: {
    sendApiError: (res: Response, status: number, code: string, message: string, init?: Record<string, unknown>) => unknown;
    isLocalSameOrigin: (req: Request, port: number) => boolean;
    resolvedPortRef: { current: number };
  };
  /** The daemon's own MCP configuration; only server identity and enabled state are read. */
  readMcpServers: () => Promise<readonly RosterMcpServer[]>;
}

/**
 * AC-R08.1 roster, AC-R12.1 connector inventory and the R16 licence record. Reads are
 * local same-origin like app settings.
 *
 * Licence writes are refused when they carry any Authorization credential (an agent-run
 * tool token, a deployment API token, Basic credentials) or a workspace member identity.
 * That stops cooperative agents and team members; it is not a security boundary against
 * a process running as the same OS user, which can call this loopback route without
 * those headers. Every write therefore records its surface label (Settings, od or raw
 * HTTP) in immutable history, so such a write is visible rather than silent. The label
 * comes from request metadata and is not authentication.
 */
export function licenceWriteSurface(req: Request): LicenceWriteSurface {
  if (String(req.get('x-od-client') ?? '').toLowerCase() === 'cli') return 'cli';
  if (req.get('sec-fetch-site') === 'same-origin') return 'settings';
  return 'http';
}
export function registerWorkbenchIntegrationRoutes(app: Express, deps: RegisterWorkbenchIntegrationRoutesDeps): void {
  const local = (req: Request, res: Response): boolean => {
    if (deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) return true;
    deps.http.sendApiError(res, 403, 'FORBIDDEN', 'Cross-origin request rejected');
    return false;
  };
  const fail = (res: Response, error: unknown) => {
    if (error instanceof IntegrationStatusError) deps.http.sendApiError(res, error.status, error.code, error.message);
    else if (error instanceof LicenceRecordError) deps.http.sendApiError(res, error.status, error.code, error.message, error.details ? { details: error.details } : undefined);
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to read or save the integration record');
  };
  async function roster() {
    // A missing or unreadable MCP config means no daemon binding, never a failed roster.
    const servers = await deps.readMcpServers().catch(() => []);
    const value = buildIntegrationRoster({ mcpServers: servers, licences: readAllLicenceRecords(deps.db) });
    return deps.status ? deps.status.status(value) : value;
  }

  app.get('/api/workbench/integrations', async (req, res) => {
    if (!local(req, res)) return;
    try { res.json(await roster()); } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/integrations/:integrationId/test', async (req, res) => {
    if (!local(req, res)) return;
    if (!deps.status) { deps.http.sendApiError(res, 503, 'SERVICE_UNAVAILABLE', 'Integration probes are unavailable'); return; }
    try { res.json(await deps.status.test(await roster(), String(req.params.integrationId))); } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/connectors/inventory', async (req, res) => {
    if (!local(req, res)) return;
    try { res.json(buildConnectorInventory(await roster())); } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/licences/:sourceId', (req, res) => {
    if (!local(req, res)) return;
    try { res.json(readLicenceRecord(deps.db, req.params.sourceId)); } catch (error) { fail(res, error); }
  });
  app.put('/api/workbench/licences/:sourceId', (req, res) => {
    if (!local(req, res)) return;
    if (req.get('authorization') !== undefined || req.get('x-od-workspace-id') !== undefined || req.get('x-od-workspace-member-id') !== undefined) {
      deps.http.sendApiError(res, 403, 'FORBIDDEN', 'The held licence is recorded from Settings or od without credentials or a workspace identity');
      return;
    }
    try { res.json(putLicenceRecord(deps.db, req.params.sourceId, req.body, { surface: licenceWriteSurface(req) })); } catch (error) { fail(res, error); }
  });
}
