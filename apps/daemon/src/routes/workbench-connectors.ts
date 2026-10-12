import type { Express, Request, Response } from 'express';
import { ConnectorError, type ConnectorProxy } from '../workbench/connectors/connector-proxy.js';

export interface RegisterWorkbenchConnectorRoutesDeps {
  http: {
    sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown;
    isLocalSameOrigin: (req: Request, port: number) => boolean;
    resolvedPortRef: { current: number };
  };
  proxy: Pick<ConnectorProxy, 'search' | 'detail' | 'select' | 'selectedImage'>;
}

/**
 * AC-R12.2: POST /api/workbench/connectors/:id/search and /detail, the typed read-only
 * proxy shared by the canvas and `od workbench connector search|detail`. Local
 * same-origin like the connector inventory. Credentials never leave the daemon.
 */
export function registerWorkbenchConnectorRoutes(app: Express, deps: RegisterWorkbenchConnectorRoutesDeps): void {
  const fail = (res: Response, error: unknown) => {
    if (error instanceof ConnectorError) {
      const { retryable, ...details } = error.details;
      return deps.http.sendApiError(res, error.status, error.code, error.message, { retryable: retryable === true, details });
    }
    return deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Connector request failed');
  };
  const local = (req: Request, res: Response): boolean => {
    if (deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) return true;
    deps.http.sendApiError(res, 403, 'FORBIDDEN', 'Cross-origin request rejected');
    return false;
  };
  app.post('/api/workbench/connectors/:connectorId/search', async (req, res) => {
    if (!local(req, res)) return;
    try { res.json(await deps.proxy.search(String(req.params.connectorId), req.body)); } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/connectors/:connectorId/detail', async (req, res) => {
    if (!local(req, res)) return;
    try { res.json(await deps.proxy.detail(String(req.params.connectorId), req.body)); } catch (error) { fail(res, error); }
  });
  app.post('/api/workbench/connectors/:connectorId/select', async (req, res) => {
    if (!local(req, res)) return;
    try { res.json(await deps.proxy.select(String(req.params.connectorId), req.body)); } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/connectors/:connectorId/images/:key', async (req, res) => {
    if (!local(req, res)) return;
    try {
      const image = await deps.proxy.selectedImage(String(req.params.connectorId), String(req.params.key));
      res.set({ 'Content-Type': image.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" }).send(image.bytes);
    } catch (error) { fail(res, error); }
  });
}
