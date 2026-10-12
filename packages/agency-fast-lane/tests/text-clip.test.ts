/**
 * Whole-word budgets for the section fill (`src/text-clip.ts`) and their use in
 * `fillSectionAdapter`: the prompt names every slot's limit and word budget, and the last-resort
 * clip never leaves part of a word on the page (goal criterion C21).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SectionAdapter } from '../../../plugins/_official/shared/agency-compiler/scripts/section-adapter.ts';
import type { ModelCall } from '../src/deepseek.ts';
import { budgetsFor, clipAdapterFill, fillSectionAdapter, resolveSectionAdapter as resolvePublicAdapter, SectionSelectionRefusedError } from '../src/section-overlay.ts';
import { briefNames, clipWholeWords, cutNames, isWholeWordPrefix, NUMBER_WORDS, promptLimit, tinyValueStands, wordBudget, wordFragments } from '../src/text-clip.ts';
import { promptBlock } from './fixtures.ts';

// Owned slot-only fixtures exercise fill policy independently of unavailable vendor markup.
async function resolveSectionAdapter(id: string): Promise<SectionAdapter> {
  if (!id.startsWith('test:')) return resolvePublicAdapter(id);
  const text: SectionAdapter['text'] = id === 'test:word-budgets'
    ? [{ name: 'label', max: 7 }, { name: 'detail', max: 80, atom: 'plain' }, { name: 'body', max: 80 }]
    : id === 'test:tiny-budgets'
      ? [1, 2, 3, 4].map(n => ({ name: `item${n}`, max: 3, atom: 'plain' as const }))
      : [{ name: 'heading3b', max: 40 }, { name: 'body', max: 80 }];
  assert.ok(['test:word-budgets', 'test:name-budgets', 'test:tiny-budgets'].includes(id));
  return { id, version: '1', sourceBlockId: id, sourceSha256: '', roles: [], text, css: '', render: () => '<section>Fixture</section>' };
}

const BRIEF = 'Ledgerline, accounting for small creative studios: invoices, time tracking and payroll in one place. Connects to Stripe, QuickBooks and Gusto. Free trial, no card needed.';

/** Texts shaped like the answers that were clipped mid-word in the live proof, plus edge cases. */
const SAMPLES = [
  'No card needed for the free trial',
  'Connect Stripe, QuickBooks and Gusto, send automatic late‑payment reminders, import clients from CSV.',
  '© Ledgerline Inc. All rights reserved.',
  'Ledgerline',
  'All‑in‑One Accounting for Creative Studios – Invoices, Time Tracking & Payroll',
  'Start your free trial today. No card needed. Cancel any time.',
  'Invoices, time tracking and payroll — all in one place for creative studios and freelancers alike',
  'See project profit at a glance (without spreadsheets) and get paid faster',
  'supercalifragilisticexpialidocious word',
  '  leading and trailing spaces   around text  ',
  'Short',
  'a b c d e f g h i j k l m n o p',
  'Ask for pricing, or book a call with our team to talk through your studio’s needs.',
];

test('clipWholeWords: for every sample and every limit, the result fits and is whole words of the source', () => {
  let cases = 0;
  for (const sample of SAMPLES) {
    for (let limit = 1; limit <= sample.length + 2; limit += 1) {
      cases += 1;
      const out = clipWholeWords(sample, limit);
      if (out === undefined) {
        // Nothing fits only when not even the first word (with a letter or digit) does.
        const first = sample.trim().split(/\s+/u)[0]!;
        assert.ok(first.length > limit || !/[\p{L}\p{N}]/u.test(first) || /^(a|an|the|and|or|of|to|for|with)$/i.test(first), `${JSON.stringify(sample)} @${limit}: undefined although "${first}" fits`);
        continue;
      }
      assert.ok(out.length <= limit, `${JSON.stringify(sample)} @${limit}: ${out.length} > ${limit}`);
      assert.ok(out.length > 0 && out === out.trim(), `${JSON.stringify(sample)} @${limit}: untrimmed ${JSON.stringify(out)}`);
      assert.ok(isWholeWordPrefix(sample, out), `${JSON.stringify(sample)} @${limit}: partial word in ${JSON.stringify(out)}`);
      // Independent of the helper: every word but the last is a word of the source, in order,
      // and the last is a source word minus trailing punctuation only.
      const source = sample.trim().split(/\s+/u);
      const words = out.split(/\s+/u);
      words.forEach((word, index) => {
        if (index < words.length - 1) assert.equal(word, source[index]);
        else assert.ok(source[index]!.startsWith(word) && /^[^\p{L}\p{N}]*$/u.test(source[index]!.slice(word.length)), `${JSON.stringify(out)} ends in a fragment of "${source[index]}"`);
      });
    }
  }
  assert.ok(cases > 500);
});

