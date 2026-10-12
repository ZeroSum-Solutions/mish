/**
 * The section-catalogue half of Build on brand: which entries can be inserted, and how one is
 * rendered into a staged insert with visible `{{slot}}` placeholders.
 *
 * Only `insertable` entries of the static catalogue are offered (HyperUI and Cult adapters
 * with a reviewed `render(fill)`); MotionSites prompts, family sections and `reference-only`
 * rows never are. Rendering uses the committed generated adapters through the fast lane's
 * `resolveSectionAdapter`, so it needs no kit directory, no network and no executor.
 */
import type { SectionCatalogEntry } from '@open-design/contracts/api/section-catalog';
import sectionCatalogJson from '@open-design/section-catalog/catalog.json' with { type: 'json' };
import { resolveSectionAdapter } from '@open-design/agency-fast-lane/section-overlay';
import { publicAdapterText } from '@open-design/agency-fast-lane/cult-public-ids';
import { publicCultEntry } from '../routes/sections.js';
import { insertFileStem, type StagedInsert } from './stage.js';

let insertable: readonly SectionCatalogEntry[] | null = null;

/** Insertable entries as `GET /api/sections` serves them (public Cult ids). */
export function insertableCatalogEntries(): readonly SectionCatalogEntry[] {
  if (insertable) return insertable;
  insertable = (sectionCatalogJson as { entries: SectionCatalogEntry[] }).entries
    .filter((entry) => entry.availability === 'insertable' && entry.rights.decision === 'bundle')
    .flatMap((entry) => {
      const served = publicCultEntry(entry);
      return served ? [served] : [];
    });
  return insertable;
}

/** Render one catalogue entry with `{{slot}}` placeholders, or null when it has no adapter. */
export async function renderCatalogInsert(ref: string): Promise<StagedInsert | null> {
  if (!insertableCatalogEntries().some((entry) => entry.id === ref)) return null;
  const adapter = await resolveSectionAdapter(ref);
  const text = Object.fromEntries(adapter.text.map((slot) => [slot.name, `{{${slot.name}}}`]));
  const items = adapter.items
    ? {
        [adapter.items.name]: Array.from({ length: adapter.items.count }, (_unused, index) =>
          Object.fromEntries(adapter.items!.fields.map((field) => [field.name, `{{${adapter.items!.name}.${index + 1}.${field.name}}}`])),
        ),
      }
    : undefined;
  const links = Object.fromEntries((adapter.links ?? []).map((link) => [link.name, '#']));
  const assets = Object.fromEntries((adapter.assets ?? []).map((asset) => [asset.name, { src: '', alt: 'Stand-in image' }]));
  const html = adapter.render({ text, ...(items ? { items } : {}), links, assets });
  const slots = [
    ...adapter.text.map((slot) => ({ name: slot.name, max: slot.max })),
    ...(adapter.items
      ? adapter.items.fields.map((field) => ({ name: `${adapter.items!.name}.N.${field.name}`, max: field.max }))
      : []),
  ];
  return {
    ref,
    file: insertFileStem(ref),
    html: publicAdapterText(adapter.id, html),
    css: publicAdapterText(adapter.id, adapter.css, 'css'),
    slots,
  };
}
