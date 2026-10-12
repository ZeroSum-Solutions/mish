/**
 * Remix into project: reads one licensed Cult UI Pro registry item from the private source kit
 * (`<CULT_KIT_DIR>/registry/<name>.json`, see docs/legal/cult-ui-pro-rights.md) and turns it into
 * the item `GET /api/cult/r/<slug>.json` serves to `npx shadcn@latest add` and `od cult add`.
 *
 * Invariants:
 * - Only a name that is a row of the shipped inventory (`catalog.json`) is ever read. The name is
 *   checked against a slug pattern first and the resolved path must stay inside `registry/`, so a
 *   request can never name another file.
 * - The bytes served are the pinned snapshot: the item file's sha256 must equal the row's
 *   `source.registrySha256`, or the item is refused (`KIT_DRIFT`) rather than served unpinned.
 * - A derived section row (`<page>--<section>`) is not a registry item; it serves its page's
 *   item (every file it needs lives there) under its own name, and its main file is the section.
 * - Registry dependencies that are catalogued items are rewritten to this endpoint's URL; the
 *   rest (`button`, `card`, ...) stay bare names for the default component registry.
 * - Some upstream files import a sibling by a relative path that only holds in the vendor's own
 *   repository layout (`../kanban-board` from `registry/components/example/kanban-board-demo.tsx`).
 *   In a `.ts`/`.tsx`/`.js`/`.jsx` file only, a relative import that names no installed target is
 *   repointed at another file's `@/` target when either (1) it resolves exactly, against the
 *   importer's registry `path`, to one file of the item or its catalogued dependencies, or (2) its
 *   tail, which must contain a directory segment (`hooks/use-x`, never a bare `./types`), ends
 *   exactly one such target. A file never points at itself, and anything else (CSS `@import`, an
 *   ambiguous or unmatched path) is left exactly as it is.
 * - Every name the item carries is brand-free (`@mish/contracts` api/cult-brand.ts): it is
 *   published under its public slug (`generated/slugs.json`; the internal name and `cult:<name>`
 *   id still resolve as aliases and are never echoed), with a scrubbed title and description,
 *   brand-free file and folder names (`cultBrandFreePath`, import paths following them), branded
 *   exports renamed (`renamesFor`) and a Next page's metadata title and description scrubbed
 *   (`scrubPageMetadata`). Vendor metadata (`author`, `meta`, `$schema`) is dropped. Two things
 *   stay as they are: npm package names (renaming one breaks the install) and the rest of the
 *   licensed source text, except exact reviewed demo-copy refinements. Those remove unsupported
 *   marketing claims after the raw pinned snapshot has passed checksum verification.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CultCopyInfo, CultRegistryFile } from '@mish/contracts';
import {
  CULT_REGISTRY_NAME,
  cultBrandFreeIdentifier,
  cultBrandFreePath,
  cultDisplayText,
  cultDisplayTitle,
  cultRegistryName,
  isCultBrandFree,
} from '@mish/contracts';

import { expandHomePrefix } from './home-expansion.js';
import { cultRefinedSourceCopy } from './cult-copy-refinements.js';
import { cultResponsiveSourceCopy } from './cult-responsive-source.js';

/** The fields of an inventory row this module reads. */
export interface CultRegistryRow {
  id: string;
  name: string;
  /** The inventory title and description; the served item carries their brand-free forms. */
  title?: string;
  description?: string;
  derivedFrom?: string;
  dependencies: string[];
  source: {
    registrySha256: string | null;
    files: Array<{ path: string; target: string; type: string }>;
  };
}

export type CultRegistryErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'KIT_UNAVAILABLE' | 'KIT_DRIFT';

export class CultRegistryError extends Error {
  readonly status: number;
  readonly code: CultRegistryErrorCode;

