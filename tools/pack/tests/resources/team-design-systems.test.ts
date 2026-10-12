import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyTeamDesignSystems } from '@/resources/team-design-systems.js';

const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mm-team-studies-')); roots.push(root);
  const directory = join(root, 'source');
  const id = 'study-example-12345678';
  const source = join(directory, id); await mkdir(join(source, 'preview'), { recursive: true });
  const content: Record<string, string> = {
    'manifest.json': JSON.stringify({ schemaVersion: 'od-design-system-project/v1', id, name: 'Example', files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' } }),
    'DESIGN.md': '# Example\n\nSource-backed rules.',
    'tokens.css': ':root{--background:#fff}',
    'components.html': '<p>Example components</p>',
    'preview/showcase.html': '<p>Example showcase</p>',
  };
  for (const [file, value] of Object.entries(content)) await writeFile(join(source, file), value);
  const entry = { id, files: Object.entries(content).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha(value) })) };
  const save = () => writeFile(join(directory, 'team-design-systems.json'), JSON.stringify({ schema: 'team-design-systems/1', packages: [entry] }));
  await save(); await writeFile(join(source, 'personal-auth.json'), 'MUST NOT SHIP');
  const resourceRoot = join(root, 'resources'); const destination = join(resourceRoot, 'design-systems');
  await mkdir(join(destination, 'neutral-product'), { recursive: true });
  await writeFile(join(destination, 'neutral-product', 'DESIGN.md'), '# Built-in');
  return { root, directory, source, entry, save, destination, options: { namespace: 'team-internal', resourceRoot, env: { OD_TEAM_DESIGN_SYSTEMS_DIR: directory } } };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('ships only pinned study files beside built-ins and excludes personal files', async () => {
  const f = await fixture(); await copyTeamDesignSystems(f.options);
  expect((await readdir(f.destination)).sort()).toEqual(['.approvals', 'neutral-product', f.entry.id].sort());
  expect(await readFile(join(f.destination, f.entry.id, 'preview/showcase.html'), 'utf8')).toContain('Example showcase');
  expect(await readFile(join(f.destination, 'neutral-product', 'DESIGN.md'), 'utf8')).toBe('# Built-in');
  expect(await readdir(join(f.destination, f.entry.id))).not.toContain('personal-auth.json');
});
it('does nothing without opt-in and rejects opt-in outside the private namespace', async () => {
  const f = await fixture(); await copyTeamDesignSystems({ ...f.options, env: {} });
  await copyTeamDesignSystems({ ...f.options, env: { OD_TEAM_DESIGN_SYSTEMS_DIR: '  ' } });
  expect(await readdir(f.destination)).toEqual(['neutral-product']);
  await expect(copyTeamDesignSystems({ ...f.options, namespace: 'default' })).rejects.toThrow('invalid private design-system kit');
});
it('accepts a native token/document package without optional component files', async () => {
  const f = await fixture(); const manifest = JSON.parse(await readFile(join(f.source, 'manifest.json'), 'utf8'));
  delete manifest.files.components; const content = JSON.stringify(manifest);
  await writeFile(join(f.source, 'manifest.json'), content); await rm(join(f.source, 'components.html'));
  f.entry.files = f.entry.files.filter(file => file.path !== 'components.html');
  f.entry.files[0]!.bytes = Buffer.byteLength(content); f.entry.files[0]!.sha256 = sha(content); await f.save();
  await copyTeamDesignSystems(f.options);
  expect(await readFile(join(f.destination, f.entry.id, 'tokens.css'), 'utf8')).toContain('--background');
});
it.each(['source/auth-backup.json', 'assets/service-account-key.json', 'source/api-credentials.json', 'source/token.json', 'source/session.json', 'source/access-token.json', 'source/api-token.json', 'source/refresh-token.json', 'source/user-session.json', 'assets/basic-auth.json', 'source/google-service-account.json', 'source/oauth2.json'])('rejects credential-shaped filenames: %s', async (path) => {
  const f = await fixture(); f.entry.files.push({ path, bytes: 13, sha256: sha('MUST NOT SHIP') }); await f.save();
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
});
it('validates later packages before materializing an earlier valid package', async () => {
  const f = await fixture(); const id = 'study-second-12345678'; await cp(f.source, join(f.directory, id), { recursive: true });
  const second = structuredClone(f.entry); second.id = id;
  const native = JSON.parse(await readFile(join(f.directory, id, 'manifest.json'), 'utf8')); native.id = id;
  const content = JSON.stringify(native); await writeFile(join(f.directory, id, 'manifest.json'), content);
  second.files[0]!.bytes = Buffer.byteLength(content); second.files[0]!.sha256 = sha(content);
  await writeFile(join(f.directory, id, 'tokens.css'), 'changed later package');
  await writeFile(join(f.directory, 'team-design-systems.json'), JSON.stringify({ schema: 'team-design-systems/1', packages: [f.entry, second] }));
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  expect(await readdir(f.destination)).toEqual(['neutral-product']);
});
it('rejects changed or missing bytes before materializing any study', async () => {
  const f = await fixture(); await writeFile(join(f.source, 'tokens.css'), 'changed');
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  expect(await readdir(f.destination)).toEqual(['neutral-product']);
  const g = await fixture(); await rm(join(g.source, 'DESIGN.md'));
  await expect(copyTeamDesignSystems(g.options)).rejects.toThrow('invalid private design-system kit');
});
it('rejects path escapes, symlinks, duplicate files and unrelated auth data', async () => {
  const f = await fixture(); f.entry.files[0]!.path = '../outside.json'; await f.save();
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  const g = await fixture(); await rm(join(g.source, 'DESIGN.md')); await writeFile(join(g.root, 'outside.md'), '# Example\n\nSource-backed rules.');
  await symlink(join(g.root, 'outside.md'), join(g.source, 'DESIGN.md'));
  await expect(copyTeamDesignSystems(g.options)).rejects.toThrow('invalid private design-system kit');
  const h = await fixture(); h.entry.files.push(h.entry.files[0]!); await h.save();
  await expect(copyTeamDesignSystems(h.options)).rejects.toThrow('invalid private design-system kit');
  const j = await fixture(); j.entry.files.push({ path: 'personal-auth.json', bytes: 13, sha256: sha('MUST NOT SHIP') }); await j.save();
  await expect(copyTeamDesignSystems(j.options)).rejects.toThrow('invalid private design-system kit');
  const k = await fixture(); k.entry.files.push({ path: 'source/auth.json', bytes: 13, sha256: sha('MUST NOT SHIP') }); await k.save();
  await expect(copyTeamDesignSystems(k.options)).rejects.toThrow('invalid private design-system kit');
});
it('rejects empty or duplicate packages, collisions and mismatched native manifests', async () => {
  const f = await fixture(); await writeFile(join(f.directory, 'team-design-systems.json'), JSON.stringify({ schema: 'team-design-systems/1', packages: [] }));
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  const g = await fixture(); await writeFile(join(g.directory, 'team-design-systems.json'), JSON.stringify({ schema: 'team-design-systems/1', packages: [g.entry, g.entry] }));
  await expect(copyTeamDesignSystems(g.options)).rejects.toThrow('invalid private design-system kit');
  const h = await fixture(); await mkdir(join(h.destination, h.entry.id));
  await expect(copyTeamDesignSystems(h.options)).rejects.toThrow('invalid private design-system kit');
  const j = await fixture(); const invalid = JSON.stringify({ schemaVersion: 'od-design-system-project/v1', id: 'wrong', files: { design: 'DESIGN.md', tokens: 'tokens.css' } });
  await writeFile(join(j.source, 'manifest.json'), invalid); j.entry.files[0]!.bytes = Buffer.byteLength(invalid); j.entry.files[0]!.sha256 = sha(invalid); await j.save();
  await expect(copyTeamDesignSystems(j.options)).rejects.toThrow('invalid private design-system kit');
});
it('rejects native preview references omitted from the pinned package', async () => {
  const f = await fixture(); const original = JSON.parse(await readFile(join(f.source, 'manifest.json'), 'utf8'));
  original.preview = { dir: 'preview', pages: [{ path: 'preview/missing.html' }] };
  const content = JSON.stringify(original); await writeFile(join(f.source, 'manifest.json'), content);
  f.entry.files[0]!.bytes = Buffer.byteLength(content); f.entry.files[0]!.sha256 = sha(content); await f.save();
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  expect(await readdir(f.destination)).toEqual(['neutral-product']);
});
it.each(['source/capture.json', 'source/capture.md', 'preview/capture.html', 'preview/capture.css', 'assets/capture.svg'])('rejects captured URL tokens in text artifacts: %s', async (path) => {
  const f = await fixture();
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ exp: 2592000000 })).toString('base64url'), 'fixture-signature'].join('.');
  const content = JSON.stringify({ page_url: `https://example.test/onboarding?token=${token}` });
  await mkdir(join(f.source, path.split('/')[0]!), { recursive: true }); await writeFile(join(f.source, path), content);
  f.entry.files.push({ path, bytes: Buffer.byteLength(content), sha256: sha(content) }); await f.save();
  await expect(copyTeamDesignSystems(f.options)).rejects.toThrow('invalid private design-system kit');
  expect(await readdir(f.destination)).toEqual(['neutral-product']);
});

