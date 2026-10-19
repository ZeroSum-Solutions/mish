/**
 * Loads an Agency Site family package: its trusted compiler (imported in-process), the
 * reference recipe that serves as the default spine, the recipe JSON schema, and the approved
 * asset manifest with its files.
 *
 * Loading and rendering go through the publisher library (`@mish/publisher`): its Node loader
 * reads the package once, and every render runs from the resources it read, the same call a
 * headless server makes. This file adds the fast lane's own parts: `--asset` overrides and the
 * quality checks `run.ts` calls.
 */

import { checkRenderQuality, type RenderQualityReport } from './render-quality.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { linkHonestyCheck, readEffectDeclaration, renderPage, type FamilyCompiler } from '@mish/publisher';
import { loadFamilyCompiler } from '@mish/publisher/node';
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
  /**
   * The package as the publisher sees it, with `--asset` overrides applied to its roster. Absent
   * on a hand-built test package.
   */
  compiler?: FamilyCompiler;
  render(input: Json, entry: string, options?: RenderOptions): RenderResult;
  readAsset(asset: ApprovedAsset): Promise<Buffer>;
};

/** Bundled family packages live under plugins/_official/examples/agency-<family>. */
export function defaultPackageDir(family: string): string {
  return path.resolve(import.meta.dirname, '../../../plugins/_official/examples', `agency-${family}`);
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
  const loaded = await loadFamilyCompiler(packageDir, family);
  const manifest = await withAssetOverrides(loaded.compiler.approvedAssets, assetOverrides);
  const compiler: FamilyCompiler = { ...loaded.compiler, approvedAssets: manifest };
  // A copy without effects.ts (synced before effect placements existed) declares none; a
  // declaration that does not validate throws here, so a broken catalog.json fails loudly.
  const effects = readEffectDeclaration(compiler) as FamilyEffectDeclaration | null;
  // `dishonestLinks` composed with `selfSectionAnchors` from the copy's `sections.ts` (a `#`
  // placeholder, a scheme-only href, an anchor to an id nothing owns, or a button that only
  // scrolls to the top of its own block). A copy that predates the gate has neither, and
  // `run.ts` skips the check for it.
  const checkLinkHonesty = linkHonestyCheck(compiler);
  return {
    family,
    packageDir,
    fixture: compiler.reference,
    schema: compiler.schema,
    manifest,
    assetsDir: loaded.assetsDir,
    effects,
    ...(checkLinkHonesty ? { checkLinkHonesty } : {}),
    checkRenderQuality,
    compiler,
    // The plan goes to the compiler as is; it validates every item against the declaration.
    render: (input, entry, options) => renderPage(compiler, input, entry, options) as RenderResult,
    readAsset: (asset) => {
      const override = assetOverrides[asset.id];
      return loaded.readApprovedAsset(override ? path.dirname(path.resolve(override)) : loaded.assetsDir, asset);
    },
  };
}
