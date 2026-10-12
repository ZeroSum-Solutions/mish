import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceRequestContext } from '@open-design/contracts';
import { bundledFontCatalogue, type FontCatalogue } from '../../src/fonts/catalogue.js';

/** The repository's bundled official plugins: the resource root the admitted font bytes live under. */
export const REPO_BUNDLED_PLUGINS_ROOT = fileURLToPath(new URL('../../../../plugins/_official', import.meta.url));
export const authority: ResourceRequestContext = { principalId: 'local-daemon' };
export const projectAuthority: ResourceRequestContext = { principalId: 'local-daemon', projectId: 'p' };

/** A deep copy of the committed snapshot that a test may edit freely. */
export function catalogueCopy(): FontCatalogue {
  return structuredClone(bundledFontCatalogue());
}

/** Copies one family's admitted local files (and notices) into a fresh temporary root. */
export function copiedFontRoot(familyId: string, catalogue: FontCatalogue = bundledFontCatalogue()): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-b6-fonts-'));
  const family = catalogue.families.find(entry => entry.id === familyId);
  if (!family) throw new Error(`unknown family ${familyId}`);
  for (const relative of new Set(family.localFiles.flatMap(file => [file.path, file.notice.path]))) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(REPO_BUNDLED_PLUGINS_ROOT, relative), target);
  }
  return root;
}