  constructor(status: number, code: CultRegistryErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The source-kit directory from `CULT_KIT_DIR` (the package scripts' variable), or null. */
export function resolveCultKitDir(env: NodeJS.ProcessEnv = process.env, resourceRoot?: string | null): string | null {
  const raw = env.CULT_KIT_DIR?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  const bundled = resourceRoot ? path.join(resourceRoot, 'data', 'component-kits', 'cult-ui-pro') : null;
  return bundled && existsSync(path.join(bundled, 'manifest.json')) ? bundled : null;
}

/** One export rename decision for an item's own code (see `exportRenames`). */
export interface CultExportRename {
  from: string;
  to: string | null;
  /** Why the export keeps its name; absent when it was renamed. */
  skipped?: string;
}

type ServedItem = Record<string, unknown> & {
  name: string;
  files: CultRegistryFile[];
  dependencies: string[];
  registryDependencies: string[];
};

const SCRIPT_PATH = /\.(?:tsx?|jsx?|mjs|cjs)$/;

/** `export function X`, `export default class X`, `export const X`, `export interface X`, … */
const EXPORT_DECL = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_][\w]*)/g;
/** `export { X, Y as Z }` (without `from`): X and Y are local names this file defines. */
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}(?!\s*from\b)/g;
/** Import and re-export specifiers this module may rewrite (relative and `@/` ones only). */
const LOCAL_SPECIFIER = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"]))((?:\.\.?\/|@\/)[^'"]*)\2/g;

function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
}

/**
 * How the occurrence at `index` reads: `code` (an identifier), `prose` (inside a quoted string on
 * its line that holds whitespace, such as an error message: renaming it there changes only the
 * words a person reads; a `X.displayName = "X"` devtools label counts too) or `key` (a property, a
 * kebab-case word, or any other string without whitespace, such as a lookup key or a module name:
 * a rename could change behavior).
 */
function occurrenceKind(content: string, index: number, length: number): 'code' | 'prose' | 'key' {
  const before = content[index - 1] ?? '';
  const after = content[index + length] ?? '';
  if (before === '.' || before === '-' || before === '@' || before === '#' || after === '-') return 'key';
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = content.indexOf('\n', index) === -1 ? content.length : content.indexOf('\n', index);
  const lead = content.slice(lineStart, index).replace(/\\./g, '');
  for (const quote of ["'", '"', '`']) {
    if ((lead.split(quote).length - 1) % 2 === 0) continue;
    const open = content.lastIndexOf(quote, index - 1);
    const close = content.indexOf(quote, index + length);
    const literal = content.slice(open + 1, close === -1 || close > lineEnd ? lineEnd : close);
    // `X.displayName = "X"` is a devtools label: it follows the component's own name.
    const displayName = /\.displayName\s*=\s*$/.test(content.slice(lineStart, open)) && literal === content.slice(index, index + length);
    return /\s/.test(literal) || displayName ? 'prose' : 'key';
  }
  return 'code';
}

/** The identifiers a file exports under a name it defines. */
function exportedNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(EXPORT_DECL)) names.add(match[1]!);
  for (const match of content.matchAll(EXPORT_LIST)) {
    for (const part of match[1]!.split(',')) {
      const local = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (local && /^[A-Za-z_][\w]*$/.test(local) && local !== 'default') names.add(local);
    }
  }
  return [...names];
}

export class CultRegistry {
  private readonly byName: ReadonlyMap<string, CultRegistryRow>;
  private readonly byId: ReadonlyMap<string, CultRegistryRow>;
  private readonly bySlug: ReadonlyMap<string, CultRegistryRow>;
  /** Internal name → public slug, for brand-free folder and file names. */
  private readonly nameToSlug: ReadonlyMap<string, string>;
  private readonly renameCache = new Map<string, CultExportRename[]>();

  private readonly kitDir: string | null;

  /**
   * `slugs` maps a row id to its public slug (`generated/slugs.json` of the catalog package). A
   * row without one is published under its internal name.
   */
  constructor(rows: readonly CultRegistryRow[], kitDir: string | null, slugs: ReadonlyMap<string, string> = new Map()) {
    this.kitDir = kitDir;
    this.byName = new Map(rows.map((row) => [row.name, row]));
    this.byId = new Map(rows.map((row) => [row.id, row]));
    this.bySlug = new Map(rows.flatMap((row) => {
      const slug = slugs.get(row.id);
      return slug === undefined ? [] : [[slug, row] as const];
    }));
    this.nameToSlug = new Map(rows.flatMap((row) => {
      const slug = slugs.get(row.id);
      return slug === undefined ? [] : [[row.name, slug] as const];
    }));
  }

