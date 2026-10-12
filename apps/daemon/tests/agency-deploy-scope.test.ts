import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDeployFileSet, prepareDeployPreflight } from '../src/deploy.js';
import { ensureProject, writeProjectFile, renameProjectFile, readProjectFile } from '../src/projects.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agency-scope-')); roots.push(root);
  const dir = await ensureProject(root, 'proof');
  const asset = 'assets/agency-site/r1/hero.png';
  const manifest = { version: 1, kind: 'html', renderer: 'html', exports: ['html'], entry: 'site-r1.html', sourceSkillId: 'agency-site', supportingFiles: [asset], metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', rendererVersion: '1.0.0', recipeDigest: 'a'.repeat(64), revision: 'r1' } } };
  await mkdir(path.join(dir, 'assets/agency-site/r1'), { recursive: true });
  await writeFile(path.join(dir, asset), 'asset-bytes');
  for (const file of ['brief.md', 'recipe.json', 'notes.txt', 'prior.html']) await writeFile(path.join(dir, file), 'private working content');
  const html = `<h1>Agency</h1><img src="${asset}">`;
  await writeProjectFile(root, 'proof', 'site-r1.html', html);
  await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify(manifest));
  return { root, dir, asset, manifest, html };
}
const scope = { requireAgencySiteScope: true };

