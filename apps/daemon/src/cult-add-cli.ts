// `od cult add <slug...> --into <projectDir> [--dry-run] [--force] [--install] [--json]` — remix a
// licensed Cult UI Pro item into one of the owner's own projects (CONTEXT.md "Remix into project").
// An item is named by its public slug (`pricing-series-v`, or `cult:<slug>`); an old internal name
// still resolves on the daemon, and everything printed uses the slug.
//
// It reads the same loopback endpoint `npx shadcn@latest add` reads (`GET /api/cult/r/<slug>.json`,
// apps/daemon/src/routes/cult-registry.ts) and follows registry dependencies that point back at it.
// Every file is written to its registry `target`, re-rooted on the project's components.json
// aliases when there is one (components, ui, lib, hooks; `app/` and other targets under `src/`
// when the project uses it), with `@/…` imports rewritten to those aliases.
//
// Every vendor `app/**` file lands under `app/(cult)/<slug>/…` (root-level Markdown under
// `docs/cult/<slug>/`), so an item never takes the project's own app files, and each item's moved
// files import that item's own siblings. `--force` replaces only files inside the item's own
// folder; a differing file of yours anywhere else (`components/…`, `lib/utils.ts`) always stops
// the copy.
//
// Nothing is written when any destination holds different content, unless `--force` may replace
// it, or when a directory is in the way; identical files are left alone. Writes are staged and all-or-nothing.
// npm packages are listed, and installed only with `--install`, through the package manager of
// the nearest directory (from the project up) that declares one. Other registry dependencies
// (`button`, `card`, …) are printed as one `npx shadcn@latest add` line, never fetched from
// anywhere else. `od cult show` (below) prints one file, as the web "Copy code" button copies it.
//
// Kept in its own module (not inline in cli.ts) so it stays unit-testable without triggering
// cli.ts's import-time SUBCOMMAND_MAP dispatch — mirrors agency-config-cli.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CultRegistryFile, CultRegistryItem } from '@mish/contracts';
import { cultRegistryName, parseCultCopyResponse, parseCultRegistryItem } from '@mish/contracts';

import { DEFAULT_ALIASES, rewriteImports, type ProjectAliases } from './cult-registry.js';

export { rewriteImports };

export type CultAddCliResult =
  | { kind: 'help'; code: number }
  | { kind: 'usage'; stderr: string[] }
  | { kind: 'http-failure'; response: Response }
  /** Print `stdout` verbatim, each `stderr` line to stderr, and exit with `code`. */
  | { kind: 'done'; code: number; stdout: string; stderr: string[] };

export interface CultAddCliOptions {
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Runs the install command in `cwd`; returns its exit code. Injected so tests never install. */
  runInstall?: (command: string, args: string[], cwd: string, json: boolean) => number;
  cwd?: string;
}

export const CULT_SHOW_USAGE = 'Usage: od cult show <slug> [--file <target|path>] [--json]';
export const CULT_ADD_USAGE = 'Usage: od cult add <slug...> --into <projectDir> [--dry-run] [--force] [--install] [--json]';

interface AddFlags {
  ids: string[];
  into?: string;
  dryRun: boolean;
  force: boolean;
  install: boolean;
  json: boolean;
  daemonUrl?: string;
}

