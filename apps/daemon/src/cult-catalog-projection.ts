/**
 * Projects the canonical Cult UI Pro inventory (`@mish/cult-ui-catalog/catalog.json`,
 * metadata and hashes only) into the display rows of `GET /api/cult/catalog`
 * (`packages/contracts/src/api/cult-catalog.ts`).
 *
 * This is the display boundary for the inventory. Every text field a person sees (title, summary,
 * state reason, tags, source category) goes through one brand scrub driven by an explicit deny
 * list (`DENIED_BRANDS`): style providers the inventory names ("Marketing Pricing Vercel",
 * "Vite-inspired hero", "Apple Keyboard") become a neutral series letter — the same titles
 * `packages/section-catalog/scripts/build-catalog.ts`'s `cultDisplayTitle` gives the section
 * catalog (`tests/cult-catalog-routes.test.ts` asserts the two agree) — and vendors and libraries
 * ("OpenAI's GPT-5-nano", "Stripe and Redis", "Sonner-backed") become a neutral noun. Every name
 * matches at word boundaries in its bare, possessive and plural forms and inside "-style",
 * "-inspired", "-powered" and "inspired by" clauses. The scrub fails closed: after the phrase
 * rules, a backstop replaces any deny-list name still present, and `assertBrandFree` throws if
 * one survives, so raw provider text never reaches the DTO. The raw text stays in the inventory,
 * server-side. The scrub itself lives in `@mish/contracts` (api/cult-brand.ts).
 *
 * The id is public too: `cult:<slug>`, the row's brand-free public slug
 * (`packages/cult-ui-catalog/generated/slugs.json`), never the internal inventory name.
 *
 * A row's `preview` says whether the daemon serves an image for it (`cultPreviewIndex`): the
 * converter preview of an insertable row (`previewId`), or the catalog package's rendered
 * thumbnail for any other row. The DTO carries no path; `GET /api/cult/catalog/:id/preview`
 * serves the file.
 *
 * The state derivation is as strict as the scrub: each inventory `conversion.status` maps to exactly
 * one DTO state (`cultState`), and an unknown status or section kind throws instead of being
 * reported as a guessed state.
 */

import type {
  CultCatalogDependencySummary,
  CultCatalogItem,
  CultCatalogListResponse,
  CultCatalogPortQueue,
  CultCatalogPreview,
  CultCatalogPreviewSource,
  CultCatalogRelatedItem,
  CultCatalogSectionKind,
  CultCatalogState,
} from '@mish/contracts';
import { CULT_CATALOG_PORT_QUEUES, isCultCatalogSectionKind } from '@mish/contracts';

/**
 * The inventory's conversion statuses, mirrored from `packages/cult-ui-catalog/src/types.ts`
 * `CONVERSION_STATUSES` (that package ships no built types for the daemon to import;
 * `tests/cult-catalog-routes.test.ts` fails if the two lists drift).
 */
export const CULT_INVENTORY_CONVERSION_STATUSES = [
  'pending-fetch',
  'unconverted',
  'insertable',
  'adapter-needed',
  'app-only',
] as const;
export type CultInventoryConversionStatus = (typeof CULT_INVENTORY_CONVERSION_STATUSES)[number];

/** The fields of an inventory row this projection reads. */
export interface CultInventoryRow {
  id: string;
  name: string;
  title: string;
  description: string;
  original: { category: string; tags: string[] };
  source: { snapshotId: string; files: Array<{ bytes: number | null }> };
  assetKind: 'section' | 'page' | 'primitive' | 'app';
  taxonomy: { sectionKind: string };
  spineAffinities: string[];
  dependencies: string[];
  runtimeFeatures: string[];
  conversion: { status: string; reason?: string };
  portQueue?: string;
  /** The converter preview (`generated/previews/<previewId>`) of an insertable row, else null. */
  previewId?: string | null;
  /** Internal source page id for a section cut from that page. */
  derivedFrom?: string;
  /** Internal component id demonstrated by this source example. */
  demoOf?: string;
}

export interface CultInventory {
  schema: string;
  snapshot: { id: string; expectedItems: number; fetchedItems: number; pendingItems: number };
  rows: CultInventoryRow[];
}

// The brand scrub lives in contracts (`packages/contracts/src/api/cult-brand.ts`), shared with the
// registry and the catalog generator; re-exported here for the projection's callers.
export {
  DENIED_BRANDS,
  assertBrandFree,
  cultDisplayCategory,
  cultDisplayTags,
  cultDisplayText,
  cultDisplayTitle,
  findDeniedBrand,
} from '@mish/contracts';
import { cultDisplayCategory, cultDisplayTags, cultDisplayText, cultDisplayTitle } from '@mish/contracts';

// ---------------------------------------------------------------------------------------------
// State, dependencies, rows
// ---------------------------------------------------------------------------------------------

