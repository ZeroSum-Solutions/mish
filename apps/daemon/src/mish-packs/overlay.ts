// Mish packs: the read side. Loaders that used to read only bundled data ask this module whether an
// installed pack provides a replacement. With no pack installed every accessor returns "nothing"
// (null, an empty list, or the bundled value passed in), so nothing changes.
//
// The set of packs is scanned synchronously at boot and again after every install or remove
// (`refreshMishPacks`). Consumers that cache derived data key the cache on `mishPackGeneration()`.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { MISH_PACK_MANIFEST_FILENAME, MISH_PACK_LIMITS, mishPackManifestSchema, type MishPackManifest, type MishPackResourceKey } from '@mish/contracts';

export interface ActiveMishPack {
  id: string;
  root: string;
  manifest: MishPackManifest;
  origin: 'installed' | 'external';
}

interface OverlayConfig {
  dataDir: string | null;
  externalDir: string | null;
}

export const MISH_PACKS_DIRNAME = 'mish-packs';

let config: OverlayConfig = { dataDir: null, externalDir: null };
let packs: ActiveMishPack[] = [];
let generation = 0;
let signature = '';
const warned = new Set<string>();

export function mishPacksInstallDir(dataDir: string): string {
  return path.join(dataDir, MISH_PACKS_DIRNAME);
}

/** Points the overlay at a data directory (and the optional read-only MISH_PACKS_DIR) and scans. */
export function configureMishPacks(next: { dataDir: string | null; externalDir?: string | null }): ActiveMishPack[] {
  config = { dataDir: next.dataDir, externalDir: next.externalDir ?? null };
  return refreshMishPacks();
}

export function mishPackGeneration(): number {
  return generation;
}

