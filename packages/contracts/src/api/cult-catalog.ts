// GET /api/cult/catalog and GET /api/cult/catalog/:id — the Cult UI Pro inventory as the web
// Catalog tab's Blocks and Components views and `od cult list|get` read it.
//
// The daemon projects `packages/cult-ui-catalog/catalog.json` (metadata and hashes only; the
// licensed source never leaves the private source kit) into these rows
// (`apps/daemon/src/routes/cult-catalog.ts`). The projection is the display boundary: titles,
// summaries, tags and reasons carry no other company's name (a neutral "series" letter instead),
// and the raw provider text stays server-side. The types are structural, so contracts keeps no
// workspace dependency on the inventory package — the same pattern `genui-catalog.ts` uses.
//
// `parseCultCatalogListResponse` / `parseCultCatalogItemResponse` validate an untrusted
// `unknown` (a `fetch().json()` result) at the web and CLI boundary.

export const CULT_CATALOG_ASSET_KINDS = ['section', 'page', 'primitive', 'app'] as const;
export type CultCatalogAssetKind = (typeof CULT_CATALOG_ASSET_KINDS)[number];

/**
 * The honest conversion state shown to a person. Each inventory `conversion.status`
 * (`packages/cult-ui-catalog/src/types.ts` `CONVERSION_STATUSES`) maps to exactly one state and no
 * two statuses share one, so nothing the inventory distinguishes is collapsed:
 * - `insertable` (status `insertable`): a reviewed adapter exists; a build can place it.
 * - `needs-adaptation` (status `adapter-needed`): fetched, but it needs a runtime a static page
 *   lacks or the converter refused it; `stateReason` says why.
 * - `not-converted` (status `unconverted`): fetched, nothing blocks it, and the converter has not
 *   produced a reviewed adapter yet.
 * - `app-only` (status `app-only`): application behavior a static site build cannot promise.
 * - `pending` (status `pending-fetch`): the registry item is not fetched yet, so nothing about its
 *   source is known.
 * The daemon projection rejects any other status instead of guessing a state for it.
 */
export const CULT_CATALOG_STATES = ['insertable', 'needs-adaptation', 'not-converted', 'app-only', 'pending'] as const;
export type CultCatalogState = (typeof CULT_CATALOG_STATES)[number];

/**
 * The closed section-kind taxonomy a row carries: the design taxonomy's section ids plus
 * `page-composition` (a whole page) and `unclassified` (no section role). Mirrors
 * `packages/cult-ui-catalog/src/taxonomy.ts` `SECTION_KINDS`; the daemon's route test fails on
 * drift. Every value has a `catalog.cult.kind.*` label in the web locales.
 */
export const CULT_CATALOG_SECTION_KINDS = [
  'navigation', 'hero', 'features', 'services', 'benefits', 'process-steps', 'proof-gallery',
  'product-grid', 'pricing', 'plan-comparison', 'testimonials', 'reviews-ratings',
  'stats-metrics', 'logo-wall', 'team', 'about-story', 'manifesto-statement', 'faq',
  'blog-articles', 'newsletter-waitlist', 'contact-form', 'booking-availability',
  'location-map-hours', 'cta-band', 'footer', 'timeline-roadmap', 'integrations',
  'specifications', 'page-composition', 'unclassified',
] as const;
export type CultCatalogSectionKind = (typeof CULT_CATALOG_SECTION_KINDS)[number];

/** `?kind=` values: one asset kind, or `blocks` (section + page) / `components` (primitive + app). */
export const CULT_CATALOG_KIND_FILTERS: Readonly<Record<string, readonly CultCatalogAssetKind[]>> = {
  section: ['section'],
  page: ['page'],
  primitive: ['primitive'],
  app: ['app'],
  blocks: ['section', 'page'],
  components: ['primitive', 'app'],
};

export const CULT_CATALOG_PORT_QUEUES = ['genui-port', 'css-surface', 'app-only'] as const;
export type CultCatalogPortQueue = (typeof CULT_CATALOG_PORT_QUEUES)[number];

/** Runtime needs, folded from the inventory's detected runtime features. */
export interface CultCatalogDependencySummary {
  motion: boolean;
  canvas: boolean;
  /** WebGL or shaders. */
  webgl: boolean;
  /** Server actions, API routes, secrets, Redis, an AI SDK or an external service. */
  server: boolean;
  /** Number of npm dependencies the item declares. */
  packages: number;
}

/**
 * A catalog card's thumbnail. `image` means the daemon serves a WebP for the row at
 * `cultCatalogPreviewUrl(id)` (`GET /api/cult/catalog/:id/preview`): the converter's preview of
 * an insertable row (`source: 'adapter'`), or a render of the item's own source
 * (`source: 'source-render'`). `none` means the row has no image; the card shows a neutral
 * placeholder. The DTO carries no URL; the client builds it from the public id.
 */
