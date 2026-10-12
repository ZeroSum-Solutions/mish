/** Types of catalog.json. schema/catalog.schema.json is the authority; these mirror it. */

export const CATALOG_SCHEMA = 'genui-catalog/1';

export type GenuiCategory =
  | 'surface' | 'hover' | 'text' | 'scroll' | 'gallery' | 'hero' | 'background' | 'navigation' | 'input';
export type GenuiKind = 'css-only' | 'js';
export type GenuiStatus = 'planned' | 'ported';
export type LicenceDecision = 'port-with-attribution' | 'clean-room' | 'licensed' | 'cut';
export type Verdict = 'keep' | 'maybe' | 'cut';
export type PortDifficulty = 'Easy' | 'Medium' | 'Hard';
export type ReducedMotion = 'static' | 'reduced' | 'none-needed';
export type SourceName = 'react-bits' | '21st.dev' | 'kokonut-ui' | 'cult-ui-pro' | 'original';

/** JSON Schema of a component's mount() options. */
export interface PropsSchema {
  type: 'object';
  properties: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CatalogSource {
  name: SourceName;
  component: string;
  /** Licence evidence: the master CSV's License column, verbatim. */
  license: string;
  category: string;
  description: string;
  dependencies: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: GenuiCategory;
  kind?: GenuiKind;
  source: CatalogSource;
  sourceUrl: string;
  licenceDecision: LicenceDecision;
  verdict: Verdict;
  rationale: string;
  tier: 1 | 2 | 3 | null;
  tierNote: string;
  portDifficulty: PortDifficulty;
  status: GenuiStatus;
  entry?: string;
  css?: string;
  demo?: string;
  bytes?: { js: number; css: number };
  props?: PropsSchema;
  a11y?: string[];
  reducedMotion?: ReducedMotion;
  /** Verified from source: the default render runs a continuous animation loop. */
  motion?: 'continuous';
  /** The entry's own visual style is retro/skeuomorphic. */
  styleClass?: 'retro';
}

export interface Catalog {
  schema: typeof CATALOG_SCHEMA;
  components: CatalogEntry[];
}

/** components/<id>/meta.json: the source of truth for a component the package carries. */
export interface ComponentMeta {
  id: string;
  status: GenuiStatus;
  name?: string;
  category?: GenuiCategory;
  kind?: GenuiKind;
  licenceDecision?: LicenceDecision;
  verdict?: Verdict;
  rationale?: string;
  entry?: string;
  css?: string;
  demo?: string;
  props?: PropsSchema;
  a11y?: string[];
  reducedMotion?: ReducedMotion;
  /** Verified from source: the default render runs a continuous animation loop. */
  motion?: 'continuous';
  /** The entry's own visual style is retro/skeuomorphic. */
  styleClass?: 'retro';
}

/** Budgets a ported component must stay within, minified (catalog-design.md §B). */
export const BUDGET = { js: 8 * 1024, css: 6 * 1024 } as const;