function parseAddFlags(args: string[]): AddFlags | { error: string[] } {
  const flags: AddFlags = { ids: [], dryRun: false, force: false, install: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      const next = inline ?? args[i + 1];
      if (inline === undefined) i += 1;
      return next;
    };
    if (name === '--dry-run') flags.dryRun = true;
    else if (name === '--force') flags.force = true;
    else if (name === '--install') flags.install = true;
    else if (name === '--json') flags.json = true;
    else if (name === '--into' || name === '--daemon-url') {
      const v = value();
      if (typeof v !== 'string' || v.length === 0) return { error: [`${name} needs a value`, CULT_ADD_USAGE] };
      if (name === '--into') flags.into = v;
      else flags.daemonUrl = v;
    } else if (arg.startsWith('-')) return { error: [`unknown flag: ${arg}`, CULT_ADD_USAGE] };
    else flags.ids.push(arg);
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Project layout
// ---------------------------------------------------------------------------------------------

export interface ProjectLayout {
  root: string;
  hasComponentsJson: boolean;
  aliases: ProjectAliases;
  /** Project-relative directory each alias names, e.g. `src/components`. */
  dirs: Record<'components' | 'ui' | 'lib' | 'hooks', string>;
  /** `src` when the project keeps its app under `src/`, else ''. */
  srcBase: string;
}

function readJson(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const asObject = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    // tsconfig.json may carry comments and trailing commas.
    try {
      return asObject(JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')));
    } catch {
      return null;
    }
  }
}

function isDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function readProjectLayout(root: string): ProjectLayout {
  const componentsJson = readJson(path.join(root, 'components.json'));
  const raw = (componentsJson?.aliases ?? {}) as Record<string, unknown>;
  const aliases = { ...DEFAULT_ALIASES };
  for (const key of Object.keys(aliases) as Array<keyof ProjectAliases>) {
    if (typeof raw[key] === 'string' && raw[key]) aliases[key] = (raw[key] as string).replace(/\/+$/, '');
  }
  if (typeof raw.components === 'string' && typeof raw.ui !== 'string') aliases.ui = `${aliases.components}/ui`;
  const srcBase = isDir(path.join(root, 'src')) && !isDir(path.join(root, 'app')) ? 'src' : '';
  const tsPaths = ((readJson(path.join(root, 'tsconfig.json'))?.compilerOptions ?? {}) as Record<string, unknown>).paths as
    | Record<string, string[]>
    | undefined;
  const aliasDir = (alias: string): string => {
    for (const [pattern, targets] of Object.entries(tsPaths ?? {})) {
      const prefix = pattern.replace(/\*$/, '');
      if (!pattern.endsWith('*') || !alias.startsWith(prefix) || !Array.isArray(targets) || typeof targets[0] !== 'string') continue;
      return path.posix.normalize(path.posix.join(targets[0].replace(/\*$/, ''), alias.slice(prefix.length))).replace(/^\.\//, '');
    }
    const rest = alias.replace(/^[@~]\//, '');
    return srcBase ? `${srcBase}/${rest}` : rest;
  };
  return {
    root,
    hasComponentsJson: componentsJson !== null,
    aliases,
    dirs: { components: aliasDir(aliases.components), ui: aliasDir(aliases.ui), lib: aliasDir(aliases.lib), hooks: aliasDir(aliases.hooks) },
    srcBase,
  };
}

/** A registry file's project-relative destination; throws on a target that leaves the project. */
export function resolveTargetPath(file: Pick<CultRegistryFile, 'path' | 'type' | 'target'>, layout: ProjectLayout): string {
  const target = (file.target || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let out: string;
  if (!target) {
    // shadcn's default placement for a file without a target: the type's alias folder, keeping
    // the file's path below the registry folder of the same name (`registry/ui/forms/x.tsx` →
    // `<ui>/forms/x.tsx`), or just its name when there is no such folder.
    const kind = file.type === 'registry:ui' ? 'ui'
      : file.type === 'registry:lib' ? 'lib'
        : file.type === 'registry:hook' ? 'hooks'
          : 'components';
    const segments = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const at = segments.lastIndexOf(kind);
    const nested = at >= 0 && at < segments.length - 1 ? segments.slice(at + 1).join('/') : path.posix.basename(file.path);
    out = `${layout.dirs[kind]}/${nested}`;
  } else if (target.startsWith('~/')) out = target.slice(2);
  else {
    const [head, ...rest] = target.split('/');
    const tail = rest.join('/');
    if (head === 'components' && rest[0] === 'ui') out = `${layout.dirs.ui}/${rest.slice(1).join('/')}`;
    else if (head === 'components' && tail) out = `${layout.dirs.components}/${tail}`;
    else if (head === 'lib' && tail) out = `${layout.dirs.lib}/${tail}`;
    else if (head === 'hooks' && tail) out = `${layout.dirs.hooks}/${tail}`;
    // Documentation stays at the project root, never under src/.
    else if (head === 'docs' && tail) out = target;
    else out = layout.srcBase ? `${layout.srcBase}/${target}` : target;
  }
  const normalized = path.posix.normalize(out);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new Error(`unsafe target ${JSON.stringify(file.target)} for ${file.path}`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9^~<>=.*|+ -]+)?$/;

function packageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** The package manager one directory declares: its `packageManager` field, else its lockfile. */
function declaredPackageManager(dir: string): PackageManager | null {
  const declared = readJson(path.join(dir, 'package.json'))?.packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  if (existsSync(path.join(dir, 'pnpm-lock.yaml')) || existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'bun.lock')) || existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

/** A workspace or repository root: the walk for a package manager stops here. */
function isWorkspaceOrRepoRoot(dir: string): boolean {
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) || existsSync(path.join(dir, '.git'))) return true;
  return readJson(path.join(dir, 'package.json'))?.workspaces !== undefined;
}

/**
 * The package manager of the nearest directory, from `root` up, that declares one — so a
 * workspace package without its own lockfile installs with its workspace's manager. The walk
 * stops at the nearest workspace or git root, and never reaches `home` (a stray lockfile or
 * `packageManager` field in the home directory decides nothing). npm when nothing declares one.
 */
export function detectPackageManager(root: string, home: string = homedir()): PackageManager {
  const stopAt = path.resolve(home);
  for (let dir = path.resolve(root); dir !== stopAt; dir = path.dirname(dir)) {
    const found = declaredPackageManager(dir);
    if (found) return found;
    if (isWorkspaceOrRepoRoot(dir) || path.dirname(dir) === dir) break;
  }
  return 'npm';
}

function installedPackages(root: string): Set<string> {
  const pkg = readJson(path.join(root, 'package.json')) ?? {};
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function defaultRunInstall(command: string, args: string[], cwd: string, json: boolean): number {
  // With --json, stdout carries only the summary; the package manager's output goes to stderr.
  const result = spawnSync(command, args, { cwd, stdio: json ? ['ignore', 2, 2] : 'inherit' });
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------------------------
// Pages, existing files and staged writes
// ---------------------------------------------------------------------------------------------

function normalizeRegistryTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^~\//, '');
}

/**
 * Where a vendor file lands so an item never takes a path in the project's own namespace
 * (null: its own target, or shadcn's default placement when it has none):
 * every `app/**` target goes under `app/(cult)/<item>/…` (a page becomes the route `/<item>/…`),
 * a root-level Markdown file under `docs/cult/<item>/`, and any other root-level file under
 * `app/(cult)/<item>/`. Component, lib and hook targets → null (they keep their alias folders).
 */
export function rerootVendorTarget(target: string | undefined, itemName: string): string | null {
  const normalized = normalizeRegistryTarget(target ?? '');
  // No target: shadcn's default ui/lib/hooks/components placement applies (resolveTargetPath).
  if (normalized === '') return null;
  if (normalized.startsWith('app/')) return `app/(cult)/${itemName}/${normalized.slice('app/'.length)}`;
  if (!normalized.includes('/')) {
    return /\.mdx?$/i.test(normalized) ? `docs/cult/${itemName}/${normalized}` : `app/(cult)/${itemName}/${normalized}`;
  }
  return null;
}

/** True when `target` (registry-relative, after re-rooting) is inside the item's own folder. */
export function isInItemFolder(target: string, itemName: string): boolean {
  return target.startsWith(`app/(cult)/${itemName}/`) || target.startsWith(`docs/cult/${itemName}/`)
    || target.split('/').slice(0, -1).includes(itemName);
}

const RELATIVE_SPEC = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"]))(\.\.?\/[^'"]*)\2/g;
const SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];