it('copies pinned font faces, stylesheets and OFL provenance for private systems', async () => {
  const f = await fixture();
  const files: Record<string, string> = {
    'fonts/inter/inter.woff2': 'reviewed fixture font bytes',
    'fonts/inter/OFL.txt': 'SIL Open Font License fixture',
    'fonts/fonts.css': '@font-face{font-family:Inter;src:url(./inter/inter.woff2)}',
    'fonts/package-fonts.json': '{"families":[]}',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(f.source, path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(f.source, path), content);
    f.entry.files.push({ path, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const manifest = JSON.parse(await readFile(join(f.source, 'manifest.json'), 'utf8'));
  manifest.fonts = [{ family: 'Inter', file: 'fonts/inter/inter.woff2' }];
  const content = JSON.stringify(manifest);
  await writeFile(join(f.source, 'manifest.json'), content);
  f.entry.files[0]!.bytes = Buffer.byteLength(content); f.entry.files[0]!.sha256 = sha(content);
  await f.save();
  await copyTeamDesignSystems(f.options);
  for (const [path, content] of Object.entries(files)) {
    expect(await readFile(join(f.destination, f.entry.id, path), 'utf8')).toBe(content);
  }
});

it('seeds approval bound to the pinned bytes that were packaged', async () => {
  const f = await fixture(); await copyTeamDesignSystems(f.options);
  const hash = createHash('sha256');
  const entries = [['metadata.json', '{"surface":"web"}'], ...await Promise.all(f.entry.files.map(async file => [file.path, await readFile(join(f.destination, f.entry.id, file.path))] as const)).then(files => files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))] as const;
  for (const [file, bytes] of entries) { hash.update(JSON.stringify([file, Buffer.byteLength(bytes)])); hash.update(bytes); }
  const revision = hash.digest('hex');
  expect(JSON.parse(await readFile(join(f.destination, '.approvals', f.entry.id + '.json'), 'utf8'))).toEqual({ approved: true, revision });
});
