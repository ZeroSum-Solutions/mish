/**
 * Public ids for Cult UI Pro rows: `cult:<slug>`, from the catalog package's
 * `generated/slugs.json`. The internal inventory id (`cult:<name>`) can name the provider a style
 * came from (`cult:marketing-pricing-vercel`), so a person only ever sees and types the public one
 * (`cult:pricing-series-v`); the internal id stays the key the section catalog, the adapter
 * registry and a build use. Used where section-catalog entries meet a person: `GET /api/sections`
 * (and so `od sections` and the web picker) serves the public id, and a build's
 * `sectionSelection.entryId` maps it back.
 */

import cultSlugsJson from '@mish/cult-ui-catalog/generated/slugs.json' with { type: 'json' };

const SLUGS = (cultSlugsJson as unknown as { items: Record<string, string> }).items;
const PUBLIC_BY_INTERNAL = new Map(Object.entries(SLUGS).map(([id, slug]) => [id, `cult:${slug}`]));
const INTERNAL_BY_PUBLIC = new Map([...PUBLIC_BY_INTERNAL].map(([id, publicId]) => [publicId, id]));

/** The public id (`cult:<slug>`) of an internal Cult row id, or undefined for any other id. */
export function cultPublicId(internalId: string): string | undefined {
  return PUBLIC_BY_INTERNAL.get(internalId);
}

/**
 * The internal id for a public Cult id (`cult:<slug>`, or a bare slug); any other key, including
 * an internal id, is returned unchanged.
 */
export function cultInternalId(key: string): string {
  return INTERNAL_BY_PUBLIC.get(key) ?? INTERNAL_BY_PUBLIC.get(`cult:${key}`) ?? key;
}
