/** Row counts by asset kind, conversion status and section kind, for the importer's report. */

import type { CultCatalog } from './types.ts';

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort()) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function catalogSummary(catalog: CultCatalog): Record<string, Record<string, number>> {
  return {
    assetKind: countBy(catalog.rows.map((r) => r.assetKind)),
    conversion: countBy(catalog.rows.map((r) => r.conversion.status)),
    sectionKind: countBy(catalog.rows.map((r) => r.taxonomy.sectionKind)),
  };
}
