import { createHash } from 'node:crypto';
import type { React95Edit, React95Kit } from './kit-types.js';

/** One file of an applied React95 unit, relative to the unit's target directory. */
export interface React95UnitFile { path: string; role: 'source' | 'asset'; bytes: Buffer; upstream: { path: string; gitBlob: string; patched: boolean } | null }

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Applies edits given against the original text (offsets never shift between edits). */
export function applyEdits(text: string, edits: readonly React95Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.insert + out.slice(edit.at + edit.deleteCount);
  return out;
}

/**
 * The adoption executor writes into one existing directory, so the unit is
 * flat: upstream `src/Window/Window.tsx` lands as `react95.Window.Window.tsx`
 * next to the template, and its relative imports are rewritten to match
 * (declared `flat-layout` edits).
 */
export const unitPathOf = (upstreamPath: string) => `react95.${upstreamPath.slice('src/'.length).split('/').join('.')}`;
/** The import specifier for an upstream file in the flat layout (no extension). */
export const unitSpecifierOf = (upstreamPath: string) => `./${unitPathOf(upstreamPath).replace(/\.(?:d\.ts|tsx?)$/u, '')}`;
export const REACT95_UNIT_LICENCE_PATH = 'react95.LICENSE';

/**
 * The exact files a template unit writes: the template, the theme typing
 * adapter, its upstream source closure (declared patches applied, everything
 * else byte for byte) and the upstream code licence. Font and image files are
 * never part of a unit. A patch whose result digest differs from the record
 * fails closed.
 */
export function react95UnitFiles(kit: React95Kit, templateId: string): React95UnitFile[] | null {
  const template = kit.templates.find(entry => entry.id === templateId);
  if (!template) return null;
  const files: React95UnitFile[] = [
    { path: template.file, role: 'source', bytes: Buffer.from(template.text), upstream: null },
    ...kit.adapters.map(adapter => ({ path: adapter.file, role: 'source' as const, bytes: Buffer.from(adapter.text), upstream: null })),
  ];
  for (const path of template.closure) {
    const vendored = kit.vendored.find(entry => entry.path === path);
    if (!vendored) throw new Error(`React95 kit is missing vendored ${path}`);
    const patch = kit.patches.find(entry => entry.path === path);
    const text = patch ? applyEdits(vendored.text, patch.edits) : vendored.text;
    if (patch && sha256(text) !== patch.patchedSha256) throw new Error(`React95 patch for ${path} does not reproduce its recorded digest`);
    files.push({ path: unitPathOf(path), role: 'source', bytes: Buffer.from(text), upstream: { path, gitBlob: vendored.gitBlob, patched: !!patch } });
  }
  files.push({ path: REACT95_UNIT_LICENCE_PATH, role: 'asset', bytes: Buffer.from(kit.notices.code.text), upstream: { path: kit.notices.code.path, gitBlob: kit.notices.code.gitBlob, patched: false } });
  return files;
}
