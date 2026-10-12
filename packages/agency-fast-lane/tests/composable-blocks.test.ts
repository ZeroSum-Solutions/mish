/**
 * G9 dry run: a composed page never plans with a block that must invent links or show a vendor
 * name (`section-overlay.ts`'s `composeRefusalFor`). The dry run's passing page carried
 * `cult:marketing-footer-apple`: GitHub/X/Discord icon links to `#contact`, 18 model-written link
 * labels ("Stripe" twice, "Reports", "Login") and "App Studio" in place of the brand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { autoCoverage, loadBlockCatalogFromSource } from '../src/block-plan.ts';
import { composeRefusalFor, listComposableAdapterIds, listSectionAdapterIds, MAX_COMPOSED_LINK_LABELS, resolveSectionAdapter, type SectionAdapter } from '../src/section-overlay.ts';

const baseAdapter: SectionAdapter = {id:'test:fixture',version:'1',sourceBlockId:'test:fixture',sourceSha256:'',roles:[],text:[],css:'',render:()=>'<p>Fixture</p>'};
test('vendor-icon blocks are refused for a fixed third-party link name', () => {
 const adapter = {...baseAdapter, links: [{name:'vendor',href:'#contact'}], render:()=>'<a href="#contact" aria-label="Discord"><svg></svg></a>'};
 assert.equal(composeRefusalFor(adapter), 'fixed-link-name');
});
test('a block with too many model-written link labels is refused', () => {
 const links = Array.from({length: MAX_COMPOSED_LINK_LABELS + 1},(_,i)=>({name:`link${i}`,href:'#contact',label:`label${i}`}));
 assert.equal(composeRefusalFor({...baseAdapter, links}), 'too-many-link-labels');
});
test('each public HyperUI block is composable', async () => {
 for(const id of await listSectionAdapterIds()) assert.equal(composeRefusalFor(await resolveSectionAdapter(id)), undefined, id);
});

test('an icon link whose name comes from a slot is not a fixed link name', () => {
  const adapter: SectionAdapter = {
    id: 'test:x', version: '1', sourceBlockId: 'test:x', sourceSha256: '', roles: [], css: '',
    text: [{ name: 'label', max: 20 }],
    links: [{ name: 'link1', href: '#contact', label: 'label' }],
    render: (fill) => `<a aria-label="${fill.text?.label ?? ''}" href="#contact"><svg></svg></a>`,
  };
  assert.equal(composeRefusalFor(adapter), undefined);
  const fixed: SectionAdapter = { ...adapter, render: () => '<a aria-label="Discord" href="#contact"><svg></svg></a>' };
  assert.equal(composeRefusalFor(fixed), 'fixed-link-name');
});

test('the planner catalog holds only composable blocks, and does not advertise automatic product-adoption coverage', async () => {
  const composable = new Set(await listComposableAdapterIds());
  const all = await listSectionAdapterIds();
  assert.deepEqual(all.filter(id => !composable.has(id)), []);
  const catalog = await loadBlockCatalogFromSource();
  for (const block of catalog.blocks) assert.ok(composable.has(block.id), block.id);
  assert.equal(catalog.blocks.some((block) => block.id === 'cult:marketing-footer-apple'), false);
  assert.equal(autoCoverage(catalog, 'PA'), false, 'public HyperUI blocks alone do not claim automatic spine coverage');
});

test('an adapter that throws on render is refused, not treated as composable', () => {
  const adapter: SectionAdapter = {
    id: 'test:throws', version: '1', sourceBlockId: 'test:throws', sourceSha256: '', roles: [], css: '',
    text: [{ name: 'label', max: 20 }],
    render: () => { throw new Error('boom'); },
  };
  assert.equal(composeRefusalFor(adapter), 'render-failed');
});
