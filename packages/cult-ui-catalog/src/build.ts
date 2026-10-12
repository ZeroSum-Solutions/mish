/**
 * Pure transform: a validated kit snapshot plus reviewed overrides → catalog.json content. Rows are
 * sorted by id; object keys are sorted by the writer (src/canonical.ts). Only metadata and hashes
 * are copied: `files[].content` is hashed and measured, never stored.
 */

import { classifyAssetKind, classifyComponents, classifySectionKind, classifyStyle } from './classify.ts';
import { initialConversion } from './conversion.ts';
import { conversionFields, type ConvertedSet } from './converted.ts';
import { buildDerivedRows, derivedName, pageSections } from './derived.ts';
import { requirements, runtimeFeatures } from './features.ts';
import { sha256, snapshotDigest, type FetchedItem, type IndexItem, type KitSnapshot } from './kit.ts';
import { applyOverrides, type Overrides } from './overrides.ts';
import { spineAffinities } from './spines.ts';
import {
  CULT_CATALOG_SCHEMA,
  REGISTRY_URL_PATTERN,
  RIGHTS_EVIDENCE,
  type CultCatalog,
  type CultCatalogRow,
  type SnapshotInfo,
  type SourceFile,
} from './types.ts';

export function snapshotInfo(kit: KitSnapshot, derivedRows: number): SnapshotInfo {
  const digest = snapshotDigest(kit.fetched);
  return {
    id: `cult-ui-pro@${digest.slice(0, 16)}`,
    digest,
    indexSha256: kit.indexSha256,
    registryUrlPattern: REGISTRY_URL_PATTERN,
    expectedItems: kit.items.length,
    fetchedItems: kit.fetched.size,
    pendingItems: kit.items.length - kit.fetched.size,
    derivedRows,
  };
}

function sourceFiles(item: IndexItem, fetched: FetchedItem | undefined): SourceFile[] {
  const byPath = new Map(fetched?.files.map((f) => [f.path, f]) ?? []);
  return item.files
    .map((f) => {
      const content = byPath.get(f.path)?.content;
      return {
        path: f.path,
        target: f.target,
        type: f.type,
        sha256: content === undefined ? null : sha256(content),
        bytes: content === undefined ? null : Buffer.byteLength(content, 'utf8'),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function buildRow(item: IndexItem, kit: KitSnapshot, snapshotId: string, names: ReadonlySet<string>): CultCatalogRow {
  const fetched = kit.fetched.get(item.name);
  const pendingReason = fetched ? undefined : (kit.pending.get(item.name) ?? 'registry item not fetched yet');
  const sourceText = fetched ? fetched.files.map((f) => f.content).join('\n') : '';
  const assetKind = classifyAssetKind(item);
  const features = runtimeFeatures(item, sourceText);
  const base = item.name.endsWith('-demo') ? item.name.slice(0, -'-demo'.length) : undefined;
  return {
    id: `cult:${item.name}`,
    name: item.name,
    title: item.title,
    description: item.description,
    original: {
      type: item.type,
      category: item.category,
      tags: [...item.tags],
      useCases: [...item.useCases],
      style: item.style,
      features: [...item.features],
      registryDependencies: [...item.registryDependencies].sort(),
    },
    source: { snapshotId, registrySha256: fetched?.registrySha256 ?? null, files: sourceFiles(item, fetched) },
    rights: { license: 'licensed', decision: 'bundle', evidence: RIGHTS_EVIDENCE },
    assetKind,
    taxonomy: {
      sectionKind: classifySectionKind(item, assetKind),
      components: classifyComponents(item, sourceText),
      style: classifyStyle(item),
    },
    spineAffinities: spineAffinities(item.useCases, assetKind),
    dependencies: [...new Set(item.dependencies)].sort(),
    runtimeFeatures: features,
    requirements: fetched ? requirements(sourceText) : null,
    conversion: initialConversion(assetKind, item.category, features, pendingReason),
    adapter: null,
    previewId: null,
    measuredBytes: { html: null, css: null, js: null },
    ...(base !== undefined && names.has(base) ? { demoOf: `cult:${base}` } : {}),
  };
}

/** Applies the converter's result (src/converted.ts) to a row; rows it has no say over pass through. */
export function withConversion(row: CultCatalogRow, converted: ConvertedSet | undefined): CultCatalogRow {
  const fields = conversionFields(row, converted?.get(row.name));
  return fields ? { ...row, ...fields } : row;
}

/**
 * Names of the converter blocks cut from fetched page items (`<page>--<section>`, src/derived.ts),
 * so the importer reads their `converted/` output alongside the registry items'.
 */
export function derivedBlockNames(kit: KitSnapshot): string[] {
  return kit.items
    .filter((item) => classifyAssetKind(item) === 'page')
    .flatMap((item) => {
      const fetched = kit.fetched.get(item.name);
      return fetched ? pageSections(fetched).map((section) => derivedName(item.name, section)) : [];
    });
}

export function buildCatalog(kit: KitSnapshot, overrides: Overrides, converted?: ConvertedSet): CultCatalog {
  const digest = snapshotInfo(kit, 0);
  const names = new Set(kit.items.map((i) => i.name));
  const sourceRows = kit.items.map((item) => buildRow(item, kit, digest.id, names));
  const derived = kit.items.flatMap((item, i) => {
    const fetched = kit.fetched.get(item.name);
    return fetched ? buildDerivedRows(sourceRows[i]!, item, fetched) : [];
  });
  const rows = [...sourceRows, ...derived]
    .map((row) => withConversion(row, converted))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: CULT_CATALOG_SCHEMA, snapshot: { ...digest, derivedRows: derived.length }, rows: applyOverrides(rows, overrides) };
}
