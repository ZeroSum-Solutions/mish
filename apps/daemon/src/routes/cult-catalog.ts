/**
 * `GET /api/cult/catalog`, `GET /api/cult/catalog/:id` and `GET /api/cult/catalog/:id/preview` —
 * the Cult UI Pro inventory, projected
 * to a curated browse list of brand-free display rows (`../cult-catalog-projection.ts`) with an honest state per item
 * (Insertable / Needs adaptation / Not converted yet / App only / Pending).
 *
 * The web Catalog tab's Blocks view (section and page rows) and Components view (primitive and
 * app rows) and `od cult list|get` all read this route — the root `AGENTS.md`'s "Capability
 * exposure (UI/CLI dual-track)" rule. Optional `?kind=` (`section|page|primitive|app`, or the
 * shorthands `blocks` = section+page and `components` = primitive+app) and `?state=` filters.
 * Reviewed examples and derived page sections live in their parent's `relatedItems`. Individual
 * item, preview and source APIs keep the full inventory, including these related rows.
 *
 * `catalog.json` is imported as a JSON module for the same reason `routes/sections.ts` does: a
 * static import survives the daemon's esbuild prebundle, an `import.meta.dirname` file read does
 * not. It is projected on first request and reused. The projection fails closed (a brand left in
 * display text, an unknown conversion status, section kind or port queue throws), so a bad
 * inventory answers 500 with the reason rather than a guessed row; `tests/cult-catalog-routes.test.ts`
 * projects the shipped inventory, so CI catches that before release, and the daemon still boots
 * for every other route. Read-only, public-safe metadata (no source content), so there is no
 * per-route gate beyond the daemon's global `/api` middleware.
 *
 * `/preview` serves a row's card image (a WebP rendered from the licensed item, never source
 * text): the converter preview of an insertable row, else the package's rendered thumbnail
 * (`generated/thumbnails.json`). The id only selects a catalog row; the file name comes from the
 * catalog and is validated before it is joined to a fixed directory. 404 for an unknown id or a
 * row without an image.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Express } from 'express';
import type { CultCatalogItem, CultCatalogItemResponse, CultCatalogListResponse } from '@open-design/contracts';
import { CULT_CATALOG_KIND_FILTERS, CULT_CATALOG_STATES, isCultCatalogState } from '@open-design/contracts';
import cultInventoryJson from '@open-design/cult-ui-catalog/catalog.json' with { type: 'json' };
import cultCurationJson from '@open-design/cult-ui-catalog/catalog-curation.json' with { type: 'json' };
import cultThumbnailsJson from '@open-design/cult-ui-catalog/generated/thumbnails.json' with { type: 'json' };
import { cultSlugs } from './cult-registry.js';
import type { RouteDeps } from '../server-context.js';
import {
  CULT_PREVIEW_FILE_PATTERN,
  cultPreviewIndex,
  curateCultCatalogItems,
  projectCultCatalog,
  type CultInventory,
  type CultCatalogCuration,
  type CultPreviewFile,
  type CultThumbnailManifest,
} from '../cult-catalog-projection.js';

export interface RegisterCultCatalogRoutesDeps extends RouteDeps<'http'> {}

let projected: CultCatalogListResponse['catalog'] | null = null;
let previews: Map<string, CultPreviewFile> | null = null;
let allItems: CultCatalogItem[] | null = null;

/** Every row's preview file (converter preview or rendered thumbnail), built on first use. */
export function cultPreviews(): Map<string, CultPreviewFile> {
  previews ??= cultPreviewIndex(cultInventoryJson as unknown as CultInventory, cultThumbnailsJson as unknown as CultThumbnailManifest);
  return previews;
}

/** The projected catalog, built on first use and reused (the inventory ships with the package). */
export function cultCatalog(): CultCatalogListResponse['catalog'] {
  if (projected === null) {
    const next = projectCultCatalog(cultInventoryJson as unknown as CultInventory, cultPreviews(), cultSlugs());
    const hashes = new Map<string, string>();
    const rows = (cultInventoryJson as unknown as CultInventory).rows;
    next.items.forEach((item, index) => {
      if (item.preview.kind !== 'image') return;
      const file = cultPreviewPath(rows[index]!.id, cultGeneratedDir());
      if (!file) return;
      let revision = hashes.get(file);
      if (!revision) {
        revision = createHash('sha256').update(readFileSync(file)).digest('hex');
        hashes.set(file, revision);
      }
      item.preview = { ...item.preview, revision };
    });
    const curated = curateCultCatalogItems(next.items, cultInventoryJson as unknown as CultInventory, cultCurationJson as CultCatalogCuration);
    allItems = curated.allItems;
    projected = { ...next, items: curated.items };
  }
  return projected;
}

