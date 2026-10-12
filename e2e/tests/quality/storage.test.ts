import {test,expect} from 'vitest';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as storage from '../../benchmarks/quality/storage.ts';
test('publishes complete JSON snapshots atomically and never replaces an exclusive receipt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'quality-atomic-'));const file=join(root,'state.json');
  try {
    await storage.writeJsonAtomic(file,{revision:0},true);
    await expect(storage.writeJsonAtomic(file,{revision:1},true)).rejects.toThrow(/EEXIST/);
    expect(JSON.parse(await readFile(file,'utf8'))).toEqual({revision:0});
    let done=false;let reads=0;const reader=(async()=>{while(!done){JSON.parse(await readFile(file,'utf8'));reads++;}})();
    try {for(let revision=1;revision<=30;revision++)await storage.writeJsonAtomic(file,{revision,payload:'x'.repeat(64000)});} finally {done=true;await reader;}
    expect(reads).toBeGreaterThan(0);expect(JSON.parse(await readFile(file,'utf8')).revision).toBe(30);expect(await readdir(root)).toEqual(['state.json']);
  } finally {await rm(root,{recursive:true,force:true});}
});
