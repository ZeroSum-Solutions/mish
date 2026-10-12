/**
 * Loads an Agency Site family package: its trusted compiler (imported in-process), the
 * reference recipe that serves as the default spine, the recipe JSON schema, and the approved
 * asset manifest with its files.
 */

import { checkRenderQuality, type RenderQualityReport } from './render-quality.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EffectPlan, EffectRenderReport, FamilyEffectDeclaration } from './effects.ts';
import { isObject, type Json, type JsonObject } from './spine.ts';

export type ApprovedAsset = { id: string; file: string; kind: string; sha256?: string; mediaType?: string; bytes?: number };
export type ResolvedAsset = ApprovedAsset & { destination: string };
export type ArtifactManifest = JsonObject & {
  entry: string;
  supportingFiles: string[];
  metadata: { agencySite: { recipeDigest: string; revision: string; family: string; outputScope?: 'site' | 'static-prototype' } };
};
/** `effects` is the compiler's report when a render was given an effect plan (see `effects.ts`). */
export type RenderResult = { recipe: Json; html: string; manifest: ArtifactManifest; approvedAssets: ResolvedAsset[]; effects?: EffectRenderReport; composed?: boolean };

/**
 * Options every render takes: the effect plan the compiler applies after rendering the family, and
 * `compose`, markup the compiler splices in BEFORE the plan (the selected section), so the plan's
 * byte budget covers the composed page. A compiler that ran `compose` returns `composed: true`.
 */
export type RenderOptions = { effects?: EffectPlan; compose?: (html: string) => string };

export type FamilyPackage = {
  family: string;
  packageDir: string;
  /** The package's reference recipe: the default spine. */
  fixture: JsonObject;
  schema: JsonObject;
  manifest: JsonObject;
  assetsDir: string;
  /**
   * The family's effect placements (`families/<family>/catalog.json` → `effects`), read through
   * the compiler copy's own `readFamilyEffectDeclaration`; `null` when the family declares none,
   * or the copy predates effect placements. Optional so a hand-built test package need not name it.
   */
  effects?: FamilyEffectDeclaration | null;
  /**
   * `sections.ts`'s `dishonestLinks(html)` for this family's compiler copy, when that shared file
   * is present (every bundled site family has it as of the link-honesty gate) — `undefined` for a
   * hand-built test package or a compiler copy that predates it. Family-agnostic on purpose: this
   * is the SAME shared check every family shares, exposed here only so `run.ts` can call it
   * without importing a specific family's compiler path itself.
   */
  checkLinkHonesty?: (html: string) => string[];
  checkRenderQuality?: (html: string, scope?: 'site' | 'static-prototype') => RenderQualityReport;
  render(input: Json, entry: string, options?: RenderOptions): RenderResult;
  readAsset(asset: ApprovedAsset): Promise<Buffer>;
};

type RenderModule = { renderAgencySite: (input: unknown, entry: string, approvedManifest?: unknown, options?: RenderOptions) => RenderResult };
type EffectsModule = { readFamilyEffectDeclaration: (family: string) => FamilyEffectDeclaration | null };
type SectionsModule = { dishonestLinks?: (html: string) => string[]; selfSectionAnchors?: (html: string) => string[] };

/**
 * The family's link-honesty check, loaded from its compiler copy's `sections.ts` when present:
 * `dishonestLinks` (a `#` placeholder, a scheme-only href, or an anchor to an id nothing on the
 * page owns) COMPOSED with `selfSectionAnchors` (an `<a href="#own-section">` — a button that
 * only scrolls to the top of the block it already sits in, invisible to `dishonestLinks` alone
 * since the id genuinely exists — see that function's own docblock, added after a Grok audit
 * found six families shipping exactly this as a placeholder). Missing the file, or the file
 * exporting neither, is not an error — it just means this compiler copy predates the link-honesty
 * gate, and `run.ts` skips the check for it.
 */
async function loadLinkHonestyCheck(scripts: string): Promise<((html: string) => string[]) | undefined> {
  const file = path.join(scripts, 'sections.ts');
  if (!existsSync(file)) return undefined;
  const module = await import(pathToFileURL(file).href) as SectionsModule;
  const dishonest = typeof module.dishonestLinks === 'function' ? module.dishonestLinks : undefined;
  const selfAnchors = typeof module.selfSectionAnchors === 'function' ? module.selfSectionAnchors : undefined;
  if (!dishonest && !selfAnchors) return undefined;
  return (html: string) => [...(dishonest?.(html) ?? []), ...(selfAnchors?.(html) ?? [])];
}

