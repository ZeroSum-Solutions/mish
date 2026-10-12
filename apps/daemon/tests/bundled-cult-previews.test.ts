import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BundledCultPreviews } from '../src/services/bundled-cult-previews.js';
import { resolveCultKitDir } from '../src/cult-registry.js';

let root: string;
afterEach(() => { if (root) rmSync(root, {recursive:true,force:true}); });
describe('bundled components on a teammate Mac', () => {
  it('resolves the installed resource root with no external source-kit environment', async () => {
    root = mkdtempSync(join(tmpdir(),'mm-components-'));
    const kit = join(root,'data','component-kits','cult-ui-pro');
    mkdirSync(join(kit,'previews'), {recursive:true});
    const file='previews/demo.light.html.gz';
    const bytes=gzipSync('<!doctype html><button>Demo</button>');
    writeFileSync(join(kit,file), bytes);
    writeFileSync(join(kit,'manifest.json'),JSON.stringify({schemaVersion:1,files:[{file,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    writeFileSync(join(kit,'previews','manifest.json'),JSON.stringify({schemaVersion:1,items:[{name:'demo',live:true,supportsDark:false,light:file},{name:'server-demo',live:false,reason:'Needs an API connection.'}]}));
    expect(resolveCultKitDir({},root)).toBe(kit);
    expect(resolveCultKitDir({CULT_KIT_DIR:'explicit'},root)).toBe(resolve('explicit'));
    const previews=new BundledCultPreviews(kit);
    expect(await previews.info('demo')).toEqual({live:true,supportsDark:false,mockNote:null});
    expect(await previews.page('demo','light')).toEqual({status:200,html:'<!doctype html><button>Demo</button>'});
    expect(await previews.page('server-demo','light')).toEqual({status:422,reason:'Needs an API connection.'});
    writeFileSync(join(kit,file),gzipSync('altered'));
    await expect(previews.page('demo','light')).rejects.toThrow('checksum mismatch');
    expect(await previews.page('../secret','light')).toMatchObject({status:422});
  });
});
