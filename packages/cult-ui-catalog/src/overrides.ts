/**
 * reviewed-overrides.json: human-reviewed corrections applied last, by row id. Every entry needs a
 * `note` saying why. An override may change classification fields and the conversion status, but
 * it cannot mark a row `insertable` (only a checked adapter does that) or `pending-fetch` (only
 * the snapshot does that). An override for an id the catalog does not have is an error, so the file
 * cannot go stale silently. Closed-list values (asset kind, section kind, conversion status, port
 * queue) are checked here, when the file is parsed; the catalog validator checks the rest after
 * application.
 */

import { SECTION_KINDS, type SectionKind } from './taxonomy.ts';
import { ASSET_KINDS, CONVERSION_STATUSES, PORT_QUEUES, type AssetKind, type CultCatalogRow, type PortQueue } from './types.ts';

export const OVERRIDE_FIELDS = ['assetKind', 'sectionKind', 'components', 'spineAffinities', 'conversion', 'portQueue'] as const;
type OverrideField = (typeof OVERRIDE_FIELDS)[number];

export interface RowOverride {
  note: string;
  assetKind?: AssetKind;
  sectionKind?: SectionKind;
  components?: string[];
  spineAffinities?: string[];
  conversion?: { status: string; reason?: string };
  portQueue?: PortQueue;
}

export type Overrides = Record<string, RowOverride>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkClosed(id: string, field: string, value: unknown, allowed: readonly string[]): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
    throw new Error(`override ${id}: ${field} ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`);
  }
}

export function parseOverrides(value: unknown): Overrides {
  if (!isObject(value) || !isObject(value.overrides)) throw new Error('reviewed-overrides.json: expected { overrides: {} }');
  const out: Overrides = {};
  for (const [id, entry] of Object.entries(value.overrides)) {
    if (!isObject(entry)) throw new Error(`override ${id}: expected an object`);
    for (const key of Object.keys(entry)) {
      if (key !== 'note' && !(OVERRIDE_FIELDS as readonly string[]).includes(key)) {
        throw new Error(`override ${id}: unknown field ${key}`);
      }
    }
    if (typeof entry.note !== 'string' || entry.note.trim() === '') throw new Error(`override ${id}: a review note is required`);
    const status = isObject(entry.conversion) ? entry.conversion.status : undefined;
    if (entry.conversion !== undefined && typeof status !== 'string') throw new Error(`override ${id}: conversion.status is required`);
    checkClosed(id, 'conversion.status', status, CONVERSION_STATUSES);
    if (status === 'insertable' || status === 'pending-fetch') {
      throw new Error(`override ${id}: conversion.status ${status} cannot be set by review`);
    }
    const reason = isObject(entry.conversion) ? entry.conversion.reason : undefined;
    if ((status === 'adapter-needed' || status === 'app-only') && (typeof reason !== 'string' || reason.trim() === '')) {
      throw new Error(`override ${id}: conversion.status ${status} needs a reason`);
    }
    checkClosed(id, 'assetKind', entry.assetKind, ASSET_KINDS);
    checkClosed(id, 'sectionKind', entry.sectionKind, SECTION_KINDS);
    checkClosed(id, 'portQueue', entry.portQueue, PORT_QUEUES);
    out[id] = entry as unknown as RowOverride;
  }
  return out;
}

export function applyOverrides(rows: CultCatalogRow[], overrides: Overrides): CultCatalogRow[] {
  const byId = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(overrides)) {
    if (!byId.has(id)) throw new Error(`reviewed-overrides.json: no catalog row ${id}`);
  }
  return rows.map((row) => {
    const override = overrides[row.id];
    if (!override) return row;
    const fields = OVERRIDE_FIELDS.filter((f) => override[f] !== undefined);
    return { ...applyFields(row, override, fields), review: { fields: [...fields].sort(), note: override.note } };
  });
}

function applyFields(row: CultCatalogRow, o: RowOverride, fields: readonly OverrideField[]): CultCatalogRow {
  // Closed-list values were checked by parseOverrides; the rest is validated by src/validate.ts afterwards.
  const next = { ...row, taxonomy: { ...row.taxonomy } } as CultCatalogRow;
  for (const field of fields) {
    if (field === 'assetKind' && o.assetKind !== undefined) next.assetKind = o.assetKind;
    if (field === 'sectionKind' && o.sectionKind !== undefined) next.taxonomy.sectionKind = o.sectionKind;
    if (field === 'components') next.taxonomy.components = [...(o.components ?? [])].sort() as CultCatalogRow['taxonomy']['components'];
    if (field === 'spineAffinities') next.spineAffinities = [...(o.spineAffinities ?? [])].sort() as CultCatalogRow['spineAffinities'];
    // A review can demote a row the deterministic build already gave an adapter (an insertable row whose
    // mobile behavior review caught after the fact, say) — conversion.status and the adapter reference
    // must keep matching (src/validate.ts), so demoting away from 'insertable' drops the adapter with it.
    // previewId names a generated/previews/<name>.webp file that the same demotion deletes (adapters.ts
    // only writes/keeps a preview for an insertable row) — leaving it set makes a demoted row's catalog
    // entry name a preview file that no longer exists on disk.
    if (field === 'conversion') { next.conversion = { ...(o.conversion as CultCatalogRow['conversion']) }; if (next.conversion.status !== 'insertable') { next.adapter = null; next.previewId = null; } }
    if (field === 'portQueue' && o.portQueue !== undefined) next.portQueue = o.portQueue;
  }
  return next;
}
