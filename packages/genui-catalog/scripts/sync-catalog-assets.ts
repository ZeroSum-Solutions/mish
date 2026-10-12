/**
 * Copy the catalog components each Agency family DECLARES into every compiler copy that carries
 * that family, and check that no copy has drifted. Modelled on scripts/sync-agency-compiler.ts at
 * the repo root.
 *
 * Why copies: the daemon packs an installed plugin without node_modules
 * (apps/daemon/src/plugins/pack.ts), the fast lane loads a family package by path, and the daemon
 * imports the Agency Site template's family modules directly, so a family's render.ts can read
 * only files inside its own compiler copy. The shared helper
 * plugins/_official/shared/agency-compiler/scripts/catalog-block.ts reads them from there.
 *
 * Declarations: `families/<family>/catalog.json` = `{"catalogComponents": ["<id>", ...]}`, plus an
 * optional `effects` placement declaration (validated by the compiler's effects.ts) whose allowed
 * ids must all be in `catalogComponents`. Every
 * family an `agency-<family>` package owns must declare (an empty list is fine); the file travels
 * with the family module, so scripts/sync-agency-compiler.ts mirrors it into every carrier. Each
 * declared id must be a catalog.json entry with status "ported".
 *
 * Targets: every `agency-*` package's `compiler/scripts/` and the Agency Site template's
 * `design-templates/agency-site/scripts/`. Each gets a generated folder `catalog/` holding:
 *
 *   components/<id>/{auto.js, styles.css}             dist/components/<id>/{auto.js, styles.css} for
 *                                                      each id declared by a family module that copy
 *                                                      carries (the two files catalog-block.ts inlines)
 *   hyperui/<kind>.css, hyperui/LICENSE               the compiled HyperUI kind CSS
 *                                                      (plugins/_official/shared/ui-kits/hyperui/css/)
 *                                                      for a package whose family is a kind in
 *                                                      pagekinds.json, plus the MIT licence it ships under
 *   CATALOG.json                                      {files[{path, source, bytes, sha256}],
 *                                                      components{<id>: {kind}}} (kind read by effects.ts)
 *
 * The folder is wholly generated: a file in it that the plan does not expect is removed, and a
 * copy that needs nothing has no folder at all.
 *
 * Usage (run `pnpm --filter @open-design/genui-catalog build` first; the JS comes from dist/):
 *   node --experimental-strip-types packages/genui-catalog/scripts/sync-catalog-assets.ts
 *   node --experimental-strip-types packages/genui-catalog/scripts/sync-catalog-assets.ts --check
 *
 * Flags:
 *   --check   Write nothing. Report every path that differs from its source, is missing or is
 *             not expected, and exit 1 if there is any. This is the CI gate.
 *
 * Nothing is written until every target has been planned without error.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCatalog } from '../src/validate.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const examplesDir = path.join(repoRoot, 'plugins/_official/examples');
const templateScripts = path.join(repoRoot, 'design-templates/agency-site/scripts');
const hyperuiDir = path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui');
const distComponents = path.join(packageRoot, 'dist/components');
/** Package-relative folder a family package receives. */
export const CATALOG_FOLDER = 'compiler/scripts/catalog';
/** A family module's declaration of the catalog components it embeds. */
export const DECLARATION = 'catalog.json';
const MANIFEST = 'CATALOG.json';
/** The built files a family page inlines (see catalog-block.ts); index.js (ESM) is not copied. */
const COPIED_FILES = ['auto.js', 'styles.css'] as const;

export interface SyncReport { targets: string[]; drift: string[]; errors: string[]; files: number; bytes: number }
type Write = { file: string; bytes: Buffer };
type Source = { source: string; bytes: Buffer };
/** One compiler copy: its scripts folder and, for a package, the family it owns. */
export interface SyncTarget { label: string; scriptsDir: string; ownFamily?: string }

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const rel = (absolute: string): string => path.relative(repoRoot, absolute).split(path.sep).join('/');

function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

/** Every `agency-*` family package that carries a compiler. */
export function familyPackages(): string[] {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agency-'))
    .map((entry) => path.join(examplesDir, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'compiler/scripts')))
    .sort();
}

