import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkRenderQuality, RenderQualityError } from '../src/render-quality.ts';
import { arrayMinimaFor, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { duplicateVariableItems } from '../src/sparse-content.ts';
const page = (content: string) => `<html><head><title>Example</title></head><body><h1>Shared practice</h1>${content}</body></html>`;
test('concrete structural failures are separate from fact verification', () => {
  for (const [html,check] of [
    ['<h2>Only a section heading</h2>','page-heading'],[page('<h1>Second page heading</h1>'),'page-heading'],['<h1> &nbsp; </h1>','page-heading'],
    [page('<div id="same"></div><div id="same"></div>'),'unique-ids'],[page('<input placeholder="Email">'),'form-labels'],[page('<a href="#">Apply</a>'),'link-destinations'],[page('<a href="#missing">Apply</a>'),'link-destinations'],[page('<a href="mailto:">Apply</a>'),'link-destinations']]) {
    const result=checkRenderQuality(html);assert.equal(result.passed,false);assert(result.issues.some(i=>i.check===check));assert.equal(new RenderQualityError(result).code,'render-quality-failed');
  }
});
test('native disclosures, contact links, labels and inline-script examples remain valid', () => {
  const html=page(`<div id="join"></div><a href="#join">Join</a><a href="mailto:team@example.com">Email</a><a href="tel:+12065550148">Call</a><a href="https://example.com">Website</a>
  <details><summary>Question</summary>Answer</details><label for="name">Name</label><input id="name"><label>Message<textarea></textarea></label><input aria-label="Search"><span id="email-label">Email</span><input aria-labelledby="email-label"><input type="hidden"><input type="submit" value="Review">
  <script>const example='<h1>Fake heading</h1><a href="#">Example</a>';</script><!-- <h1>Not a heading</h1> --><template><h1>Future content</h1></template>`);
  assert.equal(checkRenderQuality(html).passed,true);
  assert.equal(checkRenderQuality(page('<span id="empty"></span><input aria-labelledby="empty">')).passed,false);
});
test('valid relative URLs, encoded fragments and quoted greater-than signs do not cause false failures', () => {
  assert.equal(checkRenderQuality(page('<a href="/privacy">Privacy</a><a href="./guide.html">Guide</a><a href="?page=2">Next</a><div id="a&amp;b"></div><a href="#a%26b">Jump</a><input aria-label="Value > threshold" data-json="value > threshold"><h1 aria-hidden="true">Decorative repetition</h1>')).passed, true);
  assert.equal(checkRenderQuality(page('<input id="a&amp;b"><label for="a&amp;b">Name &amp; title</label>')).passed, true);
  assert.equal(checkRenderQuality(page('<a href="javascript&#58;alert(1)">Bad</a>')).passed, false);
  assert.equal(checkRenderQuality(page('<a href="#missing%20id">Missing</a>')).passed, false);
  assert.equal(checkRenderQuality('<h1 aria-label=" > "></h1>').passed, true);
  assert.equal(checkRenderQuality(page('<label>Name<input></label><span id="name">Name</span><input aria-labelledby="name absent">')).passed, true);
});
test('declared static prototypes keep their scope and still refuse duplicate IDs', () => {
  const result=checkRenderQuality('<h2>Dashboard</h2><input placeholder="Search"><a href="#">Tab</a>','static-prototype');
  assert.equal(result.passed,true);assert.deepEqual(result.checks,['unique-ids']);
  assert.equal(checkRenderQuality('<div id="x"></div><div id="x"></div>','static-prototype').passed,false);
});
test('HTML naming semantics handle hidden ancestors, nested referenced labels and explicit label ownership', () => {
  assert.equal(checkRenderQuality(page('<div hidden><h1>Hidden</h1></div><div aria-hidden="true"><h1>Decorative</h1></div>')).passed, true);
  assert.equal(checkRenderQuality('<div hidden><h1>Only hidden heading</h1></div>').passed, false);
  assert.equal(checkRenderQuality(page('<div id="real"><div></div>Email</div><input aria-labelledby="real">')).passed, true);
  assert.equal(checkRenderQuality(page('<label for="a">Name<input id="b"></label><input id="a">')).passed, false);
  assert.equal(checkRenderQuality(page('<a href="javascript&#58alert(1)">Unsafe</a>')).passed, false);
  assert.equal(checkRenderQuality(page('<a href="https:///">Missing host</a>')).passed, false);
  assert.equal(checkRenderQuality(page('<div id="a&#38b"></div><a href="#a%26b">Encoded</a>')).passed, true);
  const error = new RenderQualityError(checkRenderQuality(page('<a href="javascript:secret-client-fact">Bad</a>')));
  assert.equal(error.message, 'Rendered output failed structure checks');
  assert(error.report.issues.length > 0, 'detailed local report remains available without leaking through message');
});
test('all 19 bundled family reference and minimum-length variable recipes pass the structural contract', async () => {
  const root=path.resolve(import.meta.dirname,'../../../plugins/_official/examples');let count=0;
  for(const name of readdirSync(root).filter(name=>name.startsWith('agency-'))){
    const family=name.slice(7),scripts=path.join(root,name,'compiler/scripts');
    const {FAMILIES}=await import(path.join(scripts,'families/registry.ts'));const module=FAMILIES[family];if(!module)continue;
    const recipe=module.validate(JSON.parse(readFileSync(path.join(scripts,`families/${family}/reference.fixture.json`),'utf8')));
    const schema=JSON.parse(readFileSync(path.join(scripts,`families/${family}/recipe.schema.json`),'utf8')) as JsonObject;
    const minima=arrayMinimaFor(schema,recipe);
    function shortest(value:Json, shape:Json|undefined):Json {
      if(typeof shape==='number'&&Array.isArray(value))return value.slice(0,shape);
      if(Array.isArray(value))return value.map((item,index)=>shortest(item,Array.isArray(shape)?shape[index]:undefined));
      if(isObject(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shortest(item,isObject(shape)?shape[key]:undefined)]));
      return value;
    }
    for(const [label,candidate] of [['reference',recipe],['minimum',module.validate(shortest(recipe,minima))]] as const){
      const assets=Object.fromEntries(module.requirements(candidate).map((a:{id:string;kind:string})=>[a.id,`assets/test/${a.id}.${a.kind==='font'?'woff2':a.kind==='video'?'mp4':'png'}`]));
      const result=checkRenderQuality(module.render(candidate,assets,{outputScope:module.outputScope}),module.outputScope);
      assert.deepEqual(result.issues,[],`${family}/${label}`);
      assert.deepEqual(duplicateVariableItems(candidate,minima),[],`${family}/${label}: distinct variable records`);
    }
    count++;
  }
  assert.equal(count,19);
});
test('a control hidden from assistive technology and out of the tab order is decoration, not an unlabelled control', () => {
  assert.equal(checkRenderQuality(page('<input type="range" disabled aria-hidden="true" tabindex="-1">')).passed, true);
  assert.equal(checkRenderQuality(page('<div aria-hidden="true"><input type="range" disabled></div>')).passed, true);
  // Still a control someone can reach: hidden but focusable, or disabled but exposed.
  assert.equal(checkRenderQuality(page('<input type="range" aria-hidden="true">')).passed, false);
  assert.equal(checkRenderQuality(page('<input type="range" disabled>')).passed, false);
  // Sol review of #286 (BLOCK 2): tabindex -1 only leaves the tab order; the input is still enabled
  // and focusable, so it still needs a label.
  assert.equal(checkRenderQuality(page('<input type="email" aria-hidden="true" tabindex="-1">')).passed, false);
  assert.equal(checkRenderQuality(page('<div aria-hidden="true"><input type="email" tabindex="-1"></div>')).passed, false);
});
