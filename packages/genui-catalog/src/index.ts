/**
 * @open-design/genui-catalog: the owned GenUI component catalog.
 *
 * `loadCatalog()` returns catalog.json, validated against schema/catalog.schema.json. The JSON is
 * imported, so a bundler inlines it and the call needs no filesystem. The component sources and
 * their built JS/CSS travel through `@open-design/genui-catalog/data` (generated literals) and
 * `@open-design/genui-catalog/components/<id>`.
 */

import catalogJson from '../catalog.json' with { type: 'json' };
import { validateCatalog } from './validate.ts';
import type { Catalog, CatalogEntry } from './types.ts';

export * from './types.ts';
export {
  catalogIssues, catalogPolicyIssues, catalogSchema, validateAgainstSchema, validateCatalog, validateComponentMeta,
  type JsonSchema, type SchemaIssue,
} from './validate.ts';

let cached: Catalog | undefined;

/** The validated catalog. Throws if catalog.json does not conform (a build-time bug). */
export function loadCatalog(): Catalog {
  cached ??= validateCatalog(catalogJson);
  return cached;
}

/** Entries the catalog wants ported: verdict keep and a licence decision other than cut. */
export function eligibleEntries(catalog: Catalog = loadCatalog()): CatalogEntry[] {
  return catalog.components.filter((entry) => entry.verdict === 'keep' && entry.licenceDecision !== 'cut');
}
