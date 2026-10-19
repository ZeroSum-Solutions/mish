/**
 * The publisher: one family compiler plus explicit inputs in, deterministic static files out.
 *
 * Nothing here reads the filesystem, the environment or the clock. The compiler's static
 * resources arrive in the `FamilyCompiler`, the page content in the spec, the brand in the brand
 * tokens and every asset's bytes through the caller's resolver. Equal inputs give equal bytes.
 */

import { createHash } from 'node:crypto';
import { finishBookingEmbeds, parseBookingEmbeds, spliceBookingEmbeds, type BookingEmbed } from './booking-embed.ts';
import type {
  ApprovedAsset, ArtifactManifest, EffectPlan, EffectRenderReport, FamilyCompiler, FamilyEffectDeclaration, Json, JsonObject,
  RenderOptions, RenderResult, ResolvedAsset,
} from './types.ts';

export type PublisherErrorCode = 'unsealed-compiler' | 'invalid-spec' | 'invalid-brand-tokens' | 'missing-asset-resolver' | 'asset-rejected';

export class PublisherError extends Error {
  readonly code: PublisherErrorCode;
  constructor(code: PublisherErrorCode, message: string) {
    super(message);
    this.name = 'PublisherError';
    this.code = code;
  }
}

/** The page content: a family recipe (schemaVersion 2 typed section JSON) and its typed slots. */
export type SiteSpec = {
  recipe: JsonObject;
  /** Effect placements the compiler applies after rendering (see the fast lane's `effects.ts`). */
  effects?: EffectPlan;
  /** Booking widget sections, spliced in before effects apply; script-mode widget scripts are added after. */
  bookingEmbeds?: readonly BookingEmbed[];
};

/**
 * Brand fields kept apart from the section content, so a release can store and edit them on their
 * own. They replace the same keys of `recipe.brand` before the family validates the recipe; the
 * family's schema decides which keys exist (the public families take `name` and `descriptor`).
 */
export type BrandTokens = Readonly<Record<string, Json>>;

/** Returns the bytes of one approved asset the page uses. Called once per asset, in roster order. */
export type AssetResolver = (asset: ResolvedAsset) => Uint8Array | Promise<Uint8Array>;

export type CompileInput = {
  compiler: FamilyCompiler;
  spec: SiteSpec;
  brandTokens?: BrandTokens;
  assets?: {
    /** The approved roster to render against. Default: the compiler's own `approvedAssets`. */
    manifest?: JsonObject;
    /** Required when the page uses any asset. */
    resolve?: AssetResolver;
  };
  /** The page file name. Default `index.html`. */
  entry?: string;
};

export type PublishedFile = { path: string; mediaType: string; bytes: Uint8Array; sha256: string };

export type CompileResult = {
  entry: string;
  /** The entry HTML (styles inlined) and every asset it references, sorted by path. */
  files: PublishedFile[];
  /** SHA-256 over the sorted `path` and `sha256` of every file: one id for the whole output. */
  digest: string;
  /** The compiler's artifact manifest for the entry. */
  manifest: ArtifactManifest;
  /** The recipe as the family validated it, brand tokens applied. */
  recipe: Json;
  effects?: EffectRenderReport;
};

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', mp4: 'video/mp4',
};
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Whether the compiler copy can render from its supplied resources alone (it ships `resources.ts`). */
export function isSealed(compiler: FamilyCompiler): boolean {
  return typeof compiler.modules.withCompilerResources === 'function';
}

/** Runs `fn` inside the compiler's resource scope, or directly for a copy that predates it. */
function inScope<T>(compiler: FamilyCompiler, fn: () => T): T {
  const scope = compiler.modules.withCompilerResources;
  return scope ? scope(compiler.resources, fn) : fn();
}

/**
 * Renders one page synchronously: the compiler's `renderAgencySite` inside its resource scope.
 * This is the call the fast lane and the daemon make for every draft. `approvedAssets` overrides
 * the compiler's roster for this render.
 */
export function renderPage(compiler: FamilyCompiler, input: Json, entry: string, options: RenderOptions & { approvedAssets?: JsonObject } = {}): RenderResult {
  const manifest = options.approvedAssets ?? compiler.approvedAssets;
  const render = compiler.modules.renderAgencySite;
  return inScope(compiler, () => (options.effects || options.compose
    ? render(input, entry, manifest, { ...(options.effects ? { effects: options.effects } : {}), ...(options.compose ? { compose: options.compose } : {}) })
    : render(input, entry, manifest)));
}

