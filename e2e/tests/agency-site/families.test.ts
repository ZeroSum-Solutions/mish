import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../../design-templates/agency-site/scripts/compose.ts';
import { renderAgencySite } from '../../../design-templates/agency-site/scripts/render.ts';
import { getEmmpoAssetRequirements } from '../../../design-templates/agency-site/scripts/families/emmpo/contract.ts';
import { getWatsonAssetRequirements } from '../../../design-templates/agency-site/scripts/families/watson/contract.ts';

const template = fileURLToPath(new URL('../../../design-templates/agency-site/', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=', 'base64');
function media(kind: string): { suffix: string; mediaType: string; bytes: Buffer } {
  if (kind === 'image') return { suffix: 'png', mediaType: 'image/png', bytes: png };
  if (kind === 'font') { const bytes = Buffer.alloc(44); bytes.write('wOFF'); bytes.writeUInt32BE(44, 8); return { suffix: 'woff', mediaType: 'font/woff', bytes }; }
  const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftypisom', 4); bytes.write('mp42', 16);
  return { suffix: 'mp4', mediaType: 'video/mp4', bytes };
}
async function setup(family: 'emmpo' | 'watson' = 'emmpo') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-families-')); roots.push(dir);
  const assetsDir = path.join(dir, 'media'); await mkdir(assetsDir);
  const recipe = JSON.parse(await readFile(path.join(template, `scripts/families/${family}/reference.fixture.json`), 'utf8'));
  const requirements = family === 'emmpo' ? getEmmpoAssetRequirements(recipe) : getWatsonAssetRequirements(recipe);
  const assets = await Promise.all(requirements.map(async ({ id, kind }, index) => {
    const item = media(kind), file = `approved-${index}.${item.suffix}`;
    await writeFile(path.join(assetsDir, file), item.bytes);
    return { id, file, kind, mediaType: item.mediaType, bytes: item.bytes.length, sha256: createHash('sha256').update(item.bytes).digest('hex') };
  }));
  const manifest = { version: 1, assets };
  const input = path.join(dir, 'recipe.json'), roster = path.join(dir, 'approved.json'), output = path.join(dir, 'candidate');
  await writeFile(input, JSON.stringify(recipe)); await writeFile(roster, JSON.stringify(manifest));
  return { dir, assetsDir, recipe, manifest, input, roster, output };
}

describe('Agency Site family composition', () => {
  it.each(['emmpo', 'watson'] as const)('[P1] compiles %s through trusted dispatch, copies only approved IDs and refuses edited output', async (family) => {
    const s = await setup(family);
    await writeFile(path.join(s.assetsDir, 'private-brief.txt'), 'Do not publish');
    const first = renderAgencySite(s.recipe, 'site.html', s.manifest);
    expect(renderAgencySite(s.recipe, 'site.html', s.manifest)).toEqual(first);
    expect(first.html).toContain(`data-family="${family}"`);
    expect(first.manifest.metadata.agencySite).toMatchObject({ publication: 'closed-assets-v2', rendererVersion: '2.0.0', revision: `${family}-r1` });
    expect(first.manifest.sourceSkillId).toBe('agency-site');
    expect(first.manifest.metadata.agencySite.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    const result = await compose(s.input, s.assetsDir, s.output, 'site.html', s.roster);
    expect(await readFile(result.entry, 'utf8')).toBe(first.html);
    expect(result.supportingFiles).toHaveLength(s.manifest.assets.length);
    for (const item of s.manifest.assets) expect(await readFile(path.join(s.output, `assets/agency-site/${family}-r1/${item.file}`))).toEqual(await readFile(path.join(s.assetsDir, item.file)));
    await expect(readFile(path.join(s.output, 'private-brief.txt'))).rejects.toThrow();
    await writeFile(result.entry, '<h1>Saved manual change</h1>');
    await expect(compose(s.input, s.assetsDir, s.output, 'site.html', s.roster)).rejects.toThrow();
    expect(await readFile(result.entry, 'utf8')).toBe('<h1>Saved manual change</h1>');
  });

  it.each(['missing-roster', 'unknown-family', 'unknown-id', 'recipe-path', 'roster-traversal', 'duplicate-id', 'wrong-kind', 'wrong-mime', 'wrong-hash', 'wrong-size', 'disguised-bytes', 'vector', 'symlink', 'symlink-root'])('[P1] rejects %s without creating output', async (attack) => {
    const s = await setup('watson');
    const item = s.manifest.assets[0]!;
    let mediaRoot = s.assetsDir;
    if (attack === 'unknown-family') s.recipe.family = '../emmpo';
    if (attack === 'unknown-id') s.recipe.brand.fonts.display = 'unapproved-font';
    if (attack === 'recipe-path') s.recipe.brand.fonts.display = '../secret.woff';
    if (attack === 'roster-traversal') item.file = '../secret.woff';
    if (attack === 'duplicate-id') s.manifest.assets.push({ ...item, file: 'other.woff' });
    if (attack === 'wrong-kind') item.kind = 'image';
    if (attack === 'wrong-mime') item.mediaType = 'text/html';
    if (attack === 'wrong-hash') item.sha256 = 'a'.repeat(64);
    if (attack === 'wrong-size') item.bytes += 1;
    if (attack === 'vector') { item.file = 'vector.svg'; item.kind = 'image'; }
    if (attack === 'disguised-bytes') await writeFile(path.join(s.assetsDir, item.file), '<script>not a font</script>');
    if (attack === 'symlink') { await rm(path.join(s.assetsDir, item.file)); await writeFile(path.join(s.dir, 'secret.woff'), media('font').bytes); await symlink(path.join(s.dir, 'secret.woff'), path.join(s.assetsDir, item.file)); }
    if (attack === 'symlink-root') { mediaRoot = path.join(s.dir, 'linked-media'); await symlink(s.assetsDir, mediaRoot); }
    await writeFile(s.input, JSON.stringify(s.recipe)); await writeFile(s.roster, JSON.stringify(s.manifest));
    await expect(compose(s.input, mediaRoot, s.output, 'site.html', attack === 'missing-roster' ? undefined : s.roster)).rejects.toThrow();
    await expect(readFile(path.join(s.output, 'site.html'))).rejects.toThrow();
  });
});
