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