/** Every compiler copy the sync writes to: the family packages, then the Agency Site template. */
export function syncTargets(): SyncTarget[] {
  const packages = familyPackages().map((dir) => ({
    label: rel(dir), scriptsDir: path.join(dir, 'compiler/scripts'), ownFamily: path.basename(dir).slice('agency-'.length),
  }));
  return existsSync(templateScripts) ? [...packages, { label: rel(path.dirname(templateScripts)), scriptsDir: templateScripts }] : packages;
}

/** The ids one family module declares, or undefined when it has no declaration file. */
export function readDeclaration(familyDir: string, report: SyncReport): string[] | undefined {
  const file = path.join(familyDir, DECLARATION);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    report.errors.push(`${rel(file)}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
  const record = parsed as { catalogComponents?: unknown; effects?: unknown };
  const ids = record?.catalogComponents;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => key !== 'catalogComponents' && key !== 'effects')
    || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    report.errors.push(`${rel(file)}: expected {"catalogComponents": [unique component ids], "effects"?: {...}}`);
    return [];
  }
  for (const id of effectAllowIds(record.effects)) {
    if (!(ids as string[]).includes(id)) report.errors.push(`${rel(file)}: effects allows "${id}", which catalogComponents does not declare`);
  }
  return ids as string[];
}

/**
 * Every component id an `effects` declaration allows. Only membership in `catalogComponents` is
 * checked here, so each allowed id is on disk; the compiler's `effects.ts` validates the rest.
 */
function effectAllowIds(effects: unknown): string[] {
  if (typeof effects !== 'object' || effects === null) return [];
  const placements = (effects as { placements?: unknown }).placements;
  if (typeof placements !== 'object' || placements === null) return [];
  return Object.values(placements).flatMap((entry) => {
    const allow = (entry as { allow?: unknown } | null)?.allow;
    return Array.isArray(allow) ? allow.filter((id): id is string => typeof id === 'string') : [];
  });
}

/** Built files of every ported component, by component id. */
function portedComponents(report: SyncReport, kinds: Map<string, string>): Map<string, Map<string, Source>> {
  const out = new Map<string, Map<string, Source>>();
  const catalog = validateCatalog(JSON.parse(readFileSync(path.join(packageRoot, 'catalog.json'), 'utf8')));
  for (const entry of catalog.components) {
    if (entry.status !== 'ported') continue;
    if (entry.kind) kinds.set(entry.id, entry.kind);
    else report.errors.push(`packages/genui-catalog/catalog.json: ported component ${entry.id} has no kind`);
    const files = new Map<string, Source>();
    out.set(entry.id, files);
    const built = path.join(distComponents, entry.id);
    for (const file of COPIED_FILES.filter((name) => existsSync(path.join(built, name)))) {
      files.set(`components/${entry.id}/${file}`, {
        source: `packages/genui-catalog/dist/components/${entry.id}/${file}`,
        bytes: readFileSync(path.join(built, file)),
      });
    }
  }
  return out;
}

function planTarget(target: SyncTarget, ported: Map<string, Map<string, Source>>, componentKinds: Map<string, string>, kinds: Set<string>, report: SyncReport, writes: Write[], removals: string[]): void {
  const folder = path.join(target.scriptsDir, 'catalog');
  const expected = new Map<string, Source>();
  const copied = new Set<string>();
  const familiesDir = path.join(target.scriptsDir, 'families');
  const carried = existsSync(familiesDir)
    ? readdirSync(familiesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  if (target.ownFamily && !carried.includes(target.ownFamily)) report.errors.push(`${target.label}: no families/${target.ownFamily}/ module`);
  for (const family of carried) {
    const declared = readDeclaration(path.join(familiesDir, family), report);
    if (declared === undefined) {
      if (family === target.ownFamily) report.errors.push(`${target.label}: families/${family}/${DECLARATION} is missing — every owned family declares its catalog components (an empty list is fine)`);
      continue;
    }
    for (const id of declared) {
      const files = ported.get(id);
      if (!files) {
        report.errors.push(`${target.label}: families/${family}/${DECLARATION} declares "${id}", which is not a ported catalog component`);
        continue;
      }
      if (files.size !== COPIED_FILES.length) {
        report.errors.push(`packages/genui-catalog/dist/components/${id}: missing — run \`pnpm --filter @open-design/genui-catalog build\` first`);
        continue;
      }
      for (const [file, source] of files) expected.set(file, source);
      copied.add(id);
    }
  }
  if (target.ownFamily && kinds.has(target.ownFamily)) {
    const css = path.join(hyperuiDir, 'css', `${target.ownFamily}.css`);
    if (!existsSync(css)) report.errors.push(`${rel(css)}: missing HyperUI kind CSS for ${target.label}`);
    else expected.set(`hyperui/${target.ownFamily}.css`, { source: rel(css), bytes: readFileSync(css) });
    expected.set('hyperui/LICENSE', { source: rel(path.join(hyperuiDir, 'LICENSE')), bytes: readFileSync(path.join(hyperuiDir, 'LICENSE')) });
  }
  const all = new Map<string, Buffer>();
  if (expected.size > 0) {
    const manifest = {
      note: 'Generated by packages/genui-catalog/scripts/sync-catalog-assets.ts. Do not edit; re-run the sync.',
      files: [...expected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, { source, bytes }]) => ({
        path: file, source, bytes: bytes.length, sha256: sha256(bytes),
      })),
      // Each copied component's kind, read by the compiler's effects.ts (`componentKind`).
      components: Object.fromEntries([...copied].sort().map((id) => [id, { kind: componentKinds.get(id) }])),
    };
    for (const [file, { bytes }] of expected) all.set(file, bytes);
    all.set(MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }
  for (const [file, bytes] of all) {
    report.files += 1;
    report.bytes += bytes.length;
    const targetFile = path.join(folder, file);
    const current = existsSync(targetFile) ? readFileSync(targetFile) : undefined;
    if (current?.equals(bytes)) continue;
    report.drift.push(`${rel(targetFile)}: ${current ? 'differs from its source' : 'missing'}`);
    writes.push({ file: targetFile, bytes });
  }
  for (const file of filesUnder(folder)) {
    if (all.has(file)) continue;
    report.drift.push(`${rel(path.join(folder, file))}: not expected — remove`);
    removals.push(path.join(folder, file));
  }
}

