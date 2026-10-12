import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyBundledComponentKit } from '@/resources/component-kits.js';
it('refuses altered or unlisted component payload files before packaging', async () => {
  const root=await mkdtemp(join(tmpdir(),'mm-kit-pack-'));
  const kit=join(root,'data','component-kits','cult-ui-pro');
  try {
    await mkdir(join(kit,'registry'),{recursive:true});
    const bytes=Buffer.from('{"name":"demo"}');
    await writeFile(join(kit,'registry','demo.json'),bytes);
    await writeFile(join(kit,'manifest.json'),JSON.stringify({schemaVersion:1,files:[{file:'registry/demo.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    await verifyBundledComponentKit(root);
    await writeFile(join(kit,'registry','demo.json'),'altered');
    await expect(verifyBundledComponentKit(root)).rejects.toThrow('checksum mismatch');
    await writeFile(join(kit,'registry','demo.json'),bytes);
    await writeFile(join(kit,'fetch-token.txt'),'do not ship');
    await expect(verifyBundledComponentKit(root)).rejects.toThrow('Unlisted');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('packages a public checkout that carries no licensed kit', async () => {
  const root=await mkdtemp(join(tmpdir(),'mm-kit-absent-'));
  try {
    await expect(verifyBundledComponentKit(root)).resolves.toBeUndefined();
    await mkdir(join(root,'data','component-kits','cult-ui-pro'),{recursive:true});
    await expect(verifyBundledComponentKit(root)).resolves.toBeUndefined();
    // A manifest that is present is still verified.
    await writeFile(join(root,'data','component-kits','cult-ui-pro','manifest.json'),'{"schemaVersion":2}');
    await expect(verifyBundledComponentKit(root)).rejects.toThrow('Invalid bundled component manifest');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('copies the resource trees of a public checkout without a kit or community pets', async () => {
  const workspace=await mkdtemp(join(tmpdir(),'mm-public-ws-'));
  const out=await mkdtemp(join(tmpdir(),'mm-public-out-'));
  try {
    for (const dir of ['skills','design-templates','design-systems','craft',join('plugins','_official'),join('plugins','registry'),join('assets','frames'),join('data','plugin-previews'),join('data','component-kits')]) {
      await mkdir(join(workspace,dir),{recursive:true});
      await writeFile(join(workspace,dir,'keep.txt'),'x');
    }
    const { copyBundledResourceTrees } = await import('@/resources/index.js');
    await copyBundledResourceTrees({ workspaceRoot: workspace, resourceRoot: out });
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(out,'skills','keep.txt'))).isFile()).toBe(true);
    await expect(stat(join(out,'community-pets'))).resolves.toBeTruthy();
  } finally { await rm(workspace,{recursive:true,force:true}); await rm(out,{recursive:true,force:true}); }
});
