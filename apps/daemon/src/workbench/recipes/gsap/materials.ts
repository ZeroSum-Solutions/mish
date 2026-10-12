import { observeComponentTokens } from '../../component-token-evidence.js';
import { createHash } from 'node:crypto';
import type { ResourceCandidate, ResourceRef, ResourceSourceSnapshot } from '@open-design/contracts';
import type { CatalogueMaterial, CatalogueMaterialFile, CatalogueMaterialSource } from '../../adoption/catalogue-material.js';
import { AdoptionError } from '../../placement/adoption-executor.js';
import { canonicalJson } from '../../placement/adoption-plan.js';
import type { ResourceSourceAdapter } from '../../resources.js';
import { GSAP_RECIPE_IDS, GSAP_RECIPES, type GsapRecipe, type GsapRecipeId } from './recipes.js';
import { GSAP_PIN, GSAP_RANGE, GSAP_REACT_PIN, GsapRuntimeError, gsapNotice, loadGsapRuntime, type GsapRuntime, type GsapRuntimeFile } from './runtime.js';

export type GsapRecipeTarget = 'html' | 'react';
const TARGET_ADAPTER = { html: 'html-artifact/v1', react: 'react-source/v1' } as const;
export const gsapItemId = (id: GsapRecipeId, target: GsapRecipeTarget) => `${id}-${target}`;
export const gsapPreviewPath = (itemId: string) => `/api/workbench/recipes/gsap/${encodeURIComponent(itemId)}/preview`;

