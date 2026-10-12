/**
 * Shape of catalog.json. schema/cult-ui-catalog.schema.json is the authority; these types mirror
 * it, and src/validate.ts checks both the schema and the policy rules a schema cannot express.
 *
 * The catalog holds metadata and hashes only. The faithful Cult UI Pro source stays in the private
 * source kit (see docs/legal/cult-ui-pro-rights.md); nothing in this package carries source text.
 */

import type { ComponentId, SectionKind, SpineCode, StyleDensity } from './taxonomy.ts';

export const CULT_CATALOG_SCHEMA = 'cult-ui-catalog/1';
export const RIGHTS_EVIDENCE = 'docs/legal/cult-ui-pro-rights.md';
export const REGISTRY_URL_PATTERN = 'https://pro.cult-ui.com/api/registry/<name>';

export const ASSET_KINDS = ['section', 'page', 'primitive', 'app'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const CONVERSION_STATUSES = [
  'pending-fetch',
  'unconverted',
  'insertable',
  'adapter-needed',
  'app-only',
] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/**
 * Reviewed conversion queue for primitive and app rows (reviewed-overrides.json only): a vanilla
 * GenUI `mount(el, opts)` port, a pure-CSS GenUI surface, or app-only behavior a static site
 * build cannot promise. Independent of `conversion`, so a pending-fetch row keeps that status.
 */
export const PORT_QUEUES = ['genui-port', 'css-surface', 'app-only'] as const;
export type PortQueue = (typeof PORT_QUEUES)[number];

/** Runtime capabilities an item needs, detected from its dependencies and source text. */
export const RUNTIME_FEATURES = [
  'ai-sdk',
  'api-routes',
  'browser-apis',
  'canvas',
  'env-secrets',
  'external-services',
  'motion',
  'redis',
  'server-actions',
  'shaders',
  'syntax-highlighting',
  'webgl',
] as const;
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number];

export const INTERACTIONS = ['click', 'drag', 'hover', 'input', 'keyboard', 'scroll', 'state'] as const;
export type Interaction = (typeof INTERACTIONS)[number];

export interface CultRights {
  license: 'licensed';
  decision: 'bundle';
  evidence: typeof RIGHTS_EVIDENCE;
}

export interface SourceFile {
  path: string;
  target: string;
  type: string;
  /** SHA-256 of the file's UTF-8 content in the registry item; null while the item is pending fetch. */
  sha256: string | null;
  bytes: number | null;
}

export interface RowSource {
  snapshotId: string;
  /** SHA-256 of `registry/<name>.json`; null while pending fetch. */
  registrySha256: string | null;
  files: SourceFile[];
}

/** The provider's own labels, kept for audit. Routing reads `taxonomy`, never these. */
export interface OriginalLabels {
  type: string;
  category: string;
  tags: string[];
  useCases: string[];
  style: Record<string, unknown> | null;
  features: string[];
  registryDependencies: string[];
}

export interface RowTaxonomy {
  sectionKind: SectionKind;
  components: ComponentId[];
  style: { density?: StyleDensity };
}

export interface Requirements {
  /** Hostnames the source references over http(s); each needs an approved-asset replacement. */
  assetHosts: string[];
  images: boolean;
  interactions: Interaction[];
}

export interface Conversion {
  status: ConversionStatus;
  reason?: string;
}

export interface AdapterRef {
  /** Always the row id, `cult:<name>`. */
  id: string;
  version: string;
  /** The converter's source hash (src/converted.ts `converterSourceSha`), also in the adapter. */
  sourceSha256: string;
}

export interface MeasuredBytes {
  html: number | null;
  css: number | null;
  js: number | null;
}

export interface Review {
  fields: string[];
  note: string;
}

export interface CultCatalogRow {
  id: string;
  name: string;
  title: string;
  description: string;
  original: OriginalLabels;
  source: RowSource;
  rights: CultRights;
  assetKind: AssetKind;
  taxonomy: RowTaxonomy;
  spineAffinities: SpineCode[];
  dependencies: string[];
  runtimeFeatures: RuntimeFeature[];
  /** Null while pending fetch: these are read from source text. */
  requirements: Requirements | null;
  conversion: Conversion;
  adapter: AdapterRef | null;
  previewId: string | null;
  measuredBytes: MeasuredBytes;
  /** Set on `*-demo` items whose base item is in the index. */
  demoOf?: string;
  /**
   * Set on a section the converter cut out of a whole-page row (src/derived.ts): that page's id.
   * The row is not a registry item; its snapshot, source hashes and rights are the page's.
   */
  derivedFrom?: string;
  /** Reviewed conversion queue; primitive and app rows only. */
  portQueue?: PortQueue;
  /** Set when reviewed-overrides.json changed this row. */
  review?: Review;
}

export interface SnapshotInfo {
  id: string;
  /** sha256 over the sorted `<name> <sha256 of registry/<name>.json>` lines of every fetched item. */
  digest: string;
  indexSha256: string;
  registryUrlPattern: typeof REGISTRY_URL_PATTERN;
  /** Registry items in the index (source rows); derived rows are counted in `derivedRows`. */
  expectedItems: number;
  fetchedItems: number;
  pendingItems: number;
  /** Rows cut from a fetched page item (`derivedFrom`), not registry items. */
  derivedRows: number;
}

export interface CultCatalog {
  schema: typeof CULT_CATALOG_SCHEMA;
  snapshot: SnapshotInfo;
  rows: CultCatalogRow[];
}