test('clipWholeWords: the proof fragments come out as whole words, a complete sentence is preferred', () => {
  assert.equal(clipWholeWords('No card needed for the free trial', 13), 'No card');
  assert.equal(clipWholeWords('Stripe, QuickBooks and Gusto', 17), 'Stripe');
  assert.equal(clipWholeWords('© Ledgerline', 8), undefined, 'a lone symbol is not copy');
  assert.equal(clipWholeWords('Ledgerline', 7), undefined);
  assert.equal(clipWholeWords('Start your free trial today. No card needed. Cancel any time.', 50), 'Start your free trial today. No card needed.');
  assert.equal(clipWholeWords('Invoices, time tracking and payroll together', 30), 'Invoices, time tracking', 'no trailing connector or comma');
  assert.equal(clipWholeWords('Fits already', 40), 'Fits already');
});

test('promptLimit and wordBudget: headroom only above small limits, at least one word', () => {
  assert.equal(promptLimit(7), 7);
  assert.equal(promptLimit(12), 12);
  assert.equal(promptLimit(58), 49);
  assert.equal(promptLimit(14), 12);
  assert.equal(wordBudget(3), 1);
  assert.equal(wordBudget(49), 8);
  for (let max = 1; max <= 300; max += 1) assert.ok(promptLimit(max) <= max);
});

test('fill prompt (composed): carries every slot\'s character limit and word budget, and LIMITS below the hard maxima', async () => {
  const adapter = await resolveSectionAdapter('test:word-budgets');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    const text = Object.fromEntries(adapter.text.map((slot) => [slot.name, 'Ok']));
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  await fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true });
  const prompt = prompts[0]!;
  assert.match(prompt, /\nBUDGETS\n/);
  assert.match(prompt, /never shorten, abbreviate or cut a word or a product name/);
  for (const slot of adapter.text) {
    const limit = promptLimit(slot.max);
    const words = wordBudget(limit);
    assert.ok(prompt.includes(`- text.${slot.name}: at most ${limit} characters, about ${words} word`), `budget line for ${slot.name}`);
    if (slot.atom) assert.ok(prompt.includes(`- text.${slot.name}: at most ${limit} characters, about ${words} word${words === 1 ? '' : 's'}, or null`), `${slot.name} may be null`);
  }
  assert.deepEqual(budgetsFor(adapter).length, adapter.text.length);
  const limits = promptBlock(prompt, 'LIMITS') as { text: Record<string, number> };
  for (const slot of adapter.text) assert.equal(limits.text[slot.name], promptLimit(slot.max));
});

test('fill prompt: an item group gets one budget line per field', async () => {
  const adapter = { ...await resolveSectionAdapter('test:name-budgets'), items: {name: 'rows', count: 2, fields: [{name: 'label', max: 40}]} };
  const lines = budgetsFor(adapter);
  if (adapter.items) {
    for (const field of adapter.items.fields) assert.ok(lines.some((line) => line.includes(`items.${adapter.items!.name}[0-${adapter.items!.count - 1}].${field.name}: at most ${promptLimit(field.max)} characters`)));
  }
  assert.equal(lines.length, adapter.text.length + (adapter.items?.fields.length ?? 0));
});

