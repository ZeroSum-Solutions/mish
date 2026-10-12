import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {afterEach,describe,expect,it,vi} from 'vitest';
import JSZip from 'jszip';
import {parseTwenty1stItemResponse,parseTwenty1stListResponse,parseTwenty1stSourceResponse} from '@mish/contracts';
import {Twenty1stPrivatePreviews} from '../src/services/twenty1st-private-previews.js';
import {twenty1stCatalog,registerTwenty1stRoutes} from '../src/routes/twenty1st.js';

const roots:string[]=[];
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(id?:string) {
  const root=mkdtempSync(path.join(tmpdir(),'21st-private-'));roots.push(root);
  const row=(id ? twenty1stCatalog().items.find(row=>row.id===id) : twenty1stCatalog().items[0])!;
  const file={path:'components/card.tsx',content:'export default function Card(){return "Actual card"}',sha256:''};file.sha256=sha(file.content);
  const item={id:row.id,slug:'actual-card',title:row.name,description:'Saved original',sourceVerified:true,sourceSha256:sha(`${file.path}\0${file.sha256}\n`),sourceFiles:[file],assets:{script:'actual-card.js',style:'styles.css'},assetSha256:{script:sha('window.actualCard=true;'),style:sha('body{margin:0}')}};
  writeFileSync(path.join(root,'actual-card.js'),'window.actualCard=true;');
  writeFileSync(path.join(root,'styles.css'),'body{margin:0}');
  const save=()=>writeFileSync(path.join(root,'preview-manifest.json'),JSON.stringify({schema:'21st-private-previews/1',items:[item]}));save();
  return {root,row,item,save};
}
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('private source fidelity',()=>{
  it('blocks a missing nested CommonJS dependency and preserves bytes when restored', async () => {
    for (const present of [false, true]) {
      const {root,row,item,save}=fixture();
      const files=[
        {path:'demo.ts',content:"import helper from './helper';"},
        {path:'helper.cjs',content:"if (require.main === module) console.log(module.filename); module.exports = require('./nested');"},
        ...(present ? [{path:'nested.cjs',content:'module.exports = 1;'}] : []),
      ];
      item.sourceFiles=files.map(file=>({...file,sha256:sha(file.content)}));
      item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
      const before=readFileSync(path.join(root,'preview-manifest.json'));
      const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
      const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
      const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
      try {
        const source=parseTwenty1stSourceResponse(await(await fetch(`${url}/source`)).json());
        expect(source.files).toEqual(item.sourceFiles);
        expect(source.sourceSha256).toBe(item.sourceSha256);
        expect(source).toHaveProperty('localImportClosure',present ? {status:'resolved'} : {status:'missing',missing:[{importer:'helper.cjs',specifier:'./nested',resolvedCandidate:'nested'}]});
        const response=await fetch(`${url}/source?download=zip`);
        expect(response.status).toBe(present ? 200 : 422);
        if (present) {
          const zip=await JSZip.loadAsync(await response.arrayBuffer());
          for (const file of files) expect(await zip.file(file.path)?.async('string')).toBe(file.content);
        } else expect(await response.json()).toHaveProperty('error.code','SOURCE_DEPENDENCY_INCOMPLETE');
        expect(readFileSync(path.join(root,'preview-manifest.json'))).toEqual(before);
      } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    }
  });
  it('downloads complete JSONC/CJS source with declared external packages and preserves exact bytes', async () => {
    const {root,row,item,save}=fixture();
    const files=[
      {path:'gallery/tsconfig.json',content:'{ /* saved config */ "compilerOptions": { "baseUrl": ".", }, }'},
      {path:'gallery/package.json',content:'{"dependencies":{"react":"*"}}'},
      {path:'gallery/demo.ts',content:"import React from 'react'; export * from './helper';"},
      {path:'gallery/helper.cts',content:'export const value = 1;'},
    ];
    item.sourceFiles=files.map(file=>({...file,sha256:sha(file.content)}));
    item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
    const before=readFileSync(path.join(root,'preview-manifest.json'));
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
    try {
      const source=parseTwenty1stSourceResponse(await(await fetch(`${url}/source`)).json());
      expect(source).toHaveProperty('localImportClosure',{status:'resolved'});
      expect(source.files).toEqual(item.sourceFiles);
      const response=await fetch(`${url}/source?download=zip`);expect(response.status).toBe(200);
      const zip=await JSZip.loadAsync(await response.arrayBuffer());
      for(const file of files) expect(await zip.file(file.path)?.async('string')).toBe(file.content);
      expect(readFileSync(path.join(root,'preview-manifest.json'))).toEqual(before);
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('reports the Dashboard-style missing alias in list, detail and JSON, refuses ZIP before bytes, and keeps preview',async()=>{
    const {root,row,item,save}=fixture('21st:uniquesonu-dashboard-activities');
    const imported='import { Separator } from "@/components/ui/separator"; export default Separator;';
    item.sourceFiles[0]={path:'gallery/components/twentyfirst/dashboard/demo.tsx',content:imported,sha256:sha(imported)};
    const tsconfig=JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}});
    item.sourceFiles.push({path:'gallery/tsconfig.json',content:tsconfig,sha256:sha(tsconfig)});
    item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
    const manifestBefore=readFileSync(path.join(root,'preview-manifest.json'));
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st`;
    try {
      const list=parseTwenty1stListResponse(await(await fetch(base)).json());
      const projected=list.catalog.items.find(value=>value.id===row.id)!;
      const detail=parseTwenty1stItemResponse(await(await fetch(`${base}/${encodeURIComponent(row.id)}`)).json());
      const expected={status:'missing',missing:[{importer:'gallery/components/twentyfirst/dashboard/demo.tsx',specifier:'@/components/ui/separator',resolvedCandidate:'gallery/components/ui/separator'}]};
      expect(projected.privateImplementation?.localImportClosure).toEqual(expected);
      expect(detail.item.privateImplementation?.localImportClosure).toEqual(expected);
      const source=parseTwenty1stSourceResponse(await(await fetch(`${base}/${encodeURIComponent(row.id)}/source`)).json());
      expect(source).toHaveProperty('localImportClosure',expected);expect(source.sourceSha256).toBe(item.sourceSha256);
      expect(source.files).toEqual(item.sourceFiles);
      const blocked=await fetch(`${base}/${encodeURIComponent(row.id)}/source?download=zip`);
      expect(blocked.status).toBe(422);expect(blocked.headers.get('content-type')).not.toContain('zip');
      expect(await blocked.json()).toHaveProperty('error.code','SOURCE_DEPENDENCY_INCOMPLETE');
      expect((await fetch(`${base}/${encodeURIComponent(row.id)}/preview`)).status).toBe(200);
      expect(readFileSync(path.join(root,'preview-manifest.json'))).toEqual(manifestBefore);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('serves a ZIP when alias, relative and index imports resolve inside the saved bundle', async () => {
    const {root,row,item,save}=fixture();
    const files=[
      {path:'gallery/tsconfig.json',content:JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}})},
      {path:'gallery/components/demo.tsx',content:"import x from '@/components/ui/separator'; export { y } from './nested';"},
      {path:'gallery/components/ui/separator.tsx',content:'export default 1'},
      {path:'gallery/components/nested/index.ts',content:'export const y = 2'},
    ];
    item.sourceFiles=files.map(file=>({...file,sha256:sha(file.content)}));
    item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
    try {
      const detail=parseTwenty1stItemResponse(await(await fetch(url)).json());expect(detail.item.privateImplementation?.localImportClosure).toEqual({status:'resolved'});
      const response=await fetch(`${url}/source?download=zip`);expect(response.status).toBe(200);
      const zip=await JSZip.loadAsync(await response.arrayBuffer());
      expect(await zip.file('gallery/components/ui/separator.tsx')?.async('string')).toBe('export default 1');
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('guards baseUrl-only source ZIP when the local target is absent and serves it when present', async () => {
    for (const present of [false, true]) {
      const {root,row,item,save}=fixture('21st:uniquesonu-dashboard-activities');
      const files=[
        {path:'gallery/tsconfig.json',content:JSON.stringify({compilerOptions:{baseUrl:'.'}})},
        {path:'gallery/components/demo.tsx',content:"import Separator from 'components/ui/separator'; export default Separator;"},
        ...(present ? [{path:'gallery/components/ui/separator.tsx',content:'export default 1;'}] : []),
      ];
      item.sourceFiles=files.map(file=>({...file,sha256:sha(file.content)}));
      item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
      const manifestBefore=readFileSync(path.join(root,'preview-manifest.json'));
      const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
      const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
      const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
      try {
        const zip=await fetch(`${url}/source?download=zip`);
        expect(zip.status).toBe(present ? 200 : 422);
        expect(zip.headers.get('content-type')).toContain(present ? 'application/zip' : 'application/json');
        const sourceResponse=await fetch(`${url}/source`);
        expect(sourceResponse.status).toBe(200);
        const source=parseTwenty1stSourceResponse(await sourceResponse.json());
        expect(source.sourceSha256).toBe(item.sourceSha256);
        expect(source).toHaveProperty('localImportClosure', present ? {status:'resolved'} : {status:'unverified',reason:'ambiguous-baseurl-import'});
        expect((await fetch(`${url}/preview`)).status).toBe(200);
        expect(readFileSync(path.join(root,'preview-manifest.json'))).toEqual(manifestBefore);
      }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    }
  });
  it.each([
    ['parse-error','import {'],
    ['dynamic-local-import','import(`./${name}`)'],
    ['dynamic-local-import',"module.exports = globalThis['require']('./missing');"],
    ['dynamic-local-import',"globalThis[`require`]('./missing');"],
    ['dynamic-local-import',"const { require: load } = globalThis; load('./missing');"],
    ['dynamic-local-import',"import { createRequire as makeLoader } from 'node:module'; const load = makeLoader(import.meta.url); load('./missing');"],
  ])('refuses ZIP when closure is %s and leaves JSON inspection available', async (reason, content) => {
    const {root,row,item,save}=fixture();
    item.sourceFiles[0]!.content=content;item.sourceFiles[0]!.sha256=sha(content);
    item.sourceSha256=sha(item.sourceFiles.map(file=>`${file.path}\0${file.sha256}\n`).join(''));save();
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
    try {
      const source=parseTwenty1stSourceResponse(await(await fetch(`${url}/source`)).json());expect(source).toHaveProperty('localImportClosure',{status:'unverified',reason});
      const zip=await fetch(`${url}/source?download=zip`);expect(zip.status).toBe(422);expect(zip.headers.get('content-type')).not.toContain('zip');
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('discovers the portable bundled kit through the packaged resource root',async()=>{
    const {root,row}=fixture();
    const resourceRoot=mkdtempSync(path.join(tmpdir(),'21st-resources-'));roots.push(resourceRoot);
    const destination=path.join(resourceRoot,'data','component-kits','21st-private');
    mkdirSync(path.dirname(destination),{recursive:true});renameSync(root,destination);
    vi.stubEnv('TWENTY1ST_PREVIEW_DIR','');vi.stubEnv('OD_RESOURCE_ROOT',path.join(resourceRoot,'unvalidated'));
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{resourceRoot});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body=parseTwenty1stListResponse(await(await fetch(`${base}/api/21st`)).json());
      const item=body.catalog.items.find(item=>item.id===row.id)!;
      expect(item.privateImplementation?.provenance).toBe('upstream-private');
      expect(item.ownedAlternative).toBeUndefined();
      const source=parseTwenty1stSourceResponse(await(await fetch(`${base}${item.privateImplementation!.sourceUrl}`)).json());
      expect(source.files[0]!.content).toContain('Actual card');
      const preview=await(await fetch(`${base}${item.privateImplementation!.previewUrl}`)).text();
      expect(preview).toContain('actual-card.js');expect(preview).not.toContain(resourceRoot);
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('serves the private shell with a hash-pinned size bridge and leaves saved bytes unchanged',async()=>{
    const {root,row,item}=fixture();
    const app=express();registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st/${encodeURIComponent(row.id)}`;
    try {
      const response=await fetch(`${base}/preview`);
      const html=await response.text(),policy=response.headers.get('content-security-policy')!;
      const bridge=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      expect(bridge).toContain('"twentyfirst-preview-size"');expect(bridge).toContain(`id:${JSON.stringify(row.id)}`);
      expect(policy).toContain(`script-src 'self' 'sha256-${createHash('sha256').update(bridge).digest('base64')}'`);
      expect(policy.split(';').find(directive=>directive.trim().startsWith('script-src'))).not.toContain('unsafe-inline');expect(policy).toContain("connect-src 'none'");
      expect(html.indexOf(bridge)).toBeGreaterThan(html.indexOf('actual-card.js'));
      expect(await(await fetch(`${base}/assets/actual-card.js`)).text()).toBe('window.actualCard=true;');
      const source=parseTwenty1stSourceResponse(await(await fetch(`${base}/source`)).json());
      expect(source.files[0]!.content).toBe(item.sourceFiles[0]!.content);expect(source.sourceSha256).toBe(item.sourceSha256);
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('projects real upstream provenance and keeps authorship and rights',()=>{
    const {root,row}=fixture(),store=new Twenty1stPrivatePreviews(root,twenty1stCatalog().items);
    const item=store.project(row);
    expect(item.privateImplementation?.provenance).toBe('upstream-private');
    expect(item.privateImplementation?.sourceVerified).toBe(true);
    expect(item.ownedAlternative).toBeUndefined();
    expect(item.author).toBe(row.author);expect(item.rights).toBe(row.rights);
    expect(store.source(row.slug)?.files[0]?.path).toBe('components/card.tsx');
  });
  it('has no private implementation when a kit is not configured',()=>{
    const row=twenty1stCatalog().items[0]!,store=new Twenty1stPrivatePreviews(undefined,[row]);
    expect(store.project(row)).toBe(row);expect(store.source(row.id)).toBeUndefined();
  });
  it('permits the actual Spotify embed and Spline WASM only for their own previews',()=>{
    const music=fixture('21st:moumensoliman-glassmorphism-listen-app'),spline=fixture('21st:serafimcloud-spline-scene'),ordinary=fixture();
    const policy=(value:ReturnType<typeof fixture>)=>new Twenty1stPrivatePreviews(value.root,twenty1stCatalog().items).preview(value.row.id)!.csp;
    expect(policy(music)).toContain('frame-src https://open.spotify.com/embed/');
    expect(policy(music)).not.toContain('wasm-unsafe-eval');
    expect(policy(spline)).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy(spline)).toContain('https://unpkg.com/@splinetool/runtime@2.0.58/build/bevel.wasm');
    expect(policy(spline)).toContain('media-src https: data: blob:');
    expect(policy(ordinary)).toContain("connect-src 'none'");
    expect(policy(ordinary)).toContain('media-src https: blob:');
    expect(policy(ordinary)).not.toContain('open.spotify.com');expect(policy(ordinary)).not.toContain('wasm-unsafe-eval');
  });
  it('refuses modified source or compiled assets',()=>{
    const {root,item,save}=fixture();
    item.sourceFiles[0]!.content='corrupted';save();
    expect(()=>new Twenty1stPrivatePreviews(root,twenty1stCatalog().items)).toThrow('checksum');
    const second=fixture();writeFileSync(path.join(second.root,'actual-card.js'),'corrupted');
    expect(()=>new Twenty1stPrivatePreviews(second.root,twenty1stCatalog().items)).toThrow('checksum');
  });
  it('refuses unknown IDs, unsafe asset names, and symlink escapes',()=>{
    const first=fixture();first.item.id='21st:unknown';first.save();
    expect(()=>new Twenty1stPrivatePreviews(first.root,twenty1stCatalog().items)).toThrow('identity');
    const second=fixture();second.item.assets.script='../secret.js';second.save();
    expect(()=>new Twenty1stPrivatePreviews(second.root,twenty1stCatalog().items)).toThrow('asset');
    const third=fixture(),outside=fixture();rmSync(path.join(third.root,'actual-card.js'));
    symlinkSync(path.join(outside.root,'actual-card.js'),path.join(third.root,'actual-card.js'));
    expect(()=>new Twenty1stPrivatePreviews(third.root,twenty1stCatalog().items)).toThrow('escapes');
  });
  it('isolates a corrupt optional kit to 21st HTTP errors while other routes remain healthy',async()=>{
    const {root}=fixture();writeFileSync(path.join(root,'actual-card.js'),'corrupted');
    const app=express();
    const sendApiError=(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}});
    expect(()=>registerTwenty1stRoutes(app,{http:{sendApiError}} as never,{previewDir:root})).not.toThrow();
    app.get('/core-health',(_req,res)=>res.json({ok:true}));
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for(const suffix of ['', '/unknown/source', '/unknown/preview', '/unknown/assets/a.js']) {
        const response=await fetch(`${base}/api/21st${suffix}`);
        expect(response.status).toBe(503);expect(await response.text()).toContain('Rebuild the private previews');
      }
      expect(await(await fetch(`${base}/core-health`)).json()).toEqual({ok:true});
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('serves the same saved source, ZIP, and sandbox HTML via HTTP',async()=>{
    const {root,row}=fixture(),app=express();
    registerTwenty1stRoutes(app,{http:{sendApiError:(res:express.Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}})}} as never,{previewDir:root});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,url=`${base}/api/21st/${encodeURIComponent(row.id)}`;
    try{
      const list=parseTwenty1stListResponse(await(await fetch(`${base}/api/21st`)).json());
      expect(list.catalog.items[0]?.privateImplementation?.sourceVerified).toBe(true);
      const source=parseTwenty1stSourceResponse(await(await fetch(`${url}/source`)).json());expect(source.provenance).toBe('upstream-private');
      const zip=await JSZip.loadAsync(await(await fetch(`${url}/source?download=zip`)).arrayBuffer());
      expect(await zip.file('components/card.tsx')?.async('string')).toContain('Actual card');
      const preview=await fetch(`${url}/preview`),html=await preview.text();
      expect(html).toContain('/assets/actual-card.js');expect(html).not.toContain('mount(document');
      expect(preview.headers.get('content-security-policy')).toContain("script-src 'self'");
      const script=await fetch(`${url}/assets/actual-card.js`);expect(await script.text()).toBe('window.actualCard=true;');
      expect(script.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await fetch(`${url}/assets/secret.js`)).status).toBe(404);
      expect((await fetch(`${base}/api/21st/unknown/assets/actual-card.js`)).status).toBe(404);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});

const galleryOriginals = [
  "Explore our collection of innovative solutions and cutting-edge technologies designed to transform your business.",
  "Build Modern UIs",
  "Create stunning user interfaces with our comprehensive design system.",
  "https://cdn.21st.dev/assets/mirror/60/60f1fc317cc965fa57d1bb420b79a441aaebc281f64fceda8b7bff238686177d.png",
  "Computer Vision Technology",
  "Powerful image recognition and processing capabilities that allow AI systems to analyze, understand, and interpret visual information from the world.",
  "https://cdn.21st.dev/assets/mirror/5b/5be809c811b5c484f4f36c477a13b0af7da32fdd20512c7f6c2c38e681e32afa.png",
  "Machine Learning Automation",
  "Self-improving algorithms that learn from data patterns to automate complex tasks and make intelligent decisions with minimal human intervention.",
  "https://cdn.21st.dev/assets/mirror/6c/6c1a829d1b4c7e47d0916ff1ab901e414b6943ca338094e2bbbdba35da4e5446.png",
  "Predictive Analytics",
  "Advanced forecasting capabilities that analyze historical data to predict future trends and outcomes, helping businesses make data-driven decisions.",
  "https://cdn.21st.dev/assets/mirror/ff/ff0d274d6f15232322c8938fc0c067cb4a70ef4e568b8b61256f8254749f9374.png",
  "Neural Network Architecture",
  "Sophisticated AI models inspired by human brain structure, capable of solving complex problems through deep learning and pattern recognition.",
  "https://cdn.21st.dev/assets/mirror/58/58274556122ef7e984b226b075e8ab2c153e238896e21ad4b56d0ce447455c31.png"
];
const copyCases = [
  { id: '21st:hero-ui-card', path: 'gallery/components/twentyfirst/hero-ui-card/demo.tsx', originals: ['Lorem ipsum dolor sit amet consectetur. Sed arcu donec id aliquam dolor sed amet faucibus etiam.'], expected: ['Share a sample of your work and tell the team what you want to create.'] },
  { id: '21st:ruixen-ui-gallery-hover-carousel', path: 'gallery/components/twentyfirst/gallery-hover-carousel/gallery-hover-carousel.tsx', originals: galleryOriginals.filter(text => !text.includes('6c1a829')), expected: ['Browse project images. Use the arrows to move through the collection.', 'Studio workspace', 'Glass vessels', 'Activity dashboard', 'Alpine lake', 'Portrait study', 'A wooden worktable, paper models, and a desk lamp beside a tall studio window.', 'Blue and amber glass vessels on a pale stone plinth against a dark backdrop.', 'A dark dashboard combines an activity chart, region map, and status panels.', 'A still mountain lake bordered by pine trees and pale limestone slopes.', 'An illustrative portrait of a fictional creative director in soft daylight.'] },
];
function reviewedFixture(edit: typeof copyCases[number]) {
  const value = fixture(edit.id), file = value.item.sourceFiles[0]!;
  const literals = edit.id.includes('gallery') ? galleryOriginals : edit.originals;
  file.path = edit.path; file.content = `export const text = ${JSON.stringify(literals)};`; file.sha256 = sha(file.content);
  value.item.sourceSha256 = sha(`${file.path}\0${file.sha256}\n`);
  const script = `window.text = ${JSON.stringify(literals)};`;
  writeFileSync(path.join(value.root, 'actual-card.js'), script);
  value.item.assetSha256.script = sha(script); value.save();
  return value;
}
describe('disclosed reviewed private copy', () => {
  it.each(copyCases)('returns matching refined source and JS for $id while retaining raw pins', edit => {
    const value = reviewedFixture(edit), manifest = readFileSync(path.join(value.root, 'preview-manifest.json'));
    const rawScript = readFileSync(path.join(value.root, 'actual-card.js'));
    const store = new Twenty1stPrivatePreviews(value.root, twenty1stCatalog().items), source = store.source(edit.id)!;
    for (const text of edit.expected) expect(source.files[0]!.content).toContain(text);
    for (const text of edit.originals) expect(source.files[0]!.content).not.toContain(text);
    expect(source.files[0]!.sha256).toBe(sha(source.files[0]!.content));
    expect(source.sourceSha256).toBe(sha(source.files.map(file => `${file.path}\0${file.sha256}\n`).join('')));
    expect(source.sourceSha256).not.toBe(value.item.sourceSha256);
    expect(source).toHaveProperty('sourceVerified', true);
    expect(source).toHaveProperty('refinement.originalSourceSha256', value.item.sourceSha256);
    const projected = store.project(value.row).privateImplementation!;
    expect(projected.sourceSha256).toBe(source.sourceSha256);
    expect(projected.refinement).toEqual(source.provenance === 'upstream-private' ? source.refinement : undefined);
    expect(parseTwenty1stSourceResponse(source)).toEqual(source);
    for (const text of edit.expected) expect(store.asset(edit.id, 'actual-card.js')!.toString()).toContain(text);
    for (const text of edit.originals) expect(store.asset(edit.id, 'actual-card.js')!.toString()).not.toContain(text);
    if (edit.id.includes('gallery')) {
      const sourceUris = source.files[0]!.content.match(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g)!;
      const scriptUris = store.asset(edit.id, 'actual-card.js')!.toString().match(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g)!;
      expect(source.files[0]!.content).toContain(galleryOriginals.find(text => text.includes('6c1a829'))!);
      expect(store.asset(edit.id, 'actual-card.js')!.toString()).toContain(galleryOriginals.find(text => text.includes('6c1a829'))!);
      expect(sourceUris).toEqual(scriptUris); expect(sourceUris).toHaveLength(4); expect(new Set(sourceUris).size).toBe(4);
      expect(source).toHaveProperty('refinement.note', expect.stringContaining('fictional portrait'));
    }
    expect(readFileSync(path.join(value.root, 'actual-card.js'))).toEqual(rawScript);
    expect(readFileSync(path.join(value.root, 'preview-manifest.json'))).toEqual(manifest);
  });
  it('validates raw target source and asset checksums before refining', () => {
    const first = reviewedFixture(copyCases[0]!); first.item.sourceFiles[0]!.content += 'tampered'; first.save();
    expect(() => new Twenty1stPrivatePreviews(first.root, twenty1stCatalog().items)).toThrow('source checksum');
    const second = reviewedFixture(copyCases[1]!); writeFileSync(path.join(second.root, 'actual-card.js'), 'tampered');
    expect(() => new Twenty1stPrivatePreviews(second.root, twenty1stCatalog().items)).toThrow('asset checksum');
  });
  it('refuses literal drift even when the changed raw asset has a valid new pin', () => {
    const value = reviewedFixture(copyCases[0]!);
    const script = 'window.text = "different copy";';
    writeFileSync(path.join(value.root, 'actual-card.js'), script); value.item.assetSha256.script = sha(script); value.save();
    expect(() => new Twenty1stPrivatePreviews(value.root, twenty1stCatalog().items)).toThrow('literal');
  });
  it.each(galleryOriginals.filter(text => !text.includes('6c1a829')))('refuses a duplicate gallery literal: %s', text => {
    const value = reviewedFixture(copyCases[1]!);
    const file = value.item.sourceFiles[0]!;
    file.content += `\n${JSON.stringify(text)}`; file.sha256 = sha(file.content);
    value.item.sourceSha256 = sha(`${file.path}\0${file.sha256}\n`); value.save();
    expect(() => new Twenty1stPrivatePreviews(value.root, twenty1stCatalog().items)).toThrow('exactly once');
  });
  it('keeps every other row source and compiled asset unchanged', () => {
    const value = fixture(), store = new Twenty1stPrivatePreviews(value.root, twenty1stCatalog().items);
    expect(store.source(value.row.id)!.files).toEqual(value.item.sourceFiles);
    expect(store.source(value.row.id)!.sourceSha256).toBe(value.item.sourceSha256);
    expect(store.project(value.row).privateImplementation!.refinement).toBeUndefined();
    expect(store.asset(value.row.id, 'actual-card.js')!.toString()).toBe('window.actualCard=true;');
  });
});

describe('implementation thumbnail route (fixture kit)', () => {
  const sendApiError = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
  async function serve(options: { previewDir?: string; generatedDir?: string }) {
    const app = express();
    registerTwenty1stRoutes(app, { http: { sendApiError } } as never, options);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/21st`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  }

  it('serves a 200 webp for the kit implementation whose source hash the live-thumbnail manifest pins', async () => {
    const { root, row, item } = fixture();
    // A synthetic generated/ directory: one RIFF/WEBP-headed file pinned to the fixture kit's source.
    const generated = mkdtempSync(path.join(tmpdir(), '21st-generated-')); roots.push(generated);
    mkdirSync(path.join(generated, '21st-live-thumbnails'));
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 1)]);
    writeFileSync(path.join(generated, '21st-live-thumbnails', `${row.slug}.webp`), bytes);
    const revision = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(generated, '21st-live-thumbnails.json'), JSON.stringify({ schema: '21st-live-thumbnails/1', items: {
      [row.id]: { file: `${row.slug}.webp`, bytes: bytes.length, revision, sourceSha256: item.sourceSha256, provenance: 'upstream-private', framePath: '/api/21st/x/preview' },
    } }));
    const { base, close } = await serve({ previewDir: root, generatedDir: generated });
    try {
      const listed = parseTwenty1stListResponse(await (await fetch(base)).json()).catalog.items.find(entry => entry.id === row.id)!;
      expect(listed.privateImplementation?.thumbnail).toEqual({ revision });
      const response = await fetch(`${base}/${encodeURIComponent(row.id)}/implementation-thumbnail?revision=${revision}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(response.headers.get('etag')).toBe(`"${revision}"`);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const served = Buffer.from(await response.arrayBuffer());
      expect(served.subarray(0, 4).toString()).toBe('RIFF');
      expect(served.subarray(8, 12).toString()).toBe('WEBP');
      expect(served.equals(bytes)).toBe(true);
      expect((await fetch(`${base}/${encodeURIComponent(row.id)}/implementation-thumbnail?revision=${'0'.repeat(64)}`)).status).toBe(404);
    } finally { await close(); }
  });

  it('hints once when only the pre-rename CULT_21ST_PREVIEW_DIR is set, and never reads it', async () => {
    const { root, row } = fixture();
    vi.stubEnv('CULT_21ST_PREVIEW_DIR', root);
    vi.stubEnv('TWENTY1ST_PREVIEW_DIR', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { base, close } = await serve({});
      try {
        expect(warn.mock.calls.map(call => String(call[0]))).toEqual(['[od] CULT_21ST_PREVIEW_DIR is set: renamed to TWENTY1ST_PREVIEW_DIR; ignored']);
        const item = parseTwenty1stItemResponse(await (await fetch(`${base}/${encodeURIComponent(row.id)}`)).json()).item;
        expect(item.privateImplementation).toBeUndefined();
      } finally { await close(); }
      warn.mockClear();
      vi.stubEnv('TWENTY1ST_PREVIEW_DIR', root);
      const second = await serve({});
      await second.close();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