  /** The name a person sees and types for a row: its public slug, else its internal name. */
  publicName(row: Pick<CultRegistryRow, 'name'>): string {
    return this.nameToSlug.get(row.name) ?? row.name;
  }

  /**
   * The catalogued row for a public slug, or an alias: an internal name or `cult:<name>` id (the
   * old ids keep working, and are never shown). Throws 400 / 404.
   */
  row(idOrName: string): CultRegistryRow {
    const name = cultRegistryName(idOrName);
    if (name === null) throw new CultRegistryError(400, 'BAD_REQUEST', 'not a catalogued item name');
    const row = this.bySlug.get(name) ?? this.byName.get(name);
    // The message never repeats the name asked for: it could be an old, branded one.
    if (!row) throw new CultRegistryError(404, 'NOT_FOUND', 'no Cult catalog item with that name');
    return row;
  }

  /** The served registry item for `idOrName`, with catalogued dependencies pointing at `baseUrl`. */
  item(idOrName: string, baseUrl: string): ServedItem {
    return this.served(this.row(idOrName), baseUrl).item;
  }

  /**
   * What the web's copy buttons and `od cult show` need for one row: `file` (a target or registry
   * path, as served or as the kit names it) picks a file, else the main file. Its imports are on the
   * default aliases.
   */
  copyInfo(idOrName: string, baseUrl: string, file?: string): CultCopyInfo {
    const row = this.row(idOrName);
    const { item, rawFiles } = this.served(row, baseUrl);
    const index = file === undefined
      ? rawFiles.indexOf(mainFileOf(row, rawFiles))
      : [item.files, rawFiles].map((list) => list.findIndex((entry) => entry.target === file || entry.path === file)).find((i) => i >= 0) ?? -1;
    const picked = item.files[index];
    if (!picked) throw new CultRegistryError(404, 'NOT_FOUND', `${this.publicName(row)} has no file with that path`);
    const name = this.publicName(row);
    return {
      id: `cult:${name}`,
      name,
      registryUrl: cultRegistryUrl(baseUrl, name),
      dependencies: item.dependencies,
      registryDependencies: item.registryDependencies,
      mainFile: { ...picked, content: rewriteImports(picked.content, DEFAULT_ALIASES) },
      files: item.files.map(({ path: filePath, target }) => ({ path: filePath, target })),
    };
  }

  /**
   * The export renames applied to an item's own code, with the reason for each branded export that
   * keeps its name. For audits and tests; `item` applies the same decisions.
   */
  exportRenames(idOrName: string): CultExportRename[] {
    const row = this.row(idOrName);
    const source = this.sourceOf(row);
    return this.renamesFor(source);
  }

  private sourceOf(row: CultRegistryRow): CultRegistryRow {
    const source = row.derivedFrom ? this.byId.get(row.derivedFrom) : row;
    if (!source) throw new CultRegistryError(404, 'NOT_FOUND', `${this.publicName(row)} is cut from an item that is not catalogued`);
    return source;
  }

  /** The source item's files as the kit ships them, with vendor-layout relative imports repaired. */
  private rawFiles(source: CultRegistryRow): { raw: Record<string, unknown>; files: CultRegistryFile[]; dependencyFiles: CultRegistryFile[] } {
    const raw = this.readPinned(source);
    const own = fileList(raw.files, source.name);
    const dependencyFiles = this.dependencyFiles(raw);
    const installed = [...own, ...dependencyFiles];
    return { raw, files: own.map((file) => ({ ...file, content: repairRelativeImports(file, installed) })), dependencyFiles };
  }

