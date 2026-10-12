/**
 * Verifies `porterStem` against Porter's own worked examples (his 1980 paper's Step 1 example
 * list plus a handful of the paper's own overall-algorithm sample words) — proof this is the
 * published algorithm, not a reimplementation that happens to look similar.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { porterStem } from '../src/porter-stemmer.ts';

test('porterStem: Step 1a/1b/1c worked examples from the paper', () => {
  const cases: Array<[string, string]> = [
    ['caresses', 'caress'],
    ['ponies', 'poni'],
    ['ties', 'ti'],
    ['caress', 'caress'],
    ['cats', 'cat'],
    ['feed', 'feed'],
    ['agreed', 'agre'],
    ['plastered', 'plaster'],
    ['bled', 'bled'],
    ['motoring', 'motor'],
    ['sing', 'sing'],
    ['conflated', 'conflat'],
    ['troubled', 'troubl'],
    ['sized', 'size'],
    ['hopping', 'hop'],
    ['tanned', 'tan'],
    ['falling', 'fall'],
    ['hissing', 'hiss'],
    ['fizzed', 'fizz'],
    ['failing', 'fail'],
    ['filing', 'file'],
    ['happy', 'happi'],
    ['sky', 'sky'],
  ];
  for (const [input, expected] of cases) assert.equal(porterStem(input), expected, `porterStem(${JSON.stringify(input)})`);
});

test('porterStem: full-pipeline (steps 2-5) worked examples from the paper', () => {
  const cases: Array<[string, string]> = [
    ['relational', 'relat'],
    ['conditional', 'condit'],
    ['rational', 'ration'],
    ['valenci', 'valenc'],
    ['hesitanci', 'hesit'],
    ['digitizer', 'digit'],
    ['conformabli', 'conform'],
    ['radicalli', 'radic'],
    ['differentli', 'differ'],
    ['vileli', 'vile'],
    ['analogousli', 'analog'],
    ['vietnamization', 'vietnam'],
    ['predication', 'predic'],
    ['operator', 'oper'],
    ['feudalism', 'feudal'],
    ['decisiveness', 'decis'],
    ['hopefulness', 'hope'],
    ['callousness', 'callous'],
    ['formaliti', 'formal'],
    ['sensitiviti', 'sensit'],
    ['sensibiliti', 'sensibl'],
    ['triplicate', 'triplic'],
    ['formative', 'form'],
    ['formalize', 'formal'],
    ['electriciti', 'electr'],
    ['electrical', 'electr'],
    ['hopeful', 'hope'],
    ['goodness', 'good'],
    ['revival', 'reviv'],
    ['allowance', 'allow'],
    ['inference', 'infer'],
    ['airliner', 'airlin'],
    ['gyroscopic', 'gyroscop'],
    ['adjustable', 'adjust'],
    ['defensible', 'defens'],
    ['irritant', 'irrit'],
    ['replacement', 'replac'],
    ['adjustment', 'adjust'],
    ['dependent', 'depend'],
    ['adoption', 'adopt'],
    ['homologou', 'homolog'],
    ['communism', 'commun'],
    ['activate', 'activ'],
    ['angulariti', 'angular'],
    ['homologous', 'homolog'],
    ['effective', 'effect'],
    ['bowdlerize', 'bowdler'],
    ['probate', 'probat'],
    ['rate', 'rate'],
    ['cease', 'ceas'],
    ['controll', 'control'],
    ['roll', 'roll'],
  ];
  for (const [input, expected] of cases) assert.equal(porterStem(input), expected, `porterStem(${JSON.stringify(input)})`);
});

test('porterStem: short words (2 letters or fewer) are returned unchanged', () => {
  assert.equal(porterStem('is'), 'is');
  assert.equal(porterStem('a'), 'a');
  assert.equal(porterStem(''), '');
});

test('porterStem: is idempotent (stemming an already-stemmed word is a no-op for these examples)', () => {
  for (const word of ['agre', 'motor', 'conflat', 'size', 'hope', 'reviv']) {
    assert.equal(porterStem(word), porterStem(porterStem(word)), `porterStem(${JSON.stringify(word)}) should be stable`);
  }
});
