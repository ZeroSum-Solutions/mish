import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevChecker, normalizeFaithfulnessText } from '../src/jev.ts';

test('normalization removes discourse filler without dropping facts', () => {
  assert.equal(normalizeFaithfulnessText('It is worth noting that we opened in 2018.'), 'We opened in 2018.');
  assert.equal(normalizeFaithfulnessText('In fact, we opened in 2018.'), 'We opened in 2018.');
  assert.equal(normalizeFaithfulnessText('We did not open in 2018, because funding failed.'), 'We did not open in 2018, because funding failed.');
});

test('normalization canonicalizes unambiguous dates and numeric quantities', () => {
  assert.equal(normalizeFaithfulnessText('Opened on January 5th, 2018 with twenty-four seats and $1,000.00.'),
    normalizeFaithfulnessText('Opened on 5 January 2018 with 24 seats and $1000.00.'));
  assert.equal(normalizeFaithfulnessText('Opened on 2018-1-5.'), 'Opened on 2018-01-05.');
  assert.equal(normalizeFaithfulnessText('Rating: five stars; capacity: one hundred and twenty seats.'), 'Rating: 5 stars; capacity: 120 seats.');
});

for (const text of ['€0,125', '€0,12', '€0,1', '€0,1256', '€1,234', '€1.234,56',
  '$1,000', '1,5 kg', '1,234 guests', '€01,234', '€0,125.50']) {
  test(`normalization preserves locale-ambiguous decimal or grouped quantities: ${text}`, () => {
    assert.equal(normalizeFaithfulnessText(text), text);
  });
}

test('normalization strips only unambiguous thousands separators', () => {
  assert.equal(normalizeFaithfulnessText('$1,000.00; €1,234,567; 1,000,000 guests'),
    '$1000.00; €1234567; 1000000 guests');
});

for (const text of ['tickets.example/$1,000', '/path/1,000', '/path/$1,000', './$1,000',
  '../$1,000', 'prices/$1,000', 'tickets.example?price=$1,000', '$1,000.example',
  'https://tickets.example/$1,000', '//tickets.example/$1,000', 'C:\\prices\\$1,000',
  'tickets.example/$1,000.00', '/path/$1,000.00', '/path/January/5/2018',
  'we.example', 'our/$1,000.00', 'custom:$1,000.00', '127.0.0.1?price=$1,000.00',
  '[::1]?price=$1,000.00', '门票.测试?price=$1,000.00', '?price=$1,000.00', '#price=$1,000.00',
  '€1,234,567.测试', '(custom:$1,000.00)', 'a@host?price=$1,000.00']) {
  test(`normalization preserves URL, hostname or path identity: ${text}`, () => {
    assert.equal(normalizeFaithfulnessText(text), text);
  });
}

test('normalization still processes prose around protected paths', () => {
  assert.equal(normalizeFaithfulnessText('Pay $1,000.00 at tickets.example/$1,000.00 for twenty-four seats.'),
    'Pay $1000.00 at tickets.example/$1,000.00 for 24 seats.');
});

for (const text of ['We need 1/2 dozen seats.', 'We need 1/2 hundred seats.',
  'We need 1/2 a dozen seats.', 'We need 3/1 hundred seats.',
  'We need ratio:3 hundred seats.', 'We need ratio:3 a dozen seats.',
  'We need 3 hundred seats.']) {
  test(`normalization preserves compound quantities across protected spans: ${text}`, () => {
    assert.equal(normalizeFaithfulnessText(text), text);
  });
}

test('normalization converts independent quantities after protected fractions and numbers', () => {
  assert.equal(normalizeFaithfulnessText('We need a dozen seats.'), 'We need 12 seats.');
  assert.equal(normalizeFaithfulnessText('Use 1/2 for a dozen seats and ratio:3 for twenty-four guests.'),
    'Use 1/2 for 12 seats and ratio:3 for 24 guests.');
  assert.equal(normalizeFaithfulnessText('We need 1/2 dozen seats; a dozen guests.'),
    'We need 1/2 dozen seats; 12 guests.');
});

test('normalization preserves uncertain dates, proper names, qualifiers and unsupported claims', () => {
  for (const text of ['May is our chef.', 'Studio One opened in 2018.', 'Opened on 01/02/2018.', 'Opened on February 30, 2018.',
    'We may open in 2018.', 'We opened before 2018.', 'We opened in 2019.', 'The only certified restaurant in Millbrook.',
    'We booked Three Days Grace for the launch.', 'Our venue is the Five Stars Hotel.',
    'The guard opened the doors at 08:00.', 'They opened their doors of perception in 2018.',
    'We have two dozen guests.', 'We have half a dozen seats.', 'We run for two and a half hours.', 'We have twenty eighteen seats.',
    'Reserve at https://tickets.example/2018-1-5 or www.tickets.example/2018-1-5.',
    'Write to 2018-1-5@tickets.example.',
    'SKU: MM-2018-1-5-X.', 'Order ID: 2018-1-5.', 'They opened their doors in 2018 to let the ambulance in.',
    'We have two-dozen guests.', 'We have twenty-twelve seats.',
    'Product code: AB-1,000-X.', 'Tax ID: 1,000.', 'Reserve at tickets.example/1,000.',
    'In fact,', '', 'Email chef@example.com or call 555-0100.']) {
    assert.equal(normalizeFaithfulnessText(text), text);
  }
});

test('faithfulness sends normalized slot text while preserving the brief, context and caller slots', async () => {
  const brief = 'It is worth noting that the venue opened on January 5, 2018 with 24 seats.';
  const slots = [{ path: 'bio', text: 'In fact, we opened on 5 January 2018 with twenty-four seats.', context: 'Check the opening date.' }];
  const before = structuredClone(slots);
  const requests: { state: Record<string, string>; questions: Record<string, { instructions: string }> }[] = [];
  const checker = createJevChecker({ apiKey: 'test-key', fetchImpl: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ answers: { slot_0: { noul: 0.05 } } }));
  }) as typeof fetch });
  assert.deepEqual((await checker.checkFaithfulness({ brief, slots })).flagged, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.state.brief, brief);
  assert.equal(requests[0]!.state.text_0, 'We opened on 2018-01-05 with 24 seats.');
  assert.match(requests[0]!.questions.slot_0!.instructions, /Check the opening date\./);
  assert.deepEqual(slots, before);
});