/** The family's effect placements, read inside the resource scope; `null` when it declares none. */
export function readEffectDeclaration(compiler: FamilyCompiler): FamilyEffectDeclaration | null {
  const read = compiler.modules.readFamilyEffectDeclaration;
  const declaration = read ? inScope(compiler, () => read(compiler.family)) ?? null : null;
  // The compiler caches its parse and renders with it; a caller's edit to a copy cannot reach it.
  return declaration === null ? null : structuredClone(declaration);
}

/** The shared link-honesty check of the compiler copy, when it ships one. */
export function linkHonestyCheck(compiler: FamilyCompiler): ((html: string) => string[]) | undefined {
  const { dishonestLinks, selfSectionAnchors } = compiler.modules;
  if (!dishonestLinks && !selfSectionAnchors) return undefined;
  return (html) => [...(dishonestLinks?.(html) ?? []), ...(selfSectionAnchors?.(html) ?? [])];
}

/** `recipe` with `brandTokens` written over `recipe.brand`. Neither input is changed. */
export function applyBrandTokens(recipe: JsonObject, brandTokens: BrandTokens | undefined): JsonObject {
  const copy = structuredClone(recipe);
  if (brandTokens === undefined) return copy;
  if (!isObject(brandTokens as unknown)) throw new PublisherError('invalid-brand-tokens', 'brandTokens must be an object');
  const brand = copy.brand;
  if (!isObject(brand)) throw new PublisherError('invalid-brand-tokens', 'spec.recipe.brand must be an object to take brand tokens');
  for (const key of Object.keys(brandTokens).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new PublisherError('invalid-brand-tokens', `brandTokens.${key} is not allowed`);
    brand[key] = structuredClone(brandTokens[key]!);
  }
  return copy;
}

function mediaTypeOf(asset: ApprovedAsset): string {
  return asset.mediaType ?? MEDIA_TYPES[asset.file.slice(asset.file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Compiles one page to static files. Refuses a compiler copy that would read its own files
 * (`unsealed-compiler`), so a headless caller never touches the disk by accident.
 */
export async function compile(input: CompileInput): Promise<CompileResult> {
  const { compiler, spec } = input;
  if (!isSealed(compiler)) throw new PublisherError('unsealed-compiler', `${compiler.family}: this compiler copy has no resources.ts, so it would read its own files; sync it from plugins/_official/shared/agency-compiler`);
  if (!isObject(spec as unknown) || !isObject(spec.recipe)) throw new PublisherError('invalid-spec', 'spec.recipe must be a recipe object');
  if (spec.bookingEmbeds !== undefined && !Array.isArray(spec.bookingEmbeds)) throw new PublisherError('invalid-spec', 'spec.bookingEmbeds must be an array');
  const entry = input.entry ?? 'index.html';
  const recipe = applyBrandTokens(spec.recipe, input.brandTokens);
  const embeds = spec.bookingEmbeds ?? [];
  // Checked up front, so a bad slot fails before rendering, whatever the family does with `compose`.
  parseBookingEmbeds(embeds);
  const rendered = renderPage(compiler, recipe, entry, {
    ...(spec.effects ? { effects: spec.effects } : {}),
    ...(embeds.length > 0 ? { compose: (html: string) => spliceBookingEmbeds(html, embeds) } : {}),
    ...(input.assets?.manifest ? { approvedAssets: input.assets.manifest } : {}),
  });

  const html = embeds.length > 0 ? finishBookingEmbeds(rendered.html, embeds) : rendered.html;
  const files: PublishedFile[] = [{ path: entry, mediaType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(html), sha256: sha256(html) }];
  if (rendered.approvedAssets.length > 0) {
    const resolve = input.assets?.resolve;
    if (!resolve) throw new PublisherError('missing-asset-resolver', `${compiler.family}: the page uses ${rendered.approvedAssets.length} asset(s) but no assets.resolve was given`);
    const verify = compiler.modules.verifyApprovedAssetBytes;
    if (!verify) throw new PublisherError('unsealed-compiler', `${compiler.family}: this compiler copy cannot verify asset bytes (no verifyApprovedAssetBytes)`);
    for (const asset of rendered.approvedAssets) {
      const returned = await resolve(asset);
      if (!(returned instanceof Uint8Array)) throw new PublisherError('asset-rejected', `asset ${asset.id}: the resolver must return a Uint8Array`);
      const bytes = new Uint8Array(returned);
      try { verify(asset, bytes); } catch (error) {
        throw new PublisherError('asset-rejected', error instanceof Error ? error.message : String(error));
      }
      files.push({ path: asset.destination, mediaType: mediaTypeOf(asset), bytes, sha256: sha256(bytes) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
  return {
    entry, files, digest, manifest: rendered.manifest, recipe: rendered.recipe,
    ...(rendered.effects ? { effects: rendered.effects } : {}),
  };
}
