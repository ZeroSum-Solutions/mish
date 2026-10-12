import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserPrompt, CLAIM_SENTENCE_RULE } from '../src/prompt.ts';

const input = { brief: 'Riverbend Dental in Boise.', template: { brand: { name: 'Stratum' } }, limits: { brand: { name: 40 } }, scope: 'Fill the page' };

test('the fill prompt forbids unstated facts and never asks for a plausible value', () => {
  const plain = buildUserPrompt(input);
  const nullable = buildUserPrompt({ ...input, nullable: { brand: { name: 'name' } } });
  for (const prompt of [plain, nullable]) {
    assert.ok(!/plausible/i.test(prompt), 'no instruction to invent a plausible value');
    assert.ok(prompt.includes('Facts come only from the brief.'));
    assert.ok(prompt.includes('Numbers, dates, times, prices, amounts, counts, contact details, names and quotes may appear only when the brief states them.'));
    assert.ok(prompt.includes('never invent one'));
    assert.ok(prompt.includes('"Get in touch for details"') && prompt.includes('"Contact us for dates"'), 'names the neutral phrasing');
    // G8 dry run: "Ask for pricing" is itself a claim sentence ("pricing") the gate traces, so it
    // is no longer offered as the neutral example.
    assert.equal(prompt.includes('Ask for pricing'), false);
    assert.ok(prompt.includes(CLAIM_SENTENCE_RULE), 'claim sentences must reuse the brief\'s own words');
  }
  assert.ok(nullable.includes('never invent one: return null if NULLABLE names the value'));
  assert.equal(plain.includes('NULLABLE'), false, 'no NULLABLE wording without a NULLABLE block');
});

test('a SAMPLE block names the illustrative slots and asks for an example, never an empty value', () => {
  const plain = buildUserPrompt(input);
  const sampled = buildUserPrompt({ ...input, sample: { brand: { name: 'sample' } } });
  assert.equal(plain.includes('SAMPLE'), false, 'no SAMPLE wording without a SAMPLE block');
  assert.ok(sampled.includes('\nSAMPLE\n{'));
  assert.ok(sampled.includes('(SAMPLE values excepted, see below)'));
  assert.ok(sampled.includes('Never return null or an empty string for a SAMPLE value.'));
  for (const prompt of [plain, sampled]) {
    assert.ok(prompt.includes('A value that is not a fact (a heading, a label, a blurb, a button text) is never empty'), 'non-fact text is never left empty');
  }
});

test('an ARRAY MINIMA block tells the model an array may be shorter than TEMPLATE, and names its floor', () => {
  const plain = buildUserPrompt(input);
  const withMinima = buildUserPrompt({ ...input, arrayMinima: { sections: [{ items: 1 }] } });
  assert.equal(plain.includes('ARRAY MINIMA'), false, 'no ARRAY MINIMA wording without one');
  assert.ok(plain.includes('the same array lengths'), 'without ARRAY MINIMA, TEMPLATE\'s own array lengths are still mandatory');
  assert.ok(!withMinima.includes('the same array lengths'), 'with ARRAY MINIMA, the blanket "same array lengths" instruction is dropped');
  assert.ok(withMinima.includes('\nARRAY MINIMA\n{'));
  assert.ok(withMinima.includes('the fewest items you may return there'));
  assert.ok(withMinima.includes('never invent one, split one real fact into several entries'));
  assert.ok(withMinima.includes('repeat the SAME person, product or fact twice under different wording'), 'names the exact padding pattern a live sparse-vet build showed (the same real provider repeated under different filler text)');
  assert.ok(withMinima.includes('Do not pad to TEMPLATE\'s length with generic filler or repeated records'));
  assert.ok(withMinima.includes('Every retained fact still follows all fact, name and quote rules above'));
  assert.ok(withMinima.includes('a minimum of 0 means the array may be empty'));
  assert.ok(withMinima.includes('Every array NOT named in ARRAY MINIMA has no minimum at all'), 'a family that never uses this convention sees no change in what its arrays require');
});

test('a TRACEABLE block names the real-fact slots and asks the model to reuse the brief\'s own words', () => {
  const plain = buildUserPrompt(input);
  const traced = buildUserPrompt({ ...input, traceable: { brand: { name: 'traceable' } } });
  assert.equal(plain.includes('TRACEABLE'), false, 'no TRACEABLE wording without a TRACEABLE block');
  assert.ok(traced.includes('\nTRACEABLE\n{'));
  assert.ok(traced.includes("brief's OWN words"), 'the model is told to reuse the brief\'s own wording, not paraphrase');
  assert.ok(traced.includes('do not paraphrase, summarize, or substitute a synonym'));
});
