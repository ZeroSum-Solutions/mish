import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileAgencyRecipe } from '../src/artifacts/agency-recipe.js';

const templatesRoot = fileURLToPath(new URL('../../../design-templates/', import.meta.url));
const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(family = 'listings') {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'agency-recipe-'));
  roots.push(projectRoot);
  const source = '<!doctype html><html><body><p>Owned reconciliation fixture</p></body></html>';
  await writeFile(path.join(projectRoot, 'site.html'), source);
  await writeFile(path.join(projectRoot, 'site.html.artifact.json'), JSON.stringify({
    sourceSkillId: 'agency-site', kind: 'html', renderer: 'html', entry: 'site.html', supportingFiles: [],
    metadata: { agencySite: { version: 1, publication: 'closed-assets-v2', rendererVersion: '2.0.0', recipeSchemaVersion: 2, family, revision: `${family}-r1`, recipeDigest: '0'.repeat(64) } },
  }));
  return {
    projectRoot, templatesRoot, entry: 'site.html', skillId: 'agency-site', baseSource: source, baseVersionDigest: digest(source),
    request: { baseRecipeFile: 'recipe.json', approvedAssetManifestFile: 'approved.json', baseVersionId: 'original-version', expectedSourceDigest: digest(source) },
  };
}

describe('public Agency Site reconciliation refuses unavailable renderers', () => {
  it('refuses an unsupported public family without producing regeneration data or changing HTML', async () => {
    const options = await setup();
    const result = await reconcileAgencyRecipe(options);
    expect(result).toMatchObject({ ok: false, regenerationSafe: false, conflicts: [{ code: 'unsupported-family' }] });
    expect(result).not.toHaveProperty('recipe');
    expect(result).not.toHaveProperty('approvedAssetManifest');
    expect(await readFile(path.join(options.projectRoot, 'site.html'), 'utf8')).toBe(options.baseSource);
  });

  it('fails closed when a historic manifest needs a renderer removed from the public bundle', async () => {
    const result = await reconcileAgencyRecipe(await setup('watson'));
    expect(result).toMatchObject({ ok: false, regenerationSafe: false, conflicts: [{ code: 'invalid-input' }] });
    expect(result).not.toHaveProperty('recipe');
  });

  it.each(['project', 'entry', 'source', 'symlink'])('retains the %s guard before renderer loading', async (attack) => {
    const options = await setup();
    if (attack === 'project') options.skillId = 'other';
    if (attack === 'entry') options.entry = '../site.html';
    if (attack === 'source') options.request.expectedSourceDigest = '0'.repeat(64);
    if (attack === 'symlink') {
      await symlink(path.join(options.projectRoot, 'site.html'), path.join(options.projectRoot, 'linked.html'));
      options.entry = 'linked.html';
    }
    const result = await reconcileAgencyRecipe(options);
    expect(result.regenerationSafe).toBe(false);
    expect(result.conflicts[0]?.code).toBe({ project: 'unsupported-project', entry: 'unsafe-path', source: 'stale-source', symlink: 'unsafe-path' }[attack]);
    expect(result).not.toHaveProperty('recipe');
  });
});
