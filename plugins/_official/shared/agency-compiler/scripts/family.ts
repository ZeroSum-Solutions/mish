import { createHash } from 'node:crypto';
import { resolveApprovedAssets, type AssetRequirement } from './assets.ts';
import { FAMILIES } from './families/registry.ts';
import { applyEffectPlan, readFamilyEffectDeclaration, type EffectPlan, type EffectRenderReport } from './effects.ts';
import { assertRenderedOutputScope, type FamilyRenderOptions, type OutputScope } from './output-scope.ts';

// Trusted dispatch through the generated `families/registry.ts`. Shared: edit
// plugins/_official/shared/agency-compiler, then sync. Rationale: that folder's README.md.
export type FamilyRecipe = { revision: number; brand: { name: string } };
export type FamilyModule = {
  validate: (input: unknown) => FamilyRecipe;
  requirements: (recipe: never) => AssetRequirement[];
  render: (recipe: never, resolvedAssetPaths: Readonly<Record<string, string>>, options: FamilyRenderOptions) => string;
  outputScope: OutputScope;
};

/**
 * `compose` splices caller-owned markup (the fast lane's selected section) into the family page
 * BEFORE the effect plan applies, so `applyEffectPlan` sees, and budgets, the final composed page.
 * The result then carries `composed: true`.
 */
export type RenderFamilyOptions = { effects?: EffectPlan; compose?: (html: string) => string };

export function renderFamily(input: unknown, entry: string, approvedManifest: unknown, options?: RenderFamilyOptions) {
  const family = (input as { family?: unknown })?.family;
  if (typeof family !== 'string' || !Object.hasOwn(FAMILIES, family)) throw new Error('Unknown Agency Site family');
  const module = FAMILIES[family]!;
  const recipe = module.validate(input);
  const requirements = module.requirements(recipe as never);
  const revision = `${family}-r${recipe.revision}`;
  const resolved = resolveApprovedAssets(approvedManifest, requirements, revision);
  const outputScope = module.outputScope;
  let html = module.render(recipe as never, resolved.paths, { outputScope });
  assertRenderedOutputScope(html, outputScope, family);
  if (options?.compose) {
    html = options.compose(html);
    assertRenderedOutputScope(html, outputScope, family);
  }
  let effects: EffectRenderReport | undefined;
  if (options?.effects) {
    // A family without an `effects` declaration offers no placement: every item is skipped.
    ({ html, report: effects } = applyEffectPlan(html, options.effects, readFamilyEffectDeclaration(family)));
    assertRenderedOutputScope(html, outputScope, family);
  }
  const supportingFiles = resolved.assets.map((asset) => asset.destination);
  const manifest = { version: 1, kind: 'html', renderer: 'html', title: recipe.brand.name, entry, status: 'complete', exports: ['html', 'pdf', 'zip'], sourceSkillId: 'agency-site', supportingFiles, metadata: { agencySite: { version: 1, publication: 'closed-assets-v2', recipeDigest: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), rendererVersion: '2.0.0', revision, family, recipeSchemaVersion: 2, outputScope } } };
  return { recipe, html, manifest, approvedAssets: resolved.assets, ...(effects ? { effects } : {}), ...(options?.compose ? { composed: true as const } : {}) };
}
