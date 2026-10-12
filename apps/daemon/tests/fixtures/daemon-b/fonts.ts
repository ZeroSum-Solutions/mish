// Owned test bytes exercise admission and catalogue metadata, not browser font rendering.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import type { ResourceRequestContext } from '@mish/contracts';
import { bundledFontCatalogue as realCatalogue, type FontCatalogue } from '../../../src/fonts/catalogue.js';
import { createFontsResourceSource as realSource } from '../../../src/workbench/resources-fonts.js';
const roots: string[] = [];
export const REPO_BUNDLED_PLUGINS_ROOT = mkdtempSync(path.join(tmpdir(), 'mish-font-fixture-'));
roots.push(REPO_BUNDLED_PLUGINS_ROOT);
const catalogue = structuredClone(realCatalogue());
catalogue.localBytes.measuredWith = 'owned-synthetic-metadata';
catalogue.localBytes.method = 'Protocol tests trust declared cmap metadata; no font parser or browser rendering is exercised.';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const family of catalogue.families) for (const [index, file] of family.localFiles.entries()) {
  const bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.from(`Owned test bytes: ${family.id} ${index}`), Buffer.alloc(64)]);
  const notice = `Owned test fixture for ${family.family}. SIL Open Font License metadata test.\n`;
  file.provenance = 'Owned synthetic file with declared cmap test metadata; not measured font glyph evidence.';
  file.path = `fonts/${family.id}/${index}.woff2`;
  file.bytes = bytes.length;
  file.sha256 = sha(bytes);
  file.notice.path = `fonts/${family.id}/NOTICE.txt`;
  file.notice.sha256 = sha(notice);
  for (const [relative, content] of [[file.path, bytes], [file.notice.path, notice]] as const) {
    const target = path.join(REPO_BUNDLED_PLUGINS_ROOT, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
export const bundledFontCatalogue = (): FontCatalogue => structuredClone(catalogue);
export const catalogueCopy = bundledFontCatalogue;
export const authority: ResourceRequestContext = { principalId: 'local-daemon' };
export const projectAuthority: ResourceRequestContext = { ...authority, projectId: 'p' };
export function createFontsResourceSource(options: Parameters<typeof realSource>[0]) {
  return realSource({ ...options, catalogue: options.catalogue ?? bundledFontCatalogue() });
}
export function copiedFontRoot(familyId: string, snapshot = bundledFontCatalogue()): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mish-font-copy-'));
  roots.push(root);
  const family = snapshot.families.find(entry => entry.id === familyId);
  if (!family) throw new Error(`unknown family ${familyId}`);
  for (const relative of new Set(family.localFiles.flatMap(file => [file.path, file.notice.path]))) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(REPO_BUNDLED_PLUGINS_ROOT, relative), target);
  }
  return root;
}
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
