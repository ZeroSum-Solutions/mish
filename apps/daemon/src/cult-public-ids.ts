/**
 * Public ids for Cult UI Pro rows: `cult:<slug>`, from the catalog package's
 * `generated/slugs.json`. The internal inventory id (`cult:<name>`) can name the provider a style
 * came from (`cult:marketing-pricing-vercel`), so a person only ever sees and types the public one
 * (`cult:pricing-series-v`); the internal id stays the key the section catalog, the adapter
 * registry and a build use. Used where section-catalog entries meet a person: `GET /api/sections`
 * (and so `od sections` and the web picker) serves the public id, and a build's
 * `sectionSelection.entryId` maps it back.
 */

import { cultSlugData } from './cult-data.js';
import { mishPackGeneration } from './mish-packs/overlay.js';

interface IdMaps {
  generation: number;
  publicByInternal: Map<string, string>;
  internalByPublic: Map<string, string>;
}
let maps: IdMaps | null = null;

/** Built from the bundled slugs or an installed pack's; rebuilt when the set of packs changes. */
function idMaps(): IdMaps {
  const generation = mishPackGeneration();
  if (maps?.generation === generation) return maps;
  const slugs = (cultSlugData() as unknown as { items: Record<string, string> }).items;
  const publicByInternal = new Map(Object.entries(slugs).map(([id, slug]) => [id, `cult:${slug}`]));
  const internalByPublic = new Map([...publicByInternal].map(([id, publicId]) => [publicId, id]));
  maps = { generation, publicByInternal, internalByPublic };
  return maps;
}

/** The public id (`cult:<slug>`) of an internal Cult row id, or undefined for any other id. */
export function cultPublicId(internalId: string): string | undefined {
  return idMaps().publicByInternal.get(internalId);
}

/**
 * The internal id for a public Cult id (`cult:<slug>`, or a bare slug); any other key, including
 * an internal id, is returned unchanged.
 */
export function cultInternalId(key: string): string {
  const { internalByPublic } = idMaps();
  return internalByPublic.get(key) ?? internalByPublic.get(`cult:${key}`) ?? key;
}