/** Remove empty directories left under `dir` (and `dir` itself when it ends up empty). */
function pruneEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

export function syncCatalogAssets({ check = false }: { check?: boolean } = {}): SyncReport {
  const report: SyncReport = { targets: [], drift: [], errors: [], files: 0, bytes: 0 };
  const componentKinds = new Map<string, string>();
  const ported = portedComponents(report, componentKinds);
  const pagekinds = JSON.parse(readFileSync(path.join(hyperuiDir, 'pagekinds.json'), 'utf8')) as Record<string, unknown>;
  const kinds = new Set(Object.keys(pagekinds));
  const writes: Write[] = [];
  const removals: string[] = [];
  const targets = syncTargets();
  for (const target of targets) {
    report.targets.push(target.label);
    planTarget(target, ported, componentKinds, kinds, report, writes, removals);
  }
  if (check || report.errors.length > 0) return report;
  for (const write of writes) {
    mkdirSync(path.dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.bytes);
  }
  for (const removal of removals) rmSync(removal);
  for (const target of targets) pruneEmpty(path.join(target.scriptsDir, 'catalog'));
  return report;
}

function main(): void {
  const check = process.argv.includes('--check');
  let report: SyncReport;
  try {
    report = syncCatalogAssets({ check });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  for (const line of report.errors) console.error(`error   ${line}`);
  for (const line of report.drift) console.error(`${check || report.errors.length > 0 ? 'drift' : 'synced'}  ${line}`);
  const scale = `${report.targets.length} compiler copies, ${report.files} files, ${report.bytes} bytes`;
  if (report.errors.length > 0) {
    console.error(`sync-catalog-assets: ${report.errors.length} error(s), nothing written; ${scale}`);
    process.exitCode = 1;
    return;
  }
  if (!check) {
    console.log(`sync-catalog-assets: ${report.drift.length === 0 ? 'already in sync' : `updated ${report.drift.length} path(s)`} (${scale}).`);
    return;
  }
  if (report.drift.length > 0) {
    console.error(`sync-catalog-assets: ${report.drift.length} drifted path(s). Run \`pnpm --filter @open-design/genui-catalog build && pnpm --filter @open-design/genui-catalog sync-assets\` and commit the result.`);
    process.exitCode = 1;
    return;
  }
  console.log(`sync-catalog-assets: in sync (${scale}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