  /**
   * Branded exports this item defines, each with its brand-free name or the reason it keeps its
   * own. Decided on the defining item's own files, so every item that imports one of them reads
   * the same decision. The rename covers code and prose strings (an error message naming the
   * component). A new name already used in the item or anything it installs takes the first free
   * numbered form (`AnalyticsHeroIcon2`). An export keeps its name only when the same word is also
   * a module name, a string key or a property in the item (a string without spaces, `x.name`, a
   * kebab-case word), which must stay, or when no brand-free name is left; each such case carries
   * its reason.
   */
  private renamesFor(source: CultRegistryRow): CultExportRename[] {
    const cached = this.renameCache.get(source.name);
    if (cached) return cached;
    const { files, dependencyFiles } = this.rawFiles(source);
    const scripts = files.filter((file) => SCRIPT_PATH.test(file.path));
    const everything = [...files, ...dependencyFiles].map((file) => file.content).join('\n');
    const decisions: CultExportRename[] = [];
    const claimed = new Set<string>();
    const names = [...new Set(scripts.flatMap((file) => exportedNames(file.content)))].sort();
    for (const from of names) {
      const to = cultBrandFreeIdentifier(from);
      if (to === null) {
        if (!isCultBrandFree(from)) decisions.push({ from, to: null, skipped: 'no brand-free name is left once the brand is removed' });
        continue;
      }
      const keyUse = scripts.some((file) => [...file.content.matchAll(wordPattern(from))]
        .some((match) => occurrenceKind(file.content, match.index, from.length) === 'key'));
      if (keyUse) {
        decisions.push({ from, to: null, skipped: 'the same word is also a module name, a string key or a property in this item (`"stripe"`, `stripe:user:…`), which must stay as it is; the variable keeps that word so the code still reads as one' });
        continue;
      }
      // A taken name (`AnalyticsHeroGoogleIcon` → `AnalyticsHeroIcon`, already defined) takes the
      // first free numbered form: `AnalyticsHeroIcon2`, `AnalyticsHeroIcon3`, … Deterministic,
      // because names are decided in sorted order against the item's own text.
      const taken = (name: string) => claimed.has(name) || wordPattern(name).test(everything);
      let free = to;
      for (let n = 2; taken(free); n += 1) free = /\d$/.test(to) ? `${to}_${n}` : `${to}${n}`;
      claimed.add(free);
      decisions.push({ from, to: free });
    }
    this.renameCache.set(source.name, decisions);
    return decisions;
  }

  /** Renames for the source item and every catalogued item it installs. */
  private renameMap(source: CultRegistryRow, raw: Record<string, unknown>): Map<string, string> {
    const map = new Map<string, string>();
    const rows = [source, ...this.dependencyRows(raw)];
    for (const row of rows) {
      for (const decision of this.renamesFor(row)) {
        if (decision.to !== null && !map.has(decision.from)) map.set(decision.from, decision.to);
      }
    }
    return map;
  }

  /**
   * The served item: the public slug as its name, brand-free title and description, file paths
   * and targets with brand-free file and folder names, import paths following those names,
   * branded exports renamed (`renamesFor`) and a page's metadata title and description scrubbed
   * (`scrubPageMetadata`). Unknown vendor metadata (`author`, `meta`) is dropped.
   */
  private served(row: CultRegistryRow, baseUrl: string): { item: ServedItem; rawFiles: CultRegistryFile[] } {
    const source = this.sourceOf(row);
    const { raw, files } = this.rawFiles(source);
    const renames = this.renameMap(source, raw);
    const publishPath = (value: string) => cultBrandFreePath(value, this.nameToSlug);
    const publishContent = (file: CultRegistryFile): string => {
      if (!SCRIPT_PATH.test(file.path) && !SCRIPT_PATH.test(file.target)) return file.content;
      let content = file.content.replace(LOCAL_SPECIFIER, (_m, lead: string, quote: string, spec: string) => `${lead}${publishPath(spec)}${quote}`);
      for (const [from, to] of renames) {
        content = content.replace(wordPattern(from), (match, index: number) => (occurrenceKind(content, index, from.length) === 'key' ? match : to));
      }
      return cultResponsiveSourceCopy(cultRefinedSourceCopy(scrubPageMetadata(content), source.name), source.name);
    };
    const published = files.map((file) => ({
      ...file,
      path: publishPath(file.path),
      target: file.target ? publishPath(file.target) : '',
      content: publishContent(file),
    }));
    const title = row.title ?? (typeof raw.title === 'string' ? raw.title : undefined);
    const description = row.description ?? (typeof raw.description === 'string' ? raw.description : undefined);
    // Only `target` (the project-relative install path) feeds folder aliases: it is what `od cult
    // add` places on disk and where an earlier copy would sit, unlike `path` (the raw kit path,
    // kept for `source`/display only).
    const folderAliases = collectFolderAliases(files.flatMap((file) => (file.target ? [file.target] : [])), this.nameToSlug);
    const item: ServedItem = {
      name: this.publicName(row),
      type: typeof raw.type === 'string' ? raw.type : 'registry:block',
      ...(title !== undefined ? { title: safeDisplay(() => cultDisplayTitle(title)) } : {}),
      ...(description !== undefined ? { description: safeDisplay(() => cultDisplayText(description)) } : {}),
      dependencies: stringList(raw.dependencies),
      registryDependencies: stringList(raw.registryDependencies).map((dep) => this.dependencyRef(dep, baseUrl)),
      files: published,
      ...(Object.keys(folderAliases).length > 0 ? { folderAliases } : {}),
    };
    return { item, rawFiles: files };
  }

