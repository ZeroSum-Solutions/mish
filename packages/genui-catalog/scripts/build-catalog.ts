/**
 * Generate catalog.json: one entry per row of data/catalog-seed.json (the 57 rows of the master
 * CSV, snapshotted at data/source-csv-snapshot.csv), then one per row of data/cult-ui-pro-seed.json
 * (licensed Cult UI Pro ports, rights in docs/legal/cult-ui-pro-rights.md; not part of the CSV),
 * followed by the owned public-index harvest in data/harvest-seed.json, and merged with components/<id>/meta.json where
 * the package carries that component. meta.json is the source of truth for every field it sets;
 * the seed supplies the source record, licence evidence (the CSV License column, verbatim),
 * verdict, rationale and licence decision. `_`-prefixed directories (the `_template`) are not
 * catalogued.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-catalog.ts          write catalog.json
 *   node --experimental-strip-types scripts/build-catalog.ts --check  write nothing; exit 1 when
 *                                                                     catalog.json is stale or invalid
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentsDir, measureComponent, packageRoot } from './component-bundle.ts';
import { validateCatalog, validateComponentMeta } from '../src/validate.ts';
import {
  CATALOG_SCHEMA, type Catalog, type CatalogEntry, type ComponentMeta, type GenuiCategory, type LicenceDecision,
  type PortDifficulty, type SourceName, type Verdict,
} from '../src/types.ts';

export const catalogPath = path.join(packageRoot, 'catalog.json');
const seedPath = path.join(packageRoot, 'data/catalog-seed.json');
const cultSeedPath = path.join(packageRoot, 'data/cult-ui-pro-seed.json');
const harvestSeedPath = path.join(packageRoot, 'data/harvest-seed.json');
const categoriesPath = path.join(packageRoot, 'data/categories.json');

interface SeedRow {
  id: string;
  source: Record<string, string>;
  category: string;
  portDifficulty: string;
  tier: string;
  licenceDecision: string;
  sourceUrl: string;
  verdict: string;
  rationale: string;
}

const SOURCE_NAMES: Record<string, SourceName> = {
  'React Bits': 'react-bits',
  '21st.dev': '21st.dev',
  'Kokonut UI': 'kokonut-ui',
  'Cult UI Pro': 'cult-ui-pro',
  Original: 'original',
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** The 57 rows of the master CSV snapshot, in CSV order. */
export function readCsvSeed(): SeedRow[] {
  return readJson<{ components: SeedRow[] }>(seedPath).components;
}

/** Catalog order: the frozen CSV, licensed Cult UI Pro rows, then the owned harvest. */
export function readSeed(): SeedRow[] {
  // The licensed Cult UI Pro seed is not part of the public repository: a missing file means zero licensed rows.
  const cult = existsSync(cultSeedPath) ? readJson<{ components: SeedRow[] }>(cultSeedPath).components : [];
  return [...readCsvSeed(), ...cult,
    ...readJson<{ components: SeedRow[] }>(harvestSeedPath).components];
}

/** "GlareHover" or "glare-hover" -> "Glare Hover". */
function humanise(component: string): string {
  return component
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function parseTier(tier: string): 1 | 2 | 3 | null {
  const match = /^Tier ([123])\b/.exec(tier);
  return match ? (Number(match[1]) as 1 | 2 | 3) : null;
}

/** components/<id>/meta.json for every catalogued component directory. */
export function readMetas(): Map<string, ComponentMeta> {
  const metas = new Map<string, ComponentMeta>();
  if (!existsSync(componentsDir)) return metas;
  for (const dir of subdirectories(componentsDir)) {
    if (dir.startsWith('_')) continue;
    const file = path.join(componentsDir, dir, 'meta.json');
    if (!existsSync(file)) throw new Error(`components/${dir}/ has no meta.json`);
    const meta = validateComponentMeta(readJson<unknown>(file), `components/${dir}/meta.json`);
    if (meta.id !== dir) throw new Error(`components/${dir}/meta.json has id "${meta.id}"; it must match the directory`);
    metas.set(dir, meta);
  }
  return metas;
}

function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function seedEntry(row: SeedRow, category: GenuiCategory): CatalogEntry {
  const source = row.source;
  const name = SOURCE_NAMES[source.Source ?? ''];
  if (!name) throw new Error(`seed row ${row.id}: unknown Source "${source.Source}"`);
  return {
    id: row.id,
    name: humanise(source.Component ?? row.id),
    category,
    source: {
      name,
      component: source.Component ?? '',
      license: source.License ?? '',
      category: source.Category ?? '',
      description: source['What it does'] ?? '',
      dependencies: source.Dependencies ?? '',
    },
    sourceUrl: row.sourceUrl,
    licenceDecision: row.licenceDecision as LicenceDecision,
    verdict: row.verdict as Verdict,
    rationale: row.rationale,
    tier: parseTier(row.tier),
    tierNote: row.tier,
    portDifficulty: row.portDifficulty as PortDifficulty,
    status: 'planned',
  };
}

/** Build (and validate) the catalog from the seed, the category table and every meta.json. */
export async function buildCatalog(): Promise<Catalog> {
  const seed = readSeed();
  const categories = readJson<{ categories: Record<string, GenuiCategory> }>(categoriesPath).categories;
  const metas = readMetas();
  const seedIds = new Set(seed.map((row) => row.id));
  for (const id of metas.keys()) {
    if (!seedIds.has(id)) throw new Error(`components/${id}/ has no seed row; add an owned effect to data/harvest-seed.json or a licensed Cult UI Pro port to data/cult-ui-pro-seed.json`);
  }
  const components: CatalogEntry[] = [];
  for (const row of seed) {
    const category = categories[row.id];
    if (!category) throw new Error(`data/categories.json has no category for "${row.id}"`);
    const entry = seedEntry(row, category);
    const meta = metas.get(row.id);
    if (!meta) { components.push(entry); continue; }
    const merged: CatalogEntry = { ...entry };
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    if (merged.status === 'ported') {
      for (const field of ['entry', 'css', 'demo'] as const) {
        const file = merged[field];
        if (file && !existsSync(path.join(packageRoot, file))) throw new Error(`${row.id}: ${field} ${file} does not exist`);
      }
      merged.bytes = await measureComponent(row.id);
    }
    components.push(orderKeys(merged));
  }
  return validateCatalog({ schema: CATALOG_SCHEMA, components });
}

const KEY_ORDER: ReadonlyArray<keyof CatalogEntry> = [
  'id', 'name', 'category', 'kind', 'source', 'sourceUrl', 'licenceDecision', 'verdict', 'rationale', 'tier',
  'tierNote', 'portDifficulty', 'status', 'entry', 'css', 'demo', 'bytes', 'props', 'a11y', 'reducedMotion', 'motion', 'styleClass',
];

function orderKeys(entry: CatalogEntry): CatalogEntry {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (entry[key] !== undefined) out[key] = entry[key];
  return out as unknown as CatalogEntry;
}

export function serialiseCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const text = serialiseCatalog(await buildCatalog());
  const current = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
  if (check) {
    if (current !== text) {
      console.error('build-catalog: catalog.json is stale. Run `pnpm --filter @mish/genui-catalog catalog` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('build-catalog: catalog.json is valid and up to date.');
    return;
  }
  if (current !== text) writeFileSync(catalogPath, text);
  console.log(`build-catalog: ${current === text ? 'already up to date' : 'wrote catalog.json'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