/** A model that always answers every slot far over its limit. */
function overLimitModel(adapter: Awaited<ReturnType<typeof resolveSectionAdapter>>, answers: Record<string, string>[]): ModelCall & { prompts: string[] } {
  const prompts: string[] = [];
  const call = (async ({ user }) => {
    prompts.push(user);
    const text: Record<string, string> = {};
    for (const slot of adapter.text) text[slot.name] = `Ledgerline brings invoices, time tracking and payroll together for creative studios. ${'Connect Stripe, QuickBooks and Gusto today. '.repeat(slot.max > 60 ? 6 : 1)}`.trim();
    const items = adapter.items
      ? { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => Object.fromEntries(adapter.items!.fields.map((field) => [field.name, 'Nightly backups keep every studio invoice safe and ready whenever you need it again']))) }
      : undefined;
    answers.push(text);
    return { text: JSON.stringify({ text, ...(items ? { items } : {}) }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

test('fillSectionAdapter: a model that stays over every limit still yields whole words only', async () => {
  let accepted = 0;
  for (const id of ['hyperui:marketing/ctas/1', 'test:name-budgets', 'hyperui:marketing/sections/1']) {
    const adapter = await resolveSectionAdapter(id);
    const answers: Record<string, string>[] = [];
    const model = overLimitModel(adapter, answers);
    let result;
    try {
      result = await fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true });
    } catch (error) {
      // Refusing is allowed (no whole word fits a required slot); emitting a fragment is not.
      assert.ok(error instanceof SectionSelectionRefusedError, `${id}: ${String(error)}`);
      continue;
    }
    accepted += 1;
    assert.ok((result.clipped ?? []).length > 0, `${id}: something was clipped`);
    const raw = answers[answers.length - 1]!;
    for (const slot of adapter.text) {
      const value = result.fill.text?.[slot.name];
      if (value === null || value === undefined) continue;
      assert.ok(value.length <= slot.max, `${id} ${slot.name}: over limit`);
      assert.ok(isWholeWordPrefix(raw[slot.name]!, value), `${id} ${slot.name}: fragment ${JSON.stringify(value)}`);
    }
    // The repair prompt spelled the fix out: the length, the limit and the word budget.
    assert.match(model.prompts[1] ?? '', /Fix: write at most \d+ characters, about \d+ words?, as complete words/);
  }
  assert.ok(accepted >= 1, `clipped fills accepted: ${accepted}`);
});

test('clipAdapterFill: a nullable slot no word fits is omitted; a required one is left over its limit to be refused', async () => {
  const adapter = await resolveSectionAdapter('test:word-budgets');
  const nullable = adapter.text.find((slot) => slot.atom)!;
  const required = adapter.text.find((slot) => !slot.atom && slot.max <= 7)!;
  const long = 'Supercalifragilisticexpialidociousness'.repeat(3);
  const text: Record<string, string> = Object.fromEntries(adapter.text.map((slot) => [slot.name, 'Ok']));
  text[nullable.name] = long;
  const omitted = clipAdapterFill(adapter, { text });
  assert.equal(omitted.fill.text?.[nullable.name], null);
  assert.deepEqual(omitted.paths, [`text.${nullable.name}`]);

  text[nullable.name] = 'Ok';
  text[required.name] = 'Ledgerline';
  const kept = clipAdapterFill(adapter, { text });
  assert.equal(kept.fill.text?.[required.name], 'Ledgerline', 'no fragment: the value stays invalid');
  assert.deepEqual(kept.paths, []);
});

test('fillSectionAdapter: a required label no word of which fits gets one narrow shorten request, never a fragment', async () => {
  const adapter = await resolveSectionAdapter('test:word-budgets');
  const tiny = adapter.text.find((slot) => !slot.atom && slot.max >= 5 && slot.max <= 7)!;
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    const shortening = user.includes('Rewrite only these values');
    // Long slots run over and get clipped; every slot under 12 characters gets a name no word of
    // which fits, until the shorten request.
    const text: Record<string, string> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.max >= 12 ? 'Invoices and payroll for studios, all in one place' : (shortening ? 'Go' : 'Ledgerline')]));
    if (shortening) text[tiny.name] = 'Books';
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true });
  assert.equal(result.fill.text?.[tiny.name], 'Books');
  assert.equal(result.calls, 3, 'two attempts, then the shorten request');
  assert.match(prompts[2]!, new RegExp(`text\\.?${tiny.name}|${tiny.name}: exceeds ${tiny.max} characters`));
  for (const slot of adapter.text) {
    const value = result.fill.text?.[slot.name];
    if (typeof value === 'string' && slot.max >= 12) assert.ok(isWholeWordPrefix('Invoices and payroll for studios, all in one place', value), `${slot.name}: ${JSON.stringify(value)}`);
  }
});

