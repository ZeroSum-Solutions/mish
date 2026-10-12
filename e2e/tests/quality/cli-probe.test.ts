import { test,expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { T } from '../../lib/timeouts.ts';
test('the tsx CLI transform can serialize the browser conversion probe without runtime helpers',async()=>{
  await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/quality-probe-'));
  const probe=new URL('../../benchmarks/quality/probes.ts',import.meta.url).href;
  const playwright=new URL('../../node_modules/@playwright/test/index.mjs',import.meta.url).href;
  try {
    const script=join(root,'probe.ts');await writeFile(script,`import {chromium} from ${JSON.stringify(playwright)};import {conversionProbe} from ${JSON.stringify(probe)};const browser=await chromium.launch();try{const page=await browser.newPage();await page.goto('about:blank');await page.setContent('<a href="#contact">Book</a><section id="contact">Local request</section>');const result=await conversionProbe(page,{action:'Book',labels:['Book'],destinationRoles:[],demoOnly:true},[],[]);console.log(JSON.stringify(result));}finally{await browser.close();}`);
    const result=await promisify(execFile)(process.execPath,[new URL('../../node_modules/tsx/dist/cli.mjs',import.meta.url).pathname,script],{timeout:T.long});
    expect(JSON.parse(result.stdout)).toMatchObject({exists:true,resolves:true});
  } finally {await rm(root,{recursive:true,force:true});}
},T.long);
