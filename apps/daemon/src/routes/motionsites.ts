/**
 * Daemon-side MotionSites bridge routes (design doc §1, §4). Phase D wires the `od` CLI and web UI
 * against these; this phase exposes the daemon endpoint only (`AGENTS.md`'s dual-track rule: "Land
 * all three in the same PR" applies to the *capability's* first ship, not to every phase of a
 * staged rollout the repo's own phase plan explicitly splits across worktrees).
 *
 * Three routes:
 *   - `GET /api/motionsites/connection` — cheap, no MotionSites call, mirrors `mcp-tokens.json`.
 *   - `GET /api/motionsites/catalog` — merged `local-corpus` + federated `motionsites-mcp` entries.
 *     Never a MotionSites-specific error; a missing connection just means fewer entries. Carries
 *     the connection status alongside the merged entries, and — only when the federated half
 *     degraded because the upstream endpoint itself failed, not merely "not connected" — a
 *     structured `upstream` field (`MotionSitesCatalogResult`'s own doc in
 *     `../motionsites/catalog.ts`).
 *   - `GET /api/motionsites/starting-points` — the static 40-template list. No connection needed.
 *
 * Deliberately NOT here: a `get_prompt`/`designReference` route. The design doc is explicit that a
 * prompt body is fetched only "when a build starts" — phase D's build-start route is the one
 * caller, and it imports `fetchMotionSitesDesignReference` from
 * `apps/daemon/src/motionsites/design-reference.ts` directly (an in-process function call, not a
 * second HTTP hop back into this daemon) rather than this file exposing a public HTTP endpoint
 * whose response a client could accidentally log or cache.
 */

import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import type { MotionSitesCatalogResponse } from '@open-design/contracts/api/motionsites';
import { getMotionSitesConnectionStatus } from '../motionsites/connection.js';
import { fetchMotionSitesCatalogEntries } from '../motionsites/catalog.js';
import { MOTIONSITES_STARTING_POINTS } from '../motionsites/starting-points-data.js';

export interface RegisterMotionSitesRoutesDeps extends RouteDeps<'http' | 'paths'> {}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function registerMotionSitesRoutes(app: Express, ctx: RegisterMotionSitesRoutesDeps): void {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.get('/api/motionsites/connection', async (_req, res) => {
    try {
      const status = await getMotionSitesConnectionStatus(RUNTIME_DATA_DIR);
      res.json(status);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/motionsites/catalog', async (req, res) => {
    try {
      const query = queryString(req.query.query);
      const category = queryString(req.query.category);
      const kindRaw = queryString(req.query.kind);
      const accessRaw = queryString(req.query.access);
      const limitRaw = queryString(req.query.limit);
      const kind = kindRaw === 'website' || kindRaw === 'app' || kindRaw === 'any' ? kindRaw : undefined;
      const access = accessRaw === 'free' || accessRaw === 'premium' || accessRaw === 'any' ? accessRaw : undefined;
      const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;

      const [{ entries, upstream }, connection] = await Promise.all([
        fetchMotionSitesCatalogEntries(RUNTIME_DATA_DIR, {
          ...(query !== undefined ? { query } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(access !== undefined ? { access } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
        getMotionSitesConnectionStatus(RUNTIME_DATA_DIR),
      ]);
      const body: MotionSitesCatalogResponse = {
        catalog: { schema: 'section-catalog/1', entries },
        connection: connection.status,
        ...(upstream ? { upstream } : {}),
      };
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/motionsites/starting-points', (_req, res) => {
    res.json({ startingPoints: MOTIONSITES_STARTING_POINTS });
  });
}
