/**
 * Catalog validation: the JSON schema (closed classification ids, shapes) plus the policy rules a
 * schema cannot express — unique sorted ids, consistent snapshot counts, pending rows without
 * hashes, `insertable` only with an adapter, a stated reason for every `adapter-needed` or
 * `app-only` row, asset kind / section kind / status agreement, and derived rows that match the
 * page they were cut from.
 */

import schemaJson from '../schema/cult-ui-catalog.schema.json' with { type: 'json' };
import { canonicalJson } from './canonical.ts';
import { ADAPTER_BYTE_LIMIT } from './converted.ts';
import { validateAgainstSchema, type JsonSchema } from './schema-check.ts';
import type { CultCatalog, CultCatalogRow } from './types.ts';

export const cultCatalogSchema: JsonSchema = schemaJson as JsonSchema;

function derivedIssues(row: CultCatalogRow, byId: ReadonlyMap<string, CultCatalogRow>): string[] {
  const at = row.id;
  const page = row.derivedFrom === undefined ? undefined : byId.get(row.derivedFrom);
  if (!page) return [`${at}: derivedFrom ${row.derivedFrom} is not a catalog row`];
  const issues: string[] = [];
  if (page.assetKind !== 'page' || page.derivedFrom !== undefined) issues.push(`${at}: derivedFrom must name a page row`);
  if (!row.name.startsWith(`${page.name}--`)) issues.push(`${at}: a derived row is named <page>--<section>`);
  if (row.assetKind !== 'section') issues.push(`${at}: a derived row is a section`);
  if (page.conversion.status === 'pending-fetch' || row.conversion.status === 'pending-fetch') issues.push(`${at}: a derived row needs a fetched page`);
  if (canonicalJson(row.source) !== canonicalJson(page.source)) issues.push(`${at}: a derived row carries its page's source`);
  if (canonicalJson(row.rights) !== canonicalJson(page.rights)) issues.push(`${at}: a derived row carries its page's rights`);
  return issues;
}

function rowIssues(row: CultCatalogRow, snapshotId: string, ids: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const at = row.id;
  if (row.id !== `cult:${row.name}`) issues.push(`${at}: id must be cult:<name>`);
  if (row.source.snapshotId !== snapshotId) issues.push(`${at}: snapshotId differs from the catalog snapshot`);
  const pending = row.conversion.status === 'pending-fetch';
  const hashed = row.source.files.filter((f) => f.sha256 !== null).length;
  if (pending && (row.source.registrySha256 !== null || hashed > 0 || row.requirements !== null)) {
    issues.push(`${at}: a pending-fetch row cannot carry hashes or source-derived requirements`);
  }
  if (!pending && (row.source.registrySha256 === null || hashed !== row.source.files.length || row.requirements === null)) {
    issues.push(`${at}: a fetched row needs a registry hash, a hash for every file, and requirements`);
  }
  if ((row.conversion.status === 'adapter-needed' || row.conversion.status === 'app-only') && !row.conversion.reason?.trim()) {
    issues.push(`${at}: ${row.conversion.status} needs a stated reason`);
  }
  if ((row.conversion.status === 'insertable') !== (row.adapter !== null)) {
    issues.push(`${at}: insertable status and an adapter reference must go together`);
  }
  if (row.adapter !== null && row.adapter.id !== row.id) issues.push(`${at}: adapter id must equal the row id`);
  if (row.conversion.status === 'insertable' && (row.measuredBytes.html === null || row.measuredBytes.css === null)) {
    issues.push(`${at}: an insertable row needs measured html and css bytes`);
  }
  if (
    row.conversion.status === 'insertable'
    && (row.measuredBytes.html ?? 0) + (row.measuredBytes.css ?? 0) > ADAPTER_BYTE_LIMIT
  ) {
    issues.push(`${at}: measured html+css exceeds ${ADAPTER_BYTE_LIMIT} bytes`);
  }
  if (row.conversion.status === 'insertable' && row.assetKind !== 'section') issues.push(`${at}: only section rows can be insertable`);
  if (!pending && (row.conversion.status === 'app-only') !== (row.assetKind === 'app')) {
    issues.push(`${at}: app-only status and assetKind app must go together`);
  }
  if ((row.assetKind === 'page') !== (row.taxonomy.sectionKind === 'page-composition')) {
    issues.push(`${at}: assetKind page and sectionKind page-composition must go together`);
  }
  if (row.assetKind !== 'section' && row.assetKind !== 'page' && row.taxonomy.sectionKind !== 'unclassified') {
    issues.push(`${at}: only section and page rows take a section kind`);
  }
  if (new Set(row.taxonomy.components).size !== row.taxonomy.components.length) issues.push(`${at}: duplicate component ids`);
  if (new Set(row.spineAffinities).size !== row.spineAffinities.length) issues.push(`${at}: duplicate spine codes`);
  if (row.portQueue !== undefined && row.assetKind !== 'primitive' && row.assetKind !== 'app') {
    issues.push(`${at}: only primitive and app rows take a port queue`);
  }
  if (row.demoOf !== undefined && !ids.has(row.demoOf)) issues.push(`${at}: demoOf ${row.demoOf} is not a catalog row`);
  return issues;
}

/**
 * True when the catalog pins a non-empty licensed snapshot but carries none of its rows. The Cult UI
 * Pro rows are licensed content that ships in a private pack; a public checkout keeps the pinned
 * snapshot identity (so an installed pack is compared against the right registry) and no rows.
 * Any partly emptied catalog is still held to the snapshot counts.
 */
export function catalogWithheld(catalog: Pick<CultCatalog, 'rows' | 'snapshot'>): boolean {
  return catalog.rows.length === 0 && catalog.snapshot.expectedItems > 0;
}

/** Every schema and policy violation; empty when the catalog is valid. */
export function catalogIssues(catalog: unknown): string[] {
  const schemaIssues = validateAgainstSchema(catalog, cultCatalogSchema);
  if (schemaIssues.length > 0) return schemaIssues.map((i) => `${i.path}: ${i.message}`);
  const { snapshot, rows } = catalog as CultCatalog;
  const issues: string[] = [];
  const ids = new Set<string>();
  rows.forEach((row, i) => {
    if (ids.has(row.id)) issues.push(`${row.id}: duplicate id`);
    ids.add(row.id);
    const prev = rows[i - 1];
    if (prev && prev.id >= row.id) issues.push(`${row.id}: rows must be sorted by id`);
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    issues.push(...rowIssues(row, snapshot.id, ids));
    if (row.derivedFrom !== undefined) issues.push(...derivedIssues(row, byId));
  }
  // Registry items and derived rows are counted apart, so the index invariant stays checkable.
  if (snapshot.expectedItems - snapshot.fetchedItems !== snapshot.pendingItems) issues.push('snapshot: pending count is inconsistent');
  if (catalogWithheld({ rows, snapshot })) return issues;
  const sourceRows = rows.filter((r) => r.derivedFrom === undefined);
  const derivedRows = rows.length - sourceRows.length;
  const fetched = sourceRows.filter((r) => r.conversion.status !== 'pending-fetch').length;
  if (sourceRows.length !== snapshot.expectedItems) issues.push(`snapshot: ${sourceRows.length} source rows, expected ${snapshot.expectedItems}`);
  if (derivedRows !== snapshot.derivedRows) issues.push(`snapshot: ${derivedRows} derived rows, snapshot says ${snapshot.derivedRows}`);
  if (fetched !== snapshot.fetchedItems) issues.push(`snapshot: ${fetched} fetched rows, snapshot says ${snapshot.fetchedItems}`);
  return issues;
}
