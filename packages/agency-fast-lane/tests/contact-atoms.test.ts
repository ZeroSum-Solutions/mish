/**
 * Contact atoms copied out of a brief's prose keep the sentence's punctuation ("... or
 * intake@anchorlinelegal.com."). The fast lane normalises email, phone and link atoms at fill time,
 * before the family compiler checks their format, so the build does not spend a repair (or fail)
 * on a period; a value that is not a contact at all is still refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt, withFixHint } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { contactPathsFor, editableTemplate, getAtPath, normalizeContactAtom, type JsonObject } from '../src/spine.ts';
import { WATSON_DIR, fakeModel, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(WATSON_DIR, 'watson');
const ENTRY = 'watson-r1.html';
const BRIEF = 'Anchorline Legal, a business law firm in Seattle. Reach the intake team at (828) 555-0135 or intake@x.com.';
const LOCK_BRAND = ['brand.name'];

test('normalizeContactAtom strips the punctuation a copy out of a sentence picks up', () => {
  assert.equal(normalizeContactAtom('intake@x.com.'), 'intake@x.com');
  assert.equal(normalizeContactAtom('(828) 555-0135.'), '(828) 555-0135');
  assert.equal(normalizeContactAtom('  "intake@x.com", '), 'intake@x.com');
  assert.equal(normalizeContactAtom('(intake@x.com);'), 'intake@x.com');
  assert.equal(normalizeContactAtom('“intake@x.com”.'), 'intake@x.com');
  assert.equal(normalizeContactAtom('+1 (828) 555-0135)'), '+1 (828) 555-0135', 'an unpaired closing bracket goes');
  assert.equal(normalizeContactAtom('(828) 555-0135 (main)'), '(828) 555-0135 (main)', 'balanced brackets inside the value stay');
  assert.equal(normalizeContactAtom('https://x.com/a).'), 'https://x.com/a');
  assert.equal(normalizeContactAtom('intake at x dot com'), 'intake at x dot com', 'nothing inside the value changes');
});

test('normalizeContactAtom never strips a leading quote or bracket without its matching closer', () => {
  for (const value of ['"desk"@x.com', '(828) 555-0135', '[team]@x.com', "'a@b.co", '(828) 555-0135 (main)']) {
    assert.equal(normalizeContactAtom(value), value, `${value} stays as written`);
  }
  assert.equal(normalizeContactAtom('"desk"@x.com.'), '"desk"@x.com', 'only the sentence period goes');
  assert.equal(normalizeContactAtom('a@b.co"'), 'a@b.co"', 'a lone straight quote at the end is ambiguous and left for the repair');
});

test('contactPathsFor finds the email and phone atoms of the watson footer', () => {
  const paths = contactPathsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  assert.equal(paths.get('sections[4].content.jobsEmail'), 'email');
  assert.equal(paths.get('sections[4].content.businessEmail'), 'email');
  assert.equal(paths.get('sections[4].content.phone'), 'phone');
  assert.equal(paths.has('sections[4].content.phoneLabel'), false, 'a label next to the atom is not an atom');
});

const fillWith = (values: Record<string, string>): Filler => (key, _value, _at, limit) => values[key] ?? `New ${key} for Anchorline`.slice(0, limit);

test('"intake@x.com." and "(828) 555-0135." land valid, with no repair', async () => {
  const model = fakeModel({ fill: fillWith({ jobsEmail: 'intake@x.com.', businessEmail: 'intake@x.com,', phone: '(828) 555-0135.' }) });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', lockPaths: LOCK_BRAND });
  assert.equal(report.repairs, 0);
  const footer = getAtPath(report.recipe, ['sections', 4, 'content']) as JsonObject;
  assert.equal(footer.jobsEmail, 'intake@x.com');
  assert.equal(footer.businessEmail, 'intake@x.com');
  assert.equal(footer.phone, '(828) 555-0135');
  assert.ok(report.html.includes('mailto:intake%40x.com"'));
  assert.ok(report.html.includes('href="tel:+18285550135"') || report.html.includes('tel:8285550135'), 'the phone link is built from the bare number');
});

test('a genuinely invalid email is still refused, and the repair prompt names the fix', async () => {
  const model = fakeModel({ fill: fillWith({ jobsEmail: 'intake at x dot com.', businessEmail: 'intake@x.com', phone: '(828) 555-0135' }) });
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', lockPaths: LOCK_BRAND }),
    /watson-footer: the family compiler refused the filled unit/,
  );
  assert.ok(model.prompts.some((prompt) => prompt.includes('jobsEmail: invalid email. Fix: remove trailing punctuation')), 'the rejection tells the model what to change');
});

test('withFixHint names the fix for email and phone refusals only', () => {
  assert.match(withFixHint('jobsEmail: invalid email'), /remove trailing punctuation/);
  assert.match(withFixHint('sections[2].content.email: expected an email address'), /remove trailing punctuation/);
  assert.match(withFixHint('phone: invalid telephone'), /remove trailing punctuation/);
  assert.equal(withFixHint('title: at most 80 characters'), 'title: at most 80 characters');
  const hinted = withFixHint('jobsEmail: invalid email');
  assert.equal(withFixHint(hinted), hinted, 'a message that already says Fix: is not hinted twice');
  assert.equal(withFixHint('footer.email: expected an email address or null'), 'footer.email: expected an email address or null', 'a message that already offers null is left alone');
  assert.equal(withFixHint('phone: expected a phone number or null'), 'phone: expected a phone number or null');
  const prompt = buildUserPrompt({ brief: 'b', template: { a: 'x' }, limits: {}, scope: 's', rejected: { answer: '{}', error: 'jobsEmail: invalid email' } });
  assert.ok(prompt.includes('VALIDATION ERROR\njobsEmail: invalid email. Fix: remove trailing punctuation'));
});