test('fillSectionAdapter: when the shorten request fails too, the fill is refused rather than rendered with a fragment', async () => {
  const adapter = await resolveSectionAdapter('test:word-budgets');
  const model: ModelCall = async () => {
    const text: Record<string, string> = Object.fromEntries(adapter.text.map((slot) => [slot.name, 'Ledgerline']));
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  await assert.rejects(() => fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true }), SectionSelectionRefusedError);
});

test('briefNames and cutNames: a brief name cut short is found; whole names and brief words are not', () => {
  const names = briefNames(BRIEF);
  assert.ok(names.includes('QuickBooks') && names.includes('Stripe') && names.includes('Gusto'));
  const words = new Set([...BRIEF.matchAll(/[A-Za-z][A-Za-z'’]*/gu)].map((m) => m[0].toLowerCase()));
  assert.deepEqual(cutNames('Sync Stripe Quick', names, words), [{ word: 'Quick', name: 'QuickBooks' }]);
  assert.deepEqual(cutNames('Stripe, QuickBooks and Gusto', names, words), []);
  assert.deepEqual(cutNames('Free trial, no card needed', names, words), []);
  assert.deepEqual(cutNames('Fou', [...names, ...NUMBER_WORDS], words), [{ word: 'Fou', name: 'Four' }]);
  assert.deepEqual(cutNames('Tri', names, words), [{ word: 'Tri', name: 'Three' }]);
});

test('fillSectionAdapter: a name cut to fit is sent back once for repair', async () => {
  const adapter = await resolveSectionAdapter('test:name-budgets');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    const repairing = user.includes('YOUR PREVIOUS ANSWER WAS REJECTED');
    const text: Record<string, string | null> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.atom ? null : 'Sync']));
    text.heading3b = repairing ? 'Your tools' : 'Stripe Quick';
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true });
  assert.equal(result.fill.text?.heading3b, 'Your tools');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /cuts the name "QuickBooks" to "Quick"/);
});

test('fillSectionAdapter: a nullable step label still cut after the repair is omitted, never shown', async () => {
  const adapter = await resolveSectionAdapter('test:tiny-budgets');
  const tiny = adapter.text.filter((slot) => slot.atom && slot.max <= 3);
  assert.ok(tiny.length >= 3, 'the step labels are 3-character nullable slots');
  const model: ModelCall = async () => {
    const text: Record<string, string | null> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.max <= 3 ? 'One' : 'Payroll']));
    text[tiny[2]!.name] = 'Tri';
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model, composed: true });
  assert.equal(result.fill.text?.[tiny[2]!.name], null);
  assert.equal(result.fill.text?.[tiny[0]!.name], 'One');
  assert.deepEqual(result.clipped, [`text.${tiny[2]!.name}`]);
  assert.equal(result.calls, 2, 'one repair was asked for first');
});

test('tinyValueStands: a tiny slot keeps numerals, brief words and short common words only', () => {
  const words = new Set([...BRIEF.matchAll(/[A-Za-z][A-Za-z'’]*/gu)].map((m) => m[0].toLowerCase()));
  for (const ok of ['01', '1', 'One', 'Two', 'Yes', 'card', 'Free']) assert.ok(tinyValueStands(ok, 4, words), ok);
  for (const cut of ['Inv', 'Rpt', 'Tri', 'Fou', 'Mgmt']) assert.ok(!tinyValueStands(cut, 4, words), cut);
  assert.ok(tinyValueStands('Invoicing', 12, words), 'above the tiny limit anything goes');
});

const OPENING_BRIEF = 'Ledgerline is bookkeeping software for small creative studios. It sends invoices and runs payroll.';

test('briefNames: a business name that opens the brief (or a sentence) is a name too', () => {
  const names = briefNames(OPENING_BRIEF);
  assert.ok(names.includes('Ledgerline'), `names: ${names.join(', ')}`);
  // Common sentence openers are not names.
  assert.ok(!names.includes('It'));
  assert.ok(briefNames('Welcome to Ledgerline. Tools: Stripe and Gusto.').includes('Stripe'), 'a word after a colon counts');
  assert.ok(!briefNames('Please build a page. There are three plans.').some((name) => name === 'Please' || name === 'There'));
  const words = new Set([...OPENING_BRIEF.matchAll(/[A-Za-z][A-Za-z'’]*/gu)].map((m) => m[0].toLowerCase()));
  assert.deepEqual(cutNames('Ledger for studios', names, words), [{ word: 'Ledger', name: 'Ledgerline' }]);
});

test('fillSectionAdapter (composed): a required slot that still cuts an opening name gets one rewrite, then is refused', async () => {
  const adapter = await resolveSectionAdapter('test:name-budgets');
  const required = adapter.text.find((slot) => !slot.atom && slot.max >= 14)!;
  const answer = (value: string) => {
    const text: Record<string, string | null> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.atom ? null : 'Payroll']));
    text[required.name] = value;
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  // Always cut: two attempts, one narrow rewrite, then refused — never published as "Ledger".
  const prompts: string[] = [];
  const stubborn: ModelCall = async ({ user }) => { prompts.push(user); return answer('Ledger studios'); };
  await assert.rejects(() => fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model: stubborn, composed: true }), SectionSelectionRefusedError);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2]!, /cuts the name "Ledgerline" to "Ledger"/);
  // Fixed by the rewrite: accepted with the name in full.
  let n = 0;
  const fixes: ModelCall = async () => answer(n++ < 2 ? 'Ledger studios' : 'Ledgerline');
  const result = await fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model: fixes, composed: true });
  assert.equal(result.fill.text?.[required.name], 'Ledgerline');
  assert.equal(result.calls, 3);
});

