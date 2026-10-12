import type { Express } from 'express';
import { parseComponentLedger } from '@mish/contracts';
import ledgerJson from '../workbench/component-ledger.json' with { type: 'json' };
import { buildComponentLedgerReport } from '../workbench/component-ledger-report.js';
import type { PackRegistry } from '../packs/registry.js';
import type { RouteDeps } from '../server-context.js';

export function registerComponentLedgerRoutes(app: Express, ctx: RouteDeps<'http'>, registry: PackRegistry): void {
  const ledger = parseComponentLedger(ledgerJson);
  app.get('/api/components/ledger', ctx.http.requireLocalDaemonRequest, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(buildComponentLedgerReport(ledger, registry));
    } catch {
      ctx.http.sendApiError(res, 503, 'UNAVAILABLE', 'Component inventory is unavailable; check installed pack metadata and component identities');
    }
  });
}