let lookup: Map<string, { item: CultCatalogItem; rowId: string }> | null = null;

/**
 * One catalog item by its public id (`cult:<slug>`) or slug, or by an alias: the internal
 * `cult:<name>` id or bare name. The response only ever carries the public id.
 */
export function findCultCatalogItem(key: string): { item: CultCatalogItem; rowId: string } | undefined {
  if (lookup === null) {
    const next = new Map<string, { item: CultCatalogItem; rowId: string }>();
    const rows = (cultInventoryJson as unknown as CultInventory).rows;
    cultCatalog();
    const items = allItems!;
    rows.forEach((row, index) => {
      const entry = { item: items[index]!, rowId: row.id };
      for (const alias of [row.id, row.name]) if (!next.has(alias)) next.set(alias, entry);
    });
    // Public ids and slugs win over any alias.
    rows.forEach((row, index) => {
      const entry = { item: items[index]!, rowId: row.id };
      next.set(entry.item.id, entry);
      next.set(entry.item.slug, entry);
    });
    lookup = next;
  }
  return lookup.get(key);
}

/**
 * The catalog package's `generated/` directory, resolved at run time through the package's own
 * `catalog.json` export (the images are files, not modules, so they are read from disk).
 */
export function cultGeneratedDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@open-design/cult-ui-catalog/catalog.json')), 'generated');
}

/**
 * The absolute path of a row's preview image, or null. The id is only a lookup key: the file name
 * comes from the catalog (validated as one `.webp` segment) and the joined path must stay inside
 * its fixed directory, so no request text ever reaches the filesystem path.
 */
export function cultPreviewPath(id: string, generatedDir: string, index: ReadonlyMap<string, CultPreviewFile> = cultPreviews()): string | null {
  const entry = index.get(id);
  if (!entry || !CULT_PREVIEW_FILE_PATTERN.test(entry.file)) return null;
  const base = path.resolve(generatedDir, entry.dir);
  const file = path.resolve(base, entry.file);
  if (path.dirname(file) !== base) return null;
  return existsSync(file) ? file : null;
}

/** Previews change only with a catalog release; a day of caching, then revalidation by ETag. */
const PREVIEW_CACHE_CONTROL = 'public, max-age=86400';

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function registerCultCatalogRoutes(app: Express, ctx: RegisterCultCatalogRoutesDeps): void {
  const { sendApiError } = ctx.http;

  app.get('/api/cult/catalog', (req, res) => {
    try {
      const kind = queryString(req.query.kind);
      const kinds = kind !== undefined && Object.hasOwn(CULT_CATALOG_KIND_FILTERS, kind) ? CULT_CATALOG_KIND_FILTERS[kind] : undefined;
      if (kind !== undefined && kinds === undefined) {
        return sendApiError(res, 400, 'BAD_REQUEST', `kind must be one of ${Object.keys(CULT_CATALOG_KIND_FILTERS).join(', ')}`);
      }
      const state = queryString(req.query.state);
      if (state !== undefined && !isCultCatalogState(state)) {
        return sendApiError(res, 400, 'BAD_REQUEST', `state must be one of ${CULT_CATALOG_STATES.join(', ')}`);
      }
      const catalog = cultCatalog();
      const items = catalog.items.filter((item) =>
        (kinds === undefined || kinds.includes(item.assetKind)) && (state === undefined || item.state === state));
      res.json({ catalog: { ...catalog, items } } satisfies CultCatalogListResponse);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/cult/catalog/:id/preview', (req, res) => {
    try {
      const found = findCultCatalogItem(req.params.id);
      if (!found) {
        return sendApiError(res, 404, 'NOT_FOUND', 'no Cult catalog item with that id');
      }
      const file = cultPreviewPath(found.rowId, cultGeneratedDir());
      if (!file) return sendApiError(res, 404, 'NOT_FOUND', 'this Cult catalog item has no preview image');
      res.setHeader('Cache-Control', PREVIEW_CACHE_CONTROL);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(path.basename(file), { root: path.dirname(file), dotfiles: 'deny', headers: { 'Content-Type': 'image/webp' } }, (err) => {
        if (err && !res.headersSent) sendApiError(res, 404, 'NOT_FOUND', 'preview image unavailable');
      });
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/cult/catalog/:id', (req, res) => {
    try {
      const item = findCultCatalogItem(req.params.id)?.item;
      if (!item) return sendApiError(res, 404, 'NOT_FOUND', 'no Cult catalog item with that id');
      res.json({ item } satisfies CultCatalogItemResponse);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });
}