  /** The catalogued items `raw` depends on, transitively. */
  private dependencyRows(raw: Record<string, unknown>): CultRegistryRow[] {
    const rows: CultRegistryRow[] = [];
    const seen = new Set<string>();
    const queue = stringList(raw.registryDependencies);
    while (queue.length > 0) {
      const dep = queue.shift()!.replace(/^@cult-ui-pro\//, '');
      const row = this.byName.get(dep);
      if (!row || seen.has(dep) || row.derivedFrom) continue;
      seen.add(dep);
      rows.push(row);
      queue.push(...stringList(this.readPinned(row).registryDependencies));
    }
    return rows;
  }

  /** The files of every catalogued item `raw` depends on, transitively (each read once). */
  private dependencyFiles(raw: Record<string, unknown>): CultRegistryFile[] {
    return this.dependencyRows(raw).flatMap((row) => fileList(this.readPinned(row).files, row.name));
  }

  private dependencyRef(dep: string, baseUrl: string): string {
    const bare = dep.startsWith('@cult-ui-pro/') ? dep.slice('@cult-ui-pro/'.length) : dep;
    const row = CULT_REGISTRY_NAME.test(bare) ? this.byName.get(bare) : undefined;
    return row ? cultRegistryUrl(baseUrl, this.publicName(row)) : dep;
  }

  private readPinned(row: CultRegistryRow): Record<string, unknown> {
    if (this.kitDir === null) {
      throw new CultRegistryError(503, 'KIT_UNAVAILABLE', 'the Cult UI Pro source kit is not configured (set CULT_KIT_DIR)');
    }
    const registryDir = path.join(this.kitDir, 'registry');
    const file = path.resolve(registryDir, `${row.name}.json`);
    if (!CULT_REGISTRY_NAME.test(row.name) || path.dirname(file) !== path.resolve(registryDir)) {
      throw new CultRegistryError(400, 'BAD_REQUEST', 'not a catalogued item name');
    }
    const shown = this.publicName(row);
    if (!existsSync(file)) throw new CultRegistryError(503, 'KIT_UNAVAILABLE', `the source kit has no item "${shown}"`);
    const bytes = readFileSync(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (row.source.registrySha256 === null || digest !== row.source.registrySha256) {
      throw new CultRegistryError(409, 'KIT_DRIFT', `the source kit's "${shown}" item differs from the catalogued snapshot`);
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CultRegistryError(409, 'KIT_DRIFT', `the source kit's "${shown}" item is not an object`);
    }
    return parsed as Record<string, unknown>;
  }
}

const METADATA_BLOCK = /\bexport\s+const\s+metadata\b[^=]*=\s*\{[\s\S]*?\n\};?/g;
const METADATA_FIELD = /(\b(title|description)\s*:\s*)(["'])((?:\\.|(?!\3)[^\\\n])*)\3/g;

/**
 * A Next page's `export const metadata = { title, description }` becomes the browser tab title and
 * the page description a person sees, so its two strings get the catalog's display scrub
 * ("Marketing Pricing Vercel" → "Pricing (series V)"). A string the scrub refuses stays as it is.
 */
export function scrubPageMetadata(content: string): string {
  return content.replace(METADATA_BLOCK, (block) => block.replace(METADATA_FIELD, (match, lead: string, field: string, quote: string, text: string) => {
    const clean = safeDisplay(() => (field === 'title' ? cultDisplayTitle(text) : cultDisplayText(text)));
    return clean ? `${lead}${quote}${clean.replace(new RegExp(quote, 'g'), `\\${quote}`)}${quote}` : match;
  }));
}

/** A display string, or '' when the scrub refuses it (it fails closed on a brand it cannot remove). */
function safeDisplay(render: () => string): string {
  try {
    return render();
  } catch {
    return '';
  }
}

export function cultRegistryUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/cult/r/${name}.json`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function fileList(value: unknown, name: string): CultRegistryFile[] {
  if (!Array.isArray(value)) throw new CultRegistryError(409, 'KIT_DRIFT', `the source kit's "${name}" item has no files`);
  return value.map((file, index) => {
    const entry = (file ?? {}) as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string' || typeof entry.type !== 'string') {
      throw new CultRegistryError(409, 'KIT_DRIFT', `the source kit's "${name}" item has a malformed file ${index}`);
    }
    return { path: entry.path, type: entry.type, target: typeof entry.target === 'string' ? entry.target : '', content: entry.content };
  });
}

function normalizeTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^~\//, '');
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
const RELATIVE_IMPORT = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"]))(\.\.?\/[^'"]*)\2/g;
const SCRIPT_FILE = /\.(?:tsx?|jsx?)$/;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * `file`'s content with vendor-layout relative imports repointed (see the module docblock);
 * `installed` is every file the install writes (the item's own and its catalogued dependencies').
 */
