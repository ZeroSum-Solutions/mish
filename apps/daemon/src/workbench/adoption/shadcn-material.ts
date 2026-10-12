import { observeComponentTokens } from '../component-token-evidence.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ResourceCandidate, ResourceRef, ResourceSourceSnapshot } from '@mish/contracts';
import { parseShadcnReference, resolveShadcnRegistryItem, type ShadcnFetch, type ShadcnRegistryItemSource } from '../../design-systems/shadcn-import.js';
import { AdoptionError } from '../placement/adoption-executor.js';
import { canonicalJson } from '../placement/adoption-plan.js';
import type { ResourceSourceAdapter } from '../resources.js';
import { parseDependencySpec, type CatalogueMaterial, type CatalogueMaterialFile, type CatalogueMaterialSource, type CatalogueRecheckRefusal } from './catalogue-material.js';

/** One shadcn registry item selected for the catalogue, with its verified licence. */
export interface SelectedShadcnItem {
  itemId: string;
  /** A shadcn reference the existing importer accepts (item URL or `owner/repo/item`). */
  reference: string;
  title: string;
  packageName: string;
  licence: { spdx: string; notice: string };
}

export const SHADCN_MIT_NOTICE = [
  'MIT License',
  '',
  'Copyright (c) 2023 shadcn',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
].join('\n');

/**
 * The selected shadcn cohort (ledger decision 2026-10-07: exactly one item is
 * the external usable path in R01–R04). Other external cohorts (React Bits,
 * …) have no material source and stay reference-only; GSAP recipes
 * (`../recipes/gsap/`, AC-R08.5) and the React95 kit templates
 * (`../kits/react95/`, AC-R17) are their own material sources.
 */
export const SELECTED_SHADCN_ITEMS: readonly SelectedShadcnItem[] = Object.freeze([{
  itemId: 'button', reference: 'https://ui.shadcn.com/r/styles/new-york-v4/button.json', title: 'Button', packageName: 'shadcn/ui',
  licence: { spdx: 'MIT', notice: SHADCN_MIT_NOTICE },
}]);

/** Bound on the distinct registry dependencies in one item's transitive closure. */
const MAX_REGISTRY_DEPENDENCIES = 10;
const TYPE_DIRECTORIES: Record<string, string> = { 'registry:ui': 'components/ui', 'registry:lib': 'lib', 'registry:hook': 'hooks' };

/** Where the shadcn CLI's default aliases place a file of this registry type, relative to the target directory. */
function placement(file: ShadcnRegistryItemSource['files'][number]): string {
  return `${TYPE_DIRECTORIES[file.type ?? ''] ?? 'components'}/${path.posix.basename(file.relPath)}`;
}

