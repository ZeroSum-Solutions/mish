#!/usr/bin/env node
// Copy the one canonical Agency Site compiler into every copy of it, and check that no copy has
// drifted from it.
//
// There are seventeen copies of the same compiler. The sixteen family packages under
// `plugins/_official/examples/agency-*/` need theirs: the daemon packs an installed plugin
// without `node_modules` (`apps/daemon/src/plugins/pack.ts`) and the fast lane loads a package by
// path (`packages/agency-fast-lane/src/family.ts`), so a package runs outside the workspace and
// cannot import a shared workspace package. The seventeenth, `design-templates/agency-site/scripts/`,
// is the production "New Project -> Prototype -> Agency Site" template the daemon loads at
// runtime (`apps/daemon/src/artifacts/agency-recipe.ts`, `docs/agency-site.md`). Left alone, the
// copies drift — a fix landed in one never reaches the others.
//
// So there is one canonical copy, at `plugins/_official/shared/agency-compiler/scripts/`, and
// this script fans it out.
//
// Usage:
//   node --experimental-strip-types scripts/sync-agency-compiler.ts
//   node --experimental-strip-types scripts/sync-agency-compiler.ts --check
//
// Flags:
//   --check   Write nothing. Report every target path that differs from its source or whose
//             COMMIT.json hash is stale, and exit 1 if there is any. This is the CI gate.
//
// Two directions, two sources of truth:
//
//   1. The SHARED compiler files (`assets.ts`, `compose.ts`, `family.ts`, `render.ts`,
//      `schema.ts`, `sections.ts`, `styles.ts`) come from the canonical folder and go to all
//      seventeen copies.
//   2. A FAMILY MODULE a copy carries but does not own comes FROM THE PACKAGE NAMED AFTER IT
//      (`families/<family>/**` comes from `agency-<family>`) and goes to every copy that carries
//      it without owning it — the template (`families/emmpo/**` from `agency-emmpo`,
//      `families/watson/**` from `agency-watson`) and any example package that holds another
//      family's module as a leftover copy (for example `agency-maren`'s `families/watson/**`,
//      copied from `agency-watson`). The owning package is the source of truth for its family
//      module: it is where that family's fixes land (#19, #23, #27) and where its reference
//      fixture and preview are verified. Mirroring is one-way and additive — every file the owner
//      ships must be byte-identical in a carrier, and a file only the carrier has (the template's
//      `render.test.ts`, `tsconfig.json`, `benchmark.ts`, resource builders) is that carrier's own
//      authoring surface and is left alone. Which family a copy carries but does not own is an
//      EXPLICIT TABLE (`TEMPLATE_MIRRORS`, `PACKAGE_MIRRORS`), never inferred from directory
//      names, so a package that legitimately grows a second family module of its own is never
//      silently treated as a stale copy and overwritten. Planning cross-checks each package's
//      table entry against what is actually on disk: a carried `families/<family>/` directory
//      the table does not list, or a table entry with no such directory, is an error reported
//      before any write, naming `PACKAGE_MIRRORS` so a maintainer knows where to fix it.
//
// It also GENERATES one per-copy file, `scripts/families/registry.ts`: the static table of the
// family modules that copy carries, which the shared `family.ts` dispatches through. The roster
// is the one thing that genuinely differs per copy (the packages' family-module sets have an
// empty intersection), and it has to be static — `renderFamily` is called synchronously by the
// daemon, the fast lane and the e2e suites, and `createRequire` of a `.ts` file is not loadable
// under the Playwright loader ("exports is not defined in ES module scope"). So the dispatch
// logic lives once, in the canonical `family.ts`, and only the roster is generated.
//
// What it never touches:
//   - a family module's OWN package, `scripts/families/<family>/**` inside `agency-<family>` —
//     that copy is package-owned (`registry.ts` sits beside it, not inside it)
//   - `families/`, `preview/`, `assets/`, `README.md`, `SKILL.md`, `mish.json`
//   - `compiler/FAMILY-PATCH.json` — it records hashes of family sources only, never a shared or
//     mirrored file, so it has nothing to say about this sync
//   - every `COMMIT.json` entry for a file this script does not write. That file records a
//     source closure at commit 37f396f3, and for the files listed in `FAMILY-PATCH.json` it
//     deliberately keeps the pre-patch baseline hash. Refreshing those would destroy the record.
//     `design-templates/agency-site/` has no `COMMIT.json` at all, so it has none to refresh.
//   - a file a carrier's mirrored family folder holds that the owner does not ship — reported as
//     kept, never deleted, since a copy's family folder can carry its own extra authoring files.
//
// A non-canonical file directly under a package's `compiler/scripts/` is removed, but only when
// nothing in that package's family modules imports it; otherwise it is reported and left in
// place. The template is not pruned: it is the authoring source and legitimately carries files
// the packages do not ship. Pruning never reaches inside a `families/<family>/` folder — a
// mirrored family's extra files are reported, not removed (see above).
//
// Nothing is written until every target has been planned without error, so a failing run leaves
// the tree untouched rather than half-synced.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPageKind, outputScopeOfPageKind, type OutputScope } from '../packages/agency-fast-lane/src/atlas.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalLabel = 'plugins/_official/shared/agency-compiler/scripts';
const canonicalDir = path.join(repoRoot, canonicalLabel);
const examplesDir = path.join(repoRoot, 'plugins/_official/examples');
const templateScripts = path.join(repoRoot, 'design-templates/agency-site/scripts');
/**
 * The family registry: the one source of each family's `pageKind`, and so of its output scope.
 * A packaged compiler runs without node_modules, so the scope is materialised into each copy's
 * generated `families/registry.ts` at sync time, through the fast lane's own
 * `outputScopeOfPageKind`; `--check` fails when a row drifts from the registry.
 */