describe('agency publication scope', () => {
  it('publishes v2 WOFF and MP4 with their MIME types while excluding private files', async () => {
    const { root, dir, manifest } = await setup();
    const files = ['body.woff', 'person.mp4', 'display.woff2'].map((name) => `assets/agency-site/emmpo-r1/${name}`);
    await mkdir(path.join(dir, 'assets/agency-site/emmpo-r1'), { recursive: true });
    for (const file of files) await writeFile(path.join(dir, file), 'public media');
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', family: 'emmpo', recipeSchemaVersion: 2, revision: 'emmpo-r1' };
    await writeProjectFile(root, 'proof', 'site-r1.html', `<style>@font-face{font-family:Demo;src:url(${files[0]}),url(${files[2]})}</style><video src="${files[1]}"></video>`);
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify({ ...manifest, supportingFiles: files, metadata: { agencySite: marker } }));
    const planned = await buildDeployFileSet(root, 'proof', 'site-r1.html', scope);
    expect(planned.map((file) => [file.file, file.contentType])).toEqual([['index.html', 'text/html; charset=utf-8'], [files[1], 'video/mp4'], [files[0], 'font/woff'], [files[2], 'font/woff2']]);
  });
  it.each(['woff', 'mp4', 'svg', 'gif', 'webm'])('keeps %s out of the legacy v1 publication contract', async (suffix) => {
    const { root, dir, manifest } = await setup();
    manifest.supportingFiles = [`assets/agency-site/r1/file.${suffix}`];
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify(manifest));
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
  });
  it('publishes a maben v2 manifest with its declared assets', async () => {
    const { root, dir, manifest } = await setup();
    const file = 'assets/agency-site/maben-r1/hero-frame.png';
    await mkdir(path.join(dir, 'assets/agency-site/maben-r1'), { recursive: true });
    await writeFile(path.join(dir, file), 'public media');
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', family: 'maben', recipeSchemaVersion: 2, revision: 'maben-r1' };
    await writeProjectFile(root, 'proof', 'site-r1.html', `<img src="${file}">`);
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify({ ...manifest, supportingFiles: [file], metadata: { agencySite: marker } }));
    expect((await buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).map((f) => f.file)).toEqual(['index.html', file]);
  });
  it('keeps a family outside the allow-list out of v2 publication', async () => {
    const { root, dir, manifest } = await setup();
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', family: 'radian', recipeSchemaVersion: 2, revision: 'radian-r1' };
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify({ ...manifest, supportingFiles: [], metadata: { agencySite: marker } }));
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
  });
  it.each(['svg', 'gif', 'webm', 'js', 'json'])('keeps %s out of v2 publication too', async (suffix) => {
    const { root, dir, manifest } = await setup();
    const marker = { ...manifest.metadata.agencySite, publication: 'closed-assets-v2', rendererVersion: '2.0.0', family: 'emmpo', recipeSchemaVersion: 2, revision: 'emmpo-r1' };
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify({ ...manifest, supportingFiles: [`assets/agency-site/emmpo-r1/file.${suffix}`], metadata: { agencySite: marker } }));
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
  });

  it('limits preflight and upload to selected HTML and declared assets within the reference closure', async () => {
    const { root, asset } = await setup();
    const files = await buildDeployFileSet(root, 'proof', 'site-r1.html', scope);
    expect(files.map((f) => f.file)).toEqual(['index.html', asset]);
    const preflight = await prepareDeployPreflight(root, 'proof', 'site-r1.html', scope);
    expect(preflight.files.map((f) => f.path)).toEqual(files.map((f) => f.file));
  });
  it('warns on missing anchors while still rejecting existing out-of-scope anchor files', async () => {
    const { root, html, asset } = await setup();
    await writeProjectFile(root, 'proof', 'site-r1.html', html + '<a href="old.html">Old</a><area href="resume.pdf">');
    const preflight = await prepareDeployPreflight(root, 'proof', 'site-r1.html', scope);
    expect(preflight.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'broken-reference', path: 'old.html' }), expect.objectContaining({ code: 'broken-reference', path: 'resume.pdf' })]));
    expect((await buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).map((file) => file.file)).toEqual(['index.html', asset]);
    await writeProjectFile(root, 'proof', 'site-r1.html', html + '<a href="brief.md">Private</a>');
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('out-of-scope');
  });
  it('honors intact scope metadata even outside an agency-classified project', async () => {
    const { root, asset } = await setup();
    expect((await buildDeployFileSet(root, 'proof', 'site-r1.html', {})).map((f) => f.file)).toEqual(['index.html', asset]);
  });
  it.each(['missing', 'corrupt', 'bad-marker'])('fails closed on %s manifest, including preflight', async (state) => {
    const { root, dir, manifest } = await setup();
    const target = path.join(dir, 'site-r1.html.artifact.json');
    if (state === 'missing') await rm(target);
    if (state === 'corrupt') await writeFile(target, '{broken');
    if (state === 'bad-marker') { manifest.metadata.agencySite.publication = 'anything'; await writeFile(target, JSON.stringify(manifest)); }
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
    await expect(prepareDeployPreflight(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
  });
  it.each(['<img src="recipe.json">', '<style>body{background:url(brief.md)}</style>', '<img src="assets/agency-site/r1/../r1/hero.png">', '<img src="assets/agency-site/r1/%2e%2e/brief.md">', '<img src="assets\\agency-site/r1/hero.png">'])('rejects out-of-scope/traversal references: %s', async (html) => {
    const { root } = await setup();
    await writeProjectFile(root, 'proof', 'site-r1.html', html);
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('out-of-scope');
  });
  it('rejects a declared asset symlink into a private file', async () => {
    const { root, dir, asset } = await setup();
    await rm(path.join(dir, asset)); await symlink(path.join(dir, 'brief.md'), path.join(dir, asset));
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('out-of-scope');
  });
  it('preserves scope after ordinary HTML edit and refuses extra manifest files', async () => {
    const { root, dir, manifest } = await setup();
    const saved = await writeProjectFile(root, 'proof', 'site-r1.html', '<h1>Edited</h1>');
    expect(saved.artifactManifest?.metadata).toEqual(manifest.metadata);
    manifest.supportingFiles.push('brief.md');
    await writeFile(path.join(dir, 'site-r1.html.artifact.json'), JSON.stringify(manifest));
    await expect(buildDeployFileSet(root, 'proof', 'site-r1.html', scope)).rejects.toThrow('publication manifest');
  });
  it('excludes private siblings for ordinary legacy HTML projects', async () => {
    const { root, dir } = await setup();
    await rm(path.join(dir, 'site-r1.html.artifact.json'));
    const files = await buildDeployFileSet(root, 'proof', 'site-r1.html', {});
    expect(files.map((f) => f.file)).toEqual(['index.html', 'assets/agency-site/r1/hero.png']);
  });
  it('preserves publication metadata and asset scope after a native file rename', async () => {
    const { root, asset, manifest } = await setup();
    await renameProjectFile(root, 'proof', 'site-r1.html', 'approved.html');
    const renamed = await readProjectFile(root, 'proof', 'approved.html');
    expect(renamed.artifactManifest?.metadata).toEqual(manifest.metadata);
    expect(renamed.artifactManifest?.entry).toBe('approved.html');
    expect((await buildDeployFileSet(root, 'proof', 'approved.html', scope)).map((f) => f.file)).toEqual(['index.html', asset]);
  });
});
