/** Brand tokens: written over `recipe.brand`, validated by the family, inputs never changed. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBrandTokens, compile, PublisherError } from '../src/compile.ts';
import { entryHtml, loadExample } from './helpers.ts';

const isInvalid = (error: unknown) => error instanceof PublisherError && error.code === 'invalid-brand-tokens';

test('brand tokens: the name replaces the recipe brand, escaped on the page', async () => {
  const { compiler } = await loadExample('practice');
  const result = await compile({ compiler, spec: { recipe: compiler.reference }, brandTokens: { name: 'Fish & Chips "Dental"' } });
  const html = entryHtml(result);
  assert.ok(html.includes('Fish &amp; Chips &quot;Dental&quot;'));
  assert.ok(!html.includes('Fish & Chips'));
  assert.equal((result.recipe as { brand: { name: string } }).brand.name, 'Fish & Chips "Dental"');
  assert.equal(result.manifest.title, 'Fish & Chips "Dental"');
});

test('brand tokens: markup in a brand token is refused by the family', async () => {
  const { compiler } = await loadExample('practice');
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference }, brandTokens: { name: 'Fish <b>Dental</b>' } }), /markup is not allowed/);
});

test('brand tokens: equal to the recipe brand, they change nothing', async () => {
  const { compiler } = await loadExample('restaurant');
  const brand = compiler.reference.brand as Record<string, string>;
  const plain = await compile({ compiler, spec: { recipe: compiler.reference } });
  const tokened = await compile({ compiler, spec: { recipe: compiler.reference }, brandTokens: { ...brand } });
  assert.equal(tokened.digest, plain.digest);
});

test('brand tokens: neither the recipe nor the tokens are changed', () => {
  const recipe = { family: 'x', brand: { name: 'A', descriptor: 'B' } };
  const tokens = { name: 'C' };
  const out = applyBrandTokens(recipe, tokens);
  assert.deepEqual(recipe, { family: 'x', brand: { name: 'A', descriptor: 'B' } });
  assert.deepEqual(tokens, { name: 'C' });
  assert.deepEqual(out, { family: 'x', brand: { name: 'C', descriptor: 'B' } });
  assert.notEqual(out.brand, recipe.brand);
});

test('brand tokens: malformed tokens are refused', () => {
  const recipe = { brand: { name: 'A' } };
  assert.throws(() => applyBrandTokens(recipe, [] as never), isInvalid);
  assert.throws(() => applyBrandTokens(recipe, 'name' as never), isInvalid);
  assert.throws(() => applyBrandTokens({ brand: 'A' }, { name: 'B' }), isInvalid);
  assert.throws(() => applyBrandTokens(recipe, JSON.parse('{"__proto__": {"polluted": true}}')), isInvalid);
  assert.throws(() => applyBrandTokens(recipe, { constructor: 'x' }), isInvalid);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('brand tokens: the family schema decides which keys exist', async () => {
  const { compiler } = await loadExample('practice');
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference }, brandTokens: { primaryColour: '#ff0000' } }), /recipe\.brand\.primaryColour: unknown field/);
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference }, brandTokens: { name: '' } }), /recipe\.brand\.name: expected non-empty plain text/);
});

test('brand tokens: a spec without a recipe object is refused', async () => {
  const { compiler } = await loadExample('practice');
  await assert.rejects(compile({ compiler, spec: { recipe: null as never } }), (error: unknown) => error instanceof PublisherError && error.code === 'invalid-spec');
});