const familyRegistryPath = path.join(repoRoot, 'packages/agency-fast-lane/src/atlas/family-registry.json');

/** Each registry family's output scope, or an error message when the registry is unusable. */
function registryOutputScopes(): Map<string, OutputScope> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(familyRegistryPath, 'utf8'));
  } catch (error) {
    return `${rel(familyRegistryPath)}: unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
  const families = (parsed as { families?: unknown })?.families;
  if (!Array.isArray(families)) return `${rel(familyRegistryPath)}: expected a families array`;
  const scopes = new Map<string, OutputScope>();
  for (const entry of families as Array<{ family?: unknown; pageKind?: unknown }>) {
    if (typeof entry?.family !== 'string' || !isPageKind(entry.pageKind)) {
      return `${rel(familyRegistryPath)}: family ${String(entry?.family)} has no valid pageKind`;
    }
    scopes.set(entry.family, outputScopeOfPageKind(entry.pageKind));
  }
  return scopes;
}

/** The one file this script generates per copy, rather than copying from a source. */
const REGISTRY = 'families/registry.ts';

/**
 * The template's registry when none of its mirrored families' owning packages is in this
 * checkout. The study families ship in a private pack (see `docs/packs.md`), so the public
 * template dispatches no family at all and its registry is this fixed, empty table.
 */
const EMPTY_TEMPLATE_REGISTRY = [
  '// Generated by scripts/sync-agency-compiler.ts from the family modules in this copy. Do not edit.',
  '// Static trusted dispatch table; see plugins/_official/shared/agency-compiler/README.md.',
  `import type { FamilyModule } from '../family.ts';`,
  '',
  '// The study families (emmpo, watson, maben) are private and ship in a private pack, not in this repository.',
  'export const FAMILIES: Record<string, FamilyModule> = {};',
  '',
].join('\n');

/** A family module the template shares with an example package, and the package that owns it. */
const TEMPLATE_MIRRORS: ReadonlyArray<{ family: string; owner: string }> = [
  { family: 'emmpo', owner: 'agency-emmpo' },
  { family: 'watson', owner: 'agency-watson' },
];

/**
 * A family module is authored only in the package named after it — `agency-<family>` owns
 * `families/<family>/`. Any other package's copy of that family is listed here explicitly, by the
 * carrier's own directory name, and the sync overwrites it from the owner. This is a table, not an
 * inference from directory names, so a package that legitimately grows a second family module of
 * its own is never silently treated as a stale copy and overwritten: `packageMirrors` below checks
 * this table against what is actually on disk before planning a single write, and an
 * undeclared-but-present or declared-but-absent family is an error, not a guess.
 */
const PACKAGE_MIRRORS: Readonly<Record<string, readonly string[]>> = {
  'agency-app-shell': [],
  'agency-community': [],
  'agency-crm-dashboard': [],
  'agency-docs-hub': [],
  'agency-emmpo': ['watson'],
  'agency-fervor': ['emmpo', 'watson', 'wrenfield'],
  'agency-halcyon': ['emmpo', 'watson', 'wrenfield'],
  'agency-listings': [],
  'agency-maben': [],
  'agency-maren': ['emmpo', 'watson', 'wrenfield'],
  'agency-marketing-site': [],
  'agency-nonprofit': [],
  'agency-practice': [],
  'agency-guide': [],
  'agency-publication': [],
  'agency-restaurant': [],
  'agency-storefront': [],
  'agency-watson': ['emmpo'],
  'agency-wrenfield': ['emmpo', 'watson'],
};

type Target = {
  /** Repo-relative label for messages. */
  label: string;
  scriptsDir: string;
  /** Absolute path to the target's COMMIT.json, when it has one. */
  commitPath: string | undefined;
  /** Prefix that turns a scripts-relative path into a COMMIT.json `file` value. */
  commitPrefix: string;
  /** Whether a non-canonical file directly under `scriptsDir` may be removed. */
  prune: boolean;
  /**
   * The families this copy dispatches. `'present'` means every family module on disk, which is
   * what a package wants: it carries exactly the modules it compiles. A copy that ships a
   * declared subset lists it instead.
   */
  roster: 'present' | readonly string[];
  /** Family modules mirrored into this target from their owning example package. */
  mirrors: ReadonlyArray<{ family: string; sourceDir: string }>;
  /** Whether an empty roster is valid (it renders `EMPTY_TEMPLATE_REGISTRY`). */
  allowEmptyRoster?: boolean;
};

type CommitFileEntry = { path: string; file: string; bytes: number; sha256: string };
type CommitManifest = { files?: CommitFileEntry[] };
type Write = { file: string; bytes: Buffer };
export type SyncReport = { files: string[]; targets: string[]; drift: string[]; kept: string[]; errors: string[] };
type Plan = { writes: Write[]; removals: string[]; report: SyncReport };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const rel = (absolute: string): string => path.relative(repoRoot, absolute).split(path.sep).join('/');

/** The canonical shared files: every regular file directly inside the canonical folder. */
function canonicalFiles(): string[] {
  if (!existsSync(canonicalDir)) throw new Error(`Missing canonical folder: ${canonicalLabel}`);
  return readdirSync(canonicalDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

/**
 * One package's mirrors: `PACKAGE_MIRRORS[name]`, cross-checked against the family directories
 * actually on disk under `compiler/scripts/families/`. A directory the table does not list, or a
 * table entry with no matching directory, is reported as an error — before any write — naming
 * `PACKAGE_MIRRORS` so a maintainer who adds a new mirrored copy, or a package's own second
 * family, knows exactly where to update it.
 */
function packageMirrors(name: string, dir: string, ownFamily: string, report: SyncReport): ReadonlyArray<{ family: string; sourceDir: string }> {
  const declared = [...(PACKAGE_MIRRORS[name] ?? [])].sort();
  const familiesDir = path.join(dir, 'compiler/scripts/families');
  const carried = existsSync(familiesDir)
    ? readdirSync(familiesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== ownFamily)
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const family of carried) {
    if (!declared.includes(family)) {
      report.errors.push(`${rel(dir)}: carries families/${family}/ but PACKAGE_MIRRORS['${name}'] (scripts/sync-agency-compiler.ts) does not list it — update the table`);
    }
  }
  for (const family of declared) {
    if (!carried.includes(family)) {
      report.errors.push(`${rel(dir)}: PACKAGE_MIRRORS['${name}'] (scripts/sync-agency-compiler.ts) lists '${family}' but no families/${family}/ directory exists — update the table`);
    }
  }
  return declared.map((family) => ({ family, sourceDir: path.join(examplesDir, `agency-${family}`, 'compiler/scripts/families', family) }));
}

function targets(report: SyncReport): Target[] {
  const packages: Target[] = readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agency-'))
    .map((entry) => path.join(examplesDir, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'compiler/scripts')))
    .sort()
    .map((dir) => {
      const name = path.basename(dir);
      return {
        label: rel(dir),
        scriptsDir: path.join(dir, 'compiler/scripts'),
        commitPath: path.join(dir, 'compiler/COMMIT.json'),
        commitPrefix: 'compiler/scripts/',
        prune: true,
        roster: 'present',
        mirrors: packageMirrors(name, dir, name.slice('agency-'.length), report),
      };
    });
  // A template mirror whose owning package is not in this checkout at all ships in a private
  // pack, not here: the public template then neither mirrors nor dispatches that family. An
  // owning package that IS present still has to supply the family module, so a half-deleted
  // owner remains an error below rather than a silently shrunken roster.
  const shippedMirrors = TEMPLATE_MIRRORS.filter(({ owner }) => existsSync(path.join(examplesDir, owner)));
  const template: Target = {
    label: rel(path.dirname(templateScripts)),
    scriptsDir: templateScripts,
    // The template ships no COMMIT.json: it is the source the packages were cut from, not a
    // packaged closure. Nothing to refresh, so nothing is reported for it.
    commitPath: existsSync(path.join(templateScripts, '..', 'COMMIT.json'))
      ? path.join(templateScripts, '..', 'COMMIT.json')
      : undefined,
    commitPrefix: 'scripts/',
    prune: false,
    // The template dispatches exactly the families its SKILL.md ships, which is the closure the
    // daemon freezes. `families/maben/` also sits on disk here, unwired, as it does on main.
    roster: shippedMirrors.map(({ family }) => family),
    mirrors: shippedMirrors.map(({ family, owner }) => ({
      family,
      sourceDir: path.join(examplesDir, owner, 'compiler/scripts/families', family),
    })),
    allowEmptyRoster: true,
  };
  return [...packages, template];
}

/** The three exports a family module must provide, by convention on its ID. */
function familyExports(family: string): { validate: string; requirements: string; render: string } {
  // A family id may be hyphenated (e.g. `crm-dashboard`, a hyphen is not valid inside a JS
  // identifier), so PascalCase each `-`-separated segment rather than only the first character
  // of the whole id. Every single-word family id (maben, watson, ...) has exactly one segment,
  // so this is unchanged for them.
  const pascal = family.split('-').filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
  return { validate: `validate${pascal}Recipe`, requirements: `get${pascal}AssetRequirements`, render: `render${pascal}` };
}

/**
 * Build `families/registry.ts` for one copy: a static table of the family modules it carries.
 * Returns undefined and records an error when a module does not export the three names the
 * shared `family.ts` dispatches through, so a broken roster is never written.
 */
function renderRegistry(target: Target, report: SyncReport): Buffer | undefined {
  const { scriptsDir, label } = target;
  const familiesDir = path.join(scriptsDir, 'families');
  if (!existsSync(familiesDir)) {
    report.errors.push(`${label}: no scripts/families directory`);
    return undefined;
  }
  const present = readdirSync(familiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(familiesDir, entry.name, 'render.ts')))
    .map((entry) => entry.name)
    .sort();
  const roster = target.roster === 'present' ? present : [...target.roster].sort();
  const absent = roster.filter((family) => !present.includes(family));
  if (absent.length > 0) {
    report.errors.push(`${label}: declared families with no module: ${absent.join(', ')}`);
    return undefined;
  }
  if (roster.length === 0) {
    if (target.allowEmptyRoster) return Buffer.from(EMPTY_TEMPLATE_REGISTRY, 'utf8');
    report.errors.push(`${label}: no family module under scripts/families`);
    return undefined;
  }
  const scopes = registryOutputScopes();
  if (typeof scopes === 'string') {
    report.errors.push(`${label}: ${scopes}`);
    return undefined;
  }
  const imports: string[] = [];
  const rows: string[] = [];
  for (const family of roster) {
    const outputScope = scopes.get(family);
    if (!outputScope) {
      report.errors.push(`${label}: families/${family} is not in ${rel(familyRegistryPath)}, so it has no pageKind and no output scope`);
      continue;
    }
    const names = familyExports(family);
    const source = readFileSync(path.join(familiesDir, family, 'render.ts'), 'utf8');
    const missing = Object.values(names).filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
    if (missing.length > 0) {
      report.errors.push(`${label}: families/${family}/render.ts does not export ${missing.join(', ')}`);
      continue;
    }
    imports.push(`import { ${names.validate}, ${names.requirements}, ${names.render} } from './${family}/render.ts';`);
    // Quoted key: a hyphenated family id (e.g. `crm-dashboard`) is not a valid bare object-key
    // token — `crm-dashboard: x` parses as the expression `crm - dashboard: x`. Every existing
    // family id is a single word, so quoting is a no-op for them.
    rows.push(`  '${family}': { validate: ${names.validate}, requirements: ${names.requirements}, render: ${names.render}, outputScope: '${outputScope}' },`);
  }
  if (rows.length === 0) return undefined;
  const text = [
    // Two lines only: this file ships in every frozen compiler package, which has a hard byte cap
    // (see the shared compiler README, "Frozen package budget"). The rationale lives there.
    '// Generated by scripts/sync-agency-compiler.ts from the family modules in this copy. Do not edit.',
    '// Static trusted dispatch table; see plugins/_official/shared/agency-compiler/README.md.',
    `import type { FamilyModule } from '../family.ts';`,
    ...imports,
    '',
    'export const FAMILIES: Record<string, FamilyModule> = {',
    ...rows,
    '};',
    '',
  ].join('\n');
  return Buffer.from(text, 'utf8');
}

/**
 * The basenames every family module in a target imports, so a shared file that is still in use is
 * never deleted out from under one.
 */
function familyModuleImports(scriptsDir: string): Set<string> {
  const root = path.join(scriptsDir, 'families');
  const specifiers = new Set<string>();
  if (!existsSync(root)) return specifiers;
  for (const file of filesUnder(root)) {
    if (!/\.(ts|mts|js|mjs)$/.test(file)) continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
      specifiers.add(path.basename(match[1] ?? match[2] ?? ''));
    }
  }
  return specifiers;
}

/** Plan one target: decide every write and removal, and collect anything that blocks the run. */
function planTarget(target: Target, files: string[], plan: Plan): void {
  const { report } = plan;
  // scripts-relative path -> the bytes it must hold.
  const expected = new Map<string, Buffer>();
  for (const name of files) expected.set(name, readFileSync(path.join(canonicalDir, name)));
  for (const mirror of target.mirrors) {
    if (!existsSync(mirror.sourceDir)) {
      report.errors.push(`${rel(mirror.sourceDir)}: missing mirror source for ${target.label} families/${mirror.family}`);
      continue;
    }
    const ownerFiles = filesUnder(mirror.sourceDir);
    for (const file of ownerFiles) {
      expected.set(`families/${mirror.family}/${file}`, readFileSync(path.join(mirror.sourceDir, file)));
    }
    // A file the carrier's copy holds that the owner does not ship is reported, never deleted —
    // the mirror is additive, not a mirror-and-prune.
    const carrierFamilyDir = path.join(target.scriptsDir, 'families', mirror.family);
    if (existsSync(carrierFamilyDir)) {
      const ownerFileSet = new Set(ownerFiles);
      for (const file of filesUnder(carrierFamilyDir)) {
        if (!ownerFileSet.has(file)) {
          report.kept.push(`${rel(path.join(carrierFamilyDir, file))}: not shipped by ${rel(mirror.sourceDir)}, left in place`);
        }
      }
    }
  }

  const registry = renderRegistry(target, report);
  if (registry) expected.set(REGISTRY, registry);

  for (const [name, bytes] of expected) {
    const absolute = path.join(target.scriptsDir, name);
    const current = existsSync(absolute) ? readFileSync(absolute) : undefined;
    if (current?.equals(bytes)) continue;
    const source = name === REGISTRY ? 'the family modules in this copy'
      : name.startsWith('families/') ? 'its owning example package'
      : `${canonicalLabel}/${name}`;
    report.drift.push(`${rel(absolute)}: ${current ? 'differs from' : 'missing, expected from'} ${source}`);
    plan.writes.push({ file: absolute, bytes });
  }

  const imports = familyModuleImports(target.scriptsDir);
  for (const entry of readdirSync(target.scriptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || expected.has(entry.name)) continue;
    const absolute = path.join(target.scriptsDir, entry.name);
    if (!target.prune || imports.has(entry.name)) {
      report.kept.push(`${rel(absolute)}: not in ${canonicalLabel}, left in place`);
      continue;
    }
    report.drift.push(`${rel(absolute)}: not in ${canonicalLabel} and unused by this target's family modules — remove`);
    plan.removals.push(absolute);
  }

  planCommitJson(target, files, expected, plan);
}