const ALIAS_SPEC = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"]))@\/([^'"]+)\2/g;

function aliasOf(target: string): string {
  return `@/${target.replace(/\.(?:tsx?|jsx?)$/, '').replace(/\/index$/, '')}`;
}

/**
 * Keeps an item's imports pointing at the item's own files after re-rooting. `moved` maps this
 * item's original targets to their new ones; `installed` is every original target being copied.
 * - A relative import that resolved (from the file's original target) to a moved file of this
 *   item, or — for a file that moved — to any installed file, becomes the `@/` path of where that
 *   file lands now. So two items that both ship `app/demo.tsx` each import their own demo.
 * - An `@/app/…` style import naming a moved file of this item follows it the same way.
 * Everything else is left as it is.
 */
export function relocateImports(
  content: string,
  originalTarget: string,
  moved: ReadonlyMap<string, string>,
  installed: ReadonlySet<string>,
): string {
  const original = normalizeRegistryTarget(originalTarget);
  const selfMoved = moved.has(original);
  const landing = (base: string): string | undefined => {
    for (const suffix of SUFFIXES) {
      const candidate = base + suffix;
      const to = moved.get(candidate);
      if (to !== undefined) return to;
      if (selfMoved && installed.has(candidate)) return candidate;
    }
    return undefined;
  };
  const from = path.posix.dirname(original);
  const relative = content.replace(RELATIVE_SPEC, (match, lead: string, quote: string, spec: string) => {
    const to = landing(path.posix.normalize(path.posix.join(from, spec)));
    return to === undefined ? match : `${lead}${aliasOf(to)}${quote}`;
  });
  return relative.replace(ALIAS_SPEC, (match, lead: string, quote: string, spec: string) => {
    for (const suffix of SUFFIXES) {
      const to = moved.get(spec + suffix);
      if (to !== undefined) return `${lead}${aliasOf(to)}${quote}`;
    }
    return match;
  });
}

