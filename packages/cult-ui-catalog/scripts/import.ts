/**
 * Builds catalog.json from the private Cult UI Pro source kit.
 *
 *   node --experimental-strip-types scripts/import.ts          write catalog.json and the pinned
 *                                                               snapshot block in the rights doc
 *   node --experimental-strip-types scripts/import.ts --check  write nothing; exit 1 on drift
 *
 * Conversion statuses, adapter references and measured bytes come from the kit's `converted/`
 * output (src/converted.ts); `scripts/adapters.ts` copies the adapters themselves.
 *
 * The kit path is CULT_KIT_DIR (default ~/projects/mm-source-kits/cult-ui-pro). `--check` always
 * validates the committed catalog, the overrides and the rights-doc block. It compares against the
 * kit when the kit exists; without it (CI) the comparison is skipped and said so, unless
 * CULT_REQUIRE_KIT=1, which makes a missing kit an error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog, derivedBlockNames } from '../src/build.ts';
import { catalogFileText } from '../src/canonical.ts';
import { readConverted } from '../src/converted.ts';
import { catalogDrift } from '../src/drift.ts';
import { readKit } from '../src/kit.ts';
import { applyOverrides, parseOverrides } from '../src/overrides.ts';
import { renderSnapshotBlock, spliceSnapshotBlock } from '../src/rights-doc.ts';
import { catalogSummary } from '../src/summary.ts';
import type { CultCatalog } from '../src/types.ts';
import { catalogIssues } from '../src/validate.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(pkgDir, 'catalog.json');
const overridesPath = join(pkgDir, 'reviewed-overrides.json');
const docPath = resolve(pkgDir, '..', '..', 'docs', 'legal', 'cult-ui-pro-rights.md');
const kitDir = process.env.CULT_KIT_DIR ?? join(homedir(), 'projects', 'mm-source-kits', 'cult-ui-pro');

function fail(title: string, lines: readonly string[]): never {
  console.error(`${title} (${lines.length})`);
  for (const line of lines.slice(0, 50)) console.error(`  - ${line}`);
  if (lines.length > 50) console.error(`  … ${lines.length - 50} more`);
  process.exit(1);
}

function loadOverrides() {
  return parseOverrides(JSON.parse(readFileSync(overridesPath, 'utf8')));
}

function buildFromKit(): CultCatalog {
  const kit = readKit(kitDir);
  if (kit.issues.length > 0) fail(`Source kit ${kitDir} is inconsistent`, kit.issues);
  if (kit.warnings.length > 0) console.warn(`${kit.warnings.length} kit warnings (first: ${kit.warnings[0]})`);
  // The converter's output (kit `converted/`) decides insertable / adapter-needed; without it
  // every row keeps its initial status and `--check` reports the difference as drift.
  const converted = readConverted(kitDir, [...kit.items.map((item) => item.name), ...derivedBlockNames(kit)]);
  if (converted === null) console.warn(`no converted/ output in ${kitDir}; conversion statuses stay at their initial values`);
  return buildCatalog(kit, loadOverrides(), converted ?? undefined);
}

function runImport(): void {
  const catalog = buildFromKit();
  const issues = catalogIssues(catalog);
  if (issues.length > 0) fail('Generated catalog is invalid', issues);
  const text = catalogFileText(catalog);
  if (!existsSync(catalogPath) || readFileSync(catalogPath, 'utf8') !== text) writeFileSync(catalogPath, text);
  const doc = readFileSync(docPath, 'utf8');
  const nextDoc = spliceSnapshotBlock(doc, catalog.snapshot);
  if (nextDoc !== doc) writeFileSync(docPath, nextDoc);
  console.log(`catalog.json: ${catalog.rows.length} rows, snapshot ${catalog.snapshot.id}`);
  console.log(JSON.stringify({ snapshot: catalog.snapshot, ...catalogSummary(catalog) }, null, 2));
}

function runCheck(): void {
  const committed = JSON.parse(readFileSync(catalogPath, 'utf8')) as CultCatalog;
  const issues = catalogIssues(committed);
  if (issues.length > 0) fail('catalog.json is invalid', issues);
  try {
    // Overrides must parse and name existing rows (applying them is a no-op check here).
    applyOverrides(committed.rows, loadOverrides());
  } catch (error) {
    fail('reviewed-overrides.json is invalid', [(error as Error).message]);
  }
  const doc = readFileSync(docPath, 'utf8');
  if (!doc.includes(renderSnapshotBlock(committed.snapshot))) {
    fail('docs/legal/cult-ui-pro-rights.md does not pin the catalog snapshot', ['run the importer to re-pin it']);
  }
  if (!existsSync(join(kitDir, 'registry', 'index.json'))) {
    if (process.env.CULT_REQUIRE_KIT === '1') fail('Source kit missing', [kitDir]);
    console.log(`catalog.json valid (${committed.rows.length} rows); source kit not found at ${kitDir}, snapshot comparison skipped`);
    return;
  }
  const fresh = buildFromKit();
  const drift = catalogDrift(committed, fresh);
  if (drift.length > 0 || catalogFileText(fresh) !== readFileSync(catalogPath, 'utf8')) {
    fail('catalog.json drifted from the source kit; run `pnpm --filter @mish/cult-ui-catalog import`', drift.length > 0 ? drift : ['formatting differs']);
  }
  console.log(`catalog.json matches the source kit (${committed.rows.length} rows, snapshot ${committed.snapshot.id})`);
}

if (process.argv.includes('--check')) runCheck();
else runImport();