export function activeMishPacks(): readonly ActiveMishPack[] {
  return packs;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[mish-packs] ${message}`);
}

/** Reads and validates one pack folder's manifest, or null (with one warning) when it is unusable. */
export function readPackManifestSync(root: string): MishPackManifest | null {
  const file = path.join(root, MISH_PACK_MANIFEST_FILENAME);
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MISH_PACK_LIMITS.manifestMaxBytes) return null;
    const parsed = mishPackManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      warnOnce(file, `${path.basename(root)}: manifest is invalid and the pack is ignored`);
      return null;
    }
    return parsed.data;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') warnOnce(file, `${path.basename(root)}: manifest cannot be read and the pack is ignored`);
    return null;
  }
}

function scanInstalled(dir: string, origin: ActiveMishPack['origin'], out: ActiveMishPack[]): void {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of names) {
    const root = path.join(dir, name);
    const manifest = readPackManifestSync(root);
    if (manifest && manifest.id === name) out.push({ id: manifest.id, root, manifest, origin });
    else if (manifest) warnOnce(root, `${name}: the folder name must equal the pack id "${manifest.id}"; the pack is ignored`);
  }
}

/** Rescans the installed folder and MISH_PACKS_DIR; bumps the generation. */
export function refreshMishPacks(): ActiveMishPack[] {
  const found: ActiveMishPack[] = [];
  if (config.dataDir) scanInstalled(mishPacksInstallDir(config.dataDir), 'installed', found);
  if (config.externalDir) {
    // MISH_PACKS_DIR may be one pack folder or a folder of pack folders.
    const single = readPackManifestSync(config.externalDir);
    if (single) found.push({ id: single.id, root: config.externalDir, manifest: single, origin: 'external' });
    else scanInstalled(config.externalDir, 'external', found);
  }
  const byId = new Map<string, ActiveMishPack>();
  for (const pack of found) if (!byId.has(pack.id) || pack.origin === 'installed') byId.set(pack.id, pack);
  const next = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Consumers key caches on the generation, so it moves only when the set of packs really changed.
  const nextSignature = next.map((pack) => `${pack.id}@${pack.manifest.version}@${pack.root}@${manifestStamp(pack.root)}`).join('|');
  packs = next;
  if (nextSignature !== signature) {
    signature = nextSignature;
    generation += 1;
  }
  return packs;
}

function manifestStamp(root: string): string {
  try {
    const info = statSync(path.join(root, MISH_PACK_MANIFEST_FILENAME));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return '0';
  }
}

/** Test seam: forget every pack. */
export function resetMishPacksForTests(): void {
  config = { dataDir: null, externalDir: null };
  packs = [];
  signature = '';
  generation += 1;
  jsonCache.clear();
}

/** Declared relative path of a resource in a manifest, or undefined. */
export function declaredPackPath(manifest: MishPackManifest, key: MishPackResourceKey): string | undefined {
  const { catalogs, assets } = manifest.provides;
  switch (key) {
    case 'cultKit': return catalogs?.cultKit;
    case 'cultCatalog': return catalogs?.cultCatalog;
    case 'cultAdapters': return catalogs?.cultAdapters;
    case 'genui': return catalogs?.genui;
    case 'sections': return catalogs?.sections;
    case 'twentyFirst': return catalogs?.twentyFirst;
    case 'designSystems': return manifest.provides.designSystems;
    case 'skills': return manifest.provides.skills;
    case 'studies': return manifest.provides.studies;
    case 'pets': return assets?.pets;
    case 'promptTemplates': return assets?.promptTemplates;
    case 'styleCatalog': return assets?.styleCatalog;
  }
}

/**
 * The absolute path of a pack-relative path, or null when it does not exist or leaves the pack
 * root once links are resolved (an external folder is not vetted at install time).
 */
export function resolvePackPath(pack: ActiveMishPack, relative: string): string | null {
  const joined = path.resolve(pack.root, ...relative.split('/'));
  try {
    const realRoot = realpathSync(pack.root);
    const real = realpathSync(joined);
    const rel = path.relative(realRoot, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return real;
  } catch {
    return null;
  }
}

/** The resolved path of one resource of one pack, or null. */
export function packResourcePath(pack: ActiveMishPack, key: MishPackResourceKey): string | null {
  const declared = declaredPackPath(pack.manifest, key);
  return declared === undefined ? null : resolvePackPath(pack, declared);
}

/** Every pack's resolved path for a resource, in pack-id order. */
export function packResourcePaths(key: MishPackResourceKey): string[] {
  const out: string[] = [];
  for (const pack of packs) {
    const resolved = packResourcePath(pack, key);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** The first pack's resolved path for a resource, or null. */
export function firstPackResourcePath(key: MishPackResourceKey): string | null {
  return packResourcePaths(key)[0] ?? null;
}

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const jsonCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** Reads a JSON file inside a pack, cached by modification time. Null when absent or unreadable. */
export function readPackJson(file: string): unknown {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) return null;
    const cached = jsonCache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value });
    return value;
  } catch {
    warnOnce(`json:${file}`, `${path.basename(file)} cannot be read as JSON and is ignored`);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Cult UI catalog (mirrors the package layout of `@mish/cult-ui-catalog`)
// ---------------------------------------------------------------------------------------------

export type CultCatalogDataFile =
  | 'catalog.json'
  | 'catalog-curation.json'
  | 'catalog-copy-refinements.json'
  | 'generated/slugs.json'
  | 'generated/public-names.json'
  | 'generated/thumbnails.json';

const CULT_SHAPES: Record<CultCatalogDataFile, (value: unknown) => boolean> = {
  'catalog.json': (value) => isRecord(value) && value.schema === 'cult-ui-catalog/1' && Array.isArray(value.rows),
  'catalog-curation.json': isRecord,
  'catalog-copy-refinements.json': (value) => isRecord(value) && Array.isArray(value.replacements),
  'generated/slugs.json': (value) => isRecord(value) && isRecord(value.items),
  'generated/public-names.json': (value) => isRecord(value) && isRecord(value.items),
  'generated/thumbnails.json': (value) => isRecord(value) && isRecord(value.items),
};

/** The first pack folder that provides a Cult catalogue (one with a valid `catalog.json`), or null. */
export function packCultCatalogRoot(): string | null {
  for (const root of packResourcePaths('cultCatalog')) {
    if (CULT_SHAPES['catalog.json'](readPackJson(path.join(root, 'catalog.json')))) return root;
  }
  return null;
}

/** The pack's `generated/` folder (preview and thumbnail images) when a pack provides a catalogue. */
export function packCultGeneratedDir(): string | null {
  const root = packCultCatalogRoot();
  if (!root) return null;
  const generated = path.join(root, 'generated');
  return existsSync(generated) ? generated : null;
}

/**
 * One Cult catalogue data file: the pack's copy when a pack provides it, else `bundled`. A pack
 * file with the wrong shape is ignored (with one warning) so a bad pack cannot break a route.
 */
export function overlayCultJson<T>(file: CultCatalogDataFile, bundled: T): T {
  const root = packCultCatalogRoot();
  if (!root) return bundled;
  const value = readPackJson(path.join(root, ...file.split('/')));
  if (value === null) return bundled;
  if (!CULT_SHAPES[file](value)) {
    warnOnce(`shape:${root}:${file}`, `${file} in the pack has an unexpected shape and is ignored`);
    return bundled;
  }
  return value as T;
}

// ---------------------------------------------------------------------------------------------
// Section catalogue, GenUI, 21st thumbnails, cult adapters
// ---------------------------------------------------------------------------------------------

/** Section catalogue entries from every pack (`{ entries: [...] }` or a bare array). */
export function packSectionEntries(): unknown[] {
  const out: unknown[] = [];
  for (const file of packResourcePaths('sections')) {
    const value = readPackJson(file);
    const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
    out.push(...entries.filter(isRecord));
  }
  return out;
}

/** GenUI catalogue entries from every pack's `overlay.json` (`entries`, or `components` as in the catalogue file). */
export function packGenuiEntries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const dir of packResourcePaths('genui')) {
    const value = readPackJson(path.join(dir, 'overlay.json'));
    const list = isRecord(value) ? (Array.isArray(value.entries) ? value.entries : value.components) : undefined;
    if (Array.isArray(list)) out.push(...list.filter(isRecord));
  }
  return out;
}

const DEMO_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;

/** A pack's prebuilt GenUI demo document (`demos/<id>.html`), or null. */
export function packGenuiDemo(id: string): string | null {
  if (!DEMO_ID.test(id)) return null;
  for (const dir of packResourcePaths('genui')) {
    const file = path.join(dir, 'demos', `${id}.html`);
    try {
      if (statSync(file).isFile()) return readFileSync(file, 'utf8');
    } catch {
      // try the next pack
    }
  }
  return null;
}

/** The 21st thumbnail manifest and the folder holding its images, from the first pack that has one. */
export function packTwentyFirstThumbnails(): { manifest: { items: Record<string, { file: string }> }; dir: string } | null {
  for (const dir of packResourcePaths('twentyFirst')) {
    const value = readPackJson(path.join(dir, '21st-thumbnails.json'));
    if (isRecord(value) && isRecord(value.items)) return { manifest: value as { items: Record<string, { file: string }> }, dir };
  }
  return null;
}

/** The prebuilt adapter module (`export const CULT_ADAPTERS`) of the first pack that has one. */
export function packCultAdaptersFile(): string | null {
  return firstPackResourcePath('cultAdapters');
}

/** The folder behind `/api/mish-packs/assets/style-catalog/v1/`, or null. */
export function packStyleCatalogDir(): string | null {
  return firstPackResourcePath('styleCatalog');
}