test('fillSectionAdapter (family overlay, default policy): the prompt, repairs and accepted fill are unchanged', async () => {
  const adapter = await resolveSectionAdapter('test:name-budgets');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    const text: Record<string, string | null> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.atom ? null : 'Sync']));
    text.heading3b = 'Stripe Quick';
    return { text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  };
  const result = await fillSectionAdapter({ adapter, brief: BRIEF, model });
  // No name-cut repair, no omission, no clipping: the valid first answer is taken as it is.
  assert.equal(prompts.length, 1);
  assert.equal(result.fill.text?.heading3b, 'Stripe Quick');
  assert.equal(result.clipped, undefined);
  // No BUDGETS block, and LIMITS shows each hard maximum as it is (no headroom).
  assert.ok(!prompts[0]!.includes('BUDGETS'));
  const limits = promptBlock(prompts[0]!, 'LIMITS') as { text: Record<string, number> };
  for (const slot of adapter.text) assert.equal(limits.text[slot.name], slot.max, slot.name);
});

// ---------------------------------------------------------------------------------------------
// Round-2 review: Jev checks the exact final fill; general self-truncation in any slot
// ---------------------------------------------------------------------------------------------

const reply = (text: Record<string, string | null>) => ({ text: JSON.stringify({ text }), usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 });

/** A checker that flags any slot with a price and records every slot it was shown. */
function priceChecker() {
  const seen: Array<Array<{ path: string; text: string }>> = [];
  return {
    seen,
    async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) {
      seen.push(slots.map((slot) => ({ ...slot })));
      return { flagged: slots.filter((slot) => /\$\d/.test(slot.text)).map((slot) => ({ path: slot.path, probability: 0.95 })), ms: 1, calls: 1 };
    },
  };
}

test('fillSectionAdapter (composed): a name-cut rewrite that adds a price is checked by Jev, and a strict fill refuses it', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/sections/1');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    // Two attempts cut the name; the rewrite fixes it but adds an unstated price, and keeps it.
    if (prompts.length <= 2) return reply({ heading: 'Ledger for studios', body: 'Invoices, time tracking and payroll in one place.' });
    return reply({ heading: 'Ledgerline for studios', body: 'Invoices, time tracking and payroll from $49 a month.' });
  };
  const checker = priceChecker();
  await assert.rejects(
    () => fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model, composed: true, verify: checker, strict: true }),
    (error: unknown) => error instanceof SectionSelectionRefusedError && /unsupported facts remain/.test(error.message),
  );
  assert.ok(checker.seen.length > 0, 'Jev ran after the rewrite');
  assert.ok(checker.seen[0]!.some((slot) => slot.text.includes('$49')), 'the checked fill is the rewritten one');
});

