/**
 * The section catalogue: the bundled `@mish/section-catalog/catalog.json` plus the entries any
 * installed Mish pack provides. A pack can add entries; it cannot replace a bundled one (the
 * bundled entry wins on an id clash). Cached per pack generation.
 */

import sectionCatalogJson from '@mish/section-catalog/catalog.json' with { type: 'json' };

import { mishPackGeneration, packSectionEntries } from './mish-packs/overlay.js';

type CatalogFile = { entries: Array<{ id: string }> } & Record<string, unknown>;

let cached: { generation: number; value: CatalogFile } | null = null;

/** The merged catalogue file (every key of the bundled one, `entries` extended by packs). */
export function sectionCatalogData(): CatalogFile {
  const generation = mishPackGeneration();
  if (cached?.generation === generation) return cached.value;
  const bundled = sectionCatalogJson as unknown as CatalogFile;
  const extra = packSectionEntries() as Array<{ id?: unknown }>;
  let value = bundled;
  if (extra.length > 0) {
    const ids = new Set(bundled.entries.map((entry) => entry.id));
    const added: Array<{ id: string }> = [];
    for (const entry of extra) {
      if (typeof entry.id !== 'string' || ids.has(entry.id)) continue;
      ids.add(entry.id);
      added.push(entry as { id: string });
    }
    value = { ...bundled, entries: [...bundled.entries, ...added] };
  }
  cached = { generation, value };
  return value;
}