/**
 * The family's effect declaration through the compiler copy's `effects.ts`. A copy without that
 * module (synced before effect placements existed) declares none; any other failure — a
 * declaration that does not validate — is thrown, so a broken catalog.json fails loudly.
 */
async function loadEffectDeclaration(scripts: string, family: string): Promise<FamilyEffectDeclaration | null> {
  const file = path.join(scripts, 'effects.ts');
  if (!existsSync(file)) return null;
  const module = await import(pathToFileURL(file).href) as EffectsModule;
  if (typeof module.readFamilyEffectDeclaration !== 'function') return null;
  return module.readFamilyEffectDeclaration(family) ?? null;
}
type AssetsModule = { readApprovedAsset: (root: string, asset: ApprovedAsset) => Promise<Buffer> };

/** Bundled family packages live under plugins/_official/examples/agency-<family>. */
export function defaultPackageDir(family: string): string {
  return path.resolve(import.meta.dirname, '../../../plugins/_official/examples', `agency-${family}`);
}

async function readJson(file: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Json;
  if (!isObject(value)) throw new Error(`${file}: expected a JSON object`);
  return value;
}

const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

/**
 * Replace approved image assets by id with files supplied by the caller (a client wordmark, a
 * new hero frame). Each replacement gets a fresh manifest entry with its own size and digest;
 * the compiler still verifies the bytes when it reads them.
 */
async function withAssetOverrides(manifest: JsonObject, overrides: Record<string, string>): Promise<JsonObject> {
  const entries = Object.entries(overrides);
  if (entries.length === 0) return manifest;
  const assets = Array.isArray(manifest.assets) ? [...manifest.assets] : [];
  for (const [id, file] of entries) {
    const index = assets.findIndex((asset) => isObject(asset) && asset.id === id);
    if (index < 0) throw new Error(`--asset ${id}: no approved asset with that id`);
    const current = assets[index] as JsonObject;
    const basename = path.basename(file);
    const extension = path.extname(basename).slice(1).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.(png|jpe?g|webp|avif)$/.test(basename) || !MEDIA_TYPES[extension]) {
      throw new Error(`--asset ${id}: file name must be lowercase letters, digits and hyphens with a raster suffix`);
    }
    if (current.kind !== 'image') throw new Error(`--asset ${id}: only image assets can be replaced`);
    const bytes = await readFile(file);
    if (bytes.length > 10 * 1024 * 1024) throw new Error(`--asset ${id}: file exceeds 10 MB`);
    assets[index] = { id, file: basename, kind: 'image', mediaType: MEDIA_TYPES[extension]!, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  return { ...manifest, assets };
}

export async function loadFamilyPackage(packageDir: string, family: string, assetOverrides: Record<string, string> = {}): Promise<FamilyPackage> {
  if (!/^[a-z][a-z0-9-]*$/.test(family)) throw new Error('family: use a lowercase id');
  const scripts = path.join(packageDir, 'compiler', 'scripts');
  const familyDir = path.join(packageDir, 'families', family);
  const [fixture, schema, packageManifest, renderModule, assetsModule, effects, checkLinkHonesty] = await Promise.all([
    readJson(path.join(familyDir, 'recipe.json')),
    readJson(path.join(scripts, 'families', family, 'recipe.schema.json')),
    readJson(path.join(familyDir, 'approved-assets.json')),
    import(pathToFileURL(path.join(scripts, 'render.ts')).href) as Promise<RenderModule>,
    import(pathToFileURL(path.join(scripts, 'assets.ts')).href) as Promise<AssetsModule>,
    loadEffectDeclaration(scripts, family),
    loadLinkHonestyCheck(scripts),
  ]);
  if (fixture.family !== family) throw new Error(`${familyDir}/recipe.json is for family ${String(fixture.family)}, not ${family}`);
  const manifest = await withAssetOverrides(packageManifest, assetOverrides);
  const assetsDir = path.join(familyDir, 'assets');
  return {
    family,
    packageDir,
    fixture,
    schema,
    manifest,
    assetsDir,
    effects,
    ...(checkLinkHonesty ? { checkLinkHonesty } : {}),
    checkRenderQuality,
    // The plan goes to the compiler as is; it validates every item against the declaration.
    render: (input, entry, options) => (options?.effects || options?.compose
      ? renderModule.renderAgencySite(input, entry, manifest, { ...(options.effects ? { effects: options.effects } : {}), ...(options.compose ? { compose: options.compose } : {}) })
      : renderModule.renderAgencySite(input, entry, manifest)),
    readAsset: (asset) => {
      const override = assetOverrides[asset.id];
      return assetsModule.readApprovedAsset(override ? path.dirname(path.resolve(override)) : assetsDir, asset);
    },
  };
}