const SERVER_FEATURES: ReadonlySet<string> = new Set([
  'ai-sdk', 'api-routes', 'env-secrets', 'external-services', 'redis', 'server-actions',
]);

export function cultDependencySummary(row: Pick<CultInventoryRow, 'dependencies' | 'runtimeFeatures'>): CultCatalogDependencySummary {
  const features = new Set(row.runtimeFeatures);
  return {
    motion: features.has('motion'),
    canvas: features.has('canvas'),
    webgl: features.has('webgl') || features.has('shaders'),
    server: row.runtimeFeatures.some((feature) => SERVER_FEATURES.has(feature)),
    packages: row.dependencies.length,
  };
}

/**
 * The inventory's conversion status, read as the honest state a person sees. One status, one
 * state (see `CultCatalogState` in contracts); an unknown status throws rather than being shown
 * as a guessed state.
 */
export function cultState(status: string): CultCatalogState {
  const known = status as CultInventoryConversionStatus;
  switch (known) {
    case 'insertable': return 'insertable';
    case 'adapter-needed': return 'needs-adaptation';
    case 'unconverted': return 'not-converted';
    case 'app-only': return 'app-only';
    case 'pending-fetch': return 'pending';
    default: {
      const unreachable: never = known;
      throw new Error(`cult inventory: unknown conversion status "${String(unreachable)}"`);
    }
  }
}

function sectionKindOf(row: CultInventoryRow): CultCatalogSectionKind {
  const kind = row.assetKind === 'page' ? 'page-composition' : row.taxonomy.sectionKind;
  if (!isCultCatalogSectionKind(kind)) throw new Error(`cult inventory: ${row.id} has unknown section kind "${kind}"`);
  return kind;
}

const PORT_QUEUES: ReadonlySet<string> = new Set(CULT_CATALOG_PORT_QUEUES);

function portQueueOf(row: CultInventoryRow): CultCatalogPortQueue | undefined {
  if (row.portQueue === undefined) return undefined;
  if (!PORT_QUEUES.has(row.portQueue)) throw new Error(`cult inventory: ${row.id} has unknown port queue "${row.portQueue}"`);
  return row.portQueue as CultCatalogPortQueue;
}

