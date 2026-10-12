import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyPrivate21stKit } from '@/resources/21st-private.js';

const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mm-private-pack-')); roots.push(root);
  const directory = join(root, 'source'); await mkdir(directory);
  const inventoryDir = join(root, 'packages', '21st-catalog', 'generated'); await mkdir(inventoryDir, { recursive: true });
  await writeFile(join(inventoryDir, '21st-items.json'), JSON.stringify({ rows: [{ id: '21st:test-card' }] }));
  const file = { path: 'components/card.tsx', content: 'export const Card = () => "Actual card"', sha256: '' }; file.sha256 = sha(file.content);
  const entry = { id: '21st:test-card', slug: 'test-card', title: 'Actual card', description: 'Saved upstream component', sourceVerified: true,
    sourceSha256: sha(`${file.path}\0${file.sha256}\n`), sourceFiles: [file], assets: { script: 'card.js', style: 'style.css' },
    assetSha256: { script: sha('window.card=true;'), style: sha('body{margin:0}') } };
  const save = () => writeFile(join(directory, 'preview-manifest.json'), JSON.stringify({ schema: '21st-private-previews/1', items: [entry] }));
  await save(); await writeFile(join(directory, 'card.js'), 'window.card=true;'); await writeFile(join(directory, 'style.css'), 'body{margin:0}');
  await writeFile(join(directory, 'personal-auth.json'), 'MUST NOT SHIP');
  const resourceRoot = join(root, 'resources');
  return { root, directory, entry, save, destination: join(resourceRoot, 'data', 'component-kits', '21st-private'),
    options: { namespace: 'team-internal', workspaceRoot: root, resourceRoot, env: { OD_TEAM_21ST_PREVIEW_DIR: directory } } };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('ships only pinned assets and source, removes old files, and omits the kit without explicit opt-in', async () => {
  const f = await fixture(); await mkdir(f.destination, { recursive: true }); await writeFile(join(f.destination, 'stale.js'), 'old');
  await copyPrivate21stKit(f.options);
  expect((await readdir(f.destination)).sort()).toEqual(['card.js', 'preview-manifest.json', 'style.css']);
  expect(await readFile(join(f.destination, 'card.js'), 'utf8')).toBe('window.card=true;');
  const manifest = JSON.parse(await readFile(join(f.destination, 'preview-manifest.json'), 'utf8'));
  expect(manifest.items[0].sourceFiles[0].content).toContain('Actual card');
  await copyPrivate21stKit({ ...f.options, env: {} });
  await expect(readdir(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('omits unrelated manifest metadata and refuses unverified source', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'preview-manifest.json'), JSON.stringify({ schema: '21st-private-previews/1', personalAuth: 'MUST NOT SHIP',
    items: [{ ...f.entry, personalAuth: 'MUST NOT SHIP' }] }));
  await copyPrivate21stKit(f.options);
  expect(await readFile(join(f.destination, 'preview-manifest.json'), 'utf8')).not.toContain('MUST NOT SHIP');
  f.entry.sourceVerified = false; await f.save();
  await expect(copyPrivate21stKit(f.options)).rejects.toThrow('invalid or incomplete');
});
it('refuses non-team namespaces and incomplete inventories', async () => {
  const f = await fixture();
  await expect(copyPrivate21stKit({ ...f.options, namespace: 'default' })).rejects.toThrow('invalid or incomplete');
  await writeFile(join(f.directory, 'preview-manifest.json'), JSON.stringify({ schema: '21st-private-previews/1', items: [] }));
  await expect(copyPrivate21stKit(f.options)).rejects.toThrow('invalid or incomplete');
});
it('refuses changed sources and scripts before copying', async () => {
  const f = await fixture(); f.entry.sourceFiles[0]!.content = 'modified'; await f.save();
  await expect(copyPrivate21stKit(f.options)).rejects.toThrow('invalid or incomplete');
  const g = await fixture(); await writeFile(join(g.directory, 'card.js'), 'modified');
  await expect(copyPrivate21stKit(g.options)).rejects.toThrow('invalid or incomplete');
  await expect(readdir(g.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses assets escaping through names or symlinks', async () => {
  const f = await fixture(); f.entry.assets.script = '../outside.js'; await f.save();
  await expect(copyPrivate21stKit(f.options)).rejects.toThrow('invalid or incomplete');
  const g = await fixture(); await rm(join(g.directory, 'card.js')); await writeFile(join(g.root, 'outside.js'), 'window.card=true;');
  await symlink(join(g.root, 'outside.js'), join(g.directory, 'card.js'));
  await expect(copyPrivate21stKit(g.options)).rejects.toThrow('invalid or incomplete');
});
