/**
 * A hand-built sealed compiler whose page uses three PNG assets, for the resolver path. The public
 * family packages ship no image assets, so this drives `compile`'s asset handling with the shared
 * compiler's real `verifyApprovedAssetBytes`.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FamilyCompiler, RenderResult, ResolvedAsset } from '../src/types.ts';
import { SHARED_COMPILER } from './helpers.ts';

const { verifyApprovedAssetBytes } = await import(pathToFileURL(path.join(SHARED_COMPILER, 'assets.ts')).href) as { verifyApprovedAssetBytes: NonNullable<FamilyCompiler['modules']['verifyApprovedAssetBytes']> };

/** A minimal valid PNG signature followed by `seed` filler bytes. */
export const png = (seed: number): Buffer => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, seed)]);

export const ASSETS: ResolvedAsset[] = ['c-gallery', 'a-hero', 'b-logo'].map((id, index) => {
  const bytes = png(index + 1);
  return { id, file: `${id}.png`, kind: 'image', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), destination: `assets/${id}.png` };
});

export const bytesById = new Map(ASSETS.map((asset, index) => [asset.id, png(index + 1)]));

/** A sealed compiler placing `assets` on its page (default: all three). */
export function assetCompiler(assets: ResolvedAsset[] = ASSETS): FamilyCompiler {
  return {
    family: 'fixture', resources: {}, approvedAssets: { version: 1, assets: [] }, reference: { family: 'fixture' }, schema: {},
    modules: {
      withCompilerResources: (_resources, fn) => fn(),
      verifyApprovedAssetBytes,
      renderAgencySite: (_input, entry): RenderResult => ({
        recipe: { family: 'fixture' }, html: '<!doctype html><html><body><main></main></body></html>\n', approvedAssets: assets,
        manifest: { entry, supportingFiles: assets.map((asset) => asset.destination), metadata: { agencySite: { recipeDigest: '', revision: 'fixture-r1', family: 'fixture' } } },
      }),
    },
  };
}
