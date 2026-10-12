// GET /api/genui/catalog — the owned GenUI component catalog (packages/genui-catalog).
//
// The daemon serves the catalog manifest exactly as `@mish/genui-catalog/data` exports it.
// These types mirror that package's `Catalog` shape structurally, so contracts stays free of a
// workspace dependency; the daemon route (`apps/daemon/src/routes/genui-catalog.ts`) checks the
// two agree with a typed assignment (`const catalog: GenuiCatalogManifest = genuiCatalog.manifest`),
// which fails to compile if the package's literal drifts from this file's shape.
//
// `parseGenuiCatalogResponse` below is the runtime counterpart: it validates an untrusted
// `unknown` (e.g. a `fetch().json()` result) against this same shape at the web/CLI boundary,
// where the daemon's compile-time check does not reach.

export type GenuiCatalogCategory =
  | 'surface' | 'hover' | 'text' | 'scroll' | 'gallery' | 'hero' | 'background' | 'navigation' | 'input';
export type GenuiCatalogStatus = 'planned' | 'ported';
export type GenuiCatalogLicenceDecision = 'port-with-attribution' | 'clean-room' | 'licensed' | 'cut';
export type GenuiCatalogVerdict = 'keep' | 'maybe' | 'cut';

export interface GenuiCatalogEntry {
  id: string;
  name: string;
  category: GenuiCatalogCategory;
  kind?: 'css-only' | 'js';
  source: {
    name: 'react-bits' | '21st.dev' | 'kokonut-ui' | 'cult-ui-pro' | 'original';
    component: string;
    /** Licence evidence, verbatim from the master CSV. */
    license: string;
    category: string;
    description: string;
    dependencies: string;
  };
  sourceUrl: string;
  licenceDecision: GenuiCatalogLicenceDecision;
  verdict: GenuiCatalogVerdict;
  rationale: string;
  tier: 1 | 2 | 3 | null;
  tierNote: string;
  portDifficulty: 'Easy' | 'Medium' | 'Hard';
  status: GenuiCatalogStatus;
  entry?: string;
  css?: string;
  demo?: string;
  bytes?: { js: number; css: number };
  props?: { type: 'object'; properties: Record<string, unknown>; [key: string]: unknown };
  a11y?: string[];
  reducedMotion?: 'static' | 'reduced' | 'none-needed';
}

export interface GenuiCatalogManifest {
  schema: 'genui-catalog/1';
  components: GenuiCatalogEntry[];
}

export interface GenuiCatalogResponse {
  catalog: GenuiCatalogManifest;
}

/** Read-only, embeddable demo. Component source/export rights remain unchanged. */
export interface GenuiCatalogPreviewResponse {
  preview: { id: string; url: string; reducedMotion: boolean };
}

export function genuiCatalogPreviewUrl(id: string, reducedMotion = false): string {
  return `/api/genui/catalog/${encodeURIComponent(id)}/preview?reducedMotion=${reducedMotion}`;
}

const GENUI_CATALOG_CATEGORIES: ReadonlySet<string> = new Set<GenuiCatalogCategory>([
  'surface', 'hover', 'text', 'scroll', 'gallery', 'hero', 'background', 'navigation', 'input',
]);
const GENUI_CATALOG_STATUSES: ReadonlySet<string> = new Set<GenuiCatalogStatus>(['planned', 'ported']);
const GENUI_CATALOG_LICENCE_DECISIONS: ReadonlySet<string> = new Set<GenuiCatalogLicenceDecision>([
  'port-with-attribution', 'clean-room', 'licensed', 'cut',
]);
const GENUI_CATALOG_VERDICTS: ReadonlySet<string> = new Set<GenuiCatalogVerdict>(['keep', 'maybe', 'cut']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an `unknown` value (typically a `fetch().json()` result) as a `GenuiCatalogResponse`.
 *
 * Throws an `Error` whose message names the first failing path (e.g.
 * `catalog.components[3].status`) rather than returning `null`/`undefined`, so a caller cannot
 * accidentally treat a malformed 200 as an empty catalog — see `CatalogView.tsx` and the daemon
 * `od catalog` CLI, both of which call this at the boundary where the route's compile-time
 * agreement (see the header comment above) does not reach.
 */
export function parseGenuiCatalogResponse(value: unknown): GenuiCatalogResponse {
  if (!isPlainObject(value)) throw new Error('catalog response must be an object');
  const catalog = value.catalog;
  if (!isPlainObject(catalog)) throw new Error('catalog.catalog must be an object');
  if (catalog.schema !== 'genui-catalog/1') {
    throw new Error(`catalog.schema must be "genui-catalog/1"`);
  }
  if (!Array.isArray(catalog.components)) throw new Error('catalog.components must be an array');

  catalog.components.forEach((rawEntry: unknown, index: number) => {
    const path = `catalog.components[${index}]`;
    if (!isPlainObject(rawEntry)) throw new Error(`${path} must be an object`);

    for (const field of ['id', 'name', 'sourceUrl', 'rationale'] as const) {
      if (typeof rawEntry[field] !== 'string') throw new Error(`${path}.${field} must be a string`);
    }
    if (!GENUI_CATALOG_CATEGORIES.has(rawEntry.category as string)) {
      throw new Error(`${path}.category is invalid`);
    }
    if (!GENUI_CATALOG_STATUSES.has(rawEntry.status as string)) {
      throw new Error(`${path}.status is invalid`);
    }
    if (!GENUI_CATALOG_LICENCE_DECISIONS.has(rawEntry.licenceDecision as string)) {
      throw new Error(`${path}.licenceDecision is invalid`);
    }
    if (!GENUI_CATALOG_VERDICTS.has(rawEntry.verdict as string)) {
      throw new Error(`${path}.verdict is invalid`);
    }
    const tier = rawEntry.tier;
    if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== null) {
      throw new Error(`${path}.tier must be 1, 2, 3, or null`);
    }

    const source = rawEntry.source;
    if (!isPlainObject(source)) throw new Error(`${path}.source must be an object`);
    for (const field of ['name', 'component', 'license'] as const) {
      if (typeof source[field] !== 'string') throw new Error(`${path}.source.${field} must be a string`);
    }
  });

  return value as unknown as GenuiCatalogResponse;
}