type Existing = { kind: 'none' } | { kind: 'file'; content: string } | { kind: 'blocked' };

function readExisting(root: string, target: string): Existing {
  const dest = path.join(root, target);
  let stat;
  try {
    stat = statSync(dest);
  } catch {
    // A parent that is a file (ENOTDIR) blocks the write as surely as a directory does.
    return ancestorIsFile(root, target) ? { kind: 'blocked' } : { kind: 'none' };
  }
  if (!stat.isFile()) return { kind: 'blocked' };
  try {
    return { kind: 'file', content: readFileSync(dest, 'utf8') };
  } catch {
    return { kind: 'blocked' };
  }
}

function ancestorIsFile(root: string, target: string): boolean {
  const parts = target.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i += 1) {
    try {
      if (statSync(path.join(root, ...parts.slice(0, i))).isFile()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Writes every file or none. Each file is first written to a temp sibling; only when all temps
 * exist are they renamed into place, remembering what each replaced. Any I/O error removes the
 * temps and the directories this created, restores the replaced files, and returns a message.
 */
export function writeStaged(root: string, files: ReadonlyArray<{ target: string; content: string }>): string | null {
  const createdDirs: string[] = [];
  const temps: Array<{ temp: string; dest: string; target: string }> = [];
  const placed: Array<{ dest: string; previous: Buffer | null }> = [];
  const suffix = `.cult-add-${process.pid}-${Date.now()}.tmp`;
  const undo = () => {
    for (const { dest, previous } of placed.reverse()) {
      try {
        if (previous === null) rmSync(dest, { force: true });
        else writeFileSync(dest, previous);
      } catch { /* best effort: reported below */ }
    }
    for (const { temp } of temps) rmSync(temp, { force: true });
    for (const dir of createdDirs.reverse()) {
      try {
        rmdirSync(dir);
      } catch { /* not empty or already gone */ }
    }
  };
  let current = '';
  try {
    for (const file of files) {
      current = file.target;
      const dest = path.join(root, file.target);
      const missing: string[] = [];
      for (let dir = path.dirname(dest); !existsSync(dir); dir = path.dirname(dir)) missing.unshift(dir);
      mkdirSync(path.dirname(dest), { recursive: true });
      createdDirs.push(...missing);
      const temp = `${dest}${suffix}`;
      writeFileSync(temp, file.content, { flag: 'wx' });
      temps.push({ temp, dest, target: file.target });
    }
    for (const { temp, dest, target } of temps) {
      current = target;
      const previous = existsSync(dest) ? readFileSync(dest) : null;
      renameSync(temp, dest);
      placed.push({ dest, previous });
    }
    return null;
  } catch (err) {
    undo();
    const code = (err as NodeJS.ErrnoException).code;
    return `could not write ${current}${code ? ` (${code})` : ''}: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

type FileAction = 'create' | 'unchanged' | 'overwrite' | 'conflict' | 'protected' | 'blocked' | 'duplicate';

export interface CultAddSummary {
  projectDir: string;
  componentsJson: boolean;
  dryRun: boolean;
  force: boolean;
  written: boolean;
  items: Array<{ id: string; name: string; registryUrl: string; requestedBy: string | null }>;
  files: Array<{ item: string; source: string; target: string; action: FileAction }>;
  conflicts: string[];
  /** Your own differing files outside the item's folder: `--force` never replaces them. */
  protected: string[];
  /** Destinations `--force` cannot replace (a directory is in the way). */
  blocked: string[];
  dependencies: string[];
  missingDependencies: string[];
  baseComponents: string[];
  packageManager: string;
  installCommand: string | null;
  installed: boolean | null;
  warnings: string[];
  /**
   * A note per earlier copy found at an item's old (pre-rename) folder, still present in the
   * project. Detection only: that path is never read for content, written to, overwritten or
   * deleted, and its presence never changes `files`, an exit code, or any other file action.
   */
  earlierCopies: string[];
}

/** `/api/cult/r/<name>.json` on any host → `<name>`; anything else → null. */
function cultDependencyName(ref: string): string | null {
  try {
    const match = /^\/api\/cult\/r\/([^/]+)\.json$/.exec(new URL(ref).pathname);
    return match ? cultRegistryName(match[1]!) : null;
  } catch {
    return null;
  }
}

export async function runCultAddCli(args: string[], options: CultAddCliOptions): Promise<CultAddCliResult> {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help', code: 0 };
  const flags = parseAddFlags(args);
  if ('error' in flags) return { kind: 'usage', stderr: flags.error };
  if (flags.ids.length === 0 || !flags.into) return { kind: 'usage', stderr: [CULT_ADD_USAGE] };
  const names: string[] = [];
  for (const id of flags.ids) {
    const name = cultRegistryName(id);
    if (name === null) return { kind: 'usage', stderr: [`not a catalog id: ${id}`] };
    if (!names.includes(name)) names.push(name);
  }
  const root = path.resolve(options.cwd ?? process.cwd(), flags.into);
  if (!isDir(root)) return { kind: 'usage', stderr: [`--into ${flags.into}: not a directory`] };

  const doFetch = options.fetchImpl ?? fetch;
  const base = (await options.resolveBaseUrl(flags.daemonUrl)).replace(/\/+$/, '');

  // Breadth-first over the requested items and the catalogued items they depend on.
  const items: Array<{ item: CultRegistryItem; requestedBy: string | null }> = [];
  const baseComponents = new Set<string>();
  const queue: Array<{ name: string; requestedBy: string | null }> = names.map((name) => ({ name, requestedBy: null }));
  const seen = new Set(names);
  while (queue.length > 0) {
    const next = queue.shift()!;
    const response = await doFetch(`${base}/api/cult/r/${next.name}.json`);
    if (!response.ok) return { kind: 'http-failure', response };
    let item: CultRegistryItem;
    try {
      item = parseCultRegistryItem(await response.json());
    } catch (err) {
      return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] malformed registry item "${next.name}": ${(err as Error).message}`] };
    }
    items.push({ item, requestedBy: next.requestedBy });
    for (const ref of item.registryDependencies) {
      const dep = cultDependencyName(ref);
      if (dep === null) {
        baseComponents.add(ref);
        continue;
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push({ name: dep, requestedBy: item.name });
    }
  }

  const layout = readProjectLayout(root);
  const warnings: string[] = [];
  const files: CultAddSummary['files'] = [];
  const writes = new Map<string, string>();
  const earlierCopies: string[] = [];
  const seenEarlierCopies = new Set<string>();
  const installedTargets = new Set(items.flatMap(({ item }) => item.files.map((file) => normalizeRegistryTarget(file.target))));
  for (const { item } of items) {
    const moved = new Map<string, string>();
    for (const file of item.files) {
      const to = rerootVendorTarget(file.target, item.name);
      if (to !== null) moved.set(normalizeRegistryTarget(file.target), to);
    }
    for (const file of item.files) {
      const original = normalizeRegistryTarget(file.target);
      const placed = moved.get(original) ?? original;
      let target: string;
      try {
        target = resolveTargetPath({ ...file, target: placed }, layout);
      } catch (err) {
        return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] ${item.name}: ${(err as Error).message}`] };
      }
      // Detection only: an earlier install may still sit at the item's old (pre-rename) folder
      // name (`folderAliases`, set by the daemon only for a brand-free old name). Report it; never
      // read, write, overwrite or delete it, and never let its presence change a file action.
      for (const [newDir, oldDir] of Object.entries(item.folderAliases ?? {})) {
        const prefix = `${newDir}/`;
        if (!placed.startsWith(prefix)) continue;
        const earlierPlaced = `${oldDir}${placed.slice(newDir.length)}`;
        let earlierTarget: string;
        try {
          earlierTarget = resolveTargetPath({ ...file, target: earlierPlaced }, layout);
        } catch {
          continue;
        }
        const earlierFolder = path.posix.dirname(earlierTarget);
        const key = `${item.name}:${earlierFolder}`;
        if (seenEarlierCopies.has(key) || !isDir(path.join(root, earlierFolder))) continue;
        seenEarlierCopies.add(key);
        earlierCopies.push(`an earlier copy of ${item.name} is at ${earlierFolder}/ (its old folder name); it was left as it is.`);
      }
      const content = rewriteImports(relocateImports(file.content, original, moved, installedTargets), layout.aliases);
      if (moved.has(original) && /(^|\/)layout\.[jt]sx?$/.test(placed) && /<html[\s>]/.test(file.content)) {
        warnings.push(`${target}: this is the item's own root layout, now nested under your app; move what it adds (fonts, providers) into your layout and drop its <html>/<body>`);
      }
      if (writes.has(target)) {
        // The same file reached twice (an item and a dependency both ship it) is copied once.
        // Two different files for one destination are never resolved by dropping one.
        if (writes.get(target) !== content) {
          return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] two different files would be written to ${target} (the second from ${item.name}: ${file.path}); nothing was written`] };
        }
        files.push({ item: item.name, source: file.path, target, action: 'duplicate' });
        continue;
      }
      writes.set(target, content);
      const existing = readExisting(root, target);
      const action: FileAction = existing.kind === 'blocked' ? 'blocked'
        : existing.kind === 'none' ? 'create'
          : existing.content === content ? 'unchanged'
            : !isInItemFolder(placed, item.name) ? 'protected'
              : flags.force ? 'overwrite' : 'conflict';
      files.push({ item: item.name, source: file.path, target, action });
    }
  }

  const dependencies = [...new Set(items.flatMap(({ item }) => item.dependencies))].sort();
  const invalid = dependencies.filter((dep) => !NPM_SPEC.test(dep));
  if (invalid.length > 0) return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] refusing unexpected package names: ${invalid.join(', ')}`] };
  const installed = installedPackages(root);
  const missingDependencies = dependencies.filter((dep) => !installed.has(packageName(dep)));
  const packageManager = detectPackageManager(root);
  const installArgs = missingDependencies.length > 0 ? [packageManager === 'npm' ? 'install' : 'add', ...missingDependencies] : null;
  const conflicts = files.filter((file) => file.action === 'conflict').map((file) => file.target);
  const blocked = files.filter((file) => file.action === 'blocked').map((file) => file.target);
  const kept = files.filter((file) => file.action === 'protected').map((file) => file.target);

  const summary: CultAddSummary = {
    projectDir: root,
    componentsJson: layout.hasComponentsJson,
    dryRun: flags.dryRun,
    force: flags.force,
    written: false,
    items: items.map(({ item, requestedBy }) => ({ id: `cult:${item.name}`, name: item.name, registryUrl: `${base}/api/cult/r/${item.name}.json`, requestedBy })),
    files,
    conflicts,
    protected: kept,
    blocked,
    dependencies,
    missingDependencies,
    baseComponents: [...baseComponents].sort(),
    packageManager,
    installCommand: installArgs ? [packageManager, ...installArgs].join(' ') : null,
    installed: null,
    warnings,
    earlierCopies,
  };

  const stderr: string[] = [];
  let code = 0;
  if (blocked.length > 0) {
    code = 1;
    stderr.push(`[cult] ${blocked.length} destination(s) are directories or unreadable; nothing was written:`);
    for (const target of blocked) stderr.push(`  ${target}`);
  } else if (kept.length > 0) {
    code = 1;
    stderr.push(`[cult] ${kept.length} of your own file(s) outside the item's folder differ; nothing was written, and --force never replaces them. Move or rename them first:`);
    for (const target of kept) stderr.push(`  ${target}`);
  } else if (conflicts.length > 0) {
    code = 1;
    stderr.push(`[cult] ${conflicts.length} file(s) already exist with different content; nothing was written. Re-run with --force to overwrite:`);
    for (const target of conflicts) stderr.push(`  ${target}`);
  } else if (!flags.dryRun) {
    const staged = files
      .filter((file) => file.action === 'create' || file.action === 'overwrite')
      .map((file) => ({ target: file.target, content: writes.get(file.target)! }));
    const failure = writeStaged(root, staged);
    if (failure !== null) {
      stderr.push(`[cult] ${failure}; every file was put back as it was, and nothing was written`);
      for (const warning of warnings) stderr.push(`[cult] warning: ${warning}`);
      for (const note of earlierCopies) stderr.push(`[cult] note: ${note}`);
      return { kind: 'done', code: 1, stdout: flags.json ? `${JSON.stringify(summary, null, 2)}\n` : renderSummary(summary, flags.install), stderr };
    }
    summary.written = true;
    if (flags.install && installArgs) {
      const exit = (options.runInstall ?? defaultRunInstall)(packageManager, installArgs, root, flags.json);
      summary.installed = exit === 0;
      if (exit !== 0) {
        code = 1;
        stderr.push(`[cult] ${summary.installCommand} exited with ${exit}`);
      }
    }
  }
  for (const warning of warnings) stderr.push(`[cult] warning: ${warning}`);
  for (const note of earlierCopies) stderr.push(`[cult] note: ${note}`);
  return { kind: 'done', code, stdout: flags.json ? `${JSON.stringify(summary, null, 2)}\n` : renderSummary(summary, flags.install), stderr };
}

const ACTION_LABEL: Record<FileAction, string> = {
  create: 'create',
  unchanged: 'same',
  overwrite: 'overwrite',
  conflict: 'CONFLICT',
  protected: 'KEPT',
  blocked: 'BLOCKED',
  duplicate: 'skip',
};

function renderSummary(summary: CultAddSummary, installRequested: boolean): string {
  const lines: string[] = [];
  const verb = summary.dryRun ? 'Would copy' : summary.written ? 'Copied' : 'Did not copy';
  lines.push(`${verb} ${summary.items.map((item) => item.id).join(', ')} into ${summary.projectDir}${summary.componentsJson ? ' (components.json aliases)' : ''}`);
  for (const file of summary.files) lines.push(`${ACTION_LABEL[file.action]}\t${file.target}\t(${file.item})`);
  if (summary.missingDependencies.length > 0) {
    lines.push(`Packages to install: ${summary.missingDependencies.join(' ')}`);
    if (summary.installed === true) lines.push(`Installed with: ${summary.installCommand}`);
    else if (!installRequested || summary.dryRun) lines.push(`Install with: ${summary.installCommand}   (or re-run with --install)`);
  } else if (summary.dependencies.length > 0) lines.push('Packages: all already in package.json');
  if (summary.baseComponents.length > 0) {
    lines.push(`Base components it also uses: npx shadcn@latest add ${summary.baseComponents.join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `od cult show <id> [--file <target|path>] [--json]` — the CLI half of the web "Copy code" button:
 * prints one file of the item (the main file by default) exactly as the button copies it, with
 * `@/…` imports on the default aliases. Reads `GET /api/cult/copy/:id[?file=]`, the button's own
 * endpoint. `--json` prints the whole response (install URL, packages, file list).
 */
export async function runCultShowCli(args: string[], options: Pick<CultAddCliOptions, 'resolveBaseUrl' | 'fetchImpl'>): Promise<CultAddCliResult> {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help', code: 0 };
  let json = false;
  let file: string | undefined;
  let daemonUrl: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === '--json') json = true;
    else if (name === '--file' || name === '--daemon-url') {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (!value) return { kind: 'usage', stderr: [`${name} needs a value`, CULT_SHOW_USAGE] };
      if (name === '--file') file = value;
      else daemonUrl = value;
    } else if (arg.startsWith('-')) return { kind: 'usage', stderr: [`unknown flag: ${arg}`, CULT_SHOW_USAGE] };
    else ids.push(arg);
  }
  if (ids.length !== 1) return { kind: 'usage', stderr: [CULT_SHOW_USAGE] };
  const name = cultRegistryName(ids[0]!);
  if (name === null) return { kind: 'usage', stderr: [`not a catalog id: ${ids[0]}`] };
  const base = (await options.resolveBaseUrl(daemonUrl)).replace(/\/+$/, '');
  const query = file === undefined ? '' : `?file=${encodeURIComponent(file)}`;
  const response = await (options.fetchImpl ?? fetch)(`${base}/api/cult/copy/${encodeURIComponent(`cult:${name}`)}${query}`);
  if (!response.ok) return { kind: 'http-failure', response };
  let body;
  try {
    body = parseCultCopyResponse(await response.json());
  } catch (err) {
    return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] malformed response from /api/cult/copy: ${(err as Error).message}`] };
  }
  if (json) return { kind: 'done', code: 0, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: [] };
  const content = body.copy.mainFile.content;
  return { kind: 'done', code: 0, stdout: content.endsWith('\n') ? content : `${content}\n`, stderr: [] };
}