/** Refresh `bytes`/`sha256` for the entries of files this script writes, and nothing else. */
function planCommitJson(target: Target, files: string[], expected: Map<string, Buffer>, plan: Plan): void {
  const { report } = plan;
  if (!target.commitPath) return;
  if (!existsSync(target.commitPath)) {
    report.errors.push(`${rel(target.commitPath)}: missing`);
    return;
  }
  const text = readFileSync(target.commitPath, 'utf8');
  let manifest: CommitManifest;
  try {
    manifest = JSON.parse(text) as CommitManifest;
  } catch (error) {
    report.errors.push(`${rel(target.commitPath)}: unreadable JSON (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  const byFile = new Map((manifest.files ?? []).map((entry) => [entry.file, entry]));
  for (const [name, bytes] of expected) {
    const entry = byFile.get(`${target.commitPrefix}${name}`);
    // A shared file must be recorded; a mirrored family file is recorded only if this target's
    // curated closure happens to list it.
    if (!entry) {
      if (files.includes(name)) report.errors.push(`${rel(target.commitPath)}: no entry for ${target.commitPrefix}${name}`);
      continue;
    }
    const digest = sha256(bytes);
    if (entry.bytes === bytes.length && entry.sha256 === digest) continue;
    report.drift.push(`${rel(target.commitPath)}: stale hash for ${target.commitPrefix}${name}`);
    entry.bytes = bytes.length;
    entry.sha256 = digest;
  }
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next !== text) plan.writes.push({ file: target.commitPath, bytes: Buffer.from(next, 'utf8') });
}

export function syncAgencyCompiler({ check = false }: { check?: boolean } = {}): SyncReport {
  const files = canonicalFiles();
  const report: SyncReport = { files, targets: [], drift: [], kept: [], errors: [] };
  const list = targets(report);
  report.targets = list.map((t) => t.label);
  const plan: Plan = { writes: [], removals: [], report };
  for (const target of list) planTarget(target, files, plan);
  // Every target planned cleanly, or nothing is written at all.
  if (check || plan.report.errors.length > 0) return plan.report;
  for (const write of plan.writes) {
    mkdirSync(path.dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.bytes);
  }
  for (const removal of plan.removals) rmSync(removal);
  return plan.report;
}

function main(): void {
  const check = process.argv.includes('--check');
  let report: SyncReport;
  try {
    report = syncAgencyCompiler({ check });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  for (const line of report.kept) console.warn(`kept    ${line}`);
  for (const line of report.errors) console.error(`error   ${line}`);
  for (const line of report.drift) console.error(`${check || report.errors.length > 0 ? 'drift' : 'synced'}  ${line}`);
  const scale = `${report.files.length} shared files x ${report.targets.length} copies`;
  if (report.errors.length > 0) {
    console.error(`sync-agency-compiler: ${report.errors.length} error(s), nothing written; ${scale}`);
    process.exitCode = 1;
    return;
  }
  if (!check) {
    console.log(`sync-agency-compiler: ${report.drift.length === 0 ? 'already in sync' : `updated ${report.drift.length} path(s)`} (${scale}).`);
    return;
  }
  if (report.drift.length > 0) {
    console.error(`sync-agency-compiler: ${report.drift.length} drifted path(s). Run \`node --experimental-strip-types scripts/sync-agency-compiler.ts\` and commit the result.`);
    process.exitCode = 1;
    return;
  }
  console.log(`sync-agency-compiler: in sync (${scale}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