export function repairRelativeImports(
  file: Pick<CultRegistryFile, 'path' | 'target' | 'content'>,
  installed: ReadonlyArray<Pick<CultRegistryFile, 'path' | 'target'>>,
): string {
  const self = normalizeTarget(file.target);
  if (!SCRIPT_FILE.test(self || file.path)) return file.content;
  const targets = new Set(installed.map((entry) => normalizeTarget(entry.target)));
  const byPath = new Map(installed.map((entry) => [normalizePath(entry.path), normalizeTarget(entry.target)]));
  const lookup = <T>(base: string, get: (key: string) => T | undefined): T[] =>
    RESOLVE_SUFFIXES.map((suffix) => get(base + suffix)).filter((hit): hit is T => hit !== undefined);
  const toAlias = (target: string) => `@/${target.replace(/\.(?:tsx?|jsx?)$/, '').replace(/\/index$/, '')}`;
  return file.content.replace(RELATIVE_IMPORT, (match, lead: string, quote: string, spec: string) => {
    if (lookup(path.posix.normalize(path.posix.join(path.posix.dirname(self), spec)), (key) => (targets.has(key) ? key : undefined)).length > 0) return match;
    const byVendorPath = [...new Set(lookup(path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(file.path)), spec)), (key) => byPath.get(key)))]
      .filter((target) => target !== self);
    if (byVendorPath.length === 1) return `${lead}${toAlias(byVendorPath[0]!)}${quote}`;
    const tail = spec.replace(/^(?:\.\.?\/)+/, '');
    if (!tail.includes('/')) return match;
    const hits = [...targets].filter((target) => target !== self
      && RESOLVE_SUFFIXES.some((suffix) => target === tail + suffix || target.endsWith(`/${tail}${suffix}`)));
    return hits.length === 1 ? `${lead}${toAlias(hits[0]!)}${quote}` : match;
  });
}

export interface ProjectAliases {
  components: string;
  ui: string;
  lib: string;
  hooks: string;
  utils: string;
}

export const DEFAULT_ALIASES: ProjectAliases = {
  components: '@/components',
  ui: '@/components/ui',
  lib: '@/lib',
  hooks: '@/hooks',
  utils: '@/lib/utils',
};

