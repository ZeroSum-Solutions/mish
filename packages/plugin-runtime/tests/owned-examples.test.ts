import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/parsers/manifest';
import { parseFrontmatter } from '../src/parsers/frontmatter';
import { validateSafe } from '../src/validate';

const examplesRoot = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
const ownedFolders = [
  'acreage-farming', 'aerocore', 'ai-designer-portfolio', 'cinematic-landing-page',
  'codenest-coding-platform', 'dreamcore-landing', 'evergreen-finance', 'innovation',
];

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else files.push(file);
  }
  return files;
}

describe('owned replacement examples', () => {
  it.each(ownedFolders)('%s retains a valid runnable plugin and local-only assets', async (folder) => {
    const root = path.join(examplesRoot, folder);
    const manifestText = await readFile(path.join(root, 'mish.json'), 'utf8');
    const parsed = parseManifest(manifestText);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    expect(validateSafe(parsed.manifest)).toEqual({ ok: true, warnings: [], errors: [] });
    expect(parsed.manifest.name).toBe(`example-${folder}`);
    expect(parsed.manifest.license).toBe('Apache-2.0');
    expect(parsed.manifest.author?.name).toBe('ZeroSum Solutions');
    expect(parsed.manifest['rights']).toMatchObject({ status: 'owned', evidence: './RIGHTS.md' });
    expect(parsed.manifest.od?.preview).toMatchObject({ type: 'html', entry: './example.html', motion: 'scroll' });
    expect(parsed.manifest.od?.useCase?.exampleOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: './example.html' }),
    ]));
    const contextAssets = parsed.manifest.od?.context?.assets ?? [];
    expect(contextAssets).toContain('./example.html');
    expect(contextAssets).toContain('./RIGHTS.md');
    for (const asset of contextAssets) {
      expect(typeof asset).toBe('string');
      if (typeof asset !== 'string') throw new Error('Expected local asset path');
      const resolved = path.resolve(root, asset);
      expect(resolved.startsWith(`${root}${path.sep}`)).toBe(true);
      expect((await stat(resolved)).isFile()).toBe(true);
    }
    const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
    expect(parseFrontmatter(skill).data['name']).toBe(parsed.manifest.name);
    const html = await readFile(path.join(root, 'example.html'), 'utf8');
    // An SVG namespace is an identifier, not a network request.
    expect(html.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\/|(?:src|href)\s*=\s*["']\/\//i);
    expect(`${manifestText}\n${skill}`).not.toMatch(/motionsites\.ai|plugin-assets\.mish\.ai|CC-BY-4\.0/);
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain(':focus-visible');
    expect(html).toContain('No details were sent or saved.');
    expect(await readFile(path.join(root, 'assets/OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    for (const file of await filesUnder(root)) expect((await stat(file)).size, file).toBeLessThanOrEqual(1024 * 1024);
  });
});
