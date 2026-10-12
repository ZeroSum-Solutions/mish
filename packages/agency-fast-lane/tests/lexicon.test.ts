/**
 * The bundled word list and the lexical completion gate (`src/lexicon.ts`, `lexicalCuts` in
 * `src/text-clip.ts`; Sol review round 3): "Welcom" is a cut of "welcome" even when neither the
 * brief nor the fill uses "welcome", while real words, rare words, inflections and the brief's own
 * brands pass.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { completionOf, inWordList, isKnownWord, stemsOf } from '../src/lexicon.ts';
import { lexicalCuts } from '../src/text-clip.ts';
import { SCOWL_EN_US_50_GZIP_BASE64, SCOWL_EN_US_50_WORDS } from '../src/wordlist/scowl-en-us-50.ts';

const BRIEF = 'Ledgerline is accounting software for small creative agencies. Ledgerline connects to Stripe, QuickBooks and Gusto.';
const briefWords = new Set([...BRIEF.matchAll(/[A-Za-z]+/gu)].map((m) => m[0].toLowerCase()));

test('the bundled list: under 400 KB as code, loads in well under a second, and holds the words it claims', () => {
  assert.ok(SCOWL_EN_US_50_GZIP_BASE64.length < 400 * 1024, `${SCOWL_EN_US_50_GZIP_BASE64.length} bytes`);
  const started = performance.now();
  const words = gunzipSync(Buffer.from(SCOWL_EN_US_50_GZIP_BASE64, 'base64')).toString('utf8').split('\n');
  const ms = performance.now() - started;
  assert.equal(words.length, SCOWL_EN_US_50_WORDS);
  assert.ok(ms < 500, `decode took ${ms.toFixed(1)} ms`);
  for (const word of ['welcome', 'invoice', 'payroll', 'laptop', 'email']) assert.ok(inWordList(word), word);
  console.log(`# word list: ${words.length} words, ${SCOWL_EN_US_50_GZIP_BASE64.length} base64 bytes, decoded in ${ms.toFixed(1)} ms`);
});

test('stems and completions', () => {
  assert.ok(stemsOf('invoices').includes('invoice'));
  assert.ok(stemsOf('planning').includes('plan'));
  assert.ok(isKnownWord('invoices') && isKnownWord('ledgerline', briefWords) && !isKnownWord('welcom'));
  assert.equal(completionOf('welcom'), 'welcome');
  assert.equal(completionOf('welcome'), 'welcomed');
  assert.equal(completionOf('zzzq'), undefined);
});

test('lexicalCuts: "Welcom" is a cut; real, rare and inflected words, acronyms and the brief\'s brands are not', () => {
  assert.deepEqual(lexicalCuts('Welcom to the studio', briefWords), [{ word: 'Welcom', of: 'welcome' }]);
  assert.deepEqual(lexicalCuts('Send every invoic today', briefWords).map((cut) => cut.word), ['invoic']);
  const fine = 'Welcome laptop blog emails online signup login dashboard onboarding workflows freelancers bookkeeping invoicing payouts '
    + 'sesquipedalian petrichor susurrus quixotic ineffable serendipity analytics webinars integrations subscriptions checkout inbox '
    + 'API CSV SaaS Ledgerline QuickBooks Gusto Stripe planning tracked';
  assert.deepEqual(lexicalCuts(fine, briefWords), []);
});