test('fillSectionAdapter (composed): the returned fill is exactly the last fill Jev checked', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/sections/1');
  let n = 0;
  const model: ModelCall = async () => {
    n += 1;
    if (n <= 2) return reply({ heading: 'Ledger for studios', body: 'Invoices and payroll.' });
    if (n === 3) return reply({ heading: 'Ledgerline for studios', body: 'Invoices and payroll from $49.' });
    return reply({ heading: 'Ledgerline for studios', body: 'Invoices and payroll in one place.' });
  };
  const checker = priceChecker();
  const result = await fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model, composed: true, verify: checker, strict: true });
  const last = checker.seen.at(-1)!;
  assert.deepEqual(Object.fromEntries(last.map((slot) => [slot.path, slot.text])), { 'text.heading': result.fill.text?.heading, 'text.body': result.fill.text?.body });
  assert.deepEqual(result.remaining, []);
});

test('wordFragments: a non-name word cut short is found in any slot; real short words and stems are not', () => {
  const brief = 'Send invoices, run payroll and bookkeeping for freelancers, with tracking and workflow tools. No card needed.';
  const known = new Set([...brief.matchAll(/[A-Za-z]+/gu)].map((m) => m[0].toLowerCase()));
  assert.deepEqual(wordFragments('Send every invoi on time and track payroll across your studio', known, known), [{ word: 'invoi', of: 'invoices' }]);
  assert.deepEqual(wordFragments('No card neede', known, known), [{ word: 'neede', of: 'needed' }]);
  assert.deepEqual(wordFragments('Pay your team, book time, free trial, track work, one invoice, run tools', known, known), []);
  // A word of the fill itself is a target too: "Automat" next to "Automatic".
  const targets = new Set([...known, 'automatic']);
  assert.deepEqual(wordFragments('Autom reminders', known, targets), [{ word: 'Autom', of: 'automatic' }]);
});

test('fillSectionAdapter (composed): "invoi" in a long required slot gets one rewrite, then is refused', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/sections/1');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => { prompts.push(user); return reply({ heading: 'Accounting for studios', body: 'Send every invoi on time, run payroll and see which projects make money.' }); };
  await assert.rejects(() => fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model, composed: true }), SectionSelectionRefusedError);
  assert.equal(prompts.length, 3, 'two attempts, then one narrow rewrite');
  assert.match(prompts[1]!, /cuts the word "invoices" to "invoi"/);
});

test('fillSectionAdapter (composed): a word cut short in a long nullable slot is omitted', async () => {
  const adapter = await resolveSectionAdapter('test:word-budgets');
  const nullable = adapter.text.find((slot) => slot.atom && slot.max >= 20)!;
  const model: ModelCall = async () => {
    const text: Record<string, string | null> = Object.fromEntries(adapter.text.map((slot) => [slot.name, slot.atom ? null : (slot.max >= 7 ? 'Payroll' : 'Go')]));
    text[nullable.name] = 'Every invoi sent';
    return reply(text);
  };
  const result = await fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model, composed: true });
  assert.equal(result.fill.text?.[nullable.name], null);
  assert.ok(result.clipped?.includes(`text.${nullable.name}`));
});

test('fillSectionAdapter (composed): no model call after the last Jev check — a repair takes only the flagged slot, so its cut name never enters and no rewrite can add an unchecked price', async () => {
  const adapter = await resolveSectionAdapter('hyperui:marketing/sections/1');
  const prompts: string[] = [];
  const model: ModelCall = async ({ user }) => {
    prompts.push(user);
    // The fact repair drops the price but cuts the name; a name rewrite would put the price back.
    if (user.includes('Flagged as unsupported')) return reply({ heading: 'Ledger for studios', body: 'Invoices and payroll in one place.' });
    if (user.includes('Rewrite only these values with every word')) return reply({ heading: 'Ledgerline for studios', body: 'Invoices and payroll from $49 a month.' });
    return reply({ heading: 'Ledgerline for studios', body: 'Invoices and payroll from $49 a month.' });
  };
  // B-113: only the flagged body is taken from the repair; the unflagged cut heading is ignored, and
  // the merged fill is checked again before it is returned.
  const result = await fillSectionAdapter({ adapter, brief: OPENING_BRIEF, model, composed: true, verify: priceChecker(), strict: true });
  assert.ok(!prompts.some((prompt) => prompt.includes('Rewrite only these values with every word')), 'no rewrite after the check');
  assert.deepEqual(result.remaining, []);
  assert.equal(result.fill.text?.heading, 'Ledgerline for studios');
  assert.equal(result.fill.text?.body, 'Invoices and payroll in one place.');
});