export type CultCatalogPreview =
  | { kind: 'none' }
  | { kind: 'image'; source: CultCatalogPreviewSource; revision?: string };

export const CULT_CATALOG_PREVIEW_SOURCES = ['adapter', 'source-render'] as const;
export type CultCatalogPreviewSource = (typeof CULT_CATALOG_PREVIEW_SOURCES)[number];

/** The same-origin preview route of one catalog row (`GET /api/cult/catalog/:id/preview`). */
export function cultCatalogPreviewUrl(id: string, revision?: string): string {
  return `/api/cult/catalog/${encodeURIComponent(id)}/preview${revision ? `?v=${encodeURIComponent(revision)}` : ""}`;
}

/** A reviewed example or page section kept inside its parent's expanded view. */
export interface CultCatalogRelatedItem {
  id: string;
  title: string;
  relationship: 'example' | 'section';
}

export interface CultCatalogItem {
  /**
   * `cult:<slug>`, the public id. The internal inventory name (`cult:<name>`, which can name the
   * provider a style came from) never leaves the daemon; the item routes still accept it as an
   * alias.
   */
  id: string;
  /**
   * The public slug (`packages/cult-ui-catalog/generated/slugs.json`): brand-free, unique and
   * stable, derived from the display title (`pricing-series-v`). What a person types and sees:
   * `od cult add <slug>`, the install URL `/api/cult/r/<slug>.json`, the `app/(cult)/<slug>/`
   * folder and route.
   */
  slug: string;
  /** Brand-free display title, e.g. "Pricing (series V)". */
  displayTitle: string;
  /** Brand-free one-line description. */
  summary: string;
  assetKind: CultCatalogAssetKind;
  /**
   * The provider's own category slug (e.g. `marketing-pricing`, `ui`), kept for browsing. Passes
   * the same brand scrub as the tags: a category that names another company arrives as `other`.
   */
  sourceCategory: string;
  /** Brand-free provider tags. */
  tags: string[];
  /** Closed taxonomy section kind; `unclassified` when the importer found none. */
  sectionKind: CultCatalogSectionKind;
  /** Spine codes; empty when the inventory found no discriminating use case. */
  spineAffinities: string[];
  state: CultCatalogState;
  /** Why the item is in that state, when the inventory states a reason (brand-scrubbed, one line). */
  stateReason?: string;
  /** Reviewed conversion queue for primitive and app rows. */
  portQueue?: CultCatalogPortQueue;
  dependencies: CultCatalogDependencySummary;
  /** Total source bytes; null while the item is pending fetch. */
  bytes: number | null;
  /** The card thumbnail: an image the daemon serves, or none (the card shows a placeholder). */
  preview: CultCatalogPreview;
  provenance: { snapshotId: string };
  /** Related source items stay addressable through the individual item APIs. */
  relatedItems?: CultCatalogRelatedItem[];
}

/** Original import snapshot counts; curation changes browse rows, not source acquisition totals. */
export interface CultCatalogSnapshot {
  id: string;
  expectedItems: number;
  fetchedItems: number;
  pendingItems: number;
}

export interface CultCatalogListResponse {
  catalog: {
    schema: 'cult-catalog/1';
    snapshot: CultCatalogSnapshot;
    items: CultCatalogItem[];
  };
}

export interface CultCatalogItemResponse {
  item: CultCatalogItem;
}

const ASSET_KINDS: ReadonlySet<string> = new Set(CULT_CATALOG_ASSET_KINDS);
const STATES: ReadonlySet<string> = new Set(CULT_CATALOG_STATES);
const PORT_QUEUES: ReadonlySet<string> = new Set(CULT_CATALOG_PORT_QUEUES);
const SECTION_KINDS: ReadonlySet<string> = new Set(CULT_CATALOG_SECTION_KINDS);

export function isCultCatalogAssetKind(value: unknown): value is CultCatalogAssetKind {
  return typeof value === 'string' && ASSET_KINDS.has(value);
}

export function isCultCatalogSectionKind(value: unknown): value is CultCatalogSectionKind {
  return typeof value === 'string' && SECTION_KINDS.has(value);
}

