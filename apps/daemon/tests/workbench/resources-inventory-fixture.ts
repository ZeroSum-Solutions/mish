import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceSearchRequest, type InstalledPluginRecord, type ResourceRequestContext, type ResourceResult, type ResourceSearchRequest } from '@mish/contracts';
import { createLocalResourceSources, searchResources, type ResourceSourceAdapter } from '../../src/workbench/resources.js';
import { createFontsResourceSource } from '../../src/workbench/resources-fonts.js';

/** The repository's bundled design-system resource root (the same tree the daemon
 * resolves as its design-systems resource directory in a source checkout). */
export const REPO_DESIGN_SYSTEMS_ROOT = fileURLToPath(new URL('../../../../design-systems', import.meta.url));
/** The bundled official plugins: the resource root that holds the admitted local font files. */
export const REPO_BUNDLED_PLUGINS_ROOT = fileURLToPath(new URL('../../../../plugins/_official', import.meta.url));
export const authority: ResourceRequestContext = { principalId: 'local-daemon' };

/** A minimal installed skill plugin in a temporary directory, so the plugins
 * adapter's real skill/template branch is exercised without a database. */
export function skillPlugin(): InstalledPluginRecord {
  const fsPath = mkdtempSync(path.join(tmpdir(), 'od-u7-plugin-'));
  writeFileSync(path.join(fsPath, 'SKILL.md'), '# Fixture skill\n');
  return { id: 'fixture-skill', title: 'Fixture skill', version: '1.0.0', fsPath, manifest: { name: 'fixture-skill', od: { kind: 'skill' } }, sourceDigest: 'sha256:fixture', manifestDigest: 'sha256:fixture' } as unknown as InstalledPluginRecord;
}

/** Every local, network-free adapter the daemon wires for workbench search. */
export function localInventorySources(plugins: readonly InstalledPluginRecord[] = [], designSystemsRoot = REPO_DESIGN_SYSTEMS_ROOT): ResourceSourceAdapter[] {
  return createLocalResourceSources({ listPlugins: async () => plugins, designSystemsRoot, fonts: createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT }) });
}

/** Follows nextCursor to the end; no page cap, so a hidden quota would surface as a short union. */
export async function searchEveryPage(sources: readonly ResourceSourceAdapter[], input: Partial<ResourceSearchRequest> = {}): Promise<{ results: ResourceResult[]; pages: number }> {
  const results: ResourceResult[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await searchResources(parseResourceSearchRequest({ query: '', limit: 100, ...input, ...(cursor ? { cursor } : {}) }), authority, sources);
    results.push(...page.results); pages++;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { results, pages };
}

/** Writes a design-system package fixture under a fresh temporary resource root. */
export function designSystemFixtureRoot(packages: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-u7-design-systems-'));
  for (const [dir, files] of Object.entries(packages)) {
    for (const [relative, body] of Object.entries(files)) {
      const target = path.join(root, dir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
  return root;
}
