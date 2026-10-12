import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../../design-templates/agency-site/scripts/compose.ts';
import { FAMILIES } from '../../../design-templates/agency-site/scripts/families/registry.ts';
import { renderAgencySite } from '../../../design-templates/agency-site/scripts/render.ts';

// The study families (emmpo, watson, maben) are private and ship in a private pack, not in
// this repository, so the public built-in Agency Site skill registers no family at all.
// What ships is the trusted-dispatch boundary itself: a schemaVersion 2 (family) recipe can
// only reach a renderer listed in the generated static registry, and every other family
// name — a private study, a traversal, an inherited Object property — is refused before any
// output directory is reserved.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(family: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-families-')); roots.push(dir);
  const recipe = { schemaVersion: 2, family, revision: 1, brand: { name: 'Example Studio' } };
  const manifest = { version: 1, assets: [] };
  const input = path.join(dir, 'recipe.json'), roster = path.join(dir, 'approved.json'), output = path.join(dir, 'candidate');
  await writeFile(input, JSON.stringify(recipe)); await writeFile(roster, JSON.stringify(manifest));
  return { dir, recipe, manifest, input, roster, output };
}

describe('Agency Site family dispatch (public build)', () => {
  it('[P1] ships an empty static family registry', () => {
    expect(Object.keys(FAMILIES)).toEqual([]);
    expect(Object.getPrototypeOf(FAMILIES)).toBe(Object.prototype);
  });

  it.each(['emmpo', 'watson', 'maben', '../emmpo', '__proto__', 'constructor', 'toString', '', 42, null, undefined])(
    '[P1] refuses family %s at render time',
    async (family) => {
      const s = await setup(family);
      expect(() => renderAgencySite(s.recipe, 'site.html', s.manifest)).toThrow('Unknown Agency Site family');
    },
  );

  it.each(['emmpo', 'watson', '__proto__'])('[P1] compose refuses family %s without creating output', async (family) => {
    const s = await setup(family);
    await expect(compose(s.input, s.dir, s.output, 'site.html', s.roster)).rejects.toThrow('Unknown Agency Site family');
    await expect(readFile(path.join(s.output, 'site.html'))).rejects.toThrow();
    await expect(readFile(path.join(s.output, 'site.html.artifact.json'))).rejects.toThrow();
  });
});