function totalBytes(files: ReadonlyArray<{ bytes: number | null }>): number | null {
  if (files.length === 0) return null;
  let total = 0;
  for (const file of files) {
    if (file.bytes === null) return null;
    total += file.bytes;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------

/**
 * `generated/thumbnails.json` of the catalog package (`scripts/thumbnail-check.ts` there owns its
 * contract): a thumbnail, a thumbnail shared with a demo row, or a placeholder reason, per row
 * that has no converter preview.
 */
export interface CultThumbnailManifest {
  schema: string;
  items: Record<string, { file?: string; source?: string; placeholder?: string }>;
}

/** Where one row's preview image lives, under the catalog package's `generated/` directory. */
export interface CultPreviewFile {
  dir: 'previews' | 'thumbnails';
  file: string;
  source: CultCatalogPreviewSource;
}

/** A preview file name the route may join to its directory: one path segment, a WebP. */
export const CULT_PREVIEW_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.webp$/;

/**
 * Every row's preview file, by row id: its converter preview (`previewId`) when it has one, else
 * its thumbnail manifest entry. A name that is not a single `.webp` path segment is left out, so
 * the preview route only ever joins a validated name to a fixed directory.
 */
export function cultPreviewIndex(
  inventory: Pick<CultInventory, 'rows'>,
  thumbnails: CultThumbnailManifest | null,
): Map<string, CultPreviewFile> {
  const index = new Map<string, CultPreviewFile>();
  if (thumbnails !== null && thumbnails.schema !== 'cult-thumbnails/1') {
    throw new Error(`cult thumbnails: unexpected schema "${thumbnails.schema}"`);
  }
  for (const row of inventory.rows) {
    if (typeof row.previewId === 'string') {
      if (CULT_PREVIEW_FILE_PATTERN.test(row.previewId)) index.set(row.id, { dir: 'previews', file: row.previewId, source: 'adapter' });
      continue;
    }
    const file = thumbnails?.items[row.id]?.file;
    if (typeof file === 'string' && CULT_PREVIEW_FILE_PATTERN.test(file)) index.set(row.id, { dir: 'thumbnails', file, source: 'source-render' });
  }
  return index;
}

/**
 * One display row. `slugs` maps a row id to its public slug (`generated/slugs.json`); the item's
 * id is `cult:<slug>`, so the internal name never reaches the DTO. A row without a slug falls back
 * to its internal name (test inventories only; the shipped file covers every row).
 */
export function projectCultItem(
  row: CultInventoryRow,
  previews: ReadonlyMap<string, CultPreviewFile> = new Map(),
  slugs: ReadonlyMap<string, string> = new Map(),
): CultCatalogItem {
  const reason = row.conversion.reason ? cultDisplayText(row.conversion.reason) : '';
  const portQueue = portQueueOf(row);
  const slug = slugs.get(row.id) ?? row.name;
  return {
    id: `cult:${slug}`,
    slug,
    displayTitle: cultDisplayTitle(row.title),
    summary: cultDisplayText(row.description),
    assetKind: row.assetKind,
    sourceCategory: cultDisplayCategory(row.original.category),
    tags: cultDisplayTags(row.original.tags),
    sectionKind: sectionKindOf(row),
    spineAffinities: [...row.spineAffinities],
    state: cultState(row.conversion.status),
    ...(reason ? { stateReason: reason } : {}),
    ...(portQueue ? { portQueue } : {}),
    dependencies: cultDependencySummary(row),
    bytes: totalBytes(row.source.files),
    preview: previewOf(previews.get(row.id)),
    provenance: { snapshotId: row.source.snapshotId },
  };
}

function previewOf(file: CultPreviewFile | undefined): CultCatalogPreview {
  return file ? { kind: 'image', source: file.source } : { kind: 'none' };
}

export function projectCultCatalog(
  inventory: CultInventory,
  previews: ReadonlyMap<string, CultPreviewFile> = new Map(),
  slugs: ReadonlyMap<string, string> = new Map(),
): CultCatalogListResponse['catalog'] {
  if (inventory.schema !== 'cult-ui-catalog/1') {
    throw new Error(`cult inventory: unexpected schema "${inventory.schema}"`);
  }
  const { id, expectedItems, fetchedItems, pendingItems } = inventory.snapshot;
  return {
    schema: 'cult-catalog/1',
    snapshot: { id, expectedItems, fetchedItems, pendingItems },
    items: inventory.rows.map((row) => projectCultItem(row, previews, slugs)),
  };
}

/** Explicit, reviewed relations; never inferred from names, titles or shared thumbnails. */
export interface CultCatalogCuration {
  schema: 'cult-catalog-curation/1';
  relations: Array<{ parentId: string; childId: string; relationship: CultCatalogRelatedItem['relationship'] }>;
}

/**
 * Curate the browse list while retaining the full projection for individual item APIs. Only an
 * explicit relation whose parent and child both exist can hide a row. Unknown and new rows stay
 * visible. Page-section relations must agree with the inventory's derivation evidence.
 */
export function curateCultCatalogItems(
  items: readonly CultCatalogItem[],
  inventory: Pick<CultInventory, 'rows'>,
  curation: CultCatalogCuration,
): { items: CultCatalogItem[]; allItems: CultCatalogItem[] } {
  if (curation.schema !== 'cult-catalog-curation/1' || !Array.isArray(curation.relations)) {
    throw new Error('cult curation: unexpected schema or relations');
  }
  if (items.length !== inventory.rows.length) throw new Error('cult curation: projection and inventory must align');
  const byId = new Map(items.map((item, index) => [item.id, { item, row: inventory.rows[index]! }]));
  const children = new Set<string>();
  const related = new Map<string, CultCatalogRelatedItem[]>();
  for (const relation of curation.relations) {
    if (!relation || typeof relation.parentId !== 'string' || typeof relation.childId !== 'string'
      || relation.parentId === relation.childId || !['example', 'section'].includes(relation.relationship)) {
      throw new Error('cult curation: invalid relation');
    }
    if (children.has(relation.childId)) throw new Error(`cult curation: repeated child ${relation.childId}`);
    const parent = byId.get(relation.parentId);
    const child = byId.get(relation.childId);
    if (!parent || !child) continue;
    if (relation.relationship === 'section'
      && (parent.row.assetKind !== 'page' || child.row.assetKind !== 'section' || child.row.derivedFrom !== parent.row.id)) {
      throw new Error(`cult curation: section ${relation.childId} has no matching parent evidence`);
    }
    if (relation.relationship === 'example' && child.row.demoOf !== parent.row.id) {
      throw new Error(`cult curation: example ${relation.childId} has no matching parent evidence`);
    }
    children.add(child.item.id);
    related.set(parent.item.id, [...(related.get(parent.item.id) ?? []), {
      id: child.item.id, title: child.item.displayTitle, relationship: relation.relationship,
    }]);
  }
  // Nested parents would make related content unreachable from the browse list.
  for (const parentId of related.keys()) {
    if (children.has(parentId)) throw new Error(`cult curation: nested parent ${parentId}`);
  }
  const allItems = items.map((item) => related.has(item.id) ? { ...item, relatedItems: related.get(item.id)! } : item);
  return { items: allItems.filter((item) => !children.has(item.id)), allItems };
}
