/**
 * The public slug of every catalog row: what a person sees and types for an item (the install URL
 * `/api/cult/r/<slug>.json`, `od cult add <slug>`, the `app/(cult)/<slug>/` folder and route, `od
 * cult list`). Generated with the catalog, from each row's brand-free display title:
 *
 *   node --experimental-strip-types scripts/slugs.ts          write generated/slugs.json
 *   node --experimental-strip-types scripts/slugs.ts --check  write nothing; exit 1 when stale
 *
 * `assignCultSlugs` (@mish/contracts, api/cult-brand.ts) owns the rule: the slugified
 * brand-free title ("Marketing Pricing Vercel" → `pricing-series-v`), unique, never another row's
 * internal name, and sticky: a row keeps the slug the committed file gives it while that slug is
 * still valid for its title, so a regeneration never renames an item a person already installed.
 * The internal registry name stays in catalog.json only; the daemon resolves it as an alias.
 *
 * The file is its own generated output (not a catalog.json field), so branches that regenerate
 * catalog.json's conversion fields merge with it without a conflict; a new row only needs a
 * re-run of this script (`pnpm --filter @mish/cult-ui-catalog import` runs it last).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assignCultSlugs } from '@mish/contracts';

import type { CultCatalog } from '../src/types.ts';

export const SLUGS_SCHEMA = 'cult-slugs/1';

export interface SlugManifest {
  schema: typeof SLUGS_SCHEMA;
  /** Row id (`cult:<name>`) → public slug. */
  items: Record<string, string>;
}

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(PACKAGE_DIR, 'catalog.json');
const SLUGS_PATH = join(PACKAGE_DIR, 'generated', 'slugs.json');

export function slugManifestText(catalog: Pick<CultCatalog, 'rows'>, previous: Readonly<Record<string, string>>): string {
  const manifest: SlugManifest = { schema: SLUGS_SCHEMA, items: assignCultSlugs(catalog.rows, previous) };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readPrevious(): Record<string, string> {
  if (!existsSync(SLUGS_PATH)) return {};
  const parsed = JSON.parse(readFileSync(SLUGS_PATH, 'utf8')) as Partial<SlugManifest>;
  if (parsed.schema !== SLUGS_SCHEMA || typeof parsed.items !== 'object' || parsed.items === null) {
    throw new Error(`${SLUGS_PATH}: unexpected schema`);
  }
  return parsed.items;
}

function main(): void {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CultCatalog;
  const previous = readPrevious();
  const text = slugManifestText(catalog, previous);
  const current = existsSync(SLUGS_PATH) ? readFileSync(SLUGS_PATH, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (text !== current) {
      console.error('generated/slugs.json is stale; run `node --experimental-strip-types scripts/slugs.ts`');
      process.exit(1);
    }
    console.log(`generated/slugs.json matches catalog.json (${catalog.rows.length} slugs)`);
    return;
  }
  if (text !== current) writeFileSync(SLUGS_PATH, text);
  console.log(`generated/slugs.json: ${catalog.rows.length} slugs`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
