import { createHash } from 'node:crypto';
import path from 'node:path';
import type { OperationRight, ResourceRef } from '@mish/contracts';
import { resolveShadcnRegistryItem, type ShadcnFetch } from '../../design-systems/shadcn-import.js';
import { ACETERNITY_OWNER_DECISION, aceternityApplyAllowed, aceternityAssessmentFor, aceternityReuseAllowed } from '../aceternity-rights.js';
import { ACETERNITY_ITEMS } from '../reference-sources.js';
import { parseDependencySpec, type CatalogueDependency, type CatalogueMaterial, type CatalogueMaterialFile, type CatalogueMaterialSource, type CatalogueRecheckRefusal, type CatalogueRecheckWrite } from './catalogue-material.js';
import { SHADCN_UTILS_HELPER } from './shadcn-utils-helper.js';

/** Where the shadcn CLI's default aliases place a registry file, relative to the target directory. */
const TYPE_DIRECTORIES: Record<string, string> = { 'registry:ui': 'components/ui', 'registry:lib': 'lib', 'registry:hook': 'hooks' };
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** The React target supplies these; every other bare import is an npm package the project must have. */
const TARGET_PROVIDED = new Set(['react', 'react-dom']);

/**
 * Static and dynamic import specifiers in a module's text. The scan is linear and runs
 * only on registry file content the shadcn importer already bounded (its MAX_FILE_BYTES
 * per file and MAX_FILES per item), so an oversized module never reaches it.
 */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gmu)) {
    found.add((match[1] ?? match[2] ?? match[3])!);
  }
  return [...found];
}
/** npm package name of a bare specifier (`motion/react` → `motion`); null for relative or alias paths. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/') || specifier.startsWith('~/')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0]!;
}
/**
 * Declared dependencies plus any package the source imports without declaring it
 * (tabs imports `motion` but declares only `@radix-ui/react-tabs`). An undeclared
 * import is reported with range `*`, so apply refuses until the project has it.
 */
function actualDependencies(declared: readonly string[], files: readonly CatalogueMaterialFile[]): CatalogueDependency[] {
  const dependencies = declared.map(parseDependencySpec);
  for (const file of files) for (const specifier of importSpecifiers(file.bytes.toString('utf8'))) {
    const name = packageOf(specifier);
    if (name && !TARGET_PROVIDED.has(name) && !dependencies.some(dependency => dependency.name === name)) dependencies.push({ name, range: '*' });
  }
  return dependencies;
}

function notice(itemId: string, title: string): string {
  return [
    `Aceternity UI: ${title}. Copyright the item's author (Manu Arora, Aceternity).`,
    '',
    `Admitted under the owner-accepted-private-use basis: ${ACETERNITY_OWNER_DECISION.citation}`,
    '',
    'Published terms (kept for reference, not interpreted here): https://ui.aceternity.com/licence and https://ui.aceternity.com/terms.',
    'They forbid re-distributing the Item or its source files and selling it on a marketplace or as a template.',
    `Component page: https://ui.aceternity.com/components/${itemId}`,
  ].join('\n');
}

/**
 * AC-R18.6 / G38: catalogue material for the three evaluated Aceternity items, fetched
 * per project (`project-fetch`) through the existing shadcn importer and its egress
 * policy and bounds. The fetched component must hash to the inspected digest; any other
 * bytes come back under a different revision, so the preparer refuses them as stale.
 * npm dependencies, declared or only imported, are reported against the project
 * manifest and never installed. A component importing `cn` from `@/lib/utils` gets
 * shadcn's pinned MIT helper when the project has no such module.
 */
/** Current decisions for an item; tests inject a revocation, the daemon reads the frozen assessment. */
type RightsLookup = (itemId: string) => readonly Pick<OperationRight, 'operation' | 'decision'>[];
const assessedRights: RightsLookup = itemId => aceternityAssessmentFor(itemId).operationRights;