/** Sibling reference for a bare registry dependency name, in the same form as the item's own reference. */
function dependencyReference(itemReference: string, name: string): string {
  if (/^https:\/\//u.test(name)) return name;
  const parsed = parseShadcnReference(itemReference);
  if (parsed.kind === 'github') return `${parsed.owner}/${parsed.repo}/${name}${parsed.ref ? `#${parsed.ref}` : ''}`;
  return new URL(`${encodeURIComponent(name)}.json`, parsed.url).toString();
}

/**
 * The complete transitive closure of an item's registry dependencies, breadth
 * first and deduplicated by reference. A closure larger than the bound is
 * refused (422 `registry-closure-too-large`): material never omits a file
 * that an applied file depends on.
 */
async function resolveClosure(root: ShadcnRegistryItemSource, itemReference: string, resolve: (reference: string) => Promise<ShadcnRegistryItemSource>): Promise<ShadcnRegistryItemSource[]> {
  const seen = new Set<string>([itemReference]);
  const resolved: ShadcnRegistryItemSource[] = [];
  let wave = [root];
  while (wave.length) {
    const next = wave.flatMap(source => source.registryDependencies).map(name => dependencyReference(itemReference, name)).filter(reference => {
      if (seen.has(reference)) return false;
      seen.add(reference); return true;
    });
    if (seen.size - 1 > MAX_REGISTRY_DEPENDENCIES) {
      throw new AdoptionError(422, 'registry-closure-too-large', `The item needs more than ${MAX_REGISTRY_DEPENDENCIES} registry dependencies; nothing was prepared`);
    }
    wave = await Promise.all(next.map(resolve));
    resolved.push(...wave);
  }
  return resolved;
}

export interface ShadcnCatalogueMaterials extends CatalogueMaterialSource {
  readonly items: readonly SelectedShadcnItem[];
}

/**
 * Catalogue material for selected shadcn items, resolved through the existing
 * shadcn importer (its egress policy, fetch budget and size limits). Registry
 * dependencies such as `utils` are saved locally with the item; npm
 * dependencies are reported against the project manifest, never installed.
 */
export function createShadcnCatalogueMaterials(options: { items?: readonly SelectedShadcnItem[]; fetchImpl?: ShadcnFetch } = {}): ShadcnCatalogueMaterials {
  const items = options.items ?? SELECTED_SHADCN_ITEMS;
  const resolve = (reference: string) => resolveShadcnRegistryItem(reference, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  return {
    sourceId: 'shadcn',
    items,
    /** Apply-time re-check: the item must still be selected with its licence notice. */
    async recheck(ref: ResourceRef): Promise<CatalogueRecheckRefusal | null> {
      return ref.sourceId === 'shadcn' && items.some(item => item.itemId === ref.itemId && item.licence.notice.trim())
        ? null : { status: 404, reason: 'resource-ref-unknown', message: 'The source no longer admits this item; search again' };
    },
    async materialize(itemId: string): Promise<CatalogueMaterial | null> {
      const selected = items.find(item => item.itemId === itemId);
      if (!selected) return null;
      const root = await resolve(selected.reference);
      const dependencies = await resolveClosure(root, selected.reference, resolve);
      const files: CatalogueMaterialFile[] = [];
      const seen = new Set<string>();
      for (const source of [root, ...dependencies]) for (const file of source.files) {
        const target = placement(file);
        if (seen.has(target)) continue;
        seen.add(target);
        files.push({ path: target, role: file.relPath.endsWith('.css') ? 'style' : 'source', bytes: Buffer.from(file.content, 'utf8') });
      }
      const packageDependencies = [root, ...dependencies].flatMap(source => source.dependencies.map(parseDependencySpec));
      const revision = createHash('sha256').update(canonicalJson({
        reference: selected.reference, files: files.map(f => ({ path: f.path, role: f.role, sha256: createHash('sha256').update(f.bytes).digest('hex') })), packageDependencies,
      })).digest('hex');
      const ref: ResourceRef = { sourceType: 'library', sourceId: 'shadcn', itemId, revisionOrDigest: `sha256:${revision}` };
      return {
        ref, title: selected.title, origin: 'official', files, packageDependencies,
        rights: { status: 'permitted', licence: selected.licence.spdx, notice: selected.licence.notice, sourceUrl: selected.reference.startsWith('https://') ? selected.reference : root.registryUrl, packageName: selected.packageName },
      };
    },
  };
}

/**
 * Lists the selected shadcn items for search and inspect. Rights and the
 * incorporation grant are permitted; readiness stays `unverified` until a
 * per-item acceptance receipt exists (the contract reserves `usable` for it).
 */
export function createSelectedShadcnResourceSource(materials: ShadcnCatalogueMaterials): ResourceSourceAdapter {
  return {
    sourceId: 'shadcn',
    async list(): Promise<ResourceSourceSnapshot> {
      const items: ResourceCandidate[] = [];
      let failed = 0;
      for (const selected of materials.items) {
        const material = await materials.materialize(selected.itemId).catch(() => null);
        if (!material) { failed++; continue; }
        items.push({
          ref: material.ref, title: material.title, category: 'component', readiness: 'unverified',
          componentTokenEvidence: observeComponentTokens(material.ref, material.files),
          componentAdapter: 'catalogue-files',
          compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'unverified', reason: 'Apply checks the project manifest for the declared packages' },
          rightsStatus: 'permitted', fitReasons: [],
          previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' },
          adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
          sourceAttribution: { title: `${material.rights.packageName} · ${material.title}`, ...(material.rights.sourceUrl.startsWith('https://') ? { url: material.rights.sourceUrl } : {}) },
          implementationOrigin: 'official',
          operationGrants: [
            { operation: 'incorporation', state: 'permitted', reason: null },
            { operation: 'private-reuse', state: 'permitted', reason: null },
          ],
          admissionStage: 'admitted', needDecision: 'not-assessed', needReason: 'Project need is not assessed for catalogue items',
        });
      }
      const listingDigest = createHash('sha256').update(canonicalJson(items.map(item => item.ref))).digest('hex');
      return { items, status: { sourceId: 'shadcn', state: failed ? 'degraded' : 'searched', reason: failed ? `registry-unavailable:${failed}` : null, itemCount: items.length, listingDigest } };
    },
  };
}
