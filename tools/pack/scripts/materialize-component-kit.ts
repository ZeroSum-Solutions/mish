/** Internal-team licensed payload generator; only reviewed source-kit inputs. */
import { readFileSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
const harness=process.env.CULT_PREVIEW_HARNESS_DIR;
if (!harness) throw new Error('Set CULT_PREVIEW_HARNESS_DIR to the reviewed preview harness.');
const {inspect,pageHtml}=await import(pathToFileURL(join(harness,'lib','build.mjs')).href);
const kit=process.env.CULT_KIT_DIR;
if (!kit) throw new Error('Set CULT_KIT_DIR to the licensed, pinned source kit.');
const destination=process.argv[2];
if (!destination) throw new Error('Provide an empty staging output directory.');
const out=destination;
mkdirSync(out,{recursive:true});
if(readdirSync(out).length) throw new Error('Output directory must be empty.');
const catalog=JSON.parse(readFileSync('packages/cult-ui-catalog/catalog.json','utf8'));
const sha=(b: Buffer)=>createHash('sha256').update(b).digest('hex');
const files: Array<{file:string;bytes:number;sha256:string}>=[];
function put(rel: string,bytes: Buffer){mkdirSync(join(out,rel,'..'),{recursive:true});writeFileSync(join(out,rel),bytes);files.push({file:rel,bytes:bytes.length,sha256:sha(bytes)});}
for(const row of catalog.rows.filter(r=>!r.derivedFrom)){
 const rel=`registry/${row.name}.json`;const b=readFileSync(join(kit,rel));if(sha(b)!==row.source.registrySha256)throw new Error(`Kit drift: ${row.name}`);put(rel,b);
}
for(const row of catalog.rows.filter(r=>['section','page'].includes(r.assetKind))){
 for(const name of ['template.html','styles.css','slots.json']){try{const rel=`converted/${row.name}/${name}`;put(rel,readFileSync(join(kit,rel)));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
const previews: Array<Record<string,unknown>>=[];
for(const row of catalog.rows.filter(r=>['primitive','app'].includes(r.assetKind))){
 const b=await inspect(row.name);
 const info=b.live?{live:true,supportsDark:b.supportsDark,mockNote:b.mockNote??null}:{live:false,reason:b.reason};
 const entry: Record<string,unknown>={name:row.name,...info};
 if(b.live){for(const theme of ['light','dark']){const rel=`previews/${row.name}.${theme}.html.gz`;put(rel,gzipSync(Buffer.from(pageHtml(b,theme)),{level:9}));entry[theme]=rel;}}
 previews.push(entry);
}
put('previews/manifest.json',Buffer.from(JSON.stringify({schemaVersion:1,items:previews},null,2)+'\n'));
writeFileSync(join(out,'manifest.json'),JSON.stringify({schemaVersion:1,licenseEvidence:'docs/legal/cult-ui-pro-rights.md',registryItems:291,previewItems:previews.length,files},null,2)+'\n');
console.log(JSON.stringify({files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),previewReady:previews.filter(p=>p.live).length,previewUnavailable:previews.filter(p=>!p.live).map(p=>({name:p.name,reason:p.reason}))}));
