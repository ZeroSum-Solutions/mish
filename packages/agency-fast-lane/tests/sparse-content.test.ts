import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateVariableItems } from '../src/sparse-content.ts';
import { checkRenderQuality, RenderQualityError } from '../src/render-quality.ts';
import { runFastLane, type RunEvent } from '../src/run.ts';
import type { FamilyPackage } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, promptBlock } from './fixtures.ts';
import type { ModelCall } from '../src/deepseek.ts';
const record={title:'Shared making',body:'Working alongside other makers'};
test('variable arrays reject full-record duplicates, not shared titles or prices',()=>{
  assert.equal(duplicateVariableItems({items:[record,{...record}]},{items:1}).length,1);
  assert.equal(duplicateVariableItems({items:[{id:'a',...record},{id:'b',title:' Shared making ',body:record.body}]},{items:1}).length,1);
  assert.deepEqual(duplicateVariableItems({items:[{title:'Polish',body:'Workshop'},{title:'polish',body:'Workshop'}]},{items:1}),[],'case can change semantic meaning');
  assert.deepEqual(duplicateVariableItems({items:[{title:'Membership',price:'$20',body:'Studio'},{title:'Membership',price:'$20',body:'Workshop'}]},{items:1}),[]);
  assert.deepEqual(duplicateVariableItems({items:[record,record]},undefined),[],'fixed arrays unchanged');
  assert.deepEqual(duplicateVariableItems({items:['same','same']},{items:0}),[],'primitive repetitions are outside full-record policy');
});
function packageFor(min=1):FamilyPackage {
 const fixture:JsonObject={schemaVersion:2,family:'quality-test',revision:1,brand:{name:'Fieldwork'},sections:[{id:'shared',type:'cards',text:{heading:'Shared practice'},items:[record,{title:'Skills',body:'Learning alongside other makers'},{title:'Discussion',body:'Talking about work'}]}]};
 const text={type:'string',minLength:1,maxLength:120};
 const schema:JsonObject={type:'object',properties:{brand:{type:'object',properties:{name:text}},sections:{type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{text:{type:'object',properties:{heading:text}},items:{type:'array',minItems:min,maxItems:3,items:{type:'object',properties:{title:text,body:text}}}}}}}};
 return {family:'quality-test',packageDir:'',fixture,schema,manifest:{},assetsDir:'',checkRenderQuality,
 render(input,entry){assert(isObject(input));const sections=input.sections as JsonObject[];const cards=sections[0]!.items as JsonObject[];assert(cards.length>=min&&cards.length<=3);return {recipe:input,html:`<h1>${(sections[0]!.text as JsonObject).heading}</h1><section id="shared">${cards.map(c=>`<h2>${c.title}</h2><p>${c.body}</p>`).join('')}</section>`,manifest:{entry,supportingFiles:[],metadata:{agencySite:{recipeDigest:'test',revision:'1',family:'quality-test',outputScope:'site'}}},approvedAssets:[]};},async readAsset(){throw new Error('no assets');}};
}
function modelFor(count:number,repair=false):ModelCall & {prompts:string[]} {
 const prompts:string[]=[];const model=(async({user})=>{prompts.push(user);const template=promptBlock(user,'TEMPLATE') as JsonObject;
 const chosen=repair&&user.includes('YOUR PREVIOUS ANSWER WAS REJECTED')?1:count;
 const sections=Array.isArray(template.sections)?template.sections as JsonObject[]:[template];
 for(const section of sections)if(Array.isArray(section.items))section.items=Array.from({length:chosen},()=>structuredClone(record));
 return{text:JSON.stringify(template),ms:1,retries:0};}) as ModelCall&{prompts:string[]};model.prompts=prompts;return model;
}
const brief='Fieldwork. Shared practice. Shared making. Working alongside other makers.';
const publisher=():ProjectPublisher&{pages:string[]}=>({projectId:'p',pages:[],async savePage(_entry,html){this.pages.push(html);},async saveFile(){},async deleteProject(){return'deleted';}});
test('strict sparse fill publishes one real record without restoring template filler',async()=>{
 const pub=publisher(),events:RunEvent[]=[];
 const report=await runFastLane({pkg:packageFor(),brief,entry:'page.html',revision:1,mode:'single',model:modelFor(1),modelName:'fake',strict:true,verify:fakeJevChecker(),ensurePublisher:async()=>({publisher:pub,created:true}),onEvent:e=>events.push(e)});
 assert.equal(((report.recipe as JsonObject).sections as JsonObject[])[0]!.items instanceof Array,true);
 assert.equal((((report.recipe as JsonObject).sections as JsonObject[])[0]!.items as Json[]).length,1);
 assert.equal(report.strict?.passed,true);assert.equal(report.renderQuality?.passed,true);assert.equal(pub.pages.length,1);assert(!report.html.includes('Talking about work'));assert(events.some(e=>e.type==='render-quality'));
});
test('duplicate filler is technically repaired by shortening the list, with strict fact gates intact',async()=>{
 const model=modelFor(3,true),pub=publisher();
 const report=await runFastLane({pkg:packageFor(),brief,entry:'page.html',revision:1,mode:'single',model,modelName:'fake',strict:true,verify:fakeJevChecker(),ensurePublisher:async()=>({publisher:pub,created:true})});
 assert(model.prompts.some(p=>p.includes('Duplicate filler in variable arrays')));assert.equal(report.strict?.passed,true);assert.equal((((report.recipe as JsonObject).sections as JsonObject[])[0]!.items as Json[]).length,1);assert.equal(pub.pages.length,1);
});
test('duplicate variable content fails without factual verification, fixed arrays retain exact-count behavior',async()=>{
 await assert.rejects(runFastLane({pkg:packageFor(),brief,entry:'page.html',revision:1,mode:'single',model:modelFor(3),modelName:'fake',maxRepairs:0}),/refused/i);
 const report=await runFastLane({pkg:packageFor(3),brief,entry:'page.html',revision:1,mode:'single',model:modelFor(3),modelName:'fake'});assert.equal(report.verify,undefined);assert.equal((((report.recipe as JsonObject).sections as JsonObject[])[0]!.items as Json[]).length,3);
});
test('a malformed final render cannot publish in strict or progressive mode, and emits a distinct quality failure',async()=>{
 for(const strict of [true,false]){const pkg=packageFor(),base=pkg.render;let renders=0;pkg.render=(...args)=>{const result=base(...args);renders++;return renders===1?result:{...result,html:result.html.replace(/<h1>[\s\S]*?<\/h1>/,'')};};const pub=publisher(),events:RunEvent[]=[];
 await assert.rejects(runFastLane({pkg,brief,entry:'page.html',revision:1,mode:'single',model:modelFor(1),modelName:'fake',strict,...(strict?{verify:fakeJevChecker(),ensurePublisher:async()=>({publisher:pub,created:true})}:{publisher:pub}),onEvent:e=>events.push(e)}),e=>e instanceof RenderQualityError);
 assert.equal(pub.pages.length,0);assert(events.some(e=>e.type==='render-quality'&&!e.report.passed));}
});
