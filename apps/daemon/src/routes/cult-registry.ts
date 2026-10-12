/**
 * Remix into project — `GET /api/cult/r/<slug>.json` and `GET /api/cult/copy/:id`.
 *
 * The first answers a registry item that `npx shadcn@latest add http://127.0.0.1:<port>/api/cult/r/<slug>.json`
 * installs, and `od cult add` reads; the second answers the web copy buttons (install URL, npm
 * packages, main file). Both read the private source kit through `../cult-registry.ts`, which only
 * opens catalogued names and serves pinned bytes.
 *
 * These are the only routes that return licensed Cult UI Pro source text, so they answer this
 * machine only (docs/legal/cult-ui-pro-rights.md). The whole rule is `cultLocalOnlyRefusal`
 * (packages/contracts/src/api/cult-local-only.ts): loopback peer, Host and Origin; every
 * forwarded client loopback (the web sidecar names the client it accepted in X-Forwarded-For);
 * and no forwarded host, scheme or port at all, because a proxy that sends those (Next's dev
 * rewrite) relays a Host the client chose. A token-authenticated remote client
 * (`OD_BIND_HOST=0.0.0.0` with `OD_API_TOKEN`) is refused too. The check lives on the route, not
 * in the global `/api` middleware, so no daemon setting can widen it.
 *
 * Limit: a TCP-level forwarder (`ssh -R`, `socat`, `ngrok tcp`, …) that terminates on this
 * machine hands the daemon a loopback connection with no forwarding header, and no loopback check
 * can tell it from a local caller. Running one in front of the daemon exposes these routes.
 */

import type { Express, Request, Response } from 'express';
import type { CultCopyResponse } from '@mish/contracts';
import { cultLocalOnlyRefusal } from '@mish/contracts';

import { cultInventoryData, cultSlugData } from '../cult-data.js';
import { CultRegistry, CultRegistryError, resolveCultKitDir, type CultRegistryRow } from '../cult-registry.js';
import { mishPackGeneration } from '../mish-packs/overlay.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterCultRegistryRoutesDeps extends RouteDeps<'http'> {}

export interface CultRegistryRouteOptions {
  /** Defaults to the shipped inventory. */
  rows?: readonly CultRegistryRow[];
  /** The server supplies its validated bundled-kit fallback; a bare registrar defaults to `CULT_KIT_DIR`. A function is read per request, so an installed pack takes effect without a restart. */
  kitDir?: string | null | (() => string | null);
  /** Row id → public slug. Defaults to the catalog package's `generated/slugs.json`. */
  slugs?: ReadonlyMap<string, string>;
}

/** The public slugs (`generated/slugs.json`, or an installed pack's), by row id. */
export function cultSlugs(): Map<string, string> {
  return new Map(Object.entries((cultSlugData() as unknown as { items: Record<string, string> }).items));
}

export function registerCultRegistryRoutes(app: Express, ctx: RegisterCultRegistryRoutesDeps, options: CultRegistryRouteOptions = {}): void {
  const { sendApiError } = ctx.http;
  // Rows, slugs and the kit are read through the pack overlay and rebuilt when the set of packs changes.
  let built: { generation: number; kitDir: string | null; registry: CultRegistry } | null = null;
  const current = (): CultRegistry => {
    const generation = mishPackGeneration();
    const kitDir = typeof options.kitDir === 'function' ? options.kitDir() : options.kitDir === undefined ? resolveCultKitDir() : options.kitDir;
    if (!built || built.generation !== generation || built.kitDir !== kitDir) {
      const rows = options.rows ?? (cultInventoryData() as unknown as { rows: CultRegistryRow[] }).rows;
      built = { generation, kitDir, registry: new CultRegistry(rows, kitDir, options.slugs ?? cultSlugs()) };
    }
    return built.registry;
  };

  /** The loopback base the served item's own URLs use: the port this request reached. */
  const baseUrl = (req: Request): string => `http://127.0.0.1:${req.socket.localPort}`;

  const localOnly = (req: Request, res: Response): boolean => {
    const refusal = cultLocalOnlyRefusal({ peer: req.socket.remoteAddress, header: (name) => req.get(name) });
    if (refusal !== null) {
      sendApiError(res, 403, 'FORBIDDEN', `licensed source is served to this machine only: ${refusal}`);
      return false;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return true;
  };

  const fail = (res: Response, err: unknown) => {
    if (err instanceof CultRegistryError) return sendApiError(res, err.status, err.code, err.message);
    return sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  };

  app.get('/api/cult/r/:file', (req, res) => {
    if (!localOnly(req, res)) return;
    try {
      const file = String(req.params.file ?? '');
      if (!file.endsWith('.json')) return sendApiError(res, 404, 'NOT_FOUND', 'registry items end in .json');
      res.json(current().item(file.slice(0, -'.json'.length), baseUrl(req)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/cult/copy/:id', (req, res) => {
    if (!localOnly(req, res)) return;
    try {
      const file = typeof req.query.file === 'string' && req.query.file.length > 0 ? req.query.file : undefined;
      res.json({ copy: current().copyInfo(String(req.params.id ?? ''), baseUrl(req), file) } satisfies CultCopyResponse);
    } catch (err) {
      fail(res, err);
    }
  });
}
