/**
 * `@mish/publisher/node`: builds a `FamilyCompiler` from a family package directory on disk
 * (`plugins/_official/examples/agency-<family>/`, or any package with the same layout).
 *
 * This is the only part of the publisher that touches the filesystem, and it does so once, when
 * the package is loaded: it imports the compiler copy and reads every static resource that copy
 * renders with into the compiler's resource table. `compile` and `renderPage` then run from that
 * table alone.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AssetResolver } from './compile.ts';
import type { ApprovedAsset, CompilerModules, CompilerResources, FamilyCompiler, Json, JsonObject } from './types.ts';

/** Resource suffixes a compiler copy reads while rendering: vendored CSS, catalog component scripts and catalog JSON. */
const RESOURCE_SUFFIX = /\.(css|js|json)$/;

export type LoadedFamilyPackage = {
  compiler: FamilyCompiler;
  packageDir: string;
  /** `families/<family>/assets/`: where the approved roster's files live. */
  assetsDir: string;
  /** The copy's `readApprovedAsset(root, asset)`: a verified, symlink-safe read of one roster file under `root`. */
  readApprovedAsset: (root: string, asset: ApprovedAsset) => Promise<Buffer>;
};

type RenderModule = Pick<CompilerModules, 'renderAgencySite'>;
type ResourcesModule = Pick<CompilerModules, 'withCompilerResources'>;
type EffectsModule = Pick<CompilerModules, 'readFamilyEffectDeclaration'>;
type SectionsModule = Pick<CompilerModules, 'dishonestLinks' | 'selfSectionAnchors'>;
type AssetsModule = Pick<CompilerModules, 'verifyApprovedAssetBytes'> & { readApprovedAsset: (root: string, asset: ApprovedAsset) => Promise<Buffer> };

const isObject = (value: Json | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const fn = <T>(value: unknown): T | undefined => (typeof value === 'function' ? value as T : undefined);

async function readJson(file: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Json;
  if (!isObject(value)) throw new Error(`${file}: expected a JSON object`);
  return value;
}

async function importOptional<T>(file: string): Promise<T | undefined> {
  return existsSync(file) ? await import(pathToFileURL(file).href) as T : undefined;
}

/**
 * Every static resource under a compiler copy's `scripts/` folder (`.css`, `.js` and `.json`
 * files, symlinks and tests excluded), keyed by its path relative to that folder, in sorted order.
 */
export function collectCompilerResources(scriptsDir: string): CompilerResources {
  const table: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const file = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(file, relative);
      else if (info.isFile() && RESOURCE_SUFFIX.test(name) && !/\.test\./.test(name)) table[relative] = readFileSync(file, 'utf8');
    }
  };
  walk(scriptsDir, '');
  return Object.freeze(table);
}

/** Loads a family package: its compiler copy, the resources it renders with, its roster, reference recipe and schema. */
export async function loadFamilyCompiler(packageDir: string, family: string): Promise<LoadedFamilyPackage> {
  if (!/^[a-z][a-z0-9-]*$/.test(family)) throw new Error('family: use a lowercase id');
  const scripts = path.join(packageDir, 'compiler', 'scripts');
  const familyDir = path.join(packageDir, 'families', family);
  const [reference, schema, approvedAssets, render, assets, resources, effects, sections] = await Promise.all([
    readJson(path.join(familyDir, 'recipe.json')),
    readJson(path.join(scripts, 'families', family, 'recipe.schema.json')),
    readJson(path.join(familyDir, 'approved-assets.json')),
    import(pathToFileURL(path.join(scripts, 'render.ts')).href) as Promise<RenderModule>,
    import(pathToFileURL(path.join(scripts, 'assets.ts')).href) as Promise<AssetsModule>,
    importOptional<ResourcesModule>(path.join(scripts, 'resources.ts')),
    importOptional<EffectsModule>(path.join(scripts, 'effects.ts')),
    importOptional<SectionsModule>(path.join(scripts, 'sections.ts')),
  ]);
  if (reference.family !== family) throw new Error(`${familyDir}/recipe.json is for family ${String(reference.family)}, not ${family}`);
  const withCompilerResources = fn<CompilerModules['withCompilerResources']>(resources?.withCompilerResources);
  const modules: CompilerModules = { renderAgencySite: render.renderAgencySite };
  if (withCompilerResources) modules.withCompilerResources = withCompilerResources;
  const readFamilyEffectDeclaration = fn<CompilerModules['readFamilyEffectDeclaration']>(effects?.readFamilyEffectDeclaration);
  if (readFamilyEffectDeclaration) modules.readFamilyEffectDeclaration = readFamilyEffectDeclaration;
  const verifyApprovedAssetBytes = fn<CompilerModules['verifyApprovedAssetBytes']>(assets.verifyApprovedAssetBytes);
  if (verifyApprovedAssetBytes) modules.verifyApprovedAssetBytes = verifyApprovedAssetBytes;
  const dishonestLinks = fn<CompilerModules['dishonestLinks']>(sections?.dishonestLinks);
  if (dishonestLinks) modules.dishonestLinks = dishonestLinks;
  const selfSectionAnchors = fn<CompilerModules['selfSectionAnchors']>(sections?.selfSectionAnchors);
  if (selfSectionAnchors) modules.selfSectionAnchors = selfSectionAnchors;
  return {
    compiler: {
      family, modules, approvedAssets, reference, schema,
      // A copy without resources.ts reads its own files while rendering; it gets no table.
      resources: withCompilerResources ? collectCompilerResources(scripts) : Object.freeze({}),
    },
    packageDir,
    assetsDir: path.join(familyDir, 'assets'),
    readApprovedAsset: assets.readApprovedAsset,
  };
}

/** An `AssetResolver` that reads each roster file from `root` (default: the package's `assetsDir`) with the copy's verified reader. */
export function directoryAssetResolver(loaded: LoadedFamilyPackage, root: string = loaded.assetsDir): AssetResolver {
  return (asset) => loaded.readApprovedAsset(root, asset);
}
