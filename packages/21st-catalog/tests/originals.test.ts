import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import originals from '../generated/21st-originals.json' with {type:'json'};
import upstream from '../generated/21st-items.json' with {type:'json'};
import { parseTwenty1stSourceResponse } from '@mish/contracts';
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
test('every saved reference has a distinct independently authored, executable source bundle', () => {
  assert.equal(originals.items.length, 22);
  assert.deepEqual(originals.items.map(x=>x.id).sort(),upstream.rows.map(x=>x.id).sort());
  assert.equal(new Set(originals.items.map(x=>x.sourceSha256)).size,22);
  assert.equal(new Set(originals.items.map(x=>x.files.find(f=>f.path==='index.ts')!.content)).size,22);
  for(const item of originals.items){
    const parsed = parseTwenty1stSourceResponse(item);
    assert.equal(parsed.provenance,'independently-authored');
    for(const f of item.files) assert.equal(f.sha256,sha(f.content),`${item.id}/${f.path}`);
    assert.equal(item.sourceSha256,sha(item.files.map(f=>`${f.path}\0${f.sha256}\n`).join('')));
    const html=item.files.find(f=>f.path==='index.html')!.content;
    const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
    const style=html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    assert.ok(html.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
    assert.ok(html.includes(`'sha256-${createHash('sha256').update(style).digest('base64')}'`));
    assert.ok(!html.includes("'unsafe-inline'"));
    assert.match(html,/connect-src 'none'/);
    assert.match(item.files.find(f=>f.path==='component.js')!.content,/export function mount/);
    assert.ok(!item.files.find(f=>f.path==='component.js')!.content.includes('import '));
    assert.match(item.files.find(f=>f.path==='README.md')!.content,/Open index.html/);
    assert.match(item.files.find(f=>f.path==='NOTICE.txt')!.content,/not the upstream component/);
  }
});
test('source boundary refuses unsafe or incomplete export paths',()=>{
 const item=originals.items[0]!;
 assert.throws(()=>parseTwenty1stSourceResponse({...item,files:item.files.map((f,i)=>i?f:{...f,path:'../outside.ts'})}));
 assert.throws(()=>parseTwenty1stSourceResponse({...item,files:item.files.slice(1)}));
 assert.throws(()=>parseTwenty1stSourceResponse({...item,provenance:'upstream'}));
});