export function createAceternityCatalogueMaterials(options: { fetchImpl?: ShadcnFetch; rights?: RightsLookup } = {}): CatalogueMaterialSource {
  const rights = options.rights ?? assessedRights;
  return {
    sourceId: 'aceternity',
    /**
     * Apply-time re-check (G38 review round 2), without network: the item is still one of
     * the assessed items at the inspected revision, the owner decision still allows every
     * operation apply needs, and the plan writes exactly the assessed component bytes.
     */
    async recheck(ref: ResourceRef, writes: readonly CatalogueRecheckWrite[]): Promise<CatalogueRecheckRefusal | null> {
      const item = ACETERNITY_ITEMS.find(entry => entry.itemId === ref.itemId);
      if (!item) return { status: 404, reason: 'resource-ref-unknown', message: 'Resource is unavailable or unknown; search again' };
      const stale = { status: 409 as const, reason: 'resource-ref-stale', message: 'The item bytes no longer match the assessed digest; prepare again' };
      if (ref.revisionOrDigest !== `sha256:${item.registrySha256}`) return stale;
      if (!aceternityApplyAllowed(rights(item.itemId))) {
        return { status: 422, reason: 'source-rights-revoked', message: 'The rights decision for this source no longer allows apply; nothing was written' };
      }
      if (!writes.some(write => write.role === 'source' && write.sha256 === item.componentSha256)) return stale;
      return null;
    },
    /** Saved-unit reuse (G38): the item is still assessed and the decision still allows private reuse. */
    async recheckReuse(ref: ResourceRef): Promise<CatalogueRecheckRefusal | null> {
      const item = ACETERNITY_ITEMS.find(entry => entry.itemId === ref.itemId);
      if (!item) return { status: 404, reason: 'resource-ref-unknown', message: 'Resource is unavailable or unknown; search again' };
      if (!aceternityReuseAllowed(rights(item.itemId))) {
        return { status: 422, reason: 'source-rights-revoked', message: 'The rights decision for this source no longer allows private reuse; nothing was written' };
      }
      return null;
    },
    async materialize(itemId: string): Promise<CatalogueMaterial | null> {
      const item = ACETERNITY_ITEMS.find(entry => entry.itemId === itemId);
      if (!item) return null;
      const reference = `https://ui.aceternity.com/registry/${item.itemId}.json`;
      const resolved = await resolveShadcnRegistryItem(reference, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
      const files: CatalogueMaterialFile[] = resolved.files.map(file => ({
        path: `${TYPE_DIRECTORIES[file.type ?? ''] ?? 'components'}/${path.posix.basename(file.relPath)}`,
        role: file.relPath.endsWith('.css') ? 'style' : 'source',
        bytes: Buffer.from(file.content, 'utf8'),
      }));
      const pinned = files.length === 1 && sha256(files[0]!.bytes) === item.componentSha256
        && resolved.registryDependencies.length === 0 && JSON.stringify(resolved.dependencies) === JSON.stringify(item.dependencies);
      // The inspected revision only when the fetched bytes are exactly the inspected ones.
      const revision = pinned ? item.registrySha256 : sha256(JSON.stringify({ files: files.map(file => [file.path, sha256(file.bytes)]), dependencies: resolved.dependencies, registryDependencies: resolved.registryDependencies }));
      const ref: ResourceRef = { sourceType: 'reference', sourceId: 'aceternity', itemId: item.itemId, revisionOrDigest: `sha256:${revision}` };
      return {
        ref, title: item.title, origin: 'official', files,
        packageDependencies: actualDependencies(resolved.dependencies, files),
        helpers: files.some(file => importSpecifiers(file.bytes.toString('utf8')).includes('@/lib/utils')) ? [SHADCN_UTILS_HELPER] : [],
        rights: {
          status: aceternityApplyAllowed(rights(item.itemId)) ? 'permitted' : 'restricted', licence: 'Aceternity License (owner-accepted private use, 2026-10-09)',
          notice: notice(item.itemId, item.title), sourceUrl: reference, packageName: 'Aceternity UI',
        },
      };
    },
  };
}