/** `section-entrance-html` → recipe and target; anything else is unknown, never guessed. */
export function parseGsapItemId(itemId: string): { recipe: GsapRecipe; target: GsapRecipeTarget } | null {
  const match = /^(.+)-(html|react)$/u.exec(itemId);
  if (!match || !(GSAP_RECIPE_IDS as readonly string[]).includes(match[1]!)) return null;
  return { recipe: GSAP_RECIPES[match[1] as GsapRecipeId], target: match[2] as GsapRecipeTarget };
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const unitStem = (recipe: GsapRecipe) => `gsap-${recipe.id}`;
const runtimeFilesOf = (recipe: GsapRecipe): GsapRuntimeFile[] => ['gsap', ...recipe.plugins];

function htmlDocument(recipe: GsapRecipe, scripts: readonly string[], head: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${recipe.title}</title>`,
    head,
    '</head>',
    '<body>',
    '<main>',
    recipe.html.markup,
    '</main>',
    ...scripts,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Standalone editable unit: page, stylesheet, recipe script and only the runtime files it registers, all local and flat in the target directory. */
function htmlFiles(recipe: GsapRecipe, runtime: GsapRuntime): CatalogueMaterialFile[] {
  const stem = unitStem(recipe);
  const runtimeFiles = runtimeFilesOf(recipe).map(file => ({ path: `${stem}.${runtime.files[file].name}`, role: 'asset' as const, bytes: runtime.files[file].bytes }));
  const page = htmlDocument(recipe, [...runtimeFiles.map(file => `<script src="./${file.path}"></script>`), `<script src="./${stem}.js"></script>`], `<link rel="stylesheet" href="./${stem}.css">`);
  return [
    { path: `${stem}.html`, role: 'source', bytes: Buffer.from(page) },
    { path: `${stem}.css`, role: 'style', bytes: Buffer.from(recipe.html.css) },
    { path: `${stem}.js`, role: 'source', bytes: Buffer.from(recipe.html.script) },
    ...runtimeFiles,
  ];
}

/** An inline `<script>` body must not close its element early. */
const inlineScript = (code: string) => `<script>\n${code.replace(/<\/script/giu, '<\\/script')}\n</script>`;

/**
 * The isolated preview document: the same markup, stylesheet and recipe
 * script as the HTML unit, with the pinned runtime inline, so the preview
 * needs no network and no host privilege.
 */
export function renderGsapPreview(recipe: GsapRecipe, runtime: GsapRuntime): string {
  const scripts = [...runtimeFilesOf(recipe).map(file => inlineScript(runtime.files[file].bytes.toString('utf8'))), inlineScript(recipe.html.script)];
  return htmlDocument(recipe, scripts, `<style>\n${recipe.html.css}</style>`);
}
/** Response policy for the preview: a sandboxed (opaque-origin) document with inline script and style only, no network, no navigation. */
export const GSAP_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export interface GsapRecipeMaterials extends CatalogueMaterialSource {
  readonly itemIds: readonly string[];
  /** The isolated preview document of an HTML item, or null for unknown and React items. */
  preview(itemId: string): Promise<string | null>;
}

/**
 * AC-R08.5: GSAP recipes as an admitted catalogue material source. Apply goes
 * through the existing catalogue adoption manager and F5 executor: rights,
 * notice, dependency, target and replacement-review gates, then plan → apply →
 * undo. React items declare `gsap` and `@gsap/react` as project dependencies
 * (checked, never installed) and land only in a `react-source/v1` target.
 */
export function createGsapRecipeMaterials(options: { runtime?: () => GsapRuntime } = {}): GsapRecipeMaterials {
  let cached: GsapRuntime | null = null;
  const runtime = (): GsapRuntime => {
    if (options.runtime) return options.runtime();
    cached ??= loadGsapRuntime();
    return cached;
  };
  const itemIds = GSAP_RECIPE_IDS.flatMap(id => [gsapItemId(id, 'html'), gsapItemId(id, 'react')]);
  return {
    sourceId: 'gsap',
    itemIds,
    async materialize(itemId: string): Promise<CatalogueMaterial | null> {
      const parsed = parseGsapItemId(itemId);
      if (!parsed) return null;
      const { recipe, target } = parsed;
      let loaded: GsapRuntime;
      try { loaded = runtime(); } catch (error) {
        if (error instanceof GsapRuntimeError) throw new AdoptionError(422, error.reason, `${error.message}; nothing was prepared`);
        throw error;
      }
      const files: CatalogueMaterialFile[] = target === 'html'
        ? htmlFiles(recipe, loaded)
        : [{ path: `${recipe.component}.tsx`, role: 'source', bytes: Buffer.from(recipe.react) }];
      const packageDependencies = target === 'react' ? [{ name: GSAP_PIN.packageName, range: GSAP_RANGE }, { name: GSAP_REACT_PIN.packageName, range: GSAP_REACT_PIN.range }] : [];
      const revision = sha256(canonicalJson({
        source: 'gsap-recipe/1', item: itemId, adapter: TARGET_ADAPTER[target], runtime: GSAP_PIN.version,
        files: files.map(file => ({ path: file.path, role: file.role, sha256: sha256(file.bytes) })), packageDependencies,
      }));
      const ref: ResourceRef = { sourceType: 'library', sourceId: 'gsap', itemId, revisionOrDigest: `sha256:${revision}` };
      return {
        ref, title: `${recipe.title} (${target === 'html' ? 'HTML' : 'React'})`, origin: 'adapted', files, packageDependencies,
        target: TARGET_ADAPTER[target],
        // Sol B5/6 WARN: the installed GSAP and the declared range's lower bound must reach each minimum, not only its major.
        ...(target === 'react' ? { dependencyMinimums: [{ name: GSAP_PIN.packageName, minimum: GSAP_RANGE.replace(/^\^/u, '') }, { name: GSAP_REACT_PIN.packageName, minimum: GSAP_REACT_PIN.range.replace(/^\^/u, '') }] } : {}),
        noticeFor: written => gsapNotice(written.filter(file => file.role === 'asset').map(file => ({ path: file.path, sha256: sha256(file.bytes) }))),
        rights: { status: 'permitted', licence: GSAP_PIN.licence, notice: gsapNotice(files.filter(file => file.role === 'asset').map(file => ({ path: file.path, sha256: sha256(file.bytes) }))), sourceUrl: `${GSAP_PIN.repository}/tree/${GSAP_PIN.commit}`, packageName: `${GSAP_PIN.packageName}@${GSAP_PIN.version}` },
      };
    },
    async preview(itemId: string): Promise<string | null> {
      const parsed = parseGsapItemId(itemId);
      if (!parsed || parsed.target !== 'html') return null;
      return renderGsapPreview(parsed.recipe, runtime());
    },
  };
}

/**
 * Discovery and inspect for the recipes. Rights cover host preview,
 * incorporation, private reuse and finished-project export under the GSAP
 * standard licence; reusable-source redistribution stays unknown. Readiness
 * stays `unverified` until a per-item acceptance receipt exists.
 */
export function createGsapResourceSource(materials: GsapRecipeMaterials): ResourceSourceAdapter {
  return {
    sourceId: 'gsap',
    async list(): Promise<ResourceSourceSnapshot> {
      const items: ResourceCandidate[] = [];
      try {
        for (const itemId of materials.itemIds) {
          const material = await materials.materialize(itemId);
          const parsed = parseGsapItemId(itemId);
          if (!material || !parsed) continue;
          const { recipe, target } = parsed;
          const html = target === 'html' ? null : await materials.materialize(gsapItemId(recipe.id, 'html'));
          items.push({
            ref: material.ref, title: material.title, category: 'motion', readiness: 'unverified',
            componentTokenEvidence: observeComponentTokens(material.ref, material.files),
            componentAdapter: TARGET_ADAPTER[target],
            compatibility: {
              nativeFormat: target === 'html' ? 'html' : 'tsx', targets: [target], state: 'unverified',
              reason: target === 'html'
                ? 'html-artifact/v1: standalone editable HTML unit with local GSAP runtime files; fits any project kind'
                : `react-source/v1: needs React 17+, react-dom, ${GSAP_PIN.packageName} ${GSAP_RANGE} and ${GSAP_REACT_PIN.packageName} ${GSAP_REACT_PIN.range} in the project manifest`,
            },
            rightsStatus: 'permitted',
            fitReasons: [
              `Purpose: ${recipe.purpose}`,
              `Plugins: ${recipe.plugins.length ? recipe.plugins.join(', ') : 'none (GSAP core only)'}`,
              `Trigger: ${recipe.trigger}`,
              `Reduced motion: ${recipe.reducedMotion}`,
              `Cleanup: ${recipe.cleanup}`,
              `Adapter: ${TARGET_ADAPTER[target]} · GSAP ${GSAP_PIN.version}${target === 'react' ? ` · ${GSAP_REACT_PIN.packageName} ${GSAP_REACT_PIN.version}` : ''}`,
            ],
            previewCapability: target === 'html'
              ? { available: true, kind: 'html', url: gsapPreviewPath(itemId), reason: null }
              : { available: false, kind: 'none', reason: 'react-preview-adapter-pending' },
            adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
            sourceAttribution: { title: `GSAP ${GSAP_PIN.version} · ${recipe.title}`, url: `${GSAP_PIN.repository}/tree/${GSAP_PIN.commit}` },
            implementationOrigin: 'adapted', variantGroup: `gsap/${recipe.id}`, variantLabel: target === 'html' ? 'HTML' : 'React',
            // AC-R07: what each target variant brings into the project.
            targetDependencies: target === 'html'
              ? [{ name: GSAP_PIN.packageName, range: GSAP_PIN.version, scope: 'bundled' }]
              : [{ name: 'react', range: '>=17', scope: 'project' }, { name: 'react-dom', range: '>=17', scope: 'project' }, { name: GSAP_PIN.packageName, range: GSAP_RANGE, scope: 'project' }, { name: GSAP_REACT_PIN.packageName, range: GSAP_REACT_PIN.range, scope: 'project' }],
            ...(html ? { relatedRefs: [{ ref: html.ref, relation: 'same-recipe-html' }] } : {}),
            motionMetadata: { state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: material.ref.revisionOrDigest, field: 'recipe matchMedia (prefers-reduced-motion: reduce) static branch' },
            operationGrants: [
              { operation: 'host-preview', state: 'permitted', reason: null },
              { operation: 'incorporation', state: 'permitted', reason: null },
              { operation: 'private-reuse', state: 'permitted', reason: null },
              { operation: 'export', state: 'permitted', reason: null },
              { operation: 'redistribution', state: 'unknown', reason: 'GSAP standard licence: reusable-source redistribution is not assessed' },
            ],
            admissionStage: 'admitted', needDecision: 'required',
            needReason: 'Owner-confirmed recurring need (R08, candidate 40); applied only when a project selects it',
          });
        }
      } catch (error) {
        // Only a missing or mismatched pinned runtime is "unavailable"; every other failure is a real error.
        if (!(error instanceof AdoptionError) || !['gsap-runtime-missing', 'gsap-runtime-version-mismatch'].includes(error.reason)) throw error;
        return { items: [], status: { sourceId: 'gsap', state: 'unavailable', reason: error.reason, itemCount: null, listingDigest: null } };
      }
      const listingDigest = sha256(canonicalJson(items.map(item => item.ref)));
      return { items, status: { sourceId: 'gsap', state: 'searched', reason: null, itemCount: items.length, listingDigest } };
    },
  };
}