export function isCultCatalogState(value: unknown): value is CultCatalogState {
  return typeof value === 'string' && STATES.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const PREVIEW_SOURCES: ReadonlySet<string> = new Set(CULT_CATALOG_PREVIEW_SOURCES);

function assertPreview(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) throw new Error(`${path} must be an object`);
  if (raw.kind === 'none') return;
  if (raw.kind !== 'image') throw new Error(`${path}.kind must be "none" or "image"`);
  if (!PREVIEW_SOURCES.has(raw.source as string)) throw new Error(`${path}.source is invalid`);
  if (raw.revision !== undefined && (typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new Error(`${path}.revision must be a SHA-256 digest`);
}

function assertItem(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) throw new Error(`${path} must be an object`);
  for (const field of ['id', 'slug', 'displayTitle', 'summary', 'sourceCategory', 'sectionKind'] as const) {
    if (typeof raw[field] !== 'string') throw new Error(`${path}.${field} must be a string`);
  }
  if (!isCultCatalogAssetKind(raw.assetKind)) throw new Error(`${path}.assetKind is invalid`);
  if (!isCultCatalogState(raw.state)) throw new Error(`${path}.state is invalid`);
  if (!isCultCatalogSectionKind(raw.sectionKind)) throw new Error(`${path}.sectionKind is invalid`);
  if (raw.stateReason !== undefined && typeof raw.stateReason !== 'string') {
    throw new Error(`${path}.stateReason must be a string`);
  }
  if (raw.portQueue !== undefined && !PORT_QUEUES.has(raw.portQueue as string)) {
    throw new Error(`${path}.portQueue is invalid`);
  }
  if (!isStringArray(raw.tags)) throw new Error(`${path}.tags must be an array of strings`);
  if (!isStringArray(raw.spineAffinities)) throw new Error(`${path}.spineAffinities must be an array of strings`);
  if (raw.relatedItems !== undefined) {
    if (!Array.isArray(raw.relatedItems)) throw new Error(`${path}.relatedItems must be an array`);
    raw.relatedItems.forEach((related: unknown, index: number) => {
      const relatedPath = `${path}.relatedItems[${index}]`;
      if (!isPlainObject(related)) throw new Error(`${relatedPath} must be an object`);
      if (typeof related.id !== 'string' || !related.id.startsWith('cult:') || related.id.length <= 5) {
        throw new Error(`${relatedPath}.id must be a Cult item id`);
      }
      if (typeof related.title !== 'string') throw new Error(`${relatedPath}.title must be a string`);
      if (related.relationship !== 'example' && related.relationship !== 'section') {
        throw new Error(`${relatedPath}.relationship is invalid`);
      }
    });
  }
  const deps = raw.dependencies;
  if (!isPlainObject(deps)) throw new Error(`${path}.dependencies must be an object`);
  for (const flag of ['motion', 'canvas', 'webgl', 'server'] as const) {
    if (typeof deps[flag] !== 'boolean') throw new Error(`${path}.dependencies.${flag} must be a boolean`);
  }
  if (typeof deps.packages !== 'number') throw new Error(`${path}.dependencies.packages must be a number`);
  if (raw.bytes !== null && typeof raw.bytes !== 'number') throw new Error(`${path}.bytes must be a number or null`);
  assertPreview(raw.preview, `${path}.preview`);
  if (!isPlainObject(raw.provenance) || typeof raw.provenance.snapshotId !== 'string') {
    throw new Error(`${path}.provenance.snapshotId must be a string`);
  }
}

/**
 * Validate an `unknown` value as a `CultCatalogListResponse`. Throws an `Error` naming the first
 * failing path, so a malformed 200 is never read as an empty inventory.
 */
export function parseCultCatalogListResponse(value: unknown): CultCatalogListResponse {
  if (!isPlainObject(value)) throw new Error('cult catalog response must be an object');
  const catalog = value.catalog;
  if (!isPlainObject(catalog)) throw new Error('catalog must be an object');
  if (catalog.schema !== 'cult-catalog/1') throw new Error('catalog.schema must be "cult-catalog/1"');
  const snapshot = catalog.snapshot;
  if (!isPlainObject(snapshot) || typeof snapshot.id !== 'string') throw new Error('catalog.snapshot.id must be a string');
  for (const field of ['expectedItems', 'fetchedItems', 'pendingItems'] as const) {
    if (typeof snapshot[field] !== 'number') throw new Error(`catalog.snapshot.${field} must be a number`);
  }
  if (!Array.isArray(catalog.items)) throw new Error('catalog.items must be an array');
  catalog.items.forEach((item: unknown, index: number) => assertItem(item, `catalog.items[${index}]`));
  return value as unknown as CultCatalogListResponse;
}

/** Validate an `unknown` value as a `CultCatalogItemResponse`. */
export function parseCultCatalogItemResponse(value: unknown): CultCatalogItemResponse {
  if (!isPlainObject(value)) throw new Error('cult catalog item response must be an object');
  assertItem(value.item, 'item');
  return value as unknown as CultCatalogItemResponse;
}