/** Rewrites `@/…` import specifiers (including the upstream `@/registry/…` ones) onto `aliases`. */
export function rewriteImports(content: string, aliases: ProjectAliases): string {
  return content.replace(/(['"])@\/([A-Za-z0-9_\-./]+)\1/g, (match, quote: string, spec: string) => {
    const to = (alias: string, rest: string) => `${quote}${alias}${rest ? `/${rest}` : ''}${quote}`;
    let m: RegExpExecArray | null;
    if ((m = /^registry\/ui(?:\/(.*))?$/.exec(spec))) return to(aliases.ui, m[1] ?? '');
    if ((m = /^registry\/components(?:\/(.*))?$/.exec(spec))) return to(aliases.components, m[1] ?? '');
    if ((m = /^registry\/blocks\/[^/]+\/(components|lib|hooks)(?:\/(.*))?$/.exec(spec))) {
      return to(aliases[m[1] as 'components' | 'lib' | 'hooks'], m[2] ?? '');
    }
    if ((m = /^components\/ui(?:\/(.*))?$/.exec(spec))) return to(aliases.ui, m[1] ?? '');
    if ((m = /^components(?:\/(.*))?$/.exec(spec))) return to(aliases.components, m[1] ?? '');
    if (spec === 'lib/utils') return to(aliases.utils, '');
    if ((m = /^lib(?:\/(.*))?$/.exec(spec))) return to(aliases.lib, m[1] ?? '');
    if ((m = /^hooks(?:\/(.*))?$/.exec(spec))) return to(aliases.hooks, m[1] ?? '');
    return match;
  });
}

/**
 * A renamed folder's old (internal) name, by its new (public-slug) path — e.g.
 * `{ "sections/cta-hex": "sections/marketing-cta-hex" }` — for every directory segment
 * `cultBrandFreePath` retargeted across `paths`. Detection only, for `od cult add` to note an
 * earlier install left at the old folder; recorded only when the old segment is itself brand-free
 * (`isCultBrandFree`), so a folder renamed to scrub a vendor brand never resurfaces that name here.
 */
function collectFolderAliases(paths: readonly string[], rowSlugs: ReadonlyMap<string, string>): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const original of paths) {
    const originalSegments = original.split('/');
    const publishedSegments = cultBrandFreePath(original, rowSlugs).split('/');
    let originalPrefix = '';
    let publishedPrefix = '';
    for (let i = 0; i < originalSegments.length - 1; i += 1) {
      originalPrefix = originalPrefix ? `${originalPrefix}/${originalSegments[i]}` : originalSegments[i]!;
      publishedPrefix = publishedPrefix ? `${publishedPrefix}/${publishedSegments[i]}` : publishedSegments[i]!;
      if (originalSegments[i] !== publishedSegments[i] && isCultBrandFree(originalSegments[i]!)) {
        aliases[publishedPrefix] = originalPrefix;
      }
    }
  }
  return aliases;
}

function stem(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.[^.]+$/, '');
}

/**
 * The file a person most likely wants: a derived section's own section file; else the file named
 * after the item; else the file named by the item's longest dash-suffix (`cta-hex` for
 * `marketing-cta-hex`); else its first `registry:ui` file; else its largest component; else the
 * first file.
 */
export function mainFileOf(row: Pick<CultRegistryRow, 'name' | 'derivedFrom'>, files: readonly CultRegistryFile[]): CultRegistryFile {
  if (files.length === 0) throw new CultRegistryError(409, 'KIT_DRIFT', `the source kit's "${row.name}" item has no files`);
  const section = row.derivedFrom ? row.name.split('--').pop() : undefined;
  return (section ? files.find((file) => stem(file.path) === section) : undefined)
    ?? files.find((file) => stem(file.path) === row.name)
    ?? [...files].filter((file) => row.name.endsWith(`-${stem(file.path)}`)).sort((a, b) => stem(b.path).length - stem(a.path).length)[0]
    ?? files.find((file) => file.type === 'registry:ui')
    ?? [...files].filter((file) => file.type === 'registry:component').sort((a, b) => b.content.length - a.content.length)[0]
    ?? files[0]!;
}
