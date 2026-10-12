import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agencyManifestForManualSave, stageAgencyImage } from '../src/artifacts/agency-image.js';
import { AGENCY_V2_FAMILIES } from '../src/artifacts/deploy-scope.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=', 'base64');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agency-image-')); roots.push(root);
  const manifest = { version: 1, kind: 'html', renderer: 'html', entry: 'site.html', sourceSkillId: 'agency-site', exports: ['html'], supportingFiles: [], metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', revision: 'r1', rendererVersion: '1.0.0', recipeDigest: 'a'.repeat(64) } } };
  await writeFile(path.join(root, 'site.html'), '<h1>Saved manual text</h1>');
  await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'upload.txt'), png);
  return { root, manifest, upload: path.join(root, 'upload.txt') };
}

describe('Agency Site image publication boundary', () => {
  it('accepts the SM, CS and MI page kinds at the publication boundary and still refuses an unknown family', async () => {
    for (const family of ['listings', 'publication', 'nonprofit', 'docs-hub']) expect(AGENCY_V2_FAMILIES.has(family)).toBe(true);
    const { root, manifest, upload } = await setup();
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', recipeSchemaVersion: 2, family: 'ghost', revision: 'ghost-r1' };
    await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify({ ...manifest, metadata: { agencySite: marker } }));
    await expect(stageAgencyImage(root, 'site.html', upload)).rejects.toThrow();
  });

  it.each([...AGENCY_V2_FAMILIES])('preserves %s v2 publication metadata through native image replacement', async (family) => {
    const { root, manifest, upload } = await setup();
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', recipeSchemaVersion: 2, family, revision: `${family}-r1` };
    await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify({ ...manifest, metadata: { agencySite: marker } }));
    const image = await stageAgencyImage(root, 'site.html', upload);
    expect(image.path).toContain(`assets/agency-site/${family}-r1/`);
    const saved = await agencyManifestForManualSave(root, 'site.html', `<img src="${image.path}">`, image.path);
    expect(saved.metadata?.agencySite).toEqual(marker);
    expect(saved.supportingFiles).toEqual([image.path]);
  });

  it('stages bytes under the saved revision, then declares exactly that image on save', async () => {
    const { root, manifest, upload } = await setup();
    const image = await stageAgencyImage(root, 'site.html', upload);
    expect(image.path).toMatch(/^assets\/agency-site\/r1\/image-[a-f0-9-]+\.png$/);
    expect(await readFile(path.join(root, image.path))).toEqual(png);
    expect(JSON.parse(await readFile(path.join(root, 'site.html.artifact.json'), 'utf8'))).toEqual(manifest);
    const saved = await agencyManifestForManualSave(root, 'site.html', `<img src="${image.path}">`, image.path);
    expect(saved.supportingFiles).toEqual([image.path]);
    await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify(saved));
    expect((await agencyManifestForManualSave(root, 'site.html', '<h1>Later text edit</h1>', undefined, manifest)).supportingFiles).toEqual([image.path]);
  });
  it('refuses image bytes when authority is lost after the pre-open check', async () => {
    const { root, upload } = await setup();
    let qualified = true;
    const revisionDir = path.join(root, 'assets/agency-site/r1');
    const finalIO = { assertCurrent() {
      if (!qualified) throw new Error('owner lost');
      // The revision directory exists only after directory setup. Lose
      // authority at the next check, just before the awaited O_CREAT.
      if (existsSync(revisionDir)) qualified = false;
    } };
    await expect(stageAgencyImage(root, 'site.html', upload, finalIO)).rejects.toThrow('owner lost');
    const files = await readdir(revisionDir);
    expect(files).toHaveLength(1); // open created a file, but no image bytes may cross the lost guard
    expect(await readFile(path.join(revisionDir, files[0]!))).toHaveLength(0);
  });
  it.each(['missing', 'corrupt', 'invalid-revision', 'symlink'])('refuses a %s persisted manifest', async (state) => {
    const { root, manifest, upload } = await setup();
    const file = path.join(root, 'site.html.artifact.json');
    if (state === 'missing') await rm(file);
    if (state === 'corrupt') await writeFile(file, '{broken');
    if (state === 'invalid-revision') { manifest.metadata.agencySite.revision = '../escape'; await writeFile(file, JSON.stringify(manifest)); }
    if (state === 'symlink') { await rm(file); await writeFile(path.join(root, 'private.json'), JSON.stringify(manifest)); await symlink(path.join(root, 'private.json'), file); }
    await expect(stageAgencyImage(root, 'site.html', upload)).rejects.toThrow('persisted publication manifest');
  });
  it('rejects a symlinked asset directory, source file and owner traversal', async () => {
    const { root, upload } = await setup();
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), path.join(root, 'assets'));
    await expect(stageAgencyImage(root, 'site.html', upload)).rejects.toThrow('symlinks');
    await expect(stageAgencyImage(root, '../site.html', upload)).rejects.toThrow('root HTML');
    await rm(path.join(root, 'assets'));
    await symlink(upload, path.join(root, 'linked.png'));
    await expect(stageAgencyImage(root, 'site.html', path.join(root, 'linked.png'))).rejects.toThrow();
  });
  it('rejects non-raster bytes and stale-revision or unreferenced declarations', async () => {
    const { root, manifest, upload } = await setup();
    const image = await stageAgencyImage(root, 'site.html', upload);
    await expect(agencyManifestForManualSave(root, 'site.html', '<h1>Unchanged</h1>', image.path)).rejects.toThrow('not referenced');
    manifest.metadata.agencySite.revision = 'r2';
    await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify(manifest));
    await expect(agencyManifestForManualSave(root, 'site.html', `<img src="${image.path}">`, image.path)).rejects.toThrow('current artifact revision');
    await writeFile(upload, '<svg onload="alert(1)"></svg>');
    await expect(stageAgencyImage(root, 'site.html', upload)).rejects.toThrow('requires PNG');
  });
  it('rejects traversal, undeclared other-revision paths and replaced asset symlinks on save', async () => {
    const { root, upload } = await setup();
    for (const file of ['assets/agency-site/r1/../secret.png', 'assets/agency-site/r2/image.png', 'https://example.com/image.png']) {
      await expect(agencyManifestForManualSave(root, 'site.html', `<img src="${file}">`, file)).rejects.toThrow('current artifact revision');
    }
    const image = await stageAgencyImage(root, 'site.html', upload);
    await rm(path.join(root, image.path)); await symlink(upload, path.join(root, image.path));
    await expect(agencyManifestForManualSave(root, 'site.html', `<img src="${image.path}">`, image.path)).rejects.toThrow();
  });
});
